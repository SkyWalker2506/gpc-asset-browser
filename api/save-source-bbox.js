// POST { assetId, bbox: { x, y, w, h }, pngBase64 }
// 1. Updates data/source-bbox.json with the new bbox
// 2. Publishes the re-cropped PNG to the same destination as save-edits
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, gh, DATA_REPO } from './_config.js';
import { supabaseUpsertManifest } from './_supabase.js';

const BBOX_FILE = path.resolve(process.cwd(), 'data/source-bbox.json');

function readBboxStore() {
  if (!fs.existsSync(BBOX_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BBOX_FILE, 'utf8')); } catch { return {}; }
}

function writeBboxStore(store) {
  fs.writeFileSync(BBOX_FILE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { assetId, assetPath, bbox, pngBase64 } = body || {};

    if (!assetId || typeof assetId !== 'string') return res.status(400).json({ error: 'assetId required' });
    if (!bbox || typeof bbox.x !== 'number') return res.status(400).json({ error: 'bbox { x,y,w,h } required' });
    if (!pngBase64 || typeof pngBase64 !== 'string') return res.status(400).json({ error: 'pngBase64 required' });
    if (!assetPath || typeof assetPath !== 'string') return res.status(400).json({ error: 'assetPath required' });

    const cleanPath = assetPath.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!cleanPath.startsWith('www/assets/')) return res.status(400).json({ error: 'assetPath must start with www/assets/' });
    if (cleanPath.includes('..')) return res.status(400).json({ error: 'path traversal blocked' });

    // 1. Update source-bbox.json
    const store = readBboxStore();
    store[assetId] = { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
    writeBboxStore(store);

    // 2. Persist source-bbox.json to DATA_REPO (gpc-asset-browser)
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      try {
        const bboxContent = Buffer.from(JSON.stringify(store, null, 2) + '\n').toString('base64');
        let existingSha;
        try {
          const cur = await gh(token, 'data/source-bbox.json', { ref: 'main', github: DATA_REPO });
          existingSha = cur.sha;
        } catch (_) {}
        await gh(token, 'data/source-bbox.json', {
          method: 'PUT', github: DATA_REPO,
          body: {
            message: `asset-browser: update source-bbox for ${assetId}`,
            content: bboxContent,
            branch: 'main',
            ...(existingSha ? { sha: existingSha } : {}),
          },
        });
      } catch (e) {
        console.warn('source-bbox.json persist failed (non-fatal):', e.message);
      }
    }

    // 3. Publish the re-cropped PNG (same logic as save-edits)
    const cleanB64 = pngBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanB64, 'base64');

    // Firebase path
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
        // Dual-write manifest to Supabase (non-fatal)
        let supabaseResult = null;
        if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          try {
            supabaseResult = await supabaseUpsertManifest(assetId, url, Date.now());
          } catch (spErr) {
            console.warn('Supabase manifest upsert failed (non-fatal):', spErr.message);
          }
        }
        return res.json({ ok: true, url, storagePath, backend: 'firebase', bboxSaved: true, supabase: supabaseResult ? 'ok' : 'skipped' });
      } catch (fbErr) {
        console.error('Firebase save failed, falling back to GitHub:', fbErr);
      }
    }

    // GitHub fallback
    if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
    const config = readConfig();
    if (!config.github?.owner || !config.github?.repo) return res.status(500).json({ error: 'config.github missing' });
    const branch = config.github.branch || 'main';
    let existingShaAsset;
    try {
      const cur = await gh(token, cleanPath, { ref: branch, github: config.github });
      existingShaAsset = cur.sha;
    } catch (_) {}
    const filename = cleanPath.split('/').pop();
    const result = await gh(token, cleanPath, {
      method: 'PUT', github: config.github,
      body: {
        message: `asset-browser: re-crop from source sheet ${filename}`,
        content: cleanB64,
        branch,
        ...(existingShaAsset ? { sha: existingShaAsset } : {}),
      },
    });
    // Dual-write manifest to Supabase (non-fatal)
    let supabaseResult = null;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const config2 = readConfig();
        const branch2 = config2.github?.branch || 'main';
        const publicUrl = `https://raw.githubusercontent.com/${config2.github?.owner}/${config2.github?.repo}/${branch2}/${cleanPath}`;
        supabaseResult = await supabaseUpsertManifest(assetId, publicUrl, Date.now());
      } catch (spErr) {
        console.warn('Supabase manifest upsert failed (non-fatal):', spErr.message);
      }
    }
    res.json({ ok: true, commitSha: result?.commit?.sha || null, path: cleanPath, backend: 'github', bboxSaved: true, supabase: supabaseResult ? 'ok' : 'skipped' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
