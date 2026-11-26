import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readServerSentEvents } from './channel.js';
import { PROJECT_ROOT } from './build-info.js';
import { runProcess } from './workspace-connector.js';

// Long-running helper processes started from inside an app's own session, so
// they inherit what only that app can give them: the Codex desktop's queue,
// Antigravity's language-server address and CSRF token.
//
// - codex member bridge: holds this seat's listener stream and turns each
//   doorbell into `codex queue --thread <seat> --message …`;
// - codex door: queues "open a new conversation with this first message" into
//   the resident door conversation, which opens it;
// - antigravity door: creates top-level conversations itself and wakes
//   Antigravity seats with `agentapi send-message`.
// Every one reports what happened to /local/v1/workspaces/result.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function bridgeDirectory(dataDir) {
  return path.join(dataDir, 'workspace-bridges');
}

async function takeLock(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(await readFile(file, 'utf8'));
    if (alive(previous.pid) && previous.pid !== process.pid) return { ok: false, pid: previous.pid };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const handle = await open(file, 'w', 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  await handle.close();
  return { ok: true, release: () => unlink(file).catch(() => {}) };
}

export async function lockHolder(file) {
  try {
    const previous = JSON.parse(await readFile(file, 'utf8'));
    return alive(previous.pid) ? previous.pid : null;
  } catch {
    return null;
  }
}

// Starts `agent-hub ws <internal> …` detached, logging to a file next to its lock.
export async function spawnDetached({ dataDir, name, args, env = process.env }) {
  const directory = bridgeDirectory(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, `${name}.lock`);
  const running = await lockHolder(lock);
  if (running) return { status: 'already_running', pid: running, log: path.join(directory, `${name}.log`) };
  const log = await open(path.join(directory, `${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'bin/agent-hub.js'), 'ws', ...args, '--data-dir', dataDir], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env,
  });
  child.unref();
  await log.close();
  return { status: 'started', pid: child.pid, log: path.join(directory, `${name}.log`) };
}

class StreamLoop {
  constructor({ connectorUrl, token, logger = console, retryMs = 2000, desktopPid = null }) {
    this.connectorUrl = connectorUrl.replace(/\/$/, '');
    this.token = token;
    this.logger = logger;
    this.retryMs = retryMs;
    this.desktopPid = desktopPid;
    this.stopped = false;
  }

  async post(pathname, body) {
    const response = await fetch(`${this.connectorUrl}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) this.logger.error?.(`${pathname} answered ${response.status}`);
  }

  result(body) {
    return this.post('/local/v1/workspaces/result', body).catch((error) => this.logger.error?.(`result not sent: ${error.message}`));
  }

  async run(pathname, onEvent) {
    if (this.desktopPid) {
      this.monitor = setInterval(() => { if (!alive(this.desktopPid)) this.stop('desktop app exited'); }, 2000);
      this.monitor.unref?.();
    }
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(`${this.connectorUrl}${pathname}`, { headers: { authorization: `Bearer ${this.token}` }, signal: this.abort.signal });
        if (!response.ok) throw new Error(`Connector refused the stream (${response.status})`);
        for await (const event of readServerSentEvents(response.body)) {
          if (this.stopped) break;
          await onEvent(event);
        }
      } catch (error) {
        if (this.stopped) break;
        this.logger.error?.(`stream: ${error.message}`);
      }
      if (this.stopped) break;
      await sleep(this.retryMs);
    }
  }

  stop(reason) {
    if (reason) this.logger.error?.(`stopping: ${reason}`);
    this.stopped = true;
    this.abort?.abort();
    clearInterval(this.monitor);
  }
}

// ---- Codex -------------------------------------------------------------------

export function codexQueued(stdout, threadId) {
  const line = String(stdout ?? '').trim();
  return line.startsWith('Queued message ') && line.endsWith(` for thread ${threadId}.`);
}

export async function codexQueue({ executable = 'codex', threadId, message, cwd, run = runProcess }) {
  const result = await run(executable, ['queue', '--thread', threadId, '--message', message], { cwd, timeout: 45000 });
  if (result.code === 0 && codexQueued(result.stdout, threadId)) return { ok: true };
  return { ok: false, detail: (result.stderr || result.stdout || `codex queue 退出码 ${result.code}`).trim().slice(0, 400) };
}

export async function runCodexMemberBridge({ connectorUrl, token, sessionId, cwd, desktopPid, executable = 'codex', lockFile, logger = console, run = runProcess }) {
  const lock = await takeLock(lockFile);
  if (!lock.ok) throw new Error(`这个对话的收信桥已经在运行（PID ${lock.pid}）`);
  const loop = new StreamLoop({ connectorUrl, token, logger, desktopPid });
  const stop = () => loop.stop('signal');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const query = new URLSearchParams({ runtime: 'codex', session_id: sessionId, mode: 'stream' });
  logger.error?.(`codex member bridge for ${sessionId} started`);
  try {
    await loop.run(`/local/v1/workspaces/listen?${query}`, async (event) => {
      if (event.type !== 'wake') return;
      const message = `Agent Hub 工作区来信（当前对话必须是 ${sessionId}，不是就停下）。\n\n${event.text}`;
      const queued = await codexQueue({ executable, threadId: sessionId, message, cwd, run });
      await loop.result({ kind: 'wake', wake_id: event.wake_id, member_id: event.member_id,
        status: queued.ok ? 'delivered' : 'failed', detail: queued.ok ? '已放进 Codex 对话的队列' : queued.detail });
    });
  } finally {
    await lock.release();
  }
}

export function codexDoorInstruction(event) {
  return [
    'Agent Hub 门房请求：工作区要一个新的 Codex 队员。',
    `请新开一个独立的 Codex 对话（出现在侧栏的新对话，不是子 agent，也不是当前这个对话），${event.cwd ? `工作目录 ${event.cwd}，` : ''}把下面分隔线之间的原文一字不改地作为新对话的第一句话发出去。`,
    '开好就行，不用等它，也不用回复这条消息。开不了的话，用 agent-hub ws door report 说明原因（见最后一行）。',
    '-----',
    event.prompt,
    '-----',
    `开不了时：agent-hub ws door report --member ${event.member_id} --status failed --error "<原因>"`,
  ].join('\n');
}

export async function runCodexDoor({ connectorUrl, token, sessionId, cwd, desktopPid, executable = 'codex', lockFile, logger = console, run = runProcess }) {
  const lock = await takeLock(lockFile);
  if (!lock.ok) throw new Error(`Codex 门房已经在运行（PID ${lock.pid}）`);
  const loop = new StreamLoop({ connectorUrl, token, logger, desktopPid });
  process.once('SIGTERM', () => loop.stop('signal'));
  process.once('SIGINT', () => loop.stop('signal'));
  const query = new URLSearchParams({ runtime: 'codex', session_id: sessionId, pid: String(process.pid), detail: JSON.stringify({ door_thread: sessionId }) });
  logger.error?.(`codex door on thread ${sessionId} started`);
  try {
    await loop.run(`/local/v1/workspaces/door?${query}`, async (event) => {
      if (event.type !== 'launch') return;
      const queued = await codexQueue({ executable, threadId: sessionId, message: codexDoorInstruction(event), cwd, run });
      await loop.result({ kind: 'launch', member_id: event.member_id, status: queued.ok ? 'queued' : 'failed',
        error: queued.ok ? undefined : `门房对话没收到请求：${queued.detail}`, detail: { door_thread: sessionId } });
    });
  } finally {
    await lock.release();
  }
}

// ---- Antigravity -------------------------------------------------------------

export async function findAgentapi(explicit) {
  const candidates = [explicit, process.env.AGENT_HUB_AGENTAPI, path.join(os.homedir(), '.gemini/antigravity/bin/agentapi')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return 'agentapi';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export async function antigravityCreate({ prompt, model, projectId, title, env = process.env, agentapi, run = runProcess, fetchImpl = fetch }) {
  const problems = [];
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = env.ANTIGRAVITY_CSRF_TOKEN;
  if (address && csrf) {
    const base = /^https?:\/\//.test(address) ? address : `http://${address}`;
    const body = { prompt: [{ text: prompt }] };
    if (projectId ?? env.ANTIGRAVITY_PROJECT_ID) body.projectId = projectId ?? env.ANTIGRAVITY_PROJECT_ID;
    if (model) body.model = model;
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, '')}/product.v1.ConversationService/CreateConversation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-antigravity-csrf-token': csrf },
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => ({}));
      if (response.ok && value?.conversation?.id) return { ok: true, conversation_id: value.conversation.id, via: 'CreateConversation' };
      problems.push(`CreateConversation HTTP ${response.status} ${JSON.stringify(value).slice(0, 200)}`);
    } catch (error) {
      problems.push(`CreateConversation ${error.message}`);
    }
  } else {
    problems.push('没有 ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN（门房要在反重力托管的进程里运行）');
  }
  const args = ['new-conversation', ...(model ? [`--model=${model}`] : []), ...(title ? [`--title=${title}`] : []), prompt];
  const result = await run(agentapi, args, { env, timeout: 60000 });
  const id = UUID.exec(`${result.stdout}`)?.[0];
  if (result.code === 0 && id) return { ok: true, conversation_id: id, via: 'agentapi' };
  if (result.code === 0) return { ok: true, conversation_id: null, via: 'agentapi' };
  problems.push(`agentapi new-conversation: ${(result.stderr || result.stdout || `退出码 ${result.code}`).trim().slice(0, 300)}`);
  return { ok: false, detail: problems.join('；') };
}

export async function antigravitySend({ conversationId, text, env = process.env, agentapi, run = runProcess }) {
  const result = await run(agentapi, ['send-message', '--title=Agent Hub', conversationId, text], { env, timeout: 60000 });
  if (result.code === 0 && !/"error"/.test(result.stdout)) return { ok: true };
  return { ok: false, detail: (result.stderr || result.stdout || `退出码 ${result.code}`).trim().slice(0, 400) };
}

export async function runAntigravityDoor({ connectorUrl, token, lockFile, agentapi, logger = console, run = runProcess, env = process.env }) {
  const lock = await takeLock(lockFile);
  if (!lock.ok) throw new Error(`反重力门房已经在运行（PID ${lock.pid}）`);
  const loop = new StreamLoop({ connectorUrl, token, logger });
  process.once('SIGTERM', () => loop.stop('signal'));
  process.once('SIGINT', () => loop.stop('signal'));
  const executable = await findAgentapi(agentapi);
  const query = new URLSearchParams({ runtime: 'antigravity', pid: String(process.pid),
    detail: JSON.stringify({ project_id: env.ANTIGRAVITY_PROJECT_ID ?? null, agentapi: executable }) });
  logger.error?.(`antigravity door started (agentapi ${executable})`);
  try {
    await loop.run(`/local/v1/workspaces/door?${query}`, async (event) => {
      if (event.type === 'launch') {
        const created = await antigravityCreate({ prompt: event.prompt, model: event.model, projectId: event.antigravity_project,
          title: `${event.workspace_name}/${event.seat}`, env, agentapi: executable, run });
        await loop.result({ kind: 'launch', member_id: event.member_id, status: created.ok ? 'launched' : 'failed',
          error: created.ok ? undefined : created.detail, detail: created.ok ? { conversation_id: created.conversation_id, via: created.via } : {} });
      } else if (event.type === 'wake') {
        const sent = await antigravitySend({ conversationId: event.conversation_id, text: event.text, env, agentapi: executable, run });
        await loop.result({ kind: 'wake', wake_id: event.wake_id, member_id: event.member_id,
          status: sent.ok ? 'delivered' : 'failed', detail: sent.ok ? '已用 agentapi 送进对话' : sent.detail });
      }
    });
  } finally {
    await lock.release();
  }
}
