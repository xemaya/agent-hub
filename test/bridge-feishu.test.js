import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestContext, waitFor } from './helpers.js';
import { FeishuBridge, HubAdmin, loadConfig } from '../src/bridge-feishu.js';
import { FeishuApi, idempotencyKey, messageText, readableText } from '../src/feishu-api.js';

const BOT = 'ou_bot';
const OWNER = 'ou_owner';
const OWNER_UNION = 'on_owner'; // the owner's union_id: the same under every app
const OWNER_DM = 'oc_owner_dm';
const FEEDBACK = 'oc_feedback'; // topic-mode group: thread replies appear in the chat listing
const ORDINARY = 'oc_ordinary'; // ordinary group: thread replies do not
const EXTERNAL = 'oc_external';
const PICO = 'cli_pico'; // another bot, as a sender (app_id)
const PICO_OPEN = 'ou_pico'; // the same bot when @'d

// An in-memory Feishu: chats, messages (with threads), sends and replies with
// uuid de-duplication, and a per-call failure switch.
class FakeFeishu {
  constructor() {
    this.chats = [
      { chat_id: FEEDBACK, name: '问题反馈群', external: true },
      { chat_id: ORDINARY, name: '数字员工迭代', external: false },
      { chat_id: OWNER_DM, name: '', external: false },
    ];
    this.messages = []; // { message_id, chat_id, thread_id, listed, create_time, sender, mentions, body, parent_id }
    this.sent = []; // outbound: { kind, target, text, uuid, message_id }
    this.reactions = []; // { message_id, emoji }
    this.failing = new Set();
    this.seq = 0;
    this.clock = 1_700_000_000_000;
    this.tokens = 0;
  }

  id(prefix = 'om') { this.seq += 1; return `${prefix}_${this.seq}`; }

  post(chatId, text, { from = 'ou_colleague', senderType = 'user', mentions = [], threadId = null, listed = true, parentId = null, at = null } = {}) {
    this.clock += 1000;
    const message = {
      message_id: this.id(), chat_id: chatId, thread_id: threadId ?? (chatId === FEEDBACK ? this.id('omt') : null), listed, parent_id: parentId,
      create_time: String(at ?? this.clock), msg_type: 'text', deleted: false,
      sender: { id: from, id_type: 'open_id', sender_type: senderType },
      mentions: mentions.map((id, index) => ({ key: `@_user_${index + 1}`, id, id_type: 'open_id', name: id === BOT ? 'QA机器人' : id === PICO_OPEN ? 'PICO' : id })),
      body: { content: JSON.stringify({ text }) },
    };
    this.messages.push(message);
    return message;
  }

  // The fetch() the bridge's FeishuApi talks to.
  fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (payload, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });
    if (pathname.endsWith('/tenant_access_token/internal')) {
      this.tokens += 1;
      return json({ code: 0, tenant_access_token: `t${this.tokens}`, expire: 7200 });
    }
    if (this.failing.has(pathname) || this.failing.has('*')) return json({ code: 99991400, msg: 'injected failure' });
    if (pathname === '/open-apis/im/v1/chats') return json({ code: 0, data: { items: this.chats, has_more: false } });
    if (pathname === '/open-apis/bot/v3/info') return json({ code: 0, msg: 'ok', bot: { app_name: 'Agent Hub', open_id: BOT, activate_status: 2 } });
    if (pathname === '/open-apis/im/v1/messages' && init.method === 'GET') {
      const type = searchParams.get('container_id_type');
      const container = searchParams.get('container_id');
      let rows;
      if (type === 'chat') {
        const start = Number(searchParams.get('start_time')) * 1000;
        rows = this.messages.filter((m) => m.chat_id === container && m.listed && Number(m.create_time) >= start).sort((a, b) => a.create_time - b.create_time);
      } else {
        rows = this.messages.filter((m) => m.thread_id === container).sort((a, b) => b.create_time - a.create_time);
      }
      return json({ code: 0, data: { items: rows, has_more: false } });
    }
    const one = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(pathname);
    if (one && init.method === 'GET') {
      const message = this.messages.find((m) => m.message_id === one[1]);
      return json({ code: 0, data: { items: message ? [message] : [] } });
    }
    if (body.uuid && body.uuid.length > 50) return json({ code: 99992402, msg: 'field validation failed' });
    const reaction = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions$/.exec(pathname);
    if (reaction && init.method === 'POST') {
      if (this.failing.has('react')) return json({ code: 230099, msg: 'reaction refused' });
      this.reactions.push({ message_id: reaction[1], emoji: body.reaction_type.emoji_type });
      return json({ code: 0, data: { reaction_id: `re_${this.reactions.length}` } });
    }
    const reply = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(pathname);
    if (reply && init.method === 'POST') {
      if (this.failing.has('reply')) return json({ code: 230001, msg: 'reply refused' });
      const existing = this.sent.find((s) => s.uuid && s.uuid === body.uuid);
      if (existing) return json({ code: 0, data: { message_id: existing.message_id } });
      const target = this.messages.find((m) => m.message_id === reply[1]);
      if (!target) return json({ code: 230011, msg: 'no such message' });
      // The first in-thread reply opens the thread; the bot's reply in an ordinary group is not listed with the chat.
      target.thread_id ??= this.id('omt');
      const message = this.post(target.chat_id, JSON.parse(body.content).text, { from: BOT, senderType: 'app', threadId: target.thread_id, listed: target.chat_id === FEEDBACK });
      this.sent.push({ kind: 'reply', target: reply[1], text: JSON.parse(body.content).text, uuid: body.uuid, message_id: message.message_id });
      return json({ code: 0, data: { message_id: message.message_id } });
    }
    if (pathname === '/open-apis/im/v1/messages' && init.method === 'POST') {
      if (this.failing.has('send')) return json({ code: 230002, msg: 'send refused' });
      if (body.receive_id === OWNER_UNION && searchParams.get('receive_id_type') !== 'union_id') return json({ code: 99992361, msg: 'open_id cross app' });
      const chat = [OWNER, OWNER_UNION].includes(body.receive_id) ? OWNER_DM : body.receive_id;
      const existing = this.sent.find((s) => s.uuid && s.uuid === body.uuid);
      if (existing) return json({ code: 0, data: { message_id: existing.message_id, chat_id: chat } });
      const message = this.post(chat, JSON.parse(body.content).text, { from: BOT, senderType: 'app' });
      this.sent.push({ kind: 'send', target: body.receive_id, text: JSON.parse(body.content).text, uuid: body.uuid, message_id: message.message_id });
      return json({ code: 0, data: { message_id: message.message_id, chat_id: chat } });
    }
    return json({ code: 404, msg: `unhandled ${init.method} ${pathname}` }, 404);
  };

  dms() { return this.sent.filter((s) => s.kind === 'send' && [OWNER, OWNER_UNION].includes(s.target)).map((s) => s.text); }
  replies() { return this.sent.filter((s) => s.kind === 'reply'); }
}

function seatDriver() {
  const driver = {
    executions: [],
    answers: {},
    async execute({ worker, command, onState }) {
      driver.executions.push({ worker: worker.name, input: command.input, command_id: command.command_id });
      await onState({ started: true });
      const answer = driver.answers[worker.name];
      const value = typeof answer === 'function' ? answer(command) : answer ?? `done:${worker.name}`;
      return typeof value === 'string' ? { text: value, session_id: worker.runtime_session_id } : { session_id: worker.runtime_session_id, ...value };
    },
    of(name) { return driver.executions.filter((item) => item.worker === name).map((item) => ({ ...item, input: driver.store?.getCommand(item.command_id)?.input ?? item.input })); },
    async close() {},
  };
  return driver;
}

const CONFIG = {
  app_id: 'cli_test', bot_open_id: BOT, role: 'qa',
  owner: { name: '黄海斌', open_id: OWNER, dm_chat: OWNER_DM },
  groups: { [FEEDBACK]: { name: '问题反馈群', policy: 'auto' } },
  default_policy: { internal: 'auto', external: 'confirm' },
  people: { ou_colleague: 'Anya' },
  prompt_hint: '按 AGENTS.md「群里 @ 的跟进」处理。',
};

async function setup(t, { observe = false, config = {}, webhook = null } = {}) {
  const context = await createTestContext(t, { hub: { watchdogIntervalMs: 60 * 60 * 1000 } });
  const driver = seatDriver();
  driver.store = context.hub.store;
  context.driver = driver;
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA', takeover_after_ms: 0 } });
  const feishu = new FakeFeishu();
  const api = new FeishuApi({ appId: 'cli_test', appSecret: 's', fetch: feishu.fetch, now: () => feishu.clock });
  const hub = new HubAdmin({ baseUrl: context.hub.url, token: 'test-admin' });
  const bridge = new FeishuBridge({
    config: loadConfig({ ...CONFIG, ...config }), feishu: api, hub,
    stateFile: path.join(context.root, 'bridge', 'state.json'), observe, now: () => feishu.clock, logger: { log() {}, error() {} }, webhook,
  });
  await bridge.load();
  assert.equal(await bridge.tick(), 0, 'first tick only sets cursors');
  // Time moves on so new messages fall after the cursors.
  feishu.clock += 5000;
  return { context, driver, feishu, bridge };
}

const finished = (context, commandId) => waitFor(() => {
  const command = context.hub.store.getCommand(commandId);
  return ['succeeded', 'failed'].includes(command?.status) ? command : null;
});
const liveTask = (context, threadKey) => context.hub.store.liveTaskByThread(threadKey);

test('message text helpers read text and post messages and name mentions', () => {
  assert.equal(messageText({ msg_type: 'text', body: { content: '{"text":"hi @_user_1"}' } }), 'hi @_user_1');
  assert.equal(readableText({ msg_type: 'text', body: { content: '{"text":"@_user_1 查一下"}' }, mentions: [{ key: '@_user_1', name: 'QA机器人' }] }), '@QA机器人 查一下');
  assert.equal(messageText({ msg_type: 'post', body: { content: '{"zh_cn":{"title":"t","content":[[{"tag":"text","text":"a"},{"tag":"text","text":"b"}]]}}' } }), 'a b');
  assert.equal(messageText({ msg_type: 'image', body: { content: '{}' } }), '');
  assert.equal(messageText({ deleted: true, msg_type: 'text', body: { content: '{"text":"x"}' } }), '');
});

test('loadConfig fills defaults and refuses unknown policies', () => {
  assert.equal(loadConfig({ app_id: 'a', role: 'qa', owner: { open_id: 'ou' } }).ack_reaction, 'OK');
  assert.equal(loadConfig({ app_id: 'a', role: 'qa', owner: { open_id: 'ou' } }).ack, null);
  assert.throws(() => loadConfig({ app_id: 'a', role: 'qa', owner: { open_id: 'ou' }, ack_reaction: 3 }), /ack_reaction/);
  const config = loadConfig(CONFIG);
  assert.equal(config.default_policy.external, 'confirm');
  assert.equal(config.loose_ttl_days, 7);
  assert.throws(() => loadConfig({ ...CONFIG, groups: { x: { policy: 'maybe' } } }), /policy must be/);
  assert.throws(() => loadConfig({ ...CONFIG, role: undefined }), /needs role/);
});

test('Without bot_open_id and dm_chat the bridge discovers both on its first tick', async (t) => {
  const context = await createTestContext(t, { hub: { watchdogIntervalMs: 60 * 60 * 1000 } });
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA', takeover_after_ms: 0 } });
  const driver = seatDriver();
  driver.store = context.hub.store;
  context.driver = driver;
  const feishu = new FakeFeishu();
  const api = new FeishuApi({ appId: 'cli_test', appSecret: 's', fetch: feishu.fetch, now: () => feishu.clock });
  const hub = new HubAdmin({ baseUrl: context.hub.url, token: 'test-admin' });
  const config = loadConfig({ ...CONFIG, bot_open_id: undefined, owner: { name: '黄海斌', open_id: OWNER } });
  assert.equal(config.bot_open_id, undefined);
  const bridge = new FeishuBridge({ config, feishu: api, hub, stateFile: path.join(context.root, 'bridge', 'state.json'), now: () => feishu.clock, logger: { log() {}, error() {} } });
  await bridge.load();
  assert.equal(await bridge.tick(), 0);
  assert.equal(bridge.botId(), BOT);
  assert.equal(bridge.ownerDm(), OWNER_DM, 'the DM chat comes from the hello message');
  assert.match(feishu.dms().at(-1), /飞书桥已上线/);
  assert.ok(bridge.state.cursor[OWNER_DM], 'the owner DM is followed from now');

  // A second bridge with the same state file does not say hello again.
  const again = new FeishuBridge({ config, feishu: api, hub, stateFile: path.join(context.root, 'bridge', 'state.json'), now: () => feishu.clock, logger: { log() {}, error() {} } });
  await again.load();
  feishu.clock += 5000;
  await again.tick();
  assert.equal(feishu.dms().filter((text) => /飞书桥已上线/.test(text)).length, 1);

  // The discovered identity is what makes @ detection and owner replies work.
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(FEEDBACK, '@_user_1 看看这个', { mentions: [BOT] });
  await again.tick();
  assert.ok(liveTask(context, `feishu:${at.thread_id}`), 'the @ on the discovered bot id opened a task');
});

test('An owner named only by union_id is reached by union_id and recognised by their DM chat', async (t) => {
  const context = await createTestContext(t, { hub: { watchdogIntervalMs: 60 * 60 * 1000 } });
  await context.admin('/api/v1/roles/qa', { method: 'PUT', body: { name: 'QA', takeover_after_ms: 0 } });
  const driver = seatDriver();
  driver.store = context.hub.store;
  context.driver = driver;
  const feishu = new FakeFeishu();
  const api = new FeishuApi({ appId: 'cli_test', appSecret: 's', fetch: feishu.fetch, now: () => feishu.clock });
  const hub = new HubAdmin({ baseUrl: context.hub.url, token: 'test-admin' });
  assert.throws(() => loadConfig({ ...CONFIG, bot_open_id: undefined, owner: { name: '黄海斌' } }), /owner.open_id or owner.union_id/);
  const config = loadConfig({ ...CONFIG, bot_open_id: undefined, owner: { name: '黄海斌', union_id: OWNER_UNION } });
  const bridge = new FeishuBridge({ config, feishu: api, hub, stateFile: path.join(context.root, 'bridge', 'state.json'), now: () => feishu.clock, logger: { log() {}, error() {} } });
  await bridge.load();
  assert.equal(await bridge.tick(), 0);
  assert.equal(bridge.ownerDm(), OWNER_DM);
  assert.equal(feishu.sent.at(-1).target, OWNER_UNION, 'the hello went out by union_id');
  assert.equal(bridge.ownerOpenId(), null, 'the open_id is not known until the owner writes');

  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  feishu.clock += 5000;
  feishu.post(OWNER_DM, '看看昨天的日报有没有问题', { from: OWNER });
  await bridge.tick();
  assert.equal(bridge.ownerOpenId(), OWNER, 'learned from the DM');
  assert.equal(bridge.ownerId(), OWNER, 'later messages go to the open_id');
  const task = context.hub.store.listTasks().find((item) => /日报/.test(item.title ?? '') || /日报/.test(item.description ?? ''));
  assert.ok(task, 'a plain DM from the owner is a task for the role');
  assert.ok(bridge.personName(OWNER_UNION) === '黄海斌' && bridge.personName(OWNER) === '黄海斌');
});

test('An @ in a topic group is acked in the thread and opens a Role task with the thread as context', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(FEEDBACK, '@_user_1 为什么搜索不到我的帖子？', { mentions: [BOT] });
  assert.equal(await bridge.tick(), 0);

  assert.deepEqual(feishu.reactions, [{ message_id: at.message_id, emoji: 'OK' }], 'the ack is a reaction on the @');
  assert.deepEqual(feishu.replies(), [], 'nothing is said in the group');
  const task = liveTask(context, `feishu:${at.thread_id}`);
  assert.ok(task, 'the task follows the thread of the @');
  assert.equal(task.role_key, 'qa');
  assert.equal(task.title, '问题反馈群 @：为什么搜索不到我的帖子？');
  const command = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(command.input, /飞书群「问题反馈群」里 Anya @ 了机器人/);
  assert.match(command.input, /回了 OK 表情表示收到，没有说话/);
  assert.match(command.input, /只是通知、抄送或不需要回应的：不要回群，回报 done/);
  assert.match(command.input, /Anya：@QA机器人 为什么搜索不到我的帖子？/, 'the thread excerpt names the sender');
  assert.match(command.input, new RegExp(`"target":"${at.message_id}"`), 'the reply target is the @ message');
  assert.match(command.input, /needs_approval/);
  assert.match(command.input, /按 AGENTS.md「群里 @ 的跟进」处理/);
  assert.deepEqual(feishu.dms(), [], 'a seated task does not bother the owner');
  assert.equal(bridge.state.threads[at.thread_id], at.message_id);
  assert.equal(bridge.state.looseThreads[at.thread_id], undefined, 'topic-group threads are listed with the chat');

  // A second tick does not ack or trigger again.
  await bridge.tick();
  assert.equal(feishu.reactions.length, 1);
  assert.equal(context.hub.store.listTasks().length, 1);

  // An @ inside the followed thread is a follow-up to the same task, not a new one.
  feishu.clock += 2000;
  const again = feishu.post(FEEDBACK, '@_user_1 这个不用查，只是通知', { mentions: [BOT], threadId: at.thread_id });
  await bridge.tick();
  assert.equal(context.hub.store.listTasks().length, 1, 'no second task');
  const followup = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(followup.input, /【跟进】/);
  assert.match(followup.input, /这个不用查，只是通知/);
  assert.deepEqual(feishu.reactions.at(-1), { message_id: again.message_id, emoji: 'OK' }, 'an @ inside the thread gets the reaction too');
  assert.deepEqual(feishu.replies(), []);

  // Someone else's message in the thread without an @ is still forwarded, but not stamped with the reaction.
  feishu.clock += 2000;
  const aside = feishu.post(FEEDBACK, '补充：是昨晚八点开始的', { threadId: at.thread_id });
  await bridge.tick();
  const forwarded = await waitFor(() => driver.of('qa-a')[2]);
  assert.match(forwarded.input, /昨晚八点开始的/);
  assert.equal(feishu.reactions.length, 2, 'no reaction on a thread message that did not @ the bot');
  assert.notEqual(feishu.reactions.at(-1).message_id, aside.message_id);
});

test('With an ack sentence configured the bridge replies it, and the seat is told', async (t) => {
  const { driver, feishu, bridge, context } = await setup(t, { config: { ack: '收到，在查。', ack_reaction: null } });
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(FEEDBACK, '@_user_1 在吗', { mentions: [BOT] });
  await bridge.tick();
  assert.deepEqual(feishu.reactions, []);
  const [ack] = feishu.replies();
  assert.equal(ack.target, at.message_id);
  assert.equal(ack.uuid, `bridge-ack-${at.message_id}`);
  assert.equal(ack.text, '收到，在查。');
  const command = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(command.input, /机器人已自动在话题里回「收到，在查。」/);
});

test('An @ in an ordinary group has no thread until the seat replies; that thread is then followed under the task', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: { groups: { [ORDINARY]: { name: '数字员工迭代', policy: 'auto' } } } });
  driver.answers['qa-a'] = (command) => (/【群里的 @】/.test(command.input)
    ? { text: '查完了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target: /"target":"(om_\d+)"/.exec(command.input)[1], text: '3 条。', key: 'board-count' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(ORDINARY, '@_user_1 看板上待验证的有几条？', { mentions: [BOT] });
  await bridge.tick();
  assert.equal(at.thread_id, null, 'nothing was said, so no thread yet');
  assert.ok(liveTask(context, `feishu:${at.message_id}`), 'the task is keyed by the @ message');
  assert.deepEqual(feishu.reactions, [{ message_id: at.message_id, emoji: 'OK' }]);
  assert.deepEqual(bridge.state.threads, {});
  const first = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(first.input, /这条消息下的话题/);
  await finished(context, first.command_id);

  // The auto group sends the reply; it opens the thread, which the bridge now follows.
  feishu.clock += 2000;
  await bridge.tick();
  feishu.clock += 2000;
  await bridge.tick();
  const sent = feishu.replies().find((r) => r.text === '3 条。');
  assert.ok(sent);
  assert.ok(at.thread_id, 'the reply opened a thread');
  assert.equal(bridge.state.threads[at.thread_id], at.message_id);
  assert.equal(bridge.state.threadKeys[at.thread_id], `feishu:${at.message_id}`);
  assert.ok(bridge.state.looseThreads[at.thread_id], 'ordinary-group threads are polled on their own');

  // A reply inside the thread is not in the chat listing, yet reaches the same task.
  feishu.clock += 2000;
  feishu.post(ORDINARY, '追问：是哪一条？', { threadId: at.thread_id, listed: false });
  await bridge.tick();
  const followup = await waitFor(() => driver.of('qa-a').find((c) => /追问：是哪一条？/.test(c.input)));
  assert.match(followup.input, /【跟进】/);
  assert.equal(context.hub.store.listTasks().length, 1, 'the follow-up went to the existing task');

  // Once the task is done, an @ in that thread is a new request, not a leftover: it opens a
  // second task under the same thread (11-08: Zenas's「已经修正，再查下」right after the seat closed).
  await finished(context, followup.command_id);
  const firstTask = liveTask(context, `feishu:${at.message_id}`).task_id;
  await context.admin(`/api/v1/tasks/${firstTask}`, { method: 'PATCH', body: { status: 'done' } });
  feishu.clock += 2000;
  const again = feishu.post(ORDINARY, '@_user_1 已经修正，再查下最近半小时', { mentions: [BOT], threadId: at.thread_id, listed: false });
  await bridge.tick();
  const reopened = await waitFor(() => driver.of('qa-a').find((c) => /再查下最近半小时/.test(c.input)));
  assert.match(reopened.input, /【群里的 @】/);
  assert.equal(context.hub.store.listTasks().length, 2, 'a second task in the same thread');
  assert.deepEqual(feishu.reactions.at(-1), { message_id: again.message_id, emoji: 'OK' });
  assert.equal(bridge.state.threads[at.thread_id], again.message_id, 'the thread is followed again under the new task');

  // A plain message after the second task is done drops the thread.
  await finished(context, reopened.command_id);
  const secondTask = context.hub.store.listTasks().find((task) => task.task_id !== firstTask).task_id;
  await context.admin(`/api/v1/tasks/${secondTask}`, { method: 'PATCH', body: { status: 'done' } });
  feishu.clock += 2000;
  feishu.post(ORDINARY, '谢谢', { threadId: at.thread_id, listed: false });
  await bridge.tick();
  assert.equal(bridge.state.threads[at.thread_id], undefined);
  assert.equal(bridge.state.threadKeys[at.thread_id], undefined);
  assert.equal(bridge.state.looseThreads[at.thread_id], undefined);
});

test('An @ in an external group without a policy asks the owner first and nothing is said in the group', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  feishu.chats.push({ chat_id: EXTERNAL, name: 'FindU', external: true });
  await bridge.tick(); // the new group gets a cursor at now
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  feishu.clock += 2000;
  const at = feishu.post(EXTERNAL, '@_user_1 能帮我查个订单吗', { mentions: [BOT] });
  await bridge.tick();
  assert.equal(feishu.replies().length, 0);
  assert.equal(context.hub.store.listTasks().length, 0);
  const [ask] = feishu.dms();
  assert.match(ask, /【外部群】FindU里 Anya @ 了机器人/);
  assert.match(ask, /能帮我查个订单吗/);
  assert.equal(Object.keys(bridge.state.confirms).length, 1);

  // The owner quotes the DM and says 查.
  const dm = feishu.messages.find((m) => m.chat_id === OWNER_DM && m.sender.sender_type === 'app');
  feishu.clock += 2000;
  feishu.post(OWNER_DM, '查', { from: OWNER, parentId: dm.message_id });
  await bridge.tick();
  assert.deepEqual(feishu.reactions, [{ message_id: at.message_id, emoji: 'OK' }], 'now the @ gets the reaction');
  assert.ok(liveTask(context, `feishu:${at.message_id}`), 'an ordinary external group has no thread until someone replies');
  await waitFor(() => driver.of('qa-a')[0]);
  assert.deepEqual(bridge.state.confirms, {});
});

const REPLY_CONFIRM = { groups: { [FEEDBACK]: { name: '问题反馈群', policy: 'auto', reply: 'confirm' } } };

test('In an auto group the seat reply goes out without asking; the owner is only told afterwards', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  driver.answers['qa-a'] = (command) => (/【群里的 @】/.test(command.input)
    ? { text: '查完了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target: /"target":"(om_\d+)"/.exec(command.input)[1], text: '@Anya 状态：已修复，回测通过。', key: 'qa-fixed-1103', note: '回 Anya：已修复' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(FEEDBACK, '@_user_1 修了吗', { mentions: [BOT] });
  await bridge.tick();
  const first = await waitFor(() => driver.of('qa-a')[0]);
  await finished(context, first.command_id);
  const attention = await waitFor(() => context.hub.store.openAttentionForTask(liveTask(context, `feishu:${at.thread_id}`).task_id));
  feishu.clock += 2000;
  await bridge.tick();
  await waitFor(() => context.hub.store.getAttention(attention.attention_id).status === 'executed' ? true : null);
  feishu.clock += 2000;
  await bridge.tick();
  const sent = feishu.replies().find((r) => /状态：已修复，回测通过。/.test(r.text));
  assert.ok(sent, 'the reply was sent without an approval round');
  assert.equal(sent.text, '<at user_id="ou_colleague">Anya</at> 状态：已修复，回测通过。', '@name becomes a Feishu mention');
  assert.equal(sent.target, at.message_id);
  assert.equal(sent.uuid, 'bridge-action-qa-fixed-1103');
  assert.equal(context.hub.store.getAttention(attention.attention_id).decided_by, 'bridge:feishu');
  assert.ok(!feishu.dms().some((text) => /【待确认】/.test(text)), 'no draft was DMed');
  assert.match(feishu.dms().at(-1), /已发出（回 Anya：已修复）：消息 om_\d+/);
  assert.deepEqual(bridge.state.approvals, {});
  const notice = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(notice.input, /已获批准并发出/);
});

test('A draft reported as needs_approval reaches the owner, 「发」 sends it and the seat hears the result', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: REPLY_CONFIRM });
  driver.answers['qa-a'] = (command) => (/【群里的 @】/.test(command.input)
    ? { text: '草稿好了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target: /"target":"(om_\d+)"/.exec(command.input)[1], text: '查过了：是缓存，已修。', key: 'qa-cache-1101', note: '回 Anya：缓存问题' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(FEEDBACK, '@_user_1 搜索有问题', { mentions: [BOT] });
  await bridge.tick();
  const first = await waitFor(() => driver.of('qa-a')[0]);
  await finished(context, first.command_id);
  const attention = await waitFor(() => context.hub.store.openAttentionForTask(liveTask(context, `feishu:${at.thread_id}`).task_id));
  assert.equal(attention.outcome, 'needs_approval');

  feishu.clock += 2000;
  await bridge.tick();
  const [draft] = feishu.dms();
  assert.match(draft, /【待确认】回 Anya：缓存问题，feishu 回到话题（消息 om_\d+）/);
  assert.match(draft, /查过了：是缓存，已修。/);
  assert.match(draft, /回「发」就按这个发出去/);
  const draftDm = feishu.messages.find((m) => m.chat_id === OWNER_DM && m.sender.sender_type === 'app');
  assert.equal(bridge.state.approvals[draftDm.message_id], attention.attention_id);
  await bridge.tick();
  assert.equal(feishu.dms().length, 1, 'the draft is DMed once');

  // The owner approves without quoting: it is the only pending decision.
  feishu.clock += 2000;
  feishu.post(OWNER_DM, '发', { from: OWNER });
  await bridge.tick();
  const sent = feishu.replies().find((r) => r.text === '查过了：是缓存，已修。');
  assert.ok(sent, 'the bridge sent the approved text');
  assert.equal(sent.target, at.message_id);
  assert.equal(sent.uuid, 'bridge-action-qa-cache-1101');
  const settled = context.hub.store.getAttention(attention.attention_id);
  assert.equal(settled.status, 'executed');
  assert.equal(settled.execution.message_id, sent.message_id);
  assert.equal(settled.decided_by, '黄海斌');
  assert.match(feishu.dms().at(-1), /已发出（回 Anya：缓存问题）：消息 om_\d+/);
  const notice = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(notice.input, /已获批准并发出/);
  assert.deepEqual(bridge.state.approvals, {});

  // Replaying the approval event never sends twice.
  bridge.state.eventCursor = null;
  const before = feishu.replies().length;
  await bridge.tick();
  assert.equal(feishu.replies().length, before);
});

test('Two bridges on one Hub: each takes only its own Role\'s approvals, so a reply is never sent twice', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: { ...REPLY_CONFIRM, other_roles: ['hb-agent'] } });
  // A second app's bridge serving another Role, on the same Hub.
  const otherFeishu = new FakeFeishu();
  const other = new FeishuBridge({
    config: loadConfig({ ...CONFIG, ...REPLY_CONFIRM, app_id: 'cli_other', role: 'hb-agent', own_role_only: true }),
    feishu: new FeishuApi({ appId: 'cli_other', appSecret: 's', fetch: otherFeishu.fetch, now: () => otherFeishu.clock }),
    hub: new HubAdmin({ baseUrl: context.hub.url, token: 'test-admin' }),
    stateFile: path.join(context.root, 'bridge-other', 'state.json'), now: () => otherFeishu.clock, logger: { log() {}, error() {} },
  });
  await other.load();
  await other.tick();
  driver.answers['qa-a'] = (command) => (/【群里的 @】/.test(command.input)
    ? { text: '草稿好了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target: /"target":"(om_\d+)"/.exec(command.input)[1], text: '查过了：是缓存，已修。', key: 'qa-two-bridges' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const at = feishu.post(FEEDBACK, '@_user_1 搜索有问题', { mentions: [BOT] });
  await bridge.tick();
  const first = await waitFor(() => driver.of('qa-a')[0]);
  await finished(context, first.command_id);
  const attention = await waitFor(() => context.hub.store.openAttentionForTask(liveTask(context, `feishu:${at.thread_id}`).task_id));
  assert.equal(attention.role_key, 'qa');

  otherFeishu.clock += 2000;
  await other.tick();
  assert.ok(!otherFeishu.dms().some((text) => /【待确认】/.test(text)), 'the other Role\'s bridge leaves the draft alone');
  assert.deepEqual(other.state.approvals, {});

  feishu.clock += 2000;
  await bridge.tick();
  assert.equal(feishu.dms().filter((text) => /【待确认】/.test(text)).length, 1, 'the owning bridge DMs the draft');

  feishu.clock += 2000;
  feishu.post(OWNER_DM, '发', { from: OWNER });
  await bridge.tick();
  otherFeishu.clock += 2000;
  await other.tick();
  assert.equal(feishu.replies().filter((r) => r.text === '查过了：是缓存，已修。').length, 1);
  assert.equal(otherFeishu.replies().length, 0, 'the other bot sends nothing');
});

test('A DM from someone else, pushed by Feishu to the Hub, opens a Role task; the reply goes back to that DM without approval', async (t) => {
  // Feishu never lists DM chats, so without pushed events Anya's DM to the bot went unseen (11-11).
  const { context, driver, feishu, bridge } = await setup(t, {
    config: { dm_from_anyone: true, events: { verification_token_file: 'token' } },
    webhook: { verificationToken: 'vt-test' },
  });
  driver.answers['qa-a'] = (command) => (/【私信】/.test(command.input)
    ? { text: '查完了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'send', target: /"target":"(oc_[^"]+)"/.exec(command.input)[1], text: '状态：已修复。', key: 'dm-anya-1', note: '回 Anya：已修复' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  await bridge.tick(); // registers the webhook with the Hub
  const push = async (event, { token = 'vt-test', id } = {}) => fetch(`${context.hub.url}/hooks/feishu/cli_test`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema: '2.0', header: { event_id: id, token, create_time: String(feishu.clock), event_type: 'im.message.receive_v1', tenant_key: 't', app_id: 'cli_test' }, event }),
  });
  const dmEvent = (text, { from = 'ou_colleague', chat = 'oc_dm_anya', chatType = 'p2p', mid } = {}) => ({
    sender: { sender_id: { open_id: from, union_id: `on_${from}`, user_id: 'u' }, sender_type: 'user', tenant_key: 't' },
    message: { message_id: mid, chat_id: chat, chat_type: chatType, message_type: 'text', content: JSON.stringify({ text }), create_time: String(feishu.clock), mentions: [] },
  });
  feishu.messages.push({ message_id: 'om_dm1', chat_id: 'oc_dm_anya', listed: false, create_time: String(feishu.clock), msg_type: 'text', sender: { id: 'ou_colleague', sender_type: 'user' }, body: { content: '{"text":"T32 修了吗"}' } });
  assert.equal((await push(dmEvent('T32 修了吗', { mid: 'om_dm1' }), { id: 'evt_1' })).status, 200);
  assert.equal((await push(dmEvent('看错了', { mid: 'om_dm1' }), { id: 'evt_1' })).status, 200, 'a retried event is accepted and kept once');
  assert.equal((await push(dmEvent('群消息', { chat: FEEDBACK, chatType: 'group', mid: 'om_g1' }), { id: 'evt_2' })).status, 200);
  assert.equal((await push(dmEvent('假的', { mid: 'om_dm2' }), { id: 'evt_3', token: 'wrong' })).status, 401);
  feishu.clock += 2000;
  await bridge.tick();
  assert.deepEqual(feishu.reactions.filter((r) => r.message_id === 'om_dm1').map((r) => r.emoji), ['OK'], 'the DM is acked once');
  const task = liveTask(context, 'feishu-dm:oc_dm_anya');
  assert.ok(task, 'the DM chat is the thread of a qa task');
  assert.equal(task.role_key, 'qa');
  assert.match(task.title, /^Anya私信：T32 修了吗/);
  assert.equal(liveTask(context, `feishu:${FEEDBACK}`), null, 'group traffic in events is left to polling');
  const first = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(first.input, /【私信】Anya 在飞书私信里对机器人说（消息 om_dm1）：「T32 修了吗」/);
  assert.match(first.input, /"kind":"send","target":"oc_dm_anya"/);
  await finished(context, first.command_id);
  const attention = await waitFor(() => context.hub.store.openAttentionForTask(task.task_id));
  feishu.clock += 2000;
  await bridge.tick();
  await waitFor(() => context.hub.store.getAttention(attention.attention_id).status === 'executed' ? true : null);
  const sent = feishu.sent.find((s) => s.kind === 'send' && s.target === 'oc_dm_anya');
  assert.ok(sent, 'the reply went to the DM chat without an approval round');
  assert.equal(sent.text, '状态：已修复。');
  assert.match(feishu.dms().at(-1), /已发出（回 Anya：已修复）：消息 om_\d+/);
  assert.equal(bridge.status().dmChats, 1);
  assert.equal(bridge.status().channelCursor, 2);

  // What Anya says next in the DM follows the same task.
  feishu.clock += 2000;
  feishu.messages.push({ message_id: 'om_dm3', chat_id: 'oc_dm_anya', listed: false, create_time: String(feishu.clock), msg_type: 'text', sender: { id: 'ou_colleague', sender_type: 'user' }, body: { content: '{"text":"谢谢"}' } });
  assert.equal((await push(dmEvent('谢谢', { mid: 'om_dm3' }), { id: 'evt_4' })).status, 200);
  await bridge.tick();
  assert.equal(bridge.state.handled.om_dm3.routed, 'followup');
  assert.equal(bridge.state.handled.om_dm3.task, task.task_id);
});

test('Without dm_from_anyone other people\'s DMs in pushed events are ignored, and the owner\'s DM stays polled', async (t) => {
  const { context, feishu, bridge } = await setup(t, { config: { events: { verification_token_file: 'token' } }, webhook: { verificationToken: 'vt-test' } });
  await bridge.tick();
  const push = (event, id) => fetch(`${context.hub.url}/hooks/feishu/cli_test`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema: '2.0', header: { event_id: id, token: 'vt-test', event_type: 'im.message.receive_v1', app_id: 'cli_test' }, event }),
  });
  await push({ sender: { sender_id: { open_id: 'ou_colleague' }, sender_type: 'user' }, message: { message_id: 'om_x1', chat_id: 'oc_dm_anya', chat_type: 'p2p', message_type: 'text', content: '{"text":"在吗"}', create_time: String(feishu.clock) } }, 'evt_1');
  await push({ sender: { sender_id: { open_id: OWNER }, sender_type: 'user' }, message: { message_id: 'om_x2', chat_id: OWNER_DM, chat_type: 'p2p', message_type: 'text', content: '{"text":"自己人"}', create_time: String(feishu.clock) } }, 'evt_2');
  feishu.clock += 2000;
  await bridge.tick();
  assert.equal(feishu.reactions.length, 0);
  assert.equal(liveTask(context, 'feishu-dm:oc_dm_anya'), null);
  assert.equal(liveTask(context, `feishu-dm:om_x2`), null, 'the owner event alone opens nothing; polling owns that chat');
  assert.equal(bridge.status().channelCursor, 2, 'the events were consumed');
});

test('dm_from_anyone needs events', () => {
  assert.throws(() => loadConfig({ ...CONFIG, dm_from_anyone: true }), /needs events/);
});

test('other_roles cannot name the bridge\'s own role', () => {
  assert.throws(() => loadConfig({ ...CONFIG, other_roles: ['qa'] }), /must not name this bridge's own role/);
  assert.throws(() => loadConfig({ ...CONFIG, other_roles: 'hb-agent' }), /must be a list/);
});

test('Feedback instead of 「发」 goes back to the seat; several pending decisions need a quote', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: REPLY_CONFIRM });
  const drafts = [];
  driver.answers['qa-a'] = (command) => {
    if (!/【群里的 @】/.test(command.input)) return 'done:qa-a';
    const target = /"target":"(om_\d+)"/.exec(command.input)[1];
    drafts.push(target);
    return { text: '草稿', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target, text: `回复 ${target}` } };
  };
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const a = feishu.post(FEEDBACK, '@_user_1 问题一', { mentions: [BOT] });
  await bridge.tick();
  await finished(context, (await waitFor(() => driver.of('qa-a')[0])).command_id);
  feishu.clock += 2000;
  const b = feishu.post(FEEDBACK, '@_user_1 问题二', { mentions: [BOT] });
  await bridge.tick();
  await finished(context, (await waitFor(() => driver.of('qa-a')[1])).command_id);
  feishu.clock += 2000;
  await bridge.tick();
  assert.equal(Object.keys(bridge.state.approvals).length, 2);
  assert.ok(a && b);

  feishu.clock += 2000;
  feishu.post(OWNER_DM, '发', { from: OWNER });
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /有 2 条在等你决定，请引用/);
  assert.equal(feishu.replies().length, 0, 'nothing went out to the group');

  const draftDms = feishu.messages.filter((m) => m.chat_id === OWNER_DM && /【待确认】/.test(messageText(m)));
  feishu.clock += 2000;
  feishu.post(OWNER_DM, '太啰嗦，两句话', { from: OWNER, parentId: draftDms[0].message_id });
  await bridge.tick();
  const revise = await waitFor(() => driver.of('qa-a')[2]);
  assert.match(revise.input, /没有被批准/);
  assert.match(revise.input, /太啰嗦，两句话/);
  assert.equal(Object.keys(bridge.state.approvals).length, 1);
  assert.match(feishu.dms().at(-1), /已把你的意见发回/);
});

test('A question from a seat is DMed and the quoted reply answers it; a message to the owner needs no approval', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  driver.answers['qa-a'] = (command) => {
    // The Channel wraps every command in the task's context, so the answer is matched first.
    if (/问题：查 staging 还是 prod？/.test(command.input)) return { text: '查完了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'send', target: OWNER, text: 'prod 上有 3 条待验证。' } };
    if (/【跟进】黄海斌 在飞书私信里/.test(command.input)) return { text: '要问', outcome: 'needs_input', question: '查 staging 还是 prod？' };
    return 'done:qa-a';
  };
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  const ask = feishu.post(OWNER_DM, '看板上有几条待验证？', { from: OWNER });
  await bridge.tick();
  assert.ok(liveTask(context, `feishu-dm:${ask.message_id}`), 'an owner DM is a task of its own');
  assert.deepEqual(feishu.reactions, [{ message_id: ask.message_id, emoji: 'OK' }], 'the owner DM gets the reaction');
  const first = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(first.input, /"kind":"send","target":"ou_owner"/);
  await finished(context, first.command_id);
  feishu.clock += 2000;
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /【需要你回答】qa-a在任务「黄海斌私信：看板上有几条待验证？」里问：\n查 staging 还是 prod？/);
  const questionDm = feishu.messages.filter((m) => m.chat_id === OWNER_DM && m.sender.sender_type === 'app').at(-1);
  assert.equal(Object.values(bridge.state.questions)[0], context.hub.store.listAttentions({ status: 'open' })[0].attention_id);

  feishu.clock += 2000;
  feishu.post(OWNER_DM, 'prod', { from: OWNER, parentId: questionDm.message_id });
  await bridge.tick();
  const second = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(second.input, /回答：prod/);
  await finished(context, second.command_id);
  await waitFor(() => context.hub.store.listAttentions({ status: 'open' }).length === 1);
  assert.deepEqual(bridge.state.questions, {});

  // The result addressed to the owner is auto-approved and sent by the bridge.
  feishu.clock += 2000;
  await bridge.tick();
  assert.ok(feishu.dms().includes('prod 上有 3 条待验证。'));
  assert.equal(context.hub.store.listAttentions({ status: 'executed' }).length, 1);
  assert.ok(!feishu.dms().some((text) => /【待确认】/.test(text)), 'no approval DM for a message to the approver');
  assert.equal(context.hub.store.listTasks().length, 1, 'the owner\'s reply was an answer, not a new task');
});

test('No seat: the owner is told, and told differently when seats are merely busy', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  feishu.post(FEEDBACK, '@_user_1 没人在', { mentions: [BOT] });
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /没有可用的会话/);
  const release = (() => { let r; const p = new Promise((resolve) => { r = resolve; }); driver.answers['qa-a'] = () => p.then(() => 'done:qa-a'); return r; })();
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  await waitFor(() => driver.of('qa-a')[0]);
  feishu.clock += 2000;
  feishu.post(FEEDBACK, '@_user_1 都在忙', { mentions: [BOT] });
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /都在忙/);
  release();
});

test('Groups: a new group starts at the previous tick, a left group loses its cursor, one failing group does not stop the rest', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  feishu.chats.push({ chat_id: 'oc_new', name: '新群', external: false });
  feishu.post('oc_new', '@_user_1 历史消息', { mentions: [BOT], at: feishu.clock - 60_000 });
  const fresh = feishu.post('oc_new', '@_user_1 刚拉进群就问', { mentions: [BOT], at: feishu.clock - 2000 });
  await bridge.tick();
  assert.equal(feishu.reactions.length, 1, 'history before joining is not replayed, but an @ since the last tick is');
  assert.equal(feishu.reactions[0].message_id, fresh.message_id);
  assert.ok(bridge.state.cursor.oc_new);

  feishu.chats = feishu.chats.filter((chat) => chat.chat_id !== ORDINARY);
  await bridge.tick();
  assert.equal(bridge.state.cursor[ORDINARY], undefined);

  feishu.failing.add('/open-apis/im/v1/messages');
  feishu.clock += 2000;
  feishu.post(FEEDBACK, '@_user_1 失败期间', { mentions: [BOT] });
  const before = bridge.state.cursor[FEEDBACK];
  assert.equal(await bridge.tick(), 1);
  assert.equal(bridge.state.cursor[FEEDBACK], before, 'a failed group keeps its cursor');
  feishu.failing.clear();
  assert.equal(await bridge.tick(), 0);
  assert.equal(feishu.reactions.length, 2, 'the message is handled once the group works again');
  await waitFor(() => driver.of('qa-a')[1]);
});

test('When the chat list fails the known groups are still read', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  feishu.failing.add('/open-apis/im/v1/chats');
  feishu.post(FEEDBACK, '@_user_1 群列表挂了', { mentions: [BOT] });
  assert.equal(await bridge.tick(), 1);
  assert.equal(feishu.reactions.length, 1);
  await waitFor(() => driver.of('qa-a')[0]);
});

test('Observe mode advances cursors but never acks, triggers, DMs or sends', async (t) => {
  const { context, feishu, bridge } = await setup(t, { observe: true });
  feishu.post(FEEDBACK, '@_user_1 只看不动', { mentions: [BOT] });
  feishu.post(OWNER_DM, '随便说点什么', { from: OWNER });
  assert.equal(await bridge.tick(), 0);
  assert.equal(feishu.sent.length, 0);
  assert.equal(context.hub.store.listTasks().length, 0);
  assert.equal(Object.keys(bridge.state.handled).length, 2);
});

test('A send that fails is reported to the Hub as failed and the owner is told', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  driver.answers['qa-a'] = (command) => (/【群里的 @】/.test(command.input)
    ? { text: '草稿', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target: /"target":"(om_\d+)"/.exec(command.input)[1], text: '回复' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  feishu.post(FEEDBACK, '@_user_1 x', { mentions: [BOT] });
  await bridge.tick();
  await finished(context, (await waitFor(() => driver.of('qa-a')[0])).command_id);
  feishu.failing.add('reply'); // the auto group approves by itself; the send is what fails
  feishu.clock += 2000;
  await bridge.tick();
  feishu.clock += 2000;
  await bridge.tick();
  assert.equal(context.hub.store.listAttentions({ status: 'failed' }).length, 1);
  assert.match(feishu.dms().at(-1), /没发出去/);
  const notice = await waitFor(() => driver.of('qa-a')[1]);
  assert.match(notice.input, /渠道发送失败/);
});

test('Exhausted handoffs and long outages are reported to the owner once', async (t) => {
  const { context, feishu, bridge } = await setup(t);
  context.hub.emit('handoff.exhausted', { type: 'hub', id: 'roles' }, { task_id: 'task_x', payload: { role_key: 'qa', limit: 3 } });
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /交接了 3 次都没做完/);

  feishu.failing.add('*');
  feishu.clock += 11 * 60 * 1000;
  await bridge.tick();
  feishu.failing.clear();
  feishu.failing.add('/open-apis/im/v1/chats'); // partial failure keeps the tick incomplete, but DMs work
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /飞书桥已经 \d+ 分钟没有完整跑通一轮/);
  const count = feishu.dms().length;
  feishu.clock += 60 * 1000;
  await bridge.tick();
  assert.equal(feishu.dms().length, count, 'alerted once until a full tick succeeds');
});

test('A message uuid longer than Feishu allows is shortened deterministically', () => {
  const long = `bridge-question-attn_${'0'.repeat(32)}`;
  assert.equal(long.length, 53);
  const key = idempotencyKey(long);
  assert.ok(key.length <= 50, key);
  assert.equal(key, idempotencyKey(long), 'stable');
  assert.notEqual(key, idempotencyKey(`${long}x`));
  assert.equal(idempotencyKey('short'), 'short');
  assert.equal(idempotencyKey(undefined), undefined);
});

test('A question from a seat with a long attention id still reaches the owner', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t);
  driver.answers['qa-a'] = { text: '卡住', outcome: 'blocked', question: '工具定义是旧的，要重开吗？' };
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  feishu.post(FEEDBACK, '@_user_1 看一下', { mentions: [BOT] });
  await bridge.tick();
  await finished(context, (await waitFor(() => driver.of('qa-a')[0])).command_id);
  feishu.clock += 2000;
  assert.equal(await bridge.tick(), 0, 'the DM went out');
  assert.match(feishu.dms().at(-1), /【卡住了】.*工具定义是旧的/s);
  assert.ok(feishu.sent.every((s) => !s.uuid || s.uuid.length <= 50));
});

test('A Hub event whose handling keeps failing is skipped after a few ticks instead of blocking later events', async (t) => {
  const { context, feishu, bridge } = await setup(t);
  feishu.failing.add('send');
  context.hub.emit('handoff.exhausted', { type: 'hub', id: 'roles' }, { task_id: 'task_bad', payload: { role_key: 'qa', limit: 3 } });
  const before = bridge.state.eventCursor;
  for (let i = 0; i < 2; i += 1) { feishu.clock += 60_000; await bridge.tick(); }
  assert.equal(bridge.state.eventCursor, before, 'still retrying');
  feishu.clock += 60_000;
  await bridge.tick(); // sixth attempt: give up
  assert.notEqual(bridge.state.eventCursor, before, 'skipped');
  assert.deepEqual(bridge.state.eventFailures, {});
  feishu.failing.clear();
  context.hub.emit('handoff.exhausted', { type: 'hub', id: 'roles' }, { task_id: 'task_next', payload: { role_key: 'qa', limit: 3 } });
  feishu.clock += 60_000;
  await bridge.tick();
  assert.match(feishu.dms().at(-1), /task_next/);
});

test('Only bots listed in `bots` can @ the seat; the loop guard caps their turns; our own messages are never work', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: { bots: { [PICO]: 'PICO' }, people: { ou_colleague: 'Anya', [PICO_OPEN]: 'PICO' }, bot_thread_per_hour: 2, bot_per_hour: 3 } });
  driver.answers['qa-a'] = (command) => (/【群里的 @】/.test(command.input)
    ? { text: '回了', outcome: 'needs_approval', action: { channel: 'feishu', kind: 'reply', target: /"target":"(om_\d+)"/.exec(command.input)[1], text: '@PICO 收到。', key: 'pico-1' } }
    : 'done:qa-a');
  await context.registerWorker({ name: 'qa-a', role: 'qa' });

  // An unlisted bot and our own app are ignored outright.
  feishu.post(FEEDBACK, '@_user_1 我是别的机器人', { from: 'cli_stranger', senderType: 'app', mentions: [BOT] });
  feishu.post(FEEDBACK, '@_user_1 我是我自己', { from: 'cli_test', senderType: 'app', mentions: [BOT] });
  await bridge.tick();
  assert.equal(context.hub.store.listTasks().length, 0);
  assert.deepEqual(feishu.reactions, []);

  // A listed bot opens a task; the seat is told it is a bot; @PICO in the reply becomes a mention.
  const at = feishu.post(FEEDBACK, '@_user_1 请回复一句收到', { from: PICO, senderType: 'app', mentions: [BOT] });
  await bridge.tick();
  assert.equal(context.hub.store.listTasks().length, 1);
  assert.deepEqual(feishu.reactions, [{ message_id: at.message_id, emoji: 'OK' }]);
  const first = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(first.input, /机器人 PICO @ 了机器人/);
  assert.match(first.input, /不是真人/);
  await finished(context, first.command_id);
  feishu.clock += 2000;
  await bridge.tick();
  feishu.clock += 2000;
  await bridge.tick();
  const sent = feishu.replies().find((r) => /收到。/.test(r.text));
  assert.equal(sent.text, '<at user_id="ou_pico">PICO</at> 收到。');

  // The bot answers in the thread: forwarded once more, then capped (2 per thread per hour).
  feishu.clock += 2000;
  feishu.post(FEEDBACK, '谢谢，再确认一下', { from: PICO, senderType: 'app', threadId: at.thread_id });
  await bridge.tick();
  const followup = await waitFor(() => driver.of('qa-a').find((c) => /再确认一下/.test(c.input)));
  assert.match(followup.input, /来自机器人 PICO/);
  feishu.clock += 2000;
  const capped = feishu.post(FEEDBACK, '好的收到', { from: PICO, senderType: 'app', threadId: at.thread_id });
  await bridge.tick();
  assert.equal(bridge.state.handled[capped.message_id].state, 'bot-limited');
  assert.equal(driver.of('qa-a').filter((c) => /好的收到/.test(c.input)).length, 0);

  // A person in the same thread is not affected by the bot budget.
  feishu.clock += 2000;
  feishu.post(FEEDBACK, '人类追问', { threadId: at.thread_id });
  await bridge.tick();
  await waitFor(() => driver.of('qa-a').find((c) => /人类追问/.test(c.input)));

  // An hour later the bot may speak again.
  feishu.clock += 3600 * 1000;
  const later = feishu.post(FEEDBACK, '一小时后', { from: PICO, senderType: 'app', threadId: at.thread_id });
  await bridge.tick();
  assert.equal(bridge.state.handled[later.message_id].state, 'followup');
});

test('An @ inside a thread someone else opened in an ordinary group is found by the thread scan', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: { groups: { [ORDINARY]: { name: '数字员工迭代', policy: 'auto' } }, thread_scan_interval_s: 300 } });
  await context.registerWorker({ name: 'qa-a', role: 'qa' });
  // A colleague's root message gets replies: Feishu then shows the thread on the root, but
  // the replies themselves never appear in the chat listing.
  const root = feishu.post(ORDINARY, '看板上的任务谁在做？');
  root.thread_id = 'omt_theirs';
  feishu.clock += 2000;
  feishu.post(ORDINARY, '我在做', { threadId: 'omt_theirs', listed: false });
  await bridge.tick();
  assert.equal(context.hub.store.listTasks().length, 0);
  assert.ok(bridge.state.knownThreads.omt_theirs, 'the first tick scans and notes the thread');

  feishu.clock += 2000;
  const at = feishu.post(ORDINARY, '@_user_1 这条你复测一下', { mentions: [BOT], threadId: 'omt_theirs', listed: false });
  await bridge.tick();
  assert.equal(context.hub.store.listTasks().length, 1, 'the @ inside the thread opened a task');
  assert.ok(liveTask(context, 'feishu:omt_theirs'));
  assert.deepEqual(feishu.reactions, [{ message_id: at.message_id, emoji: 'OK' }]);
  const first = await waitFor(() => driver.of('qa-a')[0]);
  assert.match(first.input, /话题 omt_theirs/);
  assert.match(first.input, /看板上的任务谁在做？/, 'the thread excerpt includes the root');

  // Later replies in that thread are follow-ups of the same task.
  feishu.clock += 2000;
  feishu.post(ORDINARY, '补充：是昨天上线的那条', { threadId: 'omt_theirs', listed: false });
  await bridge.tick();
  await waitFor(() => driver.of('qa-a').find((c) => /补充：是昨天上线的那条/.test(c.input)));
  assert.equal(context.hub.store.listTasks().length, 1);

  // Old threads age out of the scan; the cap keeps only the most recent per group.
  for (let i = 0; i < 25; i += 1) {
    const r = feishu.post(ORDINARY, `话题 ${i}`);
    r.thread_id = `omt_many_${i}`;
    feishu.clock += 1000;
  }
  feishu.clock += 301 * 1000;
  await bridge.tick();
  assert.ok(Object.keys(bridge.state.knownThreads).length <= 21);
  assert.equal(bridge.state.knownThreads.omt_many_0, undefined, 'the oldest idle thread fell off the cap');
  assert.ok(bridge.state.knownThreads.omt_theirs, 'a thread with our live task stays polled');
});

test('With alert_role set, a bridge that starts over existing state tells that Role it was restarted; a first run and a bridge without alert_role say nothing', async (t) => {
  const { context, driver, feishu, bridge } = await setup(t, { config: { alert_role: 'ops' } });
  await context.registerWorker({ name: 'ops-a', role: 'ops', runtime_session_id: 'ops-window' });
  assert.throws(() => loadConfig({ ...CONFIG, alert_role: '' }), /alert_role/);
  await bridge.tick();
  assert.equal(driver.of('ops-a').length, 0, 'the process that created the state is a start, not a restart');

  feishu.clock += 10 * 60 * 1000;
  const again = new FeishuBridge({ config: bridge.config, feishu: bridge.feishu, hub: bridge.hub, stateFile: bridge.stateFile, now: () => feishu.clock, logger: { log() {}, error() {} } });
  await again.load();
  await again.tick();
  await waitFor(() => driver.of('ops-a').length === 1);
  const alert = driver.of('ops-a')[0];
  assert.match(alert.input, /【桥告警】岗位「qa」的飞书桥进程刚启动/);
  assert.match(alert.input, /距上次成功轮询 10 分钟/);
  const task = context.hub.store.getTask(context.hub.store.getCommand(alert.command_id).task_id);
  assert.equal(task.role_key, 'ops');
  assert.equal(task.thread_key, 'bridge-alert:qa');
  await again.tick();
  assert.equal(driver.of('ops-a').length, 1, 'one alert per process start');

  const quiet = new FeishuBridge({ config: loadConfig({ ...CONFIG }), feishu: bridge.feishu, hub: bridge.hub, stateFile: bridge.stateFile, now: () => feishu.clock, logger: { log() {}, error() {} } });
  await quiet.load();
  await quiet.tick();
  assert.equal(driver.of('ops-a').length, 1, 'no alert_role, no alert');
});
