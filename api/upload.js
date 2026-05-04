import { readConfig, gh } from './_config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  if (!config.github?.owner || !config.github?.repo) return res.status(500).json({ error: 'config.github missing' });
  const branch = config.github.branch || 'main';
  const uploadPrefix = config.uploadPath || 'asset-browser/data/uploads';
  const missingJsonPath = `${config.dataPath || (uploadPrefix.split('/').slice(0, -1).join('/') || 'asset-browser/data')}/missing.json`;

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name, filename, dataBase64 } = body;
    if (!name || !filename || !dataBase64) return res.status(400).json({ error: 'name, filename, dataBase64 required' });

    // 1. Upload file. File lands in www/assets/sliced/uploads/ (canonical asset tree).
    // To make the editor see it: run `node www/lib/asset-system/scripts/scan-assets.js`
    // locally — that rebuilds www/assets/manifest.json which the asset-browser also consumes.
    const filePath = `${uploadPrefix}/${filename}`;
    let existingSha;
    try { existingSha = (await gh(token, filePath, { ref: branch, github: config.github })).sha; } catch {}
    await gh(token, filePath, {
      method: 'PUT', github: config.github,
      body: { message: `asset upload: ${name}`, content: dataBase64, branch, ...(existingSha ? { sha: existingSha } : {}) },
    });

    // 2. Update missing.json
    const miss = await gh(token, missingJsonPath, { ref: branch, github: config.github });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'missing item not found' });
    item.status = 'waiting-for-review';
    item.uploadedFile = filename;
    json.updated = new Date().toISOString().slice(0, 10);
    await gh(token, missingJsonPath, {
      method: 'PUT', github: config.github,
      body: {
        message: `missing: ${name} -> waiting-for-review`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch,
      },
    });

    res.json({ ok: true, name, filename });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
