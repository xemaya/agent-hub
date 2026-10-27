import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_ROOT, git, readBuildInfo, shortCommit } from './build-info.js';

const execFileAsync = promisify(execFile);

async function isAncestor(rootDir, ancestor, descendant) {
  try {
    await git(rootDir, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function installDependencies(rootDir) {
  await execFileAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: rootDir, timeout: 300000 });
}

// Fast-forwards this checkout to its upstream. Never touches a dirty, ahead or diverged tree.
export async function selfUpdate({
  rootDir = PROJECT_ROOT,
  peerCommit = null,
  install = installDependencies,
} = {}) {
  const build = await readBuildInfo(rootDir);
  if (!build.commit) return { action: 'skipped', reason: 'not a git checkout' };
  if (build.dirty) return { action: 'skipped', reason: 'local changes present', from: build.commit };
  await git(rootDir, ['fetch', '--quiet'], { timeout: 60000 });
  let upstream;
  try {
    upstream = await git(rootDir, ['rev-parse', '@{u}']);
  } catch {
    return { action: 'skipped', reason: 'no upstream branch', from: build.commit };
  }
  const peerPublished = peerCommit ? await isAncestor(rootDir, peerCommit, upstream) : true;
  if (upstream === build.commit) {
    return {
      action: 'current',
      from: build.commit,
      to: build.commit,
      ...(peerPublished ? {} : { reason: `peer runs unpublished commit ${shortCommit(peerCommit)}` }),
    };
  }
  if (!(await isAncestor(rootDir, build.commit, upstream))) {
    return { action: 'skipped', reason: 'local branch is ahead of or diverged from upstream', from: build.commit };
  }
  const changed = await git(rootDir, ['diff', '--name-only', build.commit, upstream]);
  await git(rootDir, ['merge', '--ff-only', '--quiet', upstream]);
  const lockChanged = changed.split('\n').some((file) => ['package.json', 'pnpm-lock.yaml'].includes(file));
  if (lockChanged) await install(rootDir);
  return {
    action: 'updated',
    from: build.commit,
    to: upstream,
    dependencies_installed: lockChanged,
    ...(peerPublished ? {} : { reason: `peer runs unpublished commit ${shortCommit(peerCommit)}` }),
  };
}
