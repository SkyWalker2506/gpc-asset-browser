#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.resolve(ROOT, 'public/assets');
const manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'public/manifest.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const tags = new Map();
for (const item of manifest.items) {
  const tag = item.src.split('/')[2];
  if (!tags.has(tag)) {
    const d = path.join(OUT, tag);
    fs.mkdirSync(d, { recursive: true });
    tags.set(tag, d);
  }
  fs.copyFileSync(item.srcAbs, path.join(tags.get(tag), item.file));
}
for (const item of manifest.items) delete item.srcAbs;
fs.writeFileSync(path.resolve(ROOT, 'public/manifest.json'), JSON.stringify(manifest, null, 2));

// copy missing.json (items with prompts) into public/
const missingSrc = path.resolve(ROOT, 'data/missing.json');
if (fs.existsSync(missingSrc)) {
  fs.copyFileSync(missingSrc, path.resolve(ROOT, 'public/missing.json'));
}
// copy review.json (flagged-for-review items) into public/
const reviewSrc = path.resolve(ROOT, 'data/review.json');
if (fs.existsSync(reviewSrc)) {
  fs.copyFileSync(reviewSrc, path.resolve(ROOT, 'public/review.json'));
}
// copy uploads/ if any
const uploadsDir = path.resolve(ROOT, 'data/uploads');
if (fs.existsSync(uploadsDir)) {
  const dst = path.resolve(ROOT, 'public/uploads');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(uploadsDir)) fs.copyFileSync(path.join(uploadsDir, f), path.join(dst, f));
}

// config.json for client to know github repo
fs.copyFileSync(path.resolve(ROOT, 'config.json'), path.resolve(ROOT, 'public/config.json'));

console.log(`Copied ${manifest.count} assets to ${OUT}`);
