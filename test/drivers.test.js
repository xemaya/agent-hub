import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { CodexDriver } from '../src/drivers/codex.js';
import { KimiDriver } from '../src/drivers/kimi.js';

function fakeJsonlProcess(events, code = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
  });
  return child;
}

test('ClaudeDriver creates then resumes a stable session', async () => {
  const calls = [];
  const driver = new ClaudeDriver({
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return fakeJsonlProcess([
        { type: 'system', subtype: 'init', session_id: 'session-claude' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ]);
    },
  });
  const worker = {
    runtime_session_id: 'session-claude',
    driver_state: {},
    cwd: process.cwd(),
    metadata: {},
  };
  const states = [];
  const outputs = [];
  const onState = (state) => {
    worker.driver_state = state;
    states.push(state);
  };
  const first = await driver.execute({
    worker,
    command: { command_id: 'cmd-1', kind: 'prompt', input: 'hello' },
    onOutput: (chunk) => outputs.push(chunk),
    onState,
  });
  assert.equal(first.text, 'done');
  assert.ok(calls[0].args.includes('--session-id'));
  assert.ok(!calls[0].args.includes('--resume'));
  assert.ok(outputs.some((chunk) => chunk.includes('working')));
  const second = await driver.execute({
    worker,
    command: { command_id: 'cmd-2', kind: 'prompt', input: 'continue' },
    onOutput() {},
    onState,
  });
  assert.equal(second.text, 'done');
  assert.ok(calls[1].args.includes('--resume'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'session-claude');
  assert.ok(states.every((state) => state.started));
  await driver.close();
});

test('CodexDriver creates and explicitly resumes its own thread', async () => {
  const calls = [];
  const driver = new CodexDriver({
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return fakeJsonlProcess([
        { type: 'thread.started', thread_id: 'thread-codex' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'working' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: {} },
      ]);
    },
  });
  const prepared = await driver.prepareWorker({});
  const registrationId = prepared.runtime_session_id;
  const worker = { ...prepared, cwd: process.cwd(), metadata: {} };
  const states = [];
  const outputs = [];
  const onState = (state) => {
    worker.driver_state = state;
    states.push(state);
  };
  const first = await driver.execute({
    worker,
    command: { command_id: 'cmd-codex-1', kind: 'prompt', input: 'hello' },
    onOutput: (chunk) => outputs.push(chunk),
    onState,
  });
  assert.equal(first.text, 'done');
  assert.equal(first.session_id, 'thread-codex');
  assert.equal(calls[0].args[0], 'exec');
  assert.ok(!calls[0].args.includes('resume'));
  assert.ok(calls[0].args.includes('--json'));
  assert.equal(calls[0].args[calls[0].args.indexOf('-c') + 1], 'sandbox_mode="read-only"');
  assert.equal(calls[0].args[calls[0].args.indexOf('--cd') + 1], process.cwd());
  assert.deepEqual(outputs, ['working\n', 'done\n']);

  worker.metadata = { codex_sandbox: 'workspace-write', codex_model: 'codex-test-model' };
  const second = await driver.execute({
    worker,
    command: { command_id: 'cmd-codex-2', kind: 'prompt', input: 'continue' },
    onOutput() {},
    onState,
  });
  assert.equal(second.session_id, 'thread-codex');
  assert.equal(calls[1].args[1], 'resume');
  assert.ok(calls[1].args.includes('thread-codex'));
  assert.ok(!calls[1].args.includes('--last'));
  assert.equal(calls[1].args[calls[1].args.indexOf('-c') + 1], 'sandbox_mode="workspace-write"');
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'codex-test-model');
  assert.equal(worker.runtime_session_id, registrationId);
  assert.ok(states.every((state) => state.started && state.session_id === 'thread-codex'));
  assert.equal(driver.children.size, 0);
  await driver.close();
});

test('CodexDriver rejects unsafe sandboxes and propagates execution errors', async () => {
  const driver = new CodexDriver({
    spawn() {
      return fakeJsonlProcess([
        { type: 'thread.started', thread_id: 'thread-codex-error' },
        { type: 'turn.failed', error: { message: 'model failed' } },
      ]);
    },
  });
  const prepared = await driver.prepareWorker({});
  const worker = { ...prepared, cwd: process.cwd(), metadata: { codex_sandbox: 'danger-full-access' } };
  await assert.rejects(
    driver.execute({
      worker,
      command: { command_id: 'cmd-codex-invalid', kind: 'prompt', input: 'hello' },
      onOutput() {},
      onState(state) { worker.driver_state = state; },
    }),
    (error) => error.code === 'codex_invalid_sandbox',
  );
  worker.metadata = {};
  await assert.rejects(
    driver.execute({
      worker,
      command: { command_id: 'cmd-codex-error', kind: 'prompt', input: 'hello' },
      onOutput() {},
      onState(state) { worker.driver_state = state; },
    }),
    (error) => error.code === 'codex_execution_failed' && error.message === 'model failed',
  );
  assert.equal(driver.children.size, 0);
  await driver.close();
});

test('KimiDriver subscribes, submits a prompt and consumes turn events', async (t) => {
  const promptBodies = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer kimi-test') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 40101, msg: 'unauthorized' }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.method === 'POST' && request.url === '/api/v1/sessions') {
      response.end(JSON.stringify({ code: 0, msg: 'success', data: { id: 'session_kimi' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/sessions/session_kimi/prompts') {
      promptBodies.push(body);
      response.end(JSON.stringify({ code: 0, msg: 'success', data: { prompt_id: body.prompt_id } }));
      setImmediate(() => {
        for (const socket of sockets) {
          socket.send(JSON.stringify({ type: 'assistant.delta', session_id: 'session_kimi', offset: 0, payload: { delta: 'OK' } }));
          socket.send(JSON.stringify({ type: 'turn.ended', session_id: 'session_kimi', payload: { status: 'completed' } }));
        }
      });
      return;
    }
    response.end(JSON.stringify({ code: 40401, msg: 'not found' }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    if (!String(request.headers['sec-websocket-protocol']).includes('kimi-code.bearer.kimi-test')) {
      socket.close(1008, 'unauthorized');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'subscribe') {
        socket.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, msg: 'success', payload: {} }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  const driver = new KimiDriver({
    server: { baseUrl: `http://127.0.0.1:${address.port}`, token: 'kimi-test' },
  });
  const prepared = await driver.prepareWorker({ cwd: process.cwd() });
  assert.equal(prepared.runtime_session_id, 'session_kimi');
  let output = '';
  const result = await driver.execute({
    worker: {
      runtime_session_id: prepared.runtime_session_id,
      driver_state: {},
      metadata: { kimi_permission_mode: 'manual', kimi_model: 'kimi-code/test-model' },
    },
    command: {
      command_id: 'cmd-kimi',
      kind: 'prompt',
      input: 'hello',
      task_snapshot: { task_id: 'task-kimi', title: 'Kimi task', goal: 'Test', context: '', acceptance: [], status: 'ready' },
    },
    onOutput: (chunk) => { output += chunk; },
    onState() {},
  });
  assert.equal(output, 'OK');
  assert.equal(result.text, 'OK');
  assert.equal(result.prompt_id, 'cmd-kimi');
  assert.equal(promptBodies.length, 1);
  assert.equal(promptBodies[0].prompt_id, 'cmd-kimi');
  assert.equal(promptBodies[0].permission_mode, 'manual');
  assert.equal(promptBodies[0].model, 'kimi-code/test-model');
  assert.match(promptBodies[0].content[0].text, /Kimi task/);
  await driver.close();
});
