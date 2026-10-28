import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { KimiSessionManager } from '../src/kimi-session-manager.js';

test('Kimi Session manager creates or reuses native IDs without a prompt execution path', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request);
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/v1/sessions');
      assert.equal(request.headers.authorization, 'Bearer kimi-test');
      assert.equal(JSON.parse(body).metadata.cwd, process.cwd());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { id: 'session_kimi' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const manager = new KimiSessionManager({
    server: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'kimi-test' },
  });
  const prepared = await manager.prepareSession({ cwd: process.cwd() });
  assert.equal(prepared.runtime_session_id, 'session_kimi');
  const resumed = await manager.prepareSession({ runtime_session_id: 'session_existing' });
  assert.equal(resumed.runtime_session_id, 'session_existing');
  assert.equal(requests.length, 1);
  assert.equal(manager.execute, undefined);
});

test('Kimi Session manager closes the temporary server it owns', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  child.kill = () => {
    kills += 1;
    process.nextTick(() => child.emit('close', 0, null));
    return true;
  };
  const manager = new KimiSessionManager({ spawn: () => child });
  const starting = manager.startServer();
  child.stdout.write('Local: http://127.0.0.1:34567\nToken: kimi-test\n');
  const server = await starting;
  assert.equal(server.baseUrl, 'http://127.0.0.1:34567');
  assert.equal(server.owned, true);
  await manager.close();
  assert.equal(kills, 1);
  assert.equal(manager.process, null);
  assert.equal(manager.server, null);
});
