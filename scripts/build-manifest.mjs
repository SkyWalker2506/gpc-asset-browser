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

const INCOMING_DIR = path.resolve(PROJECT_ROOT, 'www/assets/incoming');

// Load sourceBbox sidecar (asset-browser/data/source-bbox.json).
const SOURCE_BBOX_PATH = path.resolve(ROOT, 'data/source-bbox.json');
let sourceBboxSidecar = {};
if (fs.existsSync(SOURCE_BBOX_PATH)) {
  try {
    sourceBboxSidecar = JSON.parse(fs.readFileSync(SOURCE_BBOX_PATH, 'utf8'));
    const count = Object.keys(sourceBboxSidecar).length;
    if (count) console.log(`sourceBbox sidecar: ${count} entries`);
  } catch (e) { console.warn('Failed to read source-bbox.json:', e.message); }
} else {
  // Create empty sidecar so the file exists for API writes.
  try { fs.writeFileSync(SOURCE_BBOX_PATH, '{}', 'utf8'); } catch (_) {}
}

/**
 * Given a sliced canonicalPath like 'www/assets/sliced/batch16/atlas-5-cosmetics/file.png',
 * derive the likely source sheet path in www/assets/incoming/.
 * Tries multiple naming conventions and returns the first match.
 * Returns a repo-relative path string, or null if not found.
 */
function deriveSourceSheet(canonicalPath) {
  if (!canonicalPath || !canonicalPath.includes('/sliced/')) return null;
  if (!fs.existsSync(INCOMING_DIR)) return null;
  // Strip 'www/assets/sliced/' prefix, split into parts.
  const rel = canonicalPath.replace(/^www\/assets\/sliced\//, '');
  const parts = rel.split('/');
  if (parts.length < 2) return null; // need at least batch/file
  const batch = parts[0];  // e.g. 'batch16', 'batch11', 'batch8', 'balls'
  const atlas = parts.length >= 3 ? parts[1] : ''; // e.g. 'atlas-5-cosmetics'
  // Build candidate filenames to try, in priority order.
  const candidates = [];
  if (atlas) {
    candidates.push(`${batch}-${atlas}-sheet.png`);
    candidates.push(`${batch}-${atlas}.png`);
  }
  // Single-level sliced dir (e.g. batch11, batch8, balls)
  candidates.push(`${batch}-sheet.png`);
  candidates.push(`${batch}-reference-sheet.png`);
  candidates.push(`${batch}-flags-reference-sheet.png`);
  // Also try without 'sheet' suffix
  candidates.push(`${batch}.png`);
  for (const name of candidates) {
    const candidate = path.join(INCOMING_DIR, name);
    if (fs.existsSync(candidate)) {
      return path.relative(PROJECT_ROOT, candidate).replace(/\\/g, '/');
    }
  }
  return null;
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
      // Source sheet re-crop support: derive source sheet path if available.
      ...(() => {
        const itemId = `${s.tag}-${base}`;
        const sheet = deriveSourceSheet(derivedCanonicalPath);
        if (!sheet) return {};
        const bbox = sourceBboxSidecar[itemId] || null;
        return { sourceSheet: sheet, sourceBbox: bbox };
      })(),
    });
  }
}

items.sort((a, b) => a.name.localeCompare(b.name));

// Merge animation-meta sidecar (data/animation-meta.json) into items.
const SIDECAR_PATH = path.resolve(ROOT, 'data/animation-meta.json');
if (fs.existsSync(SIDECAR_PATH)) {
  try {
    const sidecar = JSON.parse(fs.readFileSync(SIDECAR_PATH, 'utf8'));
    const meta = sidecar.meta || {};
    let merged = 0;
    for (const item of items) {
      if (meta[item.id]) {
        item.animation = meta[item.id];
        merged++;
      }
    }
    console.log(`Animation sidecar: ${merged} items merged from data/animation-meta.json`);
  } catch (e) {
    console.warn('Failed to read animation-meta sidecar:', e.message);
  }
}

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
