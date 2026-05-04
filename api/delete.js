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
    const { name } = body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const miss = await gh(token, missingJsonPath, { ref: branch, github: config.github });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (!['waiting-for-review', 'denied', 'approved'].includes(item.status)) return res.status(400).json({ error: 'nothing to delete' });

    // Move upload file to trash
    if (item.uploadedFile) {
      const filePath = `${uploadPrefix}/${item.uploadedFile}`;
      try { await moveToTrash(token, config, branch, filePath, uploadPrefix, `delete ${item.status}`); } catch {}
    }

    // Move runtime asset to trash too
    const runtimeDir = (config.sources || []).find(s => /in.?game|runtime/i.test(s.category || ''))?.dir
      || (config.sources || [])[0]?.dir;
    if (runtimeDir) {
      for (const ext of ['webp', 'png', 'gif', 'jpg']) {
        const rp = `${runtimeDir}/${item.name}.${ext}`;
        try { await moveToTrash(token, config, branch, rp, runtimeDir, `delete ${item.status}`); } catch {}
      }
    }

    item.status = 'todo';
    delete item.uploadedFile;
    json.updated = new Date().toISOString().slice(0, 10);
    await gh(token, missingJsonPath, {
      method: 'PUT', github: config.github,
      body: {
        message: `missing: ${name} -> todo`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch,
      },
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
