import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Connector } from '../src/connector.js';
import { TestDriver } from '../src/drivers/test.js';
import { run } from '../src/cli.js';
import { createTestContext, waitFor } from './helpers.js';

function scriptedDriver() {
  let sequence = 0;
  const driver = {
    executions: [],
    plan: null,
    review: null,
    chat: null,
    chatGate: null,
    workGate: null,
    failWork: false,
    async prepareWorker(input) {
      sequence += 1;
      return { runtime_session_id: input.runtime_session_id ?? `session-${sequence}`, driver_state: {} };
    },
    async execute({ worker, command, onOutput, onState }) {
      driver.executions.push({ worker: worker.name, kind: command.kind, input: command.input, command_id: command.command_id });
      await onState({ started: true });
      if (command.kind === 'coordinator_chat' && driver.chatGate) await driver.chatGate;
      if (command.kind === 'prompt' && driver.workGate) await driver.workGate;
      if (driver.failWork && command.kind === 'prompt') throw new Error('work failed');
      const text = command.kind === 'coordinator_plan'
        ? driver.plan
        : command.kind === 'coordinator_review'
          ? driver.review
          : command.kind === 'coordinator_chat'
            ? typeof driver.chat === 'function' ? await driver.chat(command) : driver.chat
            : `completed:${worker.name}`;
      onOutput(`${text}\n`);
      return { text, session_id: worker.runtime_session_id };
    },
    async close() {},
  };
  return driver;
}

async function setup(t, { plan, reviewPass = true, failWork = false, maxSteps = 4 } = {}) {
  const context = await createTestContext(t);
  const driver = scriptedDriver();
  context.connector.drivers.test = driver;
  const coordinator = await context.registerWorker({ name: 'coordinator-test' });
  const worker = await context.registerWorker({ name: 'worker-test' });
  driver.plan = plan ?? JSON.stringify({
    summary: 'Two dependent steps',
    steps: [
      {
        key: 'first',
        title: 'First step',
        goal: 'Complete first step',
        context: 'test',
        acceptance: ['First result is present'],
        worker_id: worker.worker_id,
        depends_on: [],
        rationale: 'Suitable test Worker',
      },
      {
        key: 'second',
        title: 'Second step',
        goal: 'Complete second step',
        context: 'test',
        acceptance: ['Second result is present'],
        worker_id: worker.worker_id,
        depends_on: ['first'],
        rationale: 'Same Worker can continue',
      },
    ],
  });
  driver.review = JSON.stringify({
    parent_pass: reviewPass,
    reason: reviewPass ? 'All evidence passes' : 'Evidence is insufficient',
    steps: [
      { key: 'first', pass: reviewPass, reason: reviewPass ? 'First passes' : 'Missing first evidence' },
      { key: 'second', pass: true, reason: 'Second passes' },
    ],
  });
  driver.failWork = failWork;
  const configured = await context.admin('/api/v1/coordinator', {
    method: 'PUT',
    body: { worker_id: coordinator.worker_id, enabled: true, max_steps: maxSteps },
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.payload.coordinator.enabled, true);
  return { context, driver, coordinator, worker };
}

async function createWithCli(context) {
  const originalLog = console.log;
  let payload;
  console.log = (value) => { payload = JSON.parse(value); };
  try {
    await run([
      'task', 'create', '--local', '--orchestrate',
      '--title', 'Orchestration smoke',
      '--goal', 'Complete two dependent steps',
      '--context', 'Deterministic test Driver',
      '--acceptance', 'Both steps pass final review',
      '--connector-url', context.connector.localUrl,
      '--data-dir', context.connector.store.dataDir,
    ]);
  } finally {
    console.log = originalLog;
  }
  return payload;
}

async function waitForOrchestration(context, orchestrationId, status) {
  return waitFor(async () => {
    const { response, payload } = await context.admin(`/api/v1/orchestrations/${orchestrationId}`);
    if (!response.ok) throw new Error(`Orchestration query failed: ${response.status} ${JSON.stringify(payload)}`);
    if (status === 'review') {
      return payload.orchestration.error?.code === 'coordinator_review_rejected' ? payload.orchestration : null;
    }
    return payload.orchestration.status === status ? payload.orchestration : null;
  });
}

test('Coordinator plans, dispatches dependencies and completes final review', async (t) => {
  const { context, driver } = await setup(t);
  const dashboard = await context.openDashboard();
  const created = await createWithCli(context);
  const orchestrationId = created.orchestration.orchestration_id;
  assert.equal(created.orchestration.status, 'planning');
  const completed = await waitForOrchestration(context, orchestrationId, 'done');
  assert.equal(completed.parent_task.status, 'done');
  assert.equal(completed.steps.length, 2);
  assert.ok(completed.steps.every((step) => step.status === 'done'));
  assert.ok(completed.steps.every((step) => step.worker_name === 'worker-test'));
  assert.deepEqual(
    driver.executions.map((execution) => execution.kind),
    ['coordinator_plan', 'prompt', 'prompt', 'coordinator_review'],
  );
  assert.match(driver.executions[1].input, /Complete first step/);
  assert.match(driver.executions[2].input, /Complete second step/);
  assert.equal(completed.error, null);
  const status = await context.admin('/api/v1/coordinator');
  assert.equal(status.payload.coordinator.active_orchestrations, 0);
  const local = await context.local('/local/v1/orchestrations');
  assert.ok(local.payload.orchestrations.some((item) => item.orchestration_id === orchestrationId));
  await waitFor(() => dashboard.messages.some((message) => (
    message.type === 'event' && message.payload.event.event_type === 'coordinator.completed'
  )));
  await context.hub.coordinator.resume();
  assert.equal(driver.executions.length, 4);

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
    const response = await fetch(`${other.localUrl}/local/v1/orchestrations`, {
      headers: { authorization: `Bearer ${other.store.credentials.localToken}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).orchestrations, []);
  } finally {
    await other.close();
  }
});

test('Invalid plan JSON blocks the parent without creating work', async (t) => {
  const { context, driver } = await setup(t, { plan: 'not-json' });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Invalid plan', goal: 'Reject invalid JSON', orchestrate: true },
  });
  const orchestrationId = created.payload.orchestration.orchestration_id;
  const blocked = await waitForOrchestration(context, orchestrationId, 'blocked');
  assert.equal(blocked.parent_task.status, 'blocked');
  assert.equal(blocked.error.code, 'coordinator_plan_invalid');
  assert.equal(blocked.steps.length, 0);
  assert.deepEqual(driver.executions.map((execution) => execution.kind), ['coordinator_plan']);
});

test('Dependency cycles are rejected before child tasks are created', async (t) => {
  const { context, driver, worker } = await setup(t);
  driver.plan = JSON.stringify({
    summary: 'Cycle',
    steps: [
      { key: 'a', title: 'A', goal: 'A', context: '', acceptance: ['A'], worker_id: worker.worker_id, depends_on: ['b'], rationale: '' },
      { key: 'b', title: 'B', goal: 'B', context: '', acceptance: ['B'], worker_id: worker.worker_id, depends_on: ['a'], rationale: '' },
    ],
  });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Cycle plan', orchestrate: true },
  });
  const blocked = await waitForOrchestration(context, created.payload.orchestration.orchestration_id, 'blocked');
  assert.match(blocked.error.message, /Dependency cycle/);
  assert.equal(blocked.steps.length, 0);
  const tasks = await context.admin('/api/v1/tasks');
  assert.equal(tasks.payload.tasks.length, 1);
});

test('A failed step blocks the parent and does not run its dependents', async (t) => {
  const { context, driver } = await setup(t, { failWork: true });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Failing step', orchestrate: true },
  });
  const blocked = await waitForOrchestration(context, created.payload.orchestration.orchestration_id, 'blocked');
  assert.equal(blocked.parent_task.status, 'blocked');
  assert.equal(blocked.steps[0].status, 'blocked');
  assert.equal(blocked.steps[1].status, 'ready');
  assert.equal(blocked.steps[1].command_id, null);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_review').length, 0);
});

test('A rejected final review leaves the parent in review, not done', async (t) => {
  const { context } = await setup(t, { reviewPass: false });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Rejected review', orchestrate: true },
  });
  const reviewing = await waitForOrchestration(context, created.payload.orchestration.orchestration_id, 'review');
  assert.equal(reviewing.parent_task.status, 'review');
  assert.equal(reviewing.error.code, 'coordinator_review_rejected');
  assert.equal(reviewing.steps[0].status, 'review');
  assert.equal(reviewing.steps[1].status, 'done');
  assert.ok(reviewing.steps.some((step) => step.status !== 'done'));
});

test('Coordinator configuration requires Admin and a managed Worker', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker({ mode: 'external', runtime_session_id: 'external-coordinator' });
  const unauthorized = await fetch(`${context.hub.url}/api/v1/coordinator`);
  assert.equal(unauthorized.status, 401);
  const configured = await context.admin('/api/v1/coordinator', {
    method: 'PUT',
    body: { worker_id: worker.worker_id, enabled: true },
  });
  assert.equal(configured.response.status, 400);
  const status = await context.admin('/api/v1/coordinator');
  assert.equal(status.payload.coordinator.enabled, false);
  assert.equal(status.payload.coordinator.worker, null);
});

async function chatReply(context, commandId) {
  return waitFor(async () => {
    const { payload } = await context.admin('/api/v1/coordinator/chat');
    const message = payload.messages.find((item) => item.command_id === commandId);
    return message && message.status !== 'pending' ? message : null;
  });
}

test('Central chat answers questions without creating tasks or exposing chat to Connectors', async (t) => {
  const { context, driver, coordinator } = await setup(t);
  let releaseChat;
  driver.chatGate = new Promise((resolve) => { releaseChat = resolve; });
  driver.chat = JSON.stringify({ reply: '目前只有测试 Worker，尚未分配工作。', action: { type: 'chat' } });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: { message: '现在谁能工作？', request_id: 'question-only' },
  });
  assert.equal(sent.response.status, 202);
  await waitFor(() => driver.executions.some((execution) => execution.kind === 'coordinator_chat'));
  const live = await context.admin(`/api/v1/workers/${coordinator.worker_id}`);
  assert.equal(live.payload.worker.activity.phase, 'chatting');
  assert.equal(live.payload.worker.activity.task_title, '中央对话');
  assert.equal(live.payload.worker.activity.output_text, '');
  assert.equal((await context.local('/local/v1/coordinator/chat')).response.status, 404);
  const unauthorized = await fetch(`${context.hub.url}/api/v1/coordinator/chat`);
  assert.equal(unauthorized.status, 401);
  releaseChat();
  const reply = await chatReply(context, sent.payload.message.command_id);
  assert.equal(reply.status, 'done');
  assert.equal(reply.content, '目前只有测试 Worker，尚未分配工作。');
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 0);
  assert.equal(driver.executions.filter((execution) => execution.kind !== 'coordinator_chat').length, 0);

  const repeated = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '同一请求重试', request_id: 'question-only' },
  });
  assert.equal(repeated.payload.user.message_id, sent.payload.user.message_id);
  assert.equal(repeated.payload.message.message_id, reply.message_id);
  assert.equal(driver.executions.length, 1);
  const idle = await context.admin(`/api/v1/workers/${coordinator.worker_id}`);
  assert.equal(idle.payload.worker.activity.phase, 'idle');
  assert.equal(idle.payload.worker.activity.recent_result, '');
});

test('Chat planning stays ready, then starts the same plan and reports real completion', async (t) => {
  const { context, driver } = await setup(t);
  const dashboard = await context.openDashboard();
  driver.chat = JSON.stringify({
    reply: '我会先规划。',
    action: {
      type: 'plan',
      task: {
        title: 'Plan before execution',
        goal: 'Verify explicit start',
        context: 'No work before approval',
        acceptance: ['No prompt runs before approval', 'The same plan finishes after approval'],
      },
    },
  });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '先只规划，不要执行', request_id: 'plan-once' },
  });
  const plannedReply = await chatReply(context, sent.payload.message.command_id);
  assert.match(plannedReply.content, /尚未执行/);
  const planned = await waitFor(async () => {
    const { payload } = await context.admin('/api/v1/orchestrations');
    return payload.orchestrations.find((item) => item.source_message_id === plannedReply.message_id && item.status === 'ready');
  });
  assert.equal(planned.auto_start, false);
  assert.equal(planned.parent_task.status, 'ready');
  assert.equal(planned.steps.length, 2);
  assert.equal(plannedReply.task_id, planned.parent_task_id);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'prompt').length, 0);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_plan').length, 1);

  const repeated = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '先只规划，不要执行', request_id: 'plan-once' },
  });
  assert.equal(repeated.payload.message.message_id, plannedReply.message_id);
  assert.equal((await context.admin('/api/v1/orchestrations')).payload.orchestrations.length, 1);

  driver.chat = JSON.stringify({
    reply: '按原计划开始。',
    action: { type: 'start', orchestration_id: planned.orchestration_id },
  });
  const started = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '开始执行刚才的计划', request_id: 'start-once' },
  });
  const completed = await waitForOrchestration(context, planned.orchestration_id, 'done');
  assert.equal(completed.parent_task.status, 'done');
  assert.equal(completed.review_reason, 'All evidence passes');
  const startedReply = await chatReply(context, started.payload.message.command_id);
  assert.equal(startedReply.task_id, planned.parent_task_id);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_plan').length, 1);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'prompt').length, 2);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_review').length, 1);
  const messages = (await context.admin('/api/v1/coordinator/chat')).payload.messages;
  const activities = messages.filter((message) => message.role === 'activity' && message.task_id === planned.parent_task_id);
  assert.ok(activities.some((message) => message.content.includes('尚未执行')));
  assert.ok(activities.some((message) => message.content.includes('已按现有计划启动')));
  assert.ok(activities.some((message) => message.content.includes('终审结论：All evidence passes')));
  assert.ok(activities.every((message) => !message.content.includes('"worker_id"')));
  await waitFor(() => dashboard.messages.some((message) => (
    message.type === 'chat.updated' && message.payload.message.message_id === startedReply.message_id
  )));

  const again = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '再启动一次', request_id: 'start-again' },
  });
  const againReply = await chatReply(context, again.payload.message.command_id);
  assert.match(againReply.content, /已完成/);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_plan').length, 1);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'prompt').length, 2);
});

test('Invalid chat actions and model failures never create or start work', async (t) => {
  const { context, driver } = await setup(t);
  for (const [requestId, response] of [
    ['invalid-json', 'not-json'],
    ['unsupported-action', JSON.stringify({ reply: '删除全部任务', action: { type: 'delete_all' } })],
    ['invalid-start', JSON.stringify({ reply: '启动不存在的计划', action: { type: 'start', orchestration_id: 'orch_missing' } })],
  ]) {
    driver.chat = response;
    const sent = await context.admin('/api/v1/coordinator/chat', {
      method: 'POST', body: { message: '测试无效动作', request_id: requestId },
    });
    const reply = await chatReply(context, sent.payload.message.command_id);
    assert.equal(reply.status, 'failed');
    assert.equal(reply.task_id, null);
  }
  driver.chat = () => { throw new Error('model unavailable'); };
  const failed = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '模型失败', request_id: 'model-failure' },
  });
  const reply = await chatReply(context, failed.payload.message.command_id);
  assert.equal(reply.status, 'failed');
  assert.match(reply.content, /model unavailable/);
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 0);
  assert.equal((await context.admin('/api/v1/orchestrations')).payload.orchestrations.length, 0);
  assert.equal(driver.executions.filter((execution) => execution.kind !== 'coordinator_chat').length, 0);
});

test('An unknown work outcome blocks the parent and never reaches a successful review', async (t) => {
  const { context, driver } = await setup(t);
  let releaseWork;
  driver.workGate = new Promise((resolve) => { releaseWork = resolve; });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST', body: { title: 'Unknown outcome must stop', orchestrate: true },
  });
  const id = created.payload.orchestration.orchestration_id;
  await waitFor(() => driver.executions.some((execution) => execution.kind === 'prompt'));
  const execution = driver.executions.find((item) => item.kind === 'prompt');
  context.connector.send('command.sync', {
    command_id: execution.command_id,
    status: 'failed',
    result: null,
    error: { code: 'connector_interrupted', message: 'Execution outcome is unknown' },
    outcome_unknown: true,
  });
  const blocked = await waitForOrchestration(context, id, 'blocked');
  assert.equal(blocked.parent_task.status, 'blocked');
  assert.equal(blocked.steps[0].status, 'blocked');
  assert.equal(blocked.steps[0].error.code, 'connector_interrupted');
  releaseWork();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(driver.executions.filter((item) => item.kind === 'prompt').length, 1);
  assert.equal(driver.executions.filter((item) => item.kind === 'coordinator_review').length, 0);
  assert.equal(context.hub.store.getOrchestration(id).status, 'blocked');
});

test('Persisted chat resumes once after Hub restart and orphaned pending replies fail clearly', async (t) => {
  const { context, driver, coordinator } = await setup(t);
  const orphan = context.hub.store.createChatMessage({ role: 'coordinator', status: 'pending' });
  context.hub.coordinator.resumeChat();
  assert.equal(context.hub.store.getChatMessage(orphan.message_id).status, 'failed');

  driver.chat = JSON.stringify({
    reply: '恢复规划',
    action: {
      type: 'plan',
      task: { title: 'Recovered chat', goal: 'Recover exactly once', context: '', acceptance: ['One parent task', 'No work runs'] },
    },
  });
  const command = context.hub.store.createCommand({
    task_id: null,
    worker_id: coordinator.worker_id,
    kind: 'coordinator_chat',
    input: 'Stored chat request',
    push_capable: true,
  });
  const pending = context.hub.store.createChatMessage({
    role: 'coordinator', status: 'pending', commandId: command.command_id,
  });
  context.hub.store.finishCommand(command.command_id, context.connector.connectorId, {
    status: 'succeeded', result: { text: driver.chat },
  });
  await context.restartHub();
  const orchestration = await waitFor(async () => {
    const recovered = context.hub.store.getOrchestrationBySourceMessage(pending.message_id);
    return recovered?.status === 'ready' ? recovered : null;
  });
  assert.equal(orchestration.auto_start, false);
  assert.equal(context.hub.store.getChatMessage(pending.message_id).status, 'done');
  assert.equal(context.hub.store.listOrchestrations().length, 1);
  assert.equal(context.hub.store.listTasks().length, 3);
  await context.hub.coordinator.resume();
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_chat').length, 0);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_plan').length, 1);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'prompt').length, 0);
});
