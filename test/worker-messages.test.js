import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Connector } from '../src/connector.js';
import { KimiChannel } from '../src/kimi-channel.js';
import { run } from '../src/cli.js';
import { createTestContext, TestDriver, waitFor } from './helpers.js';

const silentLogger = { error() {} };

function identity(worker) {
  return { runtime: worker.runtime, runtime_session_id: worker.runtime_session_id };
}

async function runAsCurrent(context, worker, args) {
  const original = {
    runtime: process.env.AGENT_HUB_RUNTIME,
    sessionId: process.env.AGENT_HUB_SESSION_ID,
    codexSessionId: process.env.CODEX_SESSION_ID,
    log: console.log,
  };
  const output = [];
  process.env.AGENT_HUB_RUNTIME = 'kimi';
  process.env.AGENT_HUB_SESSION_ID = worker.runtime_session_id;
  delete process.env.CODEX_SESSION_ID;
  console.log = value => output.push(value);
  try {
    await run([
      ...args,
      '--data-dir', path.join(context.root, 'connector'),
      '--connector-url', context.connector.localUrl,
    ]);
    return JSON.parse(output.join('\n'));
  } finally {
    if (original.runtime === undefined) delete process.env.AGENT_HUB_RUNTIME;
    else process.env.AGENT_HUB_RUNTIME = original.runtime;
    if (original.sessionId === undefined) delete process.env.AGENT_HUB_SESSION_ID;
    else process.env.AGENT_HUB_SESSION_ID = original.sessionId;
    if (original.codexSessionId === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = original.codexSessionId;
    console.log = original.log;
  }
}

async function startPeer(t, context) {
  const connector = await Connector.create({
    hubUrl: context.hub.url,
    name: 'peer-mac',
    hostname: 'peer-mac',
    dataDir: path.join(context.root, 'peer-connector'),
    localPort: 0,
    enrollToken: 'test-enroll',
    logger: silentLogger,
  });
  await connector.start();
  await connector.whenReady();
  const driver = new TestDriver();
  const channels = new Set();
  const local = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${connector.localUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${connector.store.credentials.localToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, payload: await response.json() };
  };
  context.onClose(async () => {
    for (const channel of channels) channel.stop();
    await connector.close();
  });
  return {
    connector,
    driver,
    local,
    async registerWorker({ name = 'recipient', sessionId = 'recipient-session', attach = true, ...overrides } = {}) {
      const { response, payload } = await local('/local/v1/workers/register', {
        method: 'POST',
        body: {
          name,
          runtime: 'kimi',
          mode: 'external',
          runtime_session_id: sessionId,
          cwd: context.root,
          capabilities: ['qa'],
          metadata: { description: 'QA peer', private_note: 'not public' },
          ...overrides,
        },
      });
      if (!response.ok) throw new Error(JSON.stringify(payload));
      if (!attach) return payload.worker;
      const channel = new KimiChannel({
        connectorUrl: connector.localUrl,
        token: connector.store.credentials.localToken,
        sessionId,
        runtime: 'kimi',
        driver,
        cwd: context.root,
        retryMs: 10,
        logger: silentLogger,
      });
      channel.worker.metadata = payload.worker.metadata;
      channels.add(channel);
      await channel.start();
      await waitFor(() => channel.state === 'attached');
      return waitFor(() => context.hub.store.getWorker(payload.worker.worker_id)?.push_capable
        ? context.hub.store.getWorker(payload.worker.worker_id)
        : null);
    },
  };
}

async function sender(context) {
  return context.registerWorker({
    name: 'sender',
    runtime: 'kimi',
    runtime_session_id: 'sender-session',
    capabilities: ['coding'],
    metadata: { description: 'Coding peer', private_note: 'not public' },
  });
}

test('Worker directory is live, sanitized and rejects a foreign native identity', async t => {
  const context = await createTestContext(t);
  const source = await sender(context);
  const peer = await startPeer(t, context);
  const recipient = await peer.registerWorker();
  const retired = await context.registerWorker({ name: 'retired-peer', runtime_session_id: 'retired-session', attach: false });
  await context.admin(`/api/v1/workers/${retired.worker_id}`, { method: 'DELETE' });

  const directory = await runAsCurrent(context, source, ['worker', 'directory']);
  assert.equal(directory.requester_worker_id, source.worker_id);
  assert.equal(directory.workers.some(worker => worker.worker_id === source.worker_id), false);
  assert.equal(directory.workers.some(worker => worker.worker_id === retired.worker_id), false);
  const entry = directory.workers.find(worker => worker.worker_id === recipient.worker_id);
  assert.deepEqual(Object.keys(entry).sort(), [
    'capabilities', 'connector_name', 'description', 'name', 'presence',
    'push_capable', 'runtime', 'work_state', 'worker_id',
  ]);
  assert.equal(entry.description, 'QA peer');
  assert.equal(entry.presence, 'online');
  assert.equal(entry.push_capable, true);
  assert.equal(JSON.stringify(directory).includes('not public'), false);
  assert.equal(JSON.stringify(directory).includes(recipient.runtime_session_id), false);

  const query = new URLSearchParams({ runtime: 'kimi', session_id: recipient.runtime_session_id });
  const spoofed = await context.local(`/local/v1/directory?${query}`);
  assert.equal(spoofed.response.status, 403);
});

test('A direct message crosses Connectors and returns one receipt without the Coordinator', async t => {
  const context = await createTestContext(t);
  const source = await sender(context);
  const peer = await startPeer(t, context);
  const recipient = await peer.registerWorker();
  const coordinatorCalls = [];
  const originalFinish = context.hub.coordinator.onCommandFinished;
  context.hub.coordinator.onCommandFinished = async command => {
    coordinatorCalls.push(command.command_id);
    return originalFinish.call(context.hub.coordinator, command);
  };

  const sent = await runAsCurrent(context, source, [
    'message', 'send', '--to', recipient.worker_id, '--prompt', 'Need QA evidence', '--wait',
  ]);
  const command = sent.command;
  assert.equal(command.kind, 'worker_message');
  assert.equal(command.status, 'succeeded');
  assert.equal(command.sender_worker_id, source.worker_id);
  assert.equal(command.sender_name, 'sender');
  assert.equal(command.worker_id, recipient.worker_id);
  assert.match(command.result.text, /Need QA evidence/);
  assert.match(command.result.text, /Hub-verified sender/);
  assert.match(command.result.text, /Agent Hub Worker directory/);
  assert.equal(command.task_id, null);
  assert.deepEqual(peer.driver.executions, [command.command_id]);
  assert.deepEqual(coordinatorCalls, []);

  const delivered = peer.connector.store.getCommand(command.command_id);
  assert.equal(delivered.sender_worker_id, source.worker_id);
  assert.ok(delivered.directory.some(worker => worker.worker_id === source.worker_id));
  const waited = await runAsCurrent(context, source, ['message', 'wait', command.command_id]);
  assert.equal(waited.command.command_id, command.command_id);
  assert.equal(waited.command.result.text, command.result.text);
  assert.deepEqual(peer.driver.executions, [command.command_id]);
});

test('Message APIs reject spoofing, self messages, retired recipients and generic command forgery', async t => {
  const context = await createTestContext(t);
  const source = await sender(context);
  const peer = await startPeer(t, context);
  const recipient = await peer.registerWorker({ attach: false });

  const spoofed = await context.local('/local/v1/messages', {
    method: 'POST',
    body: { ...identity(recipient), to_worker_id: source.worker_id, prompt: 'spoof' },
  });
  assert.equal(spoofed.response.status, 403);
  const self = await context.local('/local/v1/messages', {
    method: 'POST',
    body: { ...identity(source), to_worker_id: source.worker_id, prompt: 'self' },
  });
  assert.equal(self.response.status, 400);
  await context.admin(`/api/v1/workers/${recipient.worker_id}`, { method: 'DELETE' });
  const retired = await context.local('/local/v1/messages', {
    method: 'POST',
    body: { ...identity(source), to_worker_id: recipient.worker_id, prompt: 'retired' },
  });
  assert.equal(retired.response.status, 409);
  const admin = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: source.worker_id, kind: 'worker_message', input: 'forged' },
  });
  assert.equal(admin.response.status, 400);
  const local = await context.local('/local/v1/commands', {
    method: 'POST',
    body: { worker_id: source.worker_id, kind: 'worker_message', input: 'forged' },
  });
  assert.equal(local.response.status, 400);
  const legacy = await peer.registerWorker({ sessionId: 'legacy-recipient', attach: false });
  context.hub.connectorFeatures.delete(legacy.connector_id);
  const unsupported = await context.local('/local/v1/messages', {
    method: 'POST',
    body: { ...identity(source), to_worker_id: legacy.worker_id, prompt: 'do not downgrade sender identity' },
  });
  assert.equal(unsupported.response.status, 409);
  assert.match(unsupported.payload.error, /does not support Worker messages/);
  assert.equal(peer.driver.executions.length, 0);
});

test('Message wait preserves timeouts and recovers a result after sender reconnect without redelivery', async t => {
  const context = await createTestContext(t);
  const source = await sender(context);
  const peer = await startPeer(t, context);
  const manual = await peer.registerWorker({ sessionId: 'manual-recipient', attach: false });
  context.connector.commandWaitTimeoutMs = 40;

  const timedOut = await runAsCurrent(context, source, [
    'message', 'send', '--to', manual.worker_id, '--prompt', 'wait offline', '--wait',
  ]);
  assert.equal(timedOut.command.status, 'waiting_manual');
  assert.equal(timedOut.command.wait_timed_out, true);
  assert.ok(timedOut.command.command_id);
  assert.equal(context.hub.workerMessageWaiters.size, 0);
  const protectedSender = await context.admin(`/api/v1/workers/${source.worker_id}`, { method: 'DELETE' });
  assert.equal(protectedSender.response.status, 409);
  assert.equal(peer.driver.executions.length, 0);

  const recipient = await peer.registerWorker();
  const created = await context.local('/local/v1/messages', {
    method: 'POST',
    body: { ...identity(source), to_worker_id: recipient.worker_id, prompt: 'recover this reply' },
  });
  assert.equal(created.response.status, 202);
  const commandId = created.payload.command.command_id;
  await context.restartConnector();
  const recovered = await runAsCurrent(context, source, ['message', 'wait', commandId]);
  assert.equal(recovered.command.status, 'succeeded');
  assert.match(recovered.command.result.text, /recover this reply/);
  assert.deepEqual(peer.driver.executions, [commandId]);
});
