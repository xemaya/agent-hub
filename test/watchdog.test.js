import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, waitFor } from './helpers.js';
import { validateVerdicts, WATCHDOG_KIND } from '../src/watchdog.js';

// Target work blocks on a gate so it stays running; the watchdog Session
// answers each check with whatever `driver.verdicts` returns.
function scriptedDriver() {
  let release;
  const driver = {
    checks: [],
    verdicts: null,
    gate: new Promise((resolve) => { release = resolve; }),
    release: () => release(),
    async execute({ worker, command, onState }) {
      await onState({ started: true });
      if (command.kind === WATCHDOG_KIND) {
        driver.checks.push(command);
        const text = typeof driver.verdicts === 'function' ? driver.verdicts(command) : driver.verdicts;
        return { text, session_id: worker.runtime_session_id };
      }
      await driver.gate;
      return { text: `done:${command.input}`, session_id: worker.runtime_session_id };
    },
    async close() {},
  };
  return driver;
}

async function setup(t) {
  const context = await createTestContext(t, { hub: { watchdogIntervalMs: 60 * 60 * 1000 } });
  const driver = scriptedDriver();
  context.driver = driver;
  t.after(() => driver.release());
  const watchdog = await context.registerWorker({ name: 'watchdog-test' });
  const worker = await context.registerWorker({ name: 'busy-worker' });
  const configured = await context.admin('/api/v1/watchdog', {
    method: 'PUT',
    body: { worker_id: watchdog.worker_id, enabled: true, min_running_ms: 0, nudge_cooldown_ms: 60 * 60 * 1000 },
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));
  const created = await context.admin('/api/v1/commands', {
    method: 'POST',
    body: { worker_id: worker.worker_id, input: 'Fix the flaky login test' },
  });
  const commandId = created.payload.command.command_id;
  await waitFor(() => context.hub.store.getCommand(commandId)?.status === 'running');
  return { context, driver, watchdog, worker, commandId };
}

async function check(context) {
  const { payload } = await context.admin('/api/v1/watchdog/check', { method: 'POST', body: {} });
  assert.ok(payload.check, 'a check command is created');
  await waitFor(() => ['succeeded', 'failed'].includes(context.hub.store.getCommand(payload.check.command_id)?.status));
  return payload.check;
}

function events(context, type, commandId) {
  return context.hub.store.listEvents().filter((event) => event.event_type === type && (!commandId || event.command_id === commandId));
}

test('Watchdog configuration requires an attached Session other than the Coordinator', async (t) => {
  const context = await createTestContext(t);
  const offline = await context.registerWorker({ name: 'not-attached', attach: false });
  const rejected = await context.admin('/api/v1/watchdog', { method: 'PUT', body: { worker_id: offline.worker_id } });
  assert.equal(rejected.response.status, 400);
  const coordinator = await context.registerWorker({ name: 'coordinator' });
  await context.admin('/api/v1/coordinator', { method: 'PUT', body: { worker_id: coordinator.worker_id, enabled: true } });
  const same = await context.admin('/api/v1/watchdog', { method: 'PUT', body: { worker_id: coordinator.worker_id } });
  assert.equal(same.response.status, 400);
  const tooFast = await context.admin('/api/v1/watchdog', {
    method: 'PUT', body: { worker_id: (await context.registerWorker({ name: 'w' })).worker_id, interval_ms: 10 },
  });
  assert.equal(tooFast.response.status, 400);
  const status = await context.admin('/api/v1/watchdog');
  assert.equal(status.payload.watchdog.enabled, false);
  assert.equal(status.payload.watchdog.interval_ms, 10 * 60 * 1000);
});

test('A looping command gets one mailbox nudge with evidence, and is never cancelled', async (t) => {
  const { context, driver, watchdog, worker, commandId } = await setup(t);
  context.connector.emitOutput(commandId, '[progress] ran npm test, login.spec fails: timeout\n');
  context.connector.emitOutput(commandId, '[progress] ran npm test, login.spec fails: timeout\n');
  await waitFor(() => context.hub.store.getCommand(commandId).output_text.split('[progress]').length === 3);
  driver.verdicts = () => JSON.stringify({
    verdicts: [{
      command_id: commandId,
      state: 'looping',
      action: 'nudge',
      evidence: '两条进展行完全相同：login.spec timeout',
      message: '同一个超时已重复两轮，建议先看测试的等待条件再重跑。',
    }],
  });

  const first = await check(context);
  const snapshot = driver.checks[0].input;
  assert.match(snapshot, /Fix the flaky login test/);
  assert.match(snapshot, /"progress_line_count": 2/);
  assert.doesNotMatch(snapshot, /watchdog-test/, 'the watchdog never judges itself');
  const verdicts = await waitFor(() => events(context, 'watchdog.verdict', commandId).length && events(context, 'watchdog.verdict', commandId));
  assert.equal(verdicts[0].payload.applied, 'nudge');
  assert.equal(verdicts[0].payload.check_command_id, first.command_id);
  const inbox = await waitFor(async () => {
    const { payload } = await context.admin(`/api/v1/mail?worker_id=${worker.worker_id}`);
    return payload.messages?.length && payload.messages;
  });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].sender_worker_id, watchdog.worker_id);
  assert.equal(inbox[0].command_id, commandId);
  assert.equal(context.hub.store.getCommand(commandId).status, 'running');

  // The same judgement inside the cooldown is recorded but sends nothing.
  await check(context);
  await waitFor(() => events(context, 'watchdog.verdict', commandId).length === 2);
  assert.equal(events(context, 'watchdog.verdict', commandId)[0].payload.applied, 'none');
  assert.equal(events(context, 'watchdog.nudged', commandId).length, 1);
  assert.match(driver.checks[1].input, /"previous_check": \{\s+"state": "looping"/);
  assert.equal(context.hub.store.getCommand(commandId).status, 'running');
});

test('An escalation reaches the central conversation without changing work state', async (t) => {
  const { context, driver, commandId } = await setup(t);
  driver.verdicts = JSON.stringify({
    verdicts: [{
      command_id: commandId,
      state: 'drifted',
      action: 'escalate',
      evidence: '最近输出在重构 payment 模块，任务是修登录测试',
      message: '它在改 payment 模块，是否允许扩大范围？',
    }],
  });
  await check(context);
  await waitFor(() => events(context, 'watchdog.alert', commandId).length === 1);
  const chat = await context.admin('/api/v1/coordinator/chat');
  const alert = chat.payload.messages.find((message) => message.role === 'activity' && message.content.includes('payment'));
  assert.ok(alert, 'the alert is shown to people');
  assert.equal(context.hub.store.getCommand(commandId).status, 'running');
  assert.equal(events(context, 'watchdog.nudged', commandId).length, 0);
});

test('Invalid watchdog output records a failure and takes no action', async (t) => {
  const { context, driver, worker, commandId } = await setup(t);
  driver.verdicts = 'looks fine to me';
  await check(context);
  await waitFor(() => events(context, 'watchdog.check.failed').length === 1);
  assert.equal(events(context, 'watchdog.verdict', commandId).length, 0);
  const { payload } = await context.admin(`/api/v1/mail?worker_id=${worker.worker_id}`);
  assert.equal(payload.messages.length, 0);
  assert.equal(context.hub.store.getCommand(commandId).status, 'running');
});

test('Periodic ticks respect the interval and skip when nothing runs long enough', async (t) => {
  const { context, driver, commandId } = await setup(t);
  driver.verdicts = JSON.stringify({ verdicts: [{ command_id: commandId, state: 'progressing', action: 'nudge', evidence: '有新进展' }] });
  const first = context.hub.watchdog.tick();
  assert.ok(first);
  assert.equal(context.hub.watchdog.tick(), null, 'only one check is active at a time');
  await waitFor(() => context.hub.store.getCommand(first.command_id).status === 'succeeded');
  assert.equal(context.hub.watchdog.tick(), null, 'the next check waits for the interval');
  await waitFor(() => events(context, 'watchdog.verdict', commandId).length === 1);
  assert.equal(events(context, 'watchdog.verdict', commandId)[0].payload.applied, 'none', 'progressing is never disturbed');

  const watchdogId = context.hub.store.getWatchdogConfig().worker_id;
  await context.admin('/api/v1/watchdog', {
    method: 'PUT', body: { worker_id: watchdogId, interval_ms: 60 * 1000, min_running_ms: 60 * 60 * 1000 },
  });
  const later = Date.now() + 2 * 60 * 1000;
  context.hub.watchdog.now = () => later;
  assert.equal(context.hub.watchdog.tick(), null, 'a command running for minutes is not judged yet');
});

test('Verdict validation rejects unknown, duplicate or missing commands', () => {
  const ok = { command_id: 'cmd_a', state: 'stuck', action: 'escalate', evidence: 'idle 40 min', message: 'Needs a person?' };
  assert.equal(validateVerdicts({ verdicts: [ok] }, ['cmd_a'])[0].action, 'escalate');
  assert.throws(() => validateVerdicts({ verdicts: [ok, ok] }, ['cmd_a']), /duplicate/);
  assert.throws(() => validateVerdicts({ verdicts: [] }, ['cmd_a']), /every command/);
  assert.throws(() => validateVerdicts({ verdicts: [{ ...ok, command_id: 'cmd_x' }] }, ['cmd_a']), /unknown/);
  assert.throws(() => validateVerdicts({ verdicts: [{ ...ok, message: '' }] }, ['cmd_a']), /message/);
  assert.equal(validateVerdicts({ verdicts: [{ ...ok, state: 'unclear', message: '' }] }, ['cmd_a'])[0].action, 'none');
});
