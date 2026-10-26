import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { Connector } from '../src/connector.js';
import { TestDriver } from '../src/drivers/test.js';

const TEST_ROOT = path.resolve('.test-tmp');
const silentLogger = { error() {} };

export async function waitFor(predicate, { timeout = 6000, interval = 15 } = {}) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition was not met within ${timeout}ms`);
}

export async function createTestContext(t) {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_ROOT, 'case-'));
  let hub = await Hub.create({
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
  let connector;

  const startConnector = async (drivers = connector?.drivers ?? { test: driver }) => {
    connector = await Connector.create({
      hubUrl: hub.url,
      name: 'test-mac',
      hostname: 'test-mac',
      dataDir: path.join(root, 'connector'),
      localPort: 0,
      enrollToken: 'test-enroll',
      allowTestDriver: true,
      drivers,
      logger: silentLogger,
    });
    await connector.start();
    await connector.whenReady();
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

  const context = {
    root,
    get hub() {
      return hub;
    },
    driver,
    admin,
    local,
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
      const { response, payload } = await local('/local/v1/workers/register', {
        method: 'POST',
        body: {
          name: 'test-worker',
          runtime: 'test',
          mode: 'managed',
          cwd: root,
          capabilities: ['testing'],
          metadata: {},
          ...overrides,
        },
      });
      if (!response.ok) throw new Error(JSON.stringify(payload));
      return payload.worker;
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
    await connector.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  return context;
}
