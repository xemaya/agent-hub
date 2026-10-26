import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Connector } from '../src/connector.js';
import { TestDriver } from '../src/drivers/test.js';
import { createTestContext, waitFor } from './helpers.js';

test('public health and private Admin API', async (t) => {
  const context = await createTestContext(t);
  const health = await fetch(`${context.hub.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const unauthorized = await fetch(`${context.hub.url}/api/v1/workers`);
  assert.equal(unauthorized.status, 401);
  const { response, payload } = await context.admin('/api/v1/connectors');
  assert.equal(response.status, 200);
  assert.equal(payload.connectors.length, 1);
  assert.equal(payload.connectors[0].online, true);
  assert.equal('token' in payload.connectors[0], false);
  assert.equal('token_hash' in payload.connectors[0], false);
});

test('managed Worker self-registration, task dispatch and dashboard events', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime_session_id: 'session-stable' });
  const again = await context.registerWorker({ runtime_session_id: 'session-stable' });
  assert.equal(again.worker_id, worker.worker_id);
  assert.equal((await context.admin('/api/v1/workers')).payload.workers.length, 1);
  const dashboard = await context.openDashboard();

  const created = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: {
      title: 'Verify dispatch',
      goal: 'Exercise the real push path',
      context: 'Use a deterministic Worker',
      acceptance: ['Result returns to Hub'],
      assignee_worker_id: worker.worker_id,
    },
  });
  assert.equal(created.response.status, 201);
  const task = created.payload.task;
  const dispatched = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { task_id: task.task_id, kind: 'prompt', input: 'run the task' },
  });
  assert.equal(dispatched.response.status, 202);
  const commandId = dispatched.payload.command.command_id;
  const completed = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${commandId}`);
    return payload.command.status === 'succeeded' ? payload.command : null;
  });
  assert.equal(completed.result.text, 'test-worker: run the task');
  assert.deepEqual(context.driver.executions, [commandId]);
  const stored = context.connector.store.getCommand(commandId);
  assert.equal(stored.task_snapshot.title, 'Verify dispatch');
  assert.equal(stored.task_snapshot.acceptance[0], 'Result returns to Hub');
  await waitFor(() => dashboard.messages.some((message) => (
    message.type === 'event' && message.payload.event.event_type === 'command.succeeded'
    && message.payload.event.command_id === commandId
  )));
  const currentTask = await context.admin(`/api/v1/tasks/${task.task_id}`);
  assert.equal(currentTask.payload.task.status, 'in_progress');
});

test('managed Codex self-registers and receives pushed commands', async (t) => {
  const context = await createTestContext(t);
  const executions = [];
  context.connector.drivers.codex = {
    async prepareWorker() {
      return {
        runtime_session_id: 'codex-registration',
        driver_state: { started: false, session_id: null },
      };
    },
    async execute({ command, onOutput, onState }) {
      executions.push(command.command_id);
      await onState({ started: true, session_id: 'codex-native-thread' });
      onOutput('codex-ok\n');
      return { text: 'codex-ok', session_id: 'codex-native-thread' };
    },
  };
  const worker = await context.registerWorker({ runtime: 'codex' });
  assert.equal(worker.push_capable, true);
  assert.equal(worker.runtime_session_id, 'codex-registration');
  const created = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Codex dispatch', goal: 'Verify managed Codex', assignee_worker_id: worker.worker_id },
  });
  const dispatched = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { task_id: created.payload.task.task_id, input: 'return codex-ok' },
  });
  const commandId = dispatched.payload.command.command_id;
  const completed = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/commands/${commandId}`);
    return payload.command.status === 'succeeded' ? payload.command : null;
  });
  assert.equal(completed.result.text, 'codex-ok');
  assert.equal(completed.result.session_id, 'codex-native-thread');
  assert.deepEqual(executions, [commandId]);
  assert.equal(
    context.connector.store.getWorker(worker.worker_id).driver_state.session_id,
    'codex-native-thread',
  );
});

test('external Worker remains waiting_manual instead of fake push', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({
    name: 'desktop-codex',
    runtime: 'codex',
    mode: 'external',
    runtime_session_id: 'external-session',
  });
  assert.equal(worker.push_capable, false);
  const { payload } = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'manual handoff' },
  });
  assert.equal(payload.command.status, 'waiting_manual');
  const local = await context.local('/local/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'manual local handoff', wait: true },
  });
  assert.equal(local.response.status, 200);
  assert.equal(local.payload.command.status, 'waiting_manual');
  assert.equal(local.payload.command.wait_timed_out, undefined);
  assert.equal(context.driver.executions.length, 0);
});

test('offline commands replay after Connector reconnect without duplicate execution', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime_session_id: 'offline-session' });
  await context.restartConnector();
  await context.connector.close();
  await waitFor(() => !context.hub.store.getConnector(context.connector.connectorId).online);
  const { payload } = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'queued while offline' },
  });
  const command = payload.command;
  assert.equal(command.status, 'queued');
  await context.restartConnector();
  await waitFor(async () => (
    await context.admin(`/api/v1/commands/${command.command_id}`)
  ).payload.command.status === 'succeeded');
  assert.deepEqual(context.driver.executions, [command.command_id]);
  await context.connector.receiveCommand(command);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(context.driver.executions, [command.command_id]);
});

test('commands for one Worker execute serially', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({
    runtime_session_id: 'serial-session',
    metadata: { delay_ms: 45 },
  });
  const first = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'first' },
  });
  const second = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'second' },
  });
  const ids = [first.payload.command.command_id, second.payload.command.command_id];
  await waitFor(async () => {
    const { payload } = await context.admin('/api/v1/commands');
    return ids.every((id) => payload.commands.find((command) => command.command_id === id)?.status === 'succeeded');
  });
  assert.deepEqual(context.driver.executions, ids);
  assert.equal(context.driver.maxActive, 1);
});

test('Connector restart marks interrupted execution outcome unknown', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime_session_id: 'recovery-session' });
  const command = {
    command_id: 'cmd-interrupted',
    task_id: null,
    worker_id: worker.worker_id,
    kind: 'prompt',
    input: 'interrupted',
  };
  await context.connector.store.acceptCommand(command);
  await context.connector.store.updateCommand(command.command_id, { status: 'running' });
  await context.restartConnector();
  const recovered = context.connector.store.getCommand(command.command_id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.outcome_unknown, true);
  assert.equal(recovered.error.code, 'connector_interrupted');
});

test('local Agent creates, waits for and completes a task without Admin Token', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker();
  const dashboard = await context.openDashboard();
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: {
      title: 'Agent task intake',
      goal: 'Verify the local Agent workflow',
      context: 'No Admin Token is used',
      acceptance: ['Command succeeds', 'Task can be closed'],
      assignee_worker_id: worker.worker_id,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.task.created_by, `connector:${context.connector.connectorId}`);
  const task = created.payload.task;
  const dispatched = await context.local('/local/v1/commands', {
    method: 'POST',
    body: {
      task_id: task.task_id,
      worker_id: worker.worker_id,
      input: 'finish local task',
      wait: true,
    },
  });
  assert.equal(dispatched.response.status, 200);
  const command = dispatched.payload.command;
  assert.equal(command.status, 'succeeded');
  assert.equal(command.result.text, 'test-worker: finish local task');
  assert.ok(command.finished_at);
  assert.deepEqual(context.driver.executions, [command.command_id]);
  assert.equal(context.connector.store.getCommand(command.command_id).task_snapshot.title, task.title);
  assert.equal(context.connector.commandWaiters.size, 0);
  const updated = await context.local(`/local/v1/tasks/${task.task_id}`, {
    method: 'PATCH',
    body: { status: 'done' },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.task.status, 'done');
  const currentWorker = await context.admin(`/api/v1/workers/${worker.worker_id}`);
  assert.equal(currentWorker.payload.worker.current_task_id, null);
  assert.equal(currentWorker.payload.worker.work_state, 'idle');
  await waitFor(() => [
    'task.created',
    'command.succeeded',
    'task.updated',
  ].every((eventType) => dashboard.messages.some((message) => (
    message.type === 'event' && message.payload.event.event_type === eventType
  ))));
});

test('local command wait timeout does not cancel or fake the execution result', async (t) => {
  const context = await createTestContext(t);
  context.connector.commandWaitTimeoutMs = 25;
  const worker = await context.registerWorker({ metadata: { delay_ms: 70 } });
  const dispatched = await context.local('/local/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'slow local command', wait: true },
  });
  assert.equal(dispatched.response.status, 200);
  const pending = dispatched.payload.command;
  assert.equal(pending.wait_timed_out, true);
  assert.ok(['queued', 'accepted', 'running'].includes(pending.status));
  const finished = await waitFor(async () => {
    const command = context.connector.store.getCommand(pending.command_id);
    return command.status === 'succeeded' ? command : null;
  });
  assert.equal(finished.result.text, 'test-worker: slow local command');
  assert.equal(context.connector.commandWaiters.size, 0);
});

test('Connector cannot create commands or update tasks for another Connector', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker();
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Owned task', assignee_worker_id: worker.worker_id },
  });
  const task = created.payload.task;
  const other = await Connector.create({
    hubUrl: context.hub.url,
    name: 'other-mac',
    dataDir: path.join(context.root, 'other-connector'),
    localPort: 0,
    enrollToken: 'test-enroll',
    drivers: { test: new TestDriver() },
    logger: { error() {} },
  });
  await other.start();
  await other.whenReady();
  try {
    await assert.rejects(
      other.request('task.create', { title: 'Not your task', assignee_worker_id: worker.worker_id }),
      (error) => error.statusCode === 403 && error.code === 'worker_forbidden',
    );
    await assert.rejects(
      other.request('command.create', { worker_id: worker.worker_id, input: 'must not run' }),
      (error) => error.statusCode === 403 && error.code === 'worker_forbidden',
    );
    await assert.rejects(
      other.request('task.update', { task_id: task.task_id, status: 'done' }),
      (error) => error.statusCode === 403 && error.code === 'task_forbidden',
    );
    const response = await fetch(`${other.localUrl}/local/v1/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${other.store.credentials.localToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ worker_id: worker.worker_id, input: 'must not run' }),
    });
    assert.equal(response.status, 403);
    await response.json();
    assert.deepEqual(context.driver.executions, []);
  } finally {
    await other.close();
  }
});
