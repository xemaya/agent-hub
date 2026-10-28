import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KimiNativeChannelDriver } from '../src/drivers/kimi-native-channel.js';

async function socketFixture(t, onPrompt, directory = null) {
  directory ??= await mkdtemp(path.join(os.tmpdir(), 'agent-hub-native-'));
  const socketPath = path.join(directory, 'channel.sock');
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.write(`${JSON.stringify({ version: 1, type: 'ready', session_id: 'session-native' })}\n`);
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'prompt') onPrompt(socket, message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}

function send(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

test('native Channel sends prompts and correlates streaming results by request and turn', async (t) => {
  const received = [];
  const socketPath = await socketFixture(t, (socket, message) => {
    received.push(message);
    send(socket, { version: 1, type: 'prompt.accepted', request_id: message.id });
    send(socket, { version: 1, type: 'prompt.started', request_id: message.id, turn_id: 42 });
    send(socket, { version: 1, type: 'assistant.delta', request_id: message.id, turn_id: 41, delta: 'wrong-turn' });
    send(socket, { version: 1, type: 'assistant.delta', request_id: message.id, turn_id: 42, delta: 'NATIVE_' });
    send(socket, { version: 1, type: 'assistant.delta', request_id: message.id, turn_id: 42, delta: 'OK' });
    send(socket, { version: 1, type: 'prompt.completed', request_id: message.id, turn_id: 42, status: 'succeeded', output_gap: false });
  });
  const driver = new KimiNativeChannelDriver({ socketPath, sessionId: 'session-native', retryMs: 10 });
  t.after(() => driver.close());
  await driver.start();
  const states = [];
  const chunks = [];
  const result = await driver.execute({
    command: { command_id: 'cmd-native', input: '/not-a-slash-command' },
    onState: (state) => states.push(state),
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.text, 'NATIVE_OK');
  assert.equal(result.session_id, 'session-native');
  assert.equal(result.prompt_id, 'cmd-native');
  assert.equal(result.output_gap, false);
  assert.equal(chunks.join(''), 'NATIVE_OK');
  assert.deepEqual(states, [{ started: true, prompt_id: 'cmd-native' }]);
  assert.deepEqual(received, [{ version: 1, type: 'prompt', id: 'cmd-native', text: '/not-a-slash-command' }]);
});

test('native Channel marks an unconfirmed result unknown after disconnect', async (t) => {
  const socketPath = await socketFixture(t, (socket) => socket.destroy());
  const driver = new KimiNativeChannelDriver({ socketPath, sessionId: 'session-native', retryMs: 10000 });
  t.after(() => driver.close());
  await driver.start();
  await assert.rejects(
    driver.execute({ command: { command_id: 'cmd-disconnect', input: 'do not replay' } }),
    (error) => error.code === 'native_channel_closed' && error.outcomeUnknown === true,
  );
});

test('native Channel rejects a different live Session instead of dispatching into it', async (t) => {
  const socketPath = await socketFixture(t, () => {
    throw new Error('Prompt must not be dispatched after a Session switch');
  });
  const driver = new KimiNativeChannelDriver({ socketPath, sessionId: 'different-session', retryMs: 10000 });
  t.after(() => driver.close());
  await driver.start();
  await assert.rejects(
    driver.execute({ command: { command_id: 'cmd-switch', input: 'do not use another session' } }),
    (error) => error.code === 'native_session_changed' && error.outcomeUnknown !== true,
  );
});

test('native Channel waits for the TUI socket to appear', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-native-late-'));
  const socketPath = path.join(directory, 'channel.sock');
  const driver = new KimiNativeChannelDriver({ socketPath, sessionId: 'session-native', retryMs: 10 });
  t.after(() => driver.close());
  await driver.start();
  const execution = driver.execute({ command: { command_id: 'cmd-late', input: 'wait for the native window' } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await socketFixture(t, (socket, message) => {
    send(socket, { version: 1, type: 'prompt.accepted', request_id: message.id });
    send(socket, { version: 1, type: 'prompt.started', request_id: message.id, turn_id: 1 });
    send(socket, { version: 1, type: 'assistant.delta', request_id: message.id, turn_id: 1, delta: 'ready' });
    send(socket, { version: 1, type: 'prompt.completed', request_id: message.id, turn_id: 1, status: 'succeeded' });
  }, directory);
  assert.equal((await execution).text, 'ready');
});
