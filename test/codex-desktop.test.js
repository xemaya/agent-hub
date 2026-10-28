import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { CodexDesktopDriver } from '../src/drivers/codex-desktop.js';
import { CodexSharedServer, loopbackServerUrl, desktopError } from '../src/codex-shared-server.js';
import { InteractiveChannel } from '../src/interactive-channel.js';
import { createTestContext, waitFor } from './helpers.js';

function fakeClient(options = {}) {
  const calls = [];
  const client = {
    calls,
    async connect() {},
    close(error = desktopError('connection closed', true)) { this.onClose?.(error); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: options.unloaded ? [] : ['native-desktop'], nextCursor: null };
      if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'native-desktop', status: { type: 'active' } } };
      if (method === 'thread/queue/add') {
        if (options.lostResponse) throw desktopError('queue response lost', true);
        return { queuedSubmission: { id: 'submission-1', clientUserMessageId: params.clientUserMessageId, input: params.input } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    notify(method, params) { this.onNotification?.({ method, params: { threadId: 'native-desktop', ...params } }); },
    complete(turnId, { ours = false, status = 'completed', text = 'DESKTOP_OK' } = {}) {
      const queued = calls.find(c => c.method === 'thread/queue/add');
      this.notify('item/completed', { turnId, item: { id: ours ? queued.params.clientUserMessageId : 'user-console', type: 'userMessage', content: [{ type: 'text', text: ours ? queued.params.input[0].text : 'User work before Hub command' }] } });
      this.notify('item/completed', { turnId, item: { type: 'agentMessage', text: 'Working', phase: 'commentary' } });
      this.notify('item/completed', { turnId, item: { type: 'agentMessage', text, phase: 'final_answer' } });
      this.notify('turn/completed', { turn: { id: turnId, status } });
    },
  };
  return client;
}

test('Desktop bridge refuses an unloaded desktop thread before resume or queue mutation', async () => {
  const client = fakeClient({ unloaded: true });
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  await assert.rejects(driver.start(), /not loaded.*refusing to resume/);
  assert.deepEqual(client.calls.map(c => c.method), ['thread/loaded/list']);
});

test('Desktop bridge subscribes only to an already-loaded exact native thread without changing its settings', async t => {
  const client = fakeClient();
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  t.after(() => driver.close());
  await driver.start();
  assert.deepEqual(client.calls.find(c => c.method === 'thread/resume').params, { threadId: 'native-desktop', excludeTurns: true });
  assert.equal(client.calls.some(c => c.method === 'thread/start' || c.method === 'turn/start'), false);
});

test('User work before a queued Hub submission is never mistaken for the Hub result', async t => {
  const client = fakeClient();
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  t.after(() => driver.close());
  await driver.start();
  let ack = false, settled = false;
  const result = driver.execute({ command: { command_id: 'cmd-desktop', input: 'Hub task' }, onState() { ack = true; } });
  result.finally(() => { settled = true; });
  await waitFor(() => ack);
  client.complete('user-turn', { text: 'WRONG_USER_RESULT' });
  await Promise.resolve();
  assert.equal(settled, false);
  client.notify('item/completed', { threadId: 'other-thread', turnId: 'hub-turn', item: { type: 'agentMessage', text: 'wrong thread' } });
  client.complete('hub-turn', { ours: true });
  assert.deepEqual(await result, { text: 'DESKTOP_OK', session_id: 'native-desktop', output_gap: false });
});

test('Desktop input steering the Hub turn detaches with an unknown result', async t => {
  const client = fakeClient();
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  t.after(() => driver.close());
  await driver.start();
  const result = driver.execute({ command: { command_id: 'cmd-steered', input: 'Hub task' } });
  const rejected = assert.rejects(result, error => error.outcomeUnknown === true);
  await waitFor(() => driver.active?.acknowledged);
  const queued = client.calls.find(c => c.method === 'thread/queue/add');
  client.notify('item/completed', { turnId: 'hub-turn', item: { type: 'userMessage', id: queued.params.clientUserMessageId, content: [] } });
  client.notify('item/completed', { turnId: 'hub-turn', item: { type: 'userMessage', id: 'another-user-input', content: [] } });
  await rejected;
  assert.equal(driver.closed, true);
  assert.equal(client.calls.some(c => c.method === 'turn/interrupt'), false);
});

test('Lost queue response is never retried and cannot be reported as success', async () => {
  const client = fakeClient({ lostResponse: true });
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  await driver.start();
  await assert.rejects(driver.execute({ command: { command_id: 'cmd-lost', input: 'Hub task' } }), e => e.outcomeUnknown === true);
  assert.equal(client.calls.filter(c => c.method === 'thread/queue/add').length, 1);
  assert.equal(driver.closed, true);
});

test('A completed failed desktop turn remains a known failure and keeps the bridge available', async t => {
  const client = fakeClient();
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  t.after(() => driver.close());
  await driver.start();
  const result = driver.execute({ command: { command_id: 'cmd-failed', input: 'fail' } });
  const rejected = assert.rejects(result, e => e.outcomeUnknown === false && /failed/.test(e.message));
  await waitFor(() => driver.active?.acknowledged);
  client.complete('failed-hub-turn', { ours: true, status: 'failed' });
  await rejected;
  assert.equal(driver.closed, false);
});

test('Shared-server connection accepts only explicit loopback endpoints', () => {
  assert.equal(loopbackServerUrl('ws://127.0.0.1:45123'), 'ws://127.0.0.1:45123/');
  for (const url of ['ws://0.0.0.0:45123', 'ws://example.com:45123', 'ws://user:secret@127.0.0.1:45123', 'http://127.0.0.1:45123']) {
    assert.throws(() => loopbackServerUrl(url), /must be/);
  }
});

test('Desktop transport uses experimental handshake and does not answer native approvals', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const messages = [];
  let peer;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  const client = new CodexSharedServer({ url: `ws://127.0.0.1:${server.address().port}` });
  t.after(async () => { client.close(); await new Promise(resolve => server.close(resolve)); });
  await client.connect();
  assert.equal(messages[0].params.capabilities.experimentalApi, true);
  peer.send(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: {} }));
  await waitFor(() => client.closed);
  assert.equal(messages.some(m => m.id === 77), false);
});

test('Hub desktop SSE flow returns only the queued command turn and revokes push on disconnect', async t => {
  const context = await createTestContext(t);
  const client = fakeClient();
  const driver = new CodexDesktopDriver({ sessionId: 'native-desktop', client });
  const worker = await context.registerWorker({ runtime: 'codex', mode: 'external', runtime_session_id: 'native-desktop' });
  const channel = new InteractiveChannel({ runtime: 'codex', connectorUrl: context.connector.localUrl, token: context.connector.store.credentials.localToken,
    sessionId: 'native-desktop', driver });
  t.after(() => { channel.stop(); driver.close(); });
  await channel.start();
  await waitFor(() => channel.state === 'attached');
  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'desktop task' } });
  await waitFor(() => driver.active?.acknowledged);
  client.complete('previous-user-turn', { text: 'not the result' });
  client.complete('hub-turn', { ours: true });
  const finished = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${created.payload.command.command_id}`);
    return payload.command.status === 'succeeded' && payload.command;
  });
  assert.equal(finished.result.text, 'DESKTOP_OK');
  assert.equal(finished.result.session_id, 'native-desktop');
  assert.equal(finished.result.delivery, 'channel');
  driver.close();
  await waitFor(() => context.connector.store.getWorker(worker.worker_id).push_capable === false);
});
