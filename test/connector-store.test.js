import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorStore } from '../src/connector-store.js';

test('Connector state migration disables legacy background identities without deleting them', async (t) => {
  const parent = path.resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'connector-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = await ConnectorStore.load(root, { hubUrl: 'http://hub.test', name: 'mac', hostname: 'mac' });
  store.state.workers.push({
    worker_id: 'worker_legacy',
    name: 'legacy-background',
    runtime: 'codex',
    mode: 'managed',
    runtime_session_id: 'legacy-session',
    push_capable: true,
    driver_state: { started: true },
  });
  await store.save();

  store = await ConnectorStore.load(root, { hubUrl: 'http://hub.test', name: 'mac', hostname: 'mac' });
  const worker = store.getWorker('worker_legacy');
  assert.equal(worker.mode, 'external');
  assert.equal(worker.push_capable, false);
  assert.deepEqual(worker.driver_state, {});
  assert.equal(worker.runtime_session_id, 'legacy-session');
});
