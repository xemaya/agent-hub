import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { KimiDriver } from './drivers/kimi.js';

export async function prepareSessionLaunch(options = {}) {
  const runtime = options.runtime;
  if (!['claude', 'kimi'].includes(runtime)) {
    const error = new Error('runtime must be claude or kimi');
    error.code = 'unsupported_session_runtime';
    throw error;
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runtimeArgs = [...(options.runtimeArgs ?? [])];
  let sessionId;
  let executable;
  let args;
  let driver = null;
  if (runtime === 'claude') {
    sessionId = randomUUID();
    executable = 'claude';
    args = ['--session-id', sessionId, ...runtimeArgs];
  } else {
    driver = options.kimiDriver ?? new KimiDriver({ env: options.env ?? process.env });
    const prepared = await driver.prepareWorker({ cwd });
    sessionId = prepared.runtime_session_id;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Kimi did not return a valid session id');
    executable = 'kimi';
    args = ['--session', sessionId, ...runtimeArgs];
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await driver?.close();
  };
  if (runtime === 'kimi') await close();
  return {
    runtime,
    sessionId,
    executable,
    args,
    cwd,
    env: {
      ...(options.env ?? process.env),
      AGENT_HUB_RUNTIME: runtime,
      AGENT_HUB_SESSION_ID: sessionId,
    },
    close,
  };
}

export async function startSession(options = {}) {
  const launch = await prepareSessionLaunch(options);
  const spawnProcess = options.spawn ?? spawn;
  try {
    const child = spawnProcess(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: 'inherit',
    });
    await options.onReady?.(launch);
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => {
        resolve({ code: exitCode, signal: exitSignal });
      });
    });
    return { ...launch, exitCode: code ?? 1, signal };
  } finally {
    await launch.close();
  }
}
