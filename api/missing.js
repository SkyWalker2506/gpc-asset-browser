// GET  /api/missing                              — return missing.json
// POST /api/missing { name, patch }              — patch specific fields (was missing-patch.js)
// POST /api/missing { name, action:'clear' }     — remove item entirely (was clear.js)
import { DATA_REPO, gh } from './_config.js';

const ALLOWED_PATCH = ['status', 'uploadedFile', 'denyReason'];
const MISSING_JSON_PATH = 'data/missing.json';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  try {
    if (req.method === 'GET') {
      const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
      const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
      res.setHeader('Cache-Control', 'no-store');
      return res.json(json);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name, patch, action } = body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());

    if (action === 'clear') {
      // was /api/clear
      const before = json.items.length;
      json.items = json.items.filter(i => i.name !== name);
      if (json.items.length === before) return res.status(404).json({ error: 'item not found' });
      json.updated = new Date().toISOString().slice(0, 10);
      await gh(token, MISSING_JSON_PATH, {
        method: 'PUT', github: DATA_REPO,
        body: {
          message: `missing: clear ${name}`,
          content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
          sha: miss.sha, branch: DATA_REPO.branch,
        },
      });
      return res.json({ ok: true });
    }

    // default: patch
    if (!patch) return res.status(400).json({ error: 'patch object required' });
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'item not found' });

    for (const k of Object.keys(patch)) {
      if (!ALLOWED_PATCH.includes(k)) continue;
      if (patch[k] === null) delete item[k];
      else item[k] = patch[k];
    }
    json.updated = new Date().toISOString().slice(0, 10);

    await gh(token, MISSING_JSON_PATH, {
      method: 'PUT', github: DATA_REPO,
      body: {
        message: `missing: patch ${name}`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: miss.sha, branch: DATA_REPO.branch,
      },
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
