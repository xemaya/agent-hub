import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ConnectorStore } from './connector-store.js';
import { bearerToken, tokensEqual } from './auth.js';
import { createId } from './ids.js';
import { readJsonBody, sendJson } from './json.js';
import { createDefaultDrivers } from './drivers/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function localError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? 'execution_failed',
  };
}

export class Connector {
  constructor(options, store, drivers) {
    this.options = options;
    this.store = store;
    this.drivers = drivers;
    this.logger = options.logger ?? console;
    this.enrollToken = options.enrollToken;
    this.allowTestDriver = Boolean(options.allowTestDriver);
    this.localHost = options.localHost ?? '127.0.0.1';
    this.requestedLocalPort = options.localPort ?? 8788;
    this.ws = null;
    this.readyState = deferred();
    this.ready = false;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pendingRequests = new Map();
    this.commandWaiters = new Map();
    this.commandWaitTimeoutMs = options.commandWaitTimeoutMs ?? 600000;
    this.activeWorkers = new Set();
    this.localServer = createServer((request, response) => {
      this.handleLocalRequest(request, response).catch((error) => {
        sendJson(response, error.statusCode ?? 500, { error: error.message ?? 'Internal server error' });
      });
    });
  }

  static async create(options) {
    const dataDir = path.resolve(options.dataDir ?? '.runtime/connector');
    const store = await ConnectorStore.load(dataDir, {
      hubUrl: options.hubUrl,
      name: options.name ?? os.hostname(),
      hostname: options.hostname ?? os.hostname(),
    });
    const drivers = options.drivers ?? createDefaultDrivers(options);
    return new Connector(options, store, drivers);
  }

  async start() {
    this.stopping = false;
    if (!this.store.hubUrl) throw new Error('hubUrl is required');
    await this.enrollIfNeeded();
    await this.store.recoverInterruptedCommands();
    await this.listenLocal();
    this.connect();
    return this;
  }

  get localPort() {
    const address = this.localServer.address();
    return typeof address === 'object' && address ? address.port : this.requestedLocalPort;
  }

  get localUrl() {
    return `http://${this.localHost}:${this.localPort}`;
  }

  get hubUrl() {
    return this.store.hubUrl.replace(/\/$/, '');
  }

  get connectorId() {
    return this.store.credentials.connectorId;
  }

  async enrollIfNeeded() {
    if (this.store.credentials.token) return;
    if (!this.enrollToken) throw new Error('An enrollment token is required for the first Connector start');
    const response = await fetch(`${this.hubUrl}/api/v1/connectors/enroll`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.enrollToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: this.store.name, hostname: this.store.hostname }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Enrollment failed with HTTP ${response.status}`);
    await this.store.setEnrollment({
      hubUrl: this.hubUrl,
      connectorId: body.connector.connector_id,
      token: body.token,
    });
  }

  async listenLocal() {
    if (this.localServer.listening) return;
    await new Promise((resolve, reject) => {
      this.localServer.once('error', reject);
      this.localServer.listen(this.requestedLocalPort, this.localHost, () => {
        this.localServer.off('error', reject);
        resolve();
      });
    });
  }

  connectorWebSocketUrl() {
    const url = new URL(this.hubUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/connector';
    url.search = '';
    return url.toString();
  }

  connect() {
    if (this.stopping) return;
    this.ready = false;
    this.readyState = deferred();
    const socket = new WebSocket(this.connectorWebSocketUrl());
    this.ws = socket;
    socket.addEventListener('open', () => {
      this.send('connector.hello', { token: this.store.credentials.token });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.logger.error?.('Hub sent an invalid JSON message');
        return;
      }
      this.handleHubMessage(message).catch((error) => {
        this.logger.error?.(error);
        this.send('error', { error: error.message }, message.id);
      });
    });
    socket.addEventListener('close', () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.ready = false;
      for (const { reject, timer } of this.pendingRequests.values()) {
        clearTimeout(timer);
        reject(new Error('Hub connection closed'));
      }
      this.pendingRequests.clear();
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (!this.stopping) this.logger.error?.('Hub WebSocket connection error');
    });
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30000, 500 * (2 ** this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  async whenReady(timeoutMs = 15000) {
    if (this.ready) return;
    let timer;
    try {
      await Promise.race([
        this.readyState.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(localError('Hub is not connected', 503)), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  send(type, payload = {}, replyTo, id = createId('msg')) {
    if (type === 'command.finished') this.settleCommandWaiters(payload);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const message = { type, id, ts: new Date().toISOString(), payload };
    if (replyTo) message.reply_to = replyTo;
    this.ws.send(JSON.stringify(message));
    return id;
  }

  request(type, payload, timeoutMs = 15000) {
    const id = createId('msg');
    if (!this.send(type, payload, undefined, id)) {
      return Promise.reject(localError('Hub is not connected', 503));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Hub request timed out: ${type}`));
      }, timeoutMs);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  async handleHubMessage(message) {
    if (message.reply_to && this.pendingRequests.has(message.reply_to)) {
      const pending = this.pendingRequests.get(message.reply_to);
      this.pendingRequests.delete(message.reply_to);
      clearTimeout(pending.timer);
      if (message.type === 'error') {
        const error = new Error(message.payload?.error ?? 'Hub request failed');
        error.code = message.payload?.code ?? 'connector_request_failed';
        error.statusCode = message.payload?.status_code ?? 502;
        pending.reject(error);
      } else pending.resolve(message.payload);
      return;
    }
    if (message.type === 'connector.ready') {
      this.ready = true;
      this.reconnectAttempts = 0;
      this.readyState.resolve(message.payload);
      await this.syncAndPump();
      return;
    }
    if (message.type === 'command.dispatch') {
      await this.receiveCommand(message.payload.command);
      return;
    }
    if (message.type === 'worker.unregistered') {
      await this.applyWorkerRetirement(message.payload.worker);
      return;
    }
    if (message.type === 'error') {
      throw new Error(message.payload?.error ?? 'Hub error');
    }
  }

  async syncAndPump() {
    for (const command of this.store.listCommands()) {
      this.send('command.sync', {
        command_id: command.command_id,
        status: command.status,
        result: command.result,
        error: command.error,
        outcome_unknown: command.outcome_unknown,
      });
      if (command.status === 'accepted') this.scheduleWorker(command.worker_id);
    }
  }

  async receiveCommand(command) {
    if (!command?.command_id || !command.worker_id) throw new Error('Invalid dispatched command');
    const accepted = await this.store.acceptCommand(command);
    if (['succeeded', 'failed'].includes(accepted.status)) {
      this.send('command.sync', {
        command_id: accepted.command_id,
        status: accepted.status,
        result: accepted.result,
        error: accepted.error,
        outcome_unknown: accepted.outcome_unknown,
      });
      return;
    }
    this.send('command.ack', { command_id: accepted.command_id });
    this.scheduleWorker(accepted.worker_id);
  }

  scheduleWorker(workerId) {
    if (this.activeWorkers.has(workerId)) return;
    this.activeWorkers.add(workerId);
    queueMicrotask(() => {
      this.pumpWorker(workerId).catch((error) => this.logger.error?.(error));
    });
  }

  async pumpWorker(workerId) {
    try {
      const command = this.store.nextAcceptedCommand(workerId);
      if (!command || this.stopping) return;
      const worker = this.store.getWorker(workerId);
      if (!worker) {
        const failed = await this.store.updateCommand(command.command_id, {
          status: 'failed',
          error: { message: 'Worker registration is missing on this Connector', code: 'worker_missing' },
        });
        this.send('command.finished', failed);
        return;
      }
      await this.store.updateCommand(command.command_id, { status: 'running' });
      this.send('command.started', { command_id: command.command_id });
      try {
        const driver = this.drivers[worker.runtime];
        if (worker.mode !== 'managed' || !driver) throw new Error(`No managed driver for ${worker.runtime}`);
        const result = await driver.execute({
          worker,
          command,
          onOutput: (chunk) => this.emitOutput(command.command_id, chunk),
          onState: (state) => this.store.updateDriverState(workerId, state),
        });
        const current = this.store.getCommand(command.command_id);
        if (current.status === 'failed' && current.outcome_unknown) {
          this.send('command.finished', current);
        } else {
          const finished = await this.store.updateCommand(command.command_id, {
            status: 'succeeded',
            result: result ?? null,
            error: null,
          });
          this.send('command.finished', finished);
        }
      } catch (error) {
        const current = this.store.getCommand(command.command_id);
        const finished = current.status === 'failed' && current.outcome_unknown
          ? current
          : await this.store.updateCommand(command.command_id, {
              status: 'failed',
              error: normalizeError(error),
              result: null,
            });
        this.send('command.finished', finished);
      }
    } finally {
      this.activeWorkers.delete(workerId);
      if (!this.stopping && this.store.nextAcceptedCommand(workerId)) this.scheduleWorker(workerId);
    }
  }

  emitOutput(commandId, chunk) {
    const text = String(chunk ?? '');
    for (let offset = 0; offset < text.length; offset += 16384) {
      this.send('command.output', { command_id: commandId, chunk: text.slice(offset, offset + 16384) });
    }
  }

  isCommandComplete(command) {
    return command && ['succeeded', 'failed', 'waiting_manual'].includes(command.status);
  }

  settleCommandWaiters(command) {
    if (!command?.command_id || !this.isCommandComplete(command)) return;
    const waiters = this.commandWaiters.get(command.command_id);
    if (!waiters) return;
    this.commandWaiters.delete(command.command_id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(command);
    }
  }

  async waitForCommand(commandId) {
    const current = this.store.getCommand(commandId);
    if (this.isCommandComplete(current)) return current;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const waiters = this.commandWaiters.get(commandId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) this.commandWaiters.delete(commandId);
        }
        const latest = this.store.getCommand(commandId);
        if (!latest) {
          reject(localError('Command not found while waiting', 404));
          return;
        }
        resolve(this.isCommandComplete(latest) ? latest : { ...latest, wait_timed_out: true });
      }, this.commandWaitTimeoutMs);
      waiter.timer.unref();
      const waiters = this.commandWaiters.get(commandId) ?? new Set();
      waiters.add(waiter);
      this.commandWaiters.set(commandId, waiters);
      const latest = this.store.getCommand(commandId);
      if (this.isCommandComplete(latest)) this.settleCommandWaiters(latest);
    });
  }

  async registerWorker(input) {
    await this.whenReady();
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    const mode = input.mode ?? 'managed';
    if (!runtime) throw localError('runtime is required');
    if (!['managed', 'external'].includes(mode)) throw localError('mode must be managed or external');
    if (runtime === 'test' && !this.allowTestDriver) throw localError('Test driver is disabled', 403);
    if (mode === 'managed' && !this.drivers[runtime]) throw localError(`Unsupported managed runtime: ${runtime}`);

    let sessionId = input.runtime_session_id ?? input.session_id ?? null;
    if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim())) {
      throw localError('runtime_session_id must be a non-empty string');
    }
    if (sessionId) sessionId = sessionId.trim();
    const existing = sessionId ? this.store.getWorkerBySession(runtime, sessionId) : null;
    let driverState = existing?.driver_state ?? {};
    if (!existing) {
      if (mode === 'external' && !sessionId) throw localError('runtime_session_id is required for an external Worker');
      if (mode === 'managed') {
        const prepared = await this.drivers[runtime].prepareWorker(input);
        sessionId = prepared.runtime_session_id;
        driverState = prepared.driver_state ?? {};
      }
    }
    const response = await this.request('worker.register', {
      name: input.name ?? `${runtime}-${sessionId.slice(0, 8)}`,
      runtime,
      mode,
      runtime_session_id: sessionId,
      capabilities: input.capabilities ?? [],
      cwd: path.resolve(input.cwd ?? process.cwd()),
      metadata: input.metadata ?? {},
    });
    const worker = await this.store.upsertWorker({
      ...response.worker,
      driver_state: driverState,
    });
    return worker;
  }

  async applyWorkerRetirement(worker) {
    const existing = this.store.getWorker(worker.worker_id);
    if (!existing) return this.store.upsertWorker({ ...worker, driver_state: {} });
    return this.store.retireWorker(worker.worker_id, { retiredAt: worker.retired_at ?? undefined });
  }

  async unregisterCurrent(input) {
    await this.whenReady();
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    const sessionId = typeof input.runtime_session_id === 'string' ? input.runtime_session_id.trim() : '';
    if (!runtime || !sessionId) throw localError('runtime and runtime_session_id are required');
    const response = await this.request('worker.unregister', { runtime, runtime_session_id: sessionId });
    return this.applyWorkerRetirement(response.worker);
  }

  validateLocalRequest(request) {
    const host = request.headers.host;
    try {
      const hostname = new URL(`http://${host}`).hostname;
      if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) throw new Error();
      if (request.headers.origin) {
        const origin = new URL(request.headers.origin).hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(origin)) throw new Error();
      }
    } catch {
      throw localError('Invalid local Host or Origin', 403);
    }
  }

  requireLocalAuth(request) {
    if (!tokensEqual(bearerToken(request), this.store.credentials.localToken)) {
      throw localError('Local authentication required', 401);
    }
  }

  async handleLocalRequest(request, response) {
    this.validateLocalRequest(request);
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/local/v1/health') {
      sendJson(response, 200, {
        ok: true,
        connector_id: this.connectorId,
        hub_url: this.hubUrl,
        hub_connected: this.ready,
      });
      return;
    }
    this.requireLocalAuth(request);
    if (request.method === 'GET' && url.pathname === '/local/v1/orchestrations') {
      await this.whenReady();
      const { orchestrations } = await this.request('orchestration.list');
      sendJson(response, 200, { orchestrations });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/local/v1/tasks') {
      await this.whenReady();
      const body = await readJsonBody(request);
      if (body.assignee_worker_id && !this.store.getWorker(body.assignee_worker_id)) {
        throw localError('Assignee worker does not belong to this Connector', 403);
      }
      const { task, orchestration } = await this.request('task.create', body);
      sendJson(response, body.orchestrate === true ? 202 : 201, {
        task,
        ...(orchestration ? { orchestration } : {}),
      });
      return;
    }
    const taskMatch = /^\/local\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'PATCH' && taskMatch) {
      await this.whenReady();
      const body = await readJsonBody(request);
      if (Object.keys(body).some((key) => key !== 'status')) {
        throw localError('Local task updates only support status', 400);
      }
      const { task } = await this.request('task.update', {
        task_id: taskMatch[1],
        status: body.status,
      });
      sendJson(response, 200, { task });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/local/v1/commands') {
      await this.whenReady();
      const body = await readJsonBody(request);
      if (body.wait !== undefined && typeof body.wait !== 'boolean') {
        throw localError('wait must be a boolean', 400);
      }
      if (body.worker_id && !this.store.getWorker(body.worker_id)) {
        throw localError('Worker does not belong to this Connector', 403);
      }
      const { command } = await this.request('command.create', {
        task_id: body.task_id,
        worker_id: body.worker_id,
        kind: body.kind,
        input: body.input,
      });
      const result = body.wait && !this.isCommandComplete(command)
        ? await this.waitForCommand(command.command_id)
        : command;
      sendJson(response, body.wait ? 200 : 202, { command: result });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/local/v1/workers') {
      sendJson(response, 200, { workers: this.store.listWorkers() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/local/v1/workers/unregister-current') {
      const body = await readJsonBody(request);
      const worker = await this.unregisterCurrent(body);
      sendJson(response, 200, { worker });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/local/v1/workers/register') {
      const body = await readJsonBody(request);
      const worker = await this.registerWorker(body);
      sendJson(response, 201, { worker });
      return;
    }
    const statusMatch = /^\/local\/v1\/workers\/([^/]+)\/status$/.exec(url.pathname);
    if (request.method === 'POST' && statusMatch) {
      await this.whenReady();
      const worker = this.store.getWorker(statusMatch[1]);
      if (!worker) throw localError('Worker not found', 404);
      const body = await readJsonBody(request);
      if (!['idle', 'working', 'waiting', 'blocked'].includes(body.work_state)) {
        throw localError('Invalid work_state');
      }
      this.send('worker.status', {
        worker_id: worker.worker_id,
        work_state: body.work_state,
        current_task_id: body.current_task_id,
      });
      sendJson(response, 202, { ok: true });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  async close() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.store.failRunningCommands();
    if (this.ws) this.ws.close(1000, 'Connector shutting down');
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error('Connector shutting down'));
    }
    this.pendingRequests.clear();
    for (const waiters of this.commandWaiters.values()) {
      for (const { reject, timer } of waiters) {
        clearTimeout(timer);
        reject(new Error('Connector shutting down'));
      }
    }
    this.commandWaiters.clear();
    for (const driver of Object.values(this.drivers)) await driver.close?.();
    if (this.localServer.listening) {
      await new Promise((resolve) => this.localServer.close(resolve));
    }
    await this.store.save();
  }
}
