import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createId } from '../ids.js';
import { commandPrompt } from './prompt.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cleanLine(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function deltaText(payload) {
  const value = payload?.delta ?? payload?.text ?? payload?.content ?? '';
  if (typeof value === 'string') return value;
  if (typeof value?.text === 'string') return value.text;
  return '';
}

function errorMessage(payload, fallback) {
  const value = payload?.error ?? payload?.message;
  if (typeof value === 'string') return value;
  if (typeof value?.message === 'string') return value.message;
  return fallback;
}

export class KimiDriver {
  constructor(options = {}) {
    this.executable = options.executable ?? 'kimi';
    this.spawn = options.spawn ?? spawn;
    this.env = options.env ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15000;
    this.model = options.model ?? this.env.AGENT_HUB_KIMI_MODEL ?? null;
    this.server = options.server
      ? { baseUrl: options.server.baseUrl.replace(/\/$/, ''), token: options.server.token, owned: false }
      : null;
    this.process = null;
    this.starting = null;
    this.executions = new Map();
  }

  async ensureServer() {
    if (this.server) return this.server;
    if (this.starting) return this.starting;
    this.starting = this.startServer();
    try {
      this.server = await this.starting;
      return this.server;
    } finally {
      this.starting = null;
    }
  }

  async startServer() {
    const child = this.spawn(this.executable, ['web', '--no-open', '--host', '127.0.0.1'], {
      cwd: process.cwd(),
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      let baseUrl = null;
      let token = null;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error('Timed out while starting the local Kimi server'));
        }
      }, this.startupTimeoutMs);
      timer.unref();

      const finish = () => {
        if (settled || !baseUrl || !token) return;
        settled = true;
        clearTimeout(timer);
        resolve({ baseUrl, token, owned: true });
      };
      const inspect = (line) => {
        const clean = cleanLine(line);
        const local = /\bLocal:\s*(https?:\/\/\S+)/.exec(clean);
        const accessToken = /\bToken:\s*(\S+)/.exec(clean);
        if (local) baseUrl = new URL(local[1]).origin;
        if (accessToken) token = accessToken[1];
        finish();
      };
      if (child.stdout) createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', inspect);
      if (child.stderr) createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', inspect);
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Kimi server exited during startup with code ${code ?? 'unknown'}`));
        }
        if (this.process === child) {
          this.process = null;
          this.server = null;
        }
      });
    });
  }

  async api(pathname, { method = 'GET', body } = {}) {
    const server = await this.ensureServer();
    const response = await this.fetch(`${server.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      const error = new Error(payload.msg ?? `Kimi API request failed with HTTP ${response.status}`);
      error.code = payload.code ?? 'kimi_api_failed';
      throw error;
    }
    return payload.data;
  }

  async prepareWorker(input) {
    await this.ensureServer();
    if (input.runtime_session_id) {
      return { runtime_session_id: input.runtime_session_id, driver_state: { started: true } };
    }
    const data = await this.api('/api/v1/sessions', {
      method: 'POST',
      body: { metadata: { cwd: path.resolve(input.cwd ?? process.cwd()) } },
    });
    const sessionId = data?.id ?? data?.session_id;
    if (!sessionId) throw new Error('Kimi did not return a session id');
    return { runtime_session_id: sessionId, driver_state: { started: false } };
  }

  async execute({ worker, command, onOutput, onState }) {
    const server = await this.ensureServer();
    const sessionId = worker.runtime_session_id;
    const url = new URL(`${server.baseUrl}/api/v1/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.WebSocket(url, [`kimi-code.bearer.${server.token}`]);
    const subscriptionId = createId('sub');
    let promptId = null;
    let text = '';
    let outputGap = false;
    let settled = false;
    let resolveTurn;
    let rejectTurn;
    let resolveSubscribed;
    let rejectSubscribed;
    const turn = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const subscribed = new Promise((resolve, reject) => {
      resolveSubscribed = resolve;
      rejectSubscribed = reject;
    });
    turn.catch(() => {});
    subscribed.catch(() => {});
    const execution = {
      socket,
      reject: (error) => {
        rejectTurn(error);
        rejectSubscribed(error);
      },
    };
    this.executions.set(command.command_id, execution);

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolveTurn();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectTurn(error instanceof Error ? error : new Error(String(error)));
    };
    const appendDelta = (delta, offset) => {
      if (!delta) return;
      let addition = delta;
      if (typeof offset === 'number') {
        if (offset < text.length) addition = addition.slice(text.length - offset);
        if (offset > text.length) outputGap = true;
      }
      if (!addition) return;
      text += addition;
      onOutput(addition);
    };

    socket.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.session_id && frame.session_id !== sessionId) return;
      if (frame.type === 'ack' && frame.id === subscriptionId) {
        if (frame.code === 0) resolveSubscribed(frame.payload);
        else rejectSubscribed(new Error(frame.msg ?? 'Kimi subscription failed'));
        return;
      }
      if (frame.type === 'assistant.delta') {
        appendDelta(deltaText(frame.payload), frame.offset);
        return;
      }
      if (frame.type === 'tool.call.started') {
        const name = frame.payload?.tool_name ?? frame.payload?.name ?? frame.payload?.tool_call?.name;
        onOutput(`[tool] ${name ?? 'unknown'}\n`);
        return;
      }
      if (frame.type === 'event.approval.requested') {
        onOutput('[approval required in the Kimi session]\n');
        return;
      }
      if (frame.type === 'event.question.requested') {
        onOutput('[question requested in the Kimi session]\n');
        return;
      }
      if (frame.type === 'error') {
        fail(new Error(errorMessage(frame.payload, 'Kimi reported an execution error')));
        return;
      }
      if (frame.type === 'turn.ended') {
        const status = String(frame.payload?.status ?? frame.payload?.outcome ?? '').toLowerCase();
        if (frame.payload?.error || ['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) {
          fail(new Error(errorMessage(frame.payload, `Kimi turn ended with status ${status || 'failed'}`)));
        } else {
          succeed();
        }
      }
    });
    const connectionFailed = () => {
      const error = new Error('Kimi WebSocket connection failed');
      rejectSubscribed(error);
      fail(error);
    };
    socket.addEventListener('error', connectionFailed);
    socket.addEventListener('close', () => {
      if (!settled) {
        const error = new Error('Kimi WebSocket closed before the turn ended');
        rejectSubscribed(error);
        fail(error);
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out connecting to the Kimi WebSocket')), 10000);
        timer.unref();
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('Unable to connect to the Kimi WebSocket'));
        }, { once: true });
      });
      socket.send(JSON.stringify({
        type: 'subscribe',
        id: subscriptionId,
        payload: { session_ids: [sessionId] },
      }));
      let subscriptionTimer;
      try {
        await Promise.race([
          subscribed,
          new Promise((_, reject) => {
            subscriptionTimer = setTimeout(() => reject(new Error('Timed out waiting for the Kimi subscription ACK')), 10000);
            subscriptionTimer.unref();
          }),
        ]);
      } finally {
        clearTimeout(subscriptionTimer);
      }
      const model = worker.metadata?.kimi_model ?? this.model;
      const accepted = await this.api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
        method: 'POST',
        body: {
          prompt_id: command.command_id,
          content: [{ type: 'text', text: commandPrompt(command) }],
          ...(model ? { model } : {}),
          ...(worker.metadata?.kimi_permission_mode
            ? { permission_mode: worker.metadata.kimi_permission_mode }
            : {}),
          ...(Array.isArray(worker.metadata?.kimi_disabled_tools)
            ? { disabled_tools: worker.metadata.kimi_disabled_tools }
            : {}),
        },
      });
      promptId = accepted?.prompt_id ?? command.command_id;
      await onState({ started: true, prompt_id: promptId });
      await turn;
      return {
        text,
        session_id: sessionId,
        prompt_id: promptId,
        output_gap: outputGap,
      };
    } finally {
      settled = true;
      this.executions.delete(command.command_id);
      if (socket.readyState === this.WebSocket.OPEN || socket.readyState === this.WebSocket.CONNECTING) {
        socket.close(1000, 'Command finished');
      }
    }
  }

  async close() {
    for (const execution of this.executions.values()) {
      execution.reject(new Error('Connector is shutting down'));
      execution.socket.close(1001, 'Connector shutting down');
    }
    this.executions.clear();
    const child = this.process;
    if (child) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await Promise.race([closed, sleep(3000)]);
    }
    this.process = null;
    if (this.server?.owned) this.server = null;
  }
}
