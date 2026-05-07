// Update sourceBbox metadata for an asset (re-crop from source sheet feature).
// POST { assetId: string, bbox: { x, y, w, h } }
// Writes to Firestore golf-paper-craft/source-bbox doc.
// LEGACY sidecar JSON path (GitHub PUT) kept as fallback.
import { gh } from './_config.js';

const SIDECAR_PATH = 'data/source-bbox.json';
const SIDECAR_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };

async function saveToFirestore(assetId, bbox) {
  const { db } = await import('./_firebase.js');
  await db.collection('golf-paper-craft').doc('source-bbox').set(
    { [assetId]: bbox },
    { merge: true }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.GITHUB_TOKEN;

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { assetId, bbox } = body || {};
    if (!assetId || typeof assetId !== 'string') {
      return res.status(400).json({ error: 'assetId (string) required' });
    }
    if (!bbox || typeof bbox.x !== 'number' || typeof bbox.y !== 'number' ||
        typeof bbox.w !== 'number' || typeof bbox.h !== 'number') {
      return res.status(400).json({ error: 'bbox { x, y, w, h } (numbers) required' });
    }
    const cleanBbox = {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      w: Math.max(1, Math.round(bbox.w)),
      h: Math.max(1, Math.round(bbox.h)),
    };

    // --- Firestore path ---
    if (process.env.FIREBASE_PROJECT_ID) {
      try {
        await saveToFirestore(assetId, cleanBbox);
        return res.json({ ok: true, bbox: cleanBbox, backend: 'firestore' });
      } catch (fbErr) {
        console.error('Firestore save failed, falling back to GitHub sidecar:', fbErr);
        // fall through
      }
    }

    // --- GitHub sidecar fallback ---
    if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set (and Firebase not configured)' });
    let existingSha = null;
    let sidecar = {};
    try {
      const fileData = await gh(token, SIDECAR_PATH, { ref: SIDECAR_REPO.branch, github: SIDECAR_REPO });
      existingSha = fileData.sha;
      sidecar = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
    } catch (e) {
      if (!String(e.message).includes('GitHub 404')) throw e;
    }

    sidecar[assetId] = cleanBbox;
    const newContent = btoa(unescape(encodeURIComponent(JSON.stringify(sidecar, null, 2) + '\n')));
    const putBody = {
      message: `asset-browser: set sourceBbox for ${assetId} (${cleanBbox.w}x${cleanBbox.h} @ ${cleanBbox.x},${cleanBbox.y})`,
      content: newContent,
      branch: SIDECAR_REPO.branch,
    };
    if (existingSha) putBody.sha = existingSha;
    const result = await gh(token, SIDECAR_PATH, { method: 'PUT', github: SIDECAR_REPO, body: putBody });
    res.json({ ok: true, commitSha: result?.commit?.sha || null, bbox: cleanBbox, backend: 'github' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };
