import { readConfig, DATA_REPO, gh } from './_config.js';
import { moveToTrash } from './_trash-util.js';

const MISSING_JSON_PATH = 'data/missing.json';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  const uploadPrefix = config.uploadPath || 'www/assets/sliced/uploads';

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name } = body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (!['waiting-for-review', 'denied', 'approved'].includes(item.status)) return res.status(400).json({ error: 'nothing to delete' });

    // Move upload file to trash (upload lives in gpc-asset-browser data/uploads/)
    if (item.uploadedFile) {
      const filePath = `data/uploads/${item.uploadedFile}`;
      try { await moveToTrash(token, config, DATA_REPO.branch, filePath, 'data/uploads', `delete ${item.status}`); } catch {}
    }

    // Move runtime asset to trash (runtime lives in golf-paper-craft www/assets/...)
    const runtimeDir = (typeof item.runtimeDir === 'string' && item.runtimeDir.trim())
      ? item.runtimeDir.trim().replace(/^\/+|\/+$/g, '')
      : uploadPrefix;
    if (runtimeDir) {
      for (const ext of ['webp', 'png', 'gif', 'jpg']) {
        const rp = `${runtimeDir}/${item.name}.${ext}`;
        try { await moveToTrash(token, config, DATA_REPO.branch, rp, runtimeDir, `delete ${item.status}`); } catch {}
      }
    }

    item.status = 'todo';
    delete item.uploadedFile;
    json.updated = new Date().toISOString().slice(0, 10);
    await gh(token, MISSING_JSON_PATH, {
      method: 'PUT', github: DATA_REPO,
      body: {
        message: `missing: ${name} -> todo`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch: DATA_REPO.branch,
      },
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
