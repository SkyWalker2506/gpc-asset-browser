// POST /api/missing-patch { name, patch } — patch specific fields of a missing item
// Allowed fields: status, uploadedFile, denyReason
import { DATA_REPO, gh } from './_config.js';

const ALLOWED = ['status', 'uploadedFile', 'denyReason'];
const MISSING_JSON_PATH = 'data/missing.json';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { name, patch } = body;
    if (!name || !patch) return res.status(400).json({ error: 'name + patch required' });

    const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    const item = json.items.find(i => i.name === name);
    if (!item) return res.status(404).json({ error: 'item not found' });

    for (const k of Object.keys(patch)) {
      if (!ALLOWED.includes(k)) continue;
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
