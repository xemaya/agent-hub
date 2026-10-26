import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../src/cli.js';

const TEST_ROOT = path.resolve('.test-tmp');

test('local and wait flags work with task and send commands', async (t) => {
  await mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await mkdtemp(path.join(TEST_ROOT, 'cli-'));
  await writeFile(path.join(dataDir, 'connector.json'), JSON.stringify({ localToken: 'test-local' }), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const calls = [];
  console.log = () => {};
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const isCommand = String(url).endsWith('/commands');
    return new Response(JSON.stringify(isCommand
      ? { command: { command_id: 'cmd-1', status: 'succeeded', result: { text: 'done' } } }
      : { task: { task_id: 'task-1', status: 'done' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await rm(dataDir, { recursive: true, force: true });
  });

  await run(['task', 'update', '--local', 'task-1', '--status', 'done', '--data-dir', dataDir]);
  await run(['send', '--local', '--wait', '--task-id', 'task-1', '--prompt', 'finish', '--data-dir', dataDir]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/local/v1/tasks/task-1');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-local');
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: 'done' });
  assert.equal(calls[1].url, 'http://127.0.0.1:8788/local/v1/commands');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    task_id: 'task-1',
    kind: 'prompt',
    input: 'finish',
    wait: true,
  });
});

test('register-current uses launcher identity and rejects unverified sessions', async (t) => {
  await mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await mkdtemp(path.join(TEST_ROOT, 'cli-current-'));
  await writeFile(path.join(dataDir, 'connector.json'), JSON.stringify({ localToken: 'test-local' }), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalRuntime = process.env.AGENT_HUB_RUNTIME;
  const originalSessionId = process.env.AGENT_HUB_SESSION_ID;
  const calls = [];
  console.log = () => {};
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ worker: { worker_id: 'worker-current' } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalRuntime === undefined) delete process.env.AGENT_HUB_RUNTIME;
    else process.env.AGENT_HUB_RUNTIME = originalRuntime;
    if (originalSessionId === undefined) delete process.env.AGENT_HUB_SESSION_ID;
    else process.env.AGENT_HUB_SESSION_ID = originalSessionId;
    await rm(dataDir, { recursive: true, force: true });
  });

  process.env.AGENT_HUB_RUNTIME = 'kimi';
  process.env.AGENT_HUB_SESSION_ID = 'session-current-test';
  await run([
    'worker', 'register-current',
    '--name', 'current-kimi',
    '--cwd', '/tmp/project',
    '--capabilities', 'coding,review',
    '--metadata', '{"description":"当前职责"}',
    '--data-dir', dataDir,
  ]);
  assert.equal(calls.length, 1);
  const registration = JSON.parse(calls[0].options.body);
  assert.equal(registration.runtime, 'kimi');
  assert.equal(registration.mode, 'external');
  assert.equal(registration.runtime_session_id, 'session-current-test');
  assert.equal(registration.metadata.description, '当前职责');
  assert.equal(registration.metadata.interactive, true);
  assert.equal(registration.metadata.session_origin, 'agent-hub-session-launcher');

  delete process.env.AGENT_HUB_RUNTIME;
  delete process.env.AGENT_HUB_SESSION_ID;
  await assert.rejects(
    run(['worker', 'register-current', '--data-dir', dataDir]),
    /start with agent-hub session start/,
  );
  assert.equal(calls.length, 1);
});
