#!/usr/bin/env node
/**
 * build-manifest.mjs — Build asset-browser UI manifest.
 *
 * Source of truth = www/assets/manifest.json (produced by
 * www/lib/asset-system/scripts/scan-assets.js). For every source dir
 * configured in config.json that lives under www/assets/sliced/, we
 * project the canonical entries into the asset-browser UI schema.
 * Sources outside www/assets/sliced/ (animations/, batch*-generated/,
 * incoming/, art-style-study/) are scanned directly — they are not
 * covered by the canonical manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'config.json'), 'utf8'));
const PROJECT_ROOT = path.resolve(ROOT, CONFIG.projectRoot || '..');
const OUT_DIR = path.resolve(ROOT, 'public');
const MANIFEST_OUT = path.join(OUT_DIR, 'manifest.json');
const CANONICAL_PATH = path.resolve(PROJECT_ROOT, 'www/assets/manifest.json');

// Load canonical manifest (single source of truth for www/assets/sliced/**).
let canonical = { assets: [] };
if (fs.existsSync(CANONICAL_PATH)) {
  canonical = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  console.log(`Canonical manifest: ${canonical.assets?.length || 0} assets (${canonical.generatedAt})`);
} else {
  console.warn('No canonical manifest found at', CANONICAL_PATH, '- run scan-assets.js first');
}
// Index canonical assets by absolute path (for sliced sources).
const canonicalByPath = new Map();
for (const a of canonical.assets || []) {
  // a.path is relative to www/, e.g. "assets/sliced/balls/ball-01.png"
  const abs = path.resolve(PROJECT_ROOT, 'www', a.path);
  canonicalByPath.set(abs, a);
}

function classify(name) {
  const n = name.toLowerCase();
  if (/character|miner|merchant|chicken|peasent|peasant|smith|child|woman|man|npc|croc|butterfly|fish|bird|enemy/.test(n)) return 'Character';
  if (/fire|smoke|dust|spark|particle|burst|glow|explosion|magic|flash|shine/.test(n)) return 'FX';
  if (/cart|wagon|cargo|vehicle|car|ship|boat/.test(n)) return 'Vehicle';
  if (/smelter|factory|mill|church|castle|tower|house|barn|tavern|building|market|bridge|shop/.test(n)) return 'Building';
  if (/tree|forest|cliff|mountain|stone|rock|plant|flower/.test(n)) return 'Nature';
  if (/icon|ui|button|frame|panel|logo|hud|badge/.test(n)) return 'UI';
  if (/tile|ground|grass|water|road|path|sand|dirt|deck/.test(n)) return 'Tile';
  if (/loop|anim|cycle|strip|[-_]\d+f/i.test(n)) return 'Animation';
  if (/ball/.test(n)) return 'Character';
  return 'Other';
}

function getDim(file) {
  try {
    return execSync(`magick identify -format "%wx%h" ${JSON.stringify(file)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

function dimsFromCanonical(a) {
  if (a && a.w && a.h) return `${a.w}x${a.h}`;
  return '';
}

const items = [];
let canonicalHits = 0;
let scannedHits = 0;

for (const s of CONFIG.sources || []) {
  const abs = path.resolve(PROJECT_ROOT, s.dir);
  if (!fs.existsSync(abs)) { console.warn(`skip (missing): ${s.dir}`); continue; }
  const files = fs.readdirSync(abs).filter(f => /\.(png|webp|jpg|jpeg|gif)$/i.test(f));
  for (const f of files) {
    const full = path.join(abs, f);
    const base = path.basename(f, path.extname(f));
    const ext = path.extname(f).slice(1).toLowerCase();
    const isAnim = ext === 'gif' || /[-_]\d+f\b/i.test(base) || /loop|anim|cycle|strip/i.test(base);

    // Prefer canonical record (covers everything under www/assets/sliced/).
    const canon = canonicalByPath.get(full);
    let dim = '';
    let size = 0;
    let mtime = '';
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch {}
    if (canon) {
      dim = dimsFromCanonical(canon);
      canonicalHits++;
    } else {
      dim = getDim(full);
      scannedHits++;
    }

    // Derive repo-relative path for save-back (always set so resolveRepoPath works).
    const derivedCanonicalPath = canon
      ? (canon.path.startsWith('www/') ? canon.path : 'www/' + canon.path)
      : path.relative(PROJECT_ROOT, full).replace(/\\/g, '/');

    items.push({
      id: `${s.tag}-${base}`,
      name: base,
      file: f,
      ext,
      src: `./assets/${s.tag}/${f}`,
      srcAbs: full,
      category: s.category,
      kind: classify(base),
      type: isAnim ? 'Animasyon' : 'Resim',
      size,
      dim,
      mtime,
      canonicalPath: derivedCanonicalPath,
      // Pass canonical fields through when available (frontend can ignore).
      ...(canon ? {
        canonicalId: canon.id,
        tags: canon.tags,
        ...(canon.course ? { course: canon.course } : {}),
        ...(canon.frameCount ? { frameCount: canon.frameCount } : {}),
      } : {}),
    });
  }
}

items.sort((a, b) => a.name.localeCompare(b.name));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(MANIFEST_OUT, JSON.stringify({
  generated: new Date().toISOString(),
  title: CONFIG.title || 'Asset Browser',
  count: items.length,
  source: 'canonical:www/assets/manifest.json + scanned non-sliced sources',
  canonicalCount: canonical.assets?.length || 0,
  items,
}, null, 2));

console.log(`Manifest: ${items.length} items -> ${MANIFEST_OUT}`);
console.log(`  canonical-backed: ${canonicalHits}, scanned: ${scannedHits}`);
