const FINAL_COMMAND_STATUSES = new Set(['succeeded', 'failed']);
const FINISHED_STEP_STATUSES = new Set(['review', 'done']);

function coordinatorError(message, code = 'coordinator_invalid', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function text(value, field, { required = true, max = 10000 } = {}) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw coordinatorError(`${field} must be ${required ? 'a non-empty' : 'a'} string of at most ${max} characters`);
  }
  return value.trim();
}

function acceptance(value, field = 'acceptance') {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw coordinatorError(`${field} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function jsonDocument(value) {
  if (typeof value !== 'string' || !value.trim()) throw coordinatorError('Coordinator returned no JSON');
  let input = value.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(input);
  if (fence) input = fence[1].trim();
  try {
    return JSON.parse(input);
  } catch {
    const start = input.indexOf('{');
    const end = input.lastIndexOf('}');
    if (start < 0 || end <= start) throw coordinatorError('Coordinator returned invalid JSON');
    try {
      return JSON.parse(input.slice(start, end + 1));
    } catch {
      throw coordinatorError('Coordinator returned invalid JSON');
    }
  }
}

function validatePlan(value, registry, maxSteps) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw coordinatorError('Plan must be a JSON object');
  const summary = text(value.summary, 'summary', { max: 4000 });
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > maxSteps) {
    throw coordinatorError(`Plan must contain 1 to ${maxSteps} steps`);
  }
  const workers = new Map(registry.map((worker) => [worker.worker_id, worker]));
  const keys = new Set();
  const steps = value.steps.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw coordinatorError(`Step ${index + 1} must be an object`);
    const key = text(input.key, 'step.key', { max: 32 });
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(key)) throw coordinatorError(`Invalid step key: ${key}`);
    if (keys.has(key)) throw coordinatorError(`Duplicate step key: ${key}`);
    keys.add(key);
    if (!workers.has(input.worker_id)) throw coordinatorError(`Step ${key} selects an unavailable Worker`);
    if (!Array.isArray(input.depends_on ?? [])) throw coordinatorError(`Step ${key} depends_on must be an array`);
    const dependsOn = [...new Set(input.depends_on ?? [])];
    if (dependsOn.some((dependency) => typeof dependency !== 'string')) {
      throw coordinatorError(`Step ${key} has an invalid dependency`);
    }
    if (dependsOn.includes(key)) throw coordinatorError(`Step ${key} depends on itself`);
    const stepAcceptance = acceptance(input.acceptance, `step.${key}.acceptance`);
    if (stepAcceptance.length < 1) throw coordinatorError(`Step ${key} needs at least one acceptance criterion`);
    return {
      key,
      title: text(input.title, `step.${key}.title`, { max: 300 }),
      goal: text(input.goal, `step.${key}.goal`),
      context: text(input.context ?? '', `step.${key}.context`, { required: false }),
      acceptance: stepAcceptance,
      worker_id: input.worker_id,
      depends_on: dependsOn,
      rationale: text(input.rationale ?? '', `step.${key}.rationale`, { required: false, max: 2000 }),
      task_id: null,
      command_id: null,
      status: 'ready',
      result: null,
      error: null,
    };
  });
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!keys.has(dependency)) throw coordinatorError(`Step ${step.key} depends on unknown step ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(key) {
    if (visiting.has(key)) throw coordinatorError(`Dependency cycle includes ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    const step = steps.find((item) => item.key === key);
    for (const dependency of step.depends_on) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const step of steps) visit(step.key);
  return { summary, steps };
}

function validateReview(value, steps) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw coordinatorError('Review must be a JSON object');
  if (typeof value.parent_pass !== 'boolean') throw coordinatorError('Review parent_pass must be a boolean');
  const reason = text(value.reason, 'review.reason', { max: 4000 });
  if (!Array.isArray(value.steps)) throw coordinatorError('Review steps must be an array');
  const expected = new Set(steps.map((step) => step.key));
  const verdicts = new Map();
  for (const input of value.steps) {
    if (!input || typeof input !== 'object' || !expected.has(input.key) || verdicts.has(input.key)) {
      throw coordinatorError('Review contains an unknown or duplicate step');
    }
    if (typeof input.pass !== 'boolean') throw coordinatorError(`Review step ${input.key} pass must be a boolean`);
    verdicts.set(input.key, {
      pass: input.pass,
      reason: text(input.reason, `review.${input.key}.reason`, { max: 2000 }),
    });
  }
  if (verdicts.size !== expected.size) throw coordinatorError('Review must include every step');
  return { parentPass: value.parent_pass, reason, verdicts };
}

function resultEvidence(result) {
  const value = typeof result?.text === 'string' ? result.text : JSON.stringify(result ?? null);
  return value.slice(0, 12000);
}

export class Coordinator {
  constructor({ store, emit, dispatch, logger = console }) {
    this.store = store;
    this.emit = emit;
    this.dispatch = dispatch;
    this.logger = logger;
  }

  status() {
    const config = this.store.getCoordinatorConfig();
    return {
      ...config,
      worker: config.worker_id ? this.store.getWorker(config.worker_id) : null,
      active_orchestrations: this.store.listOrchestrations({ active: true }).length,
    };
  }

  configure({ workerId, enabled = true, maxSteps }) {
    if (enabled) {
      const worker = workerId ? this.store.getWorker(workerId) : null;
      if (!worker || worker.mode !== 'managed' || !worker.push_capable) {
        throw coordinatorError('Coordinator must be a managed, push-capable Worker', 'coordinator_worker_invalid');
      }
    }
    const config = this.store.getCoordinatorConfig();
    const steps = maxSteps ?? config.max_steps ?? 4;
    if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
      throw coordinatorError('max_steps must be an integer between 1 and 8', 'coordinator_max_steps_invalid');
    }
    const updated = this.store.setCoordinatorConfig({
      workerId: enabled ? workerId : config.worker_id,
      enabled,
      maxSteps: steps,
    });
    this.emit('coordinator.configured', { type: 'admin', id: 'admin' }, {
      worker_id: updated.worker_id,
      payload: { enabled: updated.enabled, max_steps: updated.max_steps },
    });
    return this.status();
  }

  eligibleRegistry(excludeWorkerId = this.store.getCoordinatorConfig().worker_id) {
    return this.store.listWorkers()
      .filter((worker) => (
        worker.worker_id !== excludeWorkerId
        && worker.mode === 'managed'
        && worker.push_capable
        && worker.presence === 'online'
      ))
      .map((worker) => ({
        worker_id: worker.worker_id,
        name: worker.name,
        connector_id: worker.connector_id,
        connector_name: worker.connector_name,
        runtime: worker.runtime,
        capabilities: worker.capabilities,
        description: typeof worker.metadata?.description === 'string' ? worker.metadata.description : '',
        cwd: worker.cwd,
        presence: worker.presence,
        work_state: worker.work_state,
        current_task_id: worker.current_task_id,
      }));
  }

  createOrchestration({ title, goal, context, acceptance: criteria, createdBy, actor }) {
    const config = this.store.getCoordinatorConfig();
    if (!config.enabled || !config.worker_id) throw coordinatorError('Coordinator is not configured', 'coordinator_disabled');
    const registry = this.eligibleRegistry(config.worker_id);
    if (!registry.length) throw coordinatorError('No eligible Workers are available for orchestration', 'coordinator_no_workers');
    const parent = this.store.createTask({
      title: text(title, 'title', { max: 300 }),
      goal: typeof goal === 'string' ? goal : '',
      context: typeof context === 'string' ? context : '',
      acceptance: criteria ?? [],
      assignee_worker_id: null,
      created_by: createdBy,
    });
    const orchestration = this.store.createOrchestration({
      parentTaskId: parent.task_id,
      coordinatorWorkerId: config.worker_id,
    });
    this.emit('task.created', actor, {
      task_id: parent.task_id,
      payload: { title: parent.title, orchestrated: true },
    });
    this.emit('coordinator.started', actor, {
      task_id: parent.task_id,
      worker_id: config.worker_id,
      payload: { orchestration_id: orchestration.orchestration_id },
    });
    try {
      this.requestPlan(orchestration, parent, registry);
    } catch (error) {
      this.fail(orchestration, 'coordinator_plan_failed', error.message);
    }
    return {
      task: this.store.getTask(parent.task_id),
      orchestration: this.store.getOrchestration(orchestration.orchestration_id),
    };
  }

  requestPlan(orchestration, parent, registry) {
    const config = this.store.getCoordinatorConfig();
    const input = [
      '你是 Agent Hub 的中央协调者。你只负责规划和最终评审，不能调用工具或修改任务。',
      '根据总目标和 Worker 自描述选择最合适的 Worker。一步能完成就不要硬拆，只有确实需要时才拆步骤。',
      '只输出一个 JSON 对象，不要 Markdown、解释或额外文本。schema:',
      '{"summary":"计划摘要","steps":[{"key":"step-1","title":"...","goal":"...","context":"...","acceptance":["可检查的标准"],"worker_id":"worker_...","depends_on":[],"rationale":"选择该 Worker 的原因"}]}',
      `最多 ${config.max_steps} 步；每步至少一条验收标准；depends_on 使用已有 key，不允许环。不要使用协调者自己或列表外的 worker_id。优先能力匹配和空闲 Worker。`,
      '总任务 JSON:',
      JSON.stringify(parent, null, 2),
      '可用 Worker JSON:',
      JSON.stringify(registry, null, 2),
    ].join('\n\n');
    const command = this.store.createCommand({
      task_id: parent.task_id,
      worker_id: orchestration.coordinator_worker_id,
      kind: 'coordinator_plan',
      input,
      push_capable: true,
    });
    this.emit('coordinator.plan.requested', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: parent.task_id,
      command_id: command.command_id,
      payload: { orchestration_id: orchestration.orchestration_id },
    });
    this.dispatch(command);
  }

  reviewPrompt(orchestration) {
    const parent = this.store.getTask(orchestration.parent_task_id);
    const steps = orchestration.steps.map((step) => ({
      key: step.key,
      title: step.title,
      goal: step.goal,
      acceptance: step.acceptance,
      status: step.status,
      result: resultEvidence(step.result),
      error: step.error,
    }));
    return [
      '你是 Agent Hub 的中央协调者，现在进行最终证据评审，不要调用工具。',
      '只根据返回证据判断，不能虚构测试或业务验收。每个子步骤及父任务验收都必须明确通过，才能 parent_pass=true。证据不足或不符合时对应步骤 pass=false，parent_pass=false。',
      '只输出 JSON：{"parent_pass":true,"reason":"整体结论","steps":[{"key":"step-1","pass":true,"reason":"该步骤的证据结论"}]}',
      '必须包含每个步骤且 key 完全一致，不要增加其他文本。',
      '父任务 JSON:',
      JSON.stringify(parent, null, 2),
      '步骤与证据 JSON:',
      JSON.stringify(steps, null, 2),
    ].join('\n\n');
  }

  requestReview(orchestration) {
    const parent = this.store.getTask(orchestration.parent_task_id);
    const reviewing = this.store.updateOrchestration(orchestration.orchestration_id, {
      status: 'review',
      error: null,
    });
    this.store.updateTask(parent.task_id, { status: 'review' });
    const command = this.store.createCommand({
      task_id: parent.task_id,
      worker_id: orchestration.coordinator_worker_id,
      kind: 'coordinator_review',
      input: this.reviewPrompt(reviewing),
      push_capable: true,
    });
    this.emit('coordinator.review.requested', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: parent.task_id,
      command_id: command.command_id,
      payload: { orchestration_id: orchestration.orchestration_id },
    });
    this.dispatch(command);
  }

  fail(orchestration, code, message) {
    const failed = this.store.updateOrchestration(orchestration.orchestration_id, {
      status: 'blocked',
      error: { code, message },
    });
    this.store.updateTask(orchestration.parent_task_id, { status: 'blocked' });
    this.emit('coordinator.blocked', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: orchestration.parent_task_id,
      payload: { orchestration_id: orchestration.orchestration_id, code, message },
    });
    return failed;
  }

  reviewNeeded(orchestration, code, message) {
    const reviewing = this.store.updateOrchestration(orchestration.orchestration_id, {
      status: 'review',
      error: { code, message },
    });
    this.store.updateTask(orchestration.parent_task_id, { status: 'review' });
    this.emit('coordinator.review_required', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: orchestration.parent_task_id,
      payload: { orchestration_id: orchestration.orchestration_id, code, message },
    });
    return reviewing;
  }

  acceptPlan(orchestration, result) {
    let plan;
    try {
      plan = validatePlan(jsonDocument(result?.text), this.eligibleRegistry(orchestration.coordinator_worker_id), this.store.getCoordinatorConfig().max_steps);
    } catch (error) {
      return this.fail(orchestration, 'coordinator_plan_invalid', error.message);
    }
    const steps = plan.steps.map((step) => {
      const task = this.store.createTask({
        title: step.title,
        goal: step.goal,
        context: step.context,
        acceptance: step.acceptance,
        assignee_worker_id: null,
        created_by: 'coordinator',
      });
      return { ...step, task_id: task.task_id };
    });
    const updated = this.store.updateOrchestration(orchestration.orchestration_id, {
      status: 'in_progress',
      summary: plan.summary,
      steps,
      error: null,
    });
    this.emit('coordinator.plan.accepted', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: orchestration.parent_task_id,
      payload: { orchestration_id: orchestration.orchestration_id, summary: plan.summary, step_count: steps.length },
    });
    this.pump(updated);
  }

  acceptReview(orchestration, result) {
    let review;
    try {
      review = validateReview(jsonDocument(result?.text), orchestration.steps);
    } catch (error) {
      return this.reviewNeeded(orchestration, 'coordinator_review_invalid', error.message);
    }
    const steps = orchestration.steps.map((step) => {
      const verdict = review.verdicts.get(step.key);
      const status = verdict.pass ? 'done' : 'review';
      this.store.updateTask(step.task_id, { status });
      return { ...step, status, review: { pass: verdict.pass, reason: verdict.reason } };
    });
    if (review.parentPass && steps.every((step) => step.status === 'done')) {
      const completed = this.store.updateOrchestration(orchestration.orchestration_id, {
        status: 'done',
        steps,
        error: null,
      });
      this.store.updateTask(orchestration.parent_task_id, { status: 'done' });
      this.emit('coordinator.completed', { type: 'worker', id: orchestration.coordinator_worker_id }, {
        task_id: orchestration.parent_task_id,
        payload: { orchestration_id: orchestration.orchestration_id, reason: review.reason },
      });
      return completed;
    }
    const updated = this.store.updateOrchestration(orchestration.orchestration_id, { steps });
    return this.reviewNeeded(updated, 'coordinator_review_rejected', review.reason);
  }

  workerAvailable(worker, taskId) {
    if (worker.work_state === 'working') return false;
    if (!worker.current_task_id || worker.current_task_id === taskId) return true;
    const current = this.store.getTask(worker.current_task_id);
    return current ? FINISHED_STEP_STATUSES.has(current.status) || ['cancelled', 'blocked'].includes(current.status) : true;
  }

  workPrompt(orchestration, step) {
    const parent = this.store.getTask(orchestration.parent_task_id);
    return [
      '你正在执行中央大脑分配的一个步骤。只完成当前步骤，不要修改其他任务，不要读取 Admin Token。',
      '返回简洁、真实的结果报告：完成内容、修改的文件、实际测试及结果。不要虚构证据。',
      '父任务背景 JSON:',
      JSON.stringify(parent, null, 2),
      '当前步骤 JSON:',
      JSON.stringify({ ...step, command_id: undefined }, null, 2),
    ].join('\n\n');
  }

  pump(orchestration) {
    let current = this.store.getOrchestration(orchestration.orchestration_id);
    if (current.status !== 'in_progress') return;
    if (current.steps.some((step) => step.status === 'blocked')) {
      const step = current.steps.find((item) => item.status === 'blocked');
      this.fail(current, 'coordinator_step_failed', step.error?.message ?? `Step ${step.key} failed`);
      return;
    }
    if (current.steps.length && current.steps.every((step) => FINISHED_STEP_STATUSES.has(step.status))) {
      this.requestReview(current);
      return;
    }
    let changed = false;
    for (const step of current.steps) {
      if (step.status !== 'ready') continue;
      const dependenciesReady = step.depends_on.every((key) => {
        const dependency = current.steps.find((item) => item.key === key);
        return dependency && FINISHED_STEP_STATUSES.has(dependency.status);
      });
      if (!dependenciesReady) continue;
      const worker = this.store.getWorker(step.worker_id);
      if (!worker || !worker.push_capable || worker.presence !== 'online' || !this.workerAvailable(worker, step.task_id)) continue;
      this.store.updateTask(step.task_id, { assignee_worker_id: worker.worker_id });
      const command = this.store.createCommand({
        task_id: step.task_id,
        worker_id: worker.worker_id,
        kind: 'prompt',
        input: this.workPrompt(current, step),
        push_capable: true,
      });
      step.command_id = command.command_id;
      step.status = 'running';
      step.error = null;
      changed = true;
      this.emit('coordinator.step.dispatched', { type: 'worker', id: worker.worker_id }, {
        connector_id: worker.connector_id,
        worker_id: worker.worker_id,
        task_id: step.task_id,
        command_id: command.command_id,
        payload: { orchestration_id: current.orchestration_id, key: step.key },
      });
      this.dispatch(command);
    }
    if (changed) this.store.updateOrchestration(current.orchestration_id, { steps: current.steps });
  }

  onCommandFinished(command) {
    if (['coordinator_plan', 'coordinator_review'].includes(command.kind)) {
      const orchestration = this.store.getOrchestrationByTask(command.task_id);
      if (!orchestration) return true;
      if (command.kind === 'coordinator_plan') {
        if (orchestration.status !== 'planning') return true;
        if (command.status !== 'succeeded' || command.outcome_unknown) {
          this.fail(orchestration, 'coordinator_plan_failed', command.error?.message ?? 'Coordinator planning failed');
        } else {
          this.acceptPlan(orchestration, command.result);
        }
      } else {
        if (orchestration.status !== 'review') return true;
        if (command.status !== 'succeeded' || command.outcome_unknown) {
          this.reviewNeeded(orchestration, 'coordinator_review_failed', command.error?.message ?? 'Coordinator review failed');
        } else {
          this.acceptReview(orchestration, command.result);
        }
      }
      return true;
    }
    for (const orchestration of this.store.listOrchestrations({ active: true })) {
      const step = orchestration.steps.find((item) => item.command_id === command.command_id);
      if (!step) continue;
      if (orchestration.status !== 'in_progress') return true;
      if (command.status === 'succeeded' && !command.outcome_unknown) {
        step.status = 'review';
        step.result = command.result;
        step.error = null;
        this.store.updateTask(step.task_id, { status: 'review' });
      } else {
        step.status = 'blocked';
        step.error = command.error ?? { message: 'Command failed', code: 'command_failed' };
        this.store.updateTask(step.task_id, { status: 'blocked' });
      }
      this.store.updateOrchestration(orchestration.orchestration_id, { steps: orchestration.steps });
      this.emit('coordinator.step.finished', { type: 'worker', id: command.worker_id }, {
        task_id: step.task_id,
        command_id: command.command_id,
        payload: { orchestration_id: orchestration.orchestration_id, key: step.key, status: step.status },
      });
      if (step.status === 'blocked') this.fail(orchestration, 'coordinator_step_failed', step.error.message);
      else this.pump(orchestration);
      return true;
    }
    return false;
  }

  present(orchestration) {
    if (!orchestration) return null;
    return {
      ...orchestration,
      parent_task: this.store.getTask(orchestration.parent_task_id),
      coordinator_worker: this.store.getWorker(orchestration.coordinator_worker_id),
      steps: orchestration.steps.map((step) => ({
        ...step,
        worker_name: this.store.getWorker(step.worker_id)?.name ?? null,
      })),
    };
  }

  list() {
    return this.store.listOrchestrations().map((orchestration) => this.present(orchestration));
  }

  get(orchestrationId) {
    return this.present(this.store.getOrchestration(orchestrationId));
  }

  listForConnector(connectorId) {
    return this.list().filter((orchestration) => {
      if (orchestration.parent_task?.created_by === `connector:${connectorId}`) return true;
      if (orchestration.coordinator_worker?.connector_id === connectorId) return true;
      return orchestration.steps.some((step) => this.store.getWorker(step.worker_id)?.connector_id === connectorId);
    });
  }

  async resume() {
    for (const pending of this.store.listOrchestrations({ active: true })) {
      const orchestration = this.store.getOrchestration(pending.orchestration_id);
      const commands = this.store.listCommands({ taskId: orchestration.parent_task_id });
      if (orchestration.status === 'planning') {
        const plan = commands.find((command) => command.kind === 'coordinator_plan');
        if (plan && FINAL_COMMAND_STATUSES.has(plan.status)) this.onCommandFinished(plan);
        else if (!plan) this.requestPlan(orchestration, this.store.getTask(orchestration.parent_task_id), this.eligibleRegistry(orchestration.coordinator_worker_id));
        continue;
      }
      if (orchestration.status === 'in_progress') {
        for (const step of orchestration.steps) {
          if (step.status !== 'running') continue;
          const command = step.command_id ? this.store.getCommand(step.command_id) : null;
          if (command && FINAL_COMMAND_STATUSES.has(command.status)) this.onCommandFinished(command);
          else if (!command) {
            step.status = 'ready';
            step.command_id = null;
            this.store.updateOrchestration(orchestration.orchestration_id, { steps: orchestration.steps });
          }
        }
        this.pump(orchestration);
        continue;
      }
      if (orchestration.status === 'review' && !orchestration.error) {
        const review = commands.find((command) => command.kind === 'coordinator_review');
        if (review && FINAL_COMMAND_STATUSES.has(review.status)) this.onCommandFinished(review);
        else if (!review) this.requestReview(orchestration);
      }
    }
  }
}
