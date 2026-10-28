import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerDriver } from '../src/drivers/codex-app-server.js';
import { startSession } from '../src/session-launcher.js';
import { InteractiveChannel } from '../src/interactive-channel.js';
import { createTestContext, waitFor } from './helpers.js';

function harness(options = {}) {
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  child.kill = () => { queueMicrotask(() => { child.stdout.end(); child.emit('close', 0, null); }); return true; };
  const requests = [];
  const turns = [];
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const nativeId = 'native-thread-1';
  const finish = (turnId, status = 'completed') => {
    send({ method: 'item/completed', params: { threadId: nativeId, turnId, item: { type: 'agentMessage', phase: 'commentary', text: 'Working' } } });
    send({ method: 'item/completed', params: { threadId: 'other-thread', turnId, item: { type: 'agentMessage', text: 'wrong thread' } } });
    send({ method: 'item/completed', params: { threadId: nativeId, turnId: 'other-turn', item: { type: 'agentMessage', text: 'wrong turn' } } });
    send({ method: 'item/completed', params: { threadId: nativeId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: `Answer ${turnId}` } } });
    send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: turnId, status, error: status === 'failed' ? { message: 'model failed' } : null } } });
  };
  child.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk));
    requests.push(message);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (['thread/start', 'thread/resume'].includes(message.method)) send({ id: message.id, result: { thread: { id: options.returnId ?? nativeId } } });
    if (message.method === 'turn/start') {
      const turnId = `turn-${turns.length + 1}`;
      turns.push(message);
      if (options.early) finish(turnId);
      send({ id: message.id, result: { turn: { id: turnId } } });
      if (options.auto !== false && !options.early) queueMicrotask(() => finish(turnId, options.status));
    }
  });
  const output = new PassThrough();
  output.resume();
  const driver = new CodexAppServerDriver({
    ...options, output,
    spawn(executable, args, spawnOptions) {
      assert.equal(executable, 'codex');
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
      return child;
    },
  });
  return { driver, child, requests, turns, send, finish };
}

test('Codex push serializes console and Hub turns in one real native identity', async t => {
  const h = harness({ auto: false });
  t.after(() => h.driver.close());
  await h.driver.start();
  const states = [];
  const first = h.driver.execute({ command: { input: 'Hub command', command_id: 'cmd-1' }, onState: s => states.push(s) });
  const second = h.driver.prompt('Console command');
  await waitFor(() => states.length === 1);
  assert.equal(h.turns.length, 1);
  h.finish('turn-1');
  assert.equal((await first).text, 'Answer turn-1');
  await waitFor(() => h.turns.length === 2);
  h.finish('turn-2');
  assert.deepEqual(await second, { text: 'Answer turn-2', session_id: 'native-thread-1', output_gap: false });
  assert.ok(h.turns.every(turn => turn.params.threadId === 'native-thread-1'));
  const start = h.requests.find(r => r.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only');
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(h.requests.filter(r => r.method === 'initialize').length, 1);
});

test('Codex handles completed events before the turn/start response', async t => {
  const { driver } = harness({ early: true });
  t.after(() => driver.close());
  await driver.start();
  assert.equal((await driver.prompt('fast')).text, 'Answer turn-1');
});

test('A failed Hub acknowledgement cannot leave a running turn or start queued work', async t => {
  const h = harness({ auto: false });
  t.after(() => h.driver.close());
  await h.driver.start();
  const result = h.driver.execute({ command: { input: 'Hub command' }, onState() { throw new Error('ack unavailable'); } });
  const queued = h.driver.prompt('must not run');
  const queuedRejected = assert.rejects(queued, /ack unavailable/);
  await assert.rejects(result, /ack unavailable/);
  await queuedRejected;
  assert.equal(h.turns.length, 1);
  assert.equal(h.driver.closed, true);
});

for (const status of ['failed', 'interrupted']) {
  test(`Codex ${status} turn is not a successful receipt`, async t => {
    const { driver } = harness({ status });
    t.after(() => driver.close());
    await driver.start();
    await assert.rejects(driver.prompt('fail'), status === 'failed' ? /model failed/ : /interrupted/);
  });
}

test('Codex rejects mismatched resume identity and unsupported sandbox', async () => {
  const h = harness({ sessionId: 'expected-native-id' });
  await assert.rejects(h.driver.start(), /different thread/);
  assert.ok(h.requests.some(r => r.method === 'thread/resume' && r.params.threadId === 'expected-native-id'));
  assert.throws(() => new CodexAppServerDriver({ sandbox: 'danger-full-access' }), /sandbox/);
});

test('Process loss rejects active and queued prompts with unknown outcome and detaches', async t => {
  const h = harness({ auto: false });
  t.after(() => h.driver.close());
  let detached = false;
  h.driver.onClose = () => { detached = true; };
  await h.driver.start();
  const first = h.driver.prompt('active');
  const second = h.driver.prompt('queued');
  const firstRejected = assert.rejects(first, e => e.outcomeUnknown === true);
  const secondRejected = assert.rejects(second, /exited/);
  await waitFor(() => h.turns.length === 1);
  h.child.emit('close', 1, null);
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(detached, true);
  assert.equal(await h.driver.run(), 1);
  assert.equal(h.turns.length, 1);
});

test('Approval requires a local choice; unsupported server requests cannot auto-approve', async t => {
  const h = harness({ auto: false });
  t.after(() => h.driver.close());
  await h.driver.start();
  const input = new PassThrough();
  h.driver.input = input;
  const run = h.driver.run();
  const result = h.driver.prompt('approval');
  await waitFor(() => h.driver.active?.turnId);
  h.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread-1', turnId: 'turn-1', command: 'write', availableDecisions: ['accept', 'decline'] } });
  assert.equal(h.requests.some(r => r.id === 'approval-1'), false);
  input.write('2\n');
  assert.deepEqual(h.requests.find(r => r.id === 'approval-1').result, { decision: 'decline' });
  h.send({ id: 'unsupported', method: 'item/tool/requestUserInput', params: {} });
  assert.equal(h.requests.find(r => r.id === 'unsupported').error.code, -32601);
  h.finish('turn-1');
  await result;
  input.write('/exit\n');
  assert.equal(await run, 0);
});

test('Codex launcher starts only its persistent channel and preserves native identity', async () => {
  let started = 0, stopped = 0, closed = 0;
  const driver = { sessionId: 'codex-native-launch', async start() { started++; }, async close() { closed++; } };
  const channel = { async start() {}, async run() { return 0; }, async stop() { stopped++; } };
  const result = await startSession({ runtime: 'codex', push: true, codexAppServerDriver: driver, codexChannel: channel,
    spawn() { throw new Error('must not spawn a second client'); } });
  assert.equal(result.sessionId, driver.sessionId);
  assert.equal(result.env.AGENT_HUB_SESSION_ID, driver.sessionId);
  assert.equal(started, 1);
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  await assert.rejects(startSession({ runtime: 'codex', push: true, runtimeArgs: ['--yolo'] }), /does not accept runtime arguments/);
});

test('Hub to Codex SSE push returns the completed turn, then window exit restores manual delivery', async t => {
  const context = await createTestContext(t);
  const h = harness();
  await h.driver.start();
  const worker = await context.registerWorker({ name: 'codex-push-test', runtime: 'codex', mode: 'external', runtime_session_id: h.driver.sessionId });
  const channel = new InteractiveChannel({ runtime: 'codex', connectorUrl: context.connector.localUrl,
    token: context.connector.store.credentials.localToken, sessionId: h.driver.sessionId, driver: h.driver, retryMs: 20 });
  t.after(async () => { channel.stop(); await h.driver.close(); });
  await channel.start();
  await waitFor(() => channel.state === 'attached');
  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'Codex push test' } });
  const id = created.payload.command.command_id;
  const done = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${id}`);
    return payload.command.status === 'succeeded' && payload.command;
  });
  assert.equal(done.result.text, 'Answer turn-1');
  assert.equal(done.result.session_id, h.driver.sessionId);
  assert.equal(done.result.delivery, 'channel');
  await h.driver.close();
  await waitFor(() => context.connector.store.getWorker(worker.worker_id).push_capable === false);
  const later = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'closed' } });
  assert.equal(later.payload.command.status, 'waiting_manual');
});

test('Codex process loss during Hub work preserves an unknown outcome and revokes push', async t => {
  const context = await createTestContext(t);
  const h = harness({ auto: false });
  await h.driver.start();
  const worker = await context.registerWorker({ name: 'codex-crash-test', runtime: 'codex', mode: 'external', runtime_session_id: h.driver.sessionId });
  const channel = new InteractiveChannel({ runtime: 'codex', connectorUrl: context.connector.localUrl,
    token: context.connector.store.credentials.localToken, sessionId: h.driver.sessionId, driver: h.driver });
  t.after(async () => { channel.stop(); await h.driver.close(); });
  await channel.start();
  await waitFor(() => channel.state === 'attached');
  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'interrupted work' } });
  await waitFor(() => h.driver.active?.turnId);
  h.child.emit('close', 1, null);
  const failed = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${created.payload.command.command_id}`);
    return payload.command.status === 'failed' && payload.command;
  });
  assert.equal(failed.outcome_unknown, true);
  assert.equal(failed.error.code, 'channel_closed');
  assert.equal(context.connector.store.getWorker(worker.worker_id).push_capable, false);
});
