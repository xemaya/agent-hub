import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { installDesktopLauncher, openHubDesktop } from '../src/desktop-launcher.js';
import { runDesktopBridge } from '../src/desktop-session.js';
import { createTestContext, waitFor } from './helpers.js';

const execute = promisify(execFile);
async function directory(t) {
  await mkdir('.test-tmp', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-tmp', 'desktop-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Desktop launcher refuses to close or reconfigure an existing unrelated desktop process', async t => {
  const dataDir = await directory(t);
  let changed = false;
  await assert.rejects(openHubDesktop({ dataDir, processes: async () => [123],
    openApp: async () => { changed = true; }, startServer: async () => { changed = true; },
  }), /already running outside this launcher/);
  assert.equal(changed, false);
});

test('Desktop launcher opens the actual App with shared-server environment and records its exact PID', async t => {
  const dataDir = await directory(t);
  await mkdir(path.join(dataDir, 'desktop'));
  let opened = false, serverOptions;
  const calls = [];
  const result = await openHubDesktop({ dataDir,
    processes: async () => opened ? [456] : [],
    startServer: async options => { serverOptions = options; return { pid: process.pid, url: options.url }; },
    openApp: async args => { calls.push(args); opened = true; },
  });
  assert.equal(serverOptions.executable, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.deepEqual(calls, [['-a', '/Applications/ChatGPT.app', '--env', 'CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:45123/']]);
  assert.equal(result.desktop_pid, 456);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'desktop', 'server.json'), 'utf8'));
  assert.equal(saved.desktop_pid, 456);
});

test('Generated macOS launcher is executable, safely quotes paths, and never overwrites an app', async t => {
  const root = await directory(t);
  const output = path.join(root, "Codex Hub's Test.app");
  await installDesktopLauncher({ output, dataDir: path.join(root, 'data dir'), nodePath: "/a path/node's binary" });
  const script = path.join(output, 'Contents', 'MacOS', 'launch');
  assert.equal((await stat(script)).mode & 0o111, 0o111);
  await execute('/bin/sh', ['-n', script]);
  if (process.platform === 'darwin') await execute('/usr/bin/plutil', ['-lint', path.join(output, 'Contents', 'Info.plist')]);
  assert.match(await readFile(script, 'utf8'), /desktop open --data-dir/);
  await assert.rejects(installDesktopLauncher({ output, dataDir: root }), e => e.code === 'EEXIST');
});

test('Exiting the tracked desktop process revokes the background bridge without stopping the shared server', async t => {
  const context = await createTestContext(t);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', peer => peer.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.id === undefined) return;
    const result = m.method === 'thread/loaded/list' ? { data: ['native-desktop-lifecycle'], nextCursor: null }
      : m.method === 'initialize' ? {} : { thread: { id: 'native-desktop-lifecycle', status: { type: 'idle' } } };
    peer.send(JSON.stringify({ id: m.id, result }));
  }));
  const desktopStandIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => { desktopStandIn.kill(); for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  const worker = await context.registerWorker({ runtime: 'codex', mode: 'external', runtime_session_id: 'native-desktop-lifecycle' });
  const run = runDesktopBridge({ dataDir: path.join(context.root, 'desktop-test'), url: `ws://127.0.0.1:${server.address().port}`,
    sessionId: 'native-desktop-lifecycle', connectorUrl: context.connector.localUrl, token: context.connector.store.credentials.localToken,
    cwd: context.root, desktopPid: desktopStandIn.pid, logger: { error() {} },
  });
  await waitFor(() => context.connector.store.getWorker(worker.worker_id).push_capable);
  const exited = new Promise(resolve => desktopStandIn.once('exit', resolve));
  desktopStandIn.kill('SIGTERM');
  await exited;
  assert.equal(await run, 0);
  await waitFor(() => context.connector.store.getWorker(worker.worker_id).push_capable === false);
  assert.ok(server.address(), 'shared server remains alive');
});
