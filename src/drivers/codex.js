import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { commandPrompt } from './prompt.js';

const SANDBOXES = new Set(['read-only', 'workspace-write']);

function executionError(message) {
  const error = new Error(message);
  error.code = 'codex_execution_failed';
  return error;
}

function eventError(event) {
  const value = event?.error ?? event?.message;
  if (typeof value === 'string') return value;
  if (typeof value?.message === 'string') return value.message;
  return 'Codex reported an execution error';
}

export class CodexDriver {
  constructor(options = {}) {
    this.executable = options.executable ?? 'codex';
    this.spawn = options.spawn ?? spawn;
    this.env = options.env ?? process.env;
    this.model = options.model ?? this.env.AGENT_HUB_CODEX_MODEL ?? null;
    this.children = new Map();
  }

  async prepareWorker(input) {
    const sessionId = input.runtime_session_id;
    return {
      runtime_session_id: sessionId ?? randomUUID(),
      driver_state: sessionId
        ? { started: true, session_id: sessionId }
        : { started: false, session_id: null },
    };
  }

  async execute({ worker, command, onOutput, onState }) {
    const started = Boolean(worker.driver_state?.started);
    const savedSessionId = worker.driver_state?.session_id;
    if (started && !savedSessionId) throw new Error('Codex native thread id is missing');
    const sandbox = worker.metadata?.codex_sandbox ?? 'read-only';
    if (!SANDBOXES.has(sandbox)) {
      const error = new Error('Codex sandbox must be read-only or workspace-write');
      error.code = 'codex_invalid_sandbox';
      throw error;
    }
    const model = worker.metadata?.codex_model ?? this.model;
    const args = [
      'exec',
      ...(started ? ['resume'] : []),
      '--json',
      '--skip-git-repo-check',
      '-c', `sandbox_mode=${JSON.stringify(sandbox)}`,
      ...(model ? ['--model', model] : []),
      ...(!started ? ['--cd', worker.cwd] : []),
      ...(started ? [savedSessionId] : []),
      '--',
      commandPrompt(command),
    ];
    const child = this.spawn(this.executable, args, {
      cwd: worker.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let resultText = '';
    let observedSessionId = null;
    let failure = null;
    let settled = false;
    let resolveClose;
    let rejectClose;
    const closed = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    closed.catch(() => {});
    this.children.set(child, closed);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      rejectClose(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolveClose({ code, signal });
    });
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-32768);
      });
    }

    try {
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            onOutput(`${line}\n`);
            continue;
          }
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            if (started && event.thread_id !== savedSessionId) {
              failure = executionError('Codex resumed a different thread');
              continue;
            }
            observedSessionId = event.thread_id;
            await onState({ started: true, session_id: observedSessionId });
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            const text = event.item.text;
            if (typeof text === 'string' && text) {
              resultText = text;
              onOutput(`${text}\n`);
            }
          }
          if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
            onOutput('[tool] command_execution\n');
          }
          if (event.type === 'turn.failed' || event.type === 'error') {
            failure = executionError(eventError(event));
          }
        }
      }
      const { code, signal } = await closed;
      if (code !== 0 || signal || failure) {
        throw executionError(
          failure?.message
          || stderr.trim()
          || `Codex exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`,
        );
      }
      if (!started && !observedSessionId) {
        throw executionError('Codex did not return a native thread id');
      }
      return {
        text: resultText,
        session_id: observedSessionId ?? savedSessionId,
      };
    } finally {
      this.children.delete(child);
    }
  }

  async close() {
    const children = [...this.children.keys()];
    for (const child of children) child.kill('SIGINT');
    const timer = setTimeout(() => {
      for (const child of children) child.kill('SIGTERM');
    }, 3000);
    timer.unref();
    try {
      await Promise.allSettled(children.map((child) => this.children.get(child)));
    } finally {
      clearTimeout(timer);
    }
  }
}
