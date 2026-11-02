// Feishu channel bridge: the one process that connects Feishu to the Hub.
//
// In:  someone @-mentions the bot in a group the bot is in → ack in the thread,
//      then a trigger opens (or follows up) a Role task on the Hub; messages in a
//      followed thread go to that task; the owner's DMs decide approvals and
//      questions, or become tasks of their own.
// Out: Hub events the owner must see become DMs (drafts to approve, questions,
//      exhausted handoffs); an approved outward action whose channel is "feishu"
//      is sent by this process and the result reported back to the Hub.
//
// Everything is deterministic: no model runs here. Idempotency comes from the
// Hub's trigger_key and Feishu's message uuid, so restarts and replays are safe.
// Workers never hold Feishu credentials; the bridge is the only sender.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FeishuApi, messageText, readableText } from './feishu-api.js';

const APPROVE = /^(发|发吧|发了|发出去|可以发|批准|同意|ok|OK)[。.!！\s]*$/;
const CONFIRM = /^(查|去查|查吧|发|好|可以|批准|同意)[。.!！\s]*$/;
const OVERLAP_S = 300; // Feishu lists by the second; look back a little and dedupe on message id.
const EXCERPT_LIMIT = 1500;
const EXCERPT_MESSAGES = 12;
const HANDLED_KEEP = 500;
const STALE_ALERT_MS = 10 * 60 * 1000;
const DEFAULT_ACK = '收到，已交给负责的同事去查，结果会回在这个话题里。';
const NO_SEAT = '岗位上现在没有可用的会话，任务已在 Agent Hub 排队，有会话登记到这个岗位就会接手。';
const SEATS_BUSY = '岗位上的会话现在都在忙，任务已在 Agent Hub 排队，有会话空出来就自动接手；着急的话可以再开一个。';
const NOTIFY_EVENTS = ['attention.created', 'attention.approved', 'attention.executed', 'attention.failed', 'handoff.exhausted'];

const seconds = (ms) => Math.floor(ms / 1000);
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

function beijing(createTimeMs) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(Number(createTimeMs)));
}

// Thin Admin-API client. The bridge authenticates as an Admin-side source.
export class HubAdmin {
  constructor({ baseUrl, token, fetch: fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(pathname, { method = 'GET', body } = {}) {
    const response = await this.fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`Hub ${method} ${pathname}: ${payload.error ?? `HTTP ${response.status}`}`), { statusCode: response.status });
    return payload;
  }

  trigger(body) { return this.request('/api/v1/triggers', { method: 'POST', body }); }
  eventsAfter(cursor, types) {
    const query = new URLSearchParams({ after: cursor ?? '', limit: '200', ...(types ? { types: types.join(',') } : {}) });
    return this.request(`/api/v1/events?${query}`);
  }
  attention(id) { return this.request(`/api/v1/attentions/${encodeURIComponent(id)}`).then((payload) => payload.attention); }
  approve(id, by) { return this.request(`/api/v1/attentions/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { by } }); }
  answer(id, answer, by) { return this.request(`/api/v1/attentions/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { answer, by } }); }
  execution(id, body) { return this.request(`/api/v1/attentions/${encodeURIComponent(id)}/execution`, { method: 'POST', body }); }
}

export function loadConfig(raw) {
  const config = {
    hub_url: 'http://127.0.0.1:8787',
    role: null,
    ack: DEFAULT_ACK,
    prompt_hint: '',
    groups: {},
    default_policy: { internal: 'auto', external: 'confirm' },
    people: {},
    loose_ttl_days: 7,
    auto_approve_to_owner: true,
    ...raw,
  };
  if (!config.app_id) throw new Error('feishu bridge config needs app_id');
  // open_id is per app; union_id (on_…) is shared by every app of the same developer,
  // so a bridge on its own app can name the owner by union_id and learn the open_id.
  if (!config.owner?.open_id && !config.owner?.union_id) throw new Error('feishu bridge config needs owner.open_id or owner.union_id');
  // bot_open_id and owner.dm_chat are optional: the bridge asks Feishu for its bot
  // identity and learns the owner DM chat from its first message to the owner.
  if (!config.role) throw new Error('feishu bridge config needs role (which Hub Role takes the work)');
  for (const [chat, group] of Object.entries(config.groups)) {
    if (group.policy && !['auto', 'confirm', 'ignore'].includes(group.policy)) throw new Error(`group ${chat}: policy must be auto, confirm or ignore`);
  }
  return config;
}

export class FeishuBridge {
  constructor({ config, feishu, hub, stateFile, observe = false, now = () => Date.now(), logger = console }) {
    this.config = config;
    this.feishu = feishu;
    this.hub = hub;
    this.stateFile = stateFile;
    this.observe = observe;
    this.now = now;
    this.logger = logger;
    this.state = null;
    this.names = { ...Object.fromEntries(Object.entries(config.groups).filter(([, group]) => group.name).map(([chat, group]) => [chat, group.name])) };
  }

  static async create({ config, stateFile, observe = false, fetch: fetchImpl = globalThis.fetch, logger = console, appSecret, adminToken }) {
    const feishu = new FeishuApi({ appId: config.app_id, appSecret, fetch: fetchImpl });
    const hub = new HubAdmin({ baseUrl: config.hub_url, token: adminToken, fetch: fetchImpl });
    const bridge = new FeishuBridge({ config, feishu, hub, stateFile, observe, logger });
    await bridge.load();
    return bridge;
  }

  // ---- state -------------------------------------------------------------

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = null;
    }
    return this.state;
  }

  async save() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 1));
    await rename(temporary, this.stateFile);
  }

  fresh(nowSeconds) {
    return {
      cursor: this.ownerDm() ? { [this.ownerDm()]: nowSeconds } : {},
      botOpenId: null, // discovered from /bot/v3/info when the config does not name it
      ownerDm: null, // discovered from the first DM to the owner when the config does not name it
      ownerOpenId: null, // the owner's open_id under this app, learned from their first DM when the config names only union_id
      floor: {}, // chat id → when we started following it; older messages are history, never handled
      eventCursor: null,
      handled: {},
      threads: {}, // thread id → the @ message that opened it; dropped when the Hub says the task is over
      looseThreads: {}, // ordinary-group threads (not listed with the chat) → when we started following
      approvals: {}, // owner DM message id → attention id waiting for 「发」
      questions: {}, // owner DM message id → attention id waiting for an answer
      confirms: {}, // owner DM message id → the @ in a confirm-policy group waiting for 「查」
      executed: {}, // attention id → message id sent, so a replayed approval never sends twice
      lastTick: null,
      lastOkAt: null,
      alertedAt: null,
    };
  }

  ownerDm() { return this.config.owner.dm_chat ?? this.state?.ownerDm ?? null; }
  botId() { return this.config.bot_open_id ?? this.state?.botOpenId ?? null; }

  // Fills in what the config left out: the bot's own open_id, and the DM chat with
  // the owner (learned from a hello message, which also proves the app can reach them).
  async discover(nowS) {
    if (!this.botId()) {
      const bot = await this.feishu.botInfo();
      if (!bot.open_id) throw new Error('Feishu did not return the bot open_id; is the 机器人 capability enabled?');
      this.state.botOpenId = bot.open_id;
      this.log(`bot is ${bot.app_name ?? ''} ${bot.open_id}`);
    }
    if (!this.ownerDm()) {
      const sent = await this.feishu.send(this.ownerId(), `飞书桥已上线${this.observe ? '（观察模式，只记录不动手）' : ''}，群里 @ 机器人的消息会从现在起处理；待确认、待审批的内容会发到这里。`, { uuid: `bridge-hello-${this.config.app_id}` });
      if (!sent.chat_id) throw new Error('Feishu did not return the owner DM chat_id');
      this.state.ownerDm = sent.chat_id;
      this.state.cursor[sent.chat_id] = nowS;
      this.log(`owner DM chat is ${sent.chat_id}`);
    }
  }
  // Where messages to the owner are addressed: the per-app open_id when known, else the union_id.
  ownerId() { return this.ownerOpenId() ?? this.config.owner.union_id; }
  // The owner's open_id under this app, configured or learned from their first DM.
  ownerOpenId() { return this.config.owner.open_id ?? this.state?.ownerOpenId ?? null; }
  isOwner(id) { return Boolean(id) && [this.config.owner.open_id, this.config.owner.union_id, this.state?.ownerOpenId].includes(id); }
  ownerName() { return this.config.owner.name ?? '业主'; }
  chatName(chatId) { return this.names[chatId] || '飞书群'; }
  personName(openId) { return this.config.people?.[openId] ?? (this.isOwner(openId) ? this.ownerName() : null); }

  log(line) { this.logger.log?.(`${new Date(this.now()).toISOString()} ${this.observe ? '[observe] ' : ''}${line}`); }
  would(line) { this.log(`would: ${line}`); }

  // ---- Feishu helpers ----------------------------------------------------

  mentionsBot(message) {
    return message.sender?.sender_type === 'user' && (message.mentions ?? []).some((mention) => mention.id === this.botId());
  }

  // A person writing in the bot's DM chat with the owner is the owner: that chat has
  // no one else. Seeing them there is how the bridge learns their open_id under this app.
  fromOwner(message) {
    if (message.sender?.sender_type !== 'user') return false;
    if (this.isOwner(message.sender?.id)) return true;
    if (this.ownerDm() && message.chat_id === this.ownerDm() && message.sender?.id) {
      if (!this.config.owner.open_id && this.state && this.state.ownerOpenId !== message.sender.id) {
        this.state.ownerOpenId = message.sender.id;
        this.log(`owner open_id under this app is ${message.sender.id}`);
      }
      return true;
    }
    return false;
  }

  policy(chatId, chat) {
    const configured = this.config.groups[chatId]?.policy;
    if (configured) return configured;
    return chat?.external ? this.config.default_policy.external : this.config.default_policy.internal;
  }

  async dmOwner(text, uuid) {
    if (this.observe) return this.would(`DM owner (${uuid}): ${clip(text.replace(/\n/g, ' '), 120)}`), null;
    return this.feishu.sendText(this.ownerId(), text, { uuid });
  }

  // The thread's recent messages, oldest first, within the excerpt budget.
  async excerpt(threadId, fallbackMessage) {
    let rows = [];
    if (threadId) {
      try {
        rows = (await this.feishu.threadMessages(threadId)).slice(0, EXCERPT_MESSAGES).reverse();
      } catch (error) {
        this.log(`thread excerpt failed for ${threadId}: ${error.message}`);
      }
    }
    if (!rows.length && fallbackMessage) rows = [fallbackMessage];
    const lines = [];
    let total = 0;
    for (const row of rows) {
      const text = readableText(row);
      if (!text) continue;
      const who = row.sender?.sender_type === 'app' ? '机器人' : this.personName(row.sender?.id) ?? '群成员';
      const line = `- [${beijing(row.create_time)}] ${who}：${clip(text, 400)}`;
      if (total + line.length > EXCERPT_LIMIT) {
        lines.push(`- …（还有更早的消息，话题 ${threadId}）`);
        break;
      }
      lines.push(line);
      total += line.length;
    }
    return lines.join('\n');
  }

  // ---- inbound: mentions ---------------------------------------------------

  async onMention(message, chat) {
    const mid = message.message_id;
    const chatId = message.chat_id;
    const policy = this.policy(chatId, chat);
    if (policy === 'ignore') return { state: 'ignored-group' };
    if (policy === 'confirm' && !message._confirmed) return this.askConfirm(message, chat);
    const where = this.chatName(chatId);
    const who = this.personName(message.sender?.id) ?? '群成员';
    if (this.observe) {
      this.would(`ack ${mid} in ${where} and open a ${this.config.role} task`);
      return { state: 'observed', thread: message.thread_id ?? null };
    }
    await this.feishu.replyText(mid, this.config.ack, { uuid: `bridge-ack-${mid}` });
    let threadId = message.thread_id ?? null;
    const loose = !threadId; // ordinary group: the ack just opened the thread, whose replies the chat listing will not show
    if (loose) {
      threadId = (await this.feishu.getMessage(mid))?.thread_id ?? null; // throws → retried next tick; the ack uuid keeps it single
    }
    const text = readableText(message);
    const prompt = [
      `【跟进】飞书群「${where}」里 ${who} @ 了机器人（消息 ${mid}${threadId ? `，话题 ${threadId}` : ''}）。机器人已自动在话题里回「${this.config.ack}」。`,
      `话题原文：\n${await this.excerpt(threadId, message)}`,
      `要回群的内容不要自己发：用 agent_hub_report 回报 outcome "needs_approval"，action = {"channel":"feishu","kind":"reply","target":"${mid}","text":"<回复正文>","key":"<唯一键>","note":"回 ${who}：<一句话>"}，${this.ownerName()}批准后由渠道发到这个话题，结果会以新指令告诉你。`,
      '这个话题后面的消息会作为同一任务的跟进直接发给你。',
      this.config.prompt_hint,
    ].filter(Boolean).join('\n\n');
    const snippet = text.replace(/@\S+\s*/g, '').trim().slice(0, 40) || mid;
    const result = await this.hub.trigger({
      trigger_key: `feishu:${mid}`,
      thread_key: `feishu:${threadId ?? mid}`,
      source: 'feishu',
      actor: who,
      role: this.config.role,
      title: `${where} @：${snippet}`,
      text: prompt,
    });
    if (result.waiting_for_seat) {
      await this.dmOwner(`${where}里 ${who} @ 了机器人（消息 ${mid}），已回「收到」。${result.seats_busy ? SEATS_BUSY : NO_SEAT}`, `bridge-noseat-${mid}`);
    }
    return { state: result.waiting_for_seat ? 'queued' : 'dispatched', routed: result.routed, task: result.task?.task_id ?? null, thread: threadId, loose };
  }

  async askConfirm(message, chat) {
    const mid = message.message_id;
    const where = this.chatName(message.chat_id);
    const who = this.personName(message.sender?.id) ?? '群成员';
    const text = `【外部群】${where}里 ${who} @ 了机器人（消息 ${mid}）：\n${clip(readableText(message), 300)}\n\n要查就引用这条回「查」，不理就不用回。群里没有回任何话。`;
    const dm = await this.dmOwner(text, `bridge-confirm-${mid}`);
    if (dm) this.state.confirms[dm] = { chat: message.chat_id, message, at: seconds(this.now()) };
    return { state: 'awaiting-confirm', dm };
  }

  async onThreadFollowup(message) {
    const text = readableText(message);
    if (!text) return { state: 'skipped' };
    if (this.observe) return this.would(`forward thread message ${message.message_id} to the task of ${message.thread_id}`), { state: 'observed' };
    const who = this.personName(message.sender?.id) ?? '群成员';
    const result = await this.hub.trigger({
      trigger_key: `feishu:${message.message_id}`, thread_key: `feishu:${message.thread_id}`, source: 'feishu', actor: who, text, followup_only: true,
    });
    return { state: result.routed ?? 'ignored', thread: message.thread_id };
  }

  // ---- inbound: the owner's DMs -------------------------------------------

  async onOwnerDm(message) {
    const mid = message.message_id;
    const text = readableText(message);
    if (!text) return { state: 'skipped' };
    const quoted = message.parent_id ?? null;
    const by = this.ownerName();
    if (quoted && this.state.approvals[quoted]) return this.decideApproval(this.state.approvals[quoted], text, mid);
    if (quoted && this.state.questions[quoted]) return this.answerQuestion(this.state.questions[quoted], text, mid);
    if (quoted && this.state.confirms[quoted]) return this.decideConfirm(quoted, text, mid);
    const pendingApprovals = Object.values(this.state.approvals);
    const pendingConfirms = Object.keys(this.state.confirms);
    if (APPROVE.test(text) || CONFIRM.test(text)) {
      const pending = pendingApprovals.length + pendingConfirms.length;
      if (pending === 1) {
        return pendingApprovals.length ? this.decideApproval(pendingApprovals[0], text, mid) : this.decideConfirm(pendingConfirms[0], text, mid);
      }
      if (pending > 1) {
        await this.dmOwner(`有 ${pending} 条在等你决定，请引用要处理的那条再回。`, `bridge-ambiguous-${mid}`);
        return { state: 'ambiguous' };
      }
    }
    // Anything else the owner says is a task of its own for the Role.
    if (this.observe) return this.would(`open a ${this.config.role} task from owner DM ${mid}`), { state: 'observed' };
    const result = await this.hub.trigger({
      trigger_key: `feishu:${mid}`,
      thread_key: `feishu-dm:${mid}`,
      source: 'feishu-dm',
      actor: by,
      role: this.config.role,
      title: `${by}私信：${text.slice(0, 30)}`,
      text: [
        `【跟进】${by} 在飞书私信里对机器人说（消息 ${mid}）：「${text}」。`,
        `按他说的做。要回给他的结果用 agent_hub_report 回报 outcome "needs_approval"，action = {"channel":"feishu","kind":"send","target":"${this.ownerId()}","text":"<回复>","key":"<唯一键>"}（发给${by}本人的不需要他再批，渠道直接发）。做完把这个任务改成 done。`,
        this.config.prompt_hint,
      ].filter(Boolean).join('\n\n'),
    });
    if (result.waiting_for_seat) await this.dmOwner(`收到。${result.seats_busy ? SEATS_BUSY : NO_SEAT}`, `bridge-noseat-${mid}`);
    return { state: result.waiting_for_seat ? 'queued' : 'dispatched', task: result.task?.task_id ?? null };
  }

  async decideApproval(attentionId, text, mid) {
    const by = this.ownerName();
    if (this.observe) return this.would(`${APPROVE.test(text) ? 'approve' : 'send feedback on'} attention ${attentionId}`), { state: 'observed' };
    try {
      if (APPROVE.test(text)) {
        await this.hub.approve(attentionId, by);
        this.forgetDecision(attentionId);
        return { state: 'approved', attention: attentionId };
      }
      await this.hub.answer(attentionId, text, by);
      this.forgetDecision(attentionId);
      await this.dmOwner('已把你的意见发回给负责的会话改，改好会再发一版给你。', `bridge-feedback-${mid}`);
      return { state: 'feedback', attention: attentionId };
    } catch (error) {
      if (error.statusCode === 409 || error.statusCode === 404) {
        this.forgetDecision(attentionId);
        await this.dmOwner(`这条已经处理过了（${error.message}）。`, `bridge-stale-${mid}`);
        return { state: 'stale', attention: attentionId };
      }
      throw error;
    }
  }

  async answerQuestion(attentionId, text, mid) {
    if (this.observe) return this.would(`answer attention ${attentionId}`), { state: 'observed' };
    try {
      await this.hub.answer(attentionId, text, this.ownerName());
      this.forgetDecision(attentionId);
      return { state: 'answered', attention: attentionId };
    } catch (error) {
      if (error.statusCode === 409 || error.statusCode === 404) {
        this.forgetDecision(attentionId);
        await this.dmOwner(`这个问题已经处理过了（${error.message}）。`, `bridge-stale-${mid}`);
        return { state: 'stale', attention: attentionId };
      }
      throw error;
    }
  }

  async decideConfirm(dmMid, text, mid) {
    const pending = this.state.confirms[dmMid];
    if (!pending) return { state: 'stale' };
    if (!CONFIRM.test(text) && !APPROVE.test(text)) {
      delete this.state.confirms[dmMid];
      await this.dmOwner('好，这条不查。', `bridge-skip-${mid}`);
      return { state: 'declined' };
    }
    delete this.state.confirms[dmMid];
    const result = await this.onMention({ ...pending.message, _confirmed: true }, null);
    this.track(pending.message.message_id, result);
    return { state: 'confirmed', ...result };
  }

  forgetDecision(attentionId) {
    for (const map of [this.state.approvals, this.state.questions]) {
      for (const [dm, id] of Object.entries(map)) if (id === attentionId) delete map[dm];
    }
  }

  // ---- outbound: Hub events → the owner, approved actions → Feishu ---------

  async pumpEvents() {
    const payload = await this.hub.eventsAfter(this.state.eventCursor, NOTIFY_EVENTS);
    for (const event of payload.events ?? []) {
      await this.onEvent(event);
      this.state.eventCursor = event.event_id;
      await this.save();
    }
    if (!this.state.eventCursor && payload.cursor) {
      this.state.eventCursor = payload.cursor; // first run: start at the present, never replay history
      await this.save();
    }
  }

  async onEvent(event) {
    const attentionId = event.payload?.attention_id;
    if (event.event_type === 'handoff.exhausted') {
      await this.dmOwner(`任务 ${event.task_id} 已经交接了 ${event.payload?.limit ?? 3} 次都没做完（岗位 ${event.payload?.role_key ?? ''}），Hub 停止自动交接，需要你看一下。`, `bridge-exhausted-${event.event_id}`);
      return;
    }
    if (!attentionId) return;
    const attention = await this.hub.attention(attentionId).catch(() => null);
    if (!attention) return;
    if (event.event_type === 'attention.created') return this.notifyAttention(attention);
    if (event.event_type === 'attention.approved') return this.executeApproved(attention);
    if (event.event_type === 'attention.executed' && attention.action?.channel !== 'feishu') {
      await this.dmOwner(`已发出（${attention.action?.channel} ${attention.action?.kind} → ${attention.action?.target}）。`, `bridge-executed-${attentionId}`);
    }
  }

  async notifyAttention(attention) {
    const who = attention.worker_name ?? '数字员工';
    const task = attention.task_title ? `「${attention.task_title}」` : '';
    if (attention.outcome === 'needs_approval') {
      const action = attention.action ?? {};
      if (this.config.auto_approve_to_owner && action.channel === 'feishu' && action.kind === 'send' && this.isOwner(action.target)) {
        if (this.observe) return this.would(`auto-approve ${attention.attention_id} (a message to the owner)`);
        await this.hub.approve(attention.attention_id, 'bridge:feishu').catch((error) => this.log(`auto-approve ${attention.attention_id}: ${error.message}`));
        return;
      }
      const where = action.kind === 'reply' ? `回到话题（消息 ${action.target}）` : `发到 ${action.target}`;
      const dm = await this.dmOwner(
        `【待确认】${action.note || `${who}的回复草稿`}，${action.channel} ${where}${task ? `，任务${task}` : ''}：\n\n${action.text}\n\n——\n回「发」就按这个发出去；要改直接说。`,
        `bridge-approval-${attention.attention_id}`,
      );
      if (dm) this.state.approvals[dm] = attention.attention_id;
      return;
    }
    const dm = await this.dmOwner(
      `【${attention.outcome === 'blocked' ? '卡住了' : '需要你回答'}】${who}${task ? `在任务${task}里` : ''}问：\n${attention.question}\n\n引用这条回我就行。`,
      `bridge-question-${attention.attention_id}`,
    );
    if (dm) this.state.questions[dm] = attention.attention_id;
  }

  async executeApproved(attention) {
    const action = attention.action ?? {};
    if (action.channel !== 'feishu') return;
    if (attention.status !== 'approved') return; // already settled, e.g. by a previous run
    if (this.observe) return this.would(`send approved ${action.kind} → ${action.target} for ${attention.attention_id}`);
    const uuid = action.key ? `bridge-action-${action.key}` : `bridge-action-${attention.attention_id}`;
    let messageId = this.state.executed[attention.attention_id] ?? null;
    try {
      if (!messageId) {
        if (action.kind === 'reply') messageId = await this.feishu.replyText(action.target, action.text, { uuid });
        else if (action.kind === 'send') messageId = await this.feishu.sendText(action.target, action.text, { uuid });
        else throw new Error(`unsupported feishu action kind ${action.kind}`);
        this.state.executed[attention.attention_id] = messageId;
        await this.save();
      }
      await this.hub.execution(attention.attention_id, { status: 'executed', result: { message_id: messageId, channel: 'feishu', kind: action.kind, target: action.target }, by: 'bridge:feishu' });
      if (!this.isOwner(action.target)) {
        await this.dmOwner(`已发出（${action.note || action.kind}）：消息 ${messageId}`, `bridge-sent-${attention.attention_id}`);
      }
    } catch (error) {
      this.log(`execute ${attention.attention_id} failed: ${error.message}`);
      if (messageId) throw error; // sent but not reported: keep the cursor so the report is retried
      await this.hub.execution(attention.attention_id, { status: 'failed', error: error.message, by: 'bridge:feishu' });
      await this.dmOwner(`批准的内容没发出去：${clip(error.message, 200)}。已通知负责的会话。`, `bridge-sendfail-${attention.attention_id}`);
    }
  }

  // ---- the tick ------------------------------------------------------------

  track(mid, result) {
    if (result?.thread && ['dispatched', 'queued', 'observed'].includes(result.state)) {
      this.state.threads[result.thread] = mid;
      if (result.loose) this.state.looseThreads[result.thread] = seconds(this.now());
    }
    if (result?.state === 'ignored' && result.thread) {
      delete this.state.threads[result.thread];
      delete this.state.looseThreads[result.thread];
    }
  }

  follow(chatId, nowS) {
    this.state.cursor[chatId] = nowS;
    this.state.floor ??= {};
    this.state.floor[chatId] = nowS;
  }

  async process(message, route) {
    const mid = message.message_id;
    if (this.state.handled[mid] || message.deleted) return;
    const floor = this.state.floor?.[message.chat_id];
    if (floor && Number(message.create_time) / 1000 < floor) return; // before we joined: history, not work
    const handler = route(message);
    if (!handler) return;
    const result = await handler(message);
    this.log(`${message.chat_id ?? message.thread_id} ${mid} ${JSON.stringify(result)}`);
    this.track(mid, result);
    this.state.handled[mid] = { ...result, at: new Date(this.now()).toISOString() };
    await this.save();
  }

  async tick() {
    const nowS = seconds(this.now());
    if (!this.state) {
      // First run: every group the bot is in starts at now, so no history is replayed.
      this.state = this.fresh(nowS);
      try {
        await this.discover(nowS);
      } catch (error) {
        this.state = null; // nothing persisted; the next tick starts over
        throw error;
      }
      for (const chat of await this.feishu.listChats()) if (chat.chat_id !== this.ownerDm()) this.follow(chat.chat_id, nowS);
      const start = await this.hub.eventsAfter(null, NOTIFY_EVENTS).catch(() => null);
      this.state.eventCursor = start?.cursor ?? null;
      await this.save();
      this.log('cursors set at now; next tick starts handling new messages');
      return 0;
    }
    const failed = [];
    const fail = (source, error) => {
      failed.push(source);
      this.logger.error?.(`${new Date(this.now()).toISOString()} ${source} failed, retried next tick: ${error.message}`);
    };

    // A state file from before the config lost bot_open_id / dm_chat still needs them.
    await this.discover(nowS).catch((error) => fail('discover', error));
    await this.pumpEvents().catch((error) => fail('hub-events', error));

    // Groups the bot is in right now; a new one starts at now, a left one is forgotten.
    let chats;
    try {
      chats = Object.fromEntries((await this.feishu.listChats()).filter((chat) => chat.chat_id !== this.ownerDm()).map((chat) => [chat.chat_id, chat]));
      for (const gone of Object.keys(this.state.cursor)) if (gone !== this.ownerDm() && !chats[gone]) delete this.state.cursor[gone];
    } catch (error) {
      fail('chat-list', error);
      chats = Object.fromEntries(Object.keys(this.state.cursor).filter((chat) => chat !== this.ownerDm()).map((chat) => [chat, { chat_id: chat }]));
    }
    for (const [chatId, chat] of Object.entries(chats)) if (chat.name) this.names[chatId] = chat.name;
    const newChats = Object.keys(chats).filter((chat) => !(chat in this.state.cursor));
    for (const chat of newChats) this.follow(chat, nowS);

    const groupRoute = (message) => {
      if (this.mentionsBot(message)) return (m) => this.onMention(m, chats[m.chat_id]);
      if (message.sender?.sender_type === 'user' && message.thread_id && this.state.threads[message.thread_id]) return (m) => this.onThreadFollowup(m);
      return null;
    };
    for (const chatId of Object.keys(chats).filter((chat) => !newChats.includes(chat))) {
      try {
        for (const message of await this.feishu.chatMessagesSince(chatId, this.state.cursor[chatId] - OVERLAP_S)) {
          await this.process({ ...message, chat_id: chatId }, groupRoute);
        }
        this.state.cursor[chatId] = nowS;
      } catch (error) {
        fail(chatId, error);
      }
    }

    // Ordinary-group threads are followed one by one, for a bounded time.
    const ttl = this.config.loose_ttl_days * 86400;
    for (const [threadId, since] of Object.entries(this.state.looseThreads)) {
      if (nowS - since > ttl) {
        delete this.state.looseThreads[threadId];
        delete this.state.threads[threadId];
      }
    }
    const threadStart = (this.state.threadCursor ?? nowS) - OVERLAP_S;
    let threadsOk = true;
    for (const threadId of Object.keys(this.state.looseThreads)) {
      try {
        const rows = (await this.feishu.threadMessages(threadId)).filter((row) => Number(row.create_time) / 1000 >= threadStart).reverse();
        for (const message of rows) await this.process({ ...message, thread_id: threadId }, groupRoute);
      } catch (error) {
        fail(threadId, error);
        threadsOk = false;
      }
    }
    if (threadsOk) this.state.threadCursor = nowS;

    if (this.ownerDm()) {
      try {
        for (const message of await this.feishu.chatMessagesSince(this.ownerDm(), (this.state.cursor[this.ownerDm()] ?? nowS) - OVERLAP_S)) {
          await this.process({ ...message, chat_id: this.ownerDm() }, (m) => (this.fromOwner(m) ? (x) => this.onOwnerDm(x) : null));
        }
        this.state.cursor[this.ownerDm()] = nowS;
      } catch (error) {
        fail('owner-dm', error);
      }
    }

    // Decisions just made in DMs produce events; act on them now, not a tick later.
    await this.pumpEvents().catch((error) => fail('hub-events-2', error));

    const handled = Object.entries(this.state.handled);
    if (handled.length > HANDLED_KEEP * 2) this.state.handled = Object.fromEntries(handled.sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-HANDLED_KEEP));

    if (failed.length) {
      await this.alertIfStale(nowS).catch(() => {});
    } else {
      this.state.lastOkAt = nowS;
      this.state.alertedAt = null;
      this.state.lastTick = new Date(this.now()).toISOString();
    }
    await this.save();
    return failed.length ? 1 : 0;
  }

  async alertIfStale(nowS) {
    const lastOk = this.state.lastOkAt ?? nowS;
    if (nowS - lastOk < STALE_ALERT_MS / 1000 || this.state.alertedAt) return;
    await this.dmOwner(`飞书桥已经 ${Math.round((nowS - lastOk) / 60)} 分钟没有完整跑通一轮（飞书或 Hub 调用持续失败），群里的 @ 可能没人接。请看 Hub 机器上的 agent-hub-bridge-feishu 日志。`, `bridge-stale-${lastOk}`);
    this.state.alertedAt = nowS; // only once the DM went out, so a Feishu-wide outage retries the alert
  }

  status() {
    return {
      lastTick: this.state?.lastTick ?? null,
      lastOkAt: this.state?.lastOkAt ?? null,
      chats: Object.keys(this.state?.cursor ?? {}).length,
      threads: this.state?.threads ?? {},
      looseThreads: Object.keys(this.state?.looseThreads ?? {}).length,
      pendingApprovals: Object.values(this.state?.approvals ?? {}),
      pendingQuestions: Object.values(this.state?.questions ?? {}),
      pendingConfirms: Object.keys(this.state?.confirms ?? {}).length,
      eventCursor: this.state?.eventCursor ?? null,
    };
  }
}

export { messageText };
