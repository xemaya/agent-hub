import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, waitFor } from './helpers.js';

async function createTask(context, overrides = {}) {
  const { response, payload } = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Delete me', goal: 'Keep the audit record', acceptance: ['History survives'], ...overrides },
  });
  assert.equal(response.status, 201);
  return payload.task;
}

test('Task deletion is an idempotent tombstone that preserves history and task numbers', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime_session_id: 'delete-independent' });
  const dashboard = await context.openDashboard();
  const task = await createTask(context, { assignee_worker_id: worker.worker_id });
  assert.equal(context.hub.store.getWorker(worker.worker_id).current_task_id, task.task_id);
  assert.equal(context.hub.store.db.prepare('PRAGMA user_version').get().user_version, 12);

  const deleted = await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.payload.deleted_task_ids, [task.task_id]);
  assert.ok(deleted.payload.task.deleted_at);
  assert.equal(context.hub.store.getWorker(worker.worker_id).current_task_id, null);
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 0);
  const audit = await context.admin('/api/v1/tasks?include_deleted=true');
  assert.equal(audit.payload.tasks[0].task_id, task.task_id);
  assert.equal(audit.payload.tasks[0].deleted_at, deleted.payload.task.deleted_at);
  assert.equal((await context.admin(`/api/v1/tasks/${task.task_id}`)).response.status, 200);
  await waitFor(() => dashboard.messages.some((message) => message.type === 'task.deleted' && message.payload.deleted_task_ids.includes(task.task_id)));

  const repeated = await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'DELETE' });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.task.deleted_at, deleted.payload.task.deleted_at);
  const updated = await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'PATCH', body: { title: 'Must not revive' } });
  assert.equal(updated.response.status, 409);
  const command = await context.admin('/api/v1/commands', {
    method: 'POST', body: { worker_id: worker.worker_id, task_id: task.task_id, input: 'Must not run' },
  });
  assert.equal(command.response.status, 409);
  assert.throws(() => context.hub.coordinator.resolveMentions([{ type: 'task', id: task.task_id }], worker.worker_id), /Mentioned Task does not exist/);
  const next = await createTask(context, { title: 'Next task' });
  assert.ok(next.task_number > task.task_number);
});

test('Active commands and tasks cannot be deleted but their settled history remains', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ runtime_session_id: 'delete-active' });
  const task = await createTask(context);
  const command = context.hub.store.createCommand({ worker_id: worker.worker_id, task_id: task.task_id, kind: 'prompt', input: 'running', push_capable: true });
  const rejected = await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'DELETE' });
  assert.equal(rejected.response.status, 409);
  assert.equal(context.hub.store.getTask(task.task_id).deleted_at, null);
  context.hub.store.finishCommand(command.command_id, context.connector.connectorId, { status: 'succeeded', result: { text: 'preserved' } });
  const deleted = await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(context.hub.store.getCommand(command.command_id).result.text, 'preserved');
  assert.equal(context.hub.store.listCommands({ taskId: task.task_id }).length, 1);

  const active = await createTask(context, { title: 'Still running' });
  context.hub.store.updateTask(active.task_id, { status: 'in_progress' });
  assert.equal((await context.admin(`/api/v1/tasks/${active.task_id}`, { method: 'DELETE' })).response.status, 409);
  context.hub.store.updateTask(active.task_id, { status: 'cancelled' });
  assert.equal((await context.admin(`/api/v1/tasks/${active.task_id}`, { method: 'DELETE' })).response.status, 200);
});

test('Deleting an orchestration removes its whole family but preserves its audit record', async (t) => {
  const context = await createTestContext(t);
  const coordinator = await context.registerWorker({ name: 'coordinator', runtime_session_id: 'delete-coordinator' });
  const worker = await context.registerWorker({ name: 'worker', runtime_session_id: 'delete-child' });
  context.hub.coordinator.configure({ workerId: coordinator.worker_id });
  const { task, orchestration } = context.hub.store.createOrchestratedTask({
    title: 'Planned task', goal: 'Delete together', acceptance: ['No orphaned steps'],
    createdBy: 'test', coordinatorWorkerId: coordinator.worker_id, autoStart: false,
  });
  const child = context.hub.store.createTask({ title: 'Child', assignee_worker_id: worker.worker_id });
  context.hub.store.updateOrchestration(orchestration.orchestration_id, {
    status: 'ready',
    steps: [
      { key: 'one', task_id: child.task_id, worker_id: worker.worker_id, status: 'ready', result: null },
      { key: 'two', task_id: null, worker_id: worker.worker_id, status: 'ready', result: null },
    ],
  });
  assert.equal((await context.admin(`/api/v1/tasks/${child.task_id}`, { method: 'DELETE' })).response.status, 409);
  const deleted = await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(new Set(deleted.payload.deleted_task_ids), new Set([task.task_id, child.task_id]));
  assert.equal(context.hub.store.listTasks().length, 0);
  assert.equal(context.hub.store.listOrchestrations().length, 0);
  assert.equal(context.hub.store.getOrchestration(orchestration.orchestration_id).parent_task_id, task.task_id);
  assert.ok(context.hub.store.getTask(task.task_id).deleted_at);
  assert.ok(context.hub.store.getTask(child.task_id).deleted_at);
  assert.equal(context.hub.store.getWorker(worker.worker_id).current_task_id, null);
});
