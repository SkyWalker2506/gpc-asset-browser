// POST /api/asset-delete { file, dir } — move runtime asset file to trash
import { readConfig } from './_config.js';
import { moveToTrash } from './_trash-util.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  const branch = config.github.branch || 'main';

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { file, dir } = body;
    if (!file || !dir) return res.status(400).json({ error: 'file + dir required' });
    if (!(config.sources || []).some(s => s.dir === dir)) {
      return res.status(400).json({ error: 'dir not in config.sources' });
    }
    const safeFile = file.replace(/[^A-Za-z0-9._-]/g, '');
    const path = `${dir}/${safeFile}`;
    const ok = await moveToTrash(token, config, branch, path, dir, 'user delete from assets');
    if (!ok) return res.status(404).json({ error: 'file not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
