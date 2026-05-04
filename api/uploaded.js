// GET /api/uploaded?file=xxx.png — proxy uploaded file from GitHub
import { readConfig, gh } from './_config.js';

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  const branch = config.github?.branch || 'main';
  const uploadPrefix = config.uploadPath || 'asset-browser/data/uploads';
  const file = (req.query?.file || new URL(req.url, 'http://x').searchParams.get('file') || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!file) return res.status(400).json({ error: 'file required' });

  try {
    const meta = await gh(token, `${uploadPrefix}/${file}`, { ref: branch, github: config.github });
    let buf;
    if (meta.content) {
      buf = Buffer.from(meta.content, 'base64');
    } else {
      // Large file: contents API returns empty content; fetch via blobs API
      const blobUrl = `https://api.github.com/repos/${config.github.owner}/${config.github.repo}/git/blobs/${meta.sha}`;
      const br = await fetch(blobUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!br.ok) throw new Error(`GitHub blob ${br.status}: ${await br.text()}`);
      const bj = await br.json();
      buf = Buffer.from(bj.content, 'base64');
    }
    const ext = (file.split('.').pop() || '').toLowerCase();
    const mime = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(buf);
  } catch (e) {
    res.status(404).json({ error: String(e.message || e) });
  }
}
