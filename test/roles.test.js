import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestContext, waitFor } from './helpers.js';
import { cwdMatches, taskPart } from '../src/roles.js';

// Each Session answers with `answers[name]` (default "done:<name>") and can be
// held on a gate so it is still running when its window closes.
function seatDriver() {
  const driver = {
    executions: [],
    gates: new Map(),
    answers: {},
    async execute({ worker, command, onState }) {
      driver.executions.push({ worker: worker.name, input: command.input, command_id: command.command_id });
      await onState({ started: true });
      const gate = driver.gates.get(worker.name);
      if (gate) await gate.promise;
      const answer = driver.answers[worker.name];
      const value = typeof answer === 'function' ? answer(command) : answer ?? `done:${worker.name}`;
      return typeof value === 'string' ? { text: value, session_id: worker.runtime_session_id } : { session_id: worker.runtime_session_id, ...value };
    },
    hold(name) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      driver.gates.set(name, { promise });
      return () => { driver.gates.delete(name); release(); };
    },
    // What the Hub sent, without the Channel's task-context wrapper.
    of(name) {
      return driver.executions.filter((item) => item.worker === name)
        .map((item) => ({ ...item, input: driver.store?.getCommand(item.command_id)?.input ?? item.input }));
    },
    async close() {},
  };
  return driver;
}

async function setup(t, { takeoverAfterMs = 0 } = {}) {
  const context = await createTestContext(t, { hub: { watchdogIntervalMs: 60 * 60 * 1000 } });
  const driver = seatDriver();
  driver.store = context.hub.store;
  context.driver = driver;
  const releases = [];
  t.after(() => releases.forEach((release) => release()));
  const role = await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA', takeover_after_ms: takeoverAfterMs } });
  assert.equal(role.response.status, 200, JSON.stringify(role.payload));
  return { context, driver, hold: (name) => { const release = driver.hold(name); releases.push(release); return release; } };
}

const trigger = (context, body) => context.local('/local/v1/triggers', {
  method: 'POST',
  body: { source: 'feishu', ...body },
});
const events = (context, type) => context.hub.store.listEvents().filter((event) => event.event_type === type);
const finished = (context, commandId) => waitFor(() => {
  const command = context.hub.store.getCommand(commandId);
  return ['succeeded', 'failed'].includes(command?.status) ? command : null;
});

test('Work addressed to a Role waits for a seat and goes to the first Session that joins', async (t) => {
  const { context, driver } = await setup(t);
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '登录页报错了', title: '登录报错' });
  assert.equal(payload.routed, 'created');
  assert.equal(payload.waiting_for_seat, true);
  assert.equal(payload.task.role_key, 'qa');
  assert.equal(payload.task.assignee_worker_id, null);

  const seat = await context.registerWorker({ name: 'qa-a', role: 'qa' });
  assert.equal(seat.role_key, 'qa');
  const handoff = await waitFor(() => context.hub.store.getHandoff(payload.handoff_id)?.status === 'dispatched' && context.hub.store.getHandoff(payload.handoff_id));
  assert.equal(handoff.worker_id, seat.worker_id);
  const command = await finished(context, handoff.command_id);
  assert.equal(command.status, 'succeeded');
  assert.equal(driver.of('qa-a')[0].input, '登录页报错了', 'first work carries no handoff package');
  assert.equal(context.hub.store.getTask(payload.task.task_id).assignee_worker_id, seat.worker_id);

  const roles = await context.admin('/api/v1/roles');
  const qa = roles.payload.roles.find((role) => role.role_key === 'qa');
  assert.equal(qa.name, 'QA');
  assert.deepEqual(qa.seats.map((item) => [item.name, item.available]), [['qa-a', true]]);
  assert.equal(qa.open_handoffs, 0);
});

test('Each seat does one job at a time and queued work goes to whichever seat frees up first', async (t) => {
  const { context, driver, hold } = await setup(t);
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  await context.registerWorker({ name: 'qa-b', role: 'qa', runtime_session_id: 'other-window' });
  const releaseA = hold('qa-a');
  const releaseB = hold('qa-b');

  const first = (await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: 'first' })).payload;
  const second = (await trigger(context, { trigger_key: 'm2', thread_key: 'feishu:t2', role: 'qa', text: 'second' })).payload;
  assert.ok(first.command_id && second.command_id);
  assert.notEqual(context.hub.store.getCommand(first.command_id).worker_id, context.hub.store.getCommand(second.command_id).worker_id, 'the idle seat gets the second job');

  const third = (await trigger(context, { trigger_key: 'm3', thread_key: 'feishu:t3', role: 'qa', text: 'third' })).payload;
  const fourth = (await trigger(context, { trigger_key: 'm4', thread_key: 'feishu:t4', role: 'qa', text: 'fourth' })).payload;
  for (const queued of [third, fourth]) {
    assert.equal(queued.waiting_for_seat, true);
    assert.equal(queued.seats_busy, true);
    assert.equal(queued.command_id, null);
    assert.equal(queued.task.assignee_worker_id, null);
  }

  // The seat that finishes first takes the oldest queued job, while the other stays held.
  const firstSeat = context.hub.store.getCommand(first.command_id).worker_id;
  const freedName = context.hub.store.getWorker(firstSeat).name;
  (freedName === 'qa-a' ? releaseA : releaseB)();
  await finished(context, first.command_id);
  const handoff = await waitFor(() => {
    const current = context.hub.store.getHandoff(third.handoff_id);
    return current?.status === 'dispatched' ? current : null;
  });
  assert.equal(handoff.worker_id, firstSeat);
  await waitFor(() => driver.of(freedName).some((item) => item.input === 'third'));
  assert.equal(context.hub.store.getHandoff(fourth.handoff_id).status, 'open', 'one job per seat, so the next one keeps waiting');
  assert.equal(context.hub.store.getCommand(second.command_id).status, 'running');
});

test('Follow-ups stay with the busy seat that holds the task', async (t) => {
  const { context, hold } = await setup(t);
  const seat = await context.registerWorker({ name: 'qa-a', role: 'qa' });
  hold('qa-a');
  await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: 'first' });
  const followup = (await trigger(context, { trigger_key: 'm2', thread_key: 'feishu:t1', role: 'qa', text: 'more' })).payload;
  assert.equal(followup.routed, 'followup');
  assert.equal(context.hub.store.getCommand(followup.command_id).worker_id, seat.worker_id);
  assert.equal(followup.waiting_for_seat, undefined);
});

test('seats_busy stays false when nobody is on the Role', async (t) => {
  const { context } = await setup(t);
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: 'anyone?' });
  assert.equal(payload.waiting_for_seat, true);
  assert.equal(payload.seats_busy, false);
});

test('A seat in the wrong directory does not count as busy', async (t) => {
  const { context } = await setup(t);
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA', workdir: 'youxian-qa' } });
  await context.registerWorker({ name: 'qa-a', role: 'qa', cwd: '/tmp/elsewhere' });
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: 'anyone?' });
  assert.equal(payload.waiting_for_seat, true);
  assert.equal(payload.seats_busy, false);
});

test('A Session that dies mid-run is replaced by another seat with a handoff package', async (t) => {
  const { context, driver, hold } = await setup(t);
  const first = await context.registerWorker({ name: 'qa-a', role: 'qa' });
  hold('qa-a');
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '查一下带话失败', title: '带话失败' });
  const interrupted = payload.command_id;
  await waitFor(() => context.hub.store.getCommand(interrupted)?.status === 'running');
  context.connector.emitOutput(interrupted, '[progress] 复现了：staging 带话返回 500\n');
  await waitFor(() => context.hub.store.getCommand(interrupted).output_text.includes('复现了'));
  const second = await context.registerWorker({ name: 'qa-b', role: 'qa', runtime_session_id: 'other-window' });

  await context.detachWorker(first);
  const lost = await finished(context, interrupted);
  assert.equal(lost.outcome_unknown, true);
  const taken = await waitFor(() => driver.of('qa-b')[0]);
  const input = taken.input;
  assert.match(input, /^【交接】你接手了任务#\d{4}「带话失败」。它属于岗位「QA」，之前由 qa-a 负责/);
  assert.match(input, /channel_closed/);
  assert.match(input, /最近进展：\n- 复现了：staging 带话返回 500/);
  assert.match(input, /关联话题：feishu:t1/);
  assert.match(input, /恢复提示：先核对现场/);
  assert.equal(taskPart(input), '查一下带话失败', 'the interrupted work is passed on as-is');
  assert.match(input, new RegExp(`agent-hub command result ${interrupted}`));

  const task = context.hub.store.getTask(payload.task.task_id);
  assert.equal(task.assignee_worker_id, second.worker_id);
  assert.ok(events(context, 'task.handoff').some((event) => event.payload.reason === 'session_lost' && event.worker_id === second.worker_id));
  const recall = await context.local(`/local/v1/commands/${interrupted}/result?runtime=test&session_id=other-window`);
  assert.equal(recall.response.status, 200, 'the new seat may read the interrupted command through its pointer');

  // Later thread messages follow the Task to its new seat.
  const later = await trigger(context, { trigger_key: 'm2', thread_key: 'feishu:t1', text: '补充：只有 iOS', followup_only: true });
  assert.equal(later.payload.routed, 'followup');
  await waitFor(() => driver.of('qa-b').length === 2);
  assert.match(driver.of('qa-b')[1].input, /补充：只有 iOS/);
});

test('A quick restart keeps the work with the same Session', async (t) => {
  const { context, driver, hold } = await setup(t, { takeoverAfterMs: 60 * 60 * 1000 });
  const first = await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const release = hold('qa-a');
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '跑一遍回归', title: '回归' });
  await waitFor(() => context.hub.store.getCommand(payload.command_id)?.status === 'running');
  await context.registerWorker({ name: 'qa-b', role: 'qa', runtime_session_id: 'other-window' });
  await context.detachWorker(first);
  await finished(context, payload.command_id);
  const open = await waitFor(() => context.hub.store.openHandoffForTask(payload.task.task_id));
  assert.equal(open.reason, 'session_lost');
  context.hub.roles.pump();
  assert.equal(driver.of('qa-b').length, 0, 'other seats wait for the takeover delay');

  release();
  await context.attachWorker(first);
  await waitFor(() => driver.of('qa-a').length === 2);
  const resumed = driver.of('qa-a')[1].input;
  assert.match(resumed, /^【恢复】任务#\d{4}「回归」的上一次执行/);
  assert.equal(taskPart(resumed), '跑一遍回归');
  assert.equal(driver.of('qa-b').length, 0);
});

test('Work queued on an unreachable seat moves to a live seat after the delay; running work never moves', async (t) => {
  const { context, driver } = await setup(t);
  const first = await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '看一下', title: '看一下' });
  await finished(context, payload.command_id);
  await context.detachWorker(first);

  // An explicit command to the old Session waits there (waiting_manual)...
  const pinned = await context.admin('/api/v1/commands', { method: 'POST', body: { task_id: payload.task.task_id, worker_id: first.worker_id, input: '再确认一次' } });
  assert.equal(pinned.payload.command.status, 'waiting_manual');
  // ...and with no other seat there is nowhere to move it.
  await context.hub.roles.tick();
  assert.equal(context.hub.store.getCommand(pinned.payload.command.command_id).status, 'waiting_manual');

  const second = await context.registerWorker({ name: 'qa-b', role: 'qa', runtime_session_id: 'other-window' });
  await context.hub.roles.tick();
  const moved = context.hub.store.getCommand(pinned.payload.command.command_id);
  assert.equal(moved.status, 'failed');
  assert.equal(moved.error.code, 'seat_reassigned');
  await waitFor(() => driver.of('qa-b').length === 1);
  assert.match(driver.of('qa-b')[0].input, /qa-a 的会话已离线，排给它的工作转给你/);
  assert.equal(taskPart(driver.of('qa-b')[0].input), '再确认一次');
  assert.match(driver.of('qa-b')[0].input, /上一次回报（命令 [^）]+）：\ndone:qa-a/);
  assert.equal(context.hub.store.getTask(payload.task.task_id).assignee_worker_id, second.worker_id);

  // Follow-ups to the Task go straight to the live seat, and so does admin work without a worker_id.
  const routed = await context.admin('/api/v1/commands', { method: 'POST', body: { task_id: payload.task.task_id, input: '顺便看下日志' } });
  assert.equal(routed.response.status, 202);
  assert.equal(routed.payload.command.worker_id, second.worker_id);
});

test('An answer to a question from a Session that is gone is handed to another seat', async (t) => {
  const { context, driver } = await setup(t);
  driver.answers['qa-a'] = { text: '缺复现账号', outcome: 'needs_input', question: '用哪个测试账号？' };
  const first = await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '复现问题', title: '复现' });
  await finished(context, payload.command_id);
  const attention = await waitFor(() => context.hub.store.openAttentionForTask(payload.task.task_id));
  await context.detachWorker(first);
  await context.registerWorker({ name: 'qa-b', role: 'qa', runtime_session_id: 'other-window' });

  const answered = await trigger(context, { trigger_key: 'm2', thread_key: 'feishu:t1', actor: '黄海斌', text: '用 test-03', followup_only: true });
  assert.equal(answered.payload.routed, 'answered');
  await waitFor(() => driver.of('qa-b').length === 1);
  const input = driver.of('qa-b')[0].input;
  assert.match(input, /回答：黄海斌：用 test-03/);
  assert.match(input, /问题：用哪个测试账号？/);
  assert.doesNotMatch(input, /还没回答的问题/, 'the answered question is no longer listed as open');
  assert.equal(context.hub.store.getAttention(attention.attention_id).status, 'answered');
});

test('Repeated lost Sessions stop after a bounded number of handoffs', async (t) => {
  const { context, hold } = await setup(t);
  const seats = [];
  for (const name of ['qa-a', 'qa-b', 'qa-c', 'qa-d', 'qa-e']) {
    hold(name);
    seats.push(await context.registerWorker({ name, role: 'qa', runtime_session_id: `${name}-window` }));
  }
  const { payload } = await trigger(context, { trigger_key: 'm1', thread_key: 'feishu:t1', role: 'qa', text: '会把会话搞崩的任务', title: '崩' });
  let commandId = payload.command_id;
  for (let round = 0; round < 4; round += 1) {
    const command = await waitFor(() => context.hub.store.getCommand(commandId)?.status === 'running' && context.hub.store.getCommand(commandId));
    await context.detachWorker(seats.find((seat) => seat.worker_id === command.worker_id));
    await finished(context, commandId);
    if (round < 3) {
      commandId = await waitFor(() => context.hub.store.listHandoffs({ taskId: payload.task.task_id, status: 'dispatched' })[round + 1]?.command_id);
    }
  }
  assert.equal(context.hub.store.countHandoffs(payload.task.task_id, 'session_lost'), 3);
  assert.equal(context.hub.store.openHandoffForTask(payload.task.task_id), null);
  assert.equal(events(context, 'handoff.exhausted').length, 1);
});

test('Role validation and membership', async (t) => {
  const { context } = await setup(t);
  const bad = await context.local('/local/v1/workers/register', {
    method: 'POST',
    body: { name: 'x', runtime: 'test', runtime_session_id: 'bad-role', cwd: context.root, role: 'QA Team!' },
  });
  assert.equal(bad.response.status, 400);
  const worker = await context.registerWorker({ name: 'plain' });
  assert.equal(worker.role_key, null);
  const assigned = await context.admin(`/api/v1/workers/${worker.worker_id}/role`, { method: 'PUT', body: { role: 'backend' } });
  assert.equal(assigned.payload.worker.role_key, 'backend');
  assert.ok(context.hub.store.getRole('backend'), 'joining an unknown Role creates it');
  // Re-registering without a role keeps the membership.
  const again = await context.local('/local/v1/workers/register', {
    method: 'POST', body: { name: 'plain', runtime: 'test', runtime_session_id: worker.runtime_session_id, cwd: context.root },
  });
  assert.equal(again.payload.worker.role_key, 'backend');
  const cleared = await context.admin(`/api/v1/workers/${worker.worker_id}/role`, { method: 'PUT', body: { role: null } });
  assert.equal(cleared.payload.worker.role_key, null);
  const invalid = await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { takeover_after_ms: -1 } });
  assert.equal(invalid.response.status, 400);
});

test('A workdir matches exactly when absolute and by path end when relative', () => {
  assert.equal(cwdMatches(null, '/anywhere'), true);
  assert.equal(cwdMatches('youxian-qa', '/Users/a/Workspace/youxian/youxian-qa'), true);
  assert.equal(cwdMatches('youxian-qa', '/Users/a/Workspace/youxian/youxian-qa/'), true);
  assert.equal(cwdMatches('youxian/youxian-qa', '/Users/b/code/youxian/youxian-qa'), true);
  assert.equal(cwdMatches('youxian-qa', '/Users/a/Workspace/youxian'), false);
  assert.equal(cwdMatches('qa', '/Users/a/youxian-qa'), false, 'matches whole path segments only');
  assert.equal(cwdMatches('/srv/qa', '/home/srv/qa'), false);
  assert.equal(cwdMatches('/srv/qa', '/srv/qa/'), true);
  assert.equal(cwdMatches('youxian-qa', null), false);
});

test('A live Session in the wrong directory gets no Role work, whatever it declared', async (t) => {
  const { context, driver } = await setup(t);
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { workdir: 'youxian-qa' } });

  // Declares the right directory, but its Channel runs from the workspace root.
  const misplaced = await context.registerWorker({ name: 'qa-wrong', role: 'qa', cwd: '/w/youxian/youxian-qa', attach: false });
  await context.attachWorker({ ...misplaced, cwd: '/w/youxian' });
  const seen = await waitFor(() => {
    const worker = context.hub.store.getWorker(misplaced.worker_id);
    return worker.push_capable && worker.session_cwd === '/w/youxian' ? worker : null;
  });
  assert.equal(context.hub.roles.available(seen), false);

  const { payload } = await trigger(context, { trigger_key: 'wd1', thread_key: 'feishu:wd', role: 'qa', text: '查一下' });
  assert.equal(payload.waiting_for_seat, true);
  const roles = await context.admin('/api/v1/roles');
  const seat = roles.payload.roles.find((role) => role.role_key === 'qa').seats[0];
  assert.equal(seat.available, false);
  assert.match(seat.problem, /runs in \/w\/youxian, but Role qa works in youxian-qa/);
  const listed = await context.admin('/api/v1/workers');
  assert.match(listed.payload.workers.find((worker) => worker.worker_id === misplaced.worker_id).seat_problem, /youxian-qa/);

  const right = await context.registerWorker({ name: 'qa-right', role: 'qa', cwd: '/other-mac/youxian-qa' });
  const handoff = await waitFor(() => {
    const current = context.hub.store.getHandoff(payload.handoff_id);
    return current?.status === 'dispatched' ? current : null;
  });
  assert.equal(handoff.worker_id, right.worker_id);
  await finished(context, handoff.command_id);
  assert.equal(driver.of('qa-wrong').length, 0);
});

test('Clearing a workdir makes the seat usable again', async (t) => {
  const { context } = await setup(t);
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { workdir: 'youxian-qa' } });
  const worker = await context.registerWorker({ name: 'qa-any', role: 'qa', cwd: '/w/elsewhere' });
  assert.equal(context.hub.roles.available(context.hub.store.getWorker(worker.worker_id)), false);
  const cleared = await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { workdir: null } });
  assert.equal(cleared.payload.role.workdir, null);
  assert.equal(context.hub.roles.available(context.hub.store.getWorker(worker.worker_id)), true);
  const kept = await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { workdir: 'keep-me' } });
  assert.equal(kept.payload.role.workdir, 'keep-me');
  const renamed = await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA2' } });
  assert.equal(renamed.payload.role.workdir, 'keep-me', 'an unrelated update leaves the workdir alone');
});

test('Without a reported directory the seat is judged by the declared one', async (t) => {
  const { context } = await setup(t);
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { workdir: 'youxian-qa' } });
  const fits = { role_key: 'qa', session_cwd: null, cwd: '/a/youxian-qa' };
  assert.equal(context.hub.roles.seatProblem(fits), null);
  assert.match(context.hub.roles.seatProblem({ ...fits, cwd: '/a/root' }), /runs in \/a\/root/);
  assert.equal(context.hub.roles.seatProblem({ role_key: null, cwd: '/a/root' }), null);
});

test('Registering warns about a wrong directory and a --cwd that disagrees with the Session', async (t) => {
  const { context } = await setup(t);
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { workdir: 'youxian-qa' } });
  const body = { name: 'qa-w', runtime: 'test', mode: 'external', runtime_session_id: 'warn-session', capabilities: [], metadata: {}, role: 'qa' };
  const first = await context.local('/local/v1/workers/register', { method: 'POST', body: { ...body, cwd: '/w/root' } });
  assert.match(first.payload.warnings.join(), /will not receive this Role's work/);
  await context.attachWorker({ ...first.payload.worker, cwd: '/w/root' });
  await waitFor(() => context.hub.store.getWorker(first.payload.worker.worker_id).session_cwd === '/w/root');
  const second = await context.local('/local/v1/workers/register', { method: 'POST', body: { ...body, cwd: '/w/youxian-qa' } });
  assert.match(second.payload.warnings.join(), /--cwd says \/w\/youxian-qa, but the Session runs in \/w\/root/);
  assert.match(second.payload.warnings.join(), /will not receive/, 'the real directory decides, not the declared one');
});

test('Re-registering keeps capabilities and metadata it does not name, and the Role', async (t) => {
  const { context } = await setup(t);
  const body = { name: 'keeper', runtime: 'test', mode: 'external', runtime_session_id: 'keep-session', cwd: '/w/keep' };
  const first = await context.local('/local/v1/workers/register', { method: 'POST', body: {
    ...body, role: 'qa', capabilities: ['qa', 'review'], metadata: { description: '线上 QA', interactive: true },
  } });
  assert.deepEqual(first.payload.worker.capabilities, ['qa', 'review']);

  const bare = await context.local('/local/v1/workers/register', { method: 'POST', body: { ...body, metadata: { session_origin: 'launcher' } } });
  assert.equal(bare.payload.worker.worker_id, first.payload.worker.worker_id);
  assert.deepEqual(bare.payload.worker.capabilities, ['qa', 'review']);
  assert.deepEqual(bare.payload.worker.metadata, { description: '线上 QA', interactive: true, session_origin: 'launcher' });
  assert.equal(bare.payload.worker.role_key, 'qa');

  const named = await context.local('/local/v1/workers/register', { method: 'POST', body: { ...body, capabilities: ['qa'], metadata: { description: '新说明' } } });
  assert.deepEqual(named.payload.worker.capabilities, ['qa']);
  assert.equal(named.payload.worker.metadata.description, '新说明');
  assert.equal(named.payload.worker.metadata.interactive, true);
});

test('The local worker list reports the Connector and the Session separately, live', async (t) => {
  const { context } = await setup(t);
  const worker = await context.registerWorker({ name: 'list-seat', cwd: '/w/list' });
  const view = async () => (await context.local('/local/v1/workers')).payload.workers.find((item) => item.worker_id === worker.worker_id);
  const live = await view();
  assert.equal(live.presence, 'online');
  assert.equal(live.session_online, true);
  assert.equal(live.session_cwd, '/w/list');
  assert.equal('last_seen_at' in live, false, 'the stored registration time must not pass for liveness');

  await context.detachWorker(worker);
  const gone = await view();
  assert.equal(gone.presence, 'online', 'the Connector is still up');
  assert.equal(gone.session_online, false);
  assert.equal(context.hub.store.getWorker(worker.worker_id).session_online, false);
});

test('A symlinked --cwd is the same directory as the real path the Channel reports', async (t) => {
  const { context } = await setup(t);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-link-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = path.join(root, 'link');
  await symlink(root, link);
  const body = { name: 'linked', runtime: 'test', mode: 'external', runtime_session_id: 'link-session', capabilities: [], metadata: {} };
  const first = await context.local('/local/v1/workers/register', { method: 'POST', body: { ...body, cwd: root } });
  await context.attachWorker(first.payload.worker);
  await waitFor(() => context.hub.store.getWorker(first.payload.worker.worker_id).session_cwd === root);
  const second = await context.local('/local/v1/workers/register', { method: 'POST', body: { ...body, cwd: link } });
  assert.equal(second.payload.warnings, undefined);
  assert.equal(second.payload.worker.cwd, root);
});
