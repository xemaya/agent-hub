import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from './hub.js';
import { Connector } from './connector.js';

const HELP = `Agent Hub

Usage:
  agent-hub hub [--host 127.0.0.1] [--port 8787] [--data-dir .runtime/hub]
  agent-hub connector --hub-url URL [--name NAME] [--data-dir .runtime/connector]
                      [--enroll-token TOKEN] [--local-port 8788] [--allow-test-driver]
  agent-hub worker register --runtime claude|kimi|codex|test|other --mode managed|external
                            [--name NAME] [--cwd DIR] [--session-id ID]
                            [--capabilities a,b] [--metadata JSON]
  agent-hub worker list
  agent-hub worker status WORKER_ID idle|working|waiting|blocked
  agent-hub task create --title TITLE [--goal TEXT] [--context TEXT]
                        [--acceptance LINE1\\nLINE2] [--worker-id ID]
  agent-hub task update TASK_ID [--status STATUS] [--worker-id ID]
  agent-hub send --prompt TEXT [--worker-id ID] [--task-id ID] [--kind KIND]
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

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const equal = item.indexOf('=');
    if (equal !== -1) {
      flags[item.slice(2, equal)] = item.slice(equal + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positionals, flags };
}

function port(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error('Invalid port');
  return parsed;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function adminOptions(flags) {
  return {
    baseUrl: flags['hub-url'] ?? process.env.AGENT_HUB_URL ?? 'http://127.0.0.1:8787',
    token: process.env.AGENT_HUB_ADMIN_TOKEN,
  };
}

async function adminRequest(flags, pathname, { method = 'GET', body } = {}) {
  const options = adminOptions(flags);
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
  if (action === 'register') {
    const metadata = flags.metadata ? JSON.parse(flags.metadata) : {};
    print(await localRequest(flags, '/local/v1/workers/register', {
      method: 'POST',
      body: {
        name: flags.name,
        runtime: flags.runtime,
        mode: flags.mode ?? 'managed',
        runtime_session_id: flags['session-id'],
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
  throw new Error('Usage: agent-hub worker register|list|status');
}

async function taskCommand(positionals, flags) {
  const action = positionals[0];
  if (action === 'create') {
    print(await adminRequest(flags, '/api/v1/tasks', {
      method: 'POST',
      body: {
        title: flags.title,
        goal: flags.goal ?? '',
        context: flags.context ?? '',
        acceptance: flags.acceptance ? flags.acceptance.split('\\n') : [],
        assignee_worker_id: flags['worker-id'],
      },
    }));
    return;
  }
  if (action === 'update' && positionals[1]) {
    print(await adminRequest(flags, `/api/v1/tasks/${encodeURIComponent(positionals[1])}`, {
      method: 'PATCH',
      body: {
        status: flags.status,
        assignee_worker_id: flags['worker-id'],
      },
    }));
    return;
  }
  throw new Error('Usage: agent-hub task create|update');
}

export async function run(argv) {
  const { positionals, flags } = parseArgs(argv);
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
  if (command === 'worker') {
    await workerCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'task') {
    await taskCommand(positionals.slice(1), flags);
    return;
  }
  if (command === 'send') {
    if (!flags.prompt) throw new Error('--prompt is required');
    print(await adminRequest(flags, '/api/v1/commands', {
      method: 'POST',
      body: {
        worker_id: flags['worker-id'],
        task_id: flags['task-id'],
        kind: flags.kind ?? 'prompt',
        input: flags.prompt,
      },
    }));
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
