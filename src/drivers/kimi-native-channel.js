import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

function channelError(message, code, outcomeUnknown = false) {
  const error = new Error(message);
  error.code = code;
  if (outcomeUnknown) error.outcomeUnknown = true;
  return error;
}

export class KimiNativeChannelDriver {
  constructor({ socketPath, sessionId, retryMs = 250, readyTimeoutMs = 30000, logger = {}, onClosed = null }) {
    this.socketPath = socketPath;
    this.sessionId = sessionId;
    this.retryMs = retryMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.logger = logger;
    this.onClosed = onClosed;
    this.socket = null;
    this.ready = false;
    this.readySessionId = null;
    this.readyWaiters = new Set();
    this.queue = [];
    this.activeJob = null;
    this.retryTimer = null;
    this.stopped = true;
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.socket) return;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    const reader = createInterface({ input: socket, crlfDelay: Infinity });
    reader.on('error', () => {});
    reader.on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.logger.error?.(`Kimi native Channel: ${error.message}`);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      reader.close();
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      if (this.activeJob?.dispatched) {
        this.failActive(channelError('Kimi native TUI closed the Channel before reporting a result', 'native_channel_closed', true));
      }
      if (!this.stopped) this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, this.retryMs);
      this.retryTimer?.unref();
    });
  }

  whenReady() {
    if (this.stopped) return Promise.reject(channelError('Kimi native Channel is closed', 'native_channel_closed'));
    if (this.ready) {
      if (this.readySessionId === this.sessionId) return Promise.resolve();
      return Promise.reject(channelError('Kimi native TUI switched to a different Session', 'native_session_changed'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(channelError('Kimi native TUI Channel is not ready', 'native_channel_not_ready'));
      }, this.readyTimeoutMs);
      waiter.timer.unref();
      this.readyWaiters.add(waiter);
    });
  }

  handleMessage(message) {
    if (message.version !== 1 || typeof message.type !== 'string') throw channelError('Unsupported native Channel message', 'native_protocol_error');
    if (message.type === 'ready') {
      this.readySessionId = message.session_id;
      this.ready = true;
      const mismatch = this.readySessionId !== this.sessionId;
      for (const waiter of this.readyWaiters) {
        clearTimeout(waiter.timer);
        if (mismatch) waiter.reject(channelError('Kimi native TUI switched to a different Session', 'native_session_changed'));
        else waiter.resolve();
      }
      this.readyWaiters.clear();
      return;
    }
    const job = this.activeJob;
    if (!job || message.request_id !== job.command.command_id) return;
    if (message.type === 'prompt.accepted') {
      job.onState?.({ started: true, prompt_id: job.command.command_id });
      return;
    }
    if (message.type === 'prompt.started') {
      job.turnId = message.turn_id;
      return;
    }
    if (message.type === 'assistant.delta') {
      if (job.turnId !== undefined && message.turn_id !== job.turnId) return;
      const delta = typeof message.delta === 'string' ? message.delta : '';
      job.text += delta;
      job.onOutput?.(delta);
      return;
    }
    if (message.type === 'prompt.completed') {
      this.activeJob = null;
      if (message.status === 'succeeded') {
        job.resolve({
          text: job.text,
          session_id: this.sessionId,
          prompt_id: job.command.command_id,
          output_gap: message.output_gap === true,
        });
      } else {
        const error = channelError(message.error || `Kimi native prompt ended with ${message.status}`, 'native_prompt_failed');
        error.resultText = job.text;
        job.reject(error);
      }
      this.pump();
      return;
    }
    if (message.type === 'error') {
      this.activeJob = null;
      job.reject(channelError(message.error || 'Kimi native TUI rejected the prompt', 'native_prompt_rejected'));
      this.pump();
    }
  }

  enqueue(job) {
    job.text = '';
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.queue.push(job);
    this.pump();
    return job.promise;
  }

  execute({ command, onOutput, onState }) {
    return this.enqueue({ command, onOutput, onState });
  }

  async pump() {
    if (this.activeJob || this.stopped) return;
    const job = this.queue.shift();
    if (!job) return;
    this.activeJob = job;
    try {
      await this.whenReady();
      if (this.stopped || this.activeJob !== job) return;
      if (!this.socket) throw channelError('Kimi native TUI Channel is unavailable', 'native_channel_not_ready');
      if (this.readySessionId !== this.sessionId) throw channelError('Kimi native TUI switched to a different Session', 'native_session_changed');
      job.dispatched = true;
      this.socket.write(`${JSON.stringify({ version: 1, type: 'prompt', id: job.command.command_id, text: job.command.input })}\n`);
    } catch (error) {
      if (this.activeJob !== job) return;
      this.activeJob = null;
      job.reject(error);
      if (error.code === 'native_session_changed') {
        this.stop();
        this.onClosed?.();
      }
      this.pump();
    }
  }

  failActive(error) {
    if (this.activeJob) {
      const job = this.activeJob;
      this.activeJob = null;
      if (!job.dispatched) error.outcomeUnknown = false;
      job.reject(error);
    }
    for (const job of this.queue.splice(0)) {
      job.reject(channelError('Kimi native Channel closed before dispatch', 'native_channel_closed'));
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(channelError('Kimi native Channel is closed', 'native_channel_closed'));
    }
    this.readyWaiters.clear();
    this.socket?.destroy();
    this.socket = null;
    this.ready = false;
    this.failActive(channelError('Kimi native Channel stopped before reporting a result', 'native_channel_closed', true));
  }

  async close() {
    this.stop();
  }
}
