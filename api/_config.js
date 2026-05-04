// Shared: read config.json at runtime to get github owner/repo/branch
import fs from 'node:fs';
import path from 'node:path';

export function readConfig() {
  const p = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export async function gh(token, repoPath, opts = {}) {
  const { owner, repo, branch = 'main' } = opts.github;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}${opts.ref ? `?ref=${opts.ref || branch}` : ''}`;
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
