import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadHubCredentials } from '../src/credentials.js';

const TEST_ROOT = path.resolve('.test-tmp');

test('Hub credentials persist with private permissions', async (t) => {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEST_ROOT, 'credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await loadHubCredentials(directory, {});
  assert.match(first.adminToken, /^ah_admin_/);
  assert.match(first.enrollmentToken, /^ah_enroll_/);
  assert.deepEqual(first.generated.sort(), ['adminToken', 'enrollmentToken']);
  assert.equal((await stat(first.file)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(first.file, 'utf8'));
  assert.equal(stored.adminToken, first.adminToken);
  const second = await loadHubCredentials(directory, {});
  assert.equal(second.adminToken, first.adminToken);
  assert.equal(second.enrollmentToken, first.enrollmentToken);
  assert.deepEqual(second.generated, []);
});

test('Environment credentials are not written to disk', async (t) => {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEST_ROOT, 'credentials-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = await loadHubCredentials(directory, {
    AGENT_HUB_ADMIN_TOKEN: 'admin-from-env',
    AGENT_HUB_ENROLLMENT_TOKEN: 'enroll-from-env',
  });
  assert.equal(credentials.adminToken, 'admin-from-env');
  assert.equal(credentials.enrollmentToken, 'enroll-from-env');
  await assert.rejects(readFile(credentials.file, 'utf8'), { code: 'ENOENT' });
});
