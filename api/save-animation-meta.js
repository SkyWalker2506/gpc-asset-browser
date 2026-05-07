// Update animation metadata for an asset.
// POST { assetId, animation: { frames, fps, layout, frameW?, frameH?, customCells? } }
// Reads/writes data/animation-meta.json in the gpc-asset-browser repo (sidecar, not manifest).
import { gh } from './_config.js';

const SIDECAR_PATH = 'data/animation-meta.json';
const SIDECAR_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

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
    const frameW = animation.frameW ? Math.max(1, parseInt(animation.frameW, 10)) : undefined;
    const frameH = animation.frameH ? Math.max(1, parseInt(animation.frameH, 10)) : undefined;
    const customCells = Array.isArray(animation.customCells) ? animation.customCells : undefined;

    // Fetch existing sidecar (create empty if not found).
    let existingSha = null;
    let sidecar = { version: 1, meta: {} };
    try {
      const fileData = await gh(token, SIDECAR_PATH, { ref: SIDECAR_REPO.branch, github: SIDECAR_REPO });
      existingSha = fileData.sha;
      sidecar = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
      if (!sidecar.meta) sidecar.meta = {};
    } catch (e) {
      if (!String(e.message).includes('GitHub 404')) throw e;
      // File doesn't exist yet — will create it.
    }

    const newAnim = { frames, fps, layout };
    if (frameW) newAnim.frameW = frameW;
    if (frameH) newAnim.frameH = frameH;
    if (customCells) newAnim.customCells = customCells;
    sidecar.meta[assetId] = newAnim;

    const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(sidecar, null, 2) + '\n')));
    const putBody = {
      message: `asset-browser: set animation meta for ${assetId} (${frames}f @ ${fps}fps)`,
      content: newContent,
      branch: SIDECAR_REPO.branch,
    };
    if (existingSha) putBody.sha = existingSha;

    const result = await gh(token, SIDECAR_PATH, {
      method: 'PUT',
      github: SIDECAR_REPO,
      body: putBody,
    });

    res.json({ ok: true, commitSha: result?.commit?.sha || null, animation: newAnim });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };
