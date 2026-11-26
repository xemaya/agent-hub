import { execFile } from 'node:child_process';
import { mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonBody, sendJson } from './json.js';
import { PROJECT_ROOT } from './build-info.js';

// The Connector side of workspaces. Three things live here:
// - a local API that forwards workspace calls from agent sessions to the Hub;
// - listeners: a session (or its bridge) holds a stream and gets its doorbell
//   there. `agent-hub ws wait` is a one-shot listener a Claude session runs in
//   the background; a Codex member's bridge holds a persistent one;
// - doors: what opens new seats on this machine. The Claude door is built in
//   (claude --bg); Codex and Antigravity doors are bridge processes that attach
//   to /local/v1/workspaces/door from inside their app.

export const DOOR_CONFIG_FILE = 'workspace-doors.json';
const STRIP_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AGENT_HUB_RUNTIME|AGENT_HUB_SESSION_ID|AGENT_HUB_WS_|CODEX_SESSION_ID|CODEX_THREAD|ANTIGRAVITY_)/;

function localError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function clip(value, max = 600) {
  const flat = String(value ?? '').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// A child the door starts must not look like it runs inside this process's session.
export function cleanChildEnv(env = process.env, extra = {}) {
  const result = {};
  for (const [key, value] of Object.entries(env)) if (!STRIP_ENV.test(key)) result[key] = value;
  return { ...result, ...extra };
}

export function runProcess(executable, args, { cwd, env, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(executable, args, { cwd, env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, error: error ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export async function loadDoorConfig(dataDir) {
  try {
    const value = JSON.parse(await readFile(path.join(dataDir, DOOR_CONFIG_FILE), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveDoorConfig(dataDir, config) {
  await writeFile(path.join(dataDir, DOOR_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return true; // unknown owner: trust the stream
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' };

export class WorkspaceConnector {
  constructor(connector, { run = runProcess, keepaliveMs = 15000 } = {}) {
    this.connector = connector;
    this.run = run;
    this.keepaliveMs = keepaliveMs;
    this.listeners = new Map();
    this.doorStreams = new Map();
    this.closed = false;
  }

  get dataDir() {
    return this.connector.store.dataDir;
  }

  async request(type, payload, timeoutMs = 20000) {
    await this.connector.whenReady();
    return this.connector.request(type, payload, timeoutMs);
  }

  hubSupports() {
    return this.connector.ready;
  }

  // ---- doors -----------------------------------------------------------------

  async doors() {
    const list = [];
    const config = await loadDoorConfig(this.dataDir).catch(() => ({}));
    if (config.claude?.enabled) {
      list.push({ runtime: 'claude', kind: 'connector', detail: { default_cwd: config.claude.default_cwd ?? null, args: config.claude.args ?? [] } });
    }
    for (const [runtime, door] of this.doorStreams) list.push({ runtime, kind: 'bridge', detail: door.detail });
    return list;
  }

  async announceDoors() {
    if (!this.connector.ready || this.closed) return null;
    try {
      return await this.connector.request('workspace.doors', { doors: await this.doors() });
    } catch (error) {
      this.connector.logger.error?.(`Workspace doors not recorded: ${error.message}`);
      return null;
    }
  }

  async onReady() {
    await this.announceDoors();
    for (const [key, entries] of this.listeners) {
      if (!entries.size) continue;
      const [runtime, ...rest] = key.split(':');
      this.notifyListener(runtime, rest.join(':'), true);
    }
  }

  // ---- hub messages ----------------------------------------------------------

  async handleHubMessage(message) {
    if (message.type === 'workspace.launch') return this.launch(message.payload ?? {});
    if (message.type === 'workspace.wake') return this.wake(message.payload ?? {});
    return null;
  }

  async report(type, payload) {
    try {
      await this.connector.request(type, payload);
    } catch (error) {
      this.connector.logger.error?.(`Workspace ${type} not recorded: ${error.message}`);
    }
  }

  async launch(payload) {
    const base = { member_id: payload.member_id };
    try {
      if (payload.runtime === 'claude') {
        const config = (await loadDoorConfig(this.dataDir)).claude;
        if (!config?.enabled) {
          await this.report('workspace.launch.result', { ...base, status: 'failed', error: '这台机器没开 Claude 门房（agent-hub ws door enable claude）' });
          return;
        }
        await this.report('workspace.launch.result', { ...base, ...(await this.launchClaude(payload, config)) });
        return;
      }
      const door = this.doorStreams.get(payload.runtime);
      if (!door) {
        await this.report('workspace.launch.result', { ...base, status: 'failed', error: `这台机器上的 ${payload.runtime} 门房不在线` });
        return;
      }
      // The bridge opens the seat and posts its own result to /local/v1/workspaces/door/result.
      this.write(door.response, { type: 'launch', ...payload });
    } catch (error) {
      await this.report('workspace.launch.result', { ...base, status: 'failed', error: clip(error.message) });
    }
  }

  // A seat runs the same agent-hub as the Connector that opened it, and talks to that Connector.
  async seatEnv(extra = {}) {
    const bin = path.join(this.dataDir, 'workspace-bin');
    const link = path.join(bin, 'agent-hub');
    const target = path.join(PROJECT_ROOT, 'bin', 'agent-hub.js');
    try {
      await mkdir(bin, { recursive: true, mode: 0o700 });
      const current = await readlink(link).catch(() => null);
      if (current !== target) {
        if (current !== null) await unlink(link);
        await symlink(target, link);
      }
    } catch (error) {
      this.connector.logger.error?.(`agent-hub shim for seats not written: ${error.message}`);
    }
    return cleanChildEnv(process.env, {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      AGENT_HUB_CONNECTOR_URL: this.connector.localUrl,
      AGENT_HUB_CONNECTOR_DATA_DIR: this.dataDir,
      ...extra,
    });
  }

  claudeArgs(config) {
    return Array.isArray(config.args) ? config.args.filter((item) => typeof item === 'string') : ['--dangerously-skip-permissions'];
  }

  async launchClaude(payload, config) {
    const cwd = payload.cwd || config.default_cwd || os.homedir();
    const executable = config.executable || 'claude';
    const args = ['--bg', '--name', payload.name, ...this.claudeArgs(config), ...(payload.model ? ['--model', payload.model] : []), payload.prompt];
    const result = await this.run(executable, args, { cwd, env: await this.seatEnv({ AGENT_HUB_WORKSPACE: payload.workspace_name ?? '' }) });
    const output = `${result.stdout}\n${result.stderr}`;
    const started = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(output);
    if (started) return { status: 'launched', detail: { short_id: started[1], cwd, executable, name: payload.name } };
    if (/not trusted/i.test(output)) {
      return { status: 'failed', error: `这台机器上的目录 ${cwd} 还没确认过信任：请到这台机器上进这个目录运行一次 claude 并接受信任，然后让队长 agent-hub ws relaunch ${payload.seat}`, detail: { cwd } };
    }
    if (result.error?.code === 'ENOENT') return { status: 'failed', error: `找不到 claude 命令（${executable}）；重新运行 agent-hub ws door enable claude`, detail: { cwd } };
    return { status: 'failed', error: clip(output) || `claude 退出码 ${result.code}`, detail: { cwd } };
  }

  async claudeSessions(executable) {
    const result = await this.run(executable, ['agents', '--json'], { env: cleanChildEnv(), timeout: 20000 });
    if (result.code !== 0) return null;
    try {
      const list = JSON.parse(result.stdout);
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }

  // A door-launched Claude seat that is not waiting for mail: an idle or retired
  // background session is resumed with the doorbell as its next prompt.
  async wakeClaude(payload) {
    const launch = payload.launch ?? {};
    if (launch.door !== 'connector') {
      return { status: 'unreachable', detail: '没在等信：这个会话没有在后台运行 agent-hub ws wait' };
    }
    const config = (await loadDoorConfig(this.dataDir)).claude;
    if (!config?.enabled) return { status: 'unreachable', detail: '没在等信，这台机器的 Claude 门房也关了' };
    const executable = config.executable || 'claude';
    const sessions = await this.claudeSessions(executable);
    if (!sessions) return { status: 'unreachable', detail: '读不到 claude agents 列表' };
    const session = sessions.find((item) => item.sessionId === payload.session_id);
    if (session && !['idle', 'done'].includes(session.status) && session.state !== 'done') {
      return { status: 'unreachable', detail: `会话正在 ${session.status}，没在等信；等它这一轮做完` };
    }
    if (session && session.kind !== 'background') return { status: 'unreachable', detail: '这是一个前台窗口，没在等信' };
    if (session) await this.run(executable, ['stop', session.id], { env: cleanChildEnv(), timeout: 30000 });
    const lines = [];
    if (payload.rejoin_ticket) lines.push(`你的后台会话刚被重新拉起，会话编号变了。先运行这条命令重新接上工作区：agent-hub ws join ${payload.rejoin_ticket}`, '');
    lines.push(payload.text, '', '读完处理好以后，用 Bash 工具的 run_in_background 运行 `agent-hub ws wait` 继续等信。');
    const name = launch.detail?.name;
    const result = await this.run(executable, ['--bg', '--resume', payload.session_id, ...(name ? ['--name', name] : []), ...this.claudeArgs(config), lines.join('\n')], {
      cwd: launch.detail?.cwd || launch.cwd || config.default_cwd || os.homedir(),
      env: await this.seatEnv(),
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const started = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(output);
    if (started) {
      // `--resume` may come back as a copy under a new id; tell the Hub which one is the seat now.
      const resumed = (await this.claudeSessions(executable))?.find((item) => item.id === started[1] || item.sessionId?.startsWith(started[1]));
      return { status: 'resumed', session_id: resumed?.sessionId ?? null, detail: session ? '会话闲着没等信，已重启并带上消息' : '会话已退出，已接着原对话重新拉起' };
    }
    return { status: 'failed', detail: clip(`${result.stdout}\n${result.stderr}`) || `claude 退出码 ${result.code}` };
  }

  async wake(payload) {
    const base = { wake_id: payload.wake_id, member_id: payload.member_id };
    try {
      const entries = this.listeners.get(`${payload.runtime}:${payload.session_id}`);
      // A listener whose session process is gone would swallow the doorbell: drop it first.
      for (const item of [...(entries ?? [])]) {
        if (!alive(item.ownerPid)) {
          entries.delete(item);
          item.response.end();
        }
      }
      const entry = entries?.size ? [...entries].at(-1) : null;
      if (entry) {
        this.write(entry.response, { type: 'wake', ...payload });
        if (entry.mode === 'wait') {
          entry.response.end();
          await this.report('workspace.wake.result', { ...base, status: 'delivered', detail: '送到了 agent-hub ws wait' });
        }
        // A persistent listener is a bridge; it reports whether the native delivery worked.
        return;
      }
      if (payload.runtime === 'antigravity' && this.doorStreams.has('antigravity')) {
        this.write(this.doorStreams.get('antigravity').response, { type: 'wake', ...payload, conversation_id: payload.session_id });
        return;
      }
      if (payload.runtime === 'claude') {
        await this.report('workspace.wake.result', { ...base, ...(await this.wakeClaude(payload)) });
        return;
      }
      const detail = payload.runtime === 'codex'
        ? '收信桥没在运行；在那个 Codex 对话里再运行一次 agent-hub ws join'
        : `这台机器没有能叫醒 ${payload.runtime} 的门房或收信桥`;
      await this.report('workspace.wake.result', { ...base, status: 'unreachable', detail });
    } catch (error) {
      await this.report('workspace.wake.result', { ...base, status: 'failed', detail: clip(error.message) });
    }
  }

  // ---- streams ---------------------------------------------------------------

  write(response, event) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  openStream(response, onClose) {
    response.writeHead(200, SSE_HEADERS);
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), this.keepaliveMs);
    keepalive.unref();
    response.on('close', () => {
      clearInterval(keepalive);
      onClose();
    });
  }

  notifyListener(runtime, sessionId, attached) {
    if (!this.connector.ready) return;
    this.connector.request('workspace.listener', { identity: { runtime, session_id: sessionId }, attached })
      .catch((error) => this.connector.logger.error?.(`Workspace listener state not recorded: ${error.message}`));
  }

  openListener(request, response, url) {
    const runtime = url.searchParams.get('runtime') ?? '';
    const sessionId = url.searchParams.get('session_id') ?? '';
    const mode = url.searchParams.get('mode') === 'stream' ? 'stream' : 'wait';
    if (!runtime || !sessionId) throw localError('runtime and session_id are required');
    const key = `${runtime}:${sessionId}`;
    const entry = { mode, response, ownerPid: Number(url.searchParams.get('owner_pid')) || null };
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.openStream(response, () => {
      const entries = this.listeners.get(key);
      entries?.delete(entry);
      if (entries && !entries.size) {
        this.listeners.delete(key);
        if (!this.closed) this.notifyListener(runtime, sessionId, false);
      }
    });
    this.listeners.get(key).add(entry);
    this.write(response, { type: 'listening', mode });
    this.notifyListener(runtime, sessionId, true);
  }

  openDoor(request, response, url) {
    const runtime = url.searchParams.get('runtime') ?? '';
    if (!['codex', 'antigravity'].includes(runtime)) throw localError('door runtime must be codex or antigravity');
    let detail = {};
    try { detail = JSON.parse(url.searchParams.get('detail') ?? '{}') ?? {}; } catch { detail = {}; }
    const door = { response, detail: { ...detail, session_id: url.searchParams.get('session_id') || null, pid: Number(url.searchParams.get('pid')) || null } };
    const previous = this.doorStreams.get(runtime);
    this.openStream(response, () => {
      if (this.doorStreams.get(runtime) === door) {
        this.doorStreams.delete(runtime);
        if (!this.closed) this.announceDoors();
      }
    });
    this.doorStreams.set(runtime, door);
    if (previous) previous.response.end();
    this.write(response, { type: 'attached', runtime });
    this.announceDoors();
  }

  // ---- files -----------------------------------------------------------------

  identityFrom(url) {
    const runtime = url.searchParams.get('runtime') ?? '';
    const sessionId = url.searchParams.get('session_id') ?? '';
    if (!runtime || !sessionId) throw localError('runtime and session_id are required');
    return { runtime, session_id: sessionId };
  }

  async upload(request, response, url) {
    const identity = this.identityFrom(url);
    const size = Number(url.searchParams.get('size'));
    const begin = await this.request('workspace.file.begin', {
      identity,
      name: url.searchParams.get('name') ?? '',
      content_type: url.searchParams.get('content_type') || null,
      note: url.searchParams.get('note') || null,
      size,
    }, 30000);
    const chunkBytes = Number(begin.chunk_bytes) || 256 * 1024;
    let buffer = Buffer.alloc(0);
    let index = 0;
    const flush = async (piece) => {
      await this.request('workspace.file.chunk', { file_id: begin.file_id, index, data: piece.toString('base64') }, 60000);
      index += 1;
    };
    try {
      for await (const chunk of request) {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
        while (buffer.length >= chunkBytes) {
          await flush(buffer.subarray(0, chunkBytes));
          buffer = buffer.subarray(chunkBytes);
        }
      }
      if (buffer.length) await flush(buffer);
      sendJson(response, 201, await this.request('workspace.file.end', { file_id: begin.file_id }, 60000));
    } catch (error) {
      this.connector.request('workspace.file.end', { file_id: begin.file_id, abort: true }).catch(() => {});
      throw error;
    }
  }

  async download(response, url, fileId) {
    const identity = this.identityFrom(url);
    let offset = 0;
    let first = await this.request('workspace.file.read', { identity, file_id: fileId, offset }, 60000);
    response.writeHead(200, {
      'content-type': first.file.content_type || 'application/octet-stream',
      'content-length': first.file.size,
      'x-agent-hub-file-name': encodeURIComponent(first.file.name),
    });
    for (let chunk = first; ; ) {
      const data = Buffer.from(chunk.data, 'base64');
      response.write(data);
      offset += data.length;
      if (chunk.eof || !data.length) break;
      chunk = await this.request('workspace.file.read', { identity, file_id: fileId, offset }, 60000);
    }
    first = null;
    response.end();
  }

  // ---- local API -------------------------------------------------------------

  async handleLocal(request, response, url) {
    const pathname = url.pathname;
    if (request.method === 'POST' && pathname === '/local/v1/workspaces/rpc') {
      const body = await readJsonBody(request);
      if (typeof body.op !== 'string') throw localError('op is required');
      sendJson(response, 200, await this.request('workspace.rpc', { op: body.op, identity: body.identity ?? null, args: body.args ?? {} }, 30000));
      return;
    }
    if (request.method === 'GET' && pathname === '/local/v1/workspaces/listen') {
      this.openListener(request, response, url);
      return;
    }
    if (request.method === 'GET' && pathname === '/local/v1/workspaces/door') {
      this.openDoor(request, response, url);
      return;
    }
    if (request.method === 'POST' && pathname === '/local/v1/workspaces/result') {
      const body = await readJsonBody(request);
      const type = body.kind === 'launch' ? 'workspace.launch.result' : 'workspace.wake.result';
      const { kind: _kind, ...payload } = body;
      sendJson(response, 200, await this.request(type, payload));
      return;
    }
    if (request.method === 'POST' && pathname === '/local/v1/workspaces/doors/refresh') {
      sendJson(response, 200, { doors: await this.doors(), recorded: await this.announceDoors() });
      return;
    }
    if (request.method === 'GET' && pathname === '/local/v1/workspaces/doors') {
      sendJson(response, 200, { doors: await this.doors() });
      return;
    }
    if (request.method === 'POST' && pathname === '/local/v1/workspaces/files') {
      await this.upload(request, response, url);
      return;
    }
    const fileMatch = /^\/local\/v1\/workspaces\/files\/([^/]+)$/.exec(pathname);
    if (request.method === 'GET' && fileMatch) {
      await this.download(response, url, decodeURIComponent(fileMatch[1]));
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  close() {
    this.closed = true;
    for (const entries of this.listeners.values()) for (const entry of entries) entry.response.end();
    for (const door of this.doorStreams.values()) door.response.end();
    this.listeners.clear();
    this.doorStreams.clear();
  }
}
