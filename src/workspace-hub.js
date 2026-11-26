import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore, NOTE_KINDS } from './workspace-store.js';
import { createToken, createId } from './ids.js';
import { hashToken } from './auth.js';
import { readJsonBody, sendJson } from './json.js';

// Workspaces: a leader session says 开工, the Hub asks each machine's door to
// open the seats, every seat joins with a one-time ticket, and the team talks
// in one group thread with a shared brief, notebook and file area.
//
// Delivery is batched. The Hub keeps every message; it only rings a member's
// doorbell when there is something new since the last ring, waits gather_ms
// to collect more unless the message is addressed to that member (handoff,
// @seat, a private line, the owner), and re-rings once if a ring went unread.
// The model never polls: a ring is the only thing that costs a turn.

export const WORKSPACE_FEATURE = 'workspace_v1';
export const DEFAULT_GATHER_MS = 3 * 60 * 1000;
const FILE_CHUNK_BYTES = 384 * 1024;
const FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const BODY_LIMIT = 20000;
const DIGEST_LIMIT = 3500;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEAT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const RUNTIMES = new Set(['claude', 'codex', 'antigravity', 'kimi', 'other']);

function wsError(message, statusCode = 400, code = 'workspace_error') {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, field, { max = BODY_LIMIT, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw wsError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw wsError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw wsError(`${field} is required`);
  if (trimmed.length > max) throw wsError(`${field} is longer than ${max} characters`);
  return trimmed;
}

function clip(value, max) {
  const flat = String(value ?? '');
  return flat.length > max ? `${flat.slice(0, max)}…（还有 ${flat.length - max} 字）` : flat;
}

const nowIso = () => new Date().toISOString();
const inMs = (ms) => new Date(Date.now() + ms).toISOString();

export class WorkspaceHub {
  constructor({ hub, store, dataDir, logger = console, gatherMs = DEFAULT_GATHER_MS, ringMs = 15 * 60 * 1000,
    retryMs = 60 * 1000, launchTimeoutMs = 10 * 60 * 1000, tickMs = 2000, maxRings = 2 }) {
    this.hub = hub;
    this.hubStore = store;
    this.store = new WorkspaceStore(store.db);
    this.logger = logger;
    this.gatherMs = gatherMs;
    this.ringMs = ringMs;
    this.retryMs = retryMs;
    this.launchTimeoutMs = launchTimeoutMs;
    this.maxRings = maxRings;
    this.filesDir = path.join(dataDir, 'workspaces', 'files');
    this.uploads = new Map();
    this.wakes = new Map();
    this.rings = new Map();
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { this.logger.error?.(error); }
    }, tickMs);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    for (const upload of this.uploads.values()) upload.handle.close().catch(() => {});
    this.uploads.clear();
  }

  // ---- plumbing ------------------------------------------------------------

  supports(connectorId) {
    return Boolean(connectorId && this.hub.connectors.get(connectorId)
      && this.hub.connectorFeatures.get(connectorId)?.has(WORKSPACE_FEATURE));
  }

  sendTo(connectorId, type, payload) {
    if (!this.supports(connectorId)) return false;
    return this.hub.send(this.hub.connectors.get(connectorId), type, payload);
  }

  changed(workspaceId) {
    this.hub.broadcast('workspace.updated', { workspace_id: workspaceId });
  }

  connectorName(connectorId) {
    return connectorId ? (this.hubStore.getConnector(connectorId)?.name ?? connectorId) : null;
  }

  // Machines are named by Connector name (case-insensitive, a unique prefix is enough) or id.
  resolveConnector(machine, runtime) {
    const connectors = this.hubStore.listConnectors().filter((item) => !item.revoked_at);
    if (!machine || machine === 'auto') {
      const doors = this.store.listDoors().filter((door) => door.runtime === runtime && door.online && this.supports(door.connector_id));
      if (!doors.length) throw wsError(`没有在线的 ${runtime} 门房；先在某台机器上开门（agent-hub ws door …）`, 409, 'no_door');
      const load = (connectorId) => this.store.db.prepare(`
        SELECT COUNT(*) AS n FROM ws_members m JOIN ws_workspaces w ON w.workspace_id = m.workspace_id
        WHERE w.status = 'active' AND m.connector_id = ? AND m.runtime = ? AND m.state != 'left' AND m.state != 'failed'
      `).get(connectorId, runtime).n;
      return doors.map((door) => ({ door, load: Number(load(door.connector_id)) })).sort((a, b) => a.load - b.load)[0].door.connector_id;
    }
    const exact = connectors.find((item) => item.connector_id === machine || item.name.toLowerCase() === machine.toLowerCase());
    if (exact) return exact.connector_id;
    const prefixed = connectors.filter((item) => item.name.toLowerCase().startsWith(machine.toLowerCase())
      || (item.hostname ?? '').toLowerCase().startsWith(machine.toLowerCase()));
    if (prefixed.length === 1) return prefixed[0].connector_id;
    if (prefixed.length > 1) throw wsError(`机器名 ${machine} 不唯一：${prefixed.map((item) => item.name).join('、')}`, 409, 'ambiguous_machine');
    throw wsError(`找不到机器 ${machine}；用 agent-hub ws doors 看有哪些`, 404, 'unknown_machine');
  }

  identityOf(payload) {
    const identity = payload?.identity ?? {};
    const runtime = typeof identity.runtime === 'string' ? identity.runtime.trim() : '';
    const sessionId = typeof identity.session_id === 'string' ? identity.session_id.trim() : '';
    if (!runtime || !sessionId) return null;
    if (runtime.length > 40 || sessionId.length > 300) throw wsError('Invalid session identity');
    return { runtime, session_id: sessionId };
  }

  requireIdentity(payload) {
    const identity = this.identityOf(payload);
    if (!identity) throw wsError('这条命令要在 agent 会话里运行，读不到当前会话身份', 400, 'identity_required');
    return identity;
  }

  memberFor(connectorId, identity) {
    const member = this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id);
    if (!member) throw wsError('当前会话不在任何进行中的工作区里；先 agent-hub ws join <报到单> 或 agent-hub ws start', 404, 'not_a_member');
    return member;
  }

  requireLeader(member) {
    if (member.role !== 'leader') throw wsError('只有队长能做这件事', 403, 'leader_only');
  }

  label(member) {
    return member.role === 'leader' ? `${member.seat}（队长）` : member.seat;
  }

  presentMember(member, { viewer = null } = {}) {
    const connector = member.connector_id ? this.hubStore.getConnector(member.connector_id) : null;
    const unread = member.state === 'joined' ? this.store.unreadFor(member).length : 0;
    const view = {
      member_id: member.member_id,
      seat: member.seat,
      role: member.role,
      job: member.job,
      runtime: member.runtime,
      model: member.model,
      machine: connector?.name ?? null,
      connector_id: member.connector_id,
      machine_online: Boolean(connector?.online),
      session_id: member.session_id,
      state: member.state,
      state_detail: member.state_detail,
      listening: member.listening,
      wake_status: member.wake_status,
      wake_detail: member.wake_detail,
      notified_at: member.notified_at,
      wake_due_at: member.wake_due_at,
      unread,
      last_active_at: member.last_active_at,
      joined_at: member.joined_at,
      created_at: member.created_at,
    };
    if (viewer === 'admin') view.launch = member.launch;
    return view;
  }

  // ---- connector lifecycle ---------------------------------------------------

  onConnectorOnline(connectorId) {
    // Listeners re-announce themselves after a reconnect; until then nobody is known to be waiting.
    for (const member of this.store.listJoinedMembersOnConnector(connectorId)) {
      if (member.listening) this.store.updateMember(member.member_id, { listening: false });
    }
  }

  onConnectorOffline(connectorId) {
    this.store.setDoorsOffline(connectorId);
    for (const member of this.store.listJoinedMembersOnConnector(connectorId)) {
      this.store.updateMember(member.member_id, { listening: false });
      this.changed(member.workspace_id);
    }
  }

  // ---- connector messages ----------------------------------------------------

  async handleConnectorMessage(socket, connectorId, message) {
    const payload = message.payload ?? {};
    const reply = (value) => this.hub.send(socket, message.type, value, message.id);
    switch (message.type) {
      case 'workspace.rpc': {
        reply(await this.rpc(connectorId, payload));
        return;
      }
      case 'workspace.doors': {
        const doors = (Array.isArray(payload.doors) ? payload.doors : [])
          .filter((door) => door && RUNTIMES.has(door.runtime) && typeof door.kind === 'string')
          .map((door) => ({ runtime: door.runtime, kind: door.kind.slice(0, 40), detail: door.detail && typeof door.detail === 'object' ? door.detail : {} }));
        const listed = this.store.replaceDoors(connectorId, doors);
        reply({ doors: listed });
        this.hub.broadcast('workspace.doors', { connector_id: connectorId });
        this.retryLaunches(connectorId);
        return;
      }
      case 'workspace.listener': {
        const identity = this.requireIdentity(payload);
        const member = this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id);
        if (member) {
          const updated = this.store.updateMember(member.member_id, { listening: payload.attached === true });
          if (payload.attached === true) this.ring(updated, { reason: 'listener' });
          this.changed(member.workspace_id);
        }
        reply({ member_id: member?.member_id ?? null });
        return;
      }
      case 'workspace.launch.result': {
        this.launchResult(connectorId, payload);
        reply({ ok: true });
        return;
      }
      case 'workspace.wake.result': {
        this.wakeResult(connectorId, payload);
        reply({ ok: true });
        return;
      }
      case 'workspace.file.begin': {
        reply(await this.fileBegin(connectorId, payload));
        return;
      }
      case 'workspace.file.chunk': {
        reply(await this.fileChunk(connectorId, payload));
        return;
      }
      case 'workspace.file.end': {
        reply(await this.fileEnd(connectorId, payload));
        return;
      }
      case 'workspace.file.read': {
        reply(await this.fileRead(connectorId, payload));
        return;
      }
      default:
        throw wsError(`Unsupported workspace message: ${message.type}`);
    }
  }

  async rpc(connectorId, payload) {
    const op = typeof payload.op === 'string' ? payload.op : '';
    const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
    switch (op) {
      case 'doors.list': return { doors: this.presentDoors() };
      case 'projects.list': return { projects: this.store.listProjects() };
      case 'project.set': return { project: this.setProject(connectorId, args) };
      case 'ws.list': return this.listFor(connectorId, this.identityOf(payload));
      case 'ws.create': return this.create(connectorId, this.requireIdentity(payload), args);
      case 'ws.join': return this.join(connectorId, this.requireIdentity(payload), args);
      default: break;
    }
    const identity = this.requireIdentity(payload);
    const member = this.memberFor(connectorId, identity);
    this.store.updateMember(member.member_id, { last_active_at: nowIso() });
    switch (op) {
      case 'ws.status': return this.status(member);
      case 'ws.say': return this.say(member, args);
      case 'ws.inbox': return this.inbox(member, args);
      case 'ws.history': return this.history(member, args);
      case 'ws.note': return this.note(member, args);
      case 'ws.notes': return { notes: this.store.listNotes(member.workspace_id) };
      case 'ws.brief': return this.brief(member, args);
      case 'ws.add': return this.addSeats(member, args);
      case 'ws.relaunch': return this.relaunch(member, args);
      case 'ws.close': return this.closeWorkspace(member, args);
      case 'ws.leave': return this.leave(member);
      case 'ws.files': return { files: this.store.listFiles(member.workspace_id) };
      case 'ws.me': return { member: this.presentMember(member), workspace: this.store.getWorkspace(member.workspace_id) };
      default: throw wsError(`Unknown workspace operation ${op}`, 400, 'unknown_op');
    }
  }

  presentDoors() {
    return this.store.listDoors().map((door) => ({
      ...door,
      machine: this.connectorName(door.connector_id),
      online: door.online && this.supports(door.connector_id),
    }));
  }

  setProject(connectorId, args) {
    const key = text(args.key, 'key', { max: 60 }).toLowerCase();
    if (!NAME_PATTERN.test(key)) throw wsError('项目名只能用小写字母、数字和横线，最多 40 个字');
    return this.store.upsertProject({
      projectKey: key,
      title: args.title === undefined ? undefined : text(args.title, 'title', { max: 200, required: false }),
      gitRemote: args.git_remote === undefined ? undefined : text(args.git_remote, 'git_remote', { max: 500, required: false }) || null,
      defaultBranch: args.default_branch === undefined ? undefined : text(args.default_branch, 'default_branch', { max: 200, required: false }) || null,
      connectorId,
      path: args.path === undefined ? undefined : (args.path === null ? null : text(args.path, 'path', { max: 4096 })),
      antigravityProject: args.antigravity_project ? text(args.antigravity_project, 'antigravity_project', { max: 200 }) : undefined,
    });
  }

  listFor(connectorId, identity) {
    const mine = identity ? this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id) : null;
    return {
      member_of: mine ? mine.workspace_id : null,
      workspaces: this.store.listWorkspaces({ status: 'active' }).map((workspace) => ({
        workspace_id: workspace.workspace_id,
        name: workspace.name,
        title: workspace.title,
        leader: workspace.leader_member_id ? this.store.getMember(workspace.leader_member_id)?.seat : null,
        members: this.store.listMembers(workspace.workspace_id).filter((member) => member.state !== 'left').length,
        created_at: workspace.created_at,
      })),
    };
  }

  // ---- create / seats / launch ----------------------------------------------

  parseSeat(workspace, spec) {
    if (!spec || typeof spec !== 'object') throw wsError('Each seat must be an object');
    const seat = text(spec.seat, 'seat', { max: 32 });
    if (!SEAT_PATTERN.test(seat)) throw wsError(`座位名 ${seat} 只能用字母、数字、横线和下划线`);
    const runtime = text(spec.runtime, 'runtime', { max: 40 }).toLowerCase();
    if (!RUNTIMES.has(runtime)) throw wsError(`不认识的 agent 类型 ${runtime}；可选 claude、codex、antigravity`);
    const connectorId = this.resolveConnector(spec.machine ? String(spec.machine) : 'auto', runtime);
    return {
      seat,
      runtime,
      connectorId,
      job: text(spec.job, 'job', { max: 500, required: false }),
      model: spec.model ? text(spec.model, 'model', { max: 100 }) : null,
    };
  }

  create(connectorId, identity, args) {
    const name = text(args.name, 'name', { max: 40 }).toLowerCase();
    if (!NAME_PATTERN.test(name)) throw wsError('工作区名只能用小写字母、数字和横线，最多 40 个字，比如 search-v2');
    const existing = this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id);
    if (existing) {
      const workspace = this.store.getWorkspace(existing.workspace_id);
      throw wsError(`当前会话已经在工作区「${workspace.title}」（${workspace.name}）里；先 agent-hub ws leave 或收工`, 409, 'already_member');
    }
    const projectKey = args.project ? text(args.project, 'project', { max: 60 }).toLowerCase() : null;
    if (projectKey && !this.store.getProject(projectKey)) throw wsError(`没有登记项目 ${projectKey}；先 agent-hub ws project set ${projectKey} …`, 404, 'unknown_project');
    const gatherMs = args.gather_ms === undefined ? this.gatherMs : Number(args.gather_ms);
    if (!Number.isFinite(gatherMs) || gatherMs < 0 || gatherMs > 60 * 60 * 1000) throw wsError('gather_ms must be between 0 and 3600000');
    const seats = Array.isArray(args.seats) ? args.seats : [];
    if (seats.length > 12) throw wsError('一个工作区最多 12 个座位');
    const leaderSeat = args.leader_seat ? text(args.leader_seat, 'leader_seat', { max: 32 }) : 'leader';
    if (!SEAT_PATTERN.test(leaderSeat)) throw wsError(`座位名 ${leaderSeat} 只能用字母、数字、横线和下划线`);
    const draft = { name };
    const parsed = seats.map((spec) => this.parseSeat(draft, spec));
    const seatNames = new Set([leaderSeat]);
    for (const seat of parsed) {
      if (seatNames.has(seat.seat)) throw wsError(`座位名 ${seat.seat} 重复了`);
      seatNames.add(seat.seat);
    }
    const { workspace, leader, members } = this.store.transaction(() => {
      const workspace = this.store.createWorkspace({
        name,
        title: text(args.title, 'title', { max: 200, required: false }) || name,
        goal: text(args.goal, 'goal', { max: BODY_LIMIT, required: false }),
        brief: text(args.brief, 'brief', { max: BODY_LIMIT, required: false }),
        projectKey,
        branch: `ws/${name}`,
        gatherMs,
      });
      const leader = this.store.createMember({
        workspaceId: workspace.workspace_id,
        seat: leaderSeat,
        role: 'leader',
        job: text(args.leader_job, 'leader_job', { max: 500, required: false }) || '队长：写简报、分工、验收、向业主汇报',
        runtime: identity.runtime,
        connectorId,
        sessionId: identity.session_id,
        state: 'joined',
      });
      this.store.setLeader(workspace.workspace_id, leader.member_id);
      const members = parsed.map((seat) => this.newSeat(workspace, seat));
      return { workspace: this.store.getWorkspace(workspace.workspace_id), leader, members };
    });
    this.system(workspace, `队长 ${leader.seat}（${identity.runtime}@${this.connectorName(connectorId)}）开工：${workspace.title}`);
    // The leader wrote the opening line; it is not news to them.
    const latest = this.store.latestSeq(workspace.workspace_id);
    this.store.updateMember(leader.member_id, { read_seq: latest, notified_seq: latest, wake_due_at: null });
    for (const member of members) this.launch(member.member_id);
    this.changed(workspace.workspace_id);
    return {
      workspace: this.store.getWorkspace(workspace.workspace_id),
      me: this.presentMember(this.store.getMember(leader.member_id)),
      members: this.store.listMembers(workspace.workspace_id).map((member) => this.presentMember(member)),
      wake: this.wakeAdvice(leader),
      warnings: this.directoryWarnings(workspace, members),
    };
  }

  // A code workspace needs the project checked out on every seat's machine. Without a
  // registered directory a seat still launches (in its door's default place) and its
  // briefing says how to find and register the checkout, but the leader hears it now.
  directoryWarnings(workspace, members) {
    const project = workspace.project_key ? this.store.getProject(workspace.project_key) : null;
    if (!project) return [];
    return members.filter((member) => !project.paths?.[member.connector_id]).map((member) =>
      `${member.seat}（${member.runtime}@${this.connectorName(member.connector_id)}）：这台机器没登记项目 ${project.project_key} 的目录，`
      + `这次会先在门房默认的地方起来，报到后自己找到或 clone 仓库再登记；以后要一开始就在项目里，请那台机器上的 agent 在项目目录里运行一次 agent-hub ws project set ${project.project_key}。`);
  }

  newSeat(workspace, seat) {
    return this.store.createMember({
      workspaceId: workspace.workspace_id,
      seat: seat.seat,
      job: seat.job,
      runtime: seat.runtime,
      connectorId: seat.connectorId,
      model: seat.model,
      state: 'requested',
      launch: { requested_at: nowIso(), attempts: 0 },
    });
  }

  addSeats(member, args) {
    this.requireLeader(member);
    const workspace = this.store.getWorkspace(member.workspace_id);
    const seats = Array.isArray(args.seats) ? args.seats : [];
    if (!seats.length) throw wsError('要加的座位是空的');
    const parsed = seats.map((spec) => this.parseSeat(workspace, spec));
    const created = this.store.transaction(() => parsed.map((seat) => this.newSeat(workspace, seat)));
    for (const item of created) this.launch(item.member_id);
    this.changed(workspace.workspace_id);
    return { members: created.map((item) => this.presentMember(this.store.getMember(item.member_id))), warnings: this.directoryWarnings(workspace, created) };
  }

  relaunch(member, args) {
    this.requireLeader(member);
    const seat = text(args.seat, 'seat', { max: 32 });
    const target = this.store.getMemberBySeat(member.workspace_id, seat);
    if (!target) throw wsError(`没有座位 ${seat}`, 404);
    if (target.role === 'leader') throw wsError('队长不能被重新拉起');
    if (target.state === 'joined') throw wsError(`${seat} 已经报到了；要换人先让它 agent-hub ws leave`, 409);
    this.store.updateMember(target.member_id, { state: 'requested', state_detail: null, session_id: null,
      launch: { ...target.launch, requested_at: nowIso() } });
    this.launch(target.member_id);
    return { member: this.presentMember(this.store.getMember(target.member_id)),
      warnings: this.directoryWarnings(this.store.getWorkspace(member.workspace_id), [target]) };
  }

  prompt(workspace, member, ticket) {
    const lines = [
      `你被拉进了 Agent Hub 工作区「${workspace.title}」（${workspace.name}），你的座位是 ${member.seat}，分工：${member.job || '听队长安排'}。`,
      '第一步先报到，运行这条本地命令：',
      `agent-hub ws join ${ticket}`,
    ];
    if (member.runtime === 'codex') lines.push('（这条本地命令用 Codex 原生的单次提升权限执行，不要 sudo。）');
    lines.push('报到的输出会告诉你目标、队友、怎么收信和工作规矩。报到前不要做别的事。');
    return lines.join('\n');
  }

  launch(memberId) {
    const member = this.store.getMember(memberId);
    if (!member || !['requested', 'launching'].includes(member.state)) return;
    const workspace = this.store.getWorkspace(member.workspace_id);
    if (!workspace || workspace.status !== 'active') return;
    const door = this.store.getDoor(member.connector_id, member.runtime);
    if (!door?.online || !this.supports(member.connector_id)) {
      this.store.updateMember(memberId, { state: 'requested', state_detail: `等 ${this.connectorName(member.connector_id)} 上的 ${member.runtime} 门房上线` });
      this.changed(workspace.workspace_id);
      return;
    }
    const ticket = createToken('wst');
    const project = workspace.project_key ? this.store.getProject(workspace.project_key) : null;
    const cwd = project?.paths?.[member.connector_id] ?? null;
    const launch = {
      ...member.launch,
      door: door.kind,
      attempts: Number(member.launch.attempts ?? 0) + 1,
      sent_at: nowIso(),
      cwd,
      antigravity_project: project?.antigravity_projects?.[member.connector_id] ?? null,
    };
    this.store.updateMember(memberId, { state: 'launching', state_detail: `已请 ${this.connectorName(member.connector_id)} 的门房拉起`,
      ticket_hash: hashToken(ticket), launch });
    const sent = this.sendTo(member.connector_id, 'workspace.launch', {
      member_id: memberId,
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.name,
      workspace_title: workspace.title,
      seat: member.seat,
      runtime: member.runtime,
      model: member.model,
      cwd,
      antigravity_project: launch.antigravity_project,
      name: `${workspace.name}-${member.seat}`,
      prompt: this.prompt(workspace, member, ticket),
    });
    if (!sent) this.store.updateMember(memberId, { state: 'requested', state_detail: '机器不在线，等它上线再拉起' });
    this.changed(workspace.workspace_id);
  }

  retryLaunches(connectorId) {
    for (const member of this.store.listLaunchingMembers()) {
      if (member.connector_id === connectorId && member.state === 'requested') this.launch(member.member_id);
    }
  }

  launchResult(connectorId, payload) {
    const member = this.store.getMember(String(payload.member_id ?? ''));
    if (!member || member.connector_id !== connectorId) return;
    if (member.state === 'joined' || member.state === 'left') {
      this.store.updateMember(member.member_id, { launch: { ...member.launch, result: payload.status, detail: payload.detail ?? null } });
      return;
    }
    const workspace = this.store.getWorkspace(member.workspace_id);
    const detail = payload.detail && typeof payload.detail === 'object' ? payload.detail : {};
    const launch = { ...member.launch, result: payload.status, detail, finished_at: nowIso() };
    if (['launched', 'queued'].includes(payload.status)) {
      this.store.updateMember(member.member_id, {
        state: 'launched',
        state_detail: payload.status === 'queued' ? '已交给门房会话去开新对话，等它报到' : '会话已起来，等它报到',
        launch,
      });
    } else {
      const error = clip(typeof payload.error === 'string' ? payload.error : '门房没能拉起会话', 600);
      this.store.updateMember(member.member_id, { state: 'failed', state_detail: error, ticket_hash: null, launch });
      this.system(workspace, `${member.seat}（${member.runtime}@${this.connectorName(member.connector_id)}）没能拉起：${error}`,
        { urgentFor: [workspace.leader_member_id] });
    }
    this.changed(member.workspace_id);
  }

  // ---- join ------------------------------------------------------------------

  join(connectorId, identity, args) {
    let member;
    if (args.ticket) {
      const ticket = text(args.ticket, 'ticket', { max: 200 });
      member = this.store.findMemberByTicket(hashToken(ticket));
      if (!member) {
        const again = this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id);
        if (again) return this.briefing(again, { rejoined: true });
        throw wsError('报到单无效或已用过；请队长 agent-hub ws relaunch <座位> 重新拉起', 404, 'bad_ticket');
      }
    } else {
      member = this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id);
      if (!member) throw wsError('需要报到单：agent-hub ws join <报到单>', 400, 'ticket_required');
      return this.briefing(member, { rejoined: true });
    }
    const workspace = this.store.getWorkspace(member.workspace_id);
    if (!workspace || workspace.status !== 'active') throw wsError('这个工作区已经收工了', 409, 'workspace_closed');
    if (member.runtime !== identity.runtime) {
      throw wsError(`这个座位要的是 ${member.runtime}，当前会话是 ${identity.runtime}；报到单不要交给别的 agent`, 409, 'runtime_mismatch');
    }
    const elsewhere = this.store.findActiveMemberBySession(connectorId, identity.runtime, identity.session_id);
    if (elsewhere && elsewhere.member_id !== member.member_id) {
      const other = this.store.getWorkspace(elsewhere.workspace_id);
      throw wsError(`当前会话已经在工作区「${other.title}」里；一个会话同时只能在一个工作区`, 409, 'already_member');
    }
    if (member.state === 'joined') {
      // Same seat, new native session (a resumed background session): rebind, keep read position.
      const reattached = this.store.updateMember(member.member_id, { session_id: identity.session_id, connector_id: connectorId, ticket_hash: null, last_active_at: nowIso() });
      if (reattached.session_id !== member.session_id) this.system(workspace, `${member.seat} 的会话重启了，已重新接上`, { actor: reattached });
      this.changed(workspace.workspace_id);
      return this.briefing(this.store.getMember(member.member_id), { rejoined: true });
    }
    const moved = member.connector_id && member.connector_id !== connectorId;
    const joined = this.store.updateMember(member.member_id, {
      state: 'joined',
      state_detail: moved ? `在 ${this.connectorName(connectorId)} 上报到（原定 ${this.connectorName(member.connector_id)}）` : null,
      connector_id: connectorId,
      session_id: identity.session_id,
      ticket_hash: null,
      joined_at: nowIso(),
      last_active_at: nowIso(),
    });
    this.system(workspace, `${joined.seat}（${joined.runtime}@${this.connectorName(connectorId)}）报到了，分工：${joined.job || '听队长安排'}`);
    // The briefing below is the newcomer's catch-up: everything so far, its own join notice included, counts as read.
    const latest = this.store.latestSeq(workspace.workspace_id);
    this.store.updateMember(member.member_id, { read_seq: latest, notified_seq: latest, wake_due_at: null });
    this.changed(workspace.workspace_id);
    return this.briefing(this.store.getMember(joined.member_id), { rejoined: false });
  }

  wakeAdvice(member) {
    if (member.runtime === 'claude' || member.runtime === 'kimi' || member.runtime === 'other') {
      return {
        mode: 'wait',
        text: '收信：现在就用 Bash 工具的 run_in_background 运行 `agent-hub ws wait`（不要前台等）。它在有新消息时结束并把消息打出来，你会被叫醒；处理完以后再后台运行一次 `agent-hub ws wait`。没有新消息时什么也不用做。',
      };
    }
    if (member.runtime === 'codex') {
      return { mode: 'codex-queue', text: '收信：报到时已在后台起了收信桥，新消息会自动送进这个对话，不用做别的。' };
    }
    return { mode: 'door', text: '收信：这台机器的反重力门房会把新消息送进这个对话，不用做别的。' };
  }

  rules(workspace, member) {
    const project = workspace.project_key ? this.store.getProject(workspace.project_key) : null;
    const lines = [
      '工作规矩：',
      '1. 只做自己分工里的事。超出分工、要业主决定、或者卡住了，在工作区里 @队长，不要自己去找业主。',
      '2. 结果和进展说在工作区里：`agent-hub ws say "…"`。要某个队友看，就在话里写 @座位名；私下说用 `--to 座位`。',
      '3. 一棒做完交给下一棒：`agent-hub ws handoff --to <座位> "改了什么、提交号或文件在哪、要对方做什么"`。',
      '4. 读新消息：`agent-hub ws inbox`。看队伍状态：`agent-hub ws status`。',
      '5. 定下的事、核实过的事实、要留的链接记进记事本：`agent-hub ws note --kind decision|fact|link "…"`。',
      '6. 文件（图、文档、报告）放进文件区：`agent-hub ws file put <路径> --note "…"`；取：`agent-hub ws file get <编号>`。',
      '7. 没有新东西就不用回话，不要互相客套。',
    ];
    if (project) {
      lines.push(`代码：项目 ${project.project_key}${project.git_remote ? `（${project.git_remote}）` : ''}，工作区分支 ${workspace.branch}。`);
      const here = project.paths?.[member.connector_id];
      if (here) lines.push(`  - 这台机器上的项目目录：${here}。`);
      else lines.push(`  - 这台机器还没登记项目目录。先在 ~/Workspace 等常用目录里找 ${project.git_remote ?? project.project_key} 的检出；没有就 git clone 到 ~/Workspace/${project.project_key}。找到或 clone 好以后，在那个目录里运行 agent-hub ws project set ${project.project_key} 登记，再开 worktree。`);
      lines.push(`  - 在项目目录旁边开自己的 worktree（游离 HEAD，不起分支名），例如 git -C <项目目录> worktree add --detach ../.wt/${workspace.name}-${member.seat} origin/${project.default_branch ?? 'main'}。`);
      lines.push(`  - 写代码的人把提交推到 ${workspace.branch}：git push origin HEAD:refs/heads/${workspace.branch}；被拒就 fetch + rebase 再推，不加 --force。`);
      lines.push(`  - 测试、review 的人：git fetch origin ${workspace.branch}，在自己的 worktree 里检出同一个提交。`);
      lines.push('  - 收工时由队长把这条分支合进个人分支，再删掉它。');
    }
    return lines.join('\n');
  }

  briefing(member, { rejoined }) {
    const workspace = this.store.getWorkspace(member.workspace_id);
    const project = workspace.project_key ? this.store.getProject(workspace.project_key) : null;
    return {
      rejoined,
      workspace,
      me: this.presentMember(member),
      leader: workspace.leader_member_id ? this.presentMember(this.store.getMember(workspace.leader_member_id)) : null,
      members: this.store.listMembers(workspace.workspace_id).map((item) => this.presentMember(item)),
      project: project ? { ...project, path_here: project.paths?.[member.connector_id] ?? null } : null,
      recent: this.store.visibleRecent(member, 15),
      notes: this.store.listNotes(workspace.workspace_id, { limit: 50 }),
      files: this.store.listFiles(workspace.workspace_id),
      wake: this.wakeAdvice(member),
      rules: this.rules(workspace, member),
    };
  }

  // ---- talk -----------------------------------------------------------------

  mentionsIn(workspace, body) {
    const members = this.store.listMembers(workspace.workspace_id).filter((member) => member.state !== 'left');
    const bySeat = new Map(members.map((member) => [member.seat.toLowerCase(), member]));
    const found = new Set();
    for (const match of body.matchAll(/@([A-Za-z0-9_\-一-龥]+)/g)) {
      const token = match[1].toLowerCase();
      if (['队长', 'leader'].includes(token) && workspace.leader_member_id) found.add(workspace.leader_member_id);
      else if (['all', '所有人', '全体'].includes(token)) for (const member of members) found.add(member.member_id);
      else if (bySeat.has(token)) found.add(bySeat.get(token).member_id);
    }
    return [...found];
  }

  seatsToMembers(workspace, seats) {
    const list = Array.isArray(seats) ? seats : typeof seats === 'string' ? seats.split(',') : [];
    return list.map((seat) => String(seat).trim()).filter(Boolean).map((seat) => {
      if (['队长', 'leader'].includes(seat.toLowerCase())) {
        if (!workspace.leader_member_id) throw wsError('这个工作区没有队长');
        return workspace.leader_member_id;
      }
      const target = this.store.getMemberBySeat(workspace.workspace_id, seat);
      if (!target || target.state === 'left') throw wsError(`没有座位 ${seat}；用 agent-hub ws status 看座位名`, 404, 'unknown_seat');
      return target.member_id;
    });
  }

  // recipients make a message private; targets mark who it is for (a handoff's
  // next runner) while the whole team can still read it.
  post(workspace, { sender = null, senderLabel, kind, body, recipients = [], targets = [], urgentFor = [] }) {
    const mentions = [...new Set([...this.mentionsIn(workspace, body), ...targets])];
    const message = this.store.addMessage({
      workspaceId: workspace.workspace_id,
      senderMemberId: sender?.member_id ?? null,
      senderLabel,
      kind,
      recipients,
      mentions,
      body,
    });
    // Your own words never ring your own doorbell: unread lists skip the sender.
    const urgent = new Set([...urgentFor.filter(Boolean), ...mentions, ...recipients]);
    for (const member of this.store.listMembers(workspace.workspace_id)) {
      if (member.state !== 'joined' || member.member_id === sender?.member_id) continue;
      if (recipients.length && !recipients.includes(member.member_id)) continue;
      this.schedule(member, { urgent: urgent.has(member.member_id) });
    }
    this.changed(workspace.workspace_id);
    return message;
  }

  // `actor` is the member whose own action caused the notice (an upload, a brief, a
  // rejoin): it is recorded as the sender, so it never rings that member's doorbell.
  system(workspace, body, { urgentFor = [], actor = null } = {}) {
    return this.post(workspace, { sender: actor, senderLabel: '系统', kind: 'system', body: clip(body, 2000), urgentFor });
  }

  say(member, args) {
    const workspace = this.store.getWorkspace(member.workspace_id);
    const body = text(args.text, 'text');
    const kind = args.kind === 'handoff' ? 'handoff' : 'chat';
    const recipients = this.seatsToMembers(workspace, args.to);
    if (kind === 'handoff' && !recipients.length) throw wsError('交棒要写交给谁：--to <座位>');
    if (recipients.includes(member.member_id)) throw wsError('不用发给自己');
    // A handoff is everyone's news but only the next runner's work: the team
    // can read it, the runner is woken now, the rest hear it in their next batch.
    const message = this.post(workspace, {
      sender: member,
      senderLabel: this.label(member),
      kind,
      body,
      recipients: kind === 'handoff' ? [] : recipients,
      targets: kind === 'handoff' ? recipients : [],
    });
    return { message, delivered_to: this.deliveryPreview(workspace, member, kind === 'handoff' ? [] : recipients) };
  }

  deliveryPreview(workspace, sender, recipients) {
    return this.store.listMembers(workspace.workspace_id)
      .filter((member) => member.member_id !== sender.member_id && member.state === 'joined'
        && (!recipients.length || recipients.includes(member.member_id)))
      .map((member) => member.seat);
  }

  inbox(member, args) {
    const latest = this.store.latestSeq(member.workspace_id);
    const messages = this.store.unreadFor(member, { limit: Math.min(Number(args.limit) || 200, 500) });
    const notes = this.store.listNotes(member.workspace_id, { after: member.notes_read_seq });
    const lastNote = notes.at(-1)?.seq ?? member.notes_read_seq;
    if (!args.peek) {
      const readUpTo = messages.length >= (Math.min(Number(args.limit) || 200, 500)) ? messages.at(-1).seq : latest;
      this.store.updateMember(member.member_id, {
        read_seq: Math.max(member.read_seq, readUpTo),
        notified_seq: Math.max(member.notified_seq, readUpTo),
        notes_read_seq: lastNote,
        wake_due_at: null,
      });
      this.rings.delete(member.member_id);
      this.changed(member.workspace_id);
    }
    const workspace = this.store.getWorkspace(member.workspace_id);
    return {
      workspace: { workspace_id: workspace.workspace_id, name: workspace.name, title: workspace.title, status: workspace.status },
      me: member.seat,
      messages: messages.map((message) => ({ ...message, private: message.kind !== 'handoff' && message.recipients.length > 0, to_me: message.recipients.includes(member.member_id) || message.mentions.includes(member.member_id) })),
      notes,
      peek: Boolean(args.peek),
    };
  }

  history(member, args) {
    const limit = Math.min(Number(args.limit) || 50, 300);
    return { messages: this.store.visibleRecent(member, limit) };
  }

  note(member, args) {
    const kind = args.kind ? text(args.kind, 'kind', { max: 20 }) : 'note';
    if (!NOTE_KINDS.includes(kind)) throw wsError(`记事本条目类型只能是 ${NOTE_KINDS.join('、')}`);
    const note = this.store.addNote({
      workspaceId: member.workspace_id,
      authorMemberId: member.member_id,
      authorLabel: this.label(member),
      kind,
      body: text(args.text, 'text'),
    });
    this.changed(member.workspace_id);
    return { note };
  }

  brief(member, args) {
    const workspace = this.store.getWorkspace(member.workspace_id);
    if (args.text === undefined) return { brief: workspace.brief, brief_version: workspace.brief_version, goal: workspace.goal };
    this.requireLeader(member);
    const updated = this.store.setBrief(workspace.workspace_id, text(args.text, 'text'));
    this.system(updated, `队长更新了简报（第 ${updated.brief_version} 版），用 agent-hub ws brief 看全文：\n${clip(updated.brief, 600)}`, { actor: member });
    return { brief: updated.brief, brief_version: updated.brief_version };
  }

  closeWorkspace(member, args) {
    this.requireLeader(member);
    const workspace = this.store.getWorkspace(member.workspace_id);
    const summary = text(args.summary, 'summary', { required: false }) || null;
    this.announceClose(workspace, `队长收工${summary ? `：${clip(summary, 1500)}` : ''}。大家停在这里，不用再做事。`, member.member_id);
    const closed = this.store.closeWorkspace(workspace.workspace_id, summary);
    this.changed(workspace.workspace_id);
    const project = closed.project_key ? this.store.getProject(closed.project_key) : null;
    return {
      workspace: closed,
      merge: project ? `把 ${closed.branch} 合进个人分支：git fetch origin ${closed.branch} && git rebase origin/${closed.branch}（或 merge）后快进推送；合完删远端分支：git push origin --delete ${closed.branch}` : null,
    };
  }

  // Anyone still working hears it now; after the close no doorbell rings.
  announceClose(workspace, body, exceptMemberId = null) {
    const everyone = this.store.listMembers(workspace.workspace_id)
      .filter((item) => item.state === 'joined' && item.member_id !== exceptMemberId)
      .map((item) => item.member_id);
    this.system(workspace, body, { urgentFor: everyone });
  }

  leave(member) {
    const workspace = this.store.getWorkspace(member.workspace_id);
    if (member.role === 'leader') throw wsError('队长不能离开；收工用 agent-hub ws close', 409);
    this.store.updateMember(member.member_id, { state: 'left', state_detail: '自己离开了', listening: false, wake_due_at: null });
    this.system(workspace, `${member.seat} 离开了工作区`, { urgentFor: [workspace.leader_member_id], actor: member });
    return { left: true };
  }

  status(member) {
    const workspace = this.store.getWorkspace(member.workspace_id);
    return {
      workspace,
      me: member.seat,
      members: this.store.listMembers(workspace.workspace_id).map((item) => this.presentMember(item)),
      files: this.store.listFiles(workspace.workspace_id).length,
      notes: this.store.listNotes(workspace.workspace_id).length,
      latest_seq: this.store.latestSeq(workspace.workspace_id),
    };
  }

  // ---- doorbell ---------------------------------------------------------------

  pendingFor(member) {
    return this.store.unreadFor(member, { after: Math.max(member.read_seq, member.notified_seq) });
  }

  schedule(member, { urgent }) {
    const current = this.store.getMember(member.member_id);
    if (!current || current.state !== 'joined') return;
    if (urgent) {
      this.ring(current, { reason: 'urgent' });
      return;
    }
    if (!current.wake_due_at) this.store.updateMember(current.member_id, { wake_due_at: inMs(this.store.getWorkspace(current.workspace_id).gather_ms) });
  }

  digest(member, messages, { reminder = false } = {}) {
    const workspace = this.store.getWorkspace(member.workspace_id);
    const head = reminder
      ? `【Agent Hub 工作区「${workspace.title}」】提醒：你（${member.seat}）还有 ${messages.length} 条消息没读。`
      : `【Agent Hub 工作区「${workspace.title}」】你（${member.seat}）有 ${messages.length} 条新消息：`;
    const lines = [head];
    let used = head.length;
    let shown = 0;
    // Work addressed to you first, in full where it fits; the rest as one-line previews.
    const ordered = [...messages].sort((a, b) => {
      const mine = (message) => (message.recipients.includes(member.member_id) || message.mentions.includes(member.member_id) ? 0 : 1);
      return mine(a) - mine(b) || a.seq - b.seq;
    });
    for (const message of ordered) {
      const toMe = message.recipients.includes(member.member_id) || message.mentions.includes(member.member_id);
      const tag = message.kind === 'handoff' ? (toMe ? '交棒给你' : '交棒') : message.kind === 'owner' ? '业主' : message.kind === 'system' ? '系统' : (toMe ? '找你' : '群聊');
      const line = `- [${tag}] ${message.sender}：${clip(message.body, toMe ? 1500 : 200)}`;
      if (used + line.length > DIGEST_LIMIT) break;
      lines.push(line);
      used += line.length;
      shown += 1;
    }
    if (shown < messages.length) lines.push(`……还有 ${messages.length - shown} 条。`);
    lines.push('看全文并标为已读：agent-hub ws inbox');
    return lines.join('\n');
  }

  ring(member, { reason, reminder = false } = {}) {
    const current = this.store.getMember(member.member_id);
    if (!current || current.state !== 'joined') return false;
    const workspace = this.store.getWorkspace(current.workspace_id);
    if (!workspace || workspace.status !== 'active') return false;
    const messages = reminder ? this.store.unreadFor(current) : this.pendingFor(current);
    if (!messages.length) {
      if (current.wake_due_at) this.store.updateMember(current.member_id, { wake_due_at: null });
      return false;
    }
    const latest = messages.at(-1).seq;
    const wakeId = createId('wswake');
    // A door-launched Claude seat may have to be resumed, and `claude --bg --resume`
    // comes back under a new session id: give it a fresh ticket to reattach with.
    let rejoinTicket = null;
    if (current.runtime === 'claude' && current.launch?.door === 'connector') {
      rejoinTicket = createToken('wst');
      this.store.updateMember(current.member_id, { ticket_hash: hashToken(rejoinTicket) });
    }
    this.wakes.set(wakeId, { member_id: current.member_id, previous: current.notified_seq, seq: latest, reminder });
    if (this.wakes.size > 2000) this.wakes.delete(this.wakes.keys().next().value);
    this.store.updateMember(current.member_id, { notified_seq: Math.max(current.notified_seq, latest), notified_at: nowIso(),
      wake_due_at: null, wake_status: 'sending', wake_detail: reason ?? null });
    const sent = this.sendTo(current.connector_id, 'workspace.wake', {
      wake_id: wakeId,
      member_id: current.member_id,
      workspace_id: workspace.workspace_id,
      seat: current.seat,
      runtime: current.runtime,
      session_id: current.session_id,
      text: this.digest(current, messages, { reminder }),
      count: messages.length,
      launch: current.launch,
      ...(rejoinTicket ? { rejoin_ticket: rejoinTicket } : {}),
    });
    if (!sent) this.wakeResult(current.connector_id, { wake_id: wakeId, member_id: current.member_id, status: 'unreachable', detail: '机器不在线' });
    this.changed(workspace.workspace_id);
    return true;
  }

  wakeResult(connectorId, payload) {
    const wake = this.wakes.get(String(payload.wake_id ?? ''));
    const member = this.store.getMember(String(payload.member_id ?? wake?.member_id ?? ''));
    if (!member || member.connector_id !== connectorId) return;
    const status = typeof payload.status === 'string' ? payload.status.slice(0, 40) : 'unknown';
    const detail = typeof payload.detail === 'string' ? payload.detail.slice(0, 500) : null;
    if (['delivered', 'resumed', 'door'].includes(status)) {
      const fields = { wake_status: status, wake_detail: detail };
      const moved = typeof payload.session_id === 'string' && payload.session_id.trim() && payload.session_id !== member.session_id;
      if (status === 'resumed' && moved && !this.store.findActiveMemberBySession(connectorId, member.runtime, payload.session_id)) fields.session_id = payload.session_id.trim().slice(0, 300);
      this.store.updateMember(member.member_id, fields);
    } else {
      // Not delivered: forget the ring so the next attempt carries the same messages.
      const fields = { wake_status: status, wake_detail: detail, wake_due_at: inMs(this.retryMs) };
      if (wake && !wake.reminder && member.notified_seq === wake.seq) fields.notified_seq = wake.previous;
      this.store.updateMember(member.member_id, fields);
    }
    this.wakes.delete(String(payload.wake_id ?? ''));
    this.changed(member.workspace_id);
  }

  tick() {
    const at = nowIso();
    for (const member of this.store.listDueWakes(at)) this.ring(member, { reason: 'gathered' });
    for (const member of this.store.listUnreadAfterRing(new Date(Date.now() - this.ringMs).toISOString())) {
      const record = this.rings.get(member.member_id);
      const count = record?.seq === member.notified_seq ? record.count : 0;
      if (count >= this.maxRings) continue;
      if (this.ring(member, { reason: 'reminder', reminder: true })) this.rings.set(member.member_id, { seq: this.store.getMember(member.member_id).notified_seq, count: count + 1 });
    }
    const cutoff = Date.now() - this.launchTimeoutMs;
    for (const member of this.store.listLaunchingMembers()) {
      const since = Date.parse(member.launch.sent_at ?? member.launch.requested_at ?? member.created_at);
      if (!Number.isFinite(since) || since > cutoff) continue;
      const workspace = this.store.getWorkspace(member.workspace_id);
      const why = member.state === 'requested' ? '门房一直没上线' : '拉起后一直没报到';
      this.store.updateMember(member.member_id, { state: 'failed', state_detail: `${why}（超过 ${Math.round(this.launchTimeoutMs / 60000)} 分钟）`, ticket_hash: null });
      this.system(workspace, `${member.seat}（${member.runtime}@${this.connectorName(member.connector_id)}）${why}；可以让队长 agent-hub ws relaunch ${member.seat}`,
        { urgentFor: [workspace.leader_member_id] });
    }
  }

  // ---- files -----------------------------------------------------------------

  async fileBegin(connectorId, payload) {
    const member = this.memberFor(connectorId, this.requireIdentity(payload));
    const name = path.basename(text(payload.name, 'name', { max: 255 }));
    const size = Number(payload.size);
    if (!Number.isFinite(size) || size < 0) throw wsError('size is required');
    if (size > FILE_LIMIT_BYTES) throw wsError(`文件超过 ${FILE_LIMIT_BYTES / 1024 / 1024} MB`, 413);
    const file = this.store.createFile({
      workspaceId: member.workspace_id,
      uploaderMemberId: member.member_id,
      uploaderLabel: this.label(member),
      name,
      contentType: payload.content_type ? text(payload.content_type, 'content_type', { max: 200 }) : null,
      note: payload.note ? text(payload.note, 'note', { max: 2000 }) : null,
    });
    await mkdir(this.filesDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.filesDir, file.file_id);
    const handle = await open(target, 'w', 0o600);
    this.uploads.set(file.file_id, { handle, target, hash: createHash('sha256'), size: 0, expected: size, connectorId, memberId: member.member_id, next: 0 });
    return { file_id: file.file_id, chunk_bytes: FILE_CHUNK_BYTES };
  }

  async fileChunk(connectorId, payload) {
    const upload = this.uploads.get(String(payload.file_id ?? ''));
    if (!upload || upload.connectorId !== connectorId) throw wsError('Upload not found', 404);
    if (Number(payload.index) !== upload.next) throw wsError('Chunks must arrive in order', 409);
    const data = Buffer.from(String(payload.data ?? ''), 'base64');
    if (data.length > FILE_CHUNK_BYTES) throw wsError('Chunk is too large', 413);
    if (upload.size + data.length > upload.expected) throw wsError('More data than the declared size', 413);
    await upload.handle.write(data);
    upload.hash.update(data);
    upload.size += data.length;
    upload.next += 1;
    return { received: upload.size };
  }

  async fileEnd(connectorId, payload) {
    const fileId = String(payload.file_id ?? '');
    const upload = this.uploads.get(fileId);
    if (!upload || upload.connectorId !== connectorId) throw wsError('Upload not found', 404);
    this.uploads.delete(fileId);
    await upload.handle.close();
    if (payload.abort === true || upload.size !== upload.expected) {
      this.store.failFile(fileId);
      await rm(upload.target, { force: true });
      if (payload.abort === true) return { aborted: true };
      throw wsError(`收到 ${upload.size} 字节，声明的是 ${upload.expected}`, 400);
    }
    const file = this.store.completeFile(fileId, { size: upload.size, sha256: upload.hash.digest('hex') });
    const member = this.store.getMember(upload.memberId);
    const workspace = this.store.getWorkspace(file.workspace_id);
    this.system(workspace, `${this.label(member)} 上传了文件 ${file.name}（${file.size} 字节，编号 ${file.file_id}）${file.note ? `：${clip(file.note, 300)}` : ''}`, { actor: member });
    return { file };
  }

  async fileRead(connectorId, payload) {
    const member = this.memberFor(connectorId, this.requireIdentity(payload));
    const file = this.store.getFile(String(payload.file_id ?? ''));
    if (!file || file.workspace_id !== member.workspace_id || file.status !== 'ready') throw wsError('文件不存在', 404);
    const offset = Math.max(0, Number(payload.offset) || 0);
    const length = Math.min(FILE_CHUNK_BYTES, Math.max(1, Number(payload.length) || FILE_CHUNK_BYTES));
    const handle = await open(path.join(this.filesDir, file.file_id), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return { file, offset, data: buffer.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= file.size };
    } finally {
      await handle.close();
    }
  }

  // ---- admin REST (behind the Admin Token) -------------------------------------

  workspaceDetail(workspaceId) {
    const workspace = this.store.getWorkspace(workspaceId) ?? this.store.getActiveWorkspaceByName(workspaceId);
    if (!workspace) return null;
    return {
      workspace,
      leader: workspace.leader_member_id ? this.store.getMember(workspace.leader_member_id)?.seat : null,
      project: workspace.project_key ? this.store.getProject(workspace.project_key) : null,
      members: this.store.listMembers(workspace.workspace_id).map((member) => this.presentMember(member, { viewer: 'admin' })),
      messages: this.store.recentMessages(workspace.workspace_id, 300).map((message) => ({
        ...message,
        recipient_seats: message.recipients.map((id) => this.store.getMember(id)?.seat).filter(Boolean),
      })),
      notes: this.store.listNotes(workspace.workspace_id),
      files: this.store.listFiles(workspace.workspace_id),
    };
  }

  workspaceSummary(workspace) {
    const members = this.store.listMembers(workspace.workspace_id);
    const count = (state) => members.filter((member) => member.state === state).length;
    return {
      ...workspace,
      leader: workspace.leader_member_id ? this.store.getMember(workspace.leader_member_id)?.seat : null,
      members: members.length,
      joined: count('joined'),
      launching: count('requested') + count('launching') + count('launched'),
      failed: count('failed'),
      latest_seq: this.store.latestSeq(workspace.workspace_id),
    };
  }

  // Returns true when the request was a workspace route.
  async handleAdmin(request, response, url) {
    const pathname = url.pathname;
    if (request.method === 'GET' && pathname === '/api/v1/workspaces') {
      const status = url.searchParams.get('status');
      sendJson(response, 200, { workspaces: this.store.listWorkspaces({ status: status || null }).map((workspace) => this.workspaceSummary(workspace)) });
      return true;
    }
    if (request.method === 'GET' && pathname === '/api/v1/workspace-doors') {
      sendJson(response, 200, { doors: this.presentDoors() });
      return true;
    }
    if (request.method === 'GET' && pathname === '/api/v1/workspace-projects') {
      sendJson(response, 200, { projects: this.store.listProjects().map((project) => ({
        ...project,
        machines: Object.fromEntries(Object.entries(project.paths).map(([id, dir]) => [this.connectorName(id), dir])),
      })) });
      return true;
    }
    const detail = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && detail) {
      const value = this.workspaceDetail(decodeURIComponent(detail[1]));
      sendJson(response, value ? 200 : 404, value ?? { error: 'Workspace not found' });
      return true;
    }
    const messages = /^\/api\/v1\/workspaces\/([^/]+)\/messages$/.exec(pathname);
    if (request.method === 'POST' && messages) {
      const workspace = this.store.getWorkspace(decodeURIComponent(messages[1]));
      if (!workspace) throw wsError('Workspace not found', 404);
      if (workspace.status !== 'active') throw wsError('这个工作区已经收工了', 409);
      const body = await readJsonBody(request);
      const recipients = this.seatsToMembers(workspace, body.to);
      const message = this.post(workspace, {
        senderLabel: '业主',
        kind: 'owner',
        body: text(body.text, 'text'),
        recipients,
        // The owner speaks to the leader unless they name someone.
        urgentFor: recipients.length ? recipients : [workspace.leader_member_id],
      });
      sendJson(response, 201, { message });
      return true;
    }
    const closeRoute = /^\/api\/v1\/workspaces\/([^/]+)\/close$/.exec(pathname);
    if (request.method === 'POST' && closeRoute) {
      const workspace = this.store.getWorkspace(decodeURIComponent(closeRoute[1]));
      if (!workspace) throw wsError('Workspace not found', 404);
      if (workspace.status !== 'active') throw wsError('已经收工了', 409);
      const body = await readJsonBody(request);
      const summary = text(body.summary, 'summary', { required: false }) || null;
      this.announceClose(workspace, `业主在中控收工${summary ? `：${clip(summary, 1500)}` : ''}。大家停在这里，不用再做事。`);
      sendJson(response, 200, { workspace: this.store.closeWorkspace(workspace.workspace_id, summary) });
      this.changed(workspace.workspace_id);
      return true;
    }
    const fileRoute = /^\/api\/v1\/workspaces\/([^/]+)\/files\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && fileRoute) {
      const file = this.store.getFile(decodeURIComponent(fileRoute[2]));
      if (!file || file.workspace_id !== decodeURIComponent(fileRoute[1]) || file.status !== 'ready') {
        sendJson(response, 404, { error: 'File not found' });
        return true;
      }
      const target = path.join(this.filesDir, file.file_id);
      const info = await stat(target);
      response.writeHead(200, {
        'content-type': file.content_type || 'application/octet-stream',
        'content-length': info.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      await new Promise((resolve, reject) => {
        const stream = createReadStream(target);
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.pipe(response);
      });
      return true;
    }
    return false;
  }
}
