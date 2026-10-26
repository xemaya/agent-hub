import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { commandPrompt } from './prompt.js';

function textFromMessage(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

function toolNames(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === 'tool_use').map((part) => part.name).filter(Boolean);
}

export class ClaudeDriver {
  constructor(options = {}) {
    this.executable = options.executable ?? 'claude';
    this.spawn = options.spawn ?? spawn;
    this.env = options.env ?? process.env;
    this.children = new Map();
  }

  async prepareWorker(input) {
    return {
      runtime_session_id: input.runtime_session_id ?? randomUUID(),
      driver_state: { started: Boolean(input.runtime_session_id) },
    };
  }

  async execute({ worker, command, onOutput, onState }) {
    const sessionId = worker.runtime_session_id;
    const started = Boolean(worker.driver_state?.started);
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-prompts', 'none',
      ...(started ? ['--resume', sessionId] : ['--session-id', sessionId]),
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
    let resultEvent = null;
    let observedSessionId = null;
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
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            observedSessionId = event.session_id;
            await onState({ started: true, session_id: observedSessionId });
          }
          if (event.type === 'assistant') {
            const text = textFromMessage(event);
            if (text) {
              resultText = text;
              onOutput(`${text}\n`);
            }
            for (const name of toolNames(event)) onOutput(`[tool] ${name}\n`);
          }
          if (event.type === 'result') {
            resultEvent = event;
            if (typeof event.result === 'string' && event.result) resultText = event.result;
          }
        }
      }
      const { code, signal } = await closed;
      if (observedSessionId) await onState({ started: true, session_id: observedSessionId });
      if (code !== 0 || signal || resultEvent?.is_error) {
        const error = new Error(
          resultEvent?.result
          || stderr.trim()
          || `Claude exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`,
        );
        error.code = 'claude_execution_failed';
        throw error;
      }
      return {
        text: resultText,
        session_id: observedSessionId ?? sessionId,
        subtype: resultEvent?.subtype ?? null,
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
