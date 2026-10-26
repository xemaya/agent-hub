import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { startSession } from '../src/session-launcher.js';

function fakeChild(code = 0) {
  const child = new EventEmitter();
  process.nextTick(() => child.emit('close', code, null));
  return child;
}

test('Claude launcher binds the current native session and forwards runtime arguments', async () => {
  const calls = [];
  const result = await startSession({
    runtime: 'claude',
    cwd: process.cwd(),
    runtimeArgs: ['-p', 'hello'],
    env: { EXISTING: 'preserved' },
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return fakeChild();
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.runtime, 'claude');
  assert.equal(calls[0].executable, 'claude');
  assert.deepEqual(calls[0].args, ['--session-id', result.sessionId, '-p', 'hello']);
  assert.equal(calls[0].options.env.AGENT_HUB_RUNTIME, 'claude');
  assert.equal(calls[0].options.env.AGENT_HUB_SESSION_ID, result.sessionId);
  assert.equal(calls[0].options.env.EXISTING, 'preserved');
  assert.equal(calls[0].options.cwd, path.resolve(process.cwd()));
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('Kimi launcher attaches the created native session and closes its server', async () => {
  const calls = [];
  const prepared = [];
  let closed = 0;
  let closedAtSpawn = -1;
  const kimiDriver = {
    async prepareWorker(input) {
      prepared.push(input);
      return { runtime_session_id: 'session-current-kimi', driver_state: {} };
    },
    async close() { closed += 1; },
  };
  const result = await startSession({
    runtime: 'kimi',
    cwd: process.cwd(),
    runtimeArgs: ['-p', 'hello'],
    kimiDriver,
    spawn(executable, args, options) {
      closedAtSpawn = closed;
      calls.push({ executable, args, options });
      return fakeChild();
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, 'session-current-kimi');
  assert.deepEqual(calls[0].args, ['--session', 'session-current-kimi', '-p', 'hello']);
  assert.equal(calls[0].options.env.AGENT_HUB_RUNTIME, 'kimi');
  assert.equal(calls[0].options.env.AGENT_HUB_SESSION_ID, 'session-current-kimi');
  assert.equal(prepared[0].cwd, path.resolve(process.cwd()));
  assert.equal(closedAtSpawn, 1);
  assert.equal(closed, 1);
});

test('Kimi launcher closes its server when the client cannot start', async () => {
  let closed = 0;
  const kimiDriver = {
    async prepareWorker() {
      return { runtime_session_id: 'session-current-kimi', driver_state: {} };
    },
    async close() { closed += 1; },
  };
  await assert.rejects(startSession({
    runtime: 'kimi',
    kimiDriver,
    spawn() { throw new Error('client unavailable'); },
  }), /client unavailable/);
  assert.equal(closed, 1);
});
