// Shared helper: move a file from origin to trash/ (with meta)
// Files in data/trash/ are stored in the gpc-asset-browser data repo.
// Runtime asset files (www/assets/...) are in golf-paper-craft repo.
import { DATA_REPO, gh } from './_config.js';

export async function moveToTrash(token, config, branch, originPath, originDir, reason = '') {
  // Determine which repo the origin file lives in.
  // Runtime files (www/assets/...) are in golf-paper-craft; data files in gpc-asset-browser.
  const isRuntimeFile = originPath.startsWith('www/') || originPath.startsWith('/www/');
  const originRepo = isRuntimeFile ? config.github : DATA_REPO;
  const originBranch = originRepo.branch || 'main';

  const trashDir = 'data/trash';
  const filename = originPath.split('/').pop();

  let meta;
  try { meta = await gh(token, originPath, { ref: originBranch, github: originRepo }); } catch { return false; }

  // fetch content (handle large files via blobs API)
  let content = meta.content;
  if (!content) {
    const blob = await fetch(`https://api.github.com/repos/${originRepo.owner}/${originRepo.repo}/git/blobs/${meta.sha}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    }).then(r => r.json());
    content = blob.content;
  }

  // PUT to trash/ in gpc-asset-browser
  const trashPath = `${trashDir}/${filename}`;
  let tSha;
  try { tSha = (await gh(token, trashPath, { ref: DATA_REPO.branch, github: DATA_REPO })).sha; } catch {}
  await gh(token, trashPath, {
    method: 'PUT', github: DATA_REPO,
    body: { message: `trash: ${filename}${reason ? ' ('+reason+')' : ''}`, content, branch: DATA_REPO.branch, ...(tSha ? { sha: tSha } : {}) },
  });

  // PUT meta (origin info for restore)
  const metaPath = `${trashDir}/${filename.replace(/\.[^.]+$/, '')}.meta.json`;
  const metaContent = Buffer.from(JSON.stringify({
    originPath, originDir, originRepo: originRepo.repo, reason, deletedAt: new Date().toISOString(),
  }, null, 2)).toString('base64');
  let mSha;
  try { mSha = (await gh(token, metaPath, { ref: DATA_REPO.branch, github: DATA_REPO })).sha; } catch {}
  await gh(token, metaPath, {
    method: 'PUT', github: DATA_REPO,
    body: { message: `trash meta: ${filename}`, content: metaContent, branch: DATA_REPO.branch, ...(mSha ? { sha: mSha } : {}) },
  });

  // DELETE from origin
  await gh(token, originPath, {
    method: 'DELETE', github: originRepo,
    body: { message: `delete (moved to trash): ${filename}`, sha: meta.sha, branch: originBranch },
  });

  return true;
}
