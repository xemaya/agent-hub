import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function acpError(message, code = 'kimi_acp_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class KimiAcpDriver {
  constructor({
    sessionId,
    cwd = process.cwd(),
    env = process.env,
    executable = 'kimi',
    spawn: spawnProcess = spawn,
    input = process.stdin,
    output = process.stdout,
    logger = {},
    onMessage = null,
  }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.env = env;
    this.executable = executable;
    this.spawn = spawnProcess;
    this.input = input;
    this.output = output;
    this.logger = logger;
    this.onMessage = onMessage;
    this.child = null;
    this.childClosed = false;
    this.pending = new Map();
    this.queue = [];
    this.activeJob = null;
    this.permission = null;
    this.nextId = 1;
    this.starting = null;
    this.started = false;
    this.closing = false;
    this.rl = null;
    this.runState = null;
    this.stderr = '';
  }

  async start() {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
      this.started = true;
    } finally {
      this.starting = null;
    }
  }

  async startProcess() {
    const child = this.spawn(this.executable, ['acp'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32768);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('close', (code, signal) => {
      this.childClosed = true;
      const reason = this.closing
        ? 'Kimi ACP client closed'
        : `Kimi ACP exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`;
      this.failAll(acpError(reason));
      this.finish(this.closing ? 0 : (code ?? 1));
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.logger.error?.(`Kimi ACP message failed: ${error.message}`);
      }
    });
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 15000);
    await this.request('session/load', {
      sessionId: this.sessionId,
      cwd: this.cwd,
      mcpServers: [],
    }, 15000);
  }

  write(message) {
    if (!this.child || this.childClosed) throw acpError('Kimi ACP process is not running');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(acpError(`Kimi ACP request timed out: ${method}`));
      }, timeoutMs) : null;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  handleMessage(message) {
    this.onMessage?.(message);
    if (message.method && message.id !== undefined && message.id !== null) {
      if (message.method === 'session/request_permission') this.handlePermissionRequest(message);
      else this.respondError(message.id, -32601, `Method not found: ${message.method}`);
      return;
    }
    if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = acpError(message.error.message ?? 'Kimi ACP request failed', message.error.code ?? 'kimi_acp_failed');
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') this.handleUpdate(message.params ?? {});
  }

  handlePermissionRequest(message) {
    const options = message.params?.options ?? [];
    if (!this.rl || !options.length) {
      this.respondError(message.id, -32000, 'Permission requires the interactive ACP window');
      return;
    }
    this.permission = { id: message.id, options };
    const tool = message.params?.toolCall?.title ?? message.params?.toolCall?.toolName ?? 'tool call';
    this.output.write(`\nPermission required: ${tool}\n`);
    options.forEach((option, index) => {
      this.output.write(`  ${index + 1}. ${option.name ?? option.optionId}\n`);
    });
    this.promptUser('Select an option: ');
  }

  handleUpdate(params) {
    if (params.sessionId && params.sessionId !== this.sessionId) return;
    const update = params.update;
    if (!update) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.text ?? '';
      if (!text) return;
      if (this.activeJob) {
        this.activeJob.text += text;
        this.activeJob.onOutput?.(text);
      }
      this.output.write(text);
      return;
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = update.content?.text ?? '';
      if (text) this.output.write(`\n${text}\n`);
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      const name = update.title ?? update.toolName ?? update.kind ?? 'tool';
      this.output.write(`\n[tool] ${name}\n`);
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

  async execute({ command, onOutput, onState }) {
    return this.enqueue({ command, onOutput, onState });
  }

  async prompt(text) {
    return this.enqueue({ command: { input: text } });
  }

  showInbound(text) {
    this.output.write(`\n[Agent Hub] ${text}\n`);
  }

  async pump() {
    if (this.activeJob || this.closing) return;
    const job = this.queue.shift();
    if (!job) return;
    this.activeJob = job;
    try {
      await job.onState?.({ started: true, prompt_id: job.command.command_id });
      const response = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: job.command.input }],
      });
      const stopReason = response?.stopReason ?? response?.stop_reason ?? 'end_turn';
      if (['cancelled', 'canceled', 'refusal'].includes(stopReason)) throw acpError(`Kimi prompt ended with ${stopReason}`);
      job.resolve({
        text: job.text,
        session_id: this.sessionId,
        ...(job.command.command_id ? { prompt_id: job.command.command_id } : {}),
        output_gap: ['max_tokens', 'max_turn_requests'].includes(stopReason),
      });
    } catch (error) {
      job.reject(error);
    } finally {
      this.output.write('\n');
      this.activeJob = null;
      if (!this.closing && this.queue.length) this.pump();
    }
  }

  promptUser(prefix = 'kimi> ') {
    if (!this.rl) return;
    this.rl.setPrompt(prefix);
    this.rl.prompt();
  }

  handleUserLine(line) {
    if (this.permission) {
      const input = line.trim();
      const index = Number(input);
      const option = Number.isInteger(index) && index >= 1 && index <= this.permission.options.length
        ? this.permission.options[index - 1]
        : this.permission.options.find((item) => item.optionId === input);
      if (!option) {
        this.output.write('Choose an option number.\n');
        this.promptUser('Select an option: ');
        return;
      }
      const { id } = this.permission;
      this.permission = null;
      this.respond(id, { outcome: { outcome: 'selected', optionId: option.optionId } });
      this.promptUser();
      return;
    }
    const text = line.trim();
    if (!text) {
      this.promptUser();
      return;
    }
    if (['/exit', '/quit'].includes(text)) {
      this.close();
      return;
    }
    this.output.write('\n');
    this.prompt(text)
      .catch((error) => this.output.write(`\n${error.message}\n`))
      .finally(() => this.promptUser());
  }

  async run() {
    if (this.runState) return this.runState.promise;
    let resolveRun;
    this.runState = { promise: new Promise((resolve) => { resolveRun = resolve; }), resolve: resolveRun };
    this.rl = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY) });
    this.rl.on('line', (line) => this.handleUserLine(line));
    this.rl.on('close', () => this.close());
    this.output.write('\nKimi ACP interactive session. Type /exit to quit.\n');
    this.promptUser();
    return this.runState.promise;
  }

  finish(code) {
    this.runState?.resolve(code);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.activeJob?.reject(error);
    for (const job of this.queue) job.reject(error);
    this.queue = [];
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.failAll(acpError('Kimi ACP client closed'));
    this.permission = null;
    this.rl?.close();
    this.finish(0);
    const child = this.child;
    if (child && !this.childClosed) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await Promise.race([closed, sleep(3000)]);
    }
  }
}
