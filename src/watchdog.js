// Semantic watchdog: an independent interactive Worker periodically judges
// whether running commands make real progress or drift from their task.
//
// The mechanical inactivity timeout in Hub only sees time. This watchdog sees
// evidence (instruction, task goal, progress lines, output tail) and answers in
// structured JSON. The Hub applies only low-risk actions: a mailbox nudge to the
// Worker, or an alert that waits for a person. It never cancels or retries work,
// so an uncertain judgement can never destroy work in progress.

export const WATCHDOG_KIND = 'watchdog_check';

const STATES = new Set(['progressing', 'looping', 'drifted', 'stuck', 'unclear']);
const ACTIONS = new Set(['none', 'nudge', 'escalate']);
const ACTIVE_STATUSES = new Set(['queued', 'accepted', 'running', 'waiting_manual']);
const DEFAULTS = {
  interval_ms: 10 * 60 * 1000,
  min_running_ms: 10 * 60 * 1000,
  nudge_cooldown_ms: 30 * 60 * 1000,
};
const MAX_COMMANDS_PER_CHECK = 8;
const INSTRUCTION_BUDGET = 1500;
const OUTPUT_TAIL_BUDGET = 3000;

function watchdogError(message, code = 'watchdog_invalid', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function canReceivePush(worker) {
  return Boolean(worker && !worker.retired_at && worker.push_capable && worker.presence === 'online');
}

function duration(value, field, fallback, { min = 60 * 1000 } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min) throw watchdogError(`${field} must be an integer of at least ${min} ms`);
  return value;
}

function minutes(milliseconds) {
  return Math.max(0, Math.round(milliseconds / 60000));
}

function jsonDocument(value) {
  if (typeof value !== 'string' || !value.trim()) throw watchdogError('Watchdog returned no JSON');
  let input = value.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(input);
  if (fence) input = fence[1].trim();
  try {
    return JSON.parse(input);
  } catch {
    const start = input.indexOf('{');
    const end = input.lastIndexOf('}');
    if (start < 0 || end <= start) throw watchdogError('Watchdog returned invalid JSON');
    try {
      return JSON.parse(input.slice(start, end + 1));
    } catch {
      throw watchdogError('Watchdog returned invalid JSON');
    }
  }
}

function shortText(value, field, max, { required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw watchdogError(`${field} must be ${required ? 'a non-empty' : 'a'} string of at most ${max} characters`);
  }
  return value.trim();
}

export function validateVerdicts(value, expectedIds) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.verdicts)) {
    throw watchdogError('Watchdog response must be {"verdicts":[...]}');
  }
  const expected = new Set(expectedIds);
  const verdicts = new Map();
  for (const input of value.verdicts) {
    if (!input || typeof input !== 'object' || !expected.has(input.command_id) || verdicts.has(input.command_id)) {
      throw watchdogError('Watchdog verdicts contain an unknown or duplicate command_id');
    }
    if (!STATES.has(input.state)) throw watchdogError(`Unsupported watchdog state for ${input.command_id}`);
    if (!ACTIONS.has(input.action)) throw watchdogError(`Unsupported watchdog action for ${input.command_id}`);
    // A healthy or unclear command must never be disturbed.
    const action = ['progressing', 'unclear'].includes(input.state) ? 'none' : input.action;
    verdicts.set(input.command_id, {
      command_id: input.command_id,
      state: input.state,
      action,
      evidence: shortText(input.evidence, `${input.command_id}.evidence`, 2000),
      message: shortText(input.message, `${input.command_id}.message`, 1000, { required: action !== 'none' }),
    });
  }
  if (verdicts.size !== expected.size) throw watchdogError('Watchdog must judge every command in the snapshot');
  return [...verdicts.values()];
}

export class Watchdog {
  constructor({ store, emit, dispatch, sendMail, alert = () => {}, logger = console, now = () => Date.now() }) {
    this.store = store;
    this.emit = emit;
    this.dispatch = dispatch;
    this.sendMail = sendMail;
    this.alert = alert;
    this.logger = logger;
    this.now = now;
  }

  config() {
    const config = this.store.getWatchdogConfig();
    return {
      ...config,
      interval_ms: config.interval_ms ?? DEFAULTS.interval_ms,
      min_running_ms: config.min_running_ms ?? DEFAULTS.min_running_ms,
      nudge_cooldown_ms: config.nudge_cooldown_ms ?? DEFAULTS.nudge_cooldown_ms,
    };
  }

  status() {
    const config = this.config();
    const last = this.store.latestCommandOfKind(WATCHDOG_KIND);
    return {
      ...config,
      worker: config.worker_id ? this.store.getWorker(config.worker_id) : null,
      last_check: last
        ? { command_id: last.command_id, status: last.status, created_at: last.created_at, finished_at: last.finished_at }
        : null,
    };
  }

  configure({ workerId, enabled = true, intervalMs, minRunningMs, nudgeCooldownMs }) {
    const current = this.config();
    if (enabled) {
      const worker = workerId ? this.store.getWorker(workerId) : null;
      if (!canReceivePush(worker)) {
        throw watchdogError('Watchdog must be online with an attached interactive Channel', 'watchdog_worker_invalid');
      }
      const coordinator = this.store.getCoordinatorConfig();
      if (coordinator.enabled && coordinator.worker_id === worker.worker_id) {
        throw watchdogError('Watchdog must be a different Session than the Coordinator', 'watchdog_worker_invalid');
      }
    }
    this.store.setWatchdogConfig({
      workerId: workerId ?? null,
      enabled,
      intervalMs: duration(intervalMs, 'interval_ms', current.interval_ms),
      minRunningMs: duration(minRunningMs, 'min_running_ms', current.min_running_ms, { min: 0 }),
      nudgeCooldownMs: duration(nudgeCooldownMs, 'nudge_cooldown_ms', current.nudge_cooldown_ms, { min: 0 }),
    });
    this.emit('watchdog.configured', { type: 'admin', id: 'admin' }, {
      worker_id: workerId ?? null,
      payload: { enabled },
    });
    return this.status();
  }

  // Running commands old enough to judge, oldest first. The watchdog never
  // judges its own Session or its own checks.
  candidates(config, at) {
    return this.store.listRunningCommands()
      .filter((command) => command.kind !== WATCHDOG_KIND && command.worker_id !== config.worker_id)
      .filter((command) => {
        const started = Date.parse(command.started_at ?? command.created_at);
        return Number.isFinite(started) && at - started >= config.min_running_ms;
      })
      .slice(0, MAX_COMMANDS_PER_CHECK);
  }

  snapshot(command, at) {
    const worker = this.store.getWorker(command.worker_id);
    const task = command.task_id ? this.store.getTask(command.task_id) : null;
    const previous = this.store.latestCommandEvent(command.command_id, 'watchdog.verdict');
    const lastActivity = Date.parse(command.last_activity_at ?? command.started_at ?? command.created_at);
    const output = command.output_text ?? '';
    const progress = output.split('\n').filter((line) => line.startsWith('[progress] '));
    return {
      command_id: command.command_id,
      worker: { name: worker?.name ?? null, runtime: worker?.runtime ?? null, description: worker?.metadata?.description ?? null },
      kind: command.kind,
      task: task
        ? { number: task.task_number ?? null, title: task.title, goal: task.goal, acceptance: task.acceptance ?? [] }
        : null,
      instruction: command.input.slice(0, INSTRUCTION_BUDGET),
      instruction_truncated: command.input.length > INSTRUCTION_BUDGET,
      running_minutes: minutes(at - Date.parse(command.started_at ?? command.created_at)),
      minutes_since_last_activity: Number.isFinite(lastActivity) ? minutes(at - lastActivity) : null,
      progress_lines: progress.slice(-10),
      progress_line_count: progress.length,
      output_tail: output.slice(-OUTPUT_TAIL_BUDGET),
      output_truncated: command.output_truncated || output.length > OUTPUT_TAIL_BUDGET,
      previous_check: previous
        ? {
          state: previous.payload.state,
          action: previous.payload.action,
          minutes_ago: minutes(at - Date.parse(previous.created_at)),
          activity_since: command.last_activity_at !== previous.payload.last_activity_at,
        }
        : null,
    };
  }

  prompt(snapshots) {
    return [
      '你是 Agent Hub 的看门狗（Watchdog），独立于各执行 Session。你只做判断：不调用工具、不修改任务、不替员工做事。',
      '对每条运行中的命令，判断它是否在真实推进、是否偏离任务目标。只依据下面的快照；证据不足就用 unclear，不要猜测。',
      'state 取值：progressing 有实质进展（新的进展行、产出接近验收）；looping 反复同一操作或同一错误、没有新产出；drifted 产出与任务目标或验收无关；stuck 长时间没有任何新活动，或在等待它无法自行解决的条件；unclear 证据不足（例如没有进展行也没有输出，但时间不算异常）。',
      'action 取值：none 不打扰；nudge 给该员工发一封简短提醒，message 指出你看到的现象和建议的下一步，不超过 100 字；escalate 需要人来决定（偏离目标、等待权限或审批、需要业务判断），message 写成给人看的一句话问题。',
      'progressing 和 unclear 只能用 none。等待权限确认或人工审批属于 escalate，不要 nudge。previous_check 显示上次已提醒且 activity_since=false 时，不要重复 nudge，改为 escalate 或 none。',
      'evidence 必须引用快照里的具体现象（如某条进展行、重复出现的错误、空闲分钟数）。',
      '只输出一个 JSON 对象，不要 Markdown 或其他文字：{"verdicts":[{"command_id":"cmd_...","state":"looping","action":"nudge","evidence":"...","message":"..."}]}',
      '必须覆盖下列每条命令，command_id 完全一致。',
      '运行中命令快照 JSON:',
      JSON.stringify(snapshots, null, 2),
    ].join('\n\n');
  }

  // Called on the Hub's periodic timer. Creates at most one check at a time and
  // at most one per interval, measured from the last persisted check, so a Hub
  // restart does not cause a burst of checks.
  tick({ force = false } = {}) {
    const config = this.config();
    if (!config.enabled || !config.worker_id) return null;
    const worker = this.store.getWorker(config.worker_id);
    if (!canReceivePush(worker)) return null;
    const last = this.store.latestCommandOfKind(WATCHDOG_KIND);
    if (last && ACTIVE_STATUSES.has(last.status)) return null;
    const at = this.now();
    if (!force && last && at - Date.parse(last.created_at) < config.interval_ms) return null;
    const commands = this.candidates(force ? { ...config, min_running_ms: 0 } : config, at);
    if (!commands.length) return null;
    const snapshots = commands.map((command) => this.snapshot(command, at));
    const check = this.store.createCommand({
      task_id: null,
      worker_id: worker.worker_id,
      kind: WATCHDOG_KIND,
      input: this.prompt(snapshots),
      push_capable: true,
    });
    this.emit('watchdog.check.requested', { type: 'hub', id: 'watchdog' }, {
      worker_id: worker.worker_id,
      command_id: check.command_id,
      payload: { command_ids: commands.map((command) => command.command_id) },
    });
    this.dispatch(check);
    return check;
  }

  snapshotIds(check) {
    const event = this.store.latestCommandEvent(check.command_id, 'watchdog.check.requested');
    return Array.isArray(event?.payload?.command_ids) ? event.payload.command_ids : [];
  }

  // Returns true when the finished command was a watchdog check.
  async onCommandFinished(check) {
    if (check.kind !== WATCHDOG_KIND) return false;
    const actor = { type: 'worker', id: check.worker_id };
    if (check.status !== 'succeeded' || check.outcome_unknown) {
      this.emit('watchdog.check.failed', actor, { command_id: check.command_id, payload: { error: check.error } });
      return true;
    }
    let verdicts;
    try {
      const text = typeof check.result?.text === 'string' ? check.result.text : JSON.stringify(check.result ?? null);
      verdicts = validateVerdicts(jsonDocument(text), this.snapshotIds(check));
    } catch (error) {
      this.emit('watchdog.check.failed', actor, {
        command_id: check.command_id,
        payload: { error: { code: error.code ?? 'watchdog_invalid', message: error.message } },
      });
      return true;
    }
    const config = this.config();
    const at = this.now();
    for (const verdict of verdicts) {
      const target = this.store.getCommand(verdict.command_id);
      if (!target) continue;
      const stillRunning = target.status === 'running';
      let applied = stillRunning ? verdict.action : 'none';
      if (applied === 'nudge') {
        const lastNudge = this.store.latestCommandEvent(target.command_id, 'watchdog.nudged');
        if (lastNudge && at - Date.parse(lastNudge.created_at) < config.nudge_cooldown_ms) applied = 'none';
      }
      const refs = { worker_id: target.worker_id, task_id: target.task_id, command_id: target.command_id };
      this.emit('watchdog.verdict', actor, {
        ...refs,
        payload: {
          check_command_id: check.command_id,
          state: verdict.state,
          action: verdict.action,
          applied,
          evidence: verdict.evidence,
          last_activity_at: target.last_activity_at,
          ...(stillRunning ? {} : { stale: true }),
        },
      });
      if (applied === 'nudge') {
        try {
          this.sendMail(check.worker_id, {
            to_worker_id: target.worker_id,
            client_message_id: `watchdog:${check.command_id}:${target.command_id}`,
            subject: '看门狗提醒',
            body: `${verdict.message}\n\n（看门狗依据：${verdict.evidence}。这是提醒，不是新任务；如判断有误可忽略，继续按原命令 ${target.command_id} 执行并照常回报。）`,
            command_id: target.command_id,
          });
          this.emit('watchdog.nudged', actor, { ...refs, payload: { check_command_id: check.command_id } });
        } catch (error) {
          this.logger.error?.(`Watchdog nudge for ${target.command_id} failed: ${error.message}`);
        }
      } else if (applied === 'escalate') {
        this.emit('watchdog.alert', actor, {
          ...refs,
          payload: { check_command_id: check.command_id, state: verdict.state, message: verdict.message, evidence: verdict.evidence },
        });
        this.alert({ check, target, verdict });
      }
    }
    return true;
  }
}
