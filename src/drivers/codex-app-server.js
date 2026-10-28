import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function failure(message, outcomeUnknown = false) {
  return Object.assign(new Error(message), { code: 'codex_app_server_failed', outcomeUnknown });
}

// One persistent process owns one native thread. No exec/resume subprocess per prompt.
export class CodexAppServerDriver {
  constructor({ sessionId = null, cwd = process.cwd(), sandbox = 'read-only',
    env = process.env, executable = 'codex', spawn: spawnProcess = spawn,
    input = process.stdin, output = process.stdout, logger = {}, requestTimeoutMs = 15000 } = {}) {
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Codex sandbox must be read-only or workspace-write');
    Object.assign(this, { sessionId, cwd, sandbox, env, executable, spawn: spawnProcess, input, output, logger, requestTimeoutMs });
    this.pending = new Map();
    this.queue = [];
    this.nextId = 1;
    this.active = null;
    this.closed = false;
    this.exitCode = null;
    this.permission = null;
    this.onClose = null;
  }

  async start() {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try { await this.starting; this.started = true; }
    catch (error) { await this.close(); throw error; }
    finally { this.starting = null; }
  }

  async startProcess() {
    const env = { ...this.env, AGENT_HUB_RUNTIME: 'codex' };
    // An enclosing agent's launcher identity must never leak into this thread.
    delete env.AGENT_HUB_SESSION_ID;
    delete env.CODEX_SESSION_ID;
    this.child = this.spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = this.child;
    this.stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-8192); });
    child.stdin.on('error', error => this.terminate(failure(error.message, Boolean(this.active)), 1));
    child.once('error', error => { this.childClosed = true; this.terminate(failure(error.message), 1); });
    child.once('close', (code, signal) => {
      this.childClosed = true;
      this.resolveChildClosed?.();
      this.terminate(failure(`Codex app-server exited (${signal ?? code ?? 'unknown'})`, Boolean(this.active)), this.closed ? 0 : (code || 1));
    });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (!line.trim()) return;
      try { this.handleMessage(JSON.parse(line)); }
      catch (error) { this.terminate(failure(`Invalid Codex protocol message: ${error.message}`, Boolean(this.active)), 1); }
    });
    this.lines.on('close', () => {
      if (!this.closed) this.terminate(failure('Codex app-server output closed', Boolean(this.active)), 1);
    });
    await this.request('initialize', { clientInfo: { name: 'agent_hub', title: 'Agent Hub', version: '0.1.0' } });
    this.write({ method: 'initialized', params: {} });
    const result = await this.request(this.sessionId ? 'thread/resume' : 'thread/start', {
      ...(this.sessionId ? { threadId: this.sessionId } : {}),
      cwd: this.cwd, sandbox: this.sandbox, approvalPolicy: 'on-request',
    });
    const nativeId = result?.thread?.id;
    if (typeof nativeId !== 'string' || !nativeId) throw failure('Codex did not return a native thread id');
    if (this.sessionId && nativeId !== this.sessionId) throw failure('Codex resumed a different thread');
    this.sessionId = nativeId;
  }

  write(message) {
    if (this.closed || !this.child || this.childClosed) throw failure('Codex app-server is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = failure(`Codex request timed out: ${method}`, method === 'turn/start');
        reject(error);
        // A timed-out turn may still be running: close rather than start another.
        this.terminate(error, 1);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  handleMessage(message) {
    if (message.method && message.id !== undefined) return this.handleServerRequest(message);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(failure(message.error.message ?? 'Codex request failed'));
      else pending.resolve(message.result);
      return;
    }
    const job = this.active;
    const params = message.params ?? {};
    if (!job || params.threadId !== this.sessionId) return;
    // Notifications can arrive before the turn/start response on a fast server.
    if (!job.turnId) { job.events.push(message); return; }
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId !== job.turnId) return;
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const item = params.item;
      if (typeof item.text === 'string') {
        this.output.write(`${item.text}\n`);
        job.onOutput?.(`${item.text}\n`);
        if (!item.phase || item.phase === 'final_answer') job.text = item.text;
      }
    }
    if (message.method === 'turn/completed') {
      job.finished = true;
      if (params.turn.status === 'completed') job.resolve({ text: job.text, session_id: this.sessionId, output_gap: !job.text });
      else job.reject(failure(params.turn.error?.message ?? `Codex turn ${params.turn.status}`));
    }
  }

  handleServerRequest(message) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];
    // Requests concerning another turn are never actionable in this window.
    const params = message.params ?? {};
    if (!supported.includes(message.method) || !this.active || params.threadId !== this.sessionId
      || !this.active.turnId || params.turnId !== this.active.turnId || !this.rl || this.permission) {
      this.write({ id: message.id, error: { code: -32601, message: 'Request requires an interactive local approval; unsupported requests are not auto-approved' } });
      return;
    }
    const offered = params.availableDecisions;
    const choices = ['accept', 'decline'].filter(choice => !Array.isArray(offered) || offered.includes(choice));
    if (!choices.length) {
      this.write({ id: message.id, error: { code: -32602, message: 'No supported approval decisions' } });
      return;
    }
    this.permission = { id: message.id, choices };
    this.output.write(`\nPermission required: ${params.command ?? params.reason ?? message.method}\n`);
    choices.forEach((choice, index) => this.output.write(`  ${index + 1}. ${choice}\n`));
    this.rl.setPrompt('Choose an option: ');
    this.rl.prompt();
  }

  execute({ command, onOutput, onState }) {
    if (!this.started || this.closed) return Promise.reject(failure('Codex app-server is not running'));
    return new Promise((resolve, reject) => {
      this.queue.push({ command, onOutput, onState, resolve, reject });
      this.pump();
    });
  }

  prompt(text) { return this.execute({ command: { input: text } }); }
  showInbound(text) { this.output.write(`\n[Agent Hub] ${text}\n`); }

  async pump() {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    let resolveTurn, rejectTurn;
    const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completion.catch(() => {});
    this.active = { ...job, resolve: resolveTurn, reject: rejectTurn, text: '', events: [], turnId: null };
    try {
      const response = await this.request('turn/start', {
        threadId: this.sessionId, input: [{ type: 'text', text: job.command.input }],
      });
      const active = this.active;
      if (!response?.turn?.id) throw failure('Codex did not return a turn id', true);
      active.turnId = response.turn.id;
      await job.onState?.({ started: true, session_id: this.sessionId, prompt_id: job.command.command_id });
      for (const event of active.events.splice(0)) this.handleMessage(event);
      job.resolve(await completion);
    } catch (error) {
      job.reject(error);
      if (this.active?.turnId && !this.active.finished) {
        this.terminate(failure(error.message, true), 1);
      }
    }
    finally {
      this.active = null;
      this.permission = null;
      this.pump();
    }
  }

  handleLine(line) {
    const text = line.trim();
    if (['/exit', '/quit'].includes(text)) { void this.close(); return; }
    if (this.permission) {
      const decision = this.permission.choices[Number(text) - 1];
      if (!decision) { this.output.write('Choose an option number.\n'); this.rl?.prompt(); return; }
      this.write({ id: this.permission.id, result: { decision } });
      this.permission = null;
    } else if (text) {
      this.prompt(text).catch(error => this.output.write(`${error.message}\n`)).finally(() => this.rl?.prompt());
    }
    this.rl?.setPrompt('codex> ');
    this.rl?.prompt();
  }

  run() {
    if (this.exitCode !== null) return Promise.resolve(this.exitCode);
    if (this.running) return this.running;
    this.running = new Promise(resolve => { this.resolveRun = resolve; });
    this.rl = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY) });
    this.rl.on('line', line => this.handleLine(line));
    this.rl.on('close', () => { void this.close(); });
    this.rl.on('SIGINT', () => { void this.close(); });
    this.output.write(`\nCodex app-server interactive session ${this.sessionId}. Type /exit to quit.\n`);
    this.rl.setPrompt('codex> ');
    this.rl.prompt();
    return this.running;
  }

  terminate(error, code) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.active?.reject(error);
    for (const job of this.queue.splice(0)) job.reject(error);
    this.permission = null;
    this.rl?.close();
    this.resolveRun?.(code);
    this.onClose?.();
    if (!this.childClosed) this.child?.kill('SIGTERM');
  }

  async close() {
    if (!this.child || this.childClosed) { this.terminate(failure('Codex client closed', Boolean(this.active)), 0); return; }
    const closed = new Promise(resolve => { this.resolveChildClosed = resolve; });
    this.terminate(failure('Codex client closed', Boolean(this.active)), 0);
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { this.child?.kill('SIGKILL'); resolve(); }, 3000); })]);
    clearTimeout(timer);
  }
}
