// GET  /api/review-flag                           — return review.json
// POST /api/review-flag { file, sourceDir, note } — flag asset for review
// POST /api/review-flag { file, remove: true }    — unflag asset
// POST /api/review-flag { reviewAction: 'approve'|'deny'|'reopen', name, reason? }
//   — approve/deny/reopen a missing item (was /api/review)
import { readConfig, DATA_REPO, gh } from './_config.js';
import { moveToTrash } from './_trash-util.js';

const REVIEW_DATA_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };
const REVIEW_JSON_PATH = 'data/review.json';
const MISSING_JSON_PATH = 'data/missing.json';

async function handleReviewAction(token, body, res) {
  const config = readConfig();
  const assetBranch = config.github?.branch || 'main';
  const uploadPrefix = config.uploadPath || 'www/assets/sliced/uploads';
  const { reviewAction: action, name, reason } = body;
  if (!name || !['approve', 'deny', 'reopen'].includes(action)) {
    return res.status(400).json({ error: 'name + reviewAction (approve|deny|reopen) required' });
  }
  if (action === 'deny' && !reason) return res.status(400).json({ error: 'reason required for deny' });

  const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
  const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
  const item = json.items.find(i => i.name === name);
  if (!item) return res.status(404).json({ error: 'item not found' });
  if (!['waiting-for-review', 'approved', 'denied'].includes(item.status)) {
    return res.status(400).json({ error: 'item must have an uploaded file to review' });
  }

  const prevStatus = item.status;
  item.status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'waiting-for-review';
  if (action === 'deny') item.denyReason = reason;
  else delete item.denyReason;

  if (action === 'approve' && item.uploadedFile) {
    const runtimeDir = (typeof item.runtimeDir === 'string' && item.runtimeDir.trim())
      ? item.runtimeDir.trim().replace(/^\/+|\/+$/g, '')
      : uploadPrefix;
    if (runtimeDir) {
      const ext = (item.uploadedFile.split('.').pop() || 'png').toLowerCase();
      const runtimePath = `${runtimeDir}/${item.name}.${ext}`;
      try {
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
  return res.json({ ok: true, status: item.status });
}

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  try {
    if (req.method === 'GET') {
      const cur = await gh(token, REVIEW_JSON_PATH, { ref: REVIEW_DATA_REPO.branch, github: REVIEW_DATA_REPO });
      const json = JSON.parse(Buffer.from(cur.content, 'base64').toString());
      res.setHeader('Cache-Control', 'no-store');
      return res.json(json);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    // Route: review approve/deny/reopen (was /api/review)
    if (body?.reviewAction) {
      return handleReviewAction(token, body, res);
    }

    // Route: flag/unflag
    const { file, sourceDir, note, remove } = body || {};
    if (!file) return res.status(400).json({ error: 'file required' });

    const cur = await gh(token, REVIEW_JSON_PATH, { ref: REVIEW_DATA_REPO.branch, github: REVIEW_DATA_REPO });
    const json = JSON.parse(Buffer.from(cur.content, 'base64').toString());

    if (remove) {
      json.items = json.items.filter(i => i.file !== file);
    } else {
      const existing = json.items.find(i => i.file === file);
      if (existing) {
        if (sourceDir) existing.sourceDir = sourceDir;
        if (note !== undefined) existing.note = note;
        existing.flaggedAt = new Date().toISOString();
      } else {
        json.items.push({ file, sourceDir: sourceDir || '', note: note || '', flaggedAt: new Date().toISOString() });
      }
    }
    json.updated = new Date().toISOString().slice(0, 10);

    await gh(token, REVIEW_JSON_PATH, {
      method: 'PUT', github: REVIEW_DATA_REPO,
      body: {
        message: remove ? `review: unflag ${file}` : `review: flag ${file}`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: cur.sha, branch: REVIEW_DATA_REPO.branch,
      },
    });

    res.json({ ok: true, count: json.items.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
