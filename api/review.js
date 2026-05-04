// POST /api/review { name, action: 'approve'|'deny', reason? }
import { readConfig, gh } from './_config.js';
import { moveToTrash } from './_trash-util.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  const branch = config.github.branch || 'main';
  const uploadPrefix = config.uploadPath || 'asset-browser/data/uploads';
  const missingJsonPath = `${config.dataPath || (uploadPrefix.split('/').slice(0, -1).join('/') || 'asset-browser/data')}/missing.json`;

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name, action, reason } = body;
    if (!name || !['approve', 'deny', 'reopen'].includes(action)) return res.status(400).json({ error: 'name + action (approve|deny|reopen) required' });
    if (action === 'deny' && !reason) return res.status(400).json({ error: 'reason required for deny' });

    const miss = await gh(token, missingJsonPath, { ref: branch, github: config.github });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (!['waiting-for-review', 'approved', 'denied'].includes(item.status)) return res.status(400).json({ error: 'item must have an uploaded file to review' });

    const prevStatus = item.status;
    item.status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'waiting-for-review';
    if (action === 'deny') item.denyReason = reason;
    else delete item.denyReason;

    // On approve: copy uploaded file to runtime dir (as-is, no split).
    // CRITICAL: runtimeDir MUST come from item.runtimeDir (explicit per-item).
    // Old behavior used a regex against config.sources[].category which matched
    // "Ball Skins (in-game)" for everything → non-ball assets ended up in
    // www/assets/sliced/balls/. We now require explicit metadata or fall
    // back to the canonical dropbox uploadPrefix (a safe quarantine).
    if (action === 'approve' && item.uploadedFile) {
      const runtimeDir = (typeof item.runtimeDir === 'string' && item.runtimeDir.trim())
        ? item.runtimeDir.trim().replace(/^\/+|\/+$/g, '')
        : uploadPrefix; // canonical fallback dropbox — not a guessed source dir
      if (runtimeDir) {
        const ext = (item.uploadedFile.split('.').pop() || 'png').toLowerCase();
        const runtimePath = `${runtimeDir}/${item.name}.${ext}`;
        try {
          // fetch upload content
          const uploadPath = `${uploadPrefix}/${item.uploadedFile}`;
          const up = await gh(token, uploadPath, { ref: branch, github: config.github });
          let content = up.content;
          if (!content) {
            const blob = await fetch(`https://api.github.com/repos/${config.github.owner}/${config.github.repo}/git/blobs/${up.sha}`, {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
            }).then(r => r.json());
            content = blob.content;
          }
          let existingSha;
          try { existingSha = (await gh(token, runtimePath, { ref: branch, github: config.github })).sha; } catch {}
          await gh(token, runtimePath, {
            method: 'PUT', github: config.github,
            body: { message: `approve: copy ${item.name} to runtime`, content, branch, ...(existingSha ? { sha: existingSha } : {}) },
          });
        } catch (e) {
          console.warn('runtime copy failed:', e.message);
        }
      }
    }

    // If transitioning from approved → denied/reopen, remove runtime file from repo.
    // Must mirror the same explicit runtimeDir resolution as approve (no regex).
    if (prevStatus === 'approved' && action !== 'approve') {
      const runtimeDir = (typeof item.runtimeDir === 'string' && item.runtimeDir.trim())
        ? item.runtimeDir.trim().replace(/^\/+|\/+$/g, '')
        : uploadPrefix;
      if (runtimeDir) {
        for (const ext of ['webp', 'png', 'gif', 'jpg']) {
          const path = `${runtimeDir}/${item.name}.${ext}`;
          try { await moveToTrash(token, config, branch, path, runtimeDir, `review ${action}`); } catch {}
        }
      }
    }
    json.updated = new Date().toISOString().slice(0, 10);

    await gh(token, missingJsonPath, {
      method: 'PUT', github: config.github,
      body: {
        message: `missing: ${name} -> ${item.status}`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch,
      },
    });

    res.json({ ok: true, status: item.status });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
