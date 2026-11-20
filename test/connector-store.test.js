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

async function freshStore(t) {
  const parent = path.resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'connector-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await ConnectorStore.load(root, { hubUrl: 'http://hub.test', name: 'mac', hostname: 'mac' }) };
}

test('Pruning drops only finished commands the Hub has confirmed, once they are old, and old mail notices', async (t) => {
  const { root, store } = await freshStore(t);
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - 8 * day).toISOString();
  for (const id of ['done_synced', 'done_unsynced', 'recent_synced', 'running', 'accepted']) {
    await store.acceptCommand({ command_id: id, task_id: null, worker_id: 'w', kind: 'task', input: id });
  }
  await store.updateCommand('done_synced', { status: 'succeeded', result: { text: 'ok' } });
  await store.updateCommand('done_unsynced', { status: 'failed', error: { message: 'x' } });
  await store.updateCommand('recent_synced', { status: 'succeeded' });
  await store.updateCommand('running', { status: 'running' });
  assert.equal(await store.markCommandSynced('done_synced'), true);
  assert.equal(await store.markCommandSynced('recent_synced'), true);
  assert.equal(await store.markCommandSynced('running'), false, 'a command still running is never confirmed');
  assert.equal(await store.markCommandSynced('done_synced'), false, 'already confirmed');
  for (const command of store.state.commands) if (command.command_id !== 'recent_synced') command.finished_at &&= old;

  await store.saveMailNotification('mail_old', { runtime: 'codex', session_id: 's', status: 'offered' });
  await store.saveMailNotification('mail_new', { runtime: 'codex', session_id: 's', status: 'offered' });
  store.state.mailNotifications.mail_old.saved_at = new Date(Date.now() - 31 * day).toISOString();

  assert.deepEqual(await store.prune(), { commands: 1, mail: 1 });
  assert.deepEqual(store.listCommands().map((command) => command.command_id), ['done_unsynced', 'recent_synced', 'running', 'accepted']);
  assert.equal(store.getMailNotification('mail_old'), null);
  assert.ok(store.getMailNotification('mail_new'));
  assert.deepEqual(await store.prune(), { commands: 0, mail: 0 });

  const reloaded = await ConnectorStore.load(root, { hubUrl: 'http://hub.test', name: 'mac', hostname: 'mac' });
  assert.equal(reloaded.getCommand('done_synced'), null, 'the pruned state was saved');
});

test('Mail notices saved before notices were dated start aging at the next load', async (t) => {
  const { root, store } = await freshStore(t);
  store.state.mailNotifications.legacy = { runtime: 'codex', session_id: 's', status: 'offered' };
  await store.save();
  const reloaded = await ConnectorStore.load(root, { hubUrl: 'http://hub.test', name: 'mac', hostname: 'mac' });
  assert.ok(reloaded.getMailNotification('legacy').saved_at);
  assert.deepEqual(await reloaded.prune(), { commands: 0, mail: 0 });
});
