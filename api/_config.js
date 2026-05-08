// Shared: read config.json at runtime to get github owner/repo/branch
import fs from 'node:fs';
import path from 'node:path';

// Data files (missing.json, review.json, trash/, uploads/) live in the
// gpc-asset-browser submodule repo, NOT in the main golf-paper-craft repo.
export const DATA_REPO = { owner: 'SkyWalker2506', repo: 'gpc-asset-browser', branch: 'main' };

export function readConfig() {
  const p = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export async function gh(token, repoPath, opts = {}) {
  const { owner, repo, branch = 'main' } = opts.github;
  // URL-encode path segments (preserve slashes) to handle spaces, non-ASCII, etc.
  const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}${opts.ref ? `?ref=${opts.ref || branch}` : ''}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}
