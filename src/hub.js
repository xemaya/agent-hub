import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { HubStore } from './db.js';
import { Coordinator } from './coordinator.js';
import { bearerToken, hashToken, tokensEqual } from './auth.js';
import { loadHubCredentials } from './credentials.js';
import { createId, createToken } from './ids.js';
import { readJsonBody, sendJson, sendText } from './json.js';
import { readBuildInfo, shortCommit } from './build-info.js';
import { createSkillArchive, readSkillFile } from './skill-package.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const TASK_STATUSES = new Set(['ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled']);
const WORK_STATES = new Set(['idle', 'working', 'waiting', 'blocked']);
const COMMAND_KINDS = new Set(['prompt', 'handoff', 'review_request', 'status_request', 'coordinator_plan', 'coordinator_review', 'coordinator_chat', 'worker_chat', 'worker_message']);
const COORDINATOR_COMMAND_KINDS = new Set(['coordinator_plan', 'coordinator_review', 'coordinator_chat']);

function workerActivity(store, worker) {
  const commands = store.listCommands({ workerId: worker.worker_id });
  const current = commands.find((command) => command.status === 'running')
    ?? commands.find((command) => command.status === 'accepted')
    ?? commands.find((command) => command.status === 'queued')
    ?? commands.find((command) => command.status === 'waiting_manual')
    ?? null;
  const recent = commands.find((command) => ['succeeded', 'failed'].includes(command.status)) ?? null;
  const orchestrations = store.listOrchestrations();
  const orchestration = current
    ? orchestrations.find((item) => (current.task_id && item.parent_task_id === current.task_id)
      || item.steps.some((step) => step.command_id === current.command_id
        || (current.task_id && step.task_id === current.task_id)))
    : null;
  const step = current && orchestration
    ? orchestration.steps.find((item) => item.command_id === current.command_id || item.task_id === current.task_id)
    : null;
  const taskId = current ? current.task_id : (worker.work_state === 'working' ? worker.current_task_id : null);
  const task = taskId ? store.getTask(taskId) : null;
  let phase = 'idle';
  if (worker.presence === 'offline') phase = 'offline';
  else if (current?.status === 'waiting_manual') phase = 'waiting_manual';
  else if (current && ['queued', 'accepted'].includes(current.status)) phase = 'queued';
  else if (current?.kind === 'coordinator_plan') phase = 'planning';
  else if (current?.kind === 'coordinator_review') phase = 'reviewing';
  else if (['coordinator_chat', 'worker_chat'].includes(current?.kind)) phase = 'chatting';
  else if (current || worker.work_state === 'working') phase = 'working';
  else if (['waiting', 'blocked'].includes(worker.work_state)) phase = worker.work_state;
  const details = {
    idle: '空闲，可以接新任务',
    queued: '已收到安排，等待开始',
    planning: '正在制定任务计划',
    reviewing: '正在核对执行证据',
    chatting: '正在理解你的消息',
    working: '正在执行任务',
    waiting: '等待进一步处理',
    blocked: 'Worker 报告了阻塞',
    waiting_manual: '需要在原会话中人工处理',
    offline: '机器连接已断开，展示最后已知状态',
  };
  const internal = current ? COORDINATOR_COMMAND_KINDS.has(current.kind) : false;
  const output = current && !internal ? current.output_text.slice(-2000) : '';
  const recentText = recent && !COORDINATOR_COMMAND_KINDS.has(recent.kind)
    ? typeof recent.result?.text === 'string' ? recent.result.text : recent.output_text
    : '';
  return {
    phase,
    detail: details[phase],
    command_id: current?.command_id ?? null,
    command_status: current?.status ?? null,
    task_id: orchestration?.parent_task_id ?? taskId,
    task_title: step?.title ?? task?.title ?? (current?.kind === 'coordinator_chat' ? '中央对话' : current?.kind === 'worker_chat' ? '直接对话' : null),
    parent_task_title: orchestration ? store.getTask(orchestration.parent_task_id)?.title ?? null : null,
    output_text: output,
    output_truncated: Boolean(current?.output_truncated || (current && current.output_text.length > output.length)),
    recent_result: recentText.slice(-2000),
    recent_result_truncated: recentText.length > 2000,
    updated_at: current?.started_at ?? current?.accepted_at ?? current?.created_at
      ?? recent?.finished_at ?? recent?.created_at ?? null,
  };
}

function protocolError(message, statusCode = 400, code = 'connector_request_failed') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requiredString(value, field, { max = 10000 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    const error = new Error(`${field} must be a non-empty string of at most ${max} characters`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

function optionalString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    const error = new Error('Expected an array of strings');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function workerInput(payload) {
  if (payload.mode !== undefined && payload.mode !== 'external') {
    const error = new Error('Only interactive external Workers are supported');
    error.statusCode = 400;
    throw error;
  }
  return {
    name: requiredString(payload.name, 'name', { max: 120 }),
    runtime: requiredString(payload.runtime, 'runtime', { max: 40 }),
    mode: 'external',
    runtime_session_id: requiredString(payload.runtime_session_id, 'runtime_session_id', { max: 300 }),
    capabilities: stringArray(payload.capabilities),
    cwd: requiredString(payload.cwd, 'cwd', { max: 4096 }),
    metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {},
  };
}

export class Hub {
  constructor({
    host, port, dataDir, credentials, logger = console, build = null,
    coordinatorInactivityTimeoutMs = 15 * 60 * 1000,
    commandInactivityTimeoutMs = 60 * 60 * 1000,
    watchdogIntervalMs = 30000,
  }) {
    this.host = host;
    this.build = build ?? { version: null, commit: null, dirty: false };
    this.connectorBuilds = new Map();
    this.requestedPort = port;
    this.dataDir = path.resolve(dataDir);
    this.logger = logger;
    this.coordinatorInactivityTimeoutMs = coordinatorInactivityTimeoutMs;
    this.commandInactivityTimeoutMs = commandInactivityTimeoutMs;
    this.expiringInactiveCommands = false;
    this.store = new HubStore(path.join(dataDir, 'hub.db'));
    this.credentials = credentials;
    this.connectors = new Map();
    this.dashboards = new Set();
    this.connectorFeatures = new Map();
    this.workerMessageWaiters = new Map();
    this.coordinator = new Coordinator({
      store: this.store,
      emit: (...args) => this.emit(...args),
      dispatch: (command) => this.dispatch(command),
      notify: (message) => this.broadcast('chat.updated', { message: this.coordinator.presentChatMessage(message) }),
      logger: this.logger,
    });
    this.server = createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.logger.error?.(error);
        if (!response.headersSent) {
          sendJson(response, error.statusCode ?? 500, { error: error.message ?? 'Internal server error' });
        } else {
          response.end();
        }
      });
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.heartbeat = setInterval(() => {
      for (const socket of this.connectors.values()) {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 30000);
    this.heartbeat.unref();
    this.inactivityWatchdog = setInterval(() => {
      this.expireInactiveCommands().catch(error => this.logger.error?.(error));
    }, watchdogIntervalMs);
    this.inactivityWatchdog.unref();
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://localhost');
      const kind = url.pathname === '/ws/connector'
        ? 'connector'
        : url.pathname === '/ws/dashboard'
          ? 'dashboard'
          : null;
      if (!kind) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        this.handleWebSocket(webSocket, kind);
      });
    });
  }

  static async create(options) {
    const dataDir = path.resolve(options.dataDir ?? '.runtime/hub');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const credentials = options.credentials ?? await loadHubCredentials(dataDir, options.env);
    const build = options.build ?? await readBuildInfo();
    return new Hub({
      ...options,
      build,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 8787,
      dataDir,
      credentials,
    });
  }

  async listen() {
    if (this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.expireInactiveCommands().catch(error => this.logger.error?.(error));
  }

  get port() {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : this.requestedPort;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  async close() {
    clearInterval(this.heartbeat);
    clearInterval(this.inactivityWatchdog);
    for (const waiters of this.workerMessageWaiters.values()) {
      for (const waiter of waiters) clearTimeout(waiter.timer);
    }
    this.workerMessageWaiters.clear();
    for (const socket of this.wss.clients) socket.close(1001, 'Hub shutting down');
    this.connectors.clear();
    this.dashboards.clear();
    this.connectorFeatures.clear();
    if (this.server.listening) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.wss.close();
    this.store.close();
  }

  async clearHistory() {
    this.store.assertHistoryClearable();
    const directory = path.join(this.dataDir, 'backups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const backup = path.join(directory, `history-${timestamp}-${createId('backup')}.db`);
    this.store.backup(backup);
    const cleared = this.store.clearHistory();
    this.broadcast('history.cleared', { cleared });
    return { backup, cleared };
  }

  emit(eventType, actor, refs = {}) {
    const event = this.store.recordEvent({
      event_type: eventType,
      actor_type: actor.type,
      actor_id: actor.id,
      ...refs,
    });
    this.broadcast('event', { event });
    return event;
  }

  send(socket, type, payload = {}, replyTo) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const message = { type, id: createId('msg'), ts: new Date().toISOString(), payload };
    if (replyTo) message.reply_to = replyTo;
    socket.send(JSON.stringify(message));
    return true;
  }

  broadcast(type, payload) {
    for (const socket of this.dashboards) this.send(socket, type, payload);
  }

  requireAdmin(request) {
    const token = bearerToken(request);
    if (!tokensEqual(token, this.credentials.adminToken)) {
      const error = new Error('Admin authentication required');
      error.statusCode = 401;
      throw error;
    }
  }

  presentWorker(worker) {
    return worker ? { ...worker, activity: workerActivity(this.store, worker) } : null;
  }

  async expireInactiveCommands() {
    if (this.expiringInactiveCommands) return;
    this.expiringInactiveCommands = true;
    try {
      const timestamp = Date.now();
      for (const command of this.store.listRunningCommands()) {
        const timeoutMs = COORDINATOR_COMMAND_KINDS.has(command.kind)
          ? this.coordinatorInactivityTimeoutMs
          : this.commandInactivityTimeoutMs;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) continue;
        const lastActivity = Date.parse(command.last_activity_at ?? command.started_at ?? command.created_at);
        if (!Number.isFinite(lastActivity) || timestamp - lastActivity < timeoutMs) continue;
        try {
          await this.cancelCommand(command.command_id, {
            actor: { type: 'hub', id: 'inactivity-watchdog' },
            code: 'inactivity_timeout',
            message: `No command activity for ${timeoutMs} ms; outcome is unknown`,
          });
        } catch (error) {
          if (error.code !== 'command_not_active') throw error;
        }
      }
    } finally {
      this.expiringInactiveCommands = false;
    }
  }

  async cancelCommand(commandId, { actor, code = 'admin_cancelled', message = 'Command cancelled by administrator' }) {
    const { command, changed } = this.store.cancelCommand(commandId, { code, message });
    if (!command) throw protocolError('Command not found', 404, 'command_not_found');
    if (!changed) throw protocolError('Command is already finished', 409, 'command_not_active');
    const worker = this.store.getWorker(command.worker_id);
    this.store.updateWorkerStatus(worker.connector_id, worker.worker_id, { work_state: 'idle', current_task_id: null });
    this.emit('command.failed', actor, {
      connector_id: worker.connector_id,
      worker_id: worker.worker_id,
      task_id: command.task_id,
      command_id: command.command_id,
      payload: { error: command.error, outcome_unknown: command.outcome_unknown },
    });
    const socket = this.connectors.get(worker.connector_id);
    if (socket) this.send(socket, 'command.cancel', { command_id: command.command_id, error: command.error });
    if (command.kind === 'worker_message') {
      this.settleWorkerMessageWaiters(command);
    } else {
      const handled = await this.coordinator.onCommandFinished(command);
      if (!handled && command.task_id) {
        const task = this.store.getTask(command.task_id);
        if (task && !['done', 'cancelled', 'blocked'].includes(task.status)) {
          const updated = this.store.updateTask(task.task_id, { status: 'blocked' });
          this.emit('task.updated', actor, {
            task_id: updated.task_id,
            worker_id: updated.assignee_worker_id,
            payload: { status: updated.status },
          });
          this.broadcast('task.updated', { task: updated });
        }
      }
    }
    this.broadcast('command.updated', { command });
    this.broadcast('worker.updated', { worker: this.presentWorker(this.store.getWorker(worker.worker_id)) });
    return command;
  }

  unregisterWorker({ workerId = null, connectorId = null, runtime = null, runtimeSessionId = null, actor = { type: 'admin', id: 'admin' } }) {
    const current = runtimeSessionId
      ? this.store.getWorkerBySession(connectorId, runtime, runtimeSessionId)
      : this.store.getWorker(workerId);
    if (!current || (connectorId && current.connector_id !== connectorId)) {
      const error = new Error('Worker not found');
      error.code = 'worker_not_found';
      error.statusCode = 404;
      throw error;
    }
    const worker = this.store.retireWorker(current.worker_id, { connectorId });
    this.emit('worker.unregistered', actor, {
      connector_id: worker.connector_id,
      worker_id: worker.worker_id,
      payload: { name: worker.name, runtime: worker.runtime, mode: worker.mode, retired_at: worker.retired_at },
    });
    this.broadcast('worker.unregistered', { worker: this.presentWorker(worker) });
    const socket = this.connectors.get(worker.connector_id);
    if (socket) this.send(socket, 'worker.unregistered', { worker });
    return worker;
  }

  async handleRequest(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'agent-hub', version: this.build.version, commit: this.build.commit });
      return;
    }
    if (request.method === 'GET' && pathname === '/skill') {
      const body = await readFile(path.join(PUBLIC_DIR, 'skill.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && pathname === '/skill/SKILL.md') {
      const { body, contentType } = await readSkillFile('SKILL.md');
      response.writeHead(200, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && pathname === '/skill/agent-hub.zip') {
      const body = await createSkillArchive();
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': body.length,
        'content-disposition': 'attachment; filename="agent-hub.zip"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && STATIC_FILES.has(pathname)) {
      const [filename, contentType] = STATIC_FILES.get(pathname);
      try {
        const body = await readFile(path.join(PUBLIC_DIR, filename));
        response.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
        response.end(body);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        sendText(response, 404, 'Not found');
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/v1/connectors/enroll') {
      if (!tokensEqual(bearerToken(request), this.credentials.enrollmentToken)) {
        sendJson(response, 401, { error: 'Valid enrollment token required' });
        return;
      }
      const body = await readJsonBody(request);
      const token = createToken('ah_connector');
      const connector = this.store.createConnector({
        name: requiredString(body.name, 'name', { max: 120 }),
        hostname: optionalString(body.hostname) || null,
        tokenHash: hashToken(token),
      });
      this.emit('connector.enrolled', { type: 'connector', id: connector.connector_id }, {
        connector_id: connector.connector_id,
        payload: { name: connector.name },
      });
      sendJson(response, 201, { connector, token });
      return;
    }
    if (!pathname.startsWith('/api/v1/')) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    this.requireAdmin(request);

    if (request.method === 'GET' && pathname === '/api/v1/coordinator') {
      sendJson(response, 200, { coordinator: this.coordinator.status() });
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/v1/coordinator') {
      const body = await readJsonBody(request);
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        sendJson(response, 400, { error: 'enabled must be a boolean' });
        return;
      }
      const coordinator = this.coordinator.configure({
        workerId: body.worker_id,
        enabled: body.enabled ?? true,
        maxSteps: body.max_steps,
      });
      this.broadcast('coordinator.updated', { coordinator });
      sendJson(response, 200, { coordinator });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/coordinator/chat') {
      sendJson(response, 200, { messages: this.coordinator.chat(), epoch: this.store.conversationEpoch() });
      return;
    }
    if (request.method === 'DELETE' && pathname === '/api/v1/coordinator/chat') {
      const epoch = this.store.clearConversation();
      this.emit('coordinator.chat.cleared', { type: 'admin', id: 'admin' }, { payload: { epoch } });
      this.broadcast('chat.cleared', { epoch });
      sendJson(response, 200, { cleared: true, epoch });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/v1/coordinator/chat') {
      const body = await readJsonBody(request);
      const result = this.coordinator.sendChat({ message: body.message, requestId: body.request_id, mentions: body.mentions });
      sendJson(response, result.message.status === 'pending' ? 202 : 200, result);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/v1/history/clear') {
      const body = await readJsonBody(request);
      if (body.confirm !== true) {
        sendJson(response, 400, { error: 'History clearing requires confirm: true' });
        return;
      }
      sendJson(response, 200, await this.clearHistory());
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/orchestrations') {
      sendJson(response, 200, { orchestrations: this.coordinator.list() });
      return;
    }
    const orchestrationMatch = /^\/api\/v1\/orchestrations\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && orchestrationMatch) {
      const orchestration = this.coordinator.get(orchestrationMatch[1]);
      if (orchestration) sendJson(response, 200, { orchestration });
      else sendJson(response, 404, { error: 'Orchestration not found' });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/connectors') {
      sendJson(response, 200, {
        connectors: this.store.listConnectors().map((connector) => ({
          ...connector,
          build: this.connectorBuilds.get(connector.connector_id) ?? null,
        })),
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/workers') {
      const includeRetired = url.searchParams.get('include_retired') === 'true';
      sendJson(response, 200, { workers: this.store.listWorkers({ includeRetired }).map((worker) => this.presentWorker(worker)) });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/tasks') {
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';
      sendJson(response, 200, { tasks: this.store.listTasks({ includeDeleted }) });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/events') {
      sendJson(response, 200, { events: this.store.listEvents() });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/commands') {
      sendJson(response, 200, {
        commands: this.store.listCommands({
          workerId: url.searchParams.get('worker_id'),
          taskId: url.searchParams.get('task_id'),
        }),
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/v1/tasks') {
      const body = await readJsonBody(request);
      if (body.orchestrate !== undefined && typeof body.orchestrate !== 'boolean') {
        sendJson(response, 400, { error: 'orchestrate must be a boolean' });
        return;
      }
      const assignee = body.assignee_worker_id ?? null;
      if (body.orchestrate === true) {
        if (assignee) {
          sendJson(response, 400, { error: 'Orchestrated tasks cannot have an initial assignee' });
          return;
        }
        const result = this.coordinator.createOrchestration({
          title: requiredString(body.title, 'title', { max: 300 }),
          goal: optionalString(body.goal),
          context: optionalString(body.context),
          acceptance: stringArray(body.acceptance),
          createdBy: 'admin',
          actor: { type: 'admin', id: 'admin' },
        });
        sendJson(response, 202, {
          task: result.task,
          orchestration: this.coordinator.present(result.orchestration),
        });
        return;
      }
      if (assignee && !this.store.getWorker(assignee)) {
        sendJson(response, 400, { error: 'Assignee worker does not exist' });
        return;
      }
      const task = this.store.createTask({
        title: requiredString(body.title, 'title', { max: 300 }),
        goal: optionalString(body.goal),
        context: optionalString(body.context),
        acceptance: stringArray(body.acceptance),
        assignee_worker_id: assignee,
        created_by: 'admin',
      });
      this.emit('task.created', { type: 'admin', id: 'admin' }, {
        task_id: task.task_id,
        worker_id: task.assignee_worker_id,
        payload: { title: task.title },
      });
      sendJson(response, 201, { task });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/v1/commands') {
      const body = await readJsonBody(request);
      const taskId = body.task_id ?? null;
      const task = taskId ? this.store.getTask(taskId) : null;
      if (taskId && !task) {
        sendJson(response, 400, { error: 'Task does not exist' });
        return;
      }
      const workerId = body.worker_id ?? task?.assignee_worker_id;
      const worker = workerId ? this.store.getWorker(workerId) : null;
      if (!worker) {
        sendJson(response, 400, { error: 'Worker does not exist or task is unassigned' });
        return;
      }
      const kind = body.kind ?? 'prompt';
      if (kind === 'worker_message' || !COMMAND_KINDS.has(kind)) {
        sendJson(response, 400, { error: 'Unsupported command kind' });
        return;
      }
      const command = this.store.createCommand({
        task_id: taskId,
        worker_id: worker.worker_id,
        kind,
        input: requiredString(body.input, 'input', { max: 200000 }),
        push_capable: worker.push_capable,
      });
      this.emit('command.created', { type: 'admin', id: 'admin' }, {
        connector_id: worker.connector_id,
        worker_id: worker.worker_id,
        task_id: command.task_id,
        command_id: command.command_id,
        payload: { kind: command.kind, status: command.status },
      });
      if (command.status === 'queued') this.dispatch(command);
      sendJson(response, 202, { command });
      return;
    }

    const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(pathname);
    if (taskMatch) {
      const task = this.store.getTask(taskMatch[1]);
      if (!task) {
        sendJson(response, 404, { error: 'Task not found' });
        return;
      }
      if (request.method === 'DELETE') {
        const deleted = this.store.deleteTask(task.task_id);
        this.emit('task.deleted', { type: 'admin', id: 'admin' }, {
          task_id: task.task_id,
          payload: { deleted_task_ids: deleted.deleted_task_ids },
        });
        this.broadcast('task.deleted', deleted);
        sendJson(response, 200, deleted);
        return;
      }
      if (request.method === 'GET') {
        sendJson(response, 200, { task });
        return;
      }
      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        if (body.status !== undefined && !TASK_STATUSES.has(body.status)) {
          sendJson(response, 400, { error: 'Invalid task status' });
          return;
        }
        if (body.assignee_worker_id && !this.store.getWorker(body.assignee_worker_id)) {
          sendJson(response, 400, { error: 'Assignee worker does not exist' });
          return;
        }
        const updated = this.store.updateTask(task.task_id, {
          title: body.title === undefined ? undefined : requiredString(body.title, 'title', { max: 300 }),
          goal: body.goal,
          context: body.context,
          acceptance: body.acceptance === undefined ? undefined : stringArray(body.acceptance),
          status: body.status,
          assignee_worker_id: body.assignee_worker_id,
        });
        this.emit('task.updated', { type: 'admin', id: 'admin' }, {
          task_id: updated.task_id,
          worker_id: updated.assignee_worker_id,
          payload: { status: updated.status, assignee_worker_id: updated.assignee_worker_id },
        });
        await this.coordinator.resume();
        sendJson(response, 200, { task: updated });
        return;
      }
    }

    const workerMatch = /^\/api\/v1\/workers\/([^/]+)$/.exec(pathname);
    if (request.method === 'DELETE' && workerMatch) {
      const worker = this.unregisterWorker({ workerId: workerMatch[1] });
      sendJson(response, 200, { worker });
      return;
    }
    if (request.method === 'GET' && workerMatch) {
      const worker = this.presentWorker(this.store.getWorker(workerMatch[1]));
      sendJson(response, worker ? 200 : 404, worker ? { worker } : { error: 'Worker not found' });
      return;
    }
    const cancelMatch = /^\/api\/v1\/commands\/([^/]+)\/cancel$/.exec(pathname);
    if (request.method === 'POST' && cancelMatch) {
      const body = await readJsonBody(request);
      const message = body.reason === undefined
        ? 'Command cancelled by administrator'
        : requiredString(body.reason, 'reason', { max: 2000 });
      const command = await this.cancelCommand(cancelMatch[1], {
        actor: { type: 'admin', id: 'admin' },
        message,
      });
      sendJson(response, 200, { command });
      return;
    }
    const commandMatch = /^\/api\/v1\/commands\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && commandMatch) {
      const command = this.store.getCommand(commandMatch[1]);
      sendJson(response, command ? 200 : 404, command ? { command } : { error: 'Command not found' });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  handleWebSocket(socket, kind) {
    let authenticated = false;
    let connectorId = null;
    socket.on('pong', () => {
      if (connectorId) this.store.touchConnector(connectorId);
    });
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.send(socket, 'error', { error: 'Invalid JSON message' });
        return;
      }
      if (!authenticated) {
        const expectedType = kind === 'connector' ? 'connector.hello' : 'dashboard.hello';
        if (message.type !== expectedType || typeof message.payload?.token !== 'string') {
          socket.close(1008, 'Authentication required');
          return;
        }
        if (kind === 'dashboard') {
          if (!tokensEqual(message.payload.token, this.credentials.adminToken)) {
            socket.close(1008, 'Invalid token');
            return;
          }
          authenticated = true;
          this.dashboards.add(socket);
          this.send(socket, 'dashboard.ready', {});
        } else {
          const connector = this.store.getConnectorByTokenHash(hashToken(message.payload.token));
          if (!connector || connector.revoked_at) {
            socket.close(1008, 'Invalid token');
            return;
          }
          authenticated = true;
          connectorId = connector.connector_id;
          const previous = this.connectors.get(connectorId);
          if (previous && previous !== socket) previous.close(1008, 'Replaced by newer connection');
          this.connectors.set(connectorId, socket);
          this.connectorFeatures.set(connectorId, new Set(
            Array.isArray(message.payload.features)
              ? message.payload.features.filter(feature => typeof feature === 'string')
              : [],
          ));
          this.store.setConnectorOnline(connectorId, true);
          this.recordConnectorBuild(connectorId, message.payload.build);
          this.emit('connector.online', { type: 'connector', id: connectorId }, { connector_id: connectorId });
          this.send(socket, 'connector.ready', { connector: this.store.getConnector(connectorId), hub: this.build });
          this.replay(connectorId);
          this.coordinator.resume().catch((error) => this.logger.error?.(error));
        }
        return;
      }
      if (kind === 'connector') {
        this.handleConnectorMessage(socket, connectorId, message).catch((error) => {
          this.send(socket, 'error', {
            error: error.message,
            code: error.code ?? 'connector_request_failed',
            status_code: error.statusCode ?? 400,
          }, message.id);
        });
      }
    });
    socket.on('close', () => {
      this.clearWorkerMessageWaiters(socket);
      if (kind === 'dashboard') {
        this.dashboards.delete(socket);
      } else if (connectorId && this.connectors.get(connectorId) === socket) {
        this.connectors.delete(connectorId);
        this.connectorFeatures.delete(connectorId);
        this.store.setConnectorOnline(connectorId, false);
        this.emit('connector.offline', { type: 'connector', id: connectorId }, { connector_id: connectorId });
      }
    });
    socket.on('error', (error) => this.logger.error?.(error));
  }

  authorizedCommand(commandId, connectorId) {
    const command = this.store.getCommand(commandId);
    if (!command) return null;
    const worker = this.store.getWorkerForConnector(command.worker_id, connectorId);
    return worker ? command : null;
  }

  workerSession(connectorId, payload) {
    const worker = this.store.getWorkerBySession(
      connectorId,
      requiredString(payload.runtime, 'runtime', { max: 40 }),
      requiredString(payload.runtime_session_id, 'runtime_session_id', { max: 300 }),
    );
    if (!worker || worker.retired_at) throw protocolError('Current Worker identity is unavailable', 403, 'worker_forbidden');
    return worker;
  }

  workerMessageForSender(commandId, sender) {
    const command = this.store.getCommand(commandId);
    if (!command || command.kind !== 'worker_message' || command.sender_worker_id !== sender.worker_id) {
      throw protocolError('Worker message not found for this sender', 404, 'worker_message_not_found');
    }
    return command;
  }

  settleWorkerMessageWaiters(command) {
    if (command?.kind !== 'worker_message' || !['succeeded', 'failed'].includes(command.status)) return;
    const waiters = this.workerMessageWaiters.get(command.command_id);
    if (!waiters) return;
    this.workerMessageWaiters.delete(command.command_id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      this.send(waiter.socket, 'worker_message.result', { command }, waiter.replyTo);
    }
  }

  waitForWorkerMessage(socket, message, command, timeoutMs) {
    const waiter = { socket, replyTo: message.id, timer: null };
    waiter.timer = setTimeout(() => {
      const waiters = this.workerMessageWaiters.get(command.command_id);
      waiters?.delete(waiter);
      if (waiters?.size === 0) this.workerMessageWaiters.delete(command.command_id);
      const latest = this.store.getCommand(command.command_id);
      this.send(socket, 'worker_message.result', {
        command: { ...latest, wait_timed_out: true },
      }, message.id);
    }, timeoutMs);
    waiter.timer.unref();
    const waiters = this.workerMessageWaiters.get(command.command_id) ?? new Set();
    waiters.add(waiter);
    this.workerMessageWaiters.set(command.command_id, waiters);
    this.settleWorkerMessageWaiters(this.store.getCommand(command.command_id));
  }

  clearWorkerMessageWaiters(socket) {
    for (const [commandId, waiters] of this.workerMessageWaiters) {
      for (const waiter of waiters) {
        if (waiter.socket !== socket) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      }
      if (waiters.size === 0) this.workerMessageWaiters.delete(commandId);
    }
  }

  recordConnectorBuild(connectorId, build) {
    const commit = typeof build?.commit === 'string' ? build.commit : null;
    this.connectorBuilds.set(connectorId, { version: build?.version ?? null, commit, dirty: Boolean(build?.dirty) });
    if (commit && this.build.commit && commit !== this.build.commit) {
      this.logger.error?.(`Connector ${connectorId} runs ${shortCommit(commit)}, Hub runs ${shortCommit(this.build.commit)}`);
    }
  }

  async handleConnectorMessage(socket, connectorId, message) {
    const payload = message.payload ?? {};
    if (message.type === 'connector.heartbeat') {
      this.store.touchConnector(connectorId);
      this.send(socket, 'connector.heartbeat', { ts: new Date().toISOString() }, message.id);
      return;
    }
    if (message.type === 'orchestration.list') {
      this.send(socket, 'orchestration.list', {
        orchestrations: this.coordinator.listForConnector(connectorId),
      }, message.id);
      return;
    }
    if (message.type === 'worker.directory') {
      const requester = this.workerSession(connectorId, payload);
      this.send(socket, 'worker.directory', {
        requester_worker_id: requester.worker_id,
        workers: this.store.listWorkerDirectory({ excludeWorkerId: requester.worker_id }),
      }, message.id);
      return;
    }
    if (message.type === 'worker_message.create') {
      const sender = this.workerSession(connectorId, payload);
      const recipient = this.store.getWorker(requiredString(payload.to_worker_id, 'to_worker_id', { max: 100 }));
      if (!recipient) throw protocolError('Recipient Worker not found', 404, 'worker_not_found');
      if (recipient.worker_id === sender.worker_id) throw protocolError('Cannot message the same Worker', 400, 'worker_message_self');
      if (!this.connectorFeatures.get(recipient.connector_id)?.has('worker_message_v1')) {
        throw protocolError('Recipient Connector does not support Worker messages', 409, 'worker_message_unsupported');
      }
      const command = this.store.createCommand({
        task_id: null,
        worker_id: recipient.worker_id,
        sender_worker_id: sender.worker_id,
        kind: 'worker_message',
        input: requiredString(payload.prompt, 'prompt', { max: 200000 }),
        push_capable: recipient.push_capable,
      });
      this.emit('worker_message.created', { type: 'worker', id: sender.worker_id }, {
        connector_id: recipient.connector_id,
        worker_id: recipient.worker_id,
        command_id: command.command_id,
        payload: { sender_worker_id: sender.worker_id, status: command.status },
      });
      this.send(socket, 'worker_message.created', { command }, message.id);
      if (command.status === 'queued') this.dispatch(command);
      return;
    }
    if (message.type === 'worker_message.wait') {
      const sender = this.workerSession(connectorId, payload);
      const command = this.workerMessageForSender(
        requiredString(payload.command_id, 'command_id', { max: 100 }),
        sender,
      );
      if (['succeeded', 'failed'].includes(command.status)) {
        this.send(socket, 'worker_message.result', { command }, message.id);
        return;
      }
      const requestedTimeout = Number(payload.timeout_ms);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(Math.floor(requestedTimeout), 600000)
        : 600000;
      this.waitForWorkerMessage(socket, message, command, timeoutMs);
      return;
    }
    if (message.type === 'task.create') {
      if (payload.orchestrate !== undefined && typeof payload.orchestrate !== 'boolean') {
        throw protocolError('orchestrate must be a boolean');
      }
      const assignee = payload.assignee_worker_id ?? null;
      if (payload.orchestrate === true) {
        if (assignee) throw protocolError('Orchestrated tasks cannot have an initial assignee');
        const result = this.coordinator.createOrchestration({
          title: requiredString(payload.title, 'title', { max: 300 }),
          goal: optionalString(payload.goal),
          context: optionalString(payload.context),
          acceptance: stringArray(payload.acceptance),
          createdBy: `connector:${connectorId}`,
          actor: { type: 'connector', id: connectorId },
        });
        this.send(socket, 'task.created', {
          task: result.task,
          orchestration: this.coordinator.present(result.orchestration),
        }, message.id);
        return;
      }
      if (assignee && !this.store.getWorkerForConnector(assignee, connectorId)) {
        throw protocolError('Assignee worker does not belong to this connector', 403, 'worker_forbidden');
      }
      const task = this.store.createTask({
        title: requiredString(payload.title, 'title', { max: 300 }),
        goal: optionalString(payload.goal),
        context: optionalString(payload.context),
        acceptance: stringArray(payload.acceptance),
        assignee_worker_id: assignee,
        created_by: `connector:${connectorId}`,
      });
      this.emit('task.created', { type: 'connector', id: connectorId }, {
        task_id: task.task_id,
        worker_id: task.assignee_worker_id,
        payload: { title: task.title },
      });
      this.send(socket, 'task.created', { task }, message.id);
      return;
    }
    if (message.type === 'task.update') {
      const task = this.store.getTask(payload.task_id);
      if (!task) throw protocolError('Task not found', 404, 'task_not_found');
      if (!task.assignee_worker_id || !this.store.getWorkerForConnector(task.assignee_worker_id, connectorId)) {
        throw protocolError('Task is not assigned to this connector', 403, 'task_forbidden');
      }
      if (!TASK_STATUSES.has(payload.status)) throw protocolError('Invalid task status', 400, 'invalid_task_status');
      const updated = this.store.updateTask(task.task_id, { status: payload.status });
      this.emit('task.updated', { type: 'connector', id: connectorId }, {
        task_id: updated.task_id,
        worker_id: updated.assignee_worker_id,
        payload: { status: updated.status, assignee_worker_id: updated.assignee_worker_id },
      });
      await this.coordinator.resume();
      this.send(socket, 'task.updated', { task: updated }, message.id);
      return;
    }
    if (message.type === 'command.create') {
      const taskId = payload.task_id ?? null;
      const task = taskId ? this.store.getTask(taskId) : null;
      if (taskId && !task) throw protocolError('Task does not exist', 400, 'task_not_found');
      const workerId = payload.worker_id ?? task?.assignee_worker_id;
      const worker = workerId ? this.store.getWorkerForConnector(workerId, connectorId) : null;
      if (!worker) throw protocolError('Worker is unavailable to this connector', 403, 'worker_forbidden');
      const kind = payload.kind ?? 'prompt';
      if (kind === 'worker_message' || !COMMAND_KINDS.has(kind)) throw protocolError('Unsupported command kind', 400, 'unsupported_command_kind');
      const command = this.store.createCommand({
        task_id: taskId,
        worker_id: worker.worker_id,
        kind,
        input: requiredString(payload.input, 'input', { max: 200000 }),
        push_capable: worker.push_capable,
      });
      this.emit('command.created', { type: 'connector', id: connectorId }, {
        connector_id: connectorId,
        worker_id: worker.worker_id,
        task_id: command.task_id,
        command_id: command.command_id,
        payload: { kind: command.kind, status: command.status },
      });
      if (command.status === 'queued') this.dispatch(command);
      this.send(socket, 'command.created', { command }, message.id);
      return;
    }
    if (message.type === 'worker.register') {
      const worker = this.store.registerWorker(connectorId, workerInput(payload));
      this.emit('worker.registered', { type: 'worker', id: worker.worker_id }, {
        connector_id: connectorId,
        worker_id: worker.worker_id,
        payload: { name: worker.name, runtime: worker.runtime, mode: worker.mode },
      });
      this.send(socket, 'worker.registered', { worker }, message.id);
      return;
    }
    if (message.type === 'worker.unregister') {
      const worker = this.unregisterWorker({
        connectorId,
        runtime: requiredString(payload.runtime, 'runtime'),
        runtimeSessionId: requiredString(payload.runtime_session_id, 'runtime_session_id'),
        actor: { type: 'connector', id: connectorId },
      });
      this.send(socket, 'worker.unregistered', { worker }, message.id);
      return;
    }
    if (message.type === 'worker.channel') {
      const worker = this.store.setWorkerChannel(connectorId, requiredString(payload.worker_id, 'worker_id'), payload.attached === true);
      if (!worker) throw new Error('Interactive Channel requires a Worker of this Connector');
      this.emit(payload.attached === true ? 'worker.channel_attached' : 'worker.channel_detached', { type: 'worker', id: worker.worker_id }, {
        connector_id: connectorId,
        worker_id: worker.worker_id,
      });
      this.broadcast('worker.updated', { worker: this.presentWorker(worker) });
      if (worker.push_capable) this.replay(connectorId);
      this.send(socket, 'worker.channel', { worker }, message.id);
      return;
    }
    if (message.type === 'worker.status') {
      if (payload.work_state !== undefined && !WORK_STATES.has(payload.work_state)) {
        throw new Error('Invalid worker work_state');
      }
      const worker = this.store.updateWorkerStatus(connectorId, payload.worker_id, payload);
      if (!worker) throw new Error('Worker not found for this connector');
      this.emit('worker.status', { type: 'worker', id: worker.worker_id }, {
        connector_id: connectorId,
        worker_id: worker.worker_id,
        task_id: worker.current_task_id,
        payload: { work_state: worker.work_state },
      });
      this.broadcast('worker.updated', { worker: this.presentWorker(worker) });
      return;
    }
    if (message.type === 'command.ack') {
      if (!this.authorizedCommand(payload.command_id, connectorId)) throw new Error('Command not found for this connector');
      const command = this.store.acceptCommand(payload.command_id, connectorId);
      this.emit('command.accepted', { type: 'connector', id: connectorId }, {
        connector_id: connectorId,
        worker_id: command.worker_id,
        task_id: command.task_id,
        command_id: command.command_id,
      });
      this.broadcast('command.updated', { command });
      this.broadcast('worker.updated', { worker: this.presentWorker(this.store.getWorker(command.worker_id)) });
      return;
    }
    if (message.type === 'command.started') {
      if (!this.authorizedCommand(payload.command_id, connectorId)) throw new Error('Command not found for this connector');
      const command = this.store.startCommand(payload.command_id, connectorId);
      const worker = this.store.updateWorkerStatus(connectorId, command.worker_id, {
        work_state: 'working',
        ...(command.task_id ? { current_task_id: command.task_id } : {}),
      });
      if (command.task_id) {
        const task = this.store.getTask(command.task_id);
        if (task && !['done', 'cancelled'].includes(task.status)) this.store.updateTask(task.task_id, { status: 'in_progress' });
      }
      this.emit('command.started', { type: 'worker', id: command.worker_id }, {
        connector_id: connectorId,
        worker_id: command.worker_id,
        task_id: command.task_id,
        command_id: command.command_id,
      });
      this.broadcast('command.updated', { command });
      this.broadcast('worker.updated', { worker: this.presentWorker(worker) });
      return;
    }
    if (message.type === 'command.output') {
      if (!this.authorizedCommand(payload.command_id, connectorId)) throw new Error('Command not found for this connector');
      const command = this.store.appendCommandOutput(payload.command_id, connectorId, payload.chunk);
      this.broadcast('command.output', {
        command_id: command.command_id,
        chunk: String(payload.chunk ?? ''),
        output_truncated: command.output_truncated,
      });
      this.broadcast('worker.updated', { worker: this.presentWorker(this.store.getWorker(command.worker_id)) });
      return;
    }
    if (message.type === 'command.finished') {
      if (!this.authorizedCommand(payload.command_id, connectorId)) throw new Error('Command not found for this connector');
      if (!['succeeded', 'failed'].includes(payload.status)) throw new Error('Invalid final command status');
      const command = this.store.finishCommand(payload.command_id, connectorId, {
        status: payload.status,
        result: payload.result,
        error: payload.error,
        outcomeUnknown: Boolean(payload.outcome_unknown),
      });
      const worker = this.store.updateWorkerStatus(connectorId, command.worker_id, { work_state: 'idle' });
      this.emit(`command.${payload.status}`, { type: 'worker', id: command.worker_id }, {
        connector_id: connectorId,
        worker_id: command.worker_id,
        task_id: command.task_id,
        command_id: command.command_id,
        payload: { error: command.error, outcome_unknown: command.outcome_unknown },
      });
      this.broadcast('command.updated', { command });
      this.broadcast('worker.updated', { worker: this.presentWorker(worker) });
      if (command.kind === 'worker_message') this.settleWorkerMessageWaiters(command);
      else await this.coordinator.onCommandFinished(command);
      return;
    }
    if (message.type === 'command.sync') {
      const command = this.authorizedCommand(payload.command_id, connectorId);
      if (!command) return;
      let updated = command;
      if (payload.status === 'accepted') updated = this.store.acceptCommand(command.command_id, connectorId);
      if (payload.status === 'running') updated = this.store.startCommand(command.command_id, connectorId);
      if (['succeeded', 'failed'].includes(payload.status)) {
        updated = this.store.finishCommand(command.command_id, connectorId, {
          status: payload.status,
          result: payload.result,
          error: payload.error,
          outcomeUnknown: Boolean(payload.outcome_unknown),
        });
        if (updated.kind === 'worker_message') this.settleWorkerMessageWaiters(updated);
        else await this.coordinator.onCommandFinished(updated);
      }
      this.broadcast('command.updated', { command: updated });
      return;
    }
    throw new Error(`Unsupported connector message: ${message.type}`);
  }

  dispatch(command) {
    const worker = this.store.getWorker(command.worker_id);
    const socket = worker && this.connectors.get(worker.connector_id);
    if (!socket) return false;
    const task = command.task_id ? this.store.getTask(command.task_id) : null;
    const directory = COORDINATOR_COMMAND_KINDS.has(command.kind)
      ? null
      : this.store.listWorkerDirectory({ excludeWorkerId: command.worker_id });
    return this.send(socket, 'command.dispatch', {
      command: { ...command, task, ...(directory ? { directory } : {}) },
    });
  }

  replay(connectorId) {
    for (const command of this.store.listQueuedCommands(connectorId)) this.dispatch(command);
  }
}
