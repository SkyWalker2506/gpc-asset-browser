// POST /api/save-edits { assetPath, pngBase64 }      — overwrite a source PNG (was save-edits.js)
// POST /api/save-edits { assetId, animation }        — save animation meta (was save-animation-meta.js)
import { readConfig, gh } from './_config.js';

// ---- save-animation-meta logic ----
const SIDECAR_PATH = 'data/animation-meta.json';
const SIDECAR_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };

async function saveAnimMetaToFirestore(assetId, animData) {
  const { db } = await import('./_firebase.js');
  await db.collection('golf-paper-craft').doc('animation-meta').set(
    { [assetId]: animData },
    { merge: true }
  );
}

async function handleAnimMeta(token, body, res) {
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

  const newAnim = { frames, fps, layout };
  if (frameW) newAnim.frameW = frameW;
  if (frameH) newAnim.frameH = frameH;
  if (customCells) newAnim.customCells = customCells;

  if (process.env.FIREBASE_PROJECT_ID) {
    try {
      await saveAnimMetaToFirestore(assetId, newAnim);
      return res.json({ ok: true, animation: newAnim, backend: 'firestore' });
    } catch (fbErr) {
      console.error('Firestore save failed, falling back to GitHub sidecar:', fbErr);
    }
  }

  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set (and Firebase not configured)' });
  let existingSha = null;
  let sidecar = { version: 1, meta: {} };
  try {
    const fileData = await gh(token, SIDECAR_PATH, { ref: SIDECAR_REPO.branch, github: SIDECAR_REPO });
    existingSha = fileData.sha;
    sidecar = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
    if (!sidecar.meta) sidecar.meta = {};
  } catch (e) {
    if (!String(e.message).includes('GitHub 404')) throw e;
  }

  sidecar.meta[assetId] = newAnim;
  const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(sidecar, null, 2) + '\n')));
  const putBody = {
    message: `asset-browser: set animation meta for ${assetId} (${frames}f @ ${fps}fps)`,
    content: newContent,
    branch: SIDECAR_REPO.branch,
  };
  if (existingSha) putBody.sha = existingSha;
  const result = await gh(token, SIDECAR_PATH, { method: 'PUT', github: SIDECAR_REPO, body: putBody });
  return res.json({ ok: true, commitSha: result?.commit?.sha || null, animation: newAnim, backend: 'github' });
}

// ---- save-edits (asset PNG) logic ----
async function saveToFirebase(assetId, buffer) {
  const { bucket, db } = await import('./_firebase.js');
  const storagePath = `golf-paper-craft/assets/${assetId}.png`;
  const file = bucket.file(storagePath);
  await file.save(buffer, { metadata: { contentType: 'image/png' } });
  await file.makePublic();
  const url = file.publicUrl();
  await db.collection('golf-paper-craft').doc('manifest').set(
    { assets: { [assetId]: { url, mtime: Date.now() } } },
    { merge: true }
  );
  return { url, storagePath };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    // Route: animation meta if assetId + animation present
    if (body?.assetId && body?.animation) {
      const token = process.env.GITHUB_TOKEN;
      return handleAnimMeta(token, body, res);
    }

    // Route: asset PNG save
    const { assetPath, pngBase64 } = body || {};
    if (!assetPath || typeof assetPath !== 'string') {
      return res.status(400).json({ error: 'assetPath (string) required' });
    }
    if (!pngBase64 || typeof pngBase64 !== 'string') {
      return res.status(400).json({ error: 'pngBase64 (string) required' });
    }
    const cleanPath = assetPath.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!cleanPath.startsWith('www/assets/')) {
      return res.status(400).json({ error: 'assetPath must start with www/assets/' });
    }
    if (cleanPath.includes('..')) {
      return res.status(400).json({ error: 'assetPath must not contain ..' });
    }
    const cleanB64 = pngBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanB64, 'base64');

    const assetId = cleanPath
      .replace(/^www\/assets\//, '')
      .replace(/\.png$/i, '')
      .replace(/[/\\]/g, '-');

    if (process.env.FIREBASE_PROJECT_ID) {
      try {
        const { url, storagePath } = await saveToFirebase(assetId, buffer);
        return res.json({ ok: true, url, storagePath, path: cleanPath, backend: 'firebase' });
      } catch (fbErr) {
        console.error('Firebase save failed, falling back to GitHub:', fbErr);
      }
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set (and Firebase not configured)' });
    const config = readConfig();
    if (!config.github?.owner || !config.github?.repo) {
      return res.status(500).json({ error: 'config.github missing' });
    }
    const branch = config.github.branch || 'main';
    let existingSha;
    try {
      const cur = await gh(token, cleanPath, { ref: branch, github: config.github });
      existingSha = cur.sha;
    } catch (_) {}

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
    const commitSha = result?.commit?.sha || null;
    if (process.env.FIREBASE_PROJECT_ID && commitSha) {
      try {
        const { db: firestoreDb } = await import('./_firebase.js');
        await firestoreDb.collection('golf-paper-craft').doc('manifest').set(
          { assets: { [assetId]: { commitSha, mtime: Date.now(), backend: 'github' } } },
          { merge: true }
        );
      } catch (_) { /* non-fatal */ }
    }
    res.json({ ok: true, commitSha, path: cleanPath, backend: 'github' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
