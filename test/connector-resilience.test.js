import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { Connector } from '../src/connector.js';
import { waitFor } from './helpers.js';

const silentLogger = { error() {} };

// A TCP hop in front of the Hub that can stall handshakes or silently drop live links,
// the two failures Node's WebSocket never reports on its own.
async function createFlakyProxy(targetPort) {
  const links = new Set();
  const proxy = {
    mode: 'forward',
    connections: 0,
    blackholeExisting() {
      for (const link of links) {
        link.client.unpipe(link.upstream);
        link.upstream.unpipe(link.client);
      }
    },
  };
  const server = net.createServer((client) => {
    proxy.connections += 1;
    client.on('error', () => {});
    if (proxy.mode === 'hang') return;
    const upstream = net.connect(targetPort, '127.0.0.1');
    upstream.on('error', () => {});
    const link = { client, upstream };
    links.add(link);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      links.delete(link);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', drop);
    upstream.on('close', drop);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.url = `http://127.0.0.1:${server.address().port}`;
  proxy.close = async () => {
    for (const link of links) {
      link.client.destroy();
      link.upstream.destroy();
    }
    server.close();
  };
  return proxy;
}

async function createResilienceContext(t, { hubBuild, connectorBuild, onVersionMismatch } = {}) {
  await mkdir(path.resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-tmp', 'resilience-'));
  const hub = await Hub.create({
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(root, 'hub'),
    credentials: { adminToken: 'test-admin', enrollmentToken: 'test-enroll', generated: [], file: path.join(root, 'c.json') },
    logger: silentLogger,
    build: hubBuild ?? { version: '0.1.0', commit: 'same', dirty: false },
  });
  await hub.listen();
  const proxy = await createFlakyProxy(new URL(hub.url).port);
  // Enroll straight against the Hub so no pooled HTTP connection rides the proxy.
  const connector = await Connector.create({
    hubUrl: hub.url,
    name: 'flaky-mac',
    hostname: 'flaky-mac',
    dataDir: path.join(root, 'connector'),
    localPort: 0,
    enrollToken: 'test-enroll',
    logger: silentLogger,
    build: connectorBuild ?? { version: '0.1.0', commit: 'same', dirty: false },
    connectTimeoutMs: 300,
    heartbeatIntervalMs: 200,
    heartbeatTimeoutMs: 200,
    onVersionMismatch,
  });
  await connector.enrollIfNeeded();
  connector.store.state.hubUrl = proxy.url;
  t.after(async () => {
    await connector.close();
    await proxy.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  return { hub, proxy, connector };
}

test('Connector recovers from a handshake that never completes', async (t) => {
  const { proxy, connector } = await createResilienceContext(t);
  proxy.mode = 'hang';
  await connector.start();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(connector.ready, false);
  assert.ok(proxy.connections >= 2, 'stalled handshakes are abandoned and retried');
  proxy.mode = 'forward';
  await waitFor(() => connector.ready, { timeout: 8000 });
});

test('Connector notices a silently dropped connection through heartbeats and reconnects', async (t) => {
  const { proxy, connector } = await createResilienceContext(t);
  await connector.start();
  await connector.whenReady();
  const before = proxy.connections;
  const firstSocket = connector.ws;
  proxy.blackholeExisting();
  await waitFor(() => connector.ready && connector.ws !== firstSocket, { timeout: 8000 });
  assert.ok(proxy.connections > before);
});

test('Heartbeat error replies from an older Hub still count as a live link', async (t) => {
  const { hub, connector } = await createResilienceContext(t);
  const original = hub.handleConnectorMessage.bind(hub);
  hub.handleConnectorMessage = async (socket, connectorId, message) => {
    if (message.type === 'connector.heartbeat') throw new Error('Unsupported connector message: connector.heartbeat');
    return original(socket, connectorId, message);
  };
  await connector.start();
  await connector.whenReady();
  const socket = connector.ws;
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(connector.ready, true);
  assert.equal(connector.ws, socket);
});

test('Hub and Connector exchange builds and a mismatch is reported once per Hub commit', async (t) => {
  const mismatches = [];
  const { hub, proxy, connector } = await createResilienceContext(t, {
    hubBuild: { version: '0.1.0', commit: 'hubcommit', dirty: false },
    connectorBuild: { version: '0.1.0', commit: 'connectorcommit', dirty: false },
    onVersionMismatch: (builds) => mismatches.push(builds),
  });
  await connector.start();
  await connector.whenReady();
  await waitFor(() => mismatches.length === 1);
  assert.equal(mismatches[0].hub.commit, 'hubcommit');
  assert.equal(mismatches[0].connector.commit, 'connectorcommit');
  assert.equal(connector.hubBuild.commit, 'hubcommit');

  const health = await (await fetch(`${hub.url}/healthz`)).json();
  assert.equal(health.commit, 'hubcommit');
  const connectors = await (await fetch(`${hub.url}/api/v1/connectors`, { headers: { authorization: 'Bearer test-admin' } })).json();
  assert.equal(connectors.connectors[0].build.commit, 'connectorcommit');

  const firstSocket = connector.ws;
  proxy.blackholeExisting();
  await waitFor(() => connector.ready && connector.ws !== firstSocket, { timeout: 8000 });
  assert.equal(mismatches.length, 1);
});

test('A requested restart waits for running interactive work to finish', async (t) => {
  const { connector } = await createResilienceContext(t);
  let restarts = 0;
  connector.onRestartRequested = () => {
    restarts += 1;
  };
  connector.activeWorkers.add('worker_busy');
  connector.requestRestart();
  assert.equal(restarts, 0);
  connector.activeWorkers.delete('worker_busy');
  connector.maybeRestart();
  assert.equal(restarts, 1);
  connector.maybeRestart();
  assert.equal(restarts, 1);
});
