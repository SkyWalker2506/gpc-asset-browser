#!/usr/bin/env node
// One-shot migration: upload existing PNGs to Firebase Storage
// and write manifest + animation-meta to Firestore.
//
// Usage:
//   FIREBASE_PROJECT_ID=vocab-418e1 \
//   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@vocab-418e1.iam.gserviceaccount.com \
//   FIREBASE_PRIVATE_KEY="$(cat ~/.config/firebase/vocab-418e1-key.json | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.private_key)")" \
//   FIREBASE_STORAGE_BUCKET=vocab-418e1.appspot.com \
//   node scripts/migrate-to-firebase.mjs
//
// Idempotent: skips upload if Storage object already exists.
// Run once, then set Vercel env vars and redeploy.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore } from 'firebase-admin/firestore';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');

// --- Init Firebase ---
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`;

if (!projectId || !clientEmail || !privateKey) {
  // Try reading service account JSON directly as fallback
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    `${process.env.HOME}/.config/firebase/vocab-418e1-key.json`;
  if (!existsSync(keyPath)) {
    console.error('Missing Firebase credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY or FIREBASE_SERVICE_ACCOUNT_PATH.');
    process.exit(1);
  }
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  process.env.FIREBASE_PROJECT_ID = key.project_id;
  process.env.FIREBASE_CLIENT_EMAIL = key.client_email;
  process.env.FIREBASE_PRIVATE_KEY = key.private_key;
  process.env.FIREBASE_STORAGE_BUCKET = `${key.project_id}.firebasestorage.app`;
}

const app = getApps()[0] || initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const storage = getStorage(app);
const db = getFirestore(app);
const bucket = storage.bucket();

// --- Load manifest ---
const manifestPath = join(root, 'public', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const items = manifest.items || [];
console.log(`Manifest loaded: ${items.length} items`);

// --- Load animation-meta sidecar ---
const animMetaPath = join(root, 'data', 'animation-meta.json');
let animMeta = { meta: {} };
if (existsSync(animMetaPath)) {
  animMeta = JSON.parse(readFileSync(animMetaPath, 'utf8'));
}
console.log(`Animation meta loaded: ${Object.keys(animMeta.meta || {}).length} entries`);

// --- Try Firebase Storage upload (optional — requires Firebase Storage to be enabled) ---
// Falls back gracefully: if Storage is unavailable, we still write manifest metadata to Firestore.
let uploaded = 0, skipped = 0, failed = 0;
const firestoreManifestAssets = {};
let storageAvailable = true;

// Test Storage availability with a small probe
try {
  const [exists] = await bucket.exists();
  if (!exists) {
    console.warn('Firebase Storage bucket does not exist — skipping PNG uploads, writing metadata only to Firestore.');
    storageAvailable = false;
  }
} catch (e) {
  console.warn('Firebase Storage not accessible:', e.message.split('\n')[0]);
  console.warn('Continuing with Firestore-only migration (metadata + animation-meta).');
  storageAvailable = false;
}

for (const item of items) {
  const assetId = item.id;

  if (storageAvailable) {
    const storagePath = `golf-paper-craft/assets/${assetId}.png`;
    const file = bucket.file(storagePath);

    // Check if already exists (idempotent)
    let [exists] = false;
    try { [exists] = await file.exists(); } catch (_) {}
    if (exists) {
      skipped++;
      const [meta] = await file.getMetadata().catch(() => [{}]);
      firestoreManifestAssets[assetId] = {
        url: file.publicUrl(),
        mtime: meta.updated || item.mtime || Date.now(),
        backend: 'storage',
      };
      if (skipped % 50 === 0) process.stdout.write(`\r  Skipped: ${skipped} / Uploaded: ${uploaded} ...`);
      continue;
    }

    const localSrc = item.src?.replace(/^\.\//, '');
    const localPath = localSrc ? join(root, 'public', localSrc) : null;

    if (!localPath || !existsSync(localPath)) {
      // Record metadata-only entry pointing to local public path
      firestoreManifestAssets[assetId] = { mtime: item.mtime || Date.now(), backend: 'github' };
      failed++;
      continue;
    }

    try {
      await file.save(readFileSync(localPath), { metadata: { contentType: 'image/png' } });
      await file.makePublic();
      const url = file.publicUrl();
      firestoreManifestAssets[assetId] = { url, mtime: item.mtime || Date.now(), backend: 'storage' };
      uploaded++;
      if (uploaded % 10 === 0) process.stdout.write(`\r  Uploaded: ${uploaded} / Skipped: ${skipped} / Failed: ${failed} ...`);
    } catch (e) {
      console.error(`  FAIL ${assetId}: ${e.message.split('\n')[0]}`);
      firestoreManifestAssets[assetId] = { mtime: item.mtime || Date.now(), backend: 'github' };
      failed++;
    }
  } else {
    // Storage not available — record metadata-only (mtime for stale-check, backend=github)
    firestoreManifestAssets[assetId] = { mtime: item.mtime || Date.now(), backend: 'github' };
  }
}

if (storageAvailable) {
  console.log(`\nUpload complete: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
} else {
  console.log(`\nMetadata-only mode: ${items.length} items recorded in Firestore (no Storage uploads).`);
}

// --- Write Firestore manifest ---
console.log('Writing Firestore manifest doc...');
await db.collection('golf-paper-craft').doc('manifest').set(
  { assets: firestoreManifestAssets, updatedAt: Date.now() },
  { merge: true }
);
console.log('  Firestore manifest written.');

// --- Write animation-meta to Firestore ---
if (Object.keys(animMeta.meta || {}).length > 0) {
  console.log(`Writing ${Object.keys(animMeta.meta).length} animation-meta entries to Firestore...`);
  await db.collection('golf-paper-craft').doc('animation-meta').set(
    animMeta.meta,
    { merge: true }
  );
  console.log('  Firestore animation-meta written.');
}

console.log('\nMigration complete!');
console.log('Next steps:');
console.log('  1. Set Vercel env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_STORAGE_BUCKET');
console.log('  2. Deploy to Vercel (./deploy.sh)');
console.log('  3. Open Asset Browser -> Firestore listener should auto-update tiles');
process.exit(0);
