import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Connector } from '../src/connector.js';
import { CodexQueueChannel } from '../src/codex-queue-channel.js';
import { ChannelServer } from '../src/channel.js';
import { run } from '../src/cli.js';
import { createTestContext, waitFor } from './helpers.js';

const identity = worker => ({ runtime: worker.runtime, runtime_session_id: worker.runtime_session_id });
const send = (ctx, sender, recipient, extra = {}) => ctx.local('/local/v1/mail', { method: 'POST', body: {
  ...identity(sender), to_worker_id: recipient.worker_id, client_message_id: 'request-one', subject: 'QA evidence', body: 'Here are the findings.', ...extra,
} });
const folder = (ctx, worker, name = 'inbox', extra = {}) => ctx.local(`/local/v1/mail?${new URLSearchParams({ runtime: worker.runtime, session_id: worker.runtime_session_id, folder: name, ...extra })}`);
const action = (ctx, worker, id, verb) => ctx.local(`/local/v1/mail/${id}/${verb}`, { method: 'POST', body: identity(worker) });

test('Offline mail immediately enters inbox and outbox with a sending receipt, without any Command', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false });
  const accepted = await send(ctx, sender, recipient);
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.payload.receipt.status, 'accepted');
  assert.ok(accepted.payload.receipt.inbox_delivered_at);
  assert.equal(accepted.payload.message.command_id, null);
  assert.equal(accepted.payload.message.read_at, null);
  assert.equal(accepted.payload.message.notification_status, 'pending');
  assert.equal(ctx.hub.store.listCommands().length, 0);
  assert.equal(ctx.hub.workerMessageWaiters.size, 0);
  assert.equal(ctx.connector.activeWorkers.size, 0);
  const inbox = (await folder(ctx, recipient)).payload;
  const outbox = (await folder(ctx, sender, 'outbox')).payload;
  assert.equal(inbox.messages[0].message_id, outbox.messages[0].message_id);
  assert.equal(inbox.messages[0].preview, 'Here are the findings.');
  assert.equal(inbox.messages[0].body, undefined);
  assert.equal(inbox.unread_count, 1);
  const adminRead = await ctx.admin(`/api/v1/mail/${accepted.payload.message.message_id}`);
  assert.equal(adminRead.payload.message.read_at, null, 'Admin inspection must not mark agent mail read');
  const read = await action(ctx, recipient, accepted.payload.message.message_id, 'read');
  assert.equal(read.payload.message.body, 'Here are the findings.');
  assert.ok(read.payload.message.read_at);
  assert.equal((await folder(ctx, recipient)).payload.unread_count, 0);
  assert.equal((await action(ctx, sender, accepted.payload.message.message_id, 'get')).payload.message.read_at, read.payload.message.read_at);
});

test('Mailbox send is idempotent and replies are independent messages in one conversation', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false });
  const first = (await send(ctx, sender, recipient)).payload.message;
  const again = await send(ctx, sender, recipient);
  assert.equal(again.payload.duplicate, true);
  assert.equal(again.payload.message.message_id, first.message_id);
  assert.equal((await send(ctx, sender, recipient, { body: 'different contents' })).response.status, 409);
  const reply = await send(ctx, recipient, sender, { client_message_id: 'reply-one', in_reply_to: first.message_id, body: 'Thanks, test reproduced.' });
  assert.equal(reply.response.status, 202);
  assert.notEqual(reply.payload.message.message_id, first.message_id);
  assert.equal(reply.payload.message.conversation_id, first.conversation_id);
  assert.equal(reply.payload.message.in_reply_to, first.message_id);
  assert.equal((await folder(ctx, sender)).payload.messages[0].message_id, reply.payload.message.message_id);
  assert.equal(ctx.hub.store.listCommands().length, 0);
});

test('Mail permits an optional related command but does not change or depend on its lifecycle', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false });
  const command = ctx.hub.store.createCommand({ worker_id: sender.worker_id, input: 'associated work', push_capable: false });
  const accepted = await send(ctx, sender, recipient, { command_id: command.command_id });
  assert.equal(accepted.response.status, 202);
  assert.equal(ctx.hub.store.getCommand(command.command_id).status, 'waiting_manual');
  await ctx.admin(`/api/v1/commands/${command.command_id}/cancel`, { method: 'POST', body: {} });
  assert.equal(ctx.hub.store.mailbox.get(accepted.payload.message.message_id).body, 'Here are the findings.');
  await ctx.admin('/api/v1/history/clear', { method: 'POST', body: { confirm: true } });
  assert.equal(ctx.hub.store.mailbox.get(accepted.payload.message.message_id).command_id, command.command_id);
  const duplicate = await send(ctx, sender, recipient, { command_id: command.command_id });
  assert.equal(duplicate.payload.duplicate, true);
  const reply = await send(ctx, recipient, sender, { client_message_id: 'after-history-clear', in_reply_to: accepted.payload.message.message_id, command_id: command.command_id });
  assert.equal(reply.response.status, 202, 'Mail replies remain available after associated task history is cleared');
});

test('Mailbox access is participant-scoped, only recipients mark read, and retired or self recipients are rejected', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false });
  const stranger = await ctx.registerWorker({ attach: false });
  const message = (await send(ctx, sender, recipient)).payload.message;
  assert.equal((await action(ctx, stranger, message.message_id, 'get')).response.status, 404);
  assert.equal((await action(ctx, sender, message.message_id, 'read')).payload.message.read_at, null);
  assert.equal((await send(ctx, stranger, sender, { in_reply_to: message.message_id })).response.status, 404);
  assert.equal((await send(ctx, sender, stranger, { client_message_id: 'invalid-reply', in_reply_to: message.message_id })).response.status, 403);
  assert.equal((await send(ctx, sender, sender, { client_message_id: 'self-mail' })).response.status, 400);
  const privateCommand = ctx.hub.store.createCommand({ worker_id: stranger.worker_id, input: 'private context', push_capable: false });
  assert.equal((await send(ctx, sender, recipient, { client_message_id: 'bad-context', command_id: privateCommand.command_id })).response.status, 403);
  await ctx.admin(`/api/v1/workers/${recipient.worker_id}`, { method: 'DELETE' });
  assert.equal((await send(ctx, sender, recipient, { client_message_id: 'after-retirement' })).response.status, 404);
  assert.equal((await send(ctx, sender, recipient)).payload.duplicate, true, 'Retrying a previously accepted envelope must retain its receipt');
});

test('Mailbox pagination and unread filtering survive Hub and Connector restarts', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false });
  for (let i = 0; i < 5; i++) await send(ctx, sender, recipient, { client_message_id: `page-${i}`, body: `mail ${i}` });
  const page = (await folder(ctx, recipient, 'inbox', { limit: '2' })).payload;
  assert.equal(page.messages.length, 2);
  await action(ctx, recipient, page.messages[0].message_id, 'read');
  await ctx.restartHub();
  const next = (await folder(ctx, recipient, 'inbox', { limit: '2', before: String(page.next_cursor) })).payload;
  assert.equal(next.messages.length, 2);
  assert.ok(next.messages.every(message => !page.messages.some(other => other.message_id === message.message_id)));
  assert.equal((await folder(ctx, recipient, 'inbox', { unread: 'true' })).payload.messages.length, 4);
  assert.equal(ctx.hub.store.db.prepare('PRAGMA user_version').get().user_version, 12);
});

test('Mail crosses Connectors with a verified sender and rejects a foreign Session identity', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const peer = await Connector.create({ hubUrl: ctx.hub.url, dataDir: path.join(ctx.root, 'peer-mail'), localPort: 0, name: 'peer', enrollToken: 'test-enroll', logger: { error() {} } });
  await peer.start(); await peer.whenReady(); ctx.onClose(() => peer.close());
  const { worker: recipient } = await peer.request('worker.register', { name: 'peer mail', runtime: 'kimi', runtime_session_id: 'peer-mail-session', cwd: ctx.root });
  assert.equal((await send(ctx, sender, recipient)).response.status, 202);
  const inbox = await peer.request('mail.list', { ...identity(recipient), folder: 'inbox' });
  assert.equal(inbox.messages[0].sender_worker_id, sender.worker_id);
  const spoof = await ctx.local(`/local/v1/mail?${new URLSearchParams({ runtime: recipient.runtime, session_id: recipient.runtime_session_id })}`);
  assert.equal(spoof.response.status, 403);
  assert.equal(ctx.hub.coordinator.list().length, 0);
});

test('A native queue notification has no Command or mandatory business reply; reconnect never replays it', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false, runtime: 'codex', runtime_session_id: 'native-mail' });
  const message = (await send(ctx, sender, recipient)).payload.message;
  const queued = [];
  const channel = new CodexQueueChannel({ connectorUrl: ctx.connector.localUrl, token: ctx.connector.store.credentials.localToken, sessionId: recipient.runtime_session_id,
    dataDir: path.join(ctx.root, 'connector'), retryMs: 10, logger: { error() {} },
    queue: async (...args) => { queued.push(args); return { stdout: 'Queued message native-mail-id for thread native-mail.' }; },
  });
  const running = channel.start(); running.catch(() => {});
  t.after(async () => { channel.stop(); await running.catch(() => {}); });
  await waitFor(() => ctx.hub.store.mailbox.get(message.message_id).notification_status === 'accepted');
  assert.equal(queued.length, 1);
  assert.match(queued[0][1][4], /不调用 desktop report/);
  assert.equal(ctx.hub.store.listCommands().length, 0);
  assert.equal(ctx.hub.store.mailbox.get(message.message_id).read_at, null);
  await ctx.restartConnector({ reuseLocalPort: true });
  await waitFor(() => ctx.hub.store.getWorker(recipient.worker_id).push_capable);
  assert.equal(queued.length, 1);
});

test('An uncertain native notification leaves durable mail and does not kill the command bridge', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false, runtime: 'codex', runtime_session_id: 'mail-failure' });
  const channel = new CodexQueueChannel({ connectorUrl: ctx.connector.localUrl, token: ctx.connector.store.credentials.localToken, sessionId: recipient.runtime_session_id,
    dataDir: path.join(ctx.root, 'connector'), retryMs: 10, logger: { error() {} }, queue: async () => { throw Error('notification timeout'); },
  });
  const running = channel.start(); running.catch(() => {}); t.after(async () => { channel.stop(); await running.catch(() => {}); });
  await waitFor(() => channel.state === 'attached');
  const message = (await send(ctx, sender, recipient)).payload.message;
  await waitFor(() => ctx.hub.store.mailbox.get(message.message_id).notification_status === 'unknown');
  assert.equal(channel.stopped, false);
  assert.equal((await folder(ctx, recipient)).payload.messages[0].message_id, message.message_id);
  assert.equal(ctx.hub.store.listCommands().length, 0);
});

test('Kimi and Claude mail delivery never requires a task report or creates a response command', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const kimi = await ctx.registerWorker({ runtime: 'kimi' });
  const message = (await send(ctx, sender, kimi)).payload.message;
  await waitFor(() => ctx.hub.store.mailbox.get(message.message_id).notification_status === 'accepted');
  assert.equal(ctx.hub.store.listCommands().length, 0);
  const claude = await ctx.registerWorker({ runtime: 'claude', runtime_session_id: 'claude-mail', attach: false });
  const input = new PassThrough(); const output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const channel = new ChannelServer({ connectorUrl: ctx.connector.localUrl, token: ctx.connector.store.credentials.localToken, runtime: 'claude', sessionId: claude.runtime_session_id, input, output, logger: { error() {} }, retryMs: 10 });
  t.after(() => { channel.stop(); input.end(); }); await channel.start();
  await waitFor(() => channel.state === 'attached');
  const next = (await send(ctx, sender, claude, { client_message_id: 'claude-mail' })).payload.message;
  await waitFor(() => ctx.hub.store.mailbox.get(next.message_id).notification_status === 'accepted');
  assert.match(text, /worker_mail/);
  assert.equal(ctx.hub.store.listCommands().length, 0);
});

test('CLI defaults to nonblocking mail and exposes inbox, outbox, read, receipt and independent reply', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ runtime: 'kimi', attach: false });
  const recipient = await ctx.registerWorker({ runtime: 'kimi', attach: false });
  const original = { runtime: process.env.AGENT_HUB_RUNTIME, session: process.env.AGENT_HUB_SESSION_ID, log: console.log, exit: process.exitCode };
  const cli = async (worker, args) => {
    process.env.AGENT_HUB_RUNTIME = worker.runtime; process.env.AGENT_HUB_SESSION_ID = worker.runtime_session_id;
    const output = []; console.log = value => output.push(value);
    try { await run([...args, '--data-dir', path.join(ctx.root, 'connector'), '--connector-url', ctx.connector.localUrl]); return JSON.parse(output.join('\n')); }
    finally { console.log = original.log; }
  };
  t.after(() => { if (original.runtime === undefined) delete process.env.AGENT_HUB_RUNTIME; else process.env.AGENT_HUB_RUNTIME = original.runtime;
    if (original.session === undefined) delete process.env.AGENT_HUB_SESSION_ID; else process.env.AGENT_HUB_SESSION_ID = original.session; process.exitCode = original.exit; });
  const sent = await cli(sender, ['message', 'send', '--to', recipient.worker_id, '--body', 'asynchronous mail']);
  assert.equal(sent.receipt.status, 'accepted'); assert.equal(sent.command, undefined);
  assert.equal((await cli(recipient, ['message', 'inbox'])).messages.length, 1);
  assert.equal((await cli(sender, ['message', 'outbox'])).messages.length, 1);
  await cli(recipient, ['message', 'read', sent.message.message_id]);
  assert.ok((await cli(sender, ['message', 'receipt', sent.message.message_id])).message.read_at);
  const reply = await cli(recipient, ['message', 'reply', sent.message.message_id, '--body', 'independent reply']);
  assert.equal(reply.message.recipient_worker_id, sender.worker_id);
  assert.equal(reply.message.in_reply_to, sent.message.message_id);
  const request = ctx.connector.request.bind(ctx.connector);
  ctx.connector.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === 'mail.send') throw Error('Accepted response was lost');
    return result;
  };
  const args = ['message', 'send', '--to', recipient.worker_id, '--body', 'recover once', '--idempotency-key', 'stable-retry'];
  const uncertain = await cli(sender, args);
  assert.equal(uncertain.receipt.status, 'unknown');
  assert.equal(uncertain.receipt.client_message_id, 'stable-retry');
  ctx.connector.request = request;
  assert.equal((await cli(sender, args)).duplicate, true);
  const rejected = await cli(sender, ['message', 'send', '--to', 'worker-missing', '--body', 'reject explicitly']);
  assert.equal(rejected.receipt.status, 'rejected');
});

test('An older native bridge is not falsely marked notified and a mailbox bridge can later notify the same message', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false, runtime: 'codex', runtime_session_id: 'old-native-mail' });
  const controller = new AbortController();
  t.after(() => controller.abort());
  await fetch(`${ctx.connector.localUrl}/local/v1/channel?runtime=codex&session_id=old-native-mail`, {
    headers: { authorization: `Bearer ${ctx.connector.store.credentials.localToken}` }, signal: controller.signal,
  });
  await waitFor(() => ctx.hub.store.getWorker(recipient.worker_id).push_capable);
  const message = (await send(ctx, sender, recipient)).payload.message;
  await waitFor(() => ctx.hub.store.mailbox.get(message.message_id).notification_status === 'unsupported');
  const queue = [];
  const channel = new CodexQueueChannel({ connectorUrl: ctx.connector.localUrl, token: ctx.connector.store.credentials.localToken, sessionId: recipient.runtime_session_id,
    dataDir: path.join(ctx.root, 'connector'), retryMs: 10, logger: { error() {} },
    queue: async (...args) => { queue.push(args); return { stdout: 'Queued message upgraded for thread old-native-mail.' }; },
  });
  const running = channel.start(); running.catch(() => {}); t.after(async () => { channel.stop(); await running.catch(() => {}); });
  await waitFor(() => ctx.hub.store.mailbox.get(message.message_id).notification_status === 'accepted');
  assert.equal(queue.length, 1);
  assert.equal((await folder(ctx, recipient)).payload.messages.length, 1);
});

test('Schema 11 upgrades retain legacy waiting commands without converting or replaying them as mail', async t => {
  const ctx = await createTestContext(t);
  const sender = await ctx.registerWorker({ attach: false });
  const recipient = await ctx.registerWorker({ attach: false });
  const legacy = await ctx.local('/local/v1/messages', { method: 'POST', body: { ...identity(sender), to_worker_id: recipient.worker_id, prompt: 'legacy pending request' } });
  const id = legacy.payload.command.command_id;
  assert.equal(legacy.payload.command.status, 'waiting_manual');
  ctx.hub.store.db.exec('DROP TABLE worker_mail; PRAGMA user_version=11');
  await ctx.restartHub();
  assert.equal(ctx.hub.store.db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(ctx.hub.store.getCommand(id).status, 'waiting_manual');
  assert.equal(ctx.hub.store.mailbox.list(recipient.worker_id).messages.length, 0);
  assert.equal(ctx.driver.executions.length, 0);
  assert.equal((await send(ctx, sender, recipient)).response.status, 202);
});
