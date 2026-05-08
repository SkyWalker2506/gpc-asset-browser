// GET /api/trash — list trash files (admin only)
// POST /api/trash { action: 'restore'|'purge', file } — restore to runtime or hard-delete
import { readConfig, DATA_REPO, gh } from './_config.js';

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const h = req.headers['x-admin-token'] || req.headers['X-Admin-Token'];
  const q = (new URL(req.url, 'http://x')).searchParams.get('admin');
  return h === token || q === token;
}

const TRASH_DIR = 'data/trash';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch { body = {}; }
  const isPurge = req.method === 'POST' && body?.action === 'purge';
  if (isPurge && !isAdmin(req)) return res.status(403).json({ error: 'purge admin only' });

  const config = readConfig();

  try {
    if (req.method === 'GET') {
      let files = [];
      try {
        const list = await gh(token, TRASH_DIR, { ref: DATA_REPO.branch, github: DATA_REPO });
        files = (Array.isArray(list) ? list : []).map(f => ({
          name: f.name,
          size: f.size,
          sha: f.sha,
          meta: f.name.replace(/\.[^.]+$/, '') + '.meta.json',
        }));
      } catch {}
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, files });
    }

    if (req.method === 'POST') {
      const { action, file } = body;
      if (!file) return res.status(400).json({ error: 'file required' });

      if (action === 'purge') {
        const path = `${TRASH_DIR}/${file}`;
        const meta = await gh(token, path, { ref: DATA_REPO.branch, github: DATA_REPO });
        await gh(token, path, { method: 'DELETE', github: DATA_REPO, body: { message: `trash purge: ${file}`, sha: meta.sha, branch: DATA_REPO.branch } });
        return res.json({ ok: true });
      }

      if (action === 'restore') {
        // Read meta json to know where it came from
        const metaPath = `${TRASH_DIR}/${file.replace(/\.[^.]+$/, '')}.meta.json`;
        let originDir, originRepoName;
        try {
          const mr = await gh(token, metaPath, { ref: DATA_REPO.branch, github: DATA_REPO });
          const metaObj = JSON.parse(Buffer.from(mr.content, 'base64').toString());
          originDir = metaObj.originDir;
          originRepoName = metaObj.originRepo;
        } catch {
          originDir = (config.sources || [])[0]?.dir;
        }
        if (!originDir) return res.status(400).json({ error: 'origin unknown' });

        // Determine which repo to restore to based on origin path
        const isRuntimeFile = originDir.startsWith('www/') || originDir.startsWith('/www/');
        const restoreRepo = (isRuntimeFile || originRepoName === 'golf-paper-craft') ? config.github : DATA_REPO;
        const restoreBranch = restoreRepo.branch || 'main';

        // Read trash file content from gpc-asset-browser
        const trashPath = `${TRASH_DIR}/${file}`;
        const trashMeta = await gh(token, trashPath, { ref: DATA_REPO.branch, github: DATA_REPO });
        let content = trashMeta.content;
        if (!content) {
          const blob = await fetch(`https://api.github.com/repos/${DATA_REPO.owner}/${DATA_REPO.repo}/git/blobs/${trashMeta.sha}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          }).then(r => r.json());
          content = blob.content;
        }

        // PUT to target repo
        const restorePath = `${originDir}/${file}`;
        let existingSha;
        try { existingSha = (await gh(token, restorePath, { ref: restoreBranch, github: restoreRepo })).sha; } catch {}
        await gh(token, restorePath, {
          method: 'PUT', github: restoreRepo,
          body: { message: `restore: ${file}`, content, branch: restoreBranch, ...(existingSha ? { sha: existingSha } : {}) },
        });

        // Delete trash + meta from gpc-asset-browser
        await gh(token, trashPath, { method: 'DELETE', github: DATA_REPO, body: { message: `trash remove after restore`, sha: trashMeta.sha, branch: DATA_REPO.branch } });
        try {
          const m2 = await gh(token, metaPath, { ref: DATA_REPO.branch, github: DATA_REPO });
          await gh(token, metaPath, { method: 'DELETE', github: DATA_REPO, body: { message: `trash meta cleanup`, sha: m2.sha, branch: DATA_REPO.branch } });
        } catch {}
        return res.json({ ok: true, restored: restorePath });
      }

      return res.status(400).json({ error: 'action must be restore|purge' });
    }

    res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
