// Shared helper: move a file from origin to trash/ (with meta)
import { gh } from './_config.js';

export async function moveToTrash(token, config, branch, originPath, originDir, reason = '') {
  const uploadPrefix = config.uploadPath || 'asset-browser/data/uploads';
  const trashDir = config.trashPath || `${uploadPrefix.split('/').slice(0, -1).join('/')}/trash`;
  const filename = originPath.split('/').pop();

  let meta;
  try { meta = await gh(token, originPath, { ref: branch, github: config.github }); } catch { return false; }

  // fetch content (handle large files via blobs API)
  let content = meta.content;
  if (!content) {
    const blob = await fetch(`https://api.github.com/repos/${config.github.owner}/${config.github.repo}/git/blobs/${meta.sha}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    }).then(r => r.json());
    content = blob.content;
  }

  // PUT to trash/
  const trashPath = `${trashDir}/${filename}`;
  let tSha;
  try { tSha = (await gh(token, trashPath, { ref: branch, github: config.github })).sha; } catch {}
  await gh(token, trashPath, {
    method: 'PUT', github: config.github,
    body: { message: `trash: ${filename}${reason ? ' ('+reason+')' : ''}`, content, branch, ...(tSha ? { sha: tSha } : {}) },
  });

  // PUT meta (origin info for restore)
  const metaPath = `${trashDir}/${filename.replace(/\.[^.]+$/, '')}.meta.json`;
  const metaContent = Buffer.from(JSON.stringify({
    originPath, originDir, reason, deletedAt: new Date().toISOString(),
  }, null, 2)).toString('base64');
  let mSha;
  try { mSha = (await gh(token, metaPath, { ref: branch, github: config.github })).sha; } catch {}
  await gh(token, metaPath, {
    method: 'PUT', github: config.github,
    body: { message: `trash meta: ${filename}`, content: metaContent, branch, ...(mSha ? { sha: mSha } : {}) },
  });

  // DELETE from origin
  await gh(token, originPath, {
    method: 'DELETE', github: config.github,
    body: { message: `delete (moved to trash): ${filename}`, sha: meta.sha, branch },
  });

  return true;
}
