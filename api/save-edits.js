// POST /api/save-edits { assetPath, pngBase64 }      — overwrite a source PNG
// POST /api/save-edits { assetId, animation }        — save animation meta
import { readConfig, gh } from './_config.js';

// ---- save-animation-meta logic ----
const SIDECAR_PATH = 'data/animation-meta.json';
const SIDECAR_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };

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

  const backends = [];

  // Firebase write
  if (process.env.FIREBASE_PROJECT_ID) {
    try {
      const { db } = await import('./_firebase.js');
      await db.collection('golf-paper-craft').doc('animation-meta').set(
        { [assetId]: newAnim },
        { merge: true }
      );
      backends.push('firestore');
    } catch (fbErr) {
      console.error('Firestore anim-meta write failed:', fbErr);
    }
  }

  // Supabase dual-write
  if (process.env.SUPABASE_URL) {
    try {
      const supabase = (await import('./_supabase.js')).default;
      await supabase.from('asset_overrides').upsert(
        { asset_id: assetId, animation: newAnim, updated_at: new Date().toISOString() },
        { onConflict: 'asset_id' }
      );
      backends.push('supabase');
    } catch (sbErr) {
      console.error('Supabase anim-meta write failed (non-fatal):', sbErr);
    }
  }

  // If at least one cloud backend succeeded, return
  if (backends.length > 0) {
    return res.json({ ok: true, animation: newAnim, backends });
  }

  // GitHub sidecar fallback
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set (and no cloud backend configured)' });
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
  return res.json({ ok: true, commitSha: result?.commit?.sha || null, animation: newAnim, backends: ['github'] });
}

// ---- save-edits (asset PNG) logic ----
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

    const backends = [];
    let resultUrl = null;
    let resultStoragePath = null;

    // Firebase write
    if (process.env.FIREBASE_PROJECT_ID) {
      try {
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
        resultUrl = url;
        resultStoragePath = storagePath;
        backends.push('firebase');
      } catch (fbErr) {
        console.error('Firebase save failed:', fbErr);
      }
    }

    // Supabase dual-write
    if (process.env.SUPABASE_URL) {
      try {
        const { default: supabase, STORAGE_BUCKET } = await import('./_supabase.js');
        const storagePath = `golf-paper-craft/assets/${assetId}.png`;
        const { error: uploadErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, buffer, { contentType: 'image/png', upsert: true });
        if (uploadErr) throw uploadErr;
        const { data: { publicUrl } } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
        await supabase.from('manifest_entries').upsert(
          { asset_id: assetId, url: publicUrl, mtime: Date.now(), backend: 'supabase' },
          { onConflict: 'asset_id' }
        );
        if (!resultUrl) resultUrl = publicUrl;
        if (!resultStoragePath) resultStoragePath = storagePath;
        backends.push('supabase');
      } catch (sbErr) {
        console.error('Supabase PNG write failed (non-fatal):', sbErr);
      }
    }

    // If at least one cloud backend succeeded, return
    if (backends.length > 0) {
      return res.json({ ok: true, url: resultUrl, storagePath: resultStoragePath, path: cleanPath, backends });
    }

    // GitHub fallback
    const token = process.env.GITHUB_TOKEN;
    if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set (and no cloud backend configured)' });
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
    res.json({ ok: true, commitSha, path: cleanPath, backends: ['github'] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
