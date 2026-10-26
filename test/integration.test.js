import test from 'node:test';
import assert from 'node:assert/strict';
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
