// Update animation metadata for a manifest item.
// POST { assetId, animation: { frames, fps, layout } }
// Reads manifest.json from the repo, updates the item's animation field, writes back.
import { readConfig, gh } from './_config.js';

const MANIFEST_PATH = 'asset-browser/public/manifest.json';

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
    const { assetId, animation } = body || {};
    if (!assetId || typeof assetId !== 'string') {
      return res.status(400).json({ error: 'assetId (string) required' });
    }
    if (!animation || typeof animation !== 'object') {
      return res.status(400).json({ error: 'animation object required' });
    }
    const frames = Math.max(1, parseInt(animation.frames, 10) || 1);
    const fps = Math.max(1, parseFloat(animation.fps) || 8);
    const layout = ['horizontal-strip', 'grid'].includes(animation.layout) ? animation.layout : 'horizontal-strip';

    // Fetch current manifest.json from GitHub.
    const fileData = await gh(token, MANIFEST_PATH, { ref: branch, github: config.github });
    const existingSha = fileData.sha;
    const currentJson = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));

    // Find and update the item.
    const items = currentJson.items || [];
    const idx = items.findIndex(i => i.id === assetId);
    if (idx === -1) {
      return res.status(404).json({ error: 'Asset not found in manifest: ' + assetId });
    }
    const frameW = animation.frameW ? Math.max(1, parseInt(animation.frameW, 10)) : undefined;
    const frameH = animation.frameH ? Math.max(1, parseInt(animation.frameH, 10)) : undefined;
    const customCells = Array.isArray(animation.customCells) ? animation.customCells : undefined;
    const newAnim = { frames, fps, layout };
    if (frameW) newAnim.frameW = frameW;
    if (frameH) newAnim.frameH = frameH;
    if (customCells) newAnim.customCells = customCells;
    items[idx] = { ...items[idx], animation: newAnim };
    currentJson.items = items;

    const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(currentJson, null, 2) + '\n')));
    const result = await gh(token, MANIFEST_PATH, {
      method: 'PUT',
      github: config.github,
      body: {
        message: `asset-browser: set animation meta for ${assetId} (${frames}f @ ${fps}fps, ${frameW||'?'}x${frameH||'?'})`,
        content: newContent,
        branch,
        sha: existingSha,
      },
    });

    res.json({ ok: true, commitSha: result?.commit?.sha || null, animation: newAnim });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };
