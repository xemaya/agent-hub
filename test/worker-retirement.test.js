import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';
import { createTestContext, waitFor } from './helpers.js';

test('Admin retirement hides Workers, rejects new work and restores the same identity', async (t) => {
  const context = await createTestContext(t);
  const dashboard = await context.openDashboard();
  const coordinator = await context.registerWorker({ name: 'coordinator-active', runtime_session_id: 'coordinator-active' });
  const worker = await context.registerWorker({ name: 'retire-me', runtime_session_id: 'retire-native' });
  context.hub.coordinator.configure({ workerId: coordinator.worker_id });
  const taskResponse = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'History remains', goal: 'Keep this record', acceptance: ['History remains'], assignee_worker_id: worker.worker_id },
  });
  assert.equal(taskResponse.response.status, 201);
  const retired = await context.admin(`/api/v1/workers/${worker.worker_id}`, { method: 'DELETE' });
  assert.equal(retired.response.status, 200);
  assert.ok(retired.payload.worker.retired_at);
  assert.equal(retired.payload.worker.worker_id, worker.worker_id);
  const active = await context.admin('/api/v1/workers');
  assert.equal(active.payload.workers.some((item) => item.worker_id === worker.worker_id), false);
  const audit = await context.admin('/api/v1/workers?include_retired=true');
  assert.equal(audit.payload.workers.find((item) => item.worker_id === worker.worker_id).retired_at, retired.payload.worker.retired_at);
  await waitFor(() => context.connector.store.getWorker(worker.worker_id)?.retired_at);
  assert.equal(context.connector.store.listWorkers().some((item) => item.worker_id === worker.worker_id), false);
  await waitFor(() => dashboard.messages.some((message) => message.type === 'worker.unregistered' && message.payload.worker.worker_id === worker.worker_id));

  const command = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'must not run' },
  });
  assert.equal(command.response.status, 409);
  const mentioned = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: { message: '@retire-me hello', mentions: [{ type: 'worker', id: worker.worker_id }] },
  });
  assert.equal(mentioned.response.status, 409);
  const repeated = await context.admin(`/api/v1/workers/${worker.worker_id}`, { method: 'DELETE' });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.worker.retired_at, retired.payload.worker.retired_at);

  const restored = await context.registerWorker({ name: 'retire-me-restored', runtime_session_id: 'retire-native' });
  assert.equal(restored.worker_id, worker.worker_id);
  assert.equal(restored.retired_at, null);
  assert.equal(restored.name, 'retire-me-restored');
  await waitFor(() => context.connector.store.listWorkers().some((item) => item.worker_id === worker.worker_id && !item.retired_at));
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks[0].task_id, taskResponse.payload.task.task_id);
  await context.restartConnector();
  assert.equal((await context.admin('/api/v1/workers')).payload.workers.some((item) => item.worker_id === worker.worker_id && !item.retired_at), true);
});

test('Codex native Session can unregister itself idempotently and explicitly rejoin', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({
    name: 'codex-self', runtime: 'codex', mode: 'external', runtime_session_id: 'codex-self-native',
  });
  const originalLog = console.log;
  const originalRuntime = process.env.AGENT_HUB_RUNTIME;
  const originalSessionId = process.env.AGENT_HUB_SESSION_ID;
  const originalCodexId = process.env.CODEX_SESSION_ID;
  const output = [];
  console.log = (value) => output.push(JSON.parse(value));
  delete process.env.AGENT_HUB_RUNTIME;
  delete process.env.AGENT_HUB_SESSION_ID;
  process.env.CODEX_SESSION_ID = 'codex-self-native';
  t.after(() => {
    console.log = originalLog;
    if (originalRuntime === undefined) delete process.env.AGENT_HUB_RUNTIME;
    else process.env.AGENT_HUB_RUNTIME = originalRuntime;
    if (originalSessionId === undefined) delete process.env.AGENT_HUB_SESSION_ID;
    else process.env.AGENT_HUB_SESSION_ID = originalSessionId;
    if (originalCodexId === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = originalCodexId;
  });
  const options = ['--connector-url', context.connector.localUrl, '--data-dir', context.connector.store.dataDir];
  await run(['worker', 'unregister-current', ...options]);
  const retiredAt = output[0].worker.retired_at;
  assert.ok(retiredAt);
  await run(['worker', 'unregister-current', ...options]);
  assert.equal(output[1].worker.retired_at, retiredAt);
  assert.equal(context.hub.store.getWorker(worker.worker_id).retired_at, retiredAt);
  assert.equal(context.connector.store.listWorkers().some((item) => item.worker_id === worker.worker_id), false);

  process.env.CODEX_SESSION_ID = 'different-native-session';
  await assert.rejects(run(['worker', 'unregister-current', ...options]), /Worker not found/);
  assert.equal(context.hub.store.getWorker(worker.worker_id).retired_at, retiredAt);

  process.env.CODEX_SESSION_ID = 'codex-self-native';
  await run(['worker', 'register-current', '--name', 'codex-self-restored', '--cwd', context.root, ...options]);
  assert.equal(output[2].worker.worker_id, worker.worker_id);
  assert.equal(output[2].worker.retired_at, null);
  assert.equal(output[2].worker.metadata.session_origin, 'codex-native-runtime');
  assert.equal(context.hub.store.getWorker(worker.worker_id).retired_at, null);
});

test('Retirement protects active work and the Coordinator while preserving command history', async (t) => {
  const context = await createTestContext(t);
  const coordinator = await context.registerWorker({ name: 'coordinator-protected', runtime_session_id: 'coordinator-protected' });
  const worker = await context.registerWorker({ name: 'active-worker', runtime_session_id: 'active-worker' });
  const external = await context.registerWorker({ name: 'manual-worker', runtime: 'codex', mode: 'external', runtime_session_id: 'manual-worker' });
  context.hub.coordinator.configure({ workerId: coordinator.worker_id });
  const coordinatorRejected = await context.admin(`/api/v1/workers/${coordinator.worker_id}`, { method: 'DELETE' });
  assert.equal(coordinatorRejected.response.status, 409);
  assert.equal(context.hub.store.getWorker(coordinator.worker_id).retired_at, null);

  const manual = context.hub.store.createCommand({ worker_id: external.worker_id, kind: 'prompt', input: 'manual history', push_capable: false });
  const manualRejected = await context.admin(`/api/v1/workers/${external.worker_id}`, { method: 'DELETE' });
  assert.equal(manualRejected.response.status, 409);
  context.hub.store.finishCommand(manual.command_id, context.connector.connectorId, {
    status: 'succeeded', result: { text: 'manual result' },
  });
  const manualRetired = await context.admin(`/api/v1/workers/${external.worker_id}`, { method: 'DELETE' });
  assert.equal(manualRetired.response.status, 200);
  assert.equal(context.hub.store.getCommand(manual.command_id).result.text, 'manual result');

  const queued = context.hub.store.createCommand({ worker_id: worker.worker_id, kind: 'prompt', input: 'queued work', push_capable: true });
  const workerRejected = await context.admin(`/api/v1/workers/${worker.worker_id}`, { method: 'DELETE' });
  assert.equal(workerRejected.response.status, 409);
  context.hub.store.finishCommand(queued.command_id, context.connector.connectorId, {
    status: 'succeeded', result: { text: 'finished' },
  });

  const { orchestration } = context.hub.store.createOrchestratedTask({
    title: 'Ready plan', goal: 'Do not strand a plan', context: '', acceptance: ['No stranded plan'],
    createdBy: 'test', coordinatorWorkerId: coordinator.worker_id, autoStart: false,
  });
  context.hub.store.updateOrchestration(orchestration.orchestration_id, {
    status: 'ready',
    steps: [{ key: 'assigned', worker_id: worker.worker_id, status: 'ready', task_id: null, command_id: null, result: null, error: null }],
  });
  const planRejected = await context.admin(`/api/v1/workers/${worker.worker_id}`, { method: 'DELETE' });
  assert.equal(planRejected.response.status, 409);
  context.hub.store.updateOrchestration(orchestration.orchestration_id, {
    status: 'blocked',
    error: { code: 'test_complete', message: 'No further work is assigned' },
    steps: [{ key: 'assigned', worker_id: worker.worker_id, status: 'blocked', task_id: null, command_id: null, result: null, error: null }],
  });
  const workerRetired = await context.admin(`/api/v1/workers/${worker.worker_id}`, { method: 'DELETE' });
  assert.equal(workerRetired.response.status, 200);
  assert.equal(context.hub.store.getOrchestration(orchestration.orchestration_id).steps[0].worker_id, worker.worker_id);

  const disabled = await context.admin('/api/v1/coordinator', { method: 'PUT', body: { enabled: false } });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.payload.coordinator.enabled, false);
  const coordinatorRetired = await context.admin(`/api/v1/workers/${coordinator.worker_id}`, { method: 'DELETE' });
  assert.equal(coordinatorRetired.response.status, 200);
  assert.equal(context.hub.store.getWorker(coordinator.worker_id).retired_at, coordinatorRetired.payload.worker.retired_at);
});
