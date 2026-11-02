// Roles: the durable owner of work is the Task and its Role ("QA"), not the
// Session that happens to be working on it. A Session is a seat: when it goes
// away, the Task's next execution goes to another seat of the same Role with a
// handoff package built from the Task's own history.
import { resultPointer } from './coordinator.js';

export const ROLE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const DEFAULT_TAKEOVER_AFTER_MS = 3 * 60 * 1000;
export const MAX_SESSION_LOST_HANDOFFS = 3;
const WORK_KINDS = new Set(['prompt', 'handoff', 'review_request', 'status_request']);
// Deliberate stops are not lost Sessions.
const NOT_LOST = new Set(['admin_cancelled', 'seat_reassigned', 'command_cancelled', 'task_cancelled']);
const TASK_MARK = '\n本次要处理：\n';
const INLINE_LIMIT = 1500;
const PROGRESS_LINES = 8;

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));
const clip = (text, limit) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

// A handed-over instruction carries its own package; only the work itself is
// passed on again, so packages never nest.
export function taskPart(input) {
  const text = String(input ?? '');
  const index = text.lastIndexOf(TASK_MARK);
  return index === -1 ? text : text.slice(index + TASK_MARK.length);
}

function resultText(result) {
  if (result == null) return '';
  if (typeof result.text === 'string') return result.text;
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function taskLabel(task) {
  return `${task.task_number ? `#${String(task.task_number).padStart(4, '0')}` : ''}「${task.title}」`;
}

// An absolute workdir must match exactly. A relative one ("youxian-qa") matches the
// end of the path, so the same Role can have seats on Macs with different home directories.
export function cwdMatches(required, actual) {
  if (!required) return true;
  if (!actual) return false;
  const clean = (value) => value.replace(/\/+$/, '');
  const want = clean(required);
  const have = clean(actual);
  return want.startsWith('/') ? have === want : have === want || have.endsWith(`/${want}`);
}

export class Roles {
  constructor({ store, emit, dispatch, broadcast = () => {}, cancel, now = () => Date.now(), logger = console }) {
    this.store = store;
    this.emit = emit;
    this.dispatch = dispatch;
    this.broadcast = broadcast;
    this.cancel = cancel;
    this.now = now;
    this.logger = logger;
    this.ticking = false;
  }

  validKey(value) {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!ROLE_KEY.test(key)) {
      const error = new Error('role must be 1-40 lowercase letters, digits, - or _');
      error.statusCode = 400;
      error.code = 'invalid_role';
      throw error;
    }
    return key;
  }

  ensure(value) {
    const key = this.validKey(value);
    return this.store.getRole(key) ?? this.store.upsertRole({ roleKey: key });
  }

  assign(workerId, value, actor) {
    const role = value === null || value === '' ? null : this.ensure(value);
    const worker = this.store.setWorkerRole(workerId, role?.role_key ?? null);
    this.emit('worker.role', actor, { connector_id: worker.connector_id, worker_id: worker.worker_id, payload: { role_key: worker.role_key } });
    return worker;
  }

  available(worker) {
    return Boolean(worker && !worker.retired_at && worker.push_capable && worker.presence === 'online' && !this.seatProblem(worker));
  }

  // Why a live Session still can't do this Role's work. The Channel reports where
  // the Session really runs; a Connector or Channel too old to say falls back to
  // the directory declared at registration.
  seatProblem(worker) {
    const workdir = worker?.role_key ? this.store.getRole(worker.role_key)?.workdir : null;
    const actual = worker?.session_cwd ?? worker?.cwd;
    if (!workdir || cwdMatches(workdir, actual)) return null;
    return `Session runs in ${actual ?? 'an unknown directory'}, but Role ${worker.role_key} works in ${workdir}`;
  }

  // When a seat stopped being reachable; null while it is reachable.
  downSince(worker) {
    if (!worker) return 0;
    if (worker.retired_at) return Date.parse(worker.retired_at);
    if (worker.presence !== 'online') return Date.parse(worker.last_seen_at) || 0;
    if (!worker.push_capable) return Date.parse(worker.detached_at ?? worker.updated_at) || 0;
    if (this.seatProblem(worker)) return Date.parse(worker.updated_at) || 0;
    return null;
  }

  // A seat does one job at a time. When every seat is busy the work stays in its
  // open handoff, and whichever seat frees up first takes the oldest one. Pushing
  // it onto a busy seat would strand it there even if another seat went idle.
  pickSeat(roleKey) {
    return this.store.listRoleWorkers(roleKey)
      .find((worker) => this.available(worker) && this.store.activeCommandCount(worker.worker_id) === 0) ?? null;
  }

  // Seats exist but none is free, as opposed to nobody being there at all.
  seatsBusy(roleKey) {
    return !this.pickSeat(roleKey) && this.store.listRoleWorkers(roleKey).some((worker) => this.available(worker));
  }

  present(role) {
    const seats = this.store.listRoleWorkers(role.role_key).map((worker) => ({
      worker_id: worker.worker_id,
      name: worker.name,
      connector_name: worker.connector_name,
      runtime: worker.runtime,
      available: this.available(worker),
      problem: this.seatProblem(worker),
      session_cwd: worker.session_cwd,
      active_commands: this.store.activeCommandCount(worker.worker_id),
    }));
    return { ...role, seats, open_handoffs: this.store.listHandoffs({ status: 'open', roleKey: role.role_key }).length };
  }

  // New work for a Role Task: straight to its seat while that seat is live,
  // otherwise into the Task's handoff. The old seat keeps priority until the
  // Role's takeover delay has passed, so a quick restart loses nothing.
  deliver(task, input, { reason = 'followup', actor }) {
    const assignee = task.assignee_worker_id ? this.store.getWorker(task.assignee_worker_id) : null;
    if (this.available(assignee) && assignee.role_key === task.role_key) {
      const command = this.store.createCommand({ task_id: task.task_id, worker_id: assignee.worker_id, kind: 'prompt', input, push_capable: true });
      this.announceCommand(command, actor);
      return { command, handoff: null };
    }
    const role = this.ensure(task.role_key);
    const down = assignee && !assignee.retired_at ? this.downSince(assignee) ?? this.now() : null;
    const notBefore = down == null ? this.now() : Math.max(this.now(), down + role.takeover_after_ms);
    const handoff = this.enqueue(task, { reason, input, fromWorkerId: assignee?.worker_id ?? null, notBefore, actor });
    return { command: handoff.command_id ? this.store.getCommand(handoff.command_id) : null, handoff };
  }

  enqueue(task, { reason, input = '', fromWorkerId = null, fromCommandId = null, notBefore = this.now(), actor = { type: 'hub', id: 'roles' } }) {
    const open = this.store.openHandoffForTask(task.task_id);
    const at = new Date(notBefore).toISOString();
    const handoff = open
      ? this.store.mergeHandoff(open.handoff_id, { input, fromCommandId, notBefore: at })
      : this.store.createHandoff({ taskId: task.task_id, roleKey: task.role_key, reason, input, fromWorkerId, fromCommandId, notBefore: at });
    if (['in_progress', 'blocked'].includes(task.status)) {
      this.broadcast('task.updated', { task: this.store.updateTask(task.task_id, { status: 'ready' }) });
    }
    this.emit(open ? 'handoff.merged' : 'handoff.created', actor, {
      task_id: task.task_id,
      worker_id: fromWorkerId,
      command_id: fromCommandId,
      payload: { handoff_id: handoff.handoff_id, role_key: handoff.role_key, reason, not_before: handoff.not_before },
    });
    this.broadcast('handoff.updated', { handoff });
    this.pump({ roleKey: task.role_key });
    return this.store.getHandoff(handoff.handoff_id);
  }

  // Seats every open handoff that can be seated now.
  pump({ roleKey = null } = {}) {
    const seated = [];
    for (const handoff of this.store.listHandoffs({ status: 'open', roleKey })) {
      const task = this.store.getTask(handoff.task_id);
      if (!task || task.deleted_at || ['done', 'cancelled'].includes(task.status)) {
        const { handoff: cancelled } = this.store.resolveHandoff(handoff.handoff_id, { status: 'cancelled' });
        this.broadcast('handoff.updated', { handoff: cancelled });
        continue;
      }
      const previous = handoff.from_worker_id ? this.store.getWorker(handoff.from_worker_id) : null;
      let seat = this.available(previous) && previous.role_key === handoff.role_key ? previous : null;
      if (!seat && this.now() >= Date.parse(handoff.not_before)) seat = this.pickSeat(handoff.role_key);
      if (!seat) continue;
      const command = this.store.createCommand({
        task_id: task.task_id,
        worker_id: seat.worker_id,
        kind: 'prompt',
        input: this.instruction(task, handoff, seat, previous),
        push_capable: seat.push_capable,
      });
      const { changed, handoff: resolved } = this.store.resolveHandoff(handoff.handoff_id, { status: 'dispatched', workerId: seat.worker_id, commandId: command.command_id });
      if (!changed) {
        this.store.cancelCommand(command.command_id, { code: 'handoff_raced', message: 'Handoff was resolved concurrently' });
        continue;
      }
      const updated = this.store.updateTask(task.task_id, { assignee_worker_id: seat.worker_id });
      this.emit('task.handoff', { type: 'hub', id: 'roles' }, {
        connector_id: seat.connector_id,
        worker_id: seat.worker_id,
        task_id: task.task_id,
        command_id: command.command_id,
        payload: { handoff_id: handoff.handoff_id, role_key: handoff.role_key, reason: handoff.reason, from_worker_id: handoff.from_worker_id, from_command_id: handoff.from_command_id },
      });
      this.announceCommand(command, { type: 'hub', id: 'roles' });
      this.broadcast('task.updated', { task: updated });
      this.broadcast('handoff.updated', { handoff: resolved });
      seated.push(resolved);
    }
    return seated;
  }

  announceCommand(command, actor = { type: 'hub', id: 'roles' }) {
    this.emit('command.created', actor, {
      worker_id: command.worker_id, task_id: command.task_id, command_id: command.command_id,
      payload: { kind: command.kind, status: command.status },
    });
    this.dispatch(command);
    this.broadcast('command.updated', { command });
  }

  instruction(task, handoff, seat, previous) {
    const history = this.store.listTaskWorkCommands(task.task_id).filter((command) => command.command_id !== handoff.command_id);
    if (!history.length) return handoff.input || task.goal || task.title;
    const work = handoff.input || '继续把任务做完，完成后照常回报。';
    const interrupted = handoff.from_command_id ? this.store.getCommand(handoff.from_command_id) : null;
    if (previous && seat.worker_id === previous.worker_id) {
      return [
        `【恢复】任务${taskLabel(task)}的上一次执行${interrupted ? `（命令 ${interrupted.command_id}）` : ''}在会话断开时中断，结果未知。`,
        '先核对现场（工作目录、git status / git log、已经发出的消息或草稿），确认哪些对外动作已经做过，不要重复；再继续。',
        `${TASK_MARK.trim()}\n${work}`,
      ].join('\n\n');
    }
    return this.package(task, handoff, seat, previous, history, interrupted, work);
  }

  package(task, handoff, seat, previous, history, interrupted, work) {
    const role = this.store.getRole(handoff.role_key);
    const why = {
      session_lost: `${previous?.name ?? '前任'} 的会话在执行中断开了${interrupted?.error?.code ? `（${interrupted.error.code}）` : ''}，那次执行的结果未知`,
      seat_down: `${previous?.name ?? '前任'} 的会话已离线${role.takeover_after_ms >= 60000 ? `超过 ${minutes(role.takeover_after_ms)} 分钟` : ''}，排给它的工作转给你`,
    }[handoff.reason] ?? `${previous ? `${previous.name} 的会话不在线` : '岗位上之前没有在线的会话'}`;
    const lines = [
      `【交接】你接手了任务${taskLabel(task)}。它属于岗位「${role.name}」${previous ? `，之前由 ${previous.name} 负责` : ''}；${why}。`,
      '你没有前任的记忆，下面是任务自带的交接包，以它为准。',
    ];
    if (task.goal && task.goal.trim() !== work.trim()) lines.push(`目标：${clip(task.goal, INLINE_LIMIT)}`);
    if (task.acceptance?.length) lines.push(`验收：\n${task.acceptance.map((item) => `- ${item}`).join('\n')}`);
    if (task.thread_key) lines.push(`关联话题：${task.thread_key}（之后这个话题里的消息会直接发给你）`);
    if (previous) {
      const elsewhere = previous.connector_id !== seat.connector_id
        ? '你在另一台机器上，看不到那里的本地改动；用前任的回报、git 远端和外部记录核对。'
        : '';
      lines.push(`前任的工作目录：${previous.cwd}（${previous.connector_name}）。${elsewhere}`);
    }
    const progress = history.flatMap((command) => (command.output_text ?? '').split('\n'))
      .filter((line) => line.startsWith('[progress] '))
      .slice(-PROGRESS_LINES)
      .map((line) => `- ${clip(line.slice(11), 300)}`);
    if (progress.length) lines.push(`最近进展：\n${progress.join('\n')}`);
    const reported = [...history].reverse().find((command) => command.status === 'succeeded' && resultText(command.result));
    if (reported) {
      const text = resultText(reported.result);
      lines.push([
        `上一次回报（命令 ${reported.command_id}${reported.result?.outcome ? `，${reported.result.outcome}` : ''}）：`,
        clip(text, INLINE_LIMIT),
        `完整内容：${resultPointer(reported.command_id)}`,
      ].join('\n'));
    }
    const open = this.store.openAttentionForTask(task.task_id);
    if (open?.outcome === 'needs_approval') {
      lines.push(`前任已提交待审批的对外内容（${open.status === 'approved' ? '已批准，渠道正在发出' : '等审批人决定'}，${open.action?.channel ?? ''} ${open.action?.kind ?? ''} → ${open.action?.target ?? ''}）：${clip(open.action?.text ?? open.question, 600)}\n不要再提交一遍；结果会以新指令告诉你。`);
    } else if (open) {
      lines.push(`还没回答的问题：${open.question}`);
    }
    if (interrupted) lines.push(`被中断的那次执行：命令 ${interrupted.command_id}（${resultPointer(interrupted.command_id)} 可看它的状态）`);
    lines.push('恢复提示：先核对现场——工作目录的 git status / git log、已经发出的消息或草稿、外部系统里的状态——确认哪些对外动作已经做过，再决定下一步。不要重复已经发生的对外动作（发消息、发帖、提交、部署、写线上数据）；拿不准就用 needs_input 回报问人。');
    lines.push(`${TASK_MARK.trim()}\n${work}`);
    return lines.join('\n\n');
  }

  // A Role Task whose execution died with its Session gets a new execution.
  onCommandFinished(command) {
    if (!WORK_KINDS.has(command.kind) || !command.task_id) return false;
    if (command.status !== 'failed' || !command.outcome_unknown || NOT_LOST.has(command.error?.code)) return false;
    const task = this.store.getTask(command.task_id);
    if (!task?.role_key || task.deleted_at || ['done', 'cancelled'].includes(task.status)) return false;
    if (task.assignee_worker_id !== command.worker_id) return false;
    if (this.store.countHandoffs(task.task_id, 'session_lost') >= MAX_SESSION_LOST_HANDOFFS) {
      this.emit('handoff.exhausted', { type: 'hub', id: 'roles' }, { task_id: task.task_id, command_id: command.command_id, payload: { role_key: task.role_key, limit: MAX_SESSION_LOST_HANDOFFS } });
      return false;
    }
    const role = this.ensure(task.role_key);
    this.enqueue(task, {
      reason: 'session_lost',
      input: taskPart(command.input),
      fromWorkerId: command.worker_id,
      fromCommandId: command.command_id,
      notBefore: this.now() + role.takeover_after_ms,
    });
    return true;
  }

  // Work queued on a seat that has been unreachable past the takeover delay
  // has not started anywhere, so it moves to another seat. Running work is
  // never moved: it ends through the inactivity timeout or the Session.
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.store.listLiveRoleTasks()) {
        const seat = this.store.getWorker(task.assignee_worker_id);
        const down = this.downSince(seat);
        if (down == null) continue;
        const role = this.ensure(task.role_key);
        if (this.now() - down < role.takeover_after_ms) continue;
        if (!this.pickSeat(task.role_key)) continue;
        for (const command of this.store.listUnstartedTaskCommands(task.task_id, seat.worker_id)) {
          try {
            await this.cancel(command.command_id, { actor: { type: 'hub', id: 'roles' }, code: 'seat_reassigned', message: 'Seat unreachable; work moved to another seat of the Role' });
          } catch (error) {
            if (error.code === 'command_not_active') continue;
            throw error;
          }
          this.enqueue(this.store.getTask(task.task_id), {
            reason: 'seat_down',
            input: taskPart(command.input),
            fromWorkerId: seat.worker_id,
            fromCommandId: command.command_id,
          });
        }
      }
      this.pump();
    } finally {
      this.ticking = false;
    }
  }
}
