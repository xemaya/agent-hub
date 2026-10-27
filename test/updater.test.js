import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { selfUpdate } from '../src/updater.js';

const execFileAsync = promisify(execFile);
const IDENTITY = ['-c', 'user.name=agent-hub-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', [...IDENTITY, '-C', cwd, ...args]);
  return stdout.trim();
}

async function commitFile(repo, file, content, message) {
  await writeFile(path.join(repo, file), content);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// origin.git <- author pushes; install is the checkout a Connector would run from.
async function createRepos(t) {
  await mkdir(path.resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-tmp', 'updater-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const install = path.join(root, 'install');
  await execFileAsync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['clone', '--quiet', origin, author]);
  await git(author, 'checkout', '--quiet', '-b', 'main');
  await commitFile(author, 'package.json', '{"version":"0.1.0"}\n', 'init');
  await git(author, 'push', '--quiet', '-u', 'origin', 'main');
  await execFileAsync('git', ['clone', '--quiet', origin, install]);
  return { author, install };
}

test('Self-update fast-forwards a clean checkout and installs only when dependencies change', async (t) => {
  const { author, install } = await createRepos(t);
  let installs = 0;
  const countInstall = async () => {
    installs += 1;
  };
  const codeCommit = await commitFile(author, 'feature.js', 'export {};\n', 'feature');
  await git(author, 'push', '--quiet');
  const first = await selfUpdate({ rootDir: install, peerCommit: codeCommit, install: countInstall });
  assert.equal(first.action, 'updated');
  assert.equal(first.to, codeCommit);
  assert.equal(first.reason, undefined);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), codeCommit);
  assert.equal(installs, 0);

  const dependencyCommit = await commitFile(author, 'package.json', '{"version":"0.2.0"}\n', 'bump');
  await git(author, 'push', '--quiet');
  const second = await selfUpdate({ rootDir: install, install: countInstall });
  assert.equal(second.action, 'updated');
  assert.equal(second.to, dependencyCommit);
  assert.equal(second.dependencies_installed, true);
  assert.equal(installs, 1);

  const current = await selfUpdate({ rootDir: install, install: countInstall });
  assert.equal(current.action, 'current');
});

test('Self-update refuses dirty or diverged checkouts and flags an unpublished peer', async (t) => {
  const { author, install } = await createRepos(t);
  const unpublished = await commitFile(author, 'local-only.js', 'export {};\n', 'not pushed');
  const peer = await selfUpdate({ rootDir: install, peerCommit: unpublished });
  assert.equal(peer.action, 'current');
  assert.match(peer.reason, /unpublished/);

  await writeFile(path.join(install, 'package.json'), '{"edited":true}\n');
  const dirty = await selfUpdate({ rootDir: install });
  assert.equal(dirty.action, 'skipped');
  assert.match(dirty.reason, /local changes/);
  await git(install, 'checkout', '--quiet', '--', 'package.json');

  await git(author, 'push', '--quiet');
  await commitFile(install, 'mine.js', 'export {};\n', 'local work');
  const diverged = await selfUpdate({ rootDir: install });
  assert.equal(diverged.action, 'skipped');
  assert.match(diverged.reason, /ahead of or diverged/);
});
