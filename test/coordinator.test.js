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
    workerChatGate: null,
    workGate: null,
    work: null,
    failWork: false,
    failWorkerChat: false,
    async prepareWorker(input) {
      sequence += 1;
      return { runtime_session_id: input.runtime_session_id ?? `session-${sequence}`, driver_state: {} };
    },
    async execute({ worker, command, onOutput, onState }) {
      driver.executions.push({ worker: worker.name, kind: command.kind, input: command.input, command_id: command.command_id });
      await onState({ started: true });
      if (command.kind === 'coordinator_chat' && driver.chatGate) await driver.chatGate;
      if (command.kind === 'worker_chat' && driver.workerChatGate) await driver.workerChatGate;
      if (command.kind === 'prompt' && driver.workGate) await driver.workGate;
      if (driver.failWork && command.kind === 'prompt') throw new Error('work failed');
      if (driver.failWorkerChat && command.kind === 'worker_chat') throw new Error('worker reply failed');
      const text = command.kind === 'coordinator_plan'
        ? driver.plan
        : command.kind === 'coordinator_review'
          ? typeof driver.review === 'function' ? await driver.review(command) : driver.review
          : command.kind === 'coordinator_chat'
            ? typeof driver.chat === 'function' ? await driver.chat(command) : driver.chat
            : typeof driver.work === 'function' ? await driver.work({ worker, command }) : `completed:${worker.name}`;
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
  assert.match(driver.executions[2].input, /completed:worker-test/);
  assert.match(driver.executions[2].input, /"result_truncated": false/);
  assert.equal(completed.error, null);
  assert.equal(completed.source_message_id, null);
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

test('A rejected final review stops after the bounded recovery attempts', async (t) => {
  const { context, driver } = await setup(t, { reviewPass: false });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Rejected review', orchestrate: true },
  });
  const reviewing = await waitForOrchestration(context, created.payload.orchestration.orchestration_id, 'review');
  assert.equal(reviewing.parent_task.status, 'review');
  assert.equal(reviewing.error.code, 'coordinator_review_rejected');
  assert.equal(reviewing.recovery_count, 2);
  assert.equal(reviewing.steps[0].status, 'review');
  assert.equal(reviewing.steps[1].status, 'done');
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_review').length, 3);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'prompt').length, 6);
  assert.ok(reviewing.steps.every((step) => step.previous_attempts.length === 2));
});

test('Central recovery uses review evidence and reruns failed steps and their dependents', async (t) => {
  const { context, driver } = await setup(t);
  let reviewRound = 0;
  driver.review = () => {
    reviewRound += 1;
    const pass = reviewRound > 1;
    return JSON.stringify({
      parent_pass: pass,
      reason: pass ? 'Corrected evidence passes' : 'Evidence is insufficient; use the correction from step two',
      steps: [
        { key: 'first', pass, reason: pass ? 'First corrected' : 'Missing first evidence' },
        { key: 'second', pass: true, reason: 'Second passes' },
      ],
    });
  };
  driver.work = ({ command }) => command.input.includes('上次终审与本次修正上下文') ? 'corrected evidence' : 'initial evidence';
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Recovered review', orchestrate: true },
  });
  const completed = await waitForOrchestration(context, created.payload.orchestration.orchestration_id, 'done');
  assert.deepEqual(driver.executions.map((execution) => execution.kind), [
    'coordinator_plan', 'prompt', 'prompt', 'coordinator_review', 'prompt', 'prompt', 'coordinator_review',
  ]);
  assert.equal(completed.recovery_count, 1);
  assert.equal(completed.parent_task.task_number, 1);
  assert.equal(completed.review_command_id, driver.executions.at(-1).command_id);
  assert.match(driver.executions[4].input, /Evidence is insufficient; use the correction from step two/);
  assert.match(driver.executions[4].input, /initial evidence/);
  assert.ok(completed.steps.every((step) => step.attempt === 2 && step.previous_attempts.length === 1));
  assert.ok(completed.steps.every((step) => step.result.text === 'corrected evidence'));
});

test('A parent-only rejection does not rerun steps or loop reviews', async (t) => {
  const { context, driver } = await setup(t);
  driver.review = JSON.stringify({
    parent_pass: false,
    reason: 'Overall acceptance is not covered',
    steps: [
      { key: 'first', pass: true, reason: 'First passes' },
      { key: 'second', pass: true, reason: 'Second passes' },
    ],
  });
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Parent only rejection', orchestrate: true },
  });
  const reviewing = await waitForOrchestration(context, created.payload.orchestration.orchestration_id, 'review');
  assert.equal(reviewing.recovery_count, 0);
  assert.match(reviewing.error.message, /无法自动推进/);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'coordinator_review').length, 1);
  assert.equal(driver.executions.filter((execution) => execution.kind === 'prompt').length, 2);
});

test('Hub resume adopts a legacy rejected review and ignores its late review after recovery', async (t) => {
  const { context, driver } = await setup(t);
  const created = await context.local('/local/v1/tasks', {
    method: 'POST',
    body: { title: 'Legacy rejected review', orchestrate: true },
  });
  const orchestrationId = created.payload.orchestration.orchestration_id;
  const done = await waitForOrchestration(context, orchestrationId, 'done');
  const steps = done.steps.map((step, index) => index === 0
    ? { ...step, status: 'review', review: { pass: false, reason: 'Legacy missing evidence' } }
    : step);
  context.hub.store.updateTask(steps[0].task_id, { status: 'review' });
  context.hub.store.updateTask(done.parent_task_id, { status: 'review' });
  context.hub.store.updateOrchestration(orchestrationId, {
    status: 'review',
    steps,
    error: { code: 'coordinator_review_rejected', message: 'Legacy missing evidence' },
    reviewReason: 'Legacy missing evidence',
    recoveryCount: 0,
  });
  await context.hub.coordinator.resume();
  const recovered = await waitForOrchestration(context, orchestrationId, 'done');
  assert.equal(recovered.recovery_count, 1);
  assert.ok(recovered.steps.every((step) => step.previous_attempts.length === 1));
  const executionCount = driver.executions.length;
  context.hub.coordinator.onCommandFinished(context.hub.store.getCommand(done.review_command_id));
  assert.equal(driver.executions.length, executionCount);
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

async function directChatReply(context, userMessageId) {
  return waitFor(async () => {
    const { payload } = await context.admin('/api/v1/coordinator/chat');
    const message = payload.messages.find((item) => item.source_key === `chat-reply:${userMessageId}`);
    return message && message.status !== 'pending' ? message : null;
  });
}

test('An @Worker question is answered by that Worker with context and without a new task', async (t) => {
  const { context, driver, worker } = await setup(t);
  const dashboard = await context.openDashboard();
  const referenced = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: {
      title: 'Direct chat reference',
      goal: 'DIRECT_CHAT_REFERENCE_CONTEXT',
      context: 'Known context only',
      acceptance: ['Existing acceptance'],
      assignee_worker_id: worker.worker_id,
    },
  });
  assert.equal(referenced.response.status, 201);
  const referencedTask = referenced.payload.task;
  driver.chat = JSON.stringify({ reply: '中央代答不应出现', action: { type: 'chat' } });
  driver.work = ({ command }) => command.kind === 'worker_chat'
    ? '这是 worker-test 本人的真实回答。'
    : '不应执行普通任务';
  let releaseWorkerChat;
  driver.workerChatGate = new Promise((resolve) => { releaseWorkerChat = resolve; });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: {
      message: '@worker-test 你能做啥？顺便看看引用任务。',
      request_id: 'direct-worker-question',
      mentions: [
        { type: 'worker', id: worker.worker_id },
        { type: 'task', id: referencedTask.task_id },
      ],
    },
  });
  assert.equal(sent.response.status, 202);
  const execution = await waitFor(() => driver.executions.find((item) => item.kind === 'worker_chat'));
  const sourceKey = `chat-reply:${sent.payload.user.message_id}`;
  const pending = await waitFor(async () => {
    const { payload } = await context.admin('/api/v1/coordinator/chat');
    const message = payload.messages.find((item) => item.source_key === sourceKey);
    return message?.speaker?.type === 'worker' && message.status === 'pending' ? message : null;
  });
  assert.equal(pending.speaker.name, 'worker-test');
  assert.equal(pending.command_id, execution.command_id);
  const live = await context.admin(`/api/v1/workers/${worker.worker_id}`);
  assert.equal(live.payload.worker.activity.phase, 'chatting');
  assert.equal(live.payload.worker.activity.task_title, '直接对话');
  context.hub.coordinator.onCommandFinished(context.hub.store.getCommand(sent.payload.message.command_id));
  assert.equal(driver.executions.filter((item) => item.kind === 'worker_chat').length, 1);
  releaseWorkerChat();
  const reply = await directChatReply(context, sent.payload.user.message_id);
  assert.equal(reply.status, 'done');
  assert.equal(reply.content, '这是 worker-test 本人的真实回答。');
  assert.doesNotMatch(reply.content, /中央代答/);
  assert.equal(reply.speaker.type, 'worker');
  assert.equal(reply.speaker.worker_id, worker.worker_id);
  assert.equal(reply.task_id, null);
  assert.match(execution.input, /@worker-test 你能做啥/);
  assert.match(execution.input, /DIRECT_CHAT_REFERENCE_CONTEXT/);
  assert.deepEqual(driver.executions.map((item) => item.kind), ['coordinator_chat', 'worker_chat']);
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 1);
  assert.equal((await context.admin('/api/v1/orchestrations')).payload.orchestrations.length, 0);
  const idle = await context.admin(`/api/v1/workers/${worker.worker_id}`);
  assert.equal(idle.payload.worker.activity.phase, 'idle');
  assert.equal(idle.payload.worker.activity.recent_result, '这是 worker-test 本人的真实回答。');
  const updated = dashboard.messages.find((message) => (
    message.type === 'chat.updated'
    && message.payload.message.message_id === reply.message_id
    && message.payload.message.status === 'done'
  ));
  assert.equal(updated.payload.message.speaker.name, 'worker-test');
  const callCount = driver.executions.length;
  await context.restartHub();
  assert.equal(driver.executions.length, callCount);
  await context.hub.coordinator.resume();
  assert.equal(driver.executions.length, callCount);
  const restored = await directChatReply(context, sent.payload.user.message_id);
  assert.equal(restored.content, reply.content);
  assert.equal(restored.speaker.worker_id, worker.worker_id);
});

test('Direct Worker chat reports execution failure and unknown outcomes without central substitutes', async (t) => {
  const { context, driver, worker } = await setup(t);
  driver.chat = JSON.stringify({ reply: '中央代答不应出现', action: { type: 'chat' } });
  driver.failWorkerChat = true;
  const mentions = [{ type: 'worker', id: worker.worker_id }];
  const failed = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: { message: '@worker-test 请回答', request_id: 'direct-worker-failure', mentions },
  });
  const failureReply = await directChatReply(context, failed.payload.user.message_id);
  assert.equal(failureReply.status, 'failed');
  assert.match(failureReply.content, /worker reply failed/);
  assert.doesNotMatch(failureReply.content, /中央代答/);

  driver.failWorkerChat = false;
  driver.work = () => '这个内容不能作为已知结果展示';
  let releaseWorkerChat;
  driver.workerChatGate = new Promise((resolve) => { releaseWorkerChat = resolve; });
  const unknown = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: { message: '@worker-test 再回答一次', request_id: 'direct-worker-unknown', mentions },
  });
  await waitFor(() => driver.executions.filter((item) => item.kind === 'worker_chat').length === 2);
  const execution = driver.executions.at(-1);
  const command = context.hub.store.finishCommand(execution.command_id, context.connector.connectorId, {
    status: 'succeeded',
    result: { text: '这个内容不能作为已知结果展示' },
    outcomeUnknown: true,
  });
  context.hub.coordinator.onCommandFinished(command);
  releaseWorkerChat();
  const unknownReply = await directChatReply(context, unknown.payload.user.message_id);
  assert.equal(unknownReply.status, 'failed');
  assert.match(unknownReply.content, /回复结果无法确认/);
  assert.doesNotMatch(unknownReply.content, /这个内容不能作为已知结果展示|中央代答/);
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 0);
  assert.equal((await context.admin('/api/v1/orchestrations')).payload.orchestrations.length, 0);
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
  assert.ok(activities.some((message) => message.content.includes('已完成') && message.content.includes('2 项交付结果')));
  assert.ok(activities.every((message) => !message.content.includes('"worker_id"')));
  assert.ok(activities.every((message) => !message.content.includes('completed:worker-test')));
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

test('An @Worker mention constrains planning and survives restart without rerouting', async (t) => {
  const { context, driver, worker } = await setup(t);
  const other = await context.registerWorker({ name: 'other-worker', runtime_session_id: 'other-mentioned-worker' });
  driver.chat = JSON.stringify({
    reply: '交给你指定的员工。',
    action: {
      type: 'orchestrate',
      task: {
        title: 'Mentioned Worker assignment', goal: 'Only the selected Worker executes',
        context: 'Browser supplied a structured mention', acceptance: ['Selected Worker returns evidence'],
      },
    },
  });
  driver.plan = JSON.stringify({
    summary: 'Use the explicitly selected Worker',
    steps: [{
      key: 'assigned', title: 'Assigned work', goal: 'Return evidence', context: '',
      acceptance: ['Evidence returned'], worker_id: worker.worker_id, depends_on: [], rationale: 'Explicitly mentioned',
    }],
  });
  driver.review = JSON.stringify({
    parent_pass: true, reason: 'Mentioned assignment passes',
    steps: [{ key: 'assigned', pass: true, reason: 'Evidence is present' }],
  });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: {
      message: '@worker-test 请完成这项工作', request_id: 'mention-worker',
      mentions: [{ type: 'worker', id: worker.worker_id }, { type: 'worker', id: worker.worker_id }],
    },
  });
  assert.equal(sent.response.status, 202);
  assert.deepEqual(sent.payload.user.mentions, [{ type: 'worker', id: worker.worker_id }]);
  const created = await waitFor(async () => {
    const { payload } = await context.admin('/api/v1/orchestrations');
    return payload.orchestrations.find((item) => item.source_message_id === sent.payload.message.message_id) ?? null;
  });
  const completed = await waitForOrchestration(context, created.orchestration_id, 'done');
  assert.equal(completed.steps.length, 1);
  assert.equal(completed.steps[0].worker_id, worker.worker_id);
  assert.deepEqual(driver.executions.filter((item) => item.kind === 'prompt').map((item) => item.worker), ['worker-test']);
  const planning = driver.executions.find((item) => item.kind === 'coordinator_plan');
  assert.match(planning.input, new RegExp(worker.worker_id));
  assert.doesNotMatch(planning.input, new RegExp(other.worker_id));
  const callCount = driver.executions.length;
  await context.restartHub();
  assert.equal(driver.executions.length, callCount);
  const restored = context.hub.store.getChatMessage(sent.payload.user.message_id);
  assert.deepEqual(restored.mentions, [{ type: 'worker', id: worker.worker_id }]);
  await context.hub.coordinator.resume();
  assert.equal(driver.executions.length, callCount);
});

test('A plan that ignores an @Worker mention is blocked before dispatch', async (t) => {
  const { context, driver, worker } = await setup(t);
  const other = await context.registerWorker({ name: 'wrong-worker', runtime_session_id: 'wrong-target' });
  driver.chat = JSON.stringify({
    reply: '按指定员工安排。',
    action: {
      type: 'orchestrate',
      task: { title: 'Reject rerouting', goal: 'Do not use another Worker', context: '', acceptance: ['No rerouting'] },
    },
  });
  driver.plan = JSON.stringify({
    summary: 'Invalid rerouting attempt',
    steps: [{
      key: 'wrong', title: 'Wrong target', goal: 'Must not run', context: '', acceptance: ['Never runs'],
      worker_id: other.worker_id, depends_on: [], rationale: 'Deliberately wrong',
    }],
  });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: { message: '@worker-test 只能交给你', mentions: [{ type: 'worker', id: worker.worker_id }] },
  });
  const created = await waitFor(async () => {
    const { payload } = await context.admin('/api/v1/orchestrations');
    return payload.orchestrations.find((item) => item.source_message_id === sent.payload.message.message_id) ?? null;
  });
  const blocked = await waitForOrchestration(context, created.orchestration_id, 'blocked');
  assert.equal(blocked.error.code, 'coordinator_plan_invalid');
  assert.match(blocked.error.message, /unavailable Worker/);
  assert.equal(blocked.steps.length, 0);
  assert.equal(driver.executions.filter((item) => item.kind === 'prompt').length, 0);
});

test('@Task supplies real context and invalid or manual Worker mentions are rejected', async (t) => {
  const { context, driver, coordinator, worker } = await setup(t);
  const referenced = await context.admin('/api/v1/tasks', {
    method: 'POST',
    body: {
      title: 'Referenced existing task', goal: 'CONTEXT_ONLY_FROM_THE_REFERENCED_TASK',
      context: 'Known historical context', acceptance: ['Existing acceptance'], assignee_worker_id: worker.worker_id,
    },
  });
  const task = referenced.payload.task;
  driver.chat = JSON.stringify({ reply: '我只读取引用，没有启动或新建任务。', action: { type: 'chat' } });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: { message: '看一下 @Referenced existing task 的验收', mentions: [{ type: 'task', id: task.task_id }] },
  });
  const reply = await chatReply(context, sent.payload.message.command_id);
  assert.equal(reply.status, 'done');
  const execution = driver.executions.find((item) => item.command_id === sent.payload.message.command_id);
  assert.match(execution.input, /CONTEXT_ONLY_FROM_THE_REFERENCED_TASK/);
  assert.match(execution.input, new RegExp(task.task_id));
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 1);
  assert.equal(driver.executions.filter((item) => item.kind !== 'coordinator_chat').length, 0);

  const external = await context.registerWorker({ name: 'manual-worker', mode: 'external', runtime_session_id: 'manual-target' });
  for (const [mentions, status] of [
    [[{ type: 'worker', id: 'worker_missing' }], 404],
    [[{ type: 'task', id: 'task_missing' }], 404],
    [[{ type: 'worker', id: external.worker_id }], 409],
    [[{ type: 'worker', id: coordinator.worker_id }], 409],
    [[{ type: 'unknown', id: task.task_id }], 400],
  ]) {
    const rejected = await context.admin('/api/v1/coordinator/chat', {
      method: 'POST', body: { message: 'Invalid mention', mentions },
    });
    assert.equal(rejected.response.status, status);
  }
  assert.equal((await context.admin('/api/v1/coordinator/chat')).payload.messages.length, 2);
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 1);
});

test('Clearing conversation preserves plans and starts a new visible epoch', async (t) => {
  const { context, driver, worker } = await setup(t);
  const dashboard = await context.openDashboard();
  driver.chat = JSON.stringify({
    reply: '先保存计划。',
    action: {
      type: 'plan',
      task: {
        title: 'Conversation clear preserves plan', goal: 'Start after clearing chat',
        context: 'Keep orchestration and mentions', acceptance: ['Plan survives', 'Worker constraint survives'],
      },
    },
  });
  const sent = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: {
      message: '@worker-test 先规划', request_id: 'clear-chat-plan',
      mentions: [{ type: 'worker', id: worker.worker_id }],
    },
  });
  const plannedReply = await chatReply(context, sent.payload.message.command_id);
  const planned = await waitFor(async () => {
    const { payload } = await context.admin('/api/v1/orchestrations');
    return payload.orchestrations.find((item) => item.source_message_id === plannedReply.message_id && item.status === 'ready');
  });
  const internalCount = context.hub.store.listChatMessages().length;
  const unauthorized = await fetch(`${context.hub.url}/api/v1/coordinator/chat`, { method: 'DELETE' });
  assert.equal(unauthorized.status, 401);
  assert.equal((await context.local('/local/v1/coordinator/chat')).response.status, 404);
  const cleared = await context.admin('/api/v1/coordinator/chat', { method: 'DELETE' });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.payload.epoch, 1);
  const visible = await context.admin('/api/v1/coordinator/chat');
  assert.deepEqual(visible.payload.messages, []);
  assert.equal(visible.payload.epoch, 1);
  assert.equal(context.hub.store.listChatMessages().length, internalCount);
  assert.equal((await context.admin('/api/v1/tasks')).payload.tasks.length, 3);
  assert.equal(context.hub.store.getOrchestration(planned.orchestration_id).status, 'ready');
  assert.deepEqual(context.hub.coordinator.orchestrationWorkerIds(planned), [worker.worker_id]);
  await waitFor(() => dashboard.messages.some((message) => message.type === 'chat.cleared' && message.payload.epoch === 1));

  driver.chat = JSON.stringify({
    reply: '按原计划启动。',
    action: { type: 'start', orchestration_id: planned.orchestration_id },
  });
  const started = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '开始执行', request_id: 'after-clear-start' },
  });
  const completed = await waitForOrchestration(context, planned.orchestration_id, 'done');
  assert.equal(completed.parent_task.status, 'done');
  assert.ok(completed.steps.every((step) => step.worker_id === worker.worker_id));
  await chatReply(context, started.payload.message.command_id);
  const next = await context.admin('/api/v1/coordinator/chat');
  assert.equal(next.payload.epoch, 1);
  assert.ok(next.payload.messages.length > 0);
  assert.ok(next.payload.messages.every((message) => message.conversation_epoch === 1));
  assert.ok(next.payload.messages.every((message) => message.request_id !== 'clear-chat-plan'));
  assert.equal(context.hub.store.listChatMessages().length > internalCount, true);
});

test('Long dependency evidence is bounded and explicitly marked as truncated', async (t) => {
  const { context, driver } = await setup(t);
  driver.work = ({ command }) => command.input.includes('Complete first step')
    ? `DEPENDENCY_BEGIN:${'上'.repeat(65000)}:DEPENDENCY_END`
    : 'SECOND_RESULT_OK';
  const created = await createWithCli(context);
  const completed = await waitForOrchestration(context, created.orchestration.orchestration_id, 'done');
  assert.equal(completed.parent_task.status, 'done');
  const work = driver.executions.filter((execution) => execution.kind === 'prompt');
  const dependencyJson = work[1].input.split('已完成依赖步骤的真实结果 JSON:\n')[1].split('\n\n对话中引用的历史任务')[0];
  const [dependency] = JSON.parse(dependencyJson);
  assert.equal(dependency.result.length, 64000);
  assert.equal(dependency.result_truncated, true);
  assert.equal(dependency.result.startsWith('DEPENDENCY_BEGIN:'), true);
  assert.equal(dependency.result.includes('DEPENDENCY_END'), false);
  assert.match(driver.executions.find((execution) => execution.kind === 'coordinator_review').input, /"result_truncated": true/);
  const messages = (await context.admin('/api/v1/coordinator/chat')).payload.messages;
  assert.ok(messages.filter((message) => message.role === 'activity').every((message) => !message.content.includes('DEPENDENCY_BEGIN')));
});

test('Follow-up work receives the complete referenced deliverable without rerunning the old task', async (t) => {
  const { context, driver, worker } = await setup(t);
  driver.plan = JSON.stringify({
    summary: 'One deliverable step',
    steps: [{
      key: 'only', title: 'Produce deliverable', goal: 'Use the supplied source material', context: '',
      acceptance: ['Return a complete result'], worker_id: worker.worker_id, depends_on: [], rationale: 'Suitable Worker',
    }],
  });
  driver.review = JSON.stringify({
    parent_pass: true, reason: 'Evidence passes',
    steps: [{ key: 'only', pass: true, reason: 'Complete result returned' }],
  });
  const artifact = `HISTORICAL_RESULT_${'完整交付'.repeat(400)}_END`;
  driver.work = () => artifact;
  const action = (title) => JSON.stringify({
    reply: '已安排',
    action: { type: 'orchestrate', task: { title, goal: 'Continue with real evidence', context: '', acceptance: ['Use the complete result'] } },
  });
  driver.chat = action('Original deliverable');
  const original = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST', body: { message: '创建原始交付', request_id: 'reference-original' },
  });
  const originalReply = await chatReply(context, original.payload.message.command_id);
  const first = await waitForOrchestration(context, context.hub.store.getOrchestrationByTask(originalReply.task_id).orchestration_id, 'done');
  const originalCommandId = first.steps[0].command_id;

  driver.chat = action('Follow-up deliverable');
  const followUp = await context.admin('/api/v1/coordinator/chat', {
    method: 'POST',
    body: {
      message: '基于旧任务继续完成修订', request_id: 'reference-follow-up',
      mentions: [{ type: 'task', id: first.parent_task_id }],
    },
  });
  const followUpReply = await chatReply(context, followUp.payload.message.command_id);
  await waitForOrchestration(context, context.hub.store.getOrchestrationByTask(followUpReply.task_id).orchestration_id, 'done');
  const work = driver.executions.filter((execution) => execution.kind === 'prompt');
  assert.equal(work.length, 2);
  const referenceJson = work[1].input.split('对话中引用的历史任务 JSON（作为上下文，不代表重启旧任务）:\n')[1];
  const [reference] = JSON.parse(referenceJson);
  assert.equal(reference.orchestration.steps[0].result, artifact);
  assert.equal(reference.orchestration.steps[0].result_truncated, false);
  assert.ok(artifact.length > 600);
  const preserved = context.hub.store.getOrchestration(first.orchestration_id);
  assert.equal(preserved.status, 'done');
  assert.equal(preserved.steps[0].command_id, originalCommandId);
});
