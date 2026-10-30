import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Hub } from '../src/hub.js';
import { createSkillArchive } from '../src/skill-package.js';

const execute = promisify(execFile);
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TEST_ROOT = path.join(PROJECT_ROOT, '.test-tmp');
const silentLogger = { error() {} };

async function temporaryDirectory(t, name) {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEST_ROOT, name));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runBootstrap(script, env, input = '', timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [script], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Bootstrap failed (${code ?? signal})\n${stdout}\n${stderr}`), { stdout, stderr }));
    });
    child.stdin.end(input);
  });
}

test('public Skill is a complete, deterministic ZIP without exposing admin APIs', async (t) => {
  const directory = await temporaryDirectory(t, 'skill-download-');
  const hub = await Hub.create({
    host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'hub'),
    credentials: { adminToken: 'test-admin', enrollmentToken: 'test-enroll', generated: [], file: path.join(directory, 'credentials.json') },
    logger: silentLogger,
  });
  await hub.listen();
  t.after(() => hub.close());
  const page = await fetch(`${hub.url}/skill`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /https:\/\/hub\.findu\.work\/skill\/agent-hub\.zip/);
  assert.doesNotMatch(html, /test-admin|test-enroll/);
  assert.match(html, /不要把当前已打开的 Kimi\/Claude 窗口登记为 Worker/);
  assert.match(html, /所有 Worker 都是可见交互 Session/);
  const raw = await fetch(`${hub.url}/skill/SKILL.md`);
  assert.equal(raw.status, 200);
  const skill = await raw.text();
  assert.match(skill, /首次接入一台新 Mac/);
  assert.match(skill, /worker directory/);
  assert.match(skill, /message send/);
  assert.match(skill, /不调用中央大脑/);
  const first = await fetch(`${hub.url}/skill/agent-hub.zip`);
  const second = await fetch(`${hub.url}/skill/agent-hub.zip`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/zip');
  assert.match(first.headers.get('content-disposition'), /agent-hub\.zip/);
  const firstBody = Buffer.from(await first.arrayBuffer());
  assert.deepEqual(firstBody, Buffer.from(await second.arrayBuffer()));
  const archive = path.join(directory, 'agent-hub.zip');
  await writeFile(archive, firstBody);
  await execute('unzip', ['-t', archive]);
  await execute('unzip', ['-q', archive, '-d', directory]);
  const expected = ['SKILL.md', 'references/workers.md', 'references/tasks.md', 'scripts/bootstrap.sh'];
  const entries = (await execute('unzip', ['-Z1', archive])).stdout.trim().split('\n');
  assert.deepEqual(entries, expected.map((name) => `agent-hub/${name}`));
  for (const name of expected) {
    assert.deepEqual(
      await readFile(path.join(directory, 'agent-hub', name)),
      await readFile(path.join(PROJECT_ROOT, 'skills', 'agent-hub', name)),
    );
  }
  assert.equal((await stat(path.join(directory, 'agent-hub', 'scripts', 'bootstrap.sh'))).mode & 0o111, 0o111);
  await execute('/bin/bash', ['-n', path.join(directory, 'agent-hub', 'scripts', 'bootstrap.sh')]);
  assert.equal((await fetch(`${hub.url}/api/v1/workers`)).status, 401);
  assert.equal((await fetch(`${hub.url}/skill/credentials.json`)).status, 404);
  assert.equal((await fetch(`${hub.url}/skill/../credentials.json`)).status, 404);
  assert.deepEqual(await createSkillArchive(), await readFile(archive));
});

test('downloaded macOS bootstrap completes enrollment and local Skill installation without replacing existing work', { skip: process.platform !== 'darwin', timeout: 90000 }, async (t) => {
  // This test must stop its Connector before deleting the PID file and checkout.
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEST_ROOT, 'skill-bootstrap-'));
  const home = path.join(directory, 'home');
  const repoDir = path.join(directory, 'runtime', 'agent-hub');
  const source = path.join(directory, 'source');
  const mockBin = path.join(directory, 'mock-bin');
  await mkdir(mockBin, { recursive: true });
  await execute('git', ['clone', '--quiet', '--no-hardlinks', PROJECT_ROOT, source]);
  // Bootstrap clones main; a linked worktree clone may expose only its feature branch.
  await execute('git', ['-C', source, 'checkout', '--quiet', '-B', 'main']);
  // This is a bootstrap lifecycle test, not a registry availability test. Reuse
  // the dependency already installed for this suite in the isolated checkout.
  const pnpm = path.join(mockBin, 'pnpm');
  await writeFile(pnpm, `#!/bin/bash
set -eu
[[ "$*" == "install --frozen-lockfile" ]]
mkdir -p node_modules
[[ -e node_modules/ws ]] || ln -s "$AGENT_HUB_TEST_WS_ROOT" node_modules/ws
`);
  await chmod(pnpm, 0o755);
  const hub = await Hub.create({
    host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'hub'),
    credentials: { adminToken: 'test-admin', enrollmentToken: 'test-enroll', generated: [], file: path.join(directory, 'credentials.json') },
    logger: silentLogger,
  });
  await hub.listen();
  const localPort = await unusedPort();
  const launchctl = path.join(mockBin, 'launchctl');
  await writeFile(launchctl, `#!/bin/bash
set -eu
case "$1" in
  bootout)
    if [[ -f "$HOME/connector-test.pid" ]]; then kill "$(cat "$HOME/connector-test.pid")" 2>/dev/null || true; fi
    ;;
  bootstrap)
    nohup node "$AGENT_HUB_REPO_DIR/bin/agent-hub.js" connector --hub-url "$AGENT_HUB_HUB_URL" --name "$AGENT_HUB_NAME" --data-dir "$AGENT_HUB_CONNECTOR_DATA_DIR" --local-port "$AGENT_HUB_LOCAL_PORT" >"$HOME/connector-test.log" 2>&1 &
    echo $! >"$HOME/connector-test.pid"
    ;;
  print)
    printf 'state = running\\npid = 4242\\n'
    ;;
esac
`);
  await chmod(launchctl, 0o755);
  const archive = path.join(directory, 'agent-hub.zip');
  await writeFile(archive, await createSkillArchive());
  await execute('unzip', ['-q', archive, '-d', directory]);
  const script = path.join(directory, 'agent-hub', 'scripts', 'bootstrap.sh');
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${mockBin}:${process.env.PATH}`,
    COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(process.env.HOME, 'Library', 'Caches', 'node', 'corepack'),
    CI: '1',
    AGENT_HUB_HUB_URL: hub.url,
    AGENT_HUB_REPOSITORY_URL: source,
    AGENT_HUB_REPO_DIR: repoDir,
    AGENT_HUB_CONNECTOR_DATA_DIR: path.join(home, '.agent-hub', 'connector'),
    AGENT_HUB_CONNECTOR_URL: `http://127.0.0.1:${localPort}`,
    AGENT_HUB_LOCAL_PORT: String(localPort),
    AGENT_HUB_NAME: 'bootstrap-test-mac',
    AGENT_HUB_AUTO_UPDATE: '0',
    AGENT_HUB_TEST_WS_ROOT: await realpath(path.join(PROJECT_ROOT, 'node_modules', 'ws')),
  };
  delete env.AGENT_HUB_ENROLLMENT_TOKEN;
  const stopConnector = async () => {
    try {
      const pid = Number(await readFile(path.join(home, 'connector-test.pid'), 'utf8'));
      if (pid) {
        process.kill(pid, 'SIGTERM');
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); } catch { return; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        process.kill(pid, 'SIGKILL');
      }
    } catch {}
  };
  t.after(async () => {
    await stopConnector();
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await runBootstrap(script, env, 'test-enroll\n');
  assert.match(first.stdout, /Connector、CLI 与 Skill 已就绪/);
  assert.doesNotMatch(first.stdout + first.stderr, /test-enroll|test-admin/);
  assert.match(await readFile(path.join(home, '.agents', 'skills', 'agent-hub', 'SKILL.md'), 'utf8'), /首次接入一台新 Mac/);
  assert.match(await readFile(path.join(home, '.claude', 'skills', 'agent-hub', 'SKILL.md'), 'utf8'), /首次接入一台新 Mac/);
  const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.agent-hub.connector.plist'), 'utf8');
  assert.doesNotMatch(plist, /test-enroll|test-admin/);
  const health = await (await fetch(`http://127.0.0.1:${localPort}/local/v1/health`)).json();
  assert.equal(health.hub_connected, true);
  assert.equal(hub.store.listConnectors().length, 1);
  assert.equal(hub.store.listWorkers().length, 0);
  const second = await runBootstrap(script, env);
  assert.match(second.stdout, /本机 Connector 已连接 Hub，保留现有服务/);
  assert.equal(hub.store.listConnectors().length, 1);
  await writeFile(path.join(repoDir, 'local-change.txt'), 'do not overwrite');
  await assert.rejects(runBootstrap(script, env, '', 10000), /仓库存在未提交修改/);
  assert.equal(await readFile(path.join(repoDir, 'local-change.txt'), 'utf8'), 'do not overwrite');
});
