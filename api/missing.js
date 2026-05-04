// GET /api/missing — serve missing.json live from GitHub (bypasses Vercel build cache)
import { readConfig, gh } from './_config.js';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  const branch = config.github?.branch || 'main';
  const uploadPrefix = config.uploadPath || 'asset-browser/data/uploads';
  const missingJsonPath = `${config.dataPath || (uploadPrefix.split('/').slice(0, -1).join('/') || 'asset-browser/data')}/missing.json`;

  try {
    const miss = await gh(token, missingJsonPath, { ref: branch, github: config.github });
    const json = JSON.parse(Buffer.from(miss.content, 'base64').toString());
    res.setHeader('Cache-Control', 'no-store');
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
