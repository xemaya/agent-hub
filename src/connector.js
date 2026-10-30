import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ConnectorStore } from './connector-store.js';
import { bearerToken, tokensEqual } from './auth.js';
import { createId } from './ids.js';
import { readJsonBody, sendJson } from './json.js';
import { readBuildInfo, shortCommit } from './build-info.js';
import { commandPrompt } from './drivers/prompt.js';

function deferred() {
  const state = { settled: false };
  state.promise = new Promise((resolve, reject) => {
    state.resolve = (value) => {
      state.settled = true;
      resolve(value);
    };
    state.reject = (error) => {
      state.settled = true;
      reject(error);
    };
  });
  return state;
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
  constructor(options, store) {
    this.options = options;
    this.store = store;
    this.logger = options.logger ?? console;
    this.enrollToken = options.enrollToken;
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
    this.build = options.build ?? { version: null, commit: null, dirty: false };
    this.hubBuild = null;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10000;
    this.watchdogTimer = null;
    this.heartbeatInFlight = false;
    this.lastHeartbeatAt = 0;
    this.socketStartedAt = 0;
    this.everReady = false;
    this.onVersionMismatch = options.onVersionMismatch ?? null;
    this.checkedHubCommits = new Set();
    this.onRestartRequested = options.onRestartRequested ?? null;
    this.restartRequested = false;
    // Interactive channels: worker_id -> { response, deliveries }, plus streams whose Session is not registered yet.
    this.channels = new Map();
    this.pendingChannels = new Set();
    this.channelKeepaliveMs = options.channelKeepaliveMs ?? 15000;
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
    const build = options.build ?? await readBuildInfo();
    return new Connector({ ...options, build }, store);
  }

  async start() {
    this.stopping = false;
    if (!this.store.hubUrl) throw new Error('hubUrl is required');
    await this.enrollIfNeeded();
    await this.store.recoverInterruptedCommands();
    await this.listenLocal();
    this.connect();
    this.startWatchdog();
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
    if (this.readyState.settled) this.readyState = deferred();
    const socket = new WebSocket(this.connectorWebSocketUrl());
    this.ws = socket;
    this.socketStartedAt = Date.now();
    socket.addEventListener('open', () => {
      this.send('connector.hello', {
        token: this.store.credentials.token,
        build: this.build,
        features: ['worker_message_v1'],
      });
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
    socket.addEventListener('close', (event) => {
      if (this.ws !== socket) return;
      this.detachSocket(`closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`);
    });
    socket.addEventListener('error', () => {
      if (!this.stopping) this.logger.error?.('Hub WebSocket connection error');
    });
  }

  detachSocket(reason) {
    const socket = this.ws;
    this.ws = null;
    this.ready = false;
    this.heartbeatInFlight = false;
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error('Hub connection closed'));
    }
    this.pendingRequests.clear();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(4000, reason.slice(0, 120));
      } catch {}
    }
    if (this.stopping) return;
    const delay = this.scheduleReconnect();
    if (delay !== null) this.logger.error?.(`Hub WebSocket ${reason}; reconnecting in ${delay}ms`);
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return null;
    const delay = Math.min(30000, 500 * (2 ** this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
    return delay;
  }

  // Node's WebSocket has no handshake timeout and never notices a silently dropped
  // connection, so close/error alone cannot be trusted to trigger a reconnect.
  startWatchdog() {
    if (this.watchdogTimer) return;
    const interval = Math.max(50, Math.min(this.heartbeatIntervalMs, this.connectTimeoutMs) / 2);
    this.watchdogTimer = setInterval(() => this.watchdogTick(), interval);
    this.watchdogTimer.unref();
  }

  watchdogTick() {
    if (this.stopping) return;
    if (!this.ws) {
      if (!this.reconnectTimer) this.scheduleReconnect();
      return;
    }
    if (!this.ready) {
      if (Date.now() - this.socketStartedAt > this.connectTimeoutMs) {
        this.detachSocket(`handshake not completed within ${this.connectTimeoutMs}ms`);
      }
      return;
    }
    if (this.heartbeatInFlight || Date.now() - this.lastHeartbeatAt < this.heartbeatIntervalMs) return;
    this.heartbeatInFlight = true;
    this.lastHeartbeatAt = Date.now();
    const socket = this.ws;
    this.request('connector.heartbeat', {}, this.heartbeatTimeoutMs)
      .catch((error) => {
        // Any reply, including an error from a Hub that predates heartbeats, proves the link is alive.
        if (error.code || this.ws !== socket) return;
        this.detachSocket(`heartbeat not answered within ${this.heartbeatTimeoutMs}ms`);
      })
      .finally(() => {
        if (this.ws === socket) this.heartbeatInFlight = false;
      });
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
      this.lastHeartbeatAt = Date.now();
      if (this.everReady) this.logger.error?.('Hub WebSocket reconnected');
      this.everReady = true;
      this.hubBuild = message.payload?.hub ?? null;
      this.readyState.resolve(message.payload);
      this.checkHubVersion();
      await this.syncChannels();
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

  checkHubVersion() {
    const hubCommit = this.hubBuild?.commit;
    const ownCommit = this.build.commit;
    if (!hubCommit || !ownCommit || hubCommit === ownCommit) return;
    if (this.checkedHubCommits.has(hubCommit)) return;
    this.checkedHubCommits.add(hubCommit);
    this.logger.error?.(`Version mismatch: Connector ${shortCommit(ownCommit)}, Hub ${shortCommit(hubCommit)}`);
    if (!this.onVersionMismatch) return;
    Promise.resolve(this.onVersionMismatch({ connector: this.build, hub: this.hubBuild }))
      .catch((error) => this.logger.error?.(`Self-update failed: ${error.message}`));
  }

  // Defers a supervised restart until no interactive command is executing.
  requestRestart() {
    this.restartRequested = true;
    this.maybeRestart();
  }

  maybeRestart() {
    if (!this.restartRequested || this.stopping || this.activeWorkers.size > 0) return;
    this.restartRequested = false;
    this.onRestartRequested?.();
  }

  writeChannelEvent(channel, event) {
    channel.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  openChannel(request, response, { runtime, sessionId }) {
    if (this.stopping) throw localError('Connector is shutting down', 503);
    if (!runtime || !sessionId) throw localError('runtime and session_id are required');
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const channel = { runtime, sessionId, response, workerId: null, deliveries: new Map() };
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), this.channelKeepaliveMs);
    keepalive.unref();
    response.on('close', () => {
      clearInterval(keepalive);
      this.closeChannel(channel).catch((error) => this.logger.error?.(error));
    });
    this.pendingChannels.add(channel);
    this.adoptPendingChannels();
    if (this.pendingChannels.has(channel)) this.writeChannelEvent(channel, { type: 'waiting_registration' });
  }

  adoptPendingChannels() {
    for (const channel of this.pendingChannels) {
      const worker = this.store.getWorkerBySession(channel.runtime, channel.sessionId);
      if (!worker || worker.retired_at) continue;
      this.pendingChannels.delete(channel);
      const previous = this.channels.get(worker.worker_id);
      if (previous && previous !== channel) previous.response.end();
      channel.workerId = worker.worker_id;
      this.channels.set(worker.worker_id, channel);
      this.store.setWorkerPushCapability(worker.worker_id, true);
      this.writeChannelEvent(channel, { type: 'attached', worker_id: worker.worker_id, name: worker.name });
      this.announceChannel(worker.worker_id, true).catch((error) => this.logger.error?.(error));
      this.scheduleWorker(worker.worker_id);
    }
  }

  async closeChannel(channel) {
    this.pendingChannels.delete(channel);
    if (!channel.workerId || this.channels.get(channel.workerId) !== channel) return;
    this.channels.delete(channel.workerId);
    this.store.setWorkerPushCapability(channel.workerId, false);
    for (const delivery of channel.deliveries.values()) {
      delivery.reject(Object.assign(new Error('Interactive session closed before reporting a result'), {
        code: 'channel_closed',
        outcomeUnknown: true,
      }));
    }
    channel.deliveries.clear();
    if (!this.stopping) await this.announceChannel(channel.workerId, false);
  }

  async announceChannel(workerId, attached) {
    if (!this.ready) return;
    await this.request('worker.channel', { worker_id: workerId, attached }).catch((error) => {
      this.logger.error?.(`Channel state for ${workerId} not recorded: ${error.message}`);
    });
  }

  // Tells the Hub which interactive Workers are live after every (re)connect.
  async syncChannels() {
    for (const worker of this.store.listWorkers()) {
      const attached = this.channels.has(worker.worker_id);
      this.store.setWorkerPushCapability(worker.worker_id, attached);
      await this.announceChannel(worker.worker_id, attached);
    }
  }

  deliverToChannel(channel, command) {
    return new Promise((resolve, reject) => {
      channel.deliveries.set(command.command_id, { resolve, reject });
      this.writeChannelEvent(channel, {
        type: 'command',
        command_id: command.command_id,
        task_id: command.task_id ?? command.task?.task_id ?? null,
        kind: command.kind,
        content: commandPrompt(command),
      });
      this.emitOutput(command.command_id, '[delivered to the interactive session]\n');
    });
  }

  handleChannelCall(commandId, action, body) {
    const channel = [...this.channels.values()].find((item) => item.deliveries.has(commandId));
    if (!channel) throw localError('No interactive delivery is waiting for this command', 404);
    if (action === 'ack') {
      this.emitOutput(commandId, '[accepted by the interactive session]\n');
      return { ok: true };
    }
    if (!['succeeded', 'failed'].includes(body.status)) throw localError('status must be succeeded or failed');
    const text = typeof body.result === 'string' ? body.result : '';
    const delivery = channel.deliveries.get(commandId);
    channel.deliveries.delete(commandId);
    if (text) this.emitOutput(commandId, `${text}\n`);
    if (body.status === 'succeeded') {
      delivery.resolve({
        text,
        session_id: channel.sessionId,
        delivery: 'channel',
        ...(body.output_gap === true ? { output_gap: true } : {}),
      });
    } else {
      delivery.reject(Object.assign(new Error(text || 'Interactive session reported failure'), { code: 'reported_failure' }));
    }
    return { ok: true };
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

  canRun(worker) {
    return Boolean(worker && this.channels.has(worker.worker_id));
  }

  async pumpWorker(workerId) {
    try {
      const command = this.store.nextAcceptedCommand(workerId);
      if (!command || this.stopping) return;
      const worker = this.store.getWorker(workerId);
      // Commands wait until the Worker's interactive Channel attaches.
      if (worker && !this.channels.has(workerId)) return;
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
        const channel = this.channels.get(workerId);
        if (!channel) throw new Error('Interactive Channel is not attached');
        const result = await this.deliverToChannel(channel, command);
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
              ...(error.outcomeUnknown ? { outcome_unknown: true } : {}),
            });
        this.send('command.finished', finished);
      }
    } finally {
      this.activeWorkers.delete(workerId);
      if (!this.stopping && this.store.nextAcceptedCommand(workerId) && this.canRun(this.store.getWorker(workerId))) {
        this.scheduleWorker(workerId);
      }
      this.maybeRestart();
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

  async waitForWorkerMessage(commandId, identity) {
    const { command } = await this.request('worker_message.wait', {
      ...identity,
      command_id: commandId,
      timeout_ms: this.commandWaitTimeoutMs,
    }, this.commandWaitTimeoutMs + 5000);
    return command;
  }

  async registerWorker(input) {
    await this.whenReady();
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : '';
    if (!runtime) throw localError('runtime is required');
    if (input.mode !== undefined && input.mode !== 'external') throw localError('Only interactive external Workers are supported');

    let sessionId = input.runtime_session_id ?? input.session_id ?? null;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw localError('runtime_session_id is required for an interactive Worker');
    }
    sessionId = sessionId.trim();
    const response = await this.request('worker.register', {
      name: input.name ?? `${runtime}-${sessionId.slice(0, 8)}`,
      runtime,
      mode: 'external',
      runtime_session_id: sessionId,
      capabilities: input.capabilities ?? [],
      cwd: path.resolve(input.cwd ?? process.cwd()),
      metadata: input.metadata ?? {},
    });
    const worker = await this.store.upsertWorker({
      ...response.worker,
      driver_state: {},
    });
    this.adoptPendingChannels();
    if (this.channels.has(worker.worker_id)) await this.announceChannel(worker.worker_id, true);
    return this.store.getWorker(worker.worker_id);
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
        build: this.build,
        hub_build: this.hubBuild,
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
    if (request.method === 'GET' && url.pathname === '/local/v1/directory') {
      await this.whenReady();
      const directory = await this.request('worker.directory', {
        runtime: url.searchParams.get('runtime') ?? '',
        runtime_session_id: url.searchParams.get('session_id') ?? '',
      });
      sendJson(response, 200, directory);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/local/v1/messages') {
      await this.whenReady();
      const body = await readJsonBody(request);
      if (body.wait !== undefined && typeof body.wait !== 'boolean') {
        throw localError('wait must be a boolean', 400);
      }
      const identity = { runtime: body.runtime, runtime_session_id: body.runtime_session_id };
      const { command } = await this.request('worker_message.create', {
        ...identity,
        to_worker_id: body.to_worker_id,
        prompt: body.prompt,
      });
      const result = body.wait && !['succeeded', 'failed'].includes(command.status)
        ? await this.waitForWorkerMessage(command.command_id, identity)
        : command;
      sendJson(response, body.wait ? 200 : 202, { command: result });
      return;
    }
    const messageMatch = /^\/local\/v1\/messages\/([^/]+)\/wait$/.exec(url.pathname);
    if (request.method === 'POST' && messageMatch) {
      await this.whenReady();
      const body = await readJsonBody(request);
      const command = await this.waitForWorkerMessage(messageMatch[1], {
        runtime: body.runtime,
        runtime_session_id: body.runtime_session_id,
      });
      sendJson(response, 200, { command });
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
    if (request.method === 'GET' && url.pathname === '/local/v1/channel') {
      this.openChannel(request, response, {
        runtime: url.searchParams.get('runtime') ?? '',
        sessionId: url.searchParams.get('session_id') ?? '',
      });
      return;
    }
    const channelMatch = /^\/local\/v1\/channel\/commands\/([^/]+)\/(ack|report)$/.exec(url.pathname);
    if (request.method === 'POST' && channelMatch) {
      const body = await readJsonBody(request);
      sendJson(response, 200, this.handleChannelCall(channelMatch[1], channelMatch[2], body));
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  async close() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    for (const channel of [...this.channels.values(), ...this.pendingChannels]) channel.response.end();
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
    if (this.localServer.listening) {
      const closed = new Promise((resolve) => this.localServer.close(resolve));
      this.localServer.closeAllConnections();
      await closed;
    }
    await this.store.save();
  }
}
