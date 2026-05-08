// Supabase REST helper — no SDK dependency, pure fetch.
// Tables:
//   manifest_entries (id, asset_id, url, mtime, backend, created_at, updated_at)
//   asset_overrides  (id, workspace_id, asset_key, scope, overrides jsonb, updated_at, asset_id, animation jsonb)

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
    'apikey': key,
    'Prefer': 'resolution=merge-duplicates,return=representation',
  };
}

function base() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL not set');
  return url.replace(/\/$/, '');
}

/**
 * Upsert a manifest_entries row using PATCH-if-exists, POST-if-new pattern.
 * Falls back gracefully if the row already exists.
 */
export async function supabaseUpsertManifest(assetId, url, mtime) {
  const hdrs = supabaseHeaders();
  const b = base();
  const payload = {
    url,
    mtime: mtime || Date.now(),
    backend: 'firebase',
    updated_at: new Date().toISOString(),
  };
  // Try PATCH first (update if exists)
  const patchRes = await fetch(`${b}/rest/v1/manifest_entries?asset_id=eq.${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    headers: { ...hdrs, 'Prefer': 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!patchRes.ok) throw new Error(`Supabase manifest PATCH failed (${patchRes.status}): ${await patchRes.text()}`);
  const patched = await patchRes.json();
  if (patched && patched.length > 0) return patched;
  // No row found — INSERT
  const postRes = await fetch(`${b}/rest/v1/manifest_entries`, {
    method: 'POST',
    headers: { ...hdrs, 'Prefer': 'return=representation' },
    body: JSON.stringify({ asset_id: assetId, ...payload }),
  });
  if (!postRes.ok) throw new Error(`Supabase manifest INSERT failed (${postRes.status}): ${await postRes.text()}`);
  return postRes.json();
}

/**
 * Upsert an asset_overrides row for animation meta.
 * Uses PATCH-if-exists, POST-if-new pattern.
 */
export async function supabaseUpsertAnimation(assetId, animData) {
  const hdrs = supabaseHeaders();
  const b = base();
  const payload = {
    animation: animData,
    updated_at: new Date().toISOString(),
  };
  // Try PATCH first
  const patchRes = await fetch(`${b}/rest/v1/asset_overrides?asset_id=eq.${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    headers: { ...hdrs, 'Prefer': 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!patchRes.ok) throw new Error(`Supabase animation PATCH failed (${patchRes.status}): ${await patchRes.text()}`);
  const patched = await patchRes.json();
  if (patched && patched.length > 0) return patched;
  // No row found — INSERT
  const postRes = await fetch(`${b}/rest/v1/asset_overrides`, {
    method: 'POST',
    headers: { ...hdrs, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      asset_id: assetId,
      asset_key: assetId,
      scope: 'global',
      animation: animData,
      overrides: {},
    }),
  });
  if (!postRes.ok) throw new Error(`Supabase animation INSERT failed (${postRes.status}): ${await postRes.text()}`);
  return postRes.json();
}
