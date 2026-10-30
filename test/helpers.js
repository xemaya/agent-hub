import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { Connector } from '../src/connector.js';
import { KimiChannel } from '../src/kimi-channel.js';

const TEST_ROOT = path.resolve('.test-tmp');
const silentLogger = { error() {} };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TestDriver {
  constructor() {
    this.executions = [];
    this.active = 0;
    this.maxActive = 0;
    this.sessionExecutions = new Map();
  }

  async execute({ worker, command, onOutput, onState }) {
    const delay = Number(worker.metadata?.delay_ms ?? 5);
    this.executions.push(command.command_id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(delay);
      if (command.input.startsWith('fail:')) throw new Error(command.input.slice(5));
      const executions = (this.sessionExecutions.get(worker.runtime_session_id) ?? 0) + 1;
      this.sessionExecutions.set(worker.runtime_session_id, executions);
      await onState({ executions });
      const text = `${worker.name}: ${command.input}`;
      onOutput(`${text}\n`);
      return { text, session_id: worker.runtime_session_id, executions };
    } finally {
      this.active -= 1;
    }
  }

  async close() {}
}

export async function waitFor(predicate, { timeout = 6000, interval = 15 } = {}) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`Condition was not met within ${timeout}ms`);
}

export async function createTestContext(t, { hub: hubOptions = {}, connector: connectorOptions = {} } = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_ROOT, 'case-'));
  let hub = await Hub.create({
    ...hubOptions,
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(root, 'hub'),
    credentials: {
      adminToken: 'test-admin',
      enrollmentToken: 'test-enroll',
      generated: [],
      file: path.join(root, 'credentials.json'),
    },
    logger: silentLogger,
  });
  await hub.listen();
  const driver = new TestDriver();
  const channels = new Set();
  const cleanups = [];
  let connector;
  let sessionSequence = 0;

  const startConnector = async () => {
    connector = await Connector.create({
      ...connectorOptions,
      hubUrl: hub.url,
      name: 'test-mac',
      hostname: 'test-mac',
      dataDir: path.join(root, 'connector'),
      localPort: 0,
      enrollToken: 'test-enroll',
      logger: silentLogger,
    });
    await connector.start();
    await connector.whenReady();
    for (const channel of channels) channel.connectorUrl = connector.localUrl;
    return connector;
  };
  await startConnector();

  const admin = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${hub.url}${pathname}`, {
      method,
      headers: {
        authorization: 'Bearer test-admin',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    return { response, payload };
  };

  const local = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${connector.localUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${connector.store.credentials.localToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    return { response, payload };
  };

  const attachWorker = async (worker, selectedDriver = context.driver) => {
    for (const channel of channels) {
      if (channel.runtime === worker.runtime && channel.sessionId === worker.runtime_session_id) {
        channel.stop();
        channels.delete(channel);
      }
    }
    const channel = new KimiChannel({
      connectorUrl: connector.localUrl,
      token: connector.store.credentials.localToken,
      sessionId: worker.runtime_session_id,
      runtime: worker.runtime,
      driver: selectedDriver,
      cwd: worker.cwd,
      retryMs: 10,
      logger: silentLogger,
    });
    channel.worker.metadata = worker.metadata ?? {};
    channels.add(channel);
    await channel.start();
    await waitFor(() => channel.state === 'attached');
    await waitFor(() => hub.store.getWorker(worker.worker_id)?.push_capable);
    return hub.store.getWorker(worker.worker_id);
  };

  const context = {
    root,
    get hub() {
      return hub;
    },
    driver,
    admin,
    local,
    attachWorker,
    onClose(callback) {
      cleanups.push(callback);
    },
    get connector() {
      return connector;
    },
    async restartConnector() {
      await connector.close();
      await waitFor(() => !hub.store.getConnector(connector.connectorId).online);
      return startConnector();
    },
    async restartHub() {
      await connector.close();
      await waitFor(() => !hub.store.getConnector(connector.connectorId).online);
      const credentials = hub.credentials;
      await hub.close();
      hub = await Hub.create({
        host: '127.0.0.1',
        port: 0,
        dataDir: path.join(root, 'hub'),
        credentials,
        logger: silentLogger,
      });
      await hub.listen();
      await startConnector();
      return hub;
    },
    async registerWorker(overrides = {}) {
      const { attach = true, driver: selectedDriver = context.driver, ...bodyOverrides } = overrides;
      sessionSequence += 1;
      const { response, payload } = await local('/local/v1/workers/register', {
        method: 'POST',
        body: {
          name: 'test-worker',
          runtime: 'test',
          mode: 'external',
          runtime_session_id: `session-${sessionSequence}`,
          cwd: root,
          capabilities: ['testing'],
          metadata: {},
          ...bodyOverrides,
        },
      });
      if (!response.ok) throw new Error(JSON.stringify(payload));
      return attach ? attachWorker(payload.worker, selectedDriver) : payload.worker;
    },
    async openDashboard() {
      const url = new URL('/ws/dashboard', hub.url);
      url.protocol = 'ws:';
      const socket = new WebSocket(url);
      const messages = [];
      socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      socket.send(JSON.stringify({ type: 'dashboard.hello', payload: { token: 'test-admin' } }));
      await waitFor(() => messages.some((message) => message.type === 'dashboard.ready'));
      t.after(() => socket.close());
      return { socket, messages };
    },
  };

  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const channel of channels) channel.stop();
    await connector.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  return context;
}
