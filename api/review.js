// POST /api/review { name, action: 'approve'|'deny', reason? }
import { readConfig, DATA_REPO, gh } from './_config.js';
import { moveToTrash } from './_trash-util.js';

const MISSING_JSON_PATH = 'data/missing.json';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  const assetBranch = config.github?.branch || 'main';
  const uploadPrefix = config.uploadPath || 'www/assets/sliced/uploads';

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name, action, reason } = body;
    if (!name || !['approve', 'deny', 'reopen'].includes(action)) return res.status(400).json({ error: 'name + action (approve|deny|reopen) required' });
    if (action === 'deny' && !reason) return res.status(400).json({ error: 'reason required for deny' });

    const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (!['waiting-for-review', 'approved', 'denied'].includes(item.status)) return res.status(400).json({ error: 'item must have an uploaded file to review' });

    const prevStatus = item.status;
    item.status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'waiting-for-review';
    if (action === 'deny') item.denyReason = reason;
    else delete item.denyReason;

    // On approve: copy uploaded file (in gpc-asset-browser data/uploads/) to runtime dir
    // in golf-paper-craft repo (www/assets/...).
    if (action === 'approve' && item.uploadedFile) {
      const runtimeDir = (typeof item.runtimeDir === 'string' && item.runtimeDir.trim())
        ? item.runtimeDir.trim().replace(/^\/+|\/+$/g, '')
        : uploadPrefix;
      if (runtimeDir) {
        const ext = (item.uploadedFile.split('.').pop() || 'png').toLowerCase();
        const runtimePath = `${runtimeDir}/${item.name}.${ext}`;
        try {
          // fetch upload content from gpc-asset-browser data/uploads/
          const uploadPath = `data/uploads/${item.uploadedFile}`;
          const up = await gh(token, uploadPath, { ref: DATA_REPO.branch, github: DATA_REPO });
          let content = up.content;
          if (!content) {
            const blob = await fetch(`https://api.github.com/repos/${DATA_REPO.owner}/${DATA_REPO.repo}/git/blobs/${up.sha}`, {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
            }).then(r => r.json());
            content = blob.content;
          }
          let existingSha;
          try { existingSha = (await gh(token, runtimePath, { ref: assetBranch, github: config.github })).sha; } catch {}
          await gh(token, runtimePath, {
            method: 'PUT', github: config.github,
            body: { message: `approve: copy ${item.name} to runtime`, content, branch: assetBranch, ...(existingSha ? { sha: existingSha } : {}) },
          });
        } catch (e) {
          console.warn('runtime copy failed:', e.message);
        }
      }
    }

    // If transitioning from approved -> denied/reopen, remove runtime file from golf-paper-craft.
    if (prevStatus === 'approved' && action !== 'approve') {
      const runtimeDir = (typeof item.runtimeDir === 'string' && item.runtimeDir.trim())
        ? item.runtimeDir.trim().replace(/^\/+|\/+$/g, '')
        : uploadPrefix;
      if (runtimeDir) {
        for (const ext of ['webp', 'png', 'gif', 'jpg']) {
          const path = `${runtimeDir}/${item.name}.${ext}`;
          try { await moveToTrash(token, config, assetBranch, path, runtimeDir, `review ${action}`); } catch {}
        }
      }
    }
    json.updated = new Date().toISOString().slice(0, 10);

    await gh(token, MISSING_JSON_PATH, {
      method: 'PUT', github: DATA_REPO,
      body: {
        message: `missing: ${name} -> ${item.status}`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch: DATA_REPO.branch,
      },
    });

    res.json({ ok: true, status: item.status });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
