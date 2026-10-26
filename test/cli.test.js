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
