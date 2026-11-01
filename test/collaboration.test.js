import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, waitFor } from './helpers.js';

// One scripted driver for every Session: per-kind answers and optional gates.
function scriptedDriver() {
  const driver = {
    executions: [],
    gates: new Map(),
    answers: {},
    async execute({ worker, command, onState }) {
      driver.executions.push({ worker: worker.name, kind: command.kind, input: command.input, command_id: command.command_id });
      await onState({ started: true });
      const gate = driver.gates.get(command.kind);
      if (gate) await gate.promise;
      const answer = driver.answers[command.kind];
      const value = typeof answer === 'function' ? await answer({ worker, command }) : answer ?? `completed:${worker.name}`;
      return typeof value === 'string' ? { text: value, session_id: worker.runtime_session_id } : { session_id: worker.runtime_session_id, ...value };
    },
    gate(kind) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      driver.gates.set(kind, { promise });
      return () => { driver.gates.delete(kind); release(); };
    },
    async close() {},
  };
  return driver;
}

async function setup(t) {
  const context = await createTestContext(t);
  const driver = scriptedDriver();
  context.driver = driver;
  const coordinator = await context.registerWorker({ name: 'coordinator' });
  const worker = await context.registerWorker({ name: 'qa-worker' });
  const configured = await context.admin('/api/v1/coordinator', { method: 'PUT', body: { worker_id: coordinator.worker_id, enabled: true } });
  assert.equal(configured.response.status, 200);
  return { context, driver, coordinator, worker };
}

async function sendChat(context, body) {
  const sent = await context.admin('/api/v1/coordinator/chat', { method: 'POST', body });
  assert.equal(sent.response.status, 202, JSON.stringify(sent.payload));
  return sent.payload;
}

async function settled(context, messageId) {
  return waitFor(() => {
    const message = context.hub.store.getChatMessage(messageId);
    return message && message.status !== 'pending' ? message : null;
  });
}

const kinds = (driver) => driver.executions.map((item) => item.kind);
const events = (context, type) => context.hub.store.listEvents().filter((event) => event.event_type === type);

test('A single @Worker question goes straight to the Worker without a coordinator call', async (t) => {
  const { context, driver, worker } = await setup(t);
  driver.answers.worker_chat = '今天跑了 12 个用例，全部通过。';
  const sent = await sendChat(context, { message: '@qa-worker 今天测得怎么样？', mentions: [{ type: 'worker', id: worker.worker_id }] });
  const reply = await settled(context, sent.message.message_id);
  assert.equal(reply.content, '今天跑了 12 个用例，全部通过。');
  assert.deepEqual(kinds(driver), ['worker_chat']);
  assert.equal(events(context, 'coordinator.chat.fast_path').length, 1);
  assert.match(driver.executions[0].input, /HANDBACK:/);
});

test('An @Task follow-up reaches the live Task assignee directly; new work is handed back', async (t) => {
  const { context, driver, worker } = await setup(t);
  const { payload } = await context.admin('/api/v1/tasks', {
    method: 'POST', body: { title: 'Retest relay timezone', goal: 'Verify F1 fix', acceptance: ['F1 passes'], assignee_worker_id: worker.worker_id },
  });
  const task = payload.task;
  driver.answers.worker_chat = 'F1 已在 staging 复测通过。';
  const first = await sendChat(context, { message: '@Retest relay timezone 进度？', mentions: [{ type: 'task', id: task.task_id }] });
  assert.equal((await settled(context, first.message.message_id)).content, 'F1 已在 staging 复测通过。');
  assert.match(driver.executions[0].input, /你是任务 #\d{4} · Retest relay timezone 的负责人/);
  assert.deepEqual(kinds(driver), ['worker_chat']);

  driver.answers.worker_chat = 'HANDBACK: 这是另一个项目的新测试';
  driver.answers.coordinator_chat = JSON.stringify({ reply: '这是新工作，我先记下。', action: { type: 'chat' } });
  const second = await sendChat(context, { message: '@Retest relay timezone 顺便把支付也测一遍', mentions: [{ type: 'task', id: task.task_id }] });
  const handed = await settled(context, second.message.message_id);
  assert.equal(handed.content, '这是新工作，我先记下。');
  assert.equal(handed.handback_reason, '这是另一个项目的新测试');
  assert.deepEqual(kinds(driver), ['worker_chat', 'worker_chat', 'coordinator_chat']);
  assert.match(driver.executions[2].input, /员工把它交回中央大脑/);

  // A task that is done, or a message that names two things, takes the slow path.
  await context.admin(`/api/v1/tasks/${task.task_id}`, { method: 'PATCH', body: { status: 'done' } });
  driver.answers.coordinator_chat = JSON.stringify({ reply: '这个任务已经完成。', action: { type: 'chat' } });
  const third = await sendChat(context, { message: '@Retest relay timezone 结论？', mentions: [{ type: 'task', id: task.task_id }] });
  await settled(context, third.message.message_id);
  assert.equal(kinds(driver).at(-1), 'coordinator_chat');
});

test('Messages that arrive while the coordinator is busy are merged into one call', async (t) => {
  const { context, driver } = await setup(t);
  const release = driver.gate('coordinator_chat');
  driver.answers.coordinator_chat = ({ command }) => {
    if (!command.input.includes('"replies"')) return JSON.stringify({ reply: '第一条已回答', action: { type: 'chat' } });
    const ids = [...command.input.matchAll(/"message_id": "(chat_[^"]+)"/g)].map((match) => match[1]);
    // The second queued message is deliberately left out of the answer.
    return JSON.stringify({ replies: [{ message_id: ids[0], reply: '第二条已回答', action: { type: 'chat' } }] });
  };
  const first = await sendChat(context, { message: '第一条' });
  await waitFor(() => driver.executions.length === 1);
  const second = await sendChat(context, { message: '第二条' });
  const third = await sendChat(context, { message: '第三条' });
  assert.equal(context.hub.store.getChatMessage(second.message.message_id).queued, true);
  assert.match(second.message.content, /已排队/);
  release();
  assert.equal((await settled(context, first.message.message_id)).content, '第一条已回答');
  assert.equal((await settled(context, second.message.message_id)).content, '第二条已回答');
  const missing = await settled(context, third.message.message_id);
  assert.equal(missing.status, 'failed', 'a missing item fails alone');
  assert.deepEqual(kinds(driver), ['coordinator_chat', 'coordinator_chat']);
  const batched = events(context, 'coordinator.chat.batched');
  assert.equal(batched.length, 1);
  assert.equal(batched[0].payload.message_ids.length, 2);
  assert.match(driver.executions[1].input, /排队了 2 条消息/);
  assert.match(driver.executions[1].input, /第二条/);
  assert.match(driver.executions[1].input, /第三条/);
});

test('A report that needs a person becomes one Attention and the answer resumes the same Worker', async (t) => {
  const { context, driver, worker } = await setup(t);
  const { payload } = await context.admin('/api/v1/tasks', {
    method: 'POST', body: { title: 'Prod 补查', goal: 'Check prod data', acceptance: ['Numbers reported'], assignee_worker_id: worker.worker_id },
  });
  const task = payload.task;
  driver.answers.prompt = { text: '需要先确认口径', outcome: 'needs_input', question: '按北京时间还是 UTC 统计？' };
  const created = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, task_id: task.task_id, input: '统计昨天的静默写入' } });
  const attention = await waitFor(() => context.hub.store.listAttentions()[0]);
  assert.equal(attention.command_id, created.payload.command.command_id);
  assert.equal(attention.question, '按北京时间还是 UTC 统计？');
  assert.equal(context.hub.store.getTask(task.task_id).status, 'blocked');
  const listed = await context.admin('/api/v1/attentions');
  assert.equal(listed.payload.attentions[0].task_title, 'Prod 补查');

  driver.answers.prompt = '按北京时间统计：6 次。';
  const answered = await context.admin(`/api/v1/attentions/${attention.attention_id}/answer`, { method: 'POST', body: { answer: '北京时间' } });
  assert.equal(answered.response.status, 200);
  assert.equal(answered.payload.attention.status, 'answered');
  const followUp = await waitFor(() => driver.executions.find((item) => item.input.includes('回答：北京时间')));
  assert.match(followUp.input, /按北京时间还是 UTC 统计？/);
  assert.match(followUp.input, new RegExp(`agent-hub command result ${attention.command_id}`));
  const again = await context.admin(`/api/v1/attentions/${attention.attention_id}/answer`, { method: 'POST', body: { answer: 'UTC' } });
  assert.equal(again.response.status, 409);
  assert.equal((await context.admin('/api/v1/attentions')).payload.attentions.length, 0);
});

test('An orchestration step that needs input blocks with an Attention and resumes after the answer', async (t) => {
  const { context, driver, worker } = await setup(t);
  driver.answers.coordinator_plan = JSON.stringify({
    summary: 'One step',
    steps: [{ key: 'only', title: 'Draft reply', goal: 'Draft the group reply', context: '', acceptance: ['Draft returned'], worker_id: worker.worker_id, depends_on: [], rationale: 'QA' }],
  });
  driver.answers.coordinator_review = JSON.stringify({ parent_pass: true, reason: 'ok', steps: [{ key: 'only', pass: true, reason: 'ok' }] });
  let asked = false;
  driver.answers.prompt = ({ command }) => {
    if (!asked) {
      asked = true;
      return { text: '没有业主确认无法下结论', outcome: 'needs_input', question: '这个算不算 bug？' };
    }
    assert.match(command.input, /"answers": \[/);
    assert.match(command.input, /算，按高优先级记/);
    return '草稿：已按高优先级记录。';
  };
  const created = await context.admin('/api/v1/tasks', {
    method: 'POST', body: { title: 'Group reply', goal: 'Reply to the group', acceptance: ['Reply drafted'], orchestrate: true },
  });
  const orchestrationId = created.payload.orchestration.orchestration_id;
  const attention = await waitFor(() => context.hub.store.listAttentions()[0]);
  assert.equal(attention.step_key, 'only');
  const blocked = context.hub.store.getOrchestration(orchestrationId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error.code, 'coordinator_step_needs_input');
  await context.admin(`/api/v1/attentions/${attention.attention_id}/answer`, { method: 'POST', body: { answer: '算，按高优先级记' } });
  const done = await waitFor(() => context.hub.store.getOrchestration(orchestrationId).status === 'done' && context.hub.store.getOrchestration(orchestrationId));
  assert.equal(done.steps[0].answers[0].question, '这个算不算 bug？');
});

test('Triggers on an external thread create one Task, route follow-ups to its assignee, and are idempotent', async (t) => {
  const { context, driver, worker } = await setup(t);
  const trigger = (body) => context.local('/local/v1/triggers', { method: 'POST', body: { source: 'feishu', thread_key: 'feishu:omt_1', ...body } });
  const first = await trigger({ trigger_key: 'feishu:om_1', text: '登录页报错了', worker_id: worker.worker_id, title: '群里 @QA：登录页报错' });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.routed, 'created');
  assert.equal(first.payload.task.thread_key, 'feishu:omt_1');
  const duplicate = await trigger({ trigger_key: 'feishu:om_1', text: '登录页报错了', worker_id: worker.worker_id });
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(context.hub.store.listTasks().length, 1);

  const followup = await trigger({ trigger_key: 'feishu:om_2', text: '补充：只在 Safari 上', actor: '郑乐乐', followup_only: true });
  assert.equal(followup.payload.routed, 'followup');
  const delivered = await waitFor(() => driver.executions.find((item) => item.input.includes('只在 Safari 上')));
  assert.equal(delivered.worker, 'qa-worker');
  assert.match(delivered.input, /没有经过中央大脑/);
  assert.ok(!kinds(driver).includes('coordinator_chat'));

  // A question from the Worker is answered by the next message in the thread.
  driver.answers.prompt = { text: '需要复现信息', outcome: 'needs_input', question: '是哪个账号？' };
  await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, task_id: first.payload.task.task_id, input: '继续查' } });
  await waitFor(() => context.hub.store.listAttentions().length === 1);
  driver.answers.prompt = 'ok';
  const answer = await trigger({ trigger_key: 'feishu:om_3', text: '测试号 13800000000', actor: '郑乐乐', followup_only: true });
  assert.equal(answer.payload.routed, 'answered');
  assert.equal(context.hub.store.listAttentions().length, 0);
  await waitFor(() => driver.executions.find((item) => item.input.includes('回答：郑乐乐：测试号 13800000000')));

  await context.admin(`/api/v1/tasks/${first.payload.task.task_id}`, { method: 'PATCH', body: { status: 'done' } });
  const late = await trigger({ trigger_key: 'feishu:om_4', text: '谢谢', followup_only: true });
  assert.equal(late.payload.routed, 'ignored', 'an ended Task no longer subscribes to the thread');
  const foreign = await trigger({ trigger_key: 'feishu:om_5', thread_key: 'feishu:omt_2', text: 'x', worker_id: 'worker_missing' });
  assert.equal(foreign.response.status, 403);
});
