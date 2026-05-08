// GET /api/proxy-image?url=<encoded-url>
// Proxies cross-origin image requests so the browser canvas can read pixel data
// without CORS tainting. Only allows requests to trusted origins.
const ALLOWED_ORIGINS = [
  'https://golf-paper-craft.vercel.app',
  'https://raw.githubusercontent.com',
  'http://localhost',
  'http://127.0.0.1',
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const allowed = ALLOWED_ORIGINS.some(o => {
    try {
      const oo = new URL(o);
      return parsed.hostname === oo.hostname;
    } catch { return false; }
  });
  if (!allowed) return res.status(403).json({ error: 'Origin not allowed: ' + parsed.origin });

  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'gpc-asset-browser/proxy' } });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream ' + upstream.status });
    const ct = upstream.headers.get('content-type') || 'image/png';
    if (!ct.startsWith('image/')) return res.status(400).json({ error: 'Not an image content-type: ' + ct });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
