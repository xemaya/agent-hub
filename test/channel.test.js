import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { ChannelServer } from '../src/channel.js';
import { KimiChannel } from '../src/kimi-channel.js';
import { startSession } from '../src/session-launcher.js';
import { createTestContext, waitFor } from './helpers.js';
import { EventEmitter } from 'node:events';

// Plays the Claude Code side of the stdio MCP connection.
function openChannel(context, sessionId) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const server = new ChannelServer({
    connectorUrl: context.connector.localUrl,
    token: context.connector.store.credentials.localToken,
    runtime: 'claude',
    sessionId,
    input,
    output,
    logger: { error() {} },
    retryMs: 50,
  });
  let nextId = 1;
  const call = async (method, params) => {
    const id = nextId++;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return waitFor(() => messages.find((message) => message.id === id));
  };
  const notifications = () => messages.filter((message) => message.method === 'notifications/claude/channel');
  const close = () => {
    server.stop();
    input.end();
  };
  return { server, messages, call, notifications, close };
}

async function workerView(context, workerId) {
  const { payload } = await context.admin('/api/v1/workers');
  return payload.workers.find((worker) => worker.worker_id === workerId);
}

test('Channel speaks MCP with the channel capability and its two tools', async (t) => {
  const context = await createTestContext(t);
  const channel = openChannel(context, 'mcp-shape');
  t.after(() => channel.close());
  await channel.server.start();
  const init = await channel.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {} });
  assert.deepEqual(init.result.capabilities.tools, {});
  assert.match(init.result.instructions, /agent_hub_report/);
  const tools = await channel.call('tools/list', {});
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['agent_hub_ack', 'agent_hub_report']);
  const unknown = await channel.call('resources/list', {});
  assert.equal(unknown.error.code, -32601);
});

test('An attached interactive Session receives Hub commands and reports results back', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ name: 'live-claude', runtime: 'claude', attach: false, runtime_session_id: 'live-1' });
  assert.equal(worker.push_capable, false);
  const queuedWhileManual = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'before attach' } });
  assert.equal(queuedWhileManual.payload.command.status, 'waiting_manual');

  const channel = openChannel(context, 'live-1');
  t.after(() => channel.close());
  await channel.server.start();
  await waitFor(() => channel.server.state === 'attached');
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === true);

  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'summarize the repo' } });
  assert.equal(created.response.status, 202);
  assert.equal(created.payload.command.status, 'queued');
  const commandId = created.payload.command.command_id;
  const [event] = await waitFor(() => channel.notifications().length && channel.notifications());
  assert.equal(event.params.meta.command_id, commandId);
  assert.match(event.params.content, /^summarize the repo\n\n\[Agent Hub\] When done, call agent_hub_report with command_id "cmd_/);

  const ack = await channel.call('tools/call', { name: 'agent_hub_ack', arguments: { command_id: commandId } });
  assert.equal(ack.result.isError, undefined);
  await waitFor(async () => (await context.admin(`/api/v1/commands/${commandId}`)).payload.command.status === 'running');
  const report = await channel.call('tools/call', {
    name: 'agent_hub_report',
    arguments: { command_id: commandId, status: 'succeeded', result: 'It is a coordination hub.' },
  });
  assert.equal(report.result.isError, undefined);
  const finished = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${commandId}`);
    return payload.command.status === 'succeeded' && payload.command;
  });
  assert.equal(finished.result.text, 'It is a coordination hub.');
  assert.equal(finished.result.delivery, 'channel');

  const again = await channel.call('tools/call', {
    name: 'agent_hub_report',
    arguments: { command_id: commandId, status: 'succeeded', result: 'twice' },
  });
  assert.equal(again.result.isError, true);
  const untouched = await context.admin(`/api/v1/commands/${queuedWhileManual.payload.command.command_id}`);
  assert.equal(untouched.payload.command.status, 'waiting_manual');
});

test('Closing the window mid-command leaves an unknown outcome and stops further pushes', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ name: 'closing', runtime: 'claude', attach: false, runtime_session_id: 'live-close' });
  const channel = openChannel(context, 'live-close');
  await channel.server.start();
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === true);
  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'long job' } });
  const commandId = created.payload.command.command_id;
  await waitFor(() => channel.notifications().length);
  channel.close();
  const failed = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${commandId}`);
    return payload.command.status === 'failed' && payload.command;
  });
  assert.equal(failed.outcome_unknown, true);
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === false);
  const later = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'after close' } });
  assert.equal(later.payload.command.status, 'waiting_manual');
});

test('A channel opened before registration attaches once the Session registers, and reattaches after Connector restart', async (t) => {
  const context = await createTestContext(t);
  const channel = openChannel(context, 'live-late');
  t.after(() => channel.close());
  await channel.server.start();
  await waitFor(() => channel.server.state === 'waiting_registration');
  const worker = await context.registerWorker({ name: 'late', runtime: 'claude', attach: false, runtime_session_id: 'live-late' });
  assert.equal(worker.push_capable, true);
  assert.equal(context.connector.store.getWorker(worker.worker_id).push_capable, true);
  await waitFor(() => channel.server.state === 'attached');
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === true);

  await context.restartConnector();
  channel.server.connectorUrl = context.connector.localUrl;
  await waitFor(() => context.connector.channels.has(worker.worker_id), { timeout: 8000 });
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === true);
});

test('Legacy managed registration is rejected instead of starting background execution', async (t) => {
  const context = await createTestContext(t);
  await assert.rejects(
    context.registerWorker({ name: 'headless', runtime: 'test', mode: 'managed', runtime_session_id: 'headless-1' }),
    /Only interactive external Workers are supported/,
  );
  assert.equal(context.hub.store.listWorkers().length, 0);
  const missingIdentity = await context.local('/local/v1/workers/register', {
    method: 'POST',
    body: { name: 'missing-session', runtime: 'kimi', mode: 'external', cwd: context.root },
  });
  assert.equal(missingIdentity.response.status, 400);
  assert.match(missingIdentity.payload.error, /runtime_session_id is required/);
});

test('Kimi Channel drives the same external Session and preserves output gaps', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ name: 'live-kimi', runtime: 'kimi', attach: false, runtime_session_id: 'live-kimi-1' });
  const executions = [];
  const driver = {
    async execute(input) {
      executions.push(input);
      await input.onState({ started: true, prompt_id: input.command.command_id });
      return { text: 'Kimi Channel result', session_id: 'live-kimi-1', output_gap: true };
    },
  };
  const channel = new KimiChannel({
    connectorUrl: context.connector.localUrl,
    token: context.connector.store.credentials.localToken,
    sessionId: 'live-kimi-1',
    driver,
    retryMs: 50,
  });
  t.after(() => channel.stop());
  channel.start();
  await waitFor(() => channel.state === 'attached');
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === true);

  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'answer in this window' } });
  const commandId = created.payload.command.command_id;
  const finished = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${commandId}`);
    return payload.command.status === 'succeeded' && payload.command;
  });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].worker.runtime_session_id, 'live-kimi-1');
  assert.deepEqual(executions[0].command, { command_id: commandId, kind: 'prompt', input: 'answer in this window' });
  assert.equal(finished.result.text, 'Kimi Channel result');
  assert.equal(finished.result.delivery, 'channel');
  assert.equal(finished.result.output_gap, true);
  assert.match(finished.output_text, /accepted by the interactive session/);

  channel.stop();
  await waitFor(async () => (await workerView(context, worker.worker_id))?.push_capable === false);
  const later = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'after close' } });
  assert.equal(later.payload.command.status, 'waiting_manual');
});

test('Kimi Channel reports occupied or failed execution without a takeover', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ name: 'busy-kimi', runtime: 'kimi', attach: false, runtime_session_id: 'live-kimi-busy' });
  const driver = {
    async execute() {
      throw Object.assign(new Error('Session is occupied by another client'), { code: 40931 });
    },
  };
  const channel = new KimiChannel({
    connectorUrl: context.connector.localUrl,
    token: context.connector.store.credentials.localToken,
    sessionId: 'live-kimi-busy',
    driver,
    retryMs: 50,
  });
  t.after(() => channel.stop());
  channel.start();
  await waitFor(() => channel.state === 'attached');
  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'do not steal this session' } });
  const commandId = created.payload.command.command_id;
  const failed = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${commandId}`);
    return payload.command.status === 'failed' && payload.command;
  });
  assert.equal(failed.outcome_unknown, false);
  assert.equal(failed.error.code, 'reported_failure');
  assert.match(failed.error.message, /occupied/);
});

test('Claude push launcher wires the channel config, tool allowance and native identity', async (t) => {
  const context = await createTestContext(t);
  const calls = [];
  const fakeChild = () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };
  const result = await startSession({
    runtime: 'claude',
    cwd: process.cwd(),
    runtimeArgs: ['hello'],
    push: true,
    resumeSessionId: 'resume-me',
    dataDir: path.join(context.root, 'connector'),
    nodePath: '/opt/node',
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return fakeChild();
    },
  });
  assert.equal(result.sessionId, 'resume-me');
  const args = calls[0].args;
  assert.deepEqual(args.slice(-3), ['--resume', 'resume-me', 'hello']);
  assert.equal(args[args.indexOf('--dangerously-load-development-channels') + 1], 'server:agent-hub');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__agent-hub__agent_hub_ack,mcp__agent-hub__agent_hub_report');
  const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  assert.equal(config.mcpServers['agent-hub'].command, '/opt/node');
  assert.deepEqual(config.mcpServers['agent-hub'].env, { AGENT_HUB_RUNTIME: 'claude', AGENT_HUB_SESSION_ID: 'resume-me' });
  assert.equal(calls[0].options.env.AGENT_HUB_SESSION_ID, 'resume-me');
  await assert.rejects(startSession({ runtime: 'codex', push: true, spawn: fakeChild }), /only supported for claude or kimi/);
});
