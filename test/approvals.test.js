import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, waitFor } from './helpers.js';
import { approvalAction, reportOutcome } from '../src/connector.js';

// A seat that answers with a scripted result per Session name.
function seatDriver() {
  const driver = {
    executions: [],
    answers: {},
    async execute({ worker, command, onState }) {
      driver.executions.push({ worker: worker.name, input: command.input, command_id: command.command_id });
      await onState({ started: true });
      const answer = driver.answers[worker.name];
      const value = typeof answer === 'function' ? answer(command) : answer ?? `done:${worker.name}`;
      return typeof value === 'string' ? { text: value, session_id: worker.runtime_session_id } : { session_id: worker.runtime_session_id, ...value };
    },
    of(name) {
      return driver.executions.filter((item) => item.worker === name)
        .map((item) => ({ ...item, input: driver.store?.getCommand(item.command_id)?.input ?? item.input }));
    },
    async close() {},
  };
  return driver;
}

const DRAFT = { channel: 'feishu', kind: 'reply', target: 'om_123', text: '查过了，是缓存问题，已修。', key: 'qa-reply-cache-1101', note: '回 Anya：缓存问题' };

async function setup(t) {
  const context = await createTestContext(t, { hub: { watchdogIntervalMs: 60 * 60 * 1000 } });
  const driver = seatDriver();
  driver.store = context.hub.store;
  context.driver = driver;
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA', takeover_after_ms: 0 } });
  return { context, driver };
}

const trigger = (context, body) => context.admin('/api/v1/triggers', { method: 'POST', body: { source: 'feishu', ...body } });
const finished = (context, commandId) => waitFor(() => {
  const command = context.hub.store.getCommand(commandId);
  return ['succeeded', 'failed'].includes(command?.status) ? command : null;
});
const openAttention = (context, taskId) => waitFor(() => context.hub.store.openAttentionForTask(taskId));

// Drives one Role task up to the point where its seat asks for approval.
async function draftForApproval(context, driver, { seat = 'qa-a' } = {}) {
  driver.answers[seat] = { text: '草稿写好了', outcome: 'needs_approval', question: '回 Anya 的草稿', action: DRAFT };
  const worker = await context.registerWorker({ name: seat, role: 'qa' });
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '为什么搜索不到我的帖子？', title: '搜索问题' });
  assert.equal(payload.routed, 'created');
  await finished(context, payload.command_id);
  const attention = await openAttention(context, payload.task.task_id);
  driver.answers[seat] = `done:${seat}`;
  return { worker, task: payload.task, attention };
}

test('reportOutcome validates needs_approval and its action', () => {
  assert.throws(() => reportOutcome({ outcome: 'needs_approval' }), /action is required/);
  assert.throws(() => reportOutcome({ outcome: 'needs_approval', action: { ...DRAFT, text: '' } }), /action.text is required/);
  assert.throws(() => approvalAction({ ...DRAFT, channel: 'Feishu Chat' }), /action.channel must be/);
  const result = reportOutcome({ outcome: 'needs_approval', action: { ...DRAFT, key: '  k1 ' } });
  assert.equal(result.outcome, 'needs_approval');
  assert.equal(result.action.key, 'k1');
  assert.equal(result.question, DRAFT.note, 'the note stands in for the question');
  assert.deepEqual(reportOutcome({ outcome: 'done', action: DRAFT }), { outcome: 'done' }, 'action is ignored for other outcomes');
});

test('An Admin source can deliver triggers without a Connector', async (t) => {
  const { context } = await setup(t);
  const first = await trigger(context, { trigger_key: 'b1', thread_key: 'feishu:t9', role: 'qa', text: '看板上有几条待验证？', title: '看板' });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.routed, 'created');
  assert.equal(first.payload.waiting_for_seat, true);
  assert.equal(first.payload.seats_busy, false);
  const again = await trigger(context, { trigger_key: 'b1', thread_key: 'feishu:t9', role: 'qa', text: '看板上有几条待验证？' });
  assert.equal(again.payload.duplicate, true);
  const event = context.hub.store.listEvents().find((item) => item.event_type === 'task.created');
  assert.deepEqual({ type: event.actor_type, id: event.actor_id }, { type: 'source', id: 'feishu' });
  const missing = await trigger(context, { trigger_key: 'b2', thread_key: 'feishu:t10', worker_id: 'wrk_nope', text: 'x' });
  assert.equal(missing.response.status, 404);
});

test('A needs_approval report becomes an approval Attention that only the owner can resolve', async (t) => {
  const { context, driver } = await setup(t);
  const { task, attention } = await draftForApproval(context, driver);
  assert.equal(attention.outcome, 'needs_approval');
  assert.deepEqual(attention.action, DRAFT);
  assert.equal(attention.question, '回 Anya 的草稿');
  assert.equal(context.hub.store.getTask(task.task_id).status, 'blocked');

  // A colleague writing in the thread is a follow-up, never the approval.
  const followup = await trigger(context, { trigger_key: 'm2', thread_key: 'feishu:t1', actor: '同事', text: '谢谢，顺便问下是哪天修的？', followup_only: true });
  assert.equal(followup.payload.routed, 'followup');
  assert.equal(context.hub.store.getAttention(attention.attention_id).status, 'open');
  await finished(context, followup.payload.command_id);
  assert.match(driver.of('qa-a').at(-1).input, /【跟进】/);

  const wrong = await context.admin(`/api/v1/attentions/${attention.attention_id}/execution`, { method: 'POST', body: { status: 'executed' } });
  assert.equal(wrong.response.status, 409, 'cannot execute before approval');
});

test('Approval goes to the channel bridge, execution comes back to the seat', async (t) => {
  const { context, driver } = await setup(t);
  const { task, attention } = await draftForApproval(context, driver);

  const approved = await context.admin(`/api/v1/attentions/${attention.attention_id}/approve`, { method: 'POST', body: { by: '黄海斌' } });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.payload.attention.status, 'approved');
  assert.equal(approved.payload.attention.decided_by, '黄海斌');
  const approvedEvent = context.hub.store.listEvents().find((event) => event.event_type === 'attention.approved');
  assert.deepEqual(approvedEvent.payload.action, DRAFT, 'the bridge reads the action from the event');
  assert.equal(driver.of('qa-a').length, 1, 'approval alone sends nothing to the seat');
  const twice = await context.admin(`/api/v1/attentions/${attention.attention_id}/approve`, { method: 'POST', body: {} });
  assert.equal(twice.response.status, 409);

  const executed = await context.admin(`/api/v1/attentions/${attention.attention_id}/execution`, {
    method: 'POST', body: { status: 'executed', result: { message_id: 'om_sent_1' }, by: 'bridge:feishu' },
  });
  assert.equal(executed.response.status, 200);
  assert.equal(executed.payload.attention.status, 'executed');
  assert.equal(executed.payload.attention.execution.message_id, 'om_sent_1');
  const notice = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(notice.input, /已获批准并发出/);
  assert.match(notice.input, /om_sent_1/);
  assert.match(notice.input, /不要再发一遍/);
  await finished(context, notice.command_id);
  assert.equal(context.hub.store.openAttentionForTask(task.task_id), null);
});

test('Feedback instead of approval goes back to the seat as a revision request', async (t) => {
  const { context, driver } = await setup(t);
  const { attention } = await draftForApproval(context, driver);
  const answered = await context.admin(`/api/v1/attentions/${attention.attention_id}/answer`, { method: 'POST', body: { answer: '太长了，两句话说完', by: '黄海斌' } });
  assert.equal(answered.response.status, 200);
  assert.equal(answered.payload.attention.status, 'answered');
  const revise = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(revise.input, /没有被批准/);
  assert.match(revise.input, /太长了，两句话说完/);
  assert.match(revise.input, /什么都没有发出去/);
});

test('A failed execution tells the seat nothing went out', async (t) => {
  const { context, driver } = await setup(t);
  const { attention } = await draftForApproval(context, driver);
  await context.admin(`/api/v1/attentions/${attention.attention_id}/approve`, { method: 'POST', body: {} });
  const failed = await context.admin(`/api/v1/attentions/${attention.attention_id}/execution`, { method: 'POST', body: { status: 'failed', error: 'feishu 99991663 token expired' } });
  assert.equal(failed.payload.attention.status, 'failed');
  const notice = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(notice.input, /渠道发送失败：feishu 99991663/);
  assert.match(notice.input, /什么都没有发出去/);
});

test('A seat that takes over sees the pending approval in its handoff package and does not resubmit', async (t) => {
  const { context, driver } = await setup(t);
  const { worker, task, attention } = await draftForApproval(context, driver);
  await context.admin(`/api/v1/attentions/${attention.attention_id}/approve`, { method: 'POST', body: {} });
  await context.detachWorker(worker);
  await context.registerWorker({ name: 'qa-b', role: 'qa', runtime_session_id: 'other-window' });
  const followup = await trigger(context, { trigger_key: 'm3', thread_key: 'feishu:t1', actor: '同事', text: '还有个补充', followup_only: true });
  assert.equal(followup.payload.routed, 'followup');
  const handed = await waitFor(() => driver.of('qa-b')[0]);
  assert.match(handed.input, /【交接】/);
  assert.match(handed.input, /前任已提交待审批的对外内容（已批准，渠道正在发出/);
  assert.match(handed.input, /不要再提交一遍/);
  assert.equal(context.hub.store.getTask(task.task_id).assignee_worker_id, handed && context.hub.store.getCommand(handed.command_id).worker_id);
});

test('Events can be read after a cursor, oldest first, filtered by type', async (t) => {
  const { context } = await setup(t);
  const start = await context.admin('/api/v1/events?after=');
  assert.equal(start.response.status, 200);
  assert.deepEqual(start.payload.events, [], 'an empty cursor starts at the present');
  const cursor = start.payload.cursor;
  await trigger(context, { trigger_key: 'e1', thread_key: 'feishu:e1', role: 'qa', text: '一', title: '一' });
  await trigger(context, { trigger_key: 'e2', thread_key: 'feishu:e2', role: 'qa', text: '二', title: '二' });
  const all = await context.admin(`/api/v1/events?after=${encodeURIComponent(cursor)}`);
  assert.ok(all.payload.events.length >= 4);
  const created = all.payload.events.filter((event) => event.event_type === 'task.created').map((event) => event.payload.title);
  assert.deepEqual(created, ['一', '二']);
  const typed = await context.admin(`/api/v1/events?after=${encodeURIComponent(cursor)}&types=task.created&limit=1`);
  assert.equal(typed.payload.events.length, 1);
  assert.equal(typed.payload.events[0].payload.title, '一');
  const next = await context.admin(`/api/v1/events?after=${encodeURIComponent(typed.payload.cursor)}&types=task.created`);
  assert.deepEqual(next.payload.events.map((event) => event.payload.title), ['二']);
  const unknown = await context.admin('/api/v1/events?after=evt_missing');
  assert.equal(unknown.response.status, 404);
});
