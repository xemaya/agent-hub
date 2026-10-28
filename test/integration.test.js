import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Connector } from '../src/connector.js';
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

test('interactive Worker self-registration, task dispatch and dashboard events', async (t) => {
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
  assert.match(completed.result.text, /^test-worker: Agent Hub task context/);
  assert.match(completed.result.text, /Agent Hub command \(prompt\):\nrun the task$/);
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

test('interactive Codex self-registers and receives commands through its Channel', async (t) => {
  const context = await createTestContext(t);
  const executions = [];
  const driver = {
    async execute({ command, onOutput, onState }) {
      executions.push(command.command_id);
      await onState({ started: true });
      onOutput('codex-ok\n');
      return { text: 'codex-ok', session_id: 'codex-registration' };
    },
  };
  const worker = await context.registerWorker({ runtime: 'codex', runtime_session_id: 'codex-registration', driver });
  assert.equal(worker.push_capable, true);
  assert.equal(worker.mode, 'external');
  assert.equal(worker.runtime_session_id, 'codex-registration');
  const created = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Codex dispatch', goal: 'Verify interactive Codex', assignee_worker_id: worker.worker_id },
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
  assert.equal(completed.result.session_id, 'codex-registration');
  assert.equal(completed.result.delivery, 'channel');
  assert.deepEqual(executions, [commandId]);
});

test('external Worker remains waiting_manual instead of fake push', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({
    name: 'desktop-codex',
    runtime: 'codex',
    attach: false,
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

test('accepted interactive commands replay after Connector reconnect without duplicate execution', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime_session_id: 'offline-session' });
  const command = context.hub.store.createCommand({
    worker_id: worker.worker_id,
    kind: 'prompt',
    input: 'accepted before offline',
    push_capable: true,
  });
  await context.connector.store.acceptCommand(command);
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
  assert.match(command.result.text, /^test-worker: Agent Hub task context/);
  assert.match(command.result.text, /Agent Hub command \(prompt\):\nfinish local task$/);
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

test('Worker activity prioritizes the running command over a newer queued command', async (t) => {
  const context = await createTestContext(t);
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  context.driver = {
    async execute({ command, onState }) {
      await onState({ started: true });
      if (command.input === 'first') {
        announceFirst();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return { text: command.input };
    },
    async close() {},
  };
  const worker = await context.registerWorker();
  const first = await context.admin('/api/v1/commands', {
    method: 'POST', body: { worker_id: worker.worker_id, input: 'first' },
  });
  await firstStarted;
  const second = await context.admin('/api/v1/commands', {
    method: 'POST', body: { worker_id: worker.worker_id, input: 'second' },
  });
  await waitFor(() => ['accepted', 'queued'].includes(context.hub.store.getCommand(second.payload.command.command_id)?.status));
  const live = await context.admin(`/api/v1/workers/${worker.worker_id}`);
  assert.equal(live.payload.worker.activity.command_id, first.payload.command.command_id);
  assert.equal(live.payload.worker.activity.command_status, 'running');
  assert.equal(live.payload.worker.activity.phase, 'working');
  assert.match(live.payload.worker.activity.output_text, /delivered to the interactive session/);
  releaseFirst();
  await waitFor(() => context.hub.store.getCommand(second.payload.command.command_id)?.status === 'succeeded');
});

test('Worker activity shows interactive delivery and clears to a recent result when finished', async (t) => {
  const context = await createTestContext(t);
  let releaseWork;
  let announceOutput;
  const outputStarted = new Promise((resolve) => { announceOutput = resolve; });
  context.driver = {
    async execute() {
      announceOutput();
      await new Promise((resolve) => { releaseWork = resolve; });
      return { text: '实际结果 AGENT_HUB_ACTIVITY_OK' };
    },
    async close() {},
  };
  const worker = await context.registerWorker({ name: 'activity-worker' });
  const dashboard = await context.openDashboard();
  const created = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: { title: '可见的员工工作', goal: '显示当前进度', assignee_worker_id: worker.worker_id },
  });
  const dispatched = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { task_id: created.payload.task.task_id, input: '显示真实输出' },
  });
  await outputStarted;
  const working = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/workers/${worker.worker_id}`);
    return payload.worker.activity.phase === 'working' && payload.worker.activity.output_text
      ? payload.worker
      : null;
  });
  assert.equal(working.activity.task_id, created.payload.task.task_id);
  assert.equal(working.activity.task_title, '可见的员工工作');
  assert.equal(working.activity.command_status, 'running');
  assert.match(working.activity.output_text, /delivered to the interactive session/);
  await waitFor(() => dashboard.messages.some((message) => (
    message.type === 'worker.updated'
    && message.payload.worker.activity?.output_text.includes('delivered to the interactive session')
  )));
  releaseWork();
  await waitFor(async () => (
    await context.admin(`/api/v1/commands/${dispatched.payload.command.command_id}`)
  ).payload.command.status === 'succeeded');
  const idle = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/workers/${worker.worker_id}`);
    return payload.worker.activity.phase === 'idle' ? payload.worker : null;
  });
  assert.equal(idle.activity.task_id, null);
  assert.equal(idle.activity.output_text, '');
  assert.equal(idle.activity.recent_result, '实际结果 AGENT_HUB_ACTIVITY_OK');
  assert.ok(idle.activity.updated_at);
});

test('Another Connector cannot read Admin chat through local or WebSocket APIs', async (t) => {
  const context = await createTestContext(t);
  const other = await Connector.create({
    hubUrl: context.hub.url,
    name: 'other-mac',
    dataDir: path.join(context.root, 'other-connector'),
    localPort: 0,
    enrollToken: 'test-enroll',
    logger: { error() {} },
  });
  await other.start();
  await other.whenReady();
  try {
    const local = await fetch(`${other.localUrl}/local/v1/coordinator/chat`, {
      headers: { authorization: `Bearer ${other.store.credentials.localToken}` },
    });
    assert.equal(local.status, 404);
    await assert.rejects(
      other.request('coordinator.chat', {}),
      (error) => /Unsupported connector message/.test(error.message),
    );
    const direct = await fetch(`${context.hub.url}/api/v1/coordinator/chat`, {
      headers: { authorization: `Bearer ${other.store.credentials.localToken}` },
    });
    assert.equal(direct.status, 401);
  } finally {
    await other.close();
  }
});
