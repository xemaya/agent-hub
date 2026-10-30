import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readServerSentEvents } from './channel.js';
import { PROJECT_ROOT } from './build-info.js';
import { mailPrompt } from './drivers/prompt.js';

const execute = promisify(execFile);
export async function checkNativeQueue(executable = 'codex') {
  const { stdout } = await execute(executable, ['queue', '--help'], { timeout: 10000 });
  if (!stdout.includes('--thread') || !stdout.includes('--message')) throw new Error('Installed Codex does not expose native queue delivery');
}
export const queueDirectory = (dataDir, sessionId) => path.join(dataDir, 'codex-queue', encodeURIComponent(sessionId));
export function commandRecord(dataDir, sessionId, commandId) {
  if (typeof commandId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(commandId)) throw new Error('Invalid command_id');
  return path.join(queueDirectory(dataDir, sessionId), `${commandId}.json`);
}
function alive(pid) { if (!Number.isInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

// Native identity is supplied by Codex; identify its actual desktop ancestor,
// without choosing a recent session or a random App instance.
export async function currentDesktopPid() {
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'ppid=,comm=']);
    const match = /^\s*(\d+)\s+(.+)$/s.exec(stdout.trim());
    if (!match) break;
    if (/\.app\/Contents\/MacOS\/(ChatGPT|Codex)$/.test(match[2].trim())) return pid;
    pid = Number(match[1]);
  }
  throw new Error('Current process is not running inside the Codex desktop App');
}

export class CodexQueueChannel {
  constructor({ connectorUrl, token, sessionId, dataDir, cwd = process.cwd(), executable = 'codex',
    queue = execute, desktopPid, onReady, logger = console, retryMs = 1000 }) {
    Object.assign(this, { connectorUrl: connectorUrl.replace(/\/$/, ''), token, sessionId, dataDir, cwd, executable, queue, desktopPid, onReady, logger, retryMs });
    this.stopped = false;
    this.state = 'connecting';
    this.seenMail = new Set();
  }
  async call(commandId, action, body = {}) {
    const response = await fetch(`${this.connectorUrl}/local/v1/channel/commands/${encodeURIComponent(commandId)}/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok && !(action === 'ack' && response.status === 404)) {
      throw Object.assign(new Error(`Connector ${action} failed (${response.status})`), { fatal: [400, 401, 403].includes(response.status) });
    }
    // A fast in-session report can finish before the queue subprocess returns.
  }
  prompt(event) {
    const report = [process.execPath, path.join(PROJECT_ROOT, 'bin/agent-hub.js'), 'desktop', 'report',
      '--data-dir', this.dataDir, '--command-id', event.command_id];
    const check = [...report]; check[3] = 'check';
    return `Agent Hub 指令，投递到当前既有 Codex 桌面会话。\n原生会话 ID 必须为 ${this.sessionId}；若不一致，停止，不代替其他会话执行。\ncommand_id: ${event.command_id}\n\n` +
      `开始工作前必须先用参数数组执行本地校验：\n${JSON.stringify(check)}\n仅当返回 allowed=true 才能执行下方工作；校验失败、已取消、结果不明时停止本条，不执行工作也不提交过期回执。check 和 report 是传输校验与回执，工作内容中的“不调用工具”不禁止这两项本地 CLI。每条 CLI 使用 Codex 原生单次提升权限。\n\n${event.content}\n\n` +
      `完成后必须在当前会话内提交一次回执，不能只在桌面文字回答。用参数数组调用以下本地 CLI：\n${JSON.stringify(report)}\n追加 --status succeeded 或 --status failed，完整结果通过 stdin 传入；本机令牌由 CLI 自动读取，不读取或打印 Admin Token。\n` +
      '提交回执时，仅对这条本地 CLI 使用 Codex 工具自带的单次提升权限机制，不要 sudo，不要修改全局沙箱。若回执返回 fetch failed 或结果不明，不重复执行，先核对 Hub 的真实命令状态。\n' +
      '只完成本条指令，沿用当前会话权限和人类约束。回执超时或失败时如实说明，不重投原任务、不改发其他会话。';
  }
  async deliver(event) {
    const file = commandRecord(this.dataDir, this.sessionId, event.command_id);
    const record = await open(file, 'wx', 0o600); // A delivery is never queued twice.
    await record.writeFile(JSON.stringify({ command_id: event.command_id, session_id: this.sessionId, connector_url: this.connectorUrl }));
    await record.close();
    const pending = this.queue(this.executable, ['queue', '--thread', this.sessionId, '--message', this.prompt(event)],
      { cwd: this.cwd, timeout: 45000, maxBuffer: 256 * 1024 });
    this.queueChild = pending.child;
    let result;
    try { result = await pending; }
    catch (error) { throw new Error(`Native Codex queue acceptance is unknown (${error.killed ? 'timeout' : error.code ?? 'error'}); do not replay`); }
    this.queueChild = null;
    if (!result.stdout?.trim().startsWith('Queued message ') || !result.stdout.trim().endsWith(` for thread ${this.sessionId}.`)) {
      throw new Error('Native queue acceptance was not confirmed; outcome is unknown');
    }
    if (!this.stopped) {
      try { await this.call(event.command_id, 'ack'); }
      catch (error) { error.transportOnly = true; throw error; }
    }
  }

  async deliverMail(message) {
    if (this.seenMail.has(message.message_id)) return;
    this.seenMail.add(message.message_id);
    let status = 'accepted';
    let failure = null;
    try {
      const text = `Agent Hub 邮件，当前原生会话必须为 ${this.sessionId}，身份不符则停止。\n\n${mailPrompt(message)}`;
      const { stdout } = await this.queue(this.executable, ['queue', '--thread', this.sessionId, '--message', text],
        { cwd: this.cwd, timeout: 45000, maxBuffer: 256 * 1024 });
      if (!stdout?.trim().startsWith('Queued message ') || !stdout.trim().endsWith(` for thread ${this.sessionId}.`)) {
        throw new Error('Native mail notification acceptance is unknown');
      }
    } catch (error) {
      status = 'unknown'; failure = error.killed ? 'native_queue_timeout' : String(error.code ?? 'native_notification_unknown');
      this.logger.error?.(`Mail remains in inbox: ${failure}`);
    }
    try {
      const response = await fetch(`${this.connectorUrl}/local/v1/mail/${encodeURIComponent(message.message_id)}/notice`, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'codex', runtime_session_id: this.sessionId, status, error: failure }),
      });
      if (!response.ok) this.logger.error?.(`Mail notification receipt was not confirmed (${response.status}); inbox is durable, do not replay`);
    } catch (error) { this.logger.error?.(`Mail notification receipt unknown: ${error.message}; do not replay`); }
  }
  async start() {
    await mkdir(queueDirectory(this.dataDir, this.sessionId), { recursive: true, mode: 0o700 });
    if (this.desktopPid) {
      this.monitor = setInterval(() => { if (!alive(this.desktopPid)) this.stop(); }, 1000);
      this.monitor.unref();
    }
    const query = new URLSearchParams({ runtime: 'codex', session_id: this.sessionId, features: 'mailbox_v1' });
    try {
      while (!this.stopped) {
        this.abort = new AbortController();
        let deliveryFailed = false;
        try {
          const response = await fetch(`${this.connectorUrl}/local/v1/channel?${query}`, {
            headers: { authorization: `Bearer ${this.token}` }, signal: this.abort.signal,
          });
          if (!response.ok) {
            const error = new Error(`Connector refused desktop queue channel (${response.status})`);
            error.fatal = [400, 401, 403].includes(response.status);
            throw error;
          }
          for await (const event of readServerSentEvents(response.body)) {
            if (this.stopped) break;
            if (event.type === 'attached') { this.state = 'attached'; this.onReady?.(event); }
            if (event.type === 'rejected') throw Object.assign(new Error(event.reason ?? 'Desktop Worker rejected'), { fatal: true });
            if (event.type === 'command') {
              try { await this.deliver(event); }
              catch (error) { deliveryFailed = !error.transportOnly; throw error; }
            }
            if (event.type === 'mail') await this.deliverMail(event.message);
          }
        } catch (error) {
          if (this.stopped) break;
          // Reconnect the transport only. A queue call or receipt with an
          // uncertain outcome must never become an automatic command replay.
          if (deliveryFailed || error.fatal) throw error;
        } finally { this.abort.abort(); }
        if (this.stopped) break;
        this.state = 'connecting';
        this.logger.error?.('Desktop queue channel disconnected; reconnecting to Connector without replaying commands');
        await new Promise(resolve => {
          this.finishRetry = () => { clearTimeout(this.retryTimer); this.finishRetry = null; resolve(); };
          this.retryTimer = setTimeout(this.finishRetry, this.retryMs);
        });
      }
    } catch (error) {
      if (!this.stopped) throw error;
    } finally { this.stop(); }
  }
  stop() { this.stopped = true; this.abort?.abort(); clearInterval(this.monitor); this.finishRetry?.(); this.queueChild?.kill('SIGTERM'); }
}

export async function startQueueBridge({ dataDir, sessionId, connectorUrl, cwd, desktopPid, executable = 'codex' }) {
  const directory = queueDirectory(dataDir, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(await readFile(path.join(directory, 'bridge.lock'), 'utf8'));
    if (alive(previous.pid)) return { status: 'already_running', session_id: sessionId, pid: previous.pid };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const log = await open(path.join(directory, 'bridge.log'), 'a', 0o600);
  const args = [path.join(PROJECT_ROOT, 'bin/agent-hub.js'), 'desktop', 'bridge', '--data-dir', dataDir,
    '--session-id', sessionId, '--cwd', cwd, '--desktop-pid', String(desktopPid), '--executable', executable];
  if (connectorUrl) args.push('--connector-url', connectorUrl);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
  await log.close();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) { child.kill('SIGTERM'); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Desktop queue bridge did not attach')), 15000);
    child.once('error', error => finish(error));
    child.once('exit', () => finish(new Error('Desktop queue bridge exited before attaching')));
    child.on('message', value => value?.type === 'ready' ? finish(null, value) : value?.type === 'failed' && finish(new Error(value.message)));
  });
}

export async function bridgeLock(dataDir, sessionId) {
  const file = path.join(queueDirectory(dataDir, sessionId), 'bridge.lock');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(file, 'utf8'));
    if (alive(previous.pid)) throw new Error(`Desktop queue bridge already runs as PID ${previous.pid}`);
    await unlink(file); handle = await open(file, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
  return () => unlink(file);
}
