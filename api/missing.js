// GET /api/missing — serve missing.json live from GitHub (bypasses Vercel build cache)
import { readConfig, gh } from './_config.js';

const DATA_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };
const MISSING_JSON_PATH = 'data/missing.json';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

  try {
    const miss = await gh(token, MISSING_JSON_PATH, { ref: DATA_REPO.branch, github: DATA_REPO });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    res.setHeader('Cache-Control', 'no-store');
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
