import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodexQueueChannel, commandRecord } from '../src/codex-queue-channel.js';
import { createTestContext, waitFor } from './helpers.js';

const execute = promisify(execFile);
const cli = path.resolve('bin/agent-hub.js');

async function setup(t, queue) {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime: 'codex', attach: false, runtime_session_id: 'native-queue-session' });
  const attempts = [];
  const channel = new CodexQueueChannel({ connectorUrl: context.connector.localUrl, token: context.connector.store.credentials.localToken,
    dataDir: path.join(context.root, 'connector'), sessionId: 'native-queue-session', cwd: context.root,
    retryMs: 20,
    queue: async (...args) => { attempts.push(args); return queue ? queue(channel, ...args) : { stdout: 'Queued message queued-native-id for thread native-queue-session.' }; },
    logger: { error() {} },
  });
  const running = channel.start();
  running.catch(() => {});
  t.after(async () => { channel.stop(); await running.catch(() => {}); });
  await waitFor(() => channel.state === 'attached');
  return { context, worker, channel, attempts, running };
}

async function send(context, worker) {
  return (await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'bounded desktop instruction' } })).payload.command;
}

function report(context, id, sessionId = 'native-queue-session') {
  const pending = execute(process.execPath, [cli, 'desktop', 'report', '--data-dir', path.join(context.root, 'connector'), '--command-id', id, '--status', 'succeeded'],
    { env: { ...process.env, CODEX_SESSION_ID: sessionId, AGENT_HUB_RUNTIME: 'codex', AGENT_HUB_SESSION_ID: sessionId } });
  pending.child.stdin.end('NATIVE_QUEUE_REPORT_OK');
  return pending;
}

test('Native desktop queue uses the real session ID and waits for an explicit in-session receipt', async t => {
  const { context, worker, channel, attempts } = await setup(t);
  const command = await send(context, worker);
  await waitFor(() => attempts.length === 1);
  assert.equal(attempts[0][0], 'codex');
  assert.deepEqual(attempts[0][1].slice(0, 3), ['queue', '--thread', 'native-queue-session']);
  assert.equal(attempts[0][1].includes('exec'), false);
  assert.match(attempts[0][1][4], /desktop.*report/);
  assert.match(attempts[0][1][4], /command_id:/);
  assert.match(attempts[0][1][4], /本地 CLI.*单次提升权限机制/);
  assert.match(attempts[0][1][4], /fetch failed.*不重复执行/);
  const record = JSON.parse(await readFile(commandRecord(channel.dataDir, channel.sessionId, command.command_id), 'utf8'));
  assert.equal(record.session_id, 'native-queue-session');
  assert.equal((await context.admin(`/api/v1/commands/${command.command_id}`)).payload.command.status, 'running');
  await report(context, command.command_id);
  const done = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${command.command_id}`);
    return payload.command.status === 'succeeded' && payload.command;
  });
  assert.equal(done.result.text, 'NATIVE_QUEUE_REPORT_OK');
  assert.equal(done.result.delivery, 'channel');
  await assert.rejects(report(context, command.command_id), /EEXIST/);
});

test('A receipt from a different native session cannot finish the command', async t => {
  const { context, worker, attempts } = await setup(t);
  const command = await send(context, worker);
  await waitFor(() => attempts.length === 1);
  await assert.rejects(report(context, command.command_id, 'wrong-native-session'), /ENOENT/);
  assert.equal((await context.admin(`/api/v1/commands/${command.command_id}`)).payload.command.status, 'running');
});

test('A native queue failure is not retried and preserves the unknown outcome', async t => {
  const { context, worker, attempts, running } = await setup(t, async () => { throw Object.assign(new Error('queue subprocess timed out'), { killed: true }); });
  const command = await send(context, worker);
  await assert.rejects(running, /unknown.*timeout/);
  const failed = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${command.command_id}`);
    return payload.command.status === 'failed' && payload.command;
  });
  assert.equal(failed.outcome_unknown, true);
  assert.equal(attempts.length, 1);
});

test('A delivery record prevents a duplicate queue submission', async t => {
  const { channel, attempts } = await setup(t);
  const event = { command_id: 'cmd-deduplication', content: 'test' };
  channel.call = async () => {};
  await channel.deliver(event);
  await assert.rejects(channel.deliver(event), /EEXIST/);
  assert.equal(attempts.length, 1);
});

test('A fast in-session completion before queue returns remains successful', async t => {
  let context;
  const configured = await setup(t, async (channel, executable, args) => {
    const commandId = /command_id: ([^\n]+)/.exec(args[4])[1];
    await channel.call(commandId, 'report', { status: 'succeeded', result: 'FAST_QUEUE_RESULT' });
    return { stdout: 'Queued message fast-id for thread native-queue-session.' };
  });
  context = configured.context;
  const command = await send(context, configured.worker);
  const done = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${command.command_id}`);
    return payload.command.status === 'succeeded' && payload.command;
  });
  assert.equal(done.result.text, 'FAST_QUEUE_RESULT');
});

test('Connector restart restores local and Hub push state without replaying an uncertain command', async t => {
  const { context, worker, channel, attempts } = await setup(t);
  const first = await send(context, worker);
  await waitFor(() => attempts.length === 1);
  await context.restartConnector({ reuseLocalPort: true });
  await waitFor(() => context.connector.store.getWorker(worker.worker_id)?.push_capable === true);
  await waitFor(() => context.hub.store.getWorker(worker.worker_id)?.push_capable === true);
  assert.equal(channel.stopped, false);
  assert.equal(attempts.length, 1, 'the old queue invocation must not be repeated');
  const failed = (await context.admin(`/api/v1/commands/${first.command_id}`)).payload.command;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.outcome_unknown, true);

  const second = await send(context, worker);
  await waitFor(() => attempts.length === 2);
  await report(context, second.command_id);
  await waitFor(async () => (await context.admin(`/api/v1/commands/${second.command_id}`)).payload.command.status === 'succeeded');
});

test('Renaming a live Worker preserves its Hub and local push flags without replacing its channel', async t => {
  const { context, worker, channel, attempts } = await setup(t);
  await waitFor(() => context.hub.store.getWorker(worker.worker_id)?.push_capable);
  const renamed = await context.registerWorker({ runtime: 'codex', attach: false,
    runtime_session_id: 'native-queue-session', name: 'renamed-desktop',
  });
  assert.equal(renamed.worker_id, worker.worker_id);
  assert.equal(renamed.name, 'renamed-desktop');
  assert.equal(renamed.push_capable, true);
  assert.equal(context.connector.store.getWorker(worker.worker_id).push_capable, true);
  assert.equal(context.hub.store.getWorker(worker.worker_id).push_capable, true);
  assert.equal(channel.stopped, false);
  assert.equal(attempts.length, 0);
});

test('An acknowledgement transport failure reconnects without repeating the accepted native queue call', async t => {
  let acceptQueue;
  const accepted = new Promise(resolve => { acceptQueue = resolve; });
  const { context, worker, channel, attempts } = await setup(t, async () => {
    await accepted;
    return { stdout: 'Queued message accepted-once for thread native-queue-session.' };
  });
  await send(context, worker);
  await waitFor(() => attempts.length === 1);
  await context.connector.close();
  acceptQueue();
  await waitFor(() => channel.state === 'connecting');
  assert.equal(channel.stopped, false);
  await context.restartConnector({ reuseLocalPort: true });
  await waitFor(() => context.connector.store.getWorker(worker.worker_id)?.push_capable === true);
  await waitFor(() => context.hub.store.getWorker(worker.worker_id)?.push_capable === true);
  assert.equal(attempts.length, 1);
});

test('Authentication rejection is terminal rather than a reconnect loop', async t => {
  const context = await createTestContext(t);
  const channel = new CodexQueueChannel({ connectorUrl: context.connector.localUrl, token: 'invalid-local-token',
    dataDir: path.join(context.root, 'connector'), sessionId: 'not-attached', retryMs: 10,
  });
  await assert.rejects(channel.start(), /401/);
  assert.equal(channel.stopped, true);
});
