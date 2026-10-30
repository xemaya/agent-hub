import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { createTestContext, TestDriver, waitFor } from './helpers.js';

const silentLogger = { error() {} };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function pendingDriver() {
  const driver = new TestDriver();
  driver.execute = async ({ command, onState }) => {
    driver.executions.push(command.command_id);
    await onState({ started: true });
    return new Promise(() => {});
  };
  return driver;
}

async function createPendingPlanning(context) {
  const driver = pendingDriver();
  const coordinator = await context.registerWorker({
    name: 'stuck-coordinator',
    runtime: 'kimi',
    runtime_session_id: `stuck-${Date.now()}-${Math.random()}`,
    driver,
  });
  context.hub.coordinator.configure({ workerId: coordinator.worker_id });
  await context.registerWorker({
    name: 'eligible-worker',
    runtime_session_id: `eligible-${Date.now()}-${Math.random()}`,
  });
  const { orchestration } = context.hub.coordinator.createOrchestration({
    title: 'Stuck planning',
    goal: 'Verify cancellation',
    context: '',
    acceptance: ['No retry after cancellation'],
    createdBy: 'admin',
    actor: { type: 'admin', id: 'admin' },
  });
  const command = await waitFor(() => {
    const current = context.hub.store.listCommands({ taskId: orchestration.parent_task_id })
      .find(item => item.kind === 'coordinator_plan');
    return current?.status === 'running' ? current : null;
  });
  return { driver, orchestration, command };
}

async function waitForDeliveryRemoval(context, commandId) {
  await waitFor(() => [...context.connector.channels.values()]
    .every(channel => !channel.deliveries.has(commandId)));
}

test('Admin cancellation blocks a running plan without retry and rejects a late receipt', async t => {
  const context = await createTestContext(t);
  const { driver, orchestration, command } = await createPendingPlanning(context);
  const cancelled = await context.admin(`/api/v1/commands/${command.command_id}/cancel`, {
    method: 'POST',
    body: { reason: 'Stopped by the administrator' },
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.payload.command.status, 'failed');
  assert.equal(cancelled.payload.command.error.code, 'admin_cancelled');
  assert.equal(cancelled.payload.command.outcome_unknown, true);
  const blocked = await waitFor(() => {
    const current = context.hub.store.getOrchestration(orchestration.orchestration_id);
    return current.status === 'blocked' ? current : null;
  });
  assert.equal(blocked.error.code, 'coordinator_plan_failed');
  assert.equal(context.hub.store.getTask(orchestration.parent_task_id).status, 'blocked');
  await waitForDeliveryRemoval(context, command.command_id);
  const late = await context.local(`/local/v1/channel/commands/${command.command_id}/report`, {
    method: 'POST',
    body: { status: 'succeeded', result: '{"steps":[]}' },
  });
  assert.equal(late.response.status, 404);
  await context.hub.coordinator.resume();
  assert.equal(context.hub.store.listCommands({ taskId: orchestration.parent_task_id }).length, 1);
  assert.deepEqual(driver.executions, [command.command_id]);
  assert.equal((await context.admin(`/api/v1/commands/${command.command_id}/cancel`, { method: 'POST', body: {} })).response.status, 409);
  assert.equal((await context.admin('/api/v1/commands/cmd_missing/cancel', { method: 'POST', body: {} })).response.status, 404);
});

test('Cancelling a queued command prevents execution while the prior command completes', async t => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ name: 'queued-worker', runtime_session_id: 'queued-worker' });
  const gate = deferred();
  const originalExecute = context.driver.execute.bind(context.driver);
  context.driver.execute = async args => {
    if (args.command.input.startsWith('hold')) {
      context.driver.executions.push(args.command.command_id);
      await args.onState({ started: true });
      await gate.promise;
      return { text: 'released', session_id: worker.runtime_session_id };
    }
    return originalExecute(args);
  };
  const first = await context.admin('/api/v1/commands', {
    method: 'POST', body: { worker_id: worker.worker_id, input: 'hold the worker' },
  });
  await waitFor(() => context.hub.store.getCommand(first.payload.command.command_id)?.status === 'running');
  const second = await context.admin('/api/v1/commands', {
    method: 'POST', body: { worker_id: worker.worker_id, input: 'must not execute' },
  });
  const secondId = second.payload.command.command_id;
  const cancelled = await context.admin(`/api/v1/commands/${secondId}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.response.status, 200);
  await waitFor(() => context.connector.store.getCommand(secondId)?.status === 'failed');
  gate.resolve();
  await waitFor(() => context.hub.store.getCommand(first.payload.command.command_id)?.status === 'succeeded');
  assert.deepEqual(context.driver.executions, [first.payload.command.command_id]);
  assert.equal(context.hub.store.getCommand(secondId).status, 'failed');
});

test('Cancelling a direct message wakes the sender and rejects the recipient late report', async t => {
  const context = await createTestContext(t);
  const source = await context.registerWorker({ name: 'message-source', runtime: 'kimi', runtime_session_id: 'message-source' });
  const driver = pendingDriver();
  const recipient = await context.registerWorker({ name: 'message-target', runtime: 'kimi', runtime_session_id: 'message-target', driver });
  const waiting = context.local('/local/v1/messages', {
    method: 'POST',
    body: {
      runtime: source.runtime,
      runtime_session_id: source.runtime_session_id,
      to_worker_id: recipient.worker_id,
      prompt: 'wait for cancellation',
      wait: true,
    },
  });
  const command = await waitFor(() => {
    const current = context.hub.store.listCommands({ workerId: recipient.worker_id })
      .find(item => item.kind === 'worker_message');
    return current?.status === 'running' ? current : null;
  });
  const cancelled = await context.admin(`/api/v1/commands/${command.command_id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.response.status, 200);
  const result = await waiting;
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.command.status, 'failed');
  assert.equal(result.payload.command.outcome_unknown, true);
  await waitForDeliveryRemoval(context, command.command_id);
  const late = await context.local(`/local/v1/channel/commands/${command.command_id}/report`, {
    method: 'POST', body: { status: 'succeeded', result: 'late reply' },
  });
  assert.equal(late.response.status, 404);
});

test('Coordinator inactivity timeout blocks planning once without automatic retry', async t => {
  const context = await createTestContext(t, {
    hub: { coordinatorInactivityTimeoutMs: 40, commandInactivityTimeoutMs: 1000, watchdogIntervalMs: 10 },
  });
  const { driver, orchestration, command } = await createPendingPlanning(context);
  const failed = await waitFor(() => {
    const current = context.hub.store.getCommand(command.command_id);
    return current.status === 'failed' ? current : null;
  });
  assert.equal(failed.error.code, 'inactivity_timeout');
  assert.equal(failed.outcome_unknown, true);
  assert.equal(context.hub.store.getOrchestration(orchestration.orchestration_id).status, 'blocked');
  assert.equal(context.hub.store.getTask(orchestration.parent_task_id).status, 'blocked');
  await context.hub.coordinator.resume();
  assert.equal(context.hub.store.listCommands({ taskId: orchestration.parent_task_id }).length, 1);
  assert.deepEqual(driver.executions, [command.command_id]);
});

test('Output renews activity and the watchdog uses the persisted deadline after restart', async t => {
  await mkdir(path.resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-tmp', 'watchdog-'));
  const credentials = { adminToken: 'test-admin', enrollmentToken: 'test-enroll', generated: [], file: path.join(root, 'credentials.json') };
  const options = {
    host: '127.0.0.1', port: 0, dataDir: root, credentials, logger: silentLogger,
    commandInactivityTimeoutMs: 60, watchdogIntervalMs: 10,
  };
  let hub = await Hub.create(options);
  t.after(async () => {
    if (hub) await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  await hub.listen();
  const connector = hub.store.createConnector({ name: 'watchdog-mac', tokenHash: 'watchdog-hash' });
  const worker = hub.store.registerWorker(connector.connector_id, {
    name: 'watchdog-worker', runtime: 'kimi', runtime_session_id: 'watchdog-session',
    capabilities: [], cwd: root, metadata: {},
  });
  const created = hub.store.createCommand({ worker_id: worker.worker_id, input: 'long work', push_capable: true });
  hub.store.acceptCommand(created.command_id, connector.connector_id);
  hub.store.startCommand(created.command_id, connector.connector_id);
  const recent = new Date(Date.now() - 40).toISOString();
  hub.store.db.prepare('UPDATE commands SET last_activity_at = ? WHERE command_id = ?').run(recent, created.command_id);
  await hub.expireInactiveCommands();
  assert.equal(hub.store.getCommand(created.command_id).status, 'running');
  const active = hub.store.appendCommandOutput(created.command_id, connector.connector_id, 'progress');
  assert.ok(Date.parse(active.last_activity_at) > Date.parse(recent));
  await hub.close();
  hub = null;
  await sleep(80);

  hub = await Hub.create(options);
  await hub.listen();
  const failed = await waitFor(() => {
    const current = hub.store.getCommand(created.command_id);
    return current.status === 'failed' ? current : null;
  });
  assert.equal(failed.error.code, 'inactivity_timeout');
  assert.equal(failed.outcome_unknown, true);
  const late = hub.store.finishCommand(created.command_id, connector.connector_id, {
    status: 'succeeded', result: { text: 'late success' },
  });
  assert.equal(late.status, 'failed');
  assert.equal(late.error.code, 'inactivity_timeout');
});
