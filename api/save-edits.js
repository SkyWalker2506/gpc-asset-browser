// Overwrite a source PNG in the parent repo with the baked output of the in-browser
// image-editor. POST { assetPath, pngBase64 } -> GitHub Contents API PUT.
import { readConfig, gh } from './_config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });
  const config = readConfig();
  if (!config.github?.owner || !config.github?.repo) {
    return res.status(500).json({ error: 'config.github missing' });
  }
  const branch = config.github.branch || 'main';

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { assetPath, pngBase64 } = body || {};
    if (!assetPath || typeof assetPath !== 'string') {
      return res.status(400).json({ error: 'assetPath (string) required' });
    }
    if (!pngBase64 || typeof pngBase64 !== 'string') {
      return res.status(400).json({ error: 'pngBase64 (string) required' });
    }
    // Sanitise: only allow paths under www/assets/ (avoid arbitrary writes).
    const cleanPath = assetPath.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!cleanPath.startsWith('www/assets/')) {
      return res.status(400).json({ error: 'assetPath must start with www/assets/' });
    }
    if (cleanPath.includes('..')) {
      return res.status(400).json({ error: 'assetPath must not contain ..' });
    }
    // Strip any data-URL prefix the client may have left in.
    const cleanB64 = pngBase64.replace(/^data:image\/\w+;base64,/, '');

    // Look up the existing file SHA (required for an update PUT).
    let existingSha;
    try {
      const cur = await gh(token, cleanPath, { ref: branch, github: config.github });
      existingSha = cur.sha;
    } catch (_) {
      // File doesn't exist yet — that's fine, we'll create it.
    }

    const filename = cleanPath.split('/').pop();
    const result = await gh(token, cleanPath, {
      method: 'PUT', github: config.github,
      body: {
        message: `asset-browser: edit ${filename}`,
        content: cleanB64,
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      },
    });

    res.json({ ok: true, commitSha: result?.commit?.sha || null, path: cleanPath });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
