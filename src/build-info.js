import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function git(rootDir, args, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync('git', ['-C', rootDir, ...args], { timeout });
  return stdout.trim();
}

export async function readBuildInfo(rootDir = PROJECT_ROOT) {
  let version = null;
  try {
    version = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).version ?? null;
  } catch {}
  let commit = null;
  let dirty = false;
  try {
    commit = await git(rootDir, ['rev-parse', 'HEAD']);
    dirty = (await git(rootDir, ['status', '--porcelain', '--untracked-files=no'])) !== '';
  } catch {}
  return { version, commit, dirty };
}

export function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : 'unknown';
}
