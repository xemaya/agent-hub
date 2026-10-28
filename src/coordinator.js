import { createId } from './ids.js';

const FINAL_COMMAND_STATUSES = new Set(['succeeded', 'failed']);
const FINISHED_STEP_STATUSES = new Set(['review', 'done']);
const DEPENDENCY_EVIDENCE_BUDGET = 64000;
const REFERENCE_EVIDENCE_BUDGET = 24000;
const MAX_RECOVERY_ROUNDS = 2;

function taskLabel(task) {
  const reference = Number.isInteger(task?.task_number) ? `#${String(task.task_number).padStart(4, '0')} · ` : '';
  return `${reference}${task?.title ?? '任务'}`;
}

function validateChatResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw coordinatorError('Chat response must be a JSON object');
  const reply = text(value.reply, 'chat.reply', { max: 12000 });
  const action = value.action;
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw coordinatorError('Chat action must be an object');
  if (action.type === 'chat') return { reply, action: { type: 'chat' } };
  if (['plan', 'orchestrate'].includes(action.type)) {
    const task = action.task;
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw coordinatorError('Chat task must be an object');
    const criteria = acceptance(task.acceptance, 'chat.task.acceptance');
    if (!criteria.length) throw coordinatorError('Chat task needs at least one acceptance criterion');
    return {
      reply,
      action: {
        type: action.type,
        task: {
          title: text(task.title, 'chat.task.title', { max: 300 }),
          goal: text(task.goal, 'chat.task.goal'),
          context: text(task.context ?? '', 'chat.task.context', { required: false }),
          acceptance: criteria,
        },
      },
    };
  }
  if (action.type === 'start') {
    return {
      reply,
      action: {
        type: 'start',
        orchestrationId: text(action.orchestration_id, 'chat.orchestration_id', { max: 100 }),
      },
    };
  }
  throw coordinatorError('Unsupported chat action');
}

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

// Only online Workers with a live interactive Channel can receive pushed work.
function canReceivePush(worker) {
  return Boolean(worker && !worker.retired_at && worker.push_capable && worker.presence === 'online');
}

function resultText(result) {
  if (typeof result?.text === 'string') return result.text;
  return result == null ? '' : JSON.stringify(result);
}

function resultEvidence(result, max = 12000) {
  return resultText(result).slice(0, max);
}

export class Coordinator {
  constructor({ store, emit, dispatch, notify = () => {}, logger = console }) {
    this.store = store;
    this.emit = emit;
    this.dispatch = dispatch;
    this.notify = notify;
    this.logger = logger;
  }

  configuredWorker() {
    const config = this.store.getCoordinatorConfig();
    const worker = config.worker_id ? this.store.getWorker(config.worker_id) : null;
    if (!config.enabled || !worker) throw coordinatorError('Coordinator is not configured', 'coordinator_disabled');
    if (!canReceivePush(worker)) {
      throw coordinatorError('Coordinator must be online with an attached interactive Channel', 'coordinator_worker_invalid');
    }
    return { config, worker };
  }

  recordActivity(orchestration, key, content) {
    if (!orchestration.source_message_id) return null;
    const sourceKey = `orchestration:${orchestration.orchestration_id}:${key}`;
    if (this.store.getChatMessageBySourceKey(sourceKey)) return null;
    const message = this.store.createChatMessage({
      role: 'activity',
      content: text(content, 'activity.content', { max: 12000 }),
      taskId: orchestration.parent_task_id,
      sourceKey,
    });
    this.notify(message);
    return message;
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
      if (!canReceivePush(worker)) {
        throw coordinatorError('Coordinator must be online with an attached interactive Channel', 'coordinator_worker_invalid');
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

  resolveMentions(value, coordinatorWorkerId) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) {
      throw coordinatorError('Mentions must be an array of at most 8 Worker or Task references', 'mentions_invalid');
    }
    const mentions = [];
    const seen = new Set();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !['worker', 'task'].includes(item.type)) {
        throw coordinatorError('Each mention must identify a Worker or Task', 'mentions_invalid');
      }
      const id = text(item.id, 'mention.id', { max: 128 });
      const key = `${item.type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (item.type === 'worker') {
        const worker = this.store.getWorker(id);
        if (!worker) throw coordinatorError('Mentioned Worker does not exist', 'mention_worker_not_found', 404);
        if (worker.worker_id === coordinatorWorkerId || !canReceivePush(worker)) {
          throw coordinatorError('Mentioned Worker must be online and able to receive pushed work', 'mention_worker_unavailable', 409);
        }
      } else {
        const task = this.store.getTask(id);
        if (!task || task.deleted_at) throw coordinatorError('Mentioned Task does not exist', 'mention_task_not_found', 404);
      }
      mentions.push({ type: item.type, id });
    }
    return mentions;
  }

  mentionedWorkerIds(message) {
    return (message?.mentions ?? []).filter((mention) => mention.type === 'worker').map((mention) => mention.id);
  }

  orchestrationWorkerIds(orchestration) {
    const message = orchestration.source_message_id ? this.store.getChatMessage(orchestration.source_message_id) : null;
    return this.mentionedWorkerIds(message);
  }

  orchestrationTaskIds(orchestration) {
    const message = orchestration.source_message_id ? this.store.getChatMessage(orchestration.source_message_id) : null;
    return (message?.mentions ?? []).filter((mention) => mention.type === 'task').map((mention) => mention.id);
  }

  taskReference(taskId, { resultBudget = null } = {}) {
    const task = this.store.getTask(taskId);
    if (!task || task.deleted_at) return null;
    const orchestration = this.store.getOrchestrationByTask(taskId)
      ?? this.store.listOrchestrations().find((item) => item.steps.some((step) => step.task_id === taskId));
    const stepCount = orchestration?.steps.length ?? 0;
    const resultLimit = Math.max(1, Math.floor((resultBudget ?? stepCount * 600) / Math.max(stepCount, 1)));
    return {
      task: {
        ...task,
        goal: task.goal.slice(0, 4000),
        context: task.context.slice(0, 4000),
        acceptance: task.acceptance.slice(0, 8).map((item) => item.slice(0, 300)),
      },
      orchestration: orchestration ? {
        orchestration_id: orchestration.orchestration_id,
        parent_task_id: orchestration.parent_task_id,
        status: orchestration.status,
        auto_start: orchestration.auto_start,
        summary: orchestration.summary.slice(0, 1000),
        review_reason: orchestration.review_reason.slice(0, 1000),
        error: orchestration.error,
        steps: orchestration.steps.map((step) => ({
          key: step.key,
          task_id: step.task_id,
          title: step.title,
          status: step.status,
          worker_id: step.worker_id,
          result: resultEvidence(step.result, resultLimit),
          result_truncated: resultText(step.result).length > resultLimit,
        })),
      } : null,
    };
  }

  workerRegistry() {
    return this.store.listWorkers().map((worker) => ({
      worker_id: worker.worker_id,
      name: worker.name,
      connector_id: worker.connector_id,
      connector_name: worker.connector_name,
      runtime: worker.runtime,
      push_capable: worker.push_capable,
      capabilities: worker.capabilities,
      description: typeof worker.metadata?.description === 'string' ? worker.metadata.description : '',
      cwd: worker.cwd,
      presence: worker.presence,
      work_state: worker.work_state,
      current_task_id: worker.current_task_id,
      current_task_title: worker.current_task_id ? this.store.getTask(worker.current_task_id)?.title ?? null : null,
    }));
  }

  eligibleRegistry(excludeWorkerId = this.store.getCoordinatorConfig().worker_id, workerIds = []) {
    const allowed = new Set(workerIds);
    return this.workerRegistry().filter((worker) => (
      worker.worker_id !== excludeWorkerId
      && canReceivePush(worker)
      && (!allowed.size || allowed.has(worker.worker_id))
    ));
  }

  createOrchestration({ title, goal, context, acceptance: criteria, createdBy, actor, autoStart = true, sourceMessageId = null, workerIds = [] }) {
    if (sourceMessageId) {
      const existing = this.store.getOrchestrationBySourceMessage(sourceMessageId);
      if (existing) return { task: this.store.getTask(existing.parent_task_id), orchestration: existing };
    }
    const { config } = this.configuredWorker();
    const registry = this.eligibleRegistry(config.worker_id, workerIds);
    if (!registry.length) throw coordinatorError('No eligible Workers are available for orchestration', 'coordinator_no_workers');
    const created = this.store.createOrchestratedTask({
      title: text(title, 'title', { max: 300 }),
      goal: typeof goal === 'string' ? goal : '',
      context: typeof context === 'string' ? context : '',
      acceptance: criteria ?? [],
      createdBy,
      coordinatorWorkerId: config.worker_id,
      sourceMessageId,
      autoStart,
    });
    const { task: parent, orchestration } = created;
    this.emit('task.created', actor, {
      task_id: parent.task_id,
      payload: { title: parent.title, orchestrated: true, auto_start: orchestration.auto_start },
    });
    this.emit('coordinator.started', actor, {
      task_id: parent.task_id,
      worker_id: config.worker_id,
      payload: { orchestration_id: orchestration.orchestration_id, auto_start: orchestration.auto_start },
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
    const mentionedWorkerIds = this.orchestrationWorkerIds(orchestration);
    const input = [
      '你是 Agent Hub 的中央协调者。你只负责规划和最终评审，不能调用工具或修改任务。',
      '根据总目标和 Worker 自描述选择最合适的 Worker。一步能完成就不要硬拆，只有确实需要时才拆步骤。',
      '只输出一个 JSON 对象，不要 Markdown、解释或额外文本。schema:',
      '{"summary":"计划摘要","steps":[{"key":"step-1","title":"...","goal":"...","context":"...","acceptance":["可检查的标准"],"worker_id":"worker_...","depends_on":[],"rationale":"选择该 Worker 的原因"}]}',
      `最多 ${config.max_steps} 步；每步至少一条验收标准；depends_on 使用已有 key，不允许环。不要使用协调者自己或列表外的 worker_id。优先能力匹配和空闲 Worker。`,
      ...(mentionedWorkerIds.length ? [`用户通过 @ 明确限定了执行 Worker：${mentionedWorkerIds.join('、')}。只能从可用列表选择这些 Worker，不得改派他人；不必为了用完人数而拆步骤。`] : []),
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
      result_truncated: resultText(step.result).length > 12000,
      result_incomplete: Boolean(step.result?.output_gap),
      error: step.error,
    }));
    return [
      '你是 Agent Hub 的中央协调者，现在进行最终证据评审，不要调用工具。',
      '只根据返回证据判断，不能虚构测试或业务验收。每个子步骤及父任务验收都必须明确通过，才能 parent_pass=true。证据不足或不符合时对应步骤 pass=false，parent_pass=false。result_truncated=true 或 result_incomplete=true 表示证据不完整，无法据此确认的验收不得通过。',
      'reason 用简洁中文说明实际交付、验收依据和未覆盖事项；修改建议不能写成已经落实。',
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
    const input = this.reviewPrompt({ ...orchestration, status: 'review', error: null });
    this.store.updateOrchestration(orchestration.orchestration_id, {
      status: 'review',
      error: null,
      reviewCommandId: null,
    });
    this.store.updateTask(parent.task_id, { status: 'review' });
    const command = this.store.createCommand({
      task_id: parent.task_id,
      worker_id: orchestration.coordinator_worker_id,
      kind: 'coordinator_review',
      input,
      push_capable: true,
    });
    this.store.updateOrchestration(orchestration.orchestration_id, { reviewCommandId: command.command_id });
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
    this.recordActivity(failed, 'blocked', `任务已停止：${String(message).slice(0, 4000)}\n不会自动重试；你可以在对话中说明下一步怎么处理。`);
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
    const next = reviewing.recovery_count
      ? `已完成 ${reviewing.recovery_count} 轮自动修正，任务仍未完成；可以 @任务 补充信息或调整验收。`
      : '任务没有标记为完成；可以 @任务 补充信息。';
    const activityKey = reviewing.recovery_count ? `review-required:${reviewing.recovery_count}` : 'review-required';
    this.recordActivity(reviewing, activityKey, `评审还需要关注：${String(message).slice(0, 4000)}\n${next}`);
    this.emit('coordinator.review_required', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: orchestration.parent_task_id,
      payload: { orchestration_id: orchestration.orchestration_id, code, message },
    });
    return reviewing;
  }

  acceptPlan(orchestration, result) {
    let plan;
    try {
      plan = validatePlan(
        jsonDocument(result?.text),
        this.eligibleRegistry(orchestration.coordinator_worker_id, this.orchestrationWorkerIds(orchestration)),
        this.store.getCoordinatorConfig().max_steps,
      );
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
      return { ...step, task_id: task.task_id, task_number: task.task_number };
    });
    const status = orchestration.auto_start ? 'in_progress' : 'ready';
    const updated = this.store.updateOrchestration(orchestration.orchestration_id, {
      status,
      summary: plan.summary,
      steps,
      error: null,
    });
    this.store.updateTask(orchestration.parent_task_id, { status });
    const arrangement = steps.map((step, index) => (
      `${index + 1}. ${step.title}（${this.store.getWorker(step.worker_id)?.name ?? '等待匹配员工'}）`
    )).join('\n');
    this.recordActivity(updated, 'plan', `已安排 ${steps.length} 个步骤：\n${arrangement}${orchestration.auto_start ? '' : '\n尚未执行。'}`);
    this.emit('coordinator.plan.accepted', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: orchestration.parent_task_id,
      payload: { orchestration_id: orchestration.orchestration_id, summary: plan.summary, step_count: steps.length },
    });
    if (updated.auto_start) this.pump(updated);
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
        reviewReason: review.reason,
      });
      this.store.updateTask(orchestration.parent_task_id, { status: 'done' });
      const parent = this.store.getTask(completed.parent_task_id);
      const deliverables = steps.filter((step) => resultText(step.result).trim()).length;
      const acceptanceCount = parent?.acceptance.length ?? 0;
      this.recordActivity(completed, 'completed', `「${taskLabel(parent)}」已完成。${deliverables} 项交付结果${acceptanceCount ? ` · ${acceptanceCount} 条整体验收通过` : ' · 终审通过'}。`);
      this.emit('coordinator.completed', { type: 'worker', id: orchestration.coordinator_worker_id }, {
        task_id: orchestration.parent_task_id,
        payload: { orchestration_id: orchestration.orchestration_id, reason: review.reason },
      });
      return completed;
    }
    const updated = this.store.updateOrchestration(orchestration.orchestration_id, { steps, reviewReason: review.reason });
    return this.recoverRejectedReview(updated);
  }

  recoverRejectedReview(orchestration) {
    if (orchestration.recovery_count >= MAX_RECOVERY_ROUNDS) {
      return this.reviewNeeded(orchestration, 'coordinator_review_rejected', orchestration.review_reason);
    }
    const reworkKeys = new Set(orchestration.steps.filter((step) => step.status !== 'done').map((step) => step.key));
    if (!reworkKeys.size) {
      return this.reviewNeeded(
        orchestration,
        'coordinator_review_rejected',
        `${orchestration.review_reason}\n终审未指出需要重做的步骤，无法自动推进。`,
      );
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const step of orchestration.steps) {
        if (!reworkKeys.has(step.key) && step.depends_on.some((key) => reworkKeys.has(key))) {
          reworkKeys.add(step.key);
          expanded = true;
        }
      }
    }
    const recoveryCount = orchestration.recovery_count + 1;
    const steps = orchestration.steps.map((step) => {
      if (!reworkKeys.has(step.key)) return step;
      return {
        ...step,
        attempt: (step.attempt ?? 1) + 1,
        previous_attempts: [
          ...(step.previous_attempts ?? []),
          {
            attempt: step.attempt ?? 1,
            command_id: step.command_id,
            result: step.result,
            error: step.error,
            review: step.review,
          },
        ],
        status: 'ready',
        command_id: null,
        result: null,
        error: null,
        review: null,
      };
    });
    for (const step of steps) {
      if (reworkKeys.has(step.key)) {
        this.store.updateTask(step.task_id, { status: 'ready', assignee_worker_id: null });
      }
    }
    const updated = this.store.updateOrchestration(orchestration.orchestration_id, {
      status: 'in_progress',
      steps,
      error: null,
      recoveryCount,
      reviewCommandId: null,
    });
    this.store.updateTask(orchestration.parent_task_id, { status: 'in_progress' });
    this.recordActivity(
      updated,
      `recovery:${recoveryCount}`,
      `终审未通过，中央大脑已开始第 ${recoveryCount} 次修正：重做 ${reworkKeys.size} 个步骤，并带上上轮结果和验收意见。`,
    );
    this.emit('coordinator.recovery.started', { type: 'worker', id: orchestration.coordinator_worker_id }, {
      task_id: orchestration.parent_task_id,
      payload: { orchestration_id: orchestration.orchestration_id, recovery_count: recoveryCount, steps: [...reworkKeys] },
    });
    this.pump(updated);
    return this.store.getOrchestration(orchestration.orchestration_id);
  }

  workerAvailable(worker, taskId) {
    if (worker.retired_at || worker.work_state === 'working') return false;
    if (!worker.current_task_id || worker.current_task_id === taskId) return true;
    const current = this.store.getTask(worker.current_task_id);
    return current ? FINISHED_STEP_STATUSES.has(current.status) || ['cancelled', 'blocked'].includes(current.status) : true;
  }

  workPrompt(orchestration, step) {
    const parent = this.store.getTask(orchestration.parent_task_id);
    const dependencies = step.depends_on.map((key) => orchestration.steps.find((item) => item.key === key)).filter(Boolean);
    const dependencyLimit = Math.max(1, Math.floor(DEPENDENCY_EVIDENCE_BUDGET / Math.max(dependencies.length, 1)));
    const dependencyResults = dependencies.map((dependency) => ({
      key: dependency.key,
      title: dependency.title,
      status: dependency.status,
      worker_name: this.store.getWorker(dependency.worker_id)?.name ?? dependency.worker_id,
      result: resultEvidence(dependency.result, dependencyLimit),
      result_truncated: resultText(dependency.result).length > dependencyLimit,
      result_incomplete: Boolean(dependency.result?.output_gap),
    }));
    const referenceIds = this.orchestrationTaskIds(orchestration);
    const referenceLimit = Math.max(1, Math.floor(REFERENCE_EVIDENCE_BUDGET / Math.max(referenceIds.length, 1)));
    const references = referenceIds.map((taskId) => this.taskReference(taskId, { resultBudget: referenceLimit })).filter(Boolean);
    const recovering = (step.attempt ?? 1) > 1;
    const recoveryLimit = Math.max(1, Math.floor(DEPENDENCY_EVIDENCE_BUDGET / Math.max(orchestration.steps.length, 1)));
    const recoveryContext = recovering ? {
      recovery_round: orchestration.recovery_count,
      overall_review: orchestration.review_reason,
      instruction: '针对上次未满足的验收重新执行，不要只复述旧结果。其他步骤的结果可能包含纠正信息，先核实再行动。',
      steps: orchestration.steps.map((item) => {
        const previous = item.previous_attempts?.at(-1);
        const result = item.result ?? previous?.result ?? null;
        return {
          key: item.key,
          title: item.title,
          result: resultEvidence(result, recoveryLimit),
          result_truncated: resultText(result).length > recoveryLimit,
          result_incomplete: Boolean(result?.output_gap),
          review: item.review ?? previous?.review ?? null,
        };
      }),
    } : null;
    return [
      '你正在执行中央大脑分配的一个步骤。只完成当前步骤，不要修改其他任务，不要读取 Admin Token。',
      '返回真实结果：完成内容、修改的文件、实际测试及结果。文案交付请直接给出完整正文，不要只给摘要。不要虚构证据。',
      '依赖和历史任务的实际结果已经附在下面，不需要自行查询 Hub。result_truncated=true 或 result_incomplete=true 表示内容不完整，不能声称已完整阅读；不足以完成当前步骤时如实说明。',
      '父任务背景 JSON:',
      JSON.stringify(parent, null, 2),
      '当前步骤 JSON:',
      JSON.stringify({ ...step, command_id: undefined, previous_attempts: undefined }, null, 2),
      '已完成依赖步骤的真实结果 JSON:',
      JSON.stringify(dependencyResults, null, 2),
      '对话中引用的历史任务 JSON（作为上下文，不代表重启旧任务）:',
      JSON.stringify(references, null, 2),
      ...(recoveryContext ? [
        '上次终审与本次修正上下文 JSON:',
        JSON.stringify(recoveryContext, null, 2),
      ] : []),
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
    if (command.kind === 'worker_chat') {
      this.acceptWorkerChat(command);
      return true;
    }
    if (command.kind === 'coordinator_chat') {
      this.acceptChat(command);
      return true;
    }
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
        if (orchestration.review_command_id && orchestration.review_command_id !== command.command_id) return true;
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
      const updated = this.store.updateOrchestration(orchestration.orchestration_id, { steps: orchestration.steps });
      this.emit('coordinator.step.finished', { type: 'worker', id: command.worker_id }, {
        task_id: step.task_id,
        command_id: command.command_id,
        payload: { orchestration_id: orchestration.orchestration_id, key: step.key, status: step.status },
      });
      if (step.status === 'blocked') this.fail(updated, 'coordinator_step_failed', step.error.message);
      else {
        const workerName = this.store.getWorker(command.worker_id)?.name ?? '数字员工';
        const next = updated.steps.find((candidate) => candidate.status === 'ready' && candidate.depends_on.every((key) => {
          const dependency = updated.steps.find((item) => item.key === key);
          return dependency && FINISHED_STEP_STATUSES.has(dependency.status);
        }));
        const nextWorker = next ? this.store.getWorker(next.worker_id)?.name ?? '数字员工' : null;
        const nextStep = next
          ? `下一步：${nextWorker} 处理「${next.title}」。`
          : '下一步：中央大脑核对结果和整体验收。';
        this.recordActivity(updated, `step:${step.key}`, `${workerName} 已返回「${step.title}」，等待验收。\n${nextStep}`);
        this.pump(updated);
      }
      return true;
    }
    return false;
  }

  chatPrompt(userMessage) {
    const history = this.store.listChatMessages({ limit: 20, epoch: this.store.conversationEpoch() })
      .filter((message) => message.message_id !== userMessage.message_id && message.status === 'done')
      .slice(-12)
      .map((message) => ({
        role: message.role,
        speaker: this.presentChatMessage(message).speaker,
        content: message.content.slice(0, 2000),
      }));
    const orchestrations = this.list().slice(0, 10).map((orchestration) => ({
      orchestration_id: orchestration.orchestration_id,
      parent_task_id: orchestration.parent_task_id,
      task_number: orchestration.parent_task?.task_number,
      title: orchestration.parent_task?.title,
      goal: orchestration.parent_task?.goal?.slice(0, 1200),
      acceptance: orchestration.parent_task?.acceptance?.slice(0, 8).map((item) => item.slice(0, 300)),
      status: orchestration.status,
      recovery_count: orchestration.recovery_count,
      auto_start: orchestration.auto_start,
      summary: orchestration.summary.slice(0, 1000),
      review_reason: orchestration.review_reason.slice(0, 1000),
      error: orchestration.error ? {
        code: orchestration.error.code,
        message: String(orchestration.error.message ?? '').slice(0, 500),
      } : null,
      steps: orchestration.steps.map((step) => ({
        title: step.title,
        status: step.status,
        worker_name: step.worker_name,
        result: resultEvidence(step.result).slice(0, 600),
        review: step.review ?? null,
        error: step.error ? String(step.error.message ?? '').slice(0, 500) : null,
      })),
    }));
    const workerIds = this.mentionedWorkerIds(userMessage);
    const references = {
      workers: this.workerRegistry().filter((worker) => workerIds.includes(worker.worker_id)),
      tasks: (userMessage.mentions ?? [])
        .filter((mention) => mention.type === 'task')
        .map((mention) => this.taskReference(mention.id))
        .filter(Boolean),
    };
    return [
      '你是 Agent Hub 的中央大脑，正在和管理员对话。你可以回答问题、解释真实进展、规划任务和启动任务。不要调用工具，不要读取凭证。',
      '只能根据提供的对话、任务快照和 Worker 自描述陈述事实。不能虚构执行、测试或完成情况。没有明确要求做事时不要创建任务。',
      '只输出一个 JSON 对象。普通问答或需要澄清时使用：{"reply":"中文回答","action":{"type":"chat"}}。',
      '用户明确要求只记录、只规划、先不要执行时，使用 plan；用户明确要求完成、修复、安排并执行新工作时，使用 orchestrate。两者格式均为：{"reply":"简短确认","action":{"type":"plan|orchestrate","task":{"title":"简短标题","goal":"整体目标","context":"用户已提供的上下文","acceptance":["可检查的整体验收"]}}}。plan 不执行；orchestrate 会开始执行。',
      '用户要启动之前已规划且 status=ready 的任务时，使用：{"reply":"简短确认","action":{"type":"start","orchestration_id":"快照中的真实 ID"}}。start 只用于 ready；不要重试 blocked/review，不要重复启动已完成或正在执行的任务。',
      '界面传入的 @ 引用已经由 Hub 核验。用户明确给 @员工 派新工作时使用 plan 或 orchestrate，后续只能在引用的 Worker 中分配，不得改派；只是 @员工 提问或没有明确做事时不要创建任务。@任务 是阅读和讨论的上下文，不代表自动启动、重试或修改该任务。',
      '当且仅当用户只 @ 一位员工并进行提问或讨论时，action=chat 表示将原问题转交该员工本人。此时 reply 只需简短说明会转交，绝对不要代替该员工回答，也不要把自描述摘要冒充员工本人的回复。',
      '用户明确要求根据 @任务 继续、修订或补充工作时，使用 plan 或 orchestrate 创建新工作；执行 Worker 会收到引用任务的结果。不要宣称已修改原任务或自动重试。',
      '回答进展或结果问题时可以概述真实步骤和实际交付；创建任务的确认不需要复述步骤。不要输出 worker_id、内部凭证或 Markdown。',
      '最近对话 JSON:',
      JSON.stringify(history, null, 2),
      '任务与编排快照 JSON:',
      JSON.stringify(orchestrations, null, 2),
      'Worker 自描述 JSON:',
      JSON.stringify(this.workerRegistry().slice(0, 50), null, 2),
      '本次结构化 @ 引用 JSON:',
      JSON.stringify(references, null, 2),
      '用户新消息:',
      userMessage.content,
    ].join('\n\n');
  }

  presentChatMessage(message) {
    const command = message.command_id ? this.store.getCommand(message.command_id) : null;
    if (command?.kind === 'worker_chat') {
      const worker = this.store.getWorker(command.worker_id);
      return {
        ...message,
        speaker: {
          type: 'worker',
          worker_id: command.worker_id,
          name: worker?.name ?? '数字员工',
        },
      };
    }
    return {
      ...message,
      speaker: message.role === 'coordinator'
        ? { type: 'coordinator', name: '中央大脑' }
        : { type: message.role },
    };
  }

  chatUserMessage(message) {
    const prefix = 'chat-reply:';
    if (!message.source_key?.startsWith(prefix)) return null;
    const user = this.store.getChatMessage(message.source_key.slice(prefix.length));
    return user?.role === 'user' ? user : null;
  }

  startWorkerChat(message, workerId) {
    const worker = this.store.getWorker(workerId);
    const user = this.chatUserMessage(message);
    if (!user) {
      this.completeChat(message, { status: 'failed', content: '没有找到要转交的原问题，请重新发送。' });
      return;
    }
    if (!canReceivePush(worker)) {
      this.completeChat(message, {
        status: 'failed',
        content: `${worker?.name ?? '这位员工'}当前不在线或不能主动接收问题，没有创建任务。`,
      });
      return;
    }
    const identity = this.workerRegistry().find((item) => item.worker_id === workerId);
    const taskIds = (user.mentions ?? []).filter((mention) => mention.type === 'task').map((mention) => mention.id);
    const resultBudget = Math.floor(REFERENCE_EVIDENCE_BUDGET / Math.max(taskIds.length, 1));
    const references = taskIds.map((taskId) => this.taskReference(taskId, { resultBudget })).filter(Boolean);
    const input = [
      '你是被管理员在 Agent Hub 操作台直接点名的数字员工。请亲自用中文回答，不要冒充中央大脑。',
      '这是直接问答，不是自动创建或修改任务的授权。可以在现有权限内核实事实，但不要创建任务、修改任务状态或虚构执行与验收。直接回答问题，不要只回复收到。',
      `你的身份与职责 JSON：${JSON.stringify(identity)}`,
      ...(references.length ? [`引用的任务上下文 JSON（若标记不完整，不得声称完整阅读）：${JSON.stringify(references)}`] : []),
      '管理员的原消息：',
      user.content,
    ].join('\n\n');
    try {
      const busy = worker.work_state === 'working';
      const { command, pending } = this.store.transaction(() => {
        const created = this.store.createCommand({
          task_id: null,
          worker_id: workerId,
          kind: 'worker_chat',
          input,
          push_capable: true,
        });
        const updated = this.store.updateChatMessage(message.message_id, {
          commandId: created.command_id,
          content: busy ? `${worker.name} 正在处理其他工作，你的问题已排队。` : `正在等待 ${worker.name} 本人回复。`,
        });
        if (!updated) throw coordinatorError('The chat reply no longer exists', 'chat_not_found', 404);
        return { command: created, pending: updated };
      });
      this.notify(pending);
      this.emit('coordinator.worker_chat.requested', { type: 'worker', id: workerId }, {
        command_id: command.command_id,
        payload: { message_id: user.message_id },
      });
      this.dispatch(command);
    } catch (error) {
      this.completeChat(message, {
        status: 'failed',
        content: `${worker.name} 的问题未能进入执行队列：${error.message}`,
      });
    }
  }

  acceptWorkerChat(command) {
    const message = this.store.getChatMessageByCommand(command.command_id);
    if (!message || message.status !== 'pending') return;
    const workerName = this.store.getWorker(command.worker_id)?.name ?? '这位员工';
    if (command.status !== 'succeeded' || command.outcome_unknown) {
      this.completeChat(message, {
        status: 'failed',
        content: `${workerName} 未能完成回复：${command.error?.message ?? '回复结果无法确认'}。`,
      });
      return;
    }
    const content = resultText(command.result).trim();
    if (!content) {
      this.completeChat(message, { status: 'failed', content: `${workerName} 没有返回可显示的回复。` });
      return;
    }
    this.completeChat(message, { content });
  }

  sendChat({ message, requestId, mentions }) {
    const { worker } = this.configuredWorker();
    const content = text(message, 'message', { max: 20000 });
    const normalizedMentions = this.resolveMentions(mentions, worker.worker_id);
    const normalizedRequestId = requestId == null
      ? createId('request')
      : text(requestId, 'request_id', { max: 128 });
    const user = this.store.createChatMessage({ role: 'user', content, requestId: normalizedRequestId, mentions: normalizedMentions });
    const sourceKey = `chat-reply:${user.message_id}`;
    const existing = this.store.getChatMessageBySourceKey(sourceKey);
    if (existing) return { user, message: this.presentChatMessage(existing) };
    let reply = this.store.createChatMessage({ role: 'coordinator', status: 'pending', sourceKey, mentions: user.mentions });
    try {
      const command = this.store.createCommand({
        task_id: null,
        worker_id: worker.worker_id,
        kind: 'coordinator_chat',
        input: this.chatPrompt(user),
        push_capable: true,
      });
      reply = this.store.updateChatMessage(reply.message_id, { commandId: command.command_id });
      this.notify(user);
      this.notify(reply);
      this.emit('coordinator.chat.requested', { type: 'worker', id: worker.worker_id }, {
        command_id: command.command_id,
        payload: { message_id: user.message_id },
      });
      this.dispatch(command);
      return { user, message: this.presentChatMessage(reply) };
    } catch (error) {
      if (!reply.command_id) {
        this.completeChat(reply, {
          status: 'failed',
          content: `消息未能进入执行队列：${error.message}`,
        });
      }
      throw error;
    }
  }

  completeChat(message, { content, status = 'done', taskId }) {
    const updated = this.store.updateChatMessage(message.message_id, { content, status, taskId });
    this.notify(updated);
    const config = this.store.getCoordinatorConfig();
    const command = updated.command_id ? this.store.getCommand(updated.command_id) : null;
    this.emit('coordinator.chat.finished', { type: 'worker', id: command?.worker_id ?? config.worker_id ?? 'coordinator' }, {
      command_id: updated.command_id,
      task_id: updated.task_id,
      payload: { message_id: updated.message_id, status: updated.status },
    });
    return updated;
  }

  taskChatReply(action, orchestration, started = false) {
    const task = this.store.getTask(orchestration.parent_task_id);
    const title = taskLabel(task);
    if (orchestration.status === 'blocked') {
      return `「${title}」未完成：${orchestration.error?.message ?? '规划或执行未完成'}。不会自动重试；可以引用任务并说明新的处理要求。`;
    }
    if (orchestration.status === 'done') {
      const deliverables = orchestration.steps.filter((step) => resultText(step.result).trim()).length;
      return `「${title}」已完成。${deliverables} 项交付结果${task?.acceptance.length ? ` · ${task.acceptance.length} 条整体验收通过` : ' · 终审通过'}。`;
    }
    if (orchestration.status === 'review' && orchestration.error) {
      return `「${title}」${orchestration.recovery_count ? '自动修正后仍未通过' : '验收未通过'}：${orchestration.error.message}。可以引用任务并补充信息或调整验收。`;
    }
    if (action.type === 'plan') {
      return orchestration.status === 'ready'
        ? `「${title}」已规划好，尚未执行。`
        : `已记录「${title}」，正在制定计划，尚未执行。`;
    }
    if (action.type === 'start') {
      const phases = { planning: '正在规划', in_progress: '正在执行', review: '正在验收', ready: '等待启动' };
      return started
        ? `已按原计划启动「${title}」，不会重新规划。`
        : `「${title}」${phases[orchestration.status] ?? '已有结果'}，没有重复启动。`;
    }
    return `已开始处理「${title}」。我会根据真实进展继续汇报，完成前会核对验收。`;
  }

  acceptChat(command) {
    const message = this.store.getChatMessageByCommand(command.command_id);
    if (!message || message.status !== 'pending') return;
    if (command.status !== 'succeeded' || command.outcome_unknown) {
      this.completeChat(message, {
        status: 'failed',
        content: `这次对话没有完成：${command.error?.message ?? '执行结果无法确认'}。未据此创建或启动任务。`,
      });
      return;
    }
    let response;
    try {
      response = validateChatResponse(jsonDocument(command.result?.text));
    } catch {
      this.completeChat(message, {
        status: 'failed',
        content: '这次回复无法正确理解，未创建或启动任务。请换一种说法再试。',
      });
      return;
    }
    try {
      const { action } = response;
      if (action.type === 'chat') {
        const workerIds = this.mentionedWorkerIds(message);
        if (workerIds.length === 1) this.startWorkerChat(message, workerIds[0]);
        else this.completeChat(message, { content: response.reply });
        return;
      }
      if (action.type === 'start') {
        const result = this.startOrchestration(action.orchestrationId);
        this.completeChat(message, {
          content: this.taskChatReply(action, result.orchestration, result.started),
          taskId: result.orchestration.parent_task_id,
        });
        return;
      }
      const created = this.createOrchestration({
        ...action.task,
        createdBy: 'admin',
        actor: { type: 'admin', id: 'admin' },
        autoStart: action.type === 'orchestrate',
        sourceMessageId: message.message_id,
        workerIds: this.mentionedWorkerIds(message),
      });
      this.completeChat(message, {
        content: this.taskChatReply(action, created.orchestration),
        taskId: created.task.task_id,
      });
    } catch (error) {
      this.completeChat(message, {
        status: 'failed',
        content: `这次请求没有执行：${error.message}`,
      });
    }
  }

  startOrchestration(orchestrationId) {
    const orchestration = this.store.getOrchestration(orchestrationId);
    if (!orchestration) throw coordinatorError('Orchestration not found', 'orchestration_not_found', 404);
    if (['planning', 'in_progress', 'review', 'done'].includes(orchestration.status)) {
      return { orchestration, started: false };
    }
    if (orchestration.status !== 'ready') {
      throw coordinatorError('Only a ready orchestration can be started; failed or reviewing tasks are not retried', 'orchestration_not_startable', 409);
    }
    const { config } = this.configuredWorker();
    if (orchestration.coordinator_worker_id !== config.worker_id) {
      throw coordinatorError('The configured Coordinator has changed', 'coordinator_changed', 409);
    }
    if (!this.eligibleRegistry(config.worker_id, this.orchestrationWorkerIds(orchestration)).length) {
      throw coordinatorError('No eligible Workers are available for this plan', 'coordinator_no_workers');
    }
    const updated = this.store.updateOrchestration(orchestrationId, { status: 'in_progress', error: null });
    this.store.updateTask(orchestration.parent_task_id, { status: 'in_progress' });
    this.recordActivity(updated, 'started', '已按现有计划启动，不会重新规划。');
    this.emit('coordinator.execution.started', { type: 'admin', id: 'admin' }, {
      task_id: orchestration.parent_task_id,
      worker_id: orchestration.coordinator_worker_id,
      payload: { orchestration_id: orchestrationId },
    });
    this.pump(updated);
    return { orchestration: this.store.getOrchestration(orchestrationId), started: true };
  }

  present(orchestration) {
    if (!orchestration) return null;
    const completed = !orchestration.review_reason && orchestration.status === 'done'
      ? this.store.latestTaskEvent(orchestration.parent_task_id, 'coordinator.completed')
      : null;
    return {
      ...orchestration,
      review_reason: orchestration.review_reason || completed?.payload?.reason || '',
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

  chat() {
    return this.store.listChatMessages({ epoch: this.store.conversationEpoch() })
      .map((message) => this.presentChatMessage(message));
  }

  listForConnector(connectorId) {
    return this.list().filter((orchestration) => {
      if (orchestration.parent_task?.created_by === `connector:${connectorId}`) return true;
      if (orchestration.coordinator_worker?.connector_id === connectorId) return true;
      return orchestration.steps.some((step) => this.store.getWorker(step.worker_id)?.connector_id === connectorId);
    });
  }

  resumeChat() {
    for (const message of this.store.listPendingChatMessages()) {
      const command = message.command_id ? this.store.getCommand(message.command_id) : null;
      if (!command) {
        this.completeChat(message, {
          status: 'failed',
          content: '服务在接收这条消息时中断，没有发出执行请求。请重新发送。',
        });
      } else if (FINAL_COMMAND_STATUSES.has(command.status)) {
        this.onCommandFinished(command);
      } else if (command.status === 'waiting_manual') {
        this.completeChat(message, {
          status: 'failed',
          content: '中央大脑当前不能主动接收消息，请检查它的运行方式。',
        });
      }
    }
  }

  async resume() {
    this.resumeChat();
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
      if (orchestration.status === 'review' && orchestration.error?.code === 'coordinator_review_rejected'
        && orchestration.recovery_count < MAX_RECOVERY_ROUNDS) {
        this.recoverRejectedReview(orchestration);
        continue;
      }
      if (orchestration.status === 'review' && !orchestration.error) {
        const review = orchestration.review_command_id
          ? this.store.getCommand(orchestration.review_command_id)
          : commands.find((command) => command.kind === 'coordinator_review');
        if (review && FINAL_COMMAND_STATUSES.has(review.status)) this.onCommandFinished(review);
        else if (!review) this.requestReview(orchestration);
      }
    }
  }
}
