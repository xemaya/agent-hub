import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { FeishuEventSocket, decodeFrame, encodeFrame } from '../src/feishu-events.js';
import { waitFor } from './helpers.js';

test('pbbp2 frames round-trip through the codec', () => {
  const frame = { SeqID: 7n, LogID: 2n ** 40n + 5n, service: 1234, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm1' }], payload: Buffer.from('{"a":1}'), payloadEncoding: null, payloadType: null, LogIDNew: 'x' };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.SeqID, 7n);
  assert.equal(decoded.LogID, 2n ** 40n + 5n);
  assert.equal(decoded.service, 1234);
  assert.equal(decoded.method, 1);
  assert.deepEqual(decoded.headers, frame.headers);
  assert.equal(decoded.payload.toString(), '{"a":1}');
  assert.equal(decoded.LogIDNew, 'x');
  // The SDK encodes service/method as int32; a negative survives.
  assert.equal(decodeFrame(encodeFrame({ SeqID: 0n, LogID: 0n, service: -1, method: 0, headers: [] })).service, -1);
});

// A fake Feishu: the endpoint hands out a WebSocket URL; the server pushes event frames
// (one split in two fragments) and expects each answered with {"code":200}, and answers pings.
async function fakeFeishu(t) {
  const received = []; // frames the client sent back
  const sockets = [];
  const http = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const { AppID, AppSecret } = JSON.parse(body);
      if (AppSecret !== 's3cret') { response.end(JSON.stringify({ code: 10003, msg: 'bad secret' })); return; }
      response.end(JSON.stringify({ code: 0, data: { URL: `ws://127.0.0.1:${http.address().port}/ws?device_id=d1&service_id=42&app=${AppID}`, ClientConfig: { PingInterval: 1, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 } } }));
    });
  });
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      const frame = decodeFrame(Buffer.from(data));
      received.push(frame);
      if (frame.method === 0 && frame.headers.some((h) => h.key === 'type' && h.value === 'ping')) {
        socket.send(encodeFrame({ SeqID: 0n, LogID: 0n, service: 42, method: 0, headers: [{ key: 'type', value: 'pong' }], payload: Buffer.from(JSON.stringify({ PingInterval: 1, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 })) }));
      }
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const s of sockets) s.terminate(); wss.close(); http.close(); });
  const push = (messageId, payload, { sum = 1, seq = 0, logId = 9n } = {}) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const parts = sum === 1 ? [bytes] : [bytes.subarray(0, Math.ceil(bytes.length / 2)), bytes.subarray(Math.ceil(bytes.length / 2))];
    sockets.at(-1).send(encodeFrame({ SeqID: 1n, LogID: logId, service: 42, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: messageId }, { key: 'sum', value: String(sum) }, { key: 'seq', value: String(seq) }, { key: 'trace_id', value: 't' }], payload: parts[seq] }));
  };
  return { http, received, sockets, push, endpoint: () => `http://127.0.0.1:${http.address().port}/callback/ws/endpoint` };
}

test('FeishuEventSocket connects, answers events once each, merges fragments and keeps pinging', async (t) => {
  const feishu = await fakeFeishu(t);
  const events = [];
  const client = new FeishuEventSocket({ appId: 'cli_test', appSecret: 's3cret', endpoint: feishu.endpoint(), logger: { log() {} }, onEvent: async (payload) => { events.push(payload); if (payload.header.event_id === 'boom') throw new Error('handler broke'); } });
  t.after(() => client.stop());
  await client.start();
  await waitFor(() => feishu.sockets.length ? true : null);
  assert.equal(client.config.serviceId, 42);
  const event = (id, text) => ({ schema: '2.0', header: { event_id: id, event_type: 'im.message.receive_v1', app_id: 'cli_test' }, event: { message: { message_id: `om_${id}`, chat_type: 'p2p', content: JSON.stringify({ text }) } } });
  feishu.push('m1', event('e1', 'hello'));
  await waitFor(() => events.length === 1 ? true : null);
  assert.equal(events[0].event.message.content, '{"text":"hello"}');
  const answer = await waitFor(() => feishu.received.find((f) => f.method === 1 && f.headers.some((h) => h.key === 'message_id' && h.value === 'm1')));
  assert.equal(answer.SeqID, 1n);
  assert.equal(answer.service, 42);
  assert.deepEqual(JSON.parse(answer.payload.toString()), { code: 200 });
  assert.ok(answer.headers.some((h) => h.key === 'biz_rt'));

  // Redelivered frame: answered again, handled once.
  feishu.push('m1', event('e1', 'hello'));
  await waitFor(() => feishu.received.filter((f) => f.method === 1 && f.headers.some((h) => h.key === 'message_id' && h.value === 'm1')).length === 2 ? true : null);
  assert.equal(events.length, 1);

  // Two fragments, out of order.
  feishu.push('m2', event('e2', 'long message in two parts'), { sum: 2, seq: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.length, 1, 'half an event is not an event');
  feishu.push('m2', event('e2', 'long message in two parts'), { sum: 2, seq: 0 });
  await waitFor(() => events.length === 2 ? true : null);
  assert.equal(events[1].header.event_id, 'e2');

  // A failing handler answers 500 so Feishu retries later.
  feishu.push('m3', event('boom', 'x'));
  const failed = await waitFor(() => feishu.received.find((f) => f.method === 1 && f.headers.some((h) => h.key === 'message_id' && h.value === 'm3')));
  assert.deepEqual(JSON.parse(failed.payload.toString()), { code: 500 });

  // Pings go out on the configured interval and the pong is read.
  await waitFor(() => feishu.received.some((f) => f.method === 0) ? true : null, { timeout: 4000 });
  assert.equal(client.status().connected, true);
  assert.ok(client.status().lastEventAt);

  // The server drops the connection: the client comes back.
  feishu.sockets.at(-1).close();
  await waitFor(() => feishu.sockets.length === 2 ? true : null, { timeout: 5000 });
  await waitFor(() => client.status().connected ? true : null);
  feishu.push('m4', event('e4', 'after reconnect'));
  await waitFor(() => events.length === 4 ? true : null);
});

test('FeishuEventSocket reports a refused endpoint and keeps retrying', async (t) => {
  const feishu = await fakeFeishu(t);
  const client = new FeishuEventSocket({ appId: 'cli_test', appSecret: 'wrong', endpoint: feishu.endpoint(), logger: { log() {} }, onEvent: async () => {} });
  t.after(() => client.stop());
  await client.start();
  assert.match(client.status().lastError, /code 10003/);
  assert.equal(client.status().connected, false);
  assert.equal(client.attempts, 1);
});
