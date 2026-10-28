import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KimiDriver } from './drivers/kimi.js';
import { KimiAcpDriver } from './drivers/kimi-acp.js';
import { KimiNativeChannelDriver } from './drivers/kimi-native-channel.js';
import { KimiChannel } from './kimi-channel.js';
import { PROJECT_ROOT } from './build-info.js';
import { CHANNEL_SERVER_NAME, CHANNEL_TOOLS } from './channel.js';

export const SESSION_RUNTIMES = ['claude', 'kimi', 'codex'];

// Writes the MCP config that lets Claude Code spawn the Agent Hub channel for this Session.
async function writeChannelConfig({ dataDir, sessionId, connectorUrl, nodePath = process.execPath }) {
  const directory = path.join(dataDir, 'channels');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${sessionId}.json`);
  const args = [path.join(PROJECT_ROOT, 'bin/agent-hub.js'), 'channel', '--data-dir', dataDir];
  if (connectorUrl) args.push('--connector-url', connectorUrl);
  const config = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        command: nodePath,
        args,
        env: { AGENT_HUB_RUNTIME: 'claude', AGENT_HUB_SESSION_ID: sessionId },
      },
    },
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

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
  const nativeTui = runtime === 'kimi' && options.push === true && options.nativeTui === true;
  if (options.nativeTui === true && !nativeTui) throw new Error('--native-tui requires --runtime kimi --push');
  let sessionId = null;
  let executable;
  let args;
  let driver = null;
  let channel = null;
  let socketPath = null;
  if ((options.push || options.resumeSessionId) && !['claude', 'kimi'].includes(runtime)) {
    const error = new Error('--push and --resume are only supported for claude or kimi');
    error.code = 'unsupported_session_option';
    throw error;
  }
  if (runtime === 'claude') {
    sessionId = options.resumeSessionId ?? randomUUID();
    executable = 'claude';
    args = [];
    if (options.push) {
      const configFile = await writeChannelConfig({
        dataDir: path.resolve(options.dataDir),
        sessionId,
        connectorUrl: options.connectorUrl,
        nodePath: options.nodePath,
      });
      // Each of these flags is variadic, so every one is closed by the next flag, never by RUNTIME_ARGS.
      args.push(
        '--allowedTools', CHANNEL_TOOLS.map((tool) => `mcp__${CHANNEL_SERVER_NAME}__${tool}`).join(','),
        '--mcp-config', configFile,
        '--dangerously-load-development-channels', `server:${CHANNEL_SERVER_NAME}`,
      );
    }
    args.push(options.resumeSessionId ? '--resume' : '--session-id', sessionId, ...runtimeArgs);
  } else if (runtime === 'kimi') {
    if (options.push && !options.kimiChannel && (!options.channel?.connectorUrl || !options.channel?.token)) {
      throw new Error('Kimi push requires Connector connection details');
    }
    if (options.push && !nativeTui && runtimeArgs.length) throw new Error('Kimi --push does not accept runtime arguments');
    driver = options.kimiDriver ?? new KimiDriver({ env });
    const prepared = await driver.prepareWorker({
      cwd,
      ...(options.resumeSessionId ? { runtime_session_id: options.resumeSessionId } : {}),
    });
    sessionId = prepared.runtime_session_id;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Kimi did not return a valid session id');
    if (nativeTui) {
      socketPath = options.nativeChannelPath ?? path.join(os.homedir(), '.agent-hub', 'channels', `${sessionId}.sock`);
      await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    }
    executable = nativeTui ? env.AGENT_HUB_KIMI_EXECUTABLE ?? 'kimi' : 'kimi';
    args = options.push
      ? nativeTui
        ? ['--session', sessionId, '--channel', socketPath, ...runtimeArgs]
        : ['acp']
      : ['--session', sessionId, ...runtimeArgs];
    if (options.push) {
      await driver.close();
      driver = nativeTui
        ? options.kimiNativeDriver ?? new KimiNativeChannelDriver({ socketPath, sessionId })
        : options.kimiAcpDriver ?? new KimiAcpDriver({
          sessionId,
          cwd,
          env: { ...env, AGENT_HUB_RUNTIME: 'kimi', AGENT_HUB_SESSION_ID: sessionId },
        });
      channel = options.kimiChannel ?? new KimiChannel({
        ...options.channel,
        sessionId,
        driver,
        cwd,
      });
      if (nativeTui) driver.onClosed = () => channel.stop();
    }
  } else {
    executable = 'codex';
    args = [...runtimeArgs];
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await channel?.stop?.();
    } finally {
      await driver?.close();
    }
  };
  if (runtime === 'kimi' && !options.push) await close();
  const launchEnv = { ...env, AGENT_HUB_RUNTIME: runtime };
  if (nativeTui) launchEnv.KIMI_CODE_EXPERIMENTAL_TUI_CHANNEL = '1';
  // Launched from inside another Claude Code session, the marker would turn off transcripts and break --resume.
  if (runtime === 'claude' && launchEnv.CLAUDE_CODE_CHILD_SESSION) launchEnv.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
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
    ...(channel ? { kimiChannel: channel } : {}),
    ...(nativeTui ? { nativeTui: true, socketPath } : {}),
  };
}

export async function startSession(options = {}) {
  const launch = await prepareSessionLaunch(options);
  const spawnProcess = options.spawn ?? spawn;
  try {
    if (launch.kimiChannel && !launch.nativeTui) {
      await launch.kimiChannel.start();
      await options.onReady?.(launch);
      const exitCode = await launch.kimiChannel.run();
      return { ...launch, exitCode, signal: null };
    }
    if (launch.kimiChannel) await launch.kimiChannel.start();
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
