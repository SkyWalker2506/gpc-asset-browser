import { readConfig, DATA_REPO, gh } from './_config.js';

const MISSING_JSON_PATH = 'data/missing.json';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  if (!config.github?.owner || !config.github?.repo) return res.status(500).json({ error: 'config.github missing' });

  // Uploaded files land in gpc-asset-browser data/uploads/ (pending review area),
  // NOT directly in the golf-paper-craft runtime tree.
  const UPLOADS_PATH = 'data/uploads';

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name, filename, dataBase64 } = body;
    if (!name || !filename || !dataBase64) return res.status(400).json({ error: 'name, filename, dataBase64 required' });

    // 1. Upload file to gpc-asset-browser data/uploads/
    const filePath = `${UPLOADS_PATH}/${filename}`;
    let existingSha;
    try { existingSha = (await gh(token, filePath, { ref: DATA_REPO.branch, github: DATA_REPO })).sha; } catch {}
    await gh(token, filePath, {
      method: 'PUT', github: DATA_REPO,
      body: { message: `asset upload: ${name}`, content: dataBase64, branch: DATA_REPO.branch, ...(existingSha ? { sha: existingSha } : {}) },
    });

    // 2. Update missing.json in gpc-asset-browser
    const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'missing item not found' });
    item.status = 'waiting-for-review';
    item.uploadedFile = filename;
    json.updated = new Date().toISOString().slice(0, 10);
    await gh(token, MISSING_JSON_PATH, {
      method: 'PUT', github: DATA_REPO,
      body: {
        message: `missing: ${name} -> waiting-for-review`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch: DATA_REPO.branch,
      },
    });

    res.json({ ok: true, name, filename });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
