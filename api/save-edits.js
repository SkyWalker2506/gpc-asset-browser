// Overwrite a source PNG: POST { assetPath, pngBase64 }
// NEW: uploads to Firebase Storage under golf-paper-craft/assets/<assetId>.png
//      and updates Firestore manifest doc.
// LEGACY path (GitHub PUT) is kept as fallback when Firebase env vars are absent.
import { readConfig, gh } from './_config.js';

async function saveToFirebase(assetId, buffer) {
  // Dynamic import so the module only resolves when Firebase env vars are present.
  const { bucket, db } = await import('./_firebase.js');
  const storagePath = `golf-paper-craft/assets/${assetId}.png`;
  const file = bucket.file(storagePath);
  await file.save(buffer, { metadata: { contentType: 'image/png' } });
  await file.makePublic();
  const url = file.publicUrl();
  // Update Firestore manifest
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

    // Derive a stable asset ID from the repo path
    // e.g. www/assets/sliced/balls/ball-09.png -> sliced-balls-ball-09
    const assetId = cleanPath
      .replace(/^www\/assets\//, '')
      .replace(/\.png$/i, '')
      .replace(/[/\\]/g, '-');

    // --- Firebase path ---
    if (process.env.FIREBASE_PROJECT_ID) {
      try {
        const { url, storagePath } = await saveToFirebase(assetId, buffer);
        return res.json({ ok: true, url, storagePath, path: cleanPath, backend: 'firebase' });
      } catch (fbErr) {
        console.error('Firebase save failed, falling back to GitHub:', fbErr);
        // fall through to GitHub
      }
    }

    // --- GitHub fallback ---
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
    // Notify Firestore that this asset was updated (enables cross-tab live sync)
    // even when Firebase Storage is not available.
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
