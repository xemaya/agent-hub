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
    failWork: false,
    async prepareWorker(input) {
      sequence += 1;
      return { runtime_session_id: input.runtime_session_id ?? `session-${sequence}`, driver_state: {} };
    },
    async execute({ worker, command, onOutput, onState }) {
      driver.executions.push({ worker: worker.name, kind: command.kind, input: command.input });
      await onState({ started: true });
      if (driver.failWork && command.kind === 'prompt') throw new Error('work failed');
      const text = command.kind === 'coordinator_plan'
        ? driver.plan
        : command.kind === 'coordinator_review'
          ? driver.review
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
