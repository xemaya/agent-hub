import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from './hub.js';
import { Connector } from './connector.js';
import { SESSION_RUNTIMES, startSession } from './session-launcher.js';
import { readBuildInfo, shortCommit } from './build-info.js';
import { selfUpdate } from './updater.js';
import { connectorServiceStatus, installConnectorService, uninstallConnectorService } from './service.js';
import { ChannelServer } from './channel.js';
import { CodexQueueChannel, bridgeLock, checkNativeQueue, commandRecord, currentDesktopPid, startQueueBridge } from './codex-queue-channel.js';

const HELP = `Agent Hub

Usage:
  agent-hub hub [--host 127.0.0.1] [--port 8787] [--data-dir .runtime/hub]
  agent-hub connector --hub-url URL [--name NAME] [--data-dir .runtime/connector]
                      [--enroll-token TOKEN] [--local-port 8788] [--no-auto-update]
  agent-hub service install --hub-url URL [--name NAME] [--data-dir ~/.agent-hub/connector]
  agent-hub service uninstall|status
  agent-hub update
  agent-hub session start --runtime claude|kimi|codex [--cwd DIR] [-- RUNTIME_ARGS...]
  agent-hub session start --runtime claude|kimi --push [--resume SESSION_ID] [--data-dir DIR]
  agent-hub session start --runtime kimi --push --native-tui [--resume SESSION_ID] [--cwd DIR]
  agent-hub channel [--data-dir DIR]           (spawned by Claude Code for --push sessions)
  agent-hub desktop attach --push [--name NAME] [--cwd DIR] [--data-dir DIR]
  agent-hub desktop report --command-id ID --status succeeded|failed [--data-dir DIR] < result.txt
  agent-hub worker register --runtime claude|kimi|codex|other --session-id ID
                            [--name NAME] [--cwd DIR]
                            [--capabilities a,b] [--metadata JSON]
  agent-hub worker register-current [--name NAME] [--cwd DIR]
                                    [--capabilities a,b] [--metadata JSON]
  agent-hub worker unregister WORKER_ID
  agent-hub worker unregister-current
  agent-hub worker list
  agent-hub worker status WORKER_ID idle|working|waiting|blocked
  agent-hub task create --title TITLE [--goal TEXT] [--context TEXT]
                        [--acceptance LINE1\\nLINE2] [--worker-id ID] [--local] [--orchestrate]
  agent-hub task update TASK_ID [--status STATUS] [--worker-id ID] [--local]
  agent-hub send --prompt TEXT [--worker-id ID] [--task-id ID] [--kind KIND]
                 [--local] [--wait]
  agent-hub orchestration list [--local]
  agent-hub coordinator enable|disable|status [--worker-id ID] [--max-steps N]
  agent-hub history clear --yes
  agent-hub list workers|connectors|tasks|commands|events

Environment:
  AGENT_HUB_URL                 Admin API URL (default http://127.0.0.1:8787)
  AGENT_HUB_ADMIN_TOKEN         Admin API token
  AGENT_HUB_ENROLLMENT_TOKEN    First Connector enrollment token
  AGENT_HUB_CONNECTOR_URL       Local Connector URL (default http://127.0.0.1:8788)
  AGENT_HUB_LOCAL_TOKEN         Local Connector token; otherwise read from data-dir
  AGENT_HUB_AUTO_UPDATE         Set to 0 to stop the Connector from fast-forwarding itself
`;

const BOOLEAN_FLAGS = new Set(['local', 'wait', 'orchestrate', 'yes', 'no-auto-update', 'push', 'desktop', 'native-tui']);

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const equal = item.indexOf('=');
    if (equal !== -1) {
      const key = item.slice(2, equal);
      const value = item.slice(equal + 1);
      flags[key] = BOOLEAN_FLAGS.has(key) ? value !== 'false' : value;
      continue;
    }
    const key = item.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positionals, flags, passthrough };
}

function port(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error('Invalid port');
  return parsed;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function adminOptions(flags) {
  let token = process.env.AGENT_HUB_ADMIN_TOKEN;
  if (!token && flags['hub-data-dir']) {
    const stored = JSON.parse(await readFile(path.join(path.resolve(flags['hub-data-dir']), 'credentials.json'), 'utf8'));
    token = stored.adminToken;
  }
  return {
    baseUrl: flags['hub-url'] ?? process.env.AGENT_HUB_URL ?? 'http://127.0.0.1:8787',
    token,
  };
}

async function adminRequest(flags, pathname, { method = 'GET', body } = {}) {
  const options = await adminOptions(flags);
  if (!options.token) throw new Error('AGENT_HUB_ADMIN_TOKEN is required');
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Request failed with HTTP ${response.status}`);
  return payload;
}

async function localOptions(flags) {
  const dataDir = path.resolve(flags['data-dir'] ?? '.runtime/connector');
  let stored = {};
  try {
    stored = JSON.parse(await readFile(path.join(dataDir, 'connector.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = process.env.AGENT_HUB_LOCAL_TOKEN ?? stored.localToken;
  if (!token) throw new Error('Local token not found; set --data-dir or AGENT_HUB_LOCAL_TOKEN');
  return {
    baseUrl: flags['connector-url'] ?? process.env.AGENT_HUB_CONNECTOR_URL ?? 'http://127.0.0.1:8788',
    token,
  };
}

async function localRequest(flags, pathname, { method = 'GET', body } = {}) {
  const options = await localOptions(flags);
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Request failed with HTTP ${response.status}`);
  return payload;
}

function waitForSignal(close) {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function startHub(flags) {
  const hub = await Hub.create({
    host: flags.host ?? '127.0.0.1',
    port: port(flags.port, 8787),
    dataDir: flags['data-dir'] ?? '.runtime/hub',
  });
  await hub.listen();
  console.log(`Agent Hub ${shortCommit(hub.build.commit)}${hub.build.dirty ? ' (modified)' : ''} listening on ${hub.url}`);
  console.log(`Dashboard: ${hub.url}/`);
  if (hub.credentials.generated.includes('adminToken')) {
    console.log(`Admin token: ${hub.credentials.adminToken}`);
  }
  if (hub.credentials.generated.includes('enrollmentToken')) {
    console.log(`Enrollment token: ${hub.credentials.enrollmentToken}`);
  }
  if (!hub.credentials.generated.length) console.log(`Using credentials from ${hub.credentials.file}`);
  await waitForSignal(() => hub.close());
}

function describeUpdate(result) {
  if (result.action === 'updated') {
    return `Updated ${shortCommit(result.from)} -> ${shortCommit(result.to)}${result.dependencies_installed ? ' (dependencies installed)' : ''}`;
  }
  if (result.action === 'current') return `Already at upstream ${shortCommit(result.to)}`;
  return `Update skipped: ${result.reason}`;
}

async function startConnector(flags) {
  const supervised = process.env.AGENT_HUB_SUPERVISED === '1';
  const autoUpdate = flags['no-auto-update'] !== true && process.env.AGENT_HUB_AUTO_UPDATE !== '0';
  const connector = await Connector.create({
    hubUrl: flags['hub-url'] ?? process.env.AGENT_HUB_URL,
    name: flags.name,
    hostname: flags.hostname,
    dataDir: flags['data-dir'] ?? '.runtime/connector',
    localHost: '127.0.0.1',
    localPort: port(flags['local-port'], 8788),
    enrollToken: flags['enroll-token'] ?? process.env.AGENT_HUB_ENROLLMENT_TOKEN,
    onVersionMismatch: autoUpdate
      ? async ({ hub }) => {
          const result = await selfUpdate({ peerCommit: hub.commit });
          console.error(describeUpdate(result));
          if (result.reason && result.action !== 'skipped') console.error(`Note: ${result.reason}; update the Hub machine`);
          if (result.action !== 'updated') return;
          if (supervised) connector.requestRestart();
          else console.error('Restart the Connector to load the update');
        }
      : null,
    onRestartRequested: () => {
      console.error('Restarting to load the update');
      connector.close().finally(() => process.exit(75));
    },
  });
  await connector.start();
  console.log(`Connector ${connector.connectorId} (${shortCommit(connector.build.commit)}${connector.build.dirty ? ', modified' : ''}) listening locally on ${connector.localUrl}`);
  console.log(`Hub: ${connector.hubUrl}`);
  try {
    await connector.whenReady();
    console.log('Hub WebSocket connected');
  } catch (error) {
    // Under launchd, keep the local API up and let the watchdog keep reconnecting.
    if (!supervised) {
      await connector.close();
      throw error;
    }
    console.error(`${error.message}; will keep retrying`);
  }
  await waitForSignal(() => connector.close());
}

async function serviceCommand(positionals, flags) {
  const action = positionals[0];
  if (action === 'status') {
    print(await connectorServiceStatus());
    return;
  }
  if (action === 'uninstall') {
    print(await uninstallConnectorService());
    return;
  }
  if (action !== 'install') throw new Error('Usage: agent-hub service install|uninstall|status');
  const localPort = flags['local-port'] === undefined ? undefined : port(flags['local-port'], 8788);
  const status = await connectorServiceStatus();
  if (!status.loaded) {
    const running = await fetch(`http://127.0.0.1:${localPort ?? 8788}/local/v1/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (running) throw new Error('A Connector is already running outside the service; stop it first, then rerun');
  }
  print(await installConnectorService({
    hubUrl: flags['hub-url'] ?? process.env.AGENT_HUB_URL,
    name: flags.name,
    dataDir: path.resolve(flags['data-dir'] ?? path.join(process.env.HOME ?? '.', '.agent-hub/connector')),
    localPort,
  }));
}

function currentSessionIdentity({ runtime = null, sessionId = null, operation = 'register-current' } = {}) {
  const launcherRuntime = process.env.AGENT_HUB_RUNTIME;
  const launcherSessionId = process.env.AGENT_HUB_SESSION_ID;
  const codexSessionId = process.env.CODEX_SESSION_ID;
  const currentRuntime = launcherRuntime ?? (codexSessionId ? 'codex' : null);
  if (!currentRuntime || !SESSION_RUNTIMES.includes(currentRuntime)) {
    throw new Error('Current Session identity is unavailable; start with agent-hub session start');
  }
  if (sessionId) throw new Error(`${operation} uses verified runtime identity; do not pass --session-id`);
  if (runtime && runtime !== currentRuntime) {
    throw new Error(`Current Session runtime is ${currentRuntime}, not ${runtime}`);
  }
  let currentSessionId;
  if (currentRuntime === 'codex') {
    if (!codexSessionId) {
      throw new Error('Codex native Session identity is unavailable; run this command from a Codex tool');
    }
    if (launcherSessionId && launcherSessionId !== codexSessionId) {
      throw new Error('Codex native Session ID does not match the launcher identity');
    }
    currentSessionId = codexSessionId;
  } else {
    if (!launcherSessionId) {
      throw new Error('Current Session identity is unavailable; start with agent-hub session start');
    }
    currentSessionId = launcherSessionId;
  }
  return {
    runtime: currentRuntime,
    sessionId: currentSessionId,
    origin: launcherRuntime ? 'agent-hub-session-launcher' : 'codex-native-runtime',
  };
}

async function workerCommand(positionals, flags) {
  const action = positionals[0];
  if (action === 'unregister-current') {
    const identity = currentSessionIdentity({ runtime: flags.runtime, sessionId: flags['session-id'], operation: action });
    print(await localRequest(flags, '/local/v1/workers/unregister-current', {
      method: 'POST',
      body: { runtime: identity.runtime, runtime_session_id: identity.sessionId },
    }));
    return;
  }
  if (action === 'unregister' && positionals[1]) {
    print(await adminRequest(flags, `/api/v1/workers/${encodeURIComponent(positionals[1])}`, { method: 'DELETE' }));
    return;
  }
  if (['register', 'register-current'].includes(action)) {
    if (flags.mode !== undefined && flags.mode !== 'external') throw new Error('Only interactive external Workers are supported');
    const metadata = flags.metadata ? JSON.parse(flags.metadata) : {};
    let runtime = flags.runtime;
    let sessionId = flags['session-id'];
    if (action === 'register-current') {
      const identity = currentSessionIdentity({ runtime, sessionId, operation: action });
      runtime = identity.runtime;
      sessionId = identity.sessionId;
      Object.assign(metadata, {
        interactive: true,
        session_origin: identity.origin,
      });
    }
    let desktop = null;
    const dataDir = path.resolve(flags['data-dir'] ?? process.env.AGENT_HUB_CONNECTOR_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.agent-hub/connector'));
    if (flags.desktop || (flags.push && action === 'register-current' && runtime === 'codex')) {
      if (action !== 'register-current' || runtime !== 'codex' || flags.push !== true || (flags.mode && flags.mode !== 'external')) throw new Error('Use desktop attach --push inside the actual Codex desktop chat');
      desktop = { pid: await currentDesktopPid(), executable: flags.executable ?? 'codex' };
      await checkNativeQueue(desktop.executable);
      Object.assign(metadata, { desktop: true, desktop_delivery: 'codex-queue' });
    }
    const payload = await localRequest(desktop ? { ...flags, 'data-dir': dataDir } : flags, '/local/v1/workers/register', {
      method: 'POST',
      body: {
        name: flags.name,
        runtime,
        mode: 'external',
        runtime_session_id: sessionId,
        capabilities: flags.capabilities ? flags.capabilities.split(',').map((item) => item.trim()).filter(Boolean) : [],
        cwd: flags.cwd ?? process.cwd(),
        metadata,
      },
    });
    if (desktop) {
      const bridge = await startQueueBridge({ dataDir, sessionId, cwd: path.resolve(flags.cwd ?? process.cwd()),
        desktopPid: desktop.pid, executable: desktop.executable,
        connectorUrl: flags['connector-url'] ?? process.env.AGENT_HUB_CONNECTOR_URL,
      });
      const { workers } = await localRequest({ ...flags, 'data-dir': dataDir }, '/local/v1/workers');
      print({ ...payload, worker: workers.find(worker => worker.worker_id === payload.worker.worker_id), desktop_bridge: bridge });
    } else print(payload);
    return;
  }
  if (action === 'list') {
    print(await localRequest(flags, '/local/v1/workers'));
    return;
  }
  if (action === 'status' && positionals[1] && positionals[2]) {
    print(await localRequest(flags, `/local/v1/workers/${encodeURIComponent(positionals[1])}/status`, {
      method: 'POST',
      body: { work_state: positionals[2], current_task_id: flags['task-id'] },
    }));
    return;
  }
  throw new Error('Usage: agent-hub worker register|register-current|unregister|unregister-current|list|status');
}

async function sessionCommand(positionals, flags, runtimeArgs) {
  if (positionals[0] !== 'start') throw new Error('Usage: agent-hub session start --runtime claude|kimi|codex');
  const dataDir = flags['data-dir'] ?? process.env.AGENT_HUB_CONNECTOR_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.agent-hub/connector');
  const connectorUrl = flags['connector-url'] ?? process.env.AGENT_HUB_CONNECTOR_URL;
  const channel = flags.push === true && flags.runtime === 'kimi'
    ? await localOptions({ 'data-dir': dataDir, 'connector-url': connectorUrl })
    : null;
  const result = await startSession({
    runtime: flags.runtime,
    cwd: flags.cwd ?? process.cwd(),
    runtimeArgs,
    push: flags.push === true,
    nativeTui: flags['native-tui'] === true,
    resumeSessionId: typeof flags.resume === 'string' ? flags.resume : undefined,
    dataDir,
    connectorUrl,
    ...(channel ? { channel: { connectorUrl: channel.baseUrl, token: channel.token } } : {}),
    onReady({ runtime, sessionId }) {
      console.error(`Agent Hub session ready: ${runtime}${sessionId ? ` ${sessionId}` : ''}`);
    },
  });
  process.exitCode = result.exitCode;
}

async function desktopCommand(positionals, flags) {
  const dataDir = path.resolve(flags['data-dir'] ?? process.env.AGENT_HUB_CONNECTOR_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.agent-hub/connector'));
  if (positionals[0] === 'attach') return workerCommand(['register-current'], { ...flags, 'data-dir': dataDir, desktop: true });
  if (positionals[0] === 'report') {
    const identity = currentSessionIdentity();
    if (identity.runtime !== 'codex') throw new Error('A Codex desktop receipt must originate in its native session');
    if (!['succeeded', 'failed'].includes(flags.status)) throw new Error('status must be succeeded or failed');
    const recordFile = commandRecord(dataDir, identity.sessionId, flags['command-id']);
    const record = JSON.parse(await readFile(recordFile, 'utf8'));
    if (record.session_id !== identity.sessionId || record.command_id !== flags['command-id']) throw new Error('Receipt does not belong to this native session');
    let result = '';
    for await (const chunk of process.stdin) { result += chunk; if (Buffer.byteLength(result) > 512 * 1024) throw new Error('Result exceeds 512 KiB'); }
    if (!result.trim()) throw new Error('Report result must be provided through stdin');
    const lock = await open(`${recordFile}.report`, 'wx', 0o600);
    try {
      await lock.writeFile(JSON.stringify({ state: 'reporting' }));
      const response = await localRequest({ ...flags, 'data-dir': dataDir, 'connector-url': record.connector_url },
        `/local/v1/channel/commands/${encodeURIComponent(record.command_id)}/report`,
        { method: 'POST', body: { status: flags.status, result } });
      await lock.truncate(0); await lock.write(JSON.stringify({ state: 'reported' }), 0, 'utf8');
      print(response);
    } finally { await lock.close(); }
    return;
  }
  if (positionals[0] === 'bridge') {
    if (typeof flags['session-id'] !== 'string' || !Number.isInteger(Number(flags['desktop-pid']))) throw new Error('Queue bridge requires verified native identity and desktop PID');
    const local = await localOptions({ ...flags, 'data-dir': dataDir });
    const release = await bridgeLock(dataDir, flags['session-id']);
    const channel = new CodexQueueChannel({ dataDir, sessionId: flags['session-id'], cwd: flags.cwd ?? process.cwd(),
      connectorUrl: local.baseUrl, token: local.token, desktopPid: Number(flags['desktop-pid']), executable: flags.executable ?? 'codex',
      onReady: event => { if (process.connected) process.send({ type: 'ready', worker_id: event.worker_id, session_id: flags['session-id'], pid: process.pid }); },
    });
    const stop = () => channel.stop();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await channel.start(); }
    catch (error) { if (process.connected) process.send({ type: 'failed', message: error.message }); throw error; }
    finally { channel.stop(); await release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  throw new Error('Usage: agent-hub desktop attach|report');
}

// stdout carries MCP JSON-RPC, so everything human-readable goes to stderr.
async function channelCommand(flags) {
  const runtime = flags.runtime ?? process.env.AGENT_HUB_RUNTIME;
  const sessionId = flags['session-id'] ?? process.env.AGENT_HUB_SESSION_ID;
  if (!runtime || !sessionId) throw new Error('channel needs AGENT_HUB_RUNTIME and AGENT_HUB_SESSION_ID');
  const options = await localOptions({
    ...flags,
    'data-dir': flags['data-dir'] ?? process.env.AGENT_HUB_CONNECTOR_DATA_DIR ?? path.join(process.env.HOME ?? '.', '.agent-hub/connector'),
  });
  const server = new ChannelServer({
    connectorUrl: options.baseUrl,
    token: options.token,
    runtime,
    sessionId,
    logger: { error: (message) => console.error(message) },
  });
  await server.start();
  await new Promise((resolve) => process.stdin.once('close', resolve));
  server.stop();
}

async function taskCommand(positionals, flags) {
  const action = positionals[0];
  const local = Boolean(flags.local);
  const request = local ? localRequest : adminRequest;
  const basePath = local ? '/local/v1/tasks' : '/api/v1/tasks';
  if (action === 'create') {
    print(await request(flags, basePath, {
      method: 'POST',
      body: {
        title: flags.title,
        goal: flags.goal ?? '',
        context: flags.context ?? '',
        acceptance: flags.acceptance ? flags.acceptance.split('\\n') : [],
        assignee_worker_id: flags['worker-id'],
        orchestrate: flags.orchestrate === true,
      },
    }));
    return;
  }
  if (action === 'update' && positionals[1]) {
    if (local && flags['worker-id']) throw new Error('Local task updates only support --status');
    print(await request(flags, `${basePath}/${encodeURIComponent(positionals[1])}`, {
      method: 'PATCH',
      body: local
        ? { status: flags.status }
        : { status: flags.status, assignee_worker_id: flags['worker-id'] },
    }));
    return;
  }
  throw new Error('Usage: agent-hub task create|update');
}

async function coordinatorCommand(positionals, flags) {
  const action = positionals[0];
  if (!['status', 'enable', 'disable'].includes(action)) {
    throw new Error('Usage: agent-hub coordinator enable|disable|status');
  }
  const body = { enabled: action !== 'disable' };
  if (action === 'enable') {
    if (!flags['worker-id']) throw new Error('--worker-id is required');
    body.worker_id = flags['worker-id'];
  }
  if (flags['max-steps'] !== undefined) {
    const maxSteps = Number(flags['max-steps']);
    if (!Number.isInteger(maxSteps)) throw new Error('--max-steps must be an integer');
    body.max_steps = maxSteps;
  }
  print(await adminRequest(flags, '/api/v1/coordinator', {
    method: action === 'status' ? 'GET' : 'PUT',
    ...(action === 'status' ? {} : { body }),
  }));
}

async function orchestrationCommand(positionals, flags) {
  if (positionals[0] !== 'list') throw new Error('Usage: agent-hub orchestration list [--local]');
  const request = flags.local ? localRequest : adminRequest;
  print(await request(flags, flags.local ? '/local/v1/orchestrations' : '/api/v1/orchestrations'));
}

async function historyCommand(positionals, flags) {
  if (positionals[0] !== 'clear') throw new Error('Usage: agent-hub history clear --yes');
  if (flags.yes !== true) throw new Error('History clearing requires explicit --yes; a database backup is created first');
  print(await adminRequest(flags, '/api/v1/history/clear', {
    method: 'POST',
    body: { confirm: true },
  }));
}

export async function run(argv) {
  const { positionals, flags, passthrough } = parseArgs(argv);
  const command = positionals[0];
  if (!command || flags.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'hub') {
    await startHub(flags);
    return;
  }
  if (command === 'connector') {
    await startConnector(flags);
    return;
  }
  if (command === 'channel') {
    await channelCommand(flags);
    return;
  }
  if (command === 'desktop') {
    await desktopCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'service') {
    await serviceCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'update') {
    const result = await selfUpdate();
    print({ ...result, build: await readBuildInfo() });
    if (result.action === 'updated') console.error('Restart the Hub or Connector to load the update');
    return;
  }
  if (command === 'session') {
    await sessionCommand(positionals.slice(1), flags, passthrough);
    return;
  }
  if (command === 'worker') {
    await workerCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'coordinator') {
    await coordinatorCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'orchestration') {
    await orchestrationCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'history') {
    await historyCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'task') {
    await taskCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'send') {
    if (!flags.prompt) throw new Error('--prompt is required');
    if (flags.wait && !flags.local) throw new Error('--wait requires --local');
    const local = Boolean(flags.local);
    const request = local ? localRequest : adminRequest;
    const payload = await request(flags, local ? '/local/v1/commands' : '/api/v1/commands', {
      method: 'POST',
      body: {
        worker_id: flags['worker-id'],
        task_id: flags['task-id'],
        kind: flags.kind ?? 'prompt',
        input: flags.prompt,
        ...(local ? { wait: flags.wait === true } : {}),
      },
    });
    print(payload);
    if (local && payload.command?.status === 'failed') process.exitCode = 1;
    return;
  }
  if (command === 'list' && positionals[1]) {
    const resource = positionals[1];
    if (!['workers', 'connectors', 'tasks', 'commands', 'events'].includes(resource)) {
      throw new Error(`Unknown resource: ${resource}`);
    }
    print(await adminRequest(flags, `/api/v1/${resource}`));
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
