import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createTestContext, waitFor } from './helpers.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = async (ctx, worker, input = 'recovery probe', taskId) => (await ctx.admin('/api/v1/commands', {
  method: 'POST', body: { worker_id: worker.worker_id, input, ...(taskId ? { task_id: taskId } : {}) },
})).payload.command;

test('Replacing a Channel fails its old delivery once and allows subsequent work', async t => {
  const ctx = await createTestContext(t);
  const worker = await ctx.registerWorker({ attach: false });
  const aborts = [];
  t.after(() => aborts.forEach(controller => controller.abort()));
  const attach = async () => {
    const controller = new AbortController(); aborts.push(controller);
    await fetch(`${ctx.connector.localUrl}/local/v1/channel?runtime=${worker.runtime}&session_id=${worker.runtime_session_id}`, {
      headers: { authorization: `Bearer ${ctx.connector.store.credentials.localToken}` }, signal: controller.signal,
    });
  };
  await attach();
  await waitFor(() => ctx.hub.store.getWorker(worker.worker_id).push_capable);
  const first = await send(ctx, worker);
  const old = ctx.connector.channels.get(worker.worker_id);
  await waitFor(() => old.deliveries.has(first.command_id));
  await attach();
  const failed = await waitFor(() => {
    const command = ctx.hub.store.getCommand(first.command_id);
    return command.status === 'failed' && command;
  });
  assert.equal(failed.outcome_unknown, true);
  assert.equal(old.deliveries.size, 0);
  assert.equal(ctx.hub.store.getWorker(worker.worker_id).push_capable, true);
  const next = await send(ctx, worker);
  await waitFor(() => ctx.connector.channels.get(worker.worker_id).deliveries.has(next.command_id));
  await ctx.local(`/local/v1/channel/commands/${next.command_id}/report`, { method: 'POST', body: { status: 'succeeded', result: 'next completed' } });
  await waitFor(() => ctx.hub.store.getCommand(next.command_id).status === 'succeeded');
  assert.equal(ctx.hub.store.listEvents().filter(event => event.command_id === first.command_id && event.event_type === 'command.failed').length, 1);
});

test('Reconnection adopts a cancellation made offline and rejects a late receipt', async t => {
  const ctx = await createTestContext(t);
  const worker = await ctx.registerWorker({ driver: { execute: async () => new Promise(() => {}) } });
  const command = await send(ctx, worker);
  await waitFor(() => ctx.hub.store.getCommand(command.command_id).status === 'running');
  ctx.connector.detachSocket('simulated transport loss');
  clearTimeout(ctx.connector.reconnectTimer); ctx.connector.reconnectTimer = null;
  await waitFor(() => !ctx.hub.store.getConnector(worker.connector_id).online);
  await ctx.admin(`/api/v1/commands/${command.command_id}/cancel`, { method: 'POST', body: {} });
  ctx.connector.connect();
  await waitFor(() => ctx.connector.store.getCommand(command.command_id).status === 'failed');
  await waitFor(() => !ctx.connector.activeWorkers.has(worker.worker_id));
  assert.equal(ctx.connector.store.getCommand(command.command_id).error.code, 'admin_cancelled');
  const late = await ctx.local(`/local/v1/channel/commands/${command.command_id}/report`, { method: 'POST', body: { status: 'succeeded', result: 'late' } });
  assert.equal(late.response.status, 404);
});

test('Accepted work is reconciled before a reconnect can schedule it', async t => {
  const ctx = await createTestContext(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const executions = [];
  const worker = await ctx.registerWorker({ driver: { execute: async ({ command }) => { executions.push(command.command_id); await gate; return { text: 'done' }; } } });
  const first = await send(ctx, worker);
  await waitFor(() => ctx.hub.store.getCommand(first.command_id).status === 'running');
  const second = await send(ctx, worker);
  await waitFor(() => ctx.hub.store.getCommand(second.command_id).status === 'accepted');
  ctx.connector.detachSocket('offline cancellation');
  clearTimeout(ctx.connector.reconnectTimer); ctx.connector.reconnectTimer = null;
  await waitFor(() => !ctx.hub.store.getConnector(worker.connector_id).online);
  await ctx.admin(`/api/v1/commands/${second.command_id}/cancel`, { method: 'POST', body: {} });
  assert.equal(ctx.hub.store.getWorker(worker.worker_id).work_state, 'working');
  ctx.connector.connect();
  await waitFor(() => ctx.connector.store.getCommand(second.command_id).status === 'failed');
  release();
  await waitFor(() => ctx.hub.store.getCommand(first.command_id).status === 'succeeded');
  await pause(40);
  assert.deepEqual(executions, [first.command_id]);
});

test('Late and duplicate events cannot mutate final tasks, Worker state or audit history', async t => {
  const ctx = await createTestContext(t);
  const worker = await ctx.registerWorker({ attach: false });
  const task = (await ctx.admin('/api/v1/tasks', { method: 'POST', body: { title: 'cancelled task' } })).payload.task;
  const command = await send(ctx, worker, 'cancel then delayed events', task.task_id);
  await ctx.admin(`/api/v1/commands/${command.command_id}/cancel`, { method: 'POST', body: {} });
  ctx.hub.store.deleteTask(task.task_id);
  const before = ctx.hub.store.getCommand(command.command_id);
  const count = ctx.hub.store.listEvents().filter(event => event.command_id === command.command_id).length;
  const socket = { readyState: 1, send() {} };
  for (const type of ['command.ack', 'command.started', 'command.output', 'command.finished', 'command.sync']) {
    await ctx.hub.handleConnectorMessage(socket, worker.connector_id, { type, payload: { command_id: command.command_id, status: 'succeeded', chunk: 'late output', result: { text: 'late result' } } });
  }
  assert.deepEqual(ctx.hub.store.getCommand(command.command_id), before);
  assert.equal(ctx.hub.store.getTask(task.task_id).status, 'blocked');
  assert.equal(ctx.hub.store.getWorker(worker.worker_id).work_state, 'idle');
  assert.equal(ctx.hub.store.listEvents().filter(event => event.command_id === command.command_id).length, count);
});

test('Hub cancellation wins over an offline local success during final-state synchronization', async t => {
  const ctx = await createTestContext(t);
  const worker = await ctx.registerWorker({ driver: { execute: async () => new Promise(() => {}) } });
  const command = await send(ctx, worker);
  await waitFor(() => ctx.hub.store.getCommand(command.command_id).status === 'running');
  ctx.connector.detachSocket('completion acknowledgement lost');
  clearTimeout(ctx.connector.reconnectTimer); ctx.connector.reconnectTimer = null;
  await waitFor(() => !ctx.hub.store.getConnector(worker.connector_id).online);
  await ctx.admin(`/api/v1/commands/${command.command_id}/cancel`, { method: 'POST', body: {} });
  await ctx.connector.store.updateCommand(command.command_id, { status: 'succeeded', result: { text: 'local completion before reconnect' } });
  ctx.connector.connect();
  await waitFor(() => ctx.connector.store.getCommand(command.command_id).status === 'failed');
  assert.equal(ctx.connector.store.getCommand(command.command_id).outcome_unknown, true);
  assert.equal(ctx.connector.store.getCommand(command.command_id).error.code, 'admin_cancelled');
  assert.equal(ctx.hub.store.listEvents().filter(event => event.command_id === command.command_id && event.event_type === 'command.succeeded').length, 0);
});

function waitingOrchestration(ctx, worker, coordinator, title) {
  const { orchestration } = ctx.hub.store.createOrchestratedTask({ title, goal: title, acceptance: ['done'], createdBy: 'test', coordinatorWorkerId: coordinator.worker_id });
  const child = ctx.hub.store.createTask({ title: `${title} child` });
  return ctx.hub.store.updateOrchestration(orchestration.orchestration_id, { status: 'in_progress', steps: [{ key: 'one', title, goal: title, context: '', acceptance: ['done'], task_id: child.task_id, worker_id: worker.worker_id, depends_on: [], status: 'ready', command_id: null, result: null, error: null }] });
}

test('A freed Worker wakes a different orchestration waiting on it', async t => {
  const ctx = await createTestContext(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = await ctx.registerWorker({ driver: { execute: async () => { await gate; return { text: 'completed' }; } } });
  const coordinator = await ctx.registerWorker({ attach: false });
  const first = waitingOrchestration(ctx, worker, coordinator, 'first');
  const second = waitingOrchestration(ctx, worker, coordinator, 'second');
  ctx.hub.coordinator.pump(first);
  await waitFor(() => ctx.hub.store.listCommands({ taskId: first.steps[0].task_id }).some(command => command.status === 'running'));
  ctx.hub.coordinator.pump(second);
  assert.equal(ctx.hub.store.listCommands({ taskId: second.steps[0].task_id }).length, 0);
  release();
  await waitFor(() => ctx.hub.store.listCommands({ taskId: second.steps[0].task_id }).some(command => command.status === 'succeeded'));
  assert.equal(ctx.hub.store.listCommands({ taskId: second.steps[0].task_id }).length, 1);
});

test('Channel reattachment wakes a ready step without retrying a blocked orchestration', async t => {
  const ctx = await createTestContext(t);
  const worker = await ctx.registerWorker({ attach: false });
  const coordinator = await ctx.registerWorker({ attach: false });
  const waiting = waitingOrchestration(ctx, worker, coordinator, 'waiting');
  const blocked = waitingOrchestration(ctx, worker, coordinator, 'blocked');
  ctx.hub.store.updateOrchestration(blocked.orchestration_id, { status: 'blocked' });
  ctx.hub.coordinator.pump(waiting);
  assert.equal(ctx.driver.executions.length, 0);
  await ctx.attachWorker(worker);
  await waitFor(() => ctx.hub.store.listCommands({ taskId: waiting.steps[0].task_id }).some(command => command.status === 'succeeded'));
  assert.equal(ctx.hub.store.listCommands({ taskId: blocked.steps[0].task_id }).length, 0);
});

test('Final-state synchronization repairs stale Worker state without replaying a result', async t => {
  const ctx = await createTestContext(t);
  const worker = await ctx.registerWorker();
  const command = await send(ctx, worker);
  await waitFor(() => ctx.hub.store.getCommand(command.command_id).status === 'succeeded');
  ctx.hub.store.updateWorkerStatus(worker.connector_id, worker.worker_id, { work_state: 'working' });
  const events = ctx.hub.store.listEvents().filter(event => event.command_id === command.command_id).length;
  ctx.connector.send('command.sync', { command_id: command.command_id, status: 'succeeded', result: ctx.connector.store.getCommand(command.command_id).result });
  await waitFor(() => ctx.hub.store.getWorker(worker.worker_id).work_state === 'idle');
  assert.equal(ctx.hub.store.listEvents().filter(event => event.command_id === command.command_id).length, events);
});

test('Hub shutdown is bounded even when a client leaves HTTP headers incomplete', async t => {
  const ctx = await createTestContext(t, { hub: { shutdownGraceMs: 30 } });
  const socket = connect({ host: '127.0.0.1', port: ctx.hub.port });
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
  // Simulate a WebSocket peer that never completes its close handshake too.
  for (const peer of ctx.hub.wss.clients) peer.close = () => {};
  await pause(15);
  const started = Date.now();
  await ctx.hub.close();
  assert.ok(Date.now() - started < 1000);
  await ctx.hub.close();
});
