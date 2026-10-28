import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  SERVICE_LABEL,
  connectorServiceSpec,
  installConnectorService,
  renderPlist,
  uninstallConnectorService,
} from '../src/service.js';

test('Connector launchd spec keeps Runtime settings and carries no tokens', () => {
  const spec = connectorServiceSpec({
    hubUrl: 'http://100.64.0.2:8787',
    name: 'mac & co',
    dataDir: '/Users/me/.agent-hub/connector',
    localPort: 8790,
    logFile: '/Users/me/.agent-hub/connector.log',
    nodePath: '/opt/node/bin/node',
    rootDir: '/Users/me/agent-hub',
    env: {
      PATH: '/Users/me/.local/bin:/usr/bin',
      HOME: '/Users/me',
      AGENT_HUB_KIMI_MODEL: 'kimi-code/kimi-for-coding',
      AGENT_HUB_CODEX_MODEL: 'gpt-5.5',
      AGENT_HUB_AUTO_UPDATE: '0',
      AGENT_HUB_ENROLLMENT_TOKEN: 'enroll-secret',
      AGENT_HUB_ADMIN_TOKEN: 'admin-secret',
      BAILIAN_TOKEN_PLAN_KEY: 'runtime-secret',
    },
  });
  assert.deepEqual(spec.ProgramArguments, [
    '/opt/node/bin/node', '/Users/me/agent-hub/bin/agent-hub.js', 'connector',
    '--hub-url', 'http://100.64.0.2:8787', '--data-dir', '/Users/me/.agent-hub/connector', '--name', 'mac & co',
    '--local-port', '8790',
  ]);
  assert.equal(spec.EnvironmentVariables.PATH, '/Users/me/.local/bin:/usr/bin');
  assert.equal(spec.EnvironmentVariables.AGENT_HUB_KIMI_MODEL, 'kimi-code/kimi-for-coding');
  assert.equal(spec.EnvironmentVariables.AGENT_HUB_CODEX_MODEL, 'gpt-5.5');
  assert.equal(spec.EnvironmentVariables.AGENT_HUB_AUTO_UPDATE, '0');
  assert.equal(spec.EnvironmentVariables.AGENT_HUB_SUPERVISED, '1');
  assert.equal(spec.KeepAlive, true);
  const plist = renderPlist(spec);
  assert.match(plist, /<string>mac &amp; co<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.doesNotMatch(plist, /secret/);
  assert.throws(() => connectorServiceSpec({ dataDir: '/tmp/x' }), /--hub-url is required/);
});

test('Installing replaces any loaded service and uninstalling removes the plist', async (t) => {
  await mkdir(path.resolve('.test-tmp'), { recursive: true });
  const home = await mkdtemp(path.resolve('.test-tmp', 'service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === 'bootout') throw new Error('not loaded');
    return { stdout: '' };
  };
  const installed = await installConnectorService({
    hubUrl: 'http://hub:8787',
    dataDir: path.join(home, '.agent-hub/connector'),
  }, { exec, home });
  assert.equal(installed.label, SERVICE_LABEL);
  assert.match(await readFile(installed.plist, 'utf8'), /<string>http:\/\/hub:8787<\/string>/);
  assert.deepEqual(calls.map((args) => args[0]), ['bootout', 'bootstrap']);
  assert.equal(calls[1][2], installed.plist);

  await uninstallConnectorService({ exec, home });
  await assert.rejects(stat(installed.plist), { code: 'ENOENT' });
});
