import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installLocal } from '../scripts/install-local.js';

const TEST_ROOT = path.resolve('.test-tmp');

async function createHome(t) {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(path.join(TEST_ROOT, 'install-'));
  const connectorDataDir = path.join(home, 'live-connector');
  await mkdir(connectorDataDir, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, connectorDataDir };
}

test('local installer links the CLI and shared Skill idempotently', async (t) => {
  const { home, connectorDataDir } = await createHome(t);
  const first = await installLocal({ home, connectorDataDir, checkHealth: false });
  assert.equal(first.links.length, 4);
  assert.ok(first.links.every((link) => link.status === 'created'));
  const skill = await readFile(path.join(home, '.agents', 'skills', 'agent-hub', 'SKILL.md'), 'utf8');
  assert.match(skill, /name: agent-hub/);
  assert.match(
    await readFile(path.join(home, '.claude', 'skills', 'agent-hub', 'SKILL.md'), 'utf8'),
    /name: agent-hub/,
  );
  assert.equal(
    await readlink(path.join(home, '.agent-hub', 'connector')),
    connectorDataDir,
  );
  await access(path.join(home, '.local', 'bin', 'agent-hub'), constants.X_OK);

  const second = await installLocal({ home, connectorDataDir, checkHealth: false });
  assert.ok(second.links.every((link) => link.status === 'unchanged'));
  const otherConnector = path.join(home, 'other-connector');
  await mkdir(otherConnector);
  await assert.rejects(
    installLocal({ home, connectorDataDir: otherConnector, checkHealth: false }),
    /Refusing to replace existing path/,
  );
  assert.equal(await readlink(path.join(home, '.agent-hub', 'connector')), connectorDataDir);
});

test('local installer does not overwrite an existing file or create partial links', async (t) => {
  const { home, connectorDataDir } = await createHome(t);
  const cliLink = path.join(home, '.local', 'bin', 'agent-hub');
  await mkdir(path.dirname(cliLink), { recursive: true });
  await writeFile(cliLink, 'keep-existing-file');
  await assert.rejects(
    installLocal({ home, connectorDataDir, checkHealth: false }),
    /Refusing to replace existing path/,
  );
  assert.equal(await readFile(cliLink, 'utf8'), 'keep-existing-file');
  await assert.rejects(access(path.join(home, '.agents', 'skills', 'agent-hub')));
  await assert.rejects(access(path.join(home, '.claude', 'skills', 'agent-hub')));
  await assert.rejects(access(path.join(home, '.agent-hub', 'connector')));
});

test('local installer preserves a real home Connector directory', async (t) => {
  const { home } = await createHome(t);
  const connectorDataDir = path.join(home, '.agent-hub', 'connector');
  await mkdir(connectorDataDir, { recursive: true });
  const result = await installLocal({ home, connectorDataDir, checkHealth: false });
  const connector = result.links.find((link) => link.path === connectorDataDir);
  assert.equal(connector.status, 'unchanged');
  const stats = await lstat(connectorDataDir);
  assert.ok(stats.isDirectory());
  assert.equal(stats.isSymbolicLink(), false);
  const second = await installLocal({ home, connectorDataDir, checkHealth: false });
  assert.ok(second.links.every((link) => link.status === 'unchanged'));
});
