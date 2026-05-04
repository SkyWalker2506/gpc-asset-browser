// GET /api/trash — list trash files (admin only)
// POST /api/trash { action: 'restore'|'purge', file } — restore to runtime or hard-delete
import { readConfig, gh } from './_config.js';

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const h = req.headers['x-admin-token'] || req.headers['X-Admin-Token'];
  const q = (new URL(req.url, 'http://x')).searchParams.get('admin');
  return h === token || q === token;
}

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  // GET (list) + POST restore are public. POST purge is admin-only.
  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch { body = {}; }
  const isPurge = req.method === 'POST' && body?.action === 'purge';
  if (isPurge && !isAdmin(req)) return res.status(403).json({ error: 'purge admin only' });

  const config = readConfig();
  const branch = config.github.branch || 'main';
  const uploadPrefix = config.uploadPath || 'asset-browser/data/uploads';
  const trashDir = config.trashPath || `${uploadPrefix.split('/').slice(0, -1).join('/')}/trash`;

  try {
    if (req.method === 'GET') {
      let files = [];
      try {
        const list = await gh(token, trashDir, { ref: branch, github: config.github });
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
        const path = `${trashDir}/${file}`;
        const meta = await gh(token, path, { ref: branch, github: config.github });
        await gh(token, path, { method: 'DELETE', github: config.github, body: { message: `trash purge: ${file}`, sha: meta.sha, branch } });
        return res.json({ ok: true });
      }

      if (action === 'restore') {
        // Read meta json to know where it came from
        const metaPath = `${trashDir}/${file.replace(/\.[^.]+$/, '')}.meta.json`;
        let originDir, deletedAt;
        try {
          const mr = await gh(token, metaPath, { ref: branch, github: config.github });
          const metaObj = JSON.parse(Buffer.from(mr.content, 'base64').toString());
          originDir = metaObj.originDir;
          deletedAt = metaObj.deletedAt;
        } catch {
          originDir = (config.sources || [])[0]?.dir;
        }
        // Restore is public — no time limit
        if (!originDir) return res.status(400).json({ error: 'origin unknown' });

        // Read trash file content
        const trashPath = `${trashDir}/${file}`;
        const trashMeta = await gh(token, trashPath, { ref: branch, github: config.github });
        let content = trashMeta.content;
        if (!content) {
          const blob = await fetch(`https://api.github.com/repos/${config.github.owner}/${config.github.repo}/git/blobs/${trashMeta.sha}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          }).then(r => r.json());
          content = blob.content;
        }

        // PUT to runtime
        const restorePath = `${originDir}/${file}`;
        let existingSha;
        try { existingSha = (await gh(token, restorePath, { ref: branch, github: config.github })).sha; } catch {}
        await gh(token, restorePath, {
          method: 'PUT', github: config.github,
          body: { message: `restore: ${file}`, content, branch, ...(existingSha ? { sha: existingSha } : {}) },
        });

        // Delete trash + meta
        await gh(token, trashPath, { method: 'DELETE', github: config.github, body: { message: `trash remove after restore`, sha: trashMeta.sha, branch } });
        try {
          const m2 = await gh(token, metaPath, { ref: branch, github: config.github });
          await gh(token, metaPath, { method: 'DELETE', github: config.github, body: { message: `trash meta cleanup`, sha: m2.sha, branch } });
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
