import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './build-info.js';
import { CodexDesktopDriver } from './drivers/codex-desktop.js';
import { loopbackServerUrl } from './codex-shared-server.js';
import { InteractiveChannel } from './interactive-channel.js';

export const DEFAULT_DESKTOP_SERVER_URL = 'ws://127.0.0.1:45123/';

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function desktopServerOptions({ dataDir, url, env = process.env }) {
  let stored = {};
  try { stored = JSON.parse(await readFile(path.join(dataDir, 'desktop', 'server.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...stored, url: loopbackServerUrl(url ?? env.CODEX_APP_SERVER_WS_URL ?? stored.url ?? DEFAULT_DESKTOP_SERVER_URL) };
}

// Starts a backend only. Never quits/restarts the desktop or opens a console UI.
export async function startDesktopServer({ dataDir, url, executable = process.env.CODEX_APP_RUNTIME_CLI_PATH || 'codex', env = process.env }) {
  const options = await desktopServerOptions({ dataDir, url, env });
  if (options.pid && alive(options.pid)) throw new Error(`A desktop backend is already recorded (PID ${options.pid}); inspect it instead of starting a second server`);
  const readyUrl = new URL('/readyz', options.url.replace('ws:', 'http:'));
  // An unrecorded listener must not be mistaken for our backend.
  if (await fetch(readyUrl, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)) throw new Error('The desktop backend port is already occupied; choose another loopback port');
  const directory = path.join(dataDir, 'desktop');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logFile = path.join(directory, 'server.log');
  const log = await open(logFile, 'a', 0o600);
  const serverEnv = { ...env, CODEX_APP_SERVER_WS_URL: options.url };
  delete serverEnv.CODEX_SESSION_ID;
  delete serverEnv.AGENT_HUB_SESSION_ID;
  delete serverEnv.AGENT_HUB_RUNTIME;
  const child = spawn(executable, ['app-server', '--listen', options.url.replace(/\/$/, '')], {
    env: serverEnv, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  let failure = null;
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure ??= new Error(`Desktop backend exited (${code}); inspect ${logFile}`); });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const ready = await fetch(readyUrl, { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false);
      if (ready) {
        if (failure) throw failure;
        const result = { url: options.url, pid: child.pid, executable, log_file: logFile };
        await writeFile(path.join(directory, 'server.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
        child.unref();
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Desktop backend did not become ready; inspect ${logFile}`);
  } catch (error) { child.kill('SIGTERM'); child.unref(); throw error; }
}

export async function runDesktopBridge({ dataDir, url, sessionId, connectorUrl, token, cwd, desktopPid, onReady, logger = console }) {
  const driver = new CodexDesktopDriver({ sessionId, url });
  const directory = path.join(dataDir, 'desktop');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, `${encodeURIComponent(sessionId)}.json`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(lockPath, 'utf8'));
    if (alive(previous.pid)) throw new Error(`This desktop thread already has a bridge (PID ${previous.pid})`);
    await unlink(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, desktop_pid: desktopPid, session_id: sessionId, url })}\n`);
  await lock.close();
  const channel = new InteractiveChannel({ runtime: 'codex', connectorUrl, token, sessionId, driver, cwd, logger,
    onState: event => { if (event.type === 'attached') onReady?.({ session_id: sessionId, worker_id: event.worker_id, pid: process.pid, server_url: url }); },
  });
  const close = () => { channel.stop(); driver.close(); };
  const monitor = setInterval(() => { if (!alive(desktopPid)) close(); }, 1000);
  monitor.unref();
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await channel.start();
    return await channel.run();
  } finally {
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
    clearInterval(monitor);
    close();
    await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function startDesktopBridge({ dataDir, url, sessionId, connectorUrl, cwd, desktopPid }) {
  if (!alive(desktopPid)) throw new Error('A live verified --desktop-pid is required for desktop bridge lifecycle tracking');
  const directory = path.join(dataDir, 'desktop');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(path.join(directory, `${encodeURIComponent(sessionId)}.log`), 'a', 0o600);
  const args = [path.join(PROJECT_ROOT, 'bin/agent-hub.js'), 'desktop', 'bridge', '--data-dir', dataDir,
    '--session-id', sessionId, '--app-server-url', url, '--cwd', cwd, '--desktop-pid', String(desktopPid)];
  if (connectorUrl) args.push('--connector-url', connectorUrl);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
  await log.close();
  return new Promise((resolve, reject) => {
    let finished = false;
    const complete = (error, ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener('error', failed);
      child.removeListener('exit', exited);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) { child.kill('SIGTERM'); reject(error); } else resolve(ready);
    };
    const failed = error => complete(error);
    const exited = () => complete(new Error('Desktop bridge exited before attaching; inspect its desktop log'));
    const timer = setTimeout(() => complete(new Error('Desktop bridge did not attach within 20 seconds')), 20000);
    child.once('error', failed);
    child.once('exit', exited);
    child.on('message', message => {
      if (message?.type === 'ready') complete(null, message);
      if (message?.type === 'failed') complete(new Error(message.message));
    });
  });
}
