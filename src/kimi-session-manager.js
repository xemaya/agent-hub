import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cleanLine(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export class KimiSessionManager {
  constructor(options = {}) {
    this.executable = options.executable ?? 'kimi';
    this.spawn = options.spawn ?? spawn;
    this.env = options.env ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15000;
    this.server = options.server
      ? { baseUrl: options.server.baseUrl.replace(/\/$/, ''), token: options.server.token, owned: false }
      : null;
    this.process = null;
    this.starting = null;
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

  async prepareSession(input) {
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

  async close() {
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
