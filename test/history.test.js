import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { run } from '../src/cli.js';
import { createTestContext, waitFor } from './helpers.js';

async function cliHistoryClear(context) {
  const previousToken = process.env.AGENT_HUB_ADMIN_TOKEN;
  const originalLog = console.log;
  let output;
  process.env.AGENT_HUB_ADMIN_TOKEN = 'test-admin';
  console.log = (value) => { output = JSON.parse(value); };
  try {
    await run(['history', 'clear', '--yes', '--hub-url', context.hub.url]);
  } finally {
    console.log = originalLog;
    if (previousToken === undefined) delete process.env.AGENT_HUB_ADMIN_TOKEN;
    else process.env.AGENT_HUB_ADMIN_TOKEN = previousToken;
  }
  return output;
}

test('History clearing backs up work, preserves registration and accepts new tasks', async (t) => {
  const context = await createTestContext(t);
  const dashboard = await context.openDashboard();
  const coordinator = await context.registerWorker({ name: 'history-coordinator', runtime_session_id: 'history-brain' });
  const worker = await context.registerWorker({ name: 'history-worker', runtime_session_id: 'history-worker' });
  await context.admin('/api/v1/coordinator', {
    method: 'PUT', body: { worker_id: coordinator.worker_id, enabled: true },
  });
  const created = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Old completed work', assignee_worker_id: worker.worker_id },
  });
  const task = created.payload.task;
  const command = context.hub.store.createCommand({
    task_id: task.task_id, worker_id: worker.worker_id, input: 'Historical command', push_capable: true,
  });
  context.hub.store.finishCommand(command.command_id, context.connector.connectorId, {
    status: 'succeeded', result: { text: 'Historical result' },
  });
  context.hub.store.updateTask(task.task_id, { status: 'done' });
  context.hub.store.createChatMessage({ role: 'user', content: 'Old conversation', requestId: 'old-request' });
  const historical = context.hub.store.createOrchestratedTask({
    title: 'Settled historical review', goal: 'Old work', context: '', acceptance: [],
    createdBy: 'admin', coordinatorWorkerId: coordinator.worker_id, autoStart: false,
  });
  context.hub.store.updateOrchestration(historical.orchestration.orchestration_id, {
    status: 'review', error: { code: 'coordinator_review_rejected', message: 'Old review did not pass' },
  });
  context.hub.store.updateTask(historical.task.task_id, { status: 'review' });
  context.hub.store.clearConversation();

  const missingConfirmation = await context.admin('/api/v1/history/clear', { method: 'POST', body: {} });
  assert.equal(missingConfirmation.response.status, 400);
  const unauthorized = await fetch(`${context.hub.url}/api/v1/history/clear`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(unauthorized.status, 401);
  await assert.rejects(run(['history', 'clear', '--hub-url', context.hub.url]), /--yes/);
  const result = await cliHistoryClear(context);
  assert.equal(result.cleared.tasks, 2);
  assert.equal(result.cleared.commands, 1);
  assert.equal(result.cleared.coordinator_chat_messages, 1);
  assert.ok(result.backup.startsWith(context.root));

  const backup = new DatabaseSync(result.backup, { readOnly: true });
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM coordinator_chat_messages').get().count, 1);
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM workers').get().count, 2);
  assert.equal(backup.prepare("SELECT content FROM coordinator_chat_messages WHERE request_id = 'old-request'").get().content, 'Old conversation');
  backup.close();

  assert.deepEqual((await context.admin('/api/v1/tasks')).payload.tasks, []);
  assert.deepEqual((await context.admin('/api/v1/orchestrations')).payload.orchestrations, []);
  assert.deepEqual((await context.admin('/api/v1/coordinator/chat')).payload.messages, []);
  assert.deepEqual((await context.admin('/api/v1/commands')).payload.commands, []);
  const workers = (await context.admin('/api/v1/workers')).payload.workers;
  assert.equal(workers.length, 2);
  assert.ok(workers.every((item) => item.work_state === 'idle' && item.current_task_id === null));
  assert.ok(workers.some((item) => item.worker_id === worker.worker_id));
  const configured = await context.admin('/api/v1/coordinator');
  assert.equal(configured.payload.coordinator.enabled, true);
  assert.equal(configured.payload.coordinator.worker_id, coordinator.worker_id);
  await waitFor(() => dashboard.messages.some((message) => message.type === 'history.cleared'));

  const next = await context.local('/local/v1/tasks', {
    method: 'POST', body: { title: 'New work after cleanup', assignee_worker_id: worker.worker_id },
  });
  assert.equal(next.response.status, 201);
  const dispatched = await context.local('/local/v1/commands', {
    method: 'POST', body: { task_id: next.payload.task.task_id, worker_id: worker.worker_id, input: 'Return new work' },
  });
  await waitFor(() => ['succeeded', 'failed'].includes(context.hub.store.getCommand(dispatched.payload.command.command_id).status));
  assert.equal(context.hub.store.getCommand(dispatched.payload.command.command_id).status, 'succeeded');
  assert.equal(context.hub.store.conversationEpoch(), 0);
  const chat = context.hub.store.createChatMessage({ role: 'user', content: 'New conversation after history reset' });
  assert.equal(chat.conversation_epoch, 0);
  assert.deepEqual(context.hub.coordinator.chat().map((message) => message.content), ['New conversation after history reset']);
});

test('History clearing refuses active work but allows a settled rejected review', async (t) => {
  const context = await createTestContext(t);
  const coordinator = await context.registerWorker({ name: 'guard-coordinator' });
  const worker = await context.registerWorker({ name: 'guard-worker' });
  const created = await context.admin('/api/v1/tasks', {
    method: 'POST', body: { title: 'Active work guard', assignee_worker_id: worker.worker_id },
  });
  const task = created.payload.task;
  const command = context.hub.store.createCommand({
    task_id: task.task_id, worker_id: worker.worker_id, input: 'Still queued', push_capable: true,
  });
  await assert.rejects(context.hub.clearHistory(), (error) => error.code === 'history_active' && error.statusCode === 409);
  context.hub.store.finishCommand(command.command_id, context.connector.connectorId, {
    status: 'failed', error: { message: 'Interrupted' },
  });
  context.hub.store.updateTask(task.task_id, { status: 'in_progress' });
  await assert.rejects(context.hub.clearHistory(), (error) => error.active.tasks === 1);
  context.hub.store.updateTask(task.task_id, { status: 'blocked' });
  const pending = context.hub.store.createChatMessage({ role: 'coordinator', status: 'pending' });
  await assert.rejects(context.hub.clearHistory(), (error) => error.active.pending_messages === 1);
  context.hub.store.updateChatMessage(pending.message_id, { status: 'failed', content: 'Not dispatched' });
  const orchestrated = context.hub.store.createOrchestratedTask({
    title: 'Unfinished planning', goal: 'Guard recovery', context: '', acceptance: [],
    createdBy: 'admin', coordinatorWorkerId: coordinator.worker_id, autoStart: false,
  });
  await assert.rejects(context.hub.clearHistory(), (error) => error.active.orchestrations === 1);
  context.hub.store.updateOrchestration(orchestrated.orchestration.orchestration_id, {
    status: 'review', error: { code: 'coordinator_review_rejected', message: 'Evidence missing' },
  });
  context.hub.store.updateTask(orchestrated.task.task_id, { status: 'review' });
  const result = await context.hub.clearHistory();
  assert.equal(result.cleared.tasks, 2);
  assert.equal(result.cleared.coordinator_orchestrations, 1);
  assert.equal(context.hub.store.listWorkers().length, 2);
});
