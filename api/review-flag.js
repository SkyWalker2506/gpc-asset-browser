// GET  /api/review-flag           — return review.json
// POST /api/review-flag { file, sourceDir, note }      — flag asset for review
// POST /api/review-flag { file, remove: true }         — unflag asset
import { readConfig, gh } from './_config.js';

const DATA_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };
const REVIEW_JSON_PATH = 'data/review.json';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  try {
    const cur = await gh(token, REVIEW_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(cur.content, 'base64').toString());

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(json);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { file, sourceDir, note, remove } = body || {};
    if (!file) return res.status(400).json({ error: 'file required' });

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
      method: 'PUT', github: DATA_REPO,
      body: {
        message: remove ? `review: unflag ${file}` : `review: flag ${file}`,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString('base64'),
        sha: cur.sha, branch: DATA_REPO.branch,
      },
    });

    res.json({ ok: true, count: json.items.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
