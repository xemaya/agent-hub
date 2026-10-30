import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { HubStore } from '../src/db.js';

async function databaseRoot(t) {
  const parent = path.resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'db-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('v2 orchestration schema migrates without losing old records', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE coordinator_orchestrations (
      orchestration_id TEXT PRIMARY KEY,
      parent_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
      coordinator_worker_id TEXT NOT NULL REFERENCES workers(worker_id),
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO coordinator_orchestrations (
      orchestration_id, parent_task_id, coordinator_worker_id,
      status, summary, steps_json, created_at, updated_at
    ) VALUES (
      'orch_legacy', 'task_legacy', 'worker_legacy',
      'done', 'Legacy plan', '[]', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'
    );
    PRAGMA user_version = 2;
  `);
  legacy.close();
  const store = new HubStore(filename);
  t.after(() => store.close());
  const columns = store.db.prepare('PRAGMA table_info(coordinator_orchestrations)').all().map((column) => column.name);
  assert.ok(columns.includes('auto_start'));
  assert.ok(columns.includes('source_message_id'));
  assert.ok(columns.includes('review_reason'));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.ok(store.db.prepare('PRAGMA table_info(tasks)').all().some((column) => column.name === 'deleted_at'));
  assert.ok(store.db.prepare('PRAGMA table_info(workers)').all().some((column) => column.name === 'retired_at'));
  assert.ok(store.db.prepare('PRAGMA table_info(coordinator_chat_messages)').all().some((column) => column.name === 'mentions_json'));
  assert.ok(store.db.prepare('PRAGMA table_info(coordinator_chat_messages)').all().some((column) => column.name === 'conversation_epoch'));
  const migrated = store.getOrchestration('orch_legacy');
  assert.equal(migrated.summary, 'Legacy plan');
  assert.equal(migrated.auto_start, true);
  assert.equal(migrated.source_message_id, null);
  assert.equal(migrated.review_reason, '');
  const chatTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_chat_messages'").get();
  assert.equal(chatTable.name, 'coordinator_chat_messages');
});

test('Chat and orchestration idempotency survive reopening the database', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  let store = new HubStore(filename);
  t.after(() => {
    if (store) store.close();
  });
  const connector = store.createConnector({ name: 'db-test', tokenHash: 'test-hash' });
  const worker = store.registerWorker(connector.connector_id, {
    name: 'db-worker', runtime: 'test', mode: 'external', runtime_session_id: 'db-session',
    capabilities: ['testing'], cwd: root, metadata: {},
  });
  const user = store.createChatMessage({
    role: 'user', content: '只规划', requestId: 'same-request',
    mentions: [{ type: 'worker', id: worker.worker_id }],
  });
  assert.equal(store.createChatMessage({ role: 'user', content: '重复请求', requestId: 'same-request' }).message_id, user.message_id);
  const reply = store.createChatMessage({ role: 'coordinator', status: 'pending', sourceKey: `chat-reply:${user.message_id}` });
  assert.equal(store.createChatMessage({ role: 'coordinator', sourceKey: `chat-reply:${user.message_id}` }).message_id, reply.message_id);
  const created = store.createOrchestratedTask({
    title: 'Persistent plan', goal: 'Only one parent', context: '', acceptance: ['One plan'],
    createdBy: 'admin', coordinatorWorkerId: worker.worker_id, sourceMessageId: reply.message_id, autoStart: false,
  });
  const repeated = store.createOrchestratedTask({
    title: 'Persistent plan', goal: 'Only one parent', context: '', acceptance: ['One plan'],
    createdBy: 'admin', coordinatorWorkerId: worker.worker_id, sourceMessageId: reply.message_id, autoStart: false,
  });
  assert.equal(repeated.orchestration.orchestration_id, created.orchestration.orchestration_id);
  assert.equal(store.listOrchestrations().length, 1);
  assert.equal(store.listTasks().length, 1);
  store.updateChatMessage(reply.message_id, {
    status: 'done', content: '计划已保存', taskId: created.task.task_id,
  });
  store.close();
  store = new HubStore(filename);
  const restored = store.getOrchestration(created.orchestration.orchestration_id);
  assert.equal(restored.status, 'planning');
  assert.equal(restored.auto_start, false);
  assert.equal(restored.source_message_id, reply.message_id);
  const messages = store.listChatMessages();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].mentions, [{ type: 'worker', id: worker.worker_id }]);
  assert.equal(messages[1].content, '计划已保存');
  assert.equal(messages[1].task_id, created.task.task_id);
  assert.equal(store.createChatMessage({ role: 'user', content: '再试一次', requestId: 'same-request' }).message_id, user.message_id);
});

test('Conversation epochs filter visible chat without deleting source messages', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  let store = new HubStore(filename);
  t.after(() => {
    if (store) store.close();
  });
  const first = store.createChatMessage({ role: 'user', content: 'Old epoch', requestId: 'old-epoch' });
  assert.equal(first.conversation_epoch, 0);
  assert.equal(store.clearConversation(), 1);
  const second = store.createChatMessage({ role: 'user', content: 'New epoch', requestId: 'new-epoch' });
  assert.equal(second.conversation_epoch, 1);
  assert.deepEqual(store.listChatMessages({ epoch: 1 }).map((message) => message.content), ['New epoch']);
  assert.equal(store.listChatMessages().length, 2);
  store.close();
  store = new HubStore(filename);
  assert.equal(store.conversationEpoch(), 1);
  assert.deepEqual(store.listChatMessages({ epoch: 1 }).map((message) => message.content), ['New epoch']);
  assert.equal(store.getChatMessage(first.message_id).content, 'Old epoch');
  assert.equal(store.clearConversation(), 2);
  assert.deepEqual(store.listChatMessages({ epoch: 2 }), []);
});

test('Task numbers migrate in order and are not reused after restart or history clearing', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      context TEXT NOT NULL,
      acceptance_json TEXT NOT NULL,
      assignee_worker_id TEXT,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tasks VALUES
      ('task_old_1', 'Old one', '', '', '[]', NULL, 'ready', 'admin', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'),
      ('task_old_2', 'Old two', '', '', '[]', NULL, 'ready', 'admin', '2026-10-26T00:00:01.000Z', '2026-10-26T00:00:01.000Z');
    PRAGMA user_version = 6;
  `);
  legacy.close();
  let store = new HubStore(filename);
  t.after(() => {
    if (store) store.close();
  });
  assert.equal(store.getTask('task_old_1').task_number, 1);
  assert.equal(store.getTask('task_old_2').task_number, 2);
  assert.equal(store.createTask({ title: 'New three' }).task_number, 3);
  store.close();
  store = new HubStore(filename);
  store.clearHistory();
  assert.equal(store.createTask({ title: 'After clear' }).task_number, 4);
});

test('interactive-only migration preserves Worker identity, work history and Coordinator config', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  let store = new HubStore(filename);
  t.after(() => {
    if (store) store.close();
  });
  const connector = store.createConnector({ name: 'legacy-mac', tokenHash: 'legacy-hash' });
  const worker = store.registerWorker(connector.connector_id, {
    name: 'legacy-worker', runtime: 'codex', mode: 'external', runtime_session_id: 'legacy-session',
    capabilities: ['coding'], cwd: root, metadata: {},
  });
  const task = store.createTask({ title: 'Legacy work', assignee_worker_id: worker.worker_id });
  const command = store.createCommand({ worker_id: worker.worker_id, task_id: task.task_id, input: 'Preserve me', push_capable: true });
  store.setCoordinatorConfig({ workerId: worker.worker_id, enabled: true, maxSteps: 4 });
  store.db.exec(`PRAGMA ignore_check_constraints = ON;
    UPDATE workers SET mode = 'managed', push_capable = 1 WHERE worker_id = '${worker.worker_id}';
    ALTER TABLE commands DROP COLUMN last_activity_at;
    PRAGMA user_version = 10;
  `);
  store.close();

  store = new HubStore(filename);
  const migrated = store.getWorker(worker.worker_id);
  assert.equal(migrated.worker_id, worker.worker_id);
  assert.equal(migrated.mode, 'external');
  assert.equal(migrated.push_capable, false);
  assert.equal(store.getTask(task.task_id).title, 'Legacy work');
  assert.equal(store.getCommand(command.command_id).input, 'Preserve me');
  assert.equal(store.getCommand(command.command_id).sender_worker_id, null);
  assert.equal(store.getCommand(command.command_id).last_activity_at, command.created_at);
  assert.equal(store.getCoordinatorConfig().worker_id, worker.worker_id);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 11);
});
