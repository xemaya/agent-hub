import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createTestContext } from './helpers.js';
import { decryptFeishuEvent } from '../src/hub.js';

const APP = 'cli_hooktest';
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function encrypt(value, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
}

test('Feishu webhook: registered token verifies the URL check and events, which the bridge pulls in order', async (t) => {
  const context = await createTestContext(t);
  const url = `${context.hub.url}/hooks/feishu/${APP}`;
  assert.equal((await post(url, { type: 'url_verification', challenge: 'c1', token: 'vt' })).status, 404, 'nothing registered yet');

  const registered = await context.admin(`/api/v1/channel-webhooks/feishu/${APP}`, { method: 'PUT', body: { verification_token: 'vt' } });
  assert.equal(registered.response.status, 200);
  assert.equal(registered.payload.path, `/hooks/feishu/${APP}`);
  assert.equal(registered.payload.encrypted, false);

  const check = await post(url, { type: 'url_verification', challenge: 'c1', token: 'vt' });
  assert.equal(check.status, 200);
  assert.deepEqual(await check.json(), { challenge: 'c1' });
  assert.equal((await post(url, { type: 'url_verification', challenge: 'c1', token: 'nope' })).status, 401);

  const event = (id, text) => ({ schema: '2.0', header: { event_id: id, token: 'vt', event_type: 'im.message.receive_v1', app_id: APP }, event: { message: { message_id: `om_${id}`, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) }, sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' } } });
  assert.deepEqual(await (await post(url, event('e1', 'one'))).json(), { ok: true, stored: true });
  assert.deepEqual(await (await post(url, event('e1', 'one again'))).json(), { ok: true, stored: false }, 'a retry is kept once');
  assert.deepEqual(await (await post(url, event('e2', 'two'))).json(), { ok: true, stored: true });
  assert.equal((await post(url, { ...event('e3', 'x'), header: { ...event('e3', 'x').header, app_id: 'cli_other' } })).status, 400);
  assert.equal((await post(url, { schema: '2.0', header: { token: 'vt', event_type: 'x' }, event: {} })).status, 400, 'no event id');

  const position = await context.admin(`/api/v1/channel-events?channel=feishu&app_id=${APP}`);
  assert.equal(position.payload.cursor, 2);
  assert.deepEqual(position.payload.events, []);
  const pulled = await context.admin(`/api/v1/channel-events?channel=feishu&app_id=${APP}&after=0`);
  assert.deepEqual(pulled.payload.events.map((e) => [e.seq, e.event_id, e.event_type, e.payload.event.message.content]), [[1, 'e1', 'im.message.receive_v1', '{"text":"one"}'], [2, 'e2', 'im.message.receive_v1', '{"text":"two"}']]);
  assert.equal(pulled.payload.cursor, 2);
  const later = await context.admin(`/api/v1/channel-events?channel=feishu&app_id=${APP}&after=2`);
  assert.deepEqual(later.payload, { events: [], cursor: 2 });
  assert.equal((await context.admin('/api/v1/channel-events?channel=feishu&app_id=cli_unknown&after=0')).response.status, 404);
  assert.equal((await fetch(`${context.hub.url}/api/v1/channel-events?channel=feishu&app_id=${APP}&after=0`)).status, 401, 'pulling needs the Admin token');
});

test('Feishu webhook: encrypted events are decrypted with the registered key', async (t) => {
  const context = await createTestContext(t);
  const url = `${context.hub.url}/hooks/feishu/${APP}`;
  await context.admin(`/api/v1/channel-webhooks/feishu/${APP}`, { method: 'PUT', body: { verification_token: 'vt', encrypt_key: 'secret-key' } });
  const check = await post(url, { encrypt: encrypt({ type: 'url_verification', challenge: 'c2', token: 'vt' }, 'secret-key') });
  assert.deepEqual(await check.json(), { challenge: 'c2' });
  const body = { schema: '2.0', header: { event_id: 'e9', token: 'vt', event_type: 'im.message.receive_v1', app_id: APP }, event: { message: { message_id: 'om_9' } } };
  assert.deepEqual(await (await post(url, { encrypt: encrypt(body, 'secret-key') })).json(), { ok: true, stored: true });
  assert.equal((await post(url, { encrypt: encrypt(body, 'other-key') })).status, 400);
  assert.equal((await post(url, { encrypt: 'not base64 at all' })).status, 400);
  const pulled = await context.admin(`/api/v1/channel-events?channel=feishu&app_id=${APP}&after=0`);
  assert.equal(pulled.payload.events[0].payload.event.message.message_id, 'om_9');
  assert.deepEqual(decryptFeishuEvent(encrypt({ a: 1 }, 'k'), 'k'), { a: 1 });
});
