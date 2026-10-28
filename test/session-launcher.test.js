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
  const kimiSessions = {
    async prepareSession(input) {
      prepared.push(input);
      return { runtime_session_id: 'session-current-kimi', driver_state: {} };
    },
    async close() { closed += 1; },
  };
  const result = await startSession({
    runtime: 'kimi',
    cwd: process.cwd(),
    runtimeArgs: ['-p', 'hello'],
    kimiSessions,
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
  const kimiSessions = {
    async prepareSession() {
      return { runtime_session_id: 'session-current-kimi', driver_state: {} };
    },
    async close() { closed += 1; },
  };
  await assert.rejects(startSession({
    runtime: 'kimi',
    kimiSessions,
    spawn() { throw new Error('client unavailable'); },
  }), /client unavailable/);
  assert.equal(closed, 1);
});

test('Kimi push launcher shares one ACP Session until the interactive window exits', async () => {
  const prepared = [];
  let temporaryDriverClosed = 0;
  let acpDriverClosed = 0;
  let channelStarted = 0;
  let channelStopped = 0;
  let temporaryDriverClosedAtStart = -1;
  const kimiSessions = {
    async prepareSession(input) {
      prepared.push(input);
      return { runtime_session_id: input.runtime_session_id, driver_state: {} };
    },
    async close() { temporaryDriverClosed += 1; },
  };
  const kimiAcpDriver = {
    async close() { acpDriverClosed += 1; },
  };
  const kimiChannel = {
    async start() {
      temporaryDriverClosedAtStart = temporaryDriverClosed;
      channelStarted += 1;
    },
    async run() { return 0; },
    async stop() { channelStopped += 1; },
  };
  const result = await startSession({
    runtime: 'kimi',
    cwd: process.cwd(),
    push: true,
    resumeSessionId: 'session-resume-kimi',
    kimiSessions,
    kimiAcpDriver,
    kimiChannel,
    spawn() { throw new Error('Kimi push must not spawn a second TUI client'); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, 'session-resume-kimi');
  assert.equal(prepared[0].runtime_session_id, 'session-resume-kimi');
  assert.deepEqual(result.args, ['acp']);
  assert.equal(result.env.AGENT_HUB_SESSION_ID, 'session-resume-kimi');
  assert.equal(Object.hasOwn(result.env, 'KIMI_CODE_SESSION_LOCK'), false);
  assert.equal(temporaryDriverClosedAtStart, 1);
  assert.equal(channelStarted, 1);
  assert.equal(channelStopped, 1);
  assert.equal(temporaryDriverClosed, 1);
  assert.equal(acpDriverClosed, 1);
});

test('Codex launcher opens a fresh client and leaves native identity to Codex', async () => {
  const calls = [];
  const result = await startSession({
    runtime: 'codex',
    cwd: process.cwd(),
    runtimeArgs: ['--no-alt-screen'],
    env: { EXISTING: 'preserved', AGENT_HUB_SESSION_ID: 'stale-id' },
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return fakeChild();
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.runtime, 'codex');
  assert.equal(result.sessionId, null);
  assert.equal(calls[0].executable, 'codex');
  assert.deepEqual(calls[0].args, ['--no-alt-screen']);
  assert.equal(calls[0].options.cwd, path.resolve(process.cwd()));
  assert.equal(calls[0].options.env.AGENT_HUB_RUNTIME, 'codex');
  assert.equal(Object.hasOwn(calls[0].options.env, 'AGENT_HUB_SESSION_ID'), false);
  assert.equal(calls[0].options.env.EXISTING, 'preserved');
});

test('Kimi native TUI launcher opens the real client with a local Channel', async () => {
  const socketPath = path.join(process.cwd(), '.test-tmp', 'native-launcher.sock');
  const calls = [];
  let nativeDriverClosed = 0;
  let channelStarted = 0;
  let channelStopped = 0;
  const kimiSessions = {
    async prepareSession(input) {
      return { runtime_session_id: input.runtime_session_id, driver_state: {} };
    },
    async close() {},
  };
  const kimiNativeDriver = {
    async close() { nativeDriverClosed += 1; },
  };
  const kimiChannel = {
    async start() { channelStarted += 1; },
    async stop() { channelStopped += 1; },
    async run() { throw new Error('Native TUI must not run the ACP interface'); },
  };
  const result = await startSession({
    runtime: 'kimi',
    cwd: process.cwd(),
    push: true,
    nativeTui: true,
    resumeSessionId: 'session-native-tui',
    runtimeArgs: ['--model', 'kimi-code/kimi-for-coding'],
    nativeChannelPath: socketPath,
    env: { AGENT_HUB_KIMI_EXECUTABLE: '/opt/kimi-dev' },
    kimiSessions,
    kimiNativeDriver,
    kimiChannel,
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return fakeChild();
    },
  });
  assert.equal(result.nativeTui, true);
  assert.equal(result.env.KIMI_CODE_EXPERIMENTAL_TUI_CHANNEL, '1');
  assert.equal(result.socketPath, socketPath);
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].executable, '/opt/kimi-dev');
  assert.deepEqual(calls[0].args, ['--session', 'session-native-tui', '--channel', socketPath, '--model', 'kimi-code/kimi-for-coding']);
  assert.equal(calls[0].options.env.AGENT_HUB_SESSION_ID, 'session-native-tui');
  assert.equal(channelStarted, 1);
  assert.equal(channelStopped, 1);
  assert.equal(nativeDriverClosed, 1);
  await assert.rejects(startSession({ runtime: 'kimi', nativeTui: true }), /--native-tui requires --runtime kimi --push/);
});
