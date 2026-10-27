import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { KimiDriver } from './drivers/kimi.js';

export const SESSION_RUNTIMES = ['claude', 'kimi', 'codex'];

export async function prepareSessionLaunch(options = {}) {
  const runtime = options.runtime;
  if (!SESSION_RUNTIMES.includes(runtime)) {
    const error = new Error('runtime must be claude, kimi or codex');
    error.code = 'unsupported_session_runtime';
    throw error;
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runtimeArgs = [...(options.runtimeArgs ?? [])];
  const env = options.env ?? process.env;
  let sessionId = null;
  let executable;
  let args;
  let driver = null;
  if (runtime === 'claude') {
    sessionId = randomUUID();
    executable = 'claude';
    args = ['--session-id', sessionId, ...runtimeArgs];
  } else if (runtime === 'kimi') {
    driver = options.kimiDriver ?? new KimiDriver({ env });
    const prepared = await driver.prepareWorker({ cwd });
    sessionId = prepared.runtime_session_id;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Kimi did not return a valid session id');
    executable = 'kimi';
    args = ['--session', sessionId, ...runtimeArgs];
  } else {
    executable = 'codex';
    args = [...runtimeArgs];
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await driver?.close();
  };
  if (runtime === 'kimi') await close();
  const launchEnv = { ...env, AGENT_HUB_RUNTIME: runtime };
  if (sessionId) launchEnv.AGENT_HUB_SESSION_ID = sessionId;
  else delete launchEnv.AGENT_HUB_SESSION_ID;
  return {
    runtime,
    sessionId,
    executable,
    args,
    cwd,
    env: launchEnv,
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
