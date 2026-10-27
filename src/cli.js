import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from './hub.js';
import { Connector } from './connector.js';
import { SESSION_RUNTIMES, startSession } from './session-launcher.js';

const HELP = `Agent Hub

Usage:
  agent-hub hub [--host 127.0.0.1] [--port 8787] [--data-dir .runtime/hub]
  agent-hub connector --hub-url URL [--name NAME] [--data-dir .runtime/connector]
                      [--enroll-token TOKEN] [--local-port 8788] [--allow-test-driver]
  agent-hub session start --runtime claude|kimi|codex [--cwd DIR] [-- RUNTIME_ARGS...]
  agent-hub worker register --runtime claude|kimi|codex|test|other --mode managed|external
                            [--name NAME] [--cwd DIR] [--session-id ID]
                            [--capabilities a,b] [--metadata JSON]
  agent-hub worker register-current [--name NAME] [--cwd DIR] [--mode managed|external]
                                    [--capabilities a,b] [--metadata JSON]
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
  AGENT_HUB_KIMI_MODEL          Default model for managed Kimi Workers
  AGENT_HUB_CODEX_MODEL         Default model for managed Codex Workers
`;

const BOOLEAN_FLAGS = new Set(['local', 'wait', 'allow-test-driver', 'orchestrate', 'yes']);

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
  console.log(`Agent Hub listening on ${hub.url}`);
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

async function startConnector(flags) {
  const connector = await Connector.create({
    hubUrl: flags['hub-url'] ?? process.env.AGENT_HUB_URL,
    name: flags.name,
    hostname: flags.hostname,
    dataDir: flags['data-dir'] ?? '.runtime/connector',
    localHost: '127.0.0.1',
    localPort: port(flags['local-port'], 8788),
    enrollToken: flags['enroll-token'] ?? process.env.AGENT_HUB_ENROLLMENT_TOKEN,
    allowTestDriver: flags['allow-test-driver'] === true || process.env.AGENT_HUB_ALLOW_TEST_DRIVER === '1',
  });
  await connector.start();
  console.log(`Connector ${connector.connectorId} listening locally on ${connector.localUrl}`);
  console.log(`Hub: ${connector.hubUrl}`);
  try {
    await connector.whenReady();
  } catch (error) {
    await connector.close();
    throw error;
  }
  console.log('Hub WebSocket connected');
  await waitForSignal(() => connector.close());
}

async function workerCommand(positionals, flags) {
  const action = positionals[0];
  if (['register', 'register-current'].includes(action)) {
    const metadata = flags.metadata ? JSON.parse(flags.metadata) : {};
    let runtime = flags.runtime;
    let sessionId = flags['session-id'];
    if (action === 'register-current') {
      const launcherRuntime = process.env.AGENT_HUB_RUNTIME;
      const launcherSessionId = process.env.AGENT_HUB_SESSION_ID;
      const codexSessionId = process.env.CODEX_SESSION_ID;
      const currentRuntime = launcherRuntime ?? (codexSessionId ? 'codex' : null);
      if (!currentRuntime || !SESSION_RUNTIMES.includes(currentRuntime)) {
        throw new Error('Current Session identity is unavailable; start with agent-hub session start');
      }
      if (sessionId) throw new Error('register-current uses verified runtime identity; do not pass --session-id');
      if (runtime && runtime !== currentRuntime) {
        throw new Error(`Current Session runtime is ${currentRuntime}, not ${runtime}`);
      }
      if (currentRuntime === 'codex') {
        if (!codexSessionId) {
          throw new Error('Codex native Session identity is unavailable; run this command from a Codex tool');
        }
        if (launcherSessionId && launcherSessionId !== codexSessionId) {
          throw new Error('Codex native Session ID does not match the launcher identity');
        }
        sessionId = codexSessionId;
      } else {
        if (!launcherSessionId) {
          throw new Error('Current Session identity is unavailable; start with agent-hub session start');
        }
        sessionId = launcherSessionId;
      }
      runtime = currentRuntime;
      Object.assign(metadata, {
        interactive: true,
        session_origin: launcherRuntime ? 'agent-hub-session-launcher' : 'codex-native-runtime',
      });
    }
    print(await localRequest(flags, '/local/v1/workers/register', {
      method: 'POST',
      body: {
        name: flags.name,
        runtime,
        mode: flags.mode ?? (action === 'register-current' ? 'external' : 'managed'),
        runtime_session_id: sessionId,
        capabilities: flags.capabilities ? flags.capabilities.split(',').map((item) => item.trim()).filter(Boolean) : [],
        cwd: flags.cwd ?? process.cwd(),
        metadata,
      },
    }));
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
  throw new Error('Usage: agent-hub worker register|register-current|list|status');
}

async function sessionCommand(positionals, flags, runtimeArgs) {
  if (positionals[0] !== 'start') throw new Error('Usage: agent-hub session start --runtime claude|kimi|codex');
  const result = await startSession({
    runtime: flags.runtime,
    cwd: flags.cwd ?? process.cwd(),
    runtimeArgs,
    onReady({ runtime, sessionId }) {
      console.error(`Agent Hub session ready: ${runtime}${sessionId ? ` ${sessionId}` : ''}`);
    },
  });
  process.exitCode = result.exitCode;
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
