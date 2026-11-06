// Feishu channel bridge: the one process that connects Feishu to the Hub.
//
// In:  someone @-mentions the bot in a group the bot is in → an emoji reaction says
//      "seen", then a trigger opens a Role task on the Hub; messages in a followed
//      thread (with or without an @) go to that task as follow-ups; the owner's DMs
//      decide approvals and questions, or become tasks of their own.
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
const DEFAULT_ACK_REACTION = 'OK'; // the emoji put on an @ to say "seen"; a sentence would promise work before anyone judged it
const EVENT_GIVE_UP = 6; // a Hub event whose handling keeps failing is skipped after this many attempts (two per tick)
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
    ack: null, // optional sentence replied in the thread on an @; off by default, the reaction is the ack
    ack_reaction: DEFAULT_ACK_REACTION, // emoji_type reacted on an @ (also inside a followed thread) and on an owner DM that opens a task; never on other people's thread messages; null for none
    prompt_hint: '',
    groups: {},
    default_policy: { internal: 'auto', external: 'confirm' },
    people: {},
    bots: {}, // app_id → name: other bots whose @ and thread messages count as work; any other bot is ignored
    bot_per_hour: 6, // loop guard: at most this many messages from one listed bot per hour …
    bot_thread_per_hour: 3, // … and this many bot messages per thread per hour; beyond that they are dropped and logged
    loose_ttl_days: 7,
    thread_scan_interval_s: 300, // how often each group's recent roots are re-listed to discover threads others opened
    thread_scan_hours: 48, // how far back that listing looks
    thread_max_per_chat: 20, // the most recently active discovered threads polled per group
    auto_approve_to_owner: true,
    // Several bridges (one per Feishu app) can serve one Hub. Approvals, questions and
    // receipts are Hub-wide events, so each bridge must take only its share or the same
    // reply goes out once per bot: own_role_only takes just `role`; other_roles names the
    // Roles another bridge serves, which this one then skips.
    own_role_only: false,
    other_roles: [],
    ...raw,
  };
  if (!config.app_id) throw new Error('feishu bridge config needs app_id');
  // open_id is per app; union_id (on_…) is shared by every app of the same developer,
  // so a bridge on its own app can name the owner by union_id and learn the open_id.
  if (!config.owner?.open_id && !config.owner?.union_id) throw new Error('feishu bridge config needs owner.open_id or owner.union_id');
  // bot_open_id and owner.dm_chat are optional: the bridge asks Feishu for its bot
  // identity and learns the owner DM chat from its first message to the owner.
  if (!config.role) throw new Error('feishu bridge config needs role (which Hub Role takes the work)');
  if (!Array.isArray(config.other_roles) || config.other_roles.some((role) => typeof role !== 'string' || !role)) throw new Error('feishu bridge config: other_roles must be a list of Role keys');
  if (config.other_roles.includes(config.role)) throw new Error('feishu bridge config: other_roles must not name this bridge\'s own role');
  if (config.ack_reaction !== null && typeof config.ack_reaction !== 'string') throw new Error('feishu bridge config: ack_reaction must be an emoji_type string or null');
  for (const [id, name] of Object.entries(config.bots)) {
    if (!/^cli_/.test(id) || typeof name !== 'string' || !name) throw new Error(`bots: ${id} must map an app_id (cli_…) to a name`);
  }
  for (const [chat, group] of Object.entries(config.groups)) {
    if (group.policy && !['auto', 'confirm', 'ignore'].includes(group.policy)) throw new Error(`group ${chat}: policy must be auto, confirm or ignore`);
    if (group.reply && !['auto', 'confirm'].includes(group.reply)) throw new Error(`group ${chat}: reply must be auto or confirm`);
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
      this.state.threadKeys ??= {}; // state files from before these maps existed
      this.state.eventFailures ??= {};
      this.state.botTurns ??= {};
      this.state.knownThreads ??= {};
      this.state.threadScanAt ??= 0;
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
      threadKeys: {}, // thread id → the Hub thread_key when it is not feishu:<thread id> (a thread opened later by the seat's reply)
      looseThreads: {}, // ordinary-group threads (not listed with the chat) → when we started following
      knownThreads: {}, // thread id → { chat, at }: threads others opened, polled so an @ inside them is seen
      threadScanAt: 0,
      eventFailures: {}, // Hub event id → failed handling attempts; skipped at EVENT_GIVE_UP
      botTurns: {}, // "bot:<app_id>" / "thread:<thread_key>" → recent seconds a listed bot's message was accepted (loop guard)
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
  // Outgoing text: "@Anya" for a person named in `people` becomes a real Feishu mention.
  withMentions(text) {
    let out = String(text ?? '');
    for (const [openId, name] of Object.entries(this.config.people ?? {})) {
      if (name) out = out.split(`@${name}`).join(`<at user_id="${openId}">${name}</at>`);
    }
    return out;
  }

  log(line) { this.logger.log?.(`${new Date(this.now()).toISOString()} ${this.observe ? '[observe] ' : ''}${line}`); }
  would(line) { this.log(`would: ${line}`); }

  // ---- Feishu helpers ----------------------------------------------------

  // An @ counts when a person sent it, or a bot named in `bots`. Our own messages and
  // every other bot's are never work: two bots acknowledging each other would never stop.
  mentionsBot(message) {
    if (message.sender?.sender_type !== 'user' && !this.trustedBot(message)) return false;
    return (message.mentions ?? []).some((mention) => mention.id === this.botId());
  }

  trustedBot(message) {
    const id = message.sender?.id;
    if (message.sender?.sender_type !== 'app' || !id || id === this.config.app_id) return null;
    return this.config.bots?.[id] ?? null;
  }

  // Who sent a message, as the seat is told: a person by name, a listed bot by name, any
  // other bot as 机器人.
  senderName(message) {
    if (message.sender?.sender_type === 'app') return this.config.bots?.[message.sender.id] ?? '机器人';
    return this.personName(message.sender?.id) ?? '群成员';
  }

  // Loop guard for listed bots: a bot gets at most bot_per_hour accepted messages, and a
  // thread at most bot_thread_per_hour bot messages. Returns null for a person, otherwise
  // { bot, exceeded } and records the turn when it was accepted.
  botBudget(message, threadKey) {
    const bot = this.trustedBot(message);
    if (!bot) return null;
    const now = seconds(this.now());
    const recent = (key) => (this.state.botTurns[key] ?? []).filter((at) => at > now - 3600);
    const botKey = `bot:${message.sender.id}`;
    const threadKeyed = `thread:${threadKey}`;
    const byBot = recent(botKey);
    const byThread = recent(threadKeyed);
    if (byBot.length >= this.config.bot_per_hour || byThread.length >= this.config.bot_thread_per_hour) return { bot, exceeded: true };
    this.state.botTurns[botKey] = [...byBot, now];
    this.state.botTurns[threadKeyed] = [...byThread, now];
    return { bot, exceeded: false };
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
      const who = row.sender?.sender_type === 'app' && row.sender.id === this.config.app_id ? '机器人（我方）' : this.senderName(row);
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
    const who = this.senderName(message);
    const budget = this.botBudget(message, `feishu:${message.thread_id ?? mid}`);
    if (budget?.exceeded) {
      this.log(`bot ${budget.bot} over its hourly budget: ${mid} in ${where} dropped`);
      return { state: 'bot-limited', bot: budget.bot };
    }
    if (this.observe) {
      this.would(`acknowledge ${mid} in ${where} and open a ${this.config.role} task`);
      return { state: 'observed', thread: message.thread_id ?? null };
    }
    const acked = await this.acknowledge(mid);
    let threadId = message.thread_id ?? null;
    const loose = !threadId; // ordinary group: thread replies are not in the chat listing, the thread is polled on its own
    if (loose && this.config.ack) {
      threadId = (await this.feishu.getMessage(mid))?.thread_id ?? null; // the ack sentence opened the thread; throws → retried next tick, the uuid keeps it single
    }
    // Without an ack sentence an ordinary-group @ has no thread yet: the seat's reply
    // opens one, and executeApproved starts following it under this task's key.
    const text = readableText(message);
    const prompt = [
      `【群里的 @】飞书群「${where}」里 ${budget ? `机器人 ${who}` : who} @ 了机器人（消息 ${mid}${threadId ? `，话题 ${threadId}` : ''}）。${acked}`,
      budget ? `发消息的是另一个机器人（${who}），不是真人：按同样的规则判断要不要回。机器人之间的往来一轮说完，不要为了礼貌、确认或致谢再回一条。` : '',
      `${threadId ? '话题' : '消息'}原文：\n${await this.excerpt(threadId, message)}`,
      `先判断这条 @ 要你做什么。只是通知、抄送或不需要回应的：不要回群，回报 done 并写明「只是通知，无需处理」。要你做事或回答的：按手册处理，要回群的内容不要自己发，用 agent_hub_report 回报 outcome "needs_approval"，action = {"channel":"feishu","kind":"reply","target":"${mid}","text":"<回复正文>","key":"<唯一键>","note":"回 ${who}：<一句话>"}，由渠道发到${threadId ? '这个话题' : '这条消息下的话题'}（有的群要先经${this.ownerName()}批准），结果会以新指令告诉你。`,
      `${threadId ? '这个话题' : '这条消息开出的话题'}后面的消息会作为同一任务的跟进直接发给你；对方说不用查、不用回，就停手结单。`,
      this.config.prompt_hint,
    ].filter(Boolean).join('\n\n');
    const snippet = text.replace(/@\S+\s*/g, '').trim().slice(0, 40) || mid;
    const threadKey = `feishu:${threadId ?? mid}`;
    const result = await this.hub.trigger({
      trigger_key: `feishu:${mid}`,
      thread_key: threadKey,
      source: 'feishu',
      actor: who,
      role: this.config.role,
      title: `${where} @：${snippet}`,
      text: prompt,
    });
    if (result.waiting_for_seat) {
      await this.dmOwner(`${where}里 ${who} @ 了机器人（消息 ${mid}），已表示收到。${result.seats_busy ? SEATS_BUSY : NO_SEAT}`, `bridge-noseat-${mid}`);
    }
    return { state: result.waiting_for_seat ? 'queued' : 'dispatched', routed: result.routed, task: result.task?.task_id ?? null, thread: threadId, thread_key: threadKey, loose, chat: chatId };
  }

  // Says "seen" on an @: the configured reaction, the configured sentence, or both.
  // Returns the sentence the seat is told, so it knows what the group already saw.
  // A failed reaction is logged, not fatal: the task matters more than the emoji.
  async acknowledge(mid) {
    const said = [];
    if (this.config.ack_reaction) {
      try {
        await this.feishu.react(mid, this.config.ack_reaction);
        said.push(`机器人已在那条消息上回了 ${this.config.ack_reaction} 表情表示收到，没有说话`);
      } catch (error) {
        this.log(`react ${this.config.ack_reaction} on ${mid} failed: ${error.message}`);
      }
    }
    if (this.config.ack) {
      await this.feishu.replyText(mid, this.config.ack, { uuid: `bridge-ack-${mid}` });
      said.push(`机器人已自动在话题里回「${this.config.ack}」`);
    }
    return said.length ? `${said.join('；')}。` : '机器人没有在群里回任何话。';
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
    const threadKey = this.state.threadKeys[message.thread_id] ?? `feishu:${message.thread_id}`;
    const budget = this.botBudget(message, threadKey);
    if (budget?.exceeded) {
      this.log(`bot ${budget.bot} over its hourly budget: ${message.message_id} in thread ${message.thread_id} dropped`);
      return { state: 'bot-limited', bot: budget.bot };
    }
    if (this.observe) return this.would(`forward thread message ${message.message_id} to the task of ${message.thread_id}`), { state: 'observed' };
    const who = budget ? `机器人 ${this.senderName(message)}` : this.senderName(message);
    const result = await this.hub.trigger({
      trigger_key: `feishu:${message.message_id}`, thread_key: threadKey, source: 'feishu', actor: who, text: budget ? `（来自机器人 ${budget.bot}，机器人之间的往来一轮说完）\n${text}` : text, followup_only: true,
    });
    // Only an @ gets the reaction: other people's messages in a followed thread are read, not stamped (owner 11-05).
    if (result.routed === 'followup' && this.config.ack_reaction && this.mentionsBot(message)) {
      await this.feishu.react(message.message_id, this.config.ack_reaction).catch((error) => this.log(`react on follow-up ${message.message_id} failed: ${error.message}`));
    }
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
    if (this.config.ack_reaction) {
      await this.feishu.react(mid, this.config.ack_reaction).catch((error) => this.log(`react on DM ${mid} failed: ${error.message}`));
    }
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
      try {
        await this.onEvent(event);
      } catch (error) {
        // One event that cannot be handled must not hold every later approval and
        // receipt behind it: retry a few ticks, then skip it and say so.
        this.state.eventFailures ??= {};
        const attempts = (this.state.eventFailures[event.event_id] ?? 0) + 1;
        this.state.eventFailures[event.event_id] = attempts;
        await this.save();
        if (attempts < EVENT_GIVE_UP) throw error;
        this.logger.error?.(`${new Date(this.now()).toISOString()} event ${event.event_id} (${event.event_type}) skipped after ${attempts} failed attempts: ${error.message}`);
      }
      delete this.state.eventFailures?.[event.event_id];
      this.state.eventCursor = event.event_id;
      await this.save();
    }
    if (!this.state.eventCursor && payload.cursor) {
      this.state.eventCursor = payload.cursor; // first run: start at the present, never replay history
      await this.save();
    }
  }

  // Whether this bridge answers for work of `roleKey` (null = work outside any Role).
  servesRole(roleKey) {
    if (this.config.own_role_only) return roleKey === this.config.role;
    return !this.config.other_roles.includes(roleKey);
  }

  async onEvent(event) {
    const attentionId = event.payload?.attention_id;
    if (event.event_type === 'handoff.exhausted') {
      if (!this.servesRole(event.payload?.role_key ?? null)) return;
      await this.dmOwner(`任务 ${event.task_id} 已经交接了 ${event.payload?.limit ?? 3} 次都没做完（岗位 ${event.payload?.role_key ?? ''}），Hub 停止自动交接，需要你看一下。`, `bridge-exhausted-${event.event_id}`);
      return;
    }
    if (!attentionId) return;
    const attention = await this.hub.attention(attentionId).catch(() => null);
    if (!attention) return;
    if (!this.servesRole(attention.role_key ?? null)) return;
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
      const reason = await this.autoApproves(action);
      if (reason) {
        if (this.observe) return this.would(`auto-approve ${attention.attention_id} (${reason})`);
        this.log(`auto-approve ${attention.attention_id} (${reason})`);
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

  // Why an approval-type action goes out without asking the owner, or null when the
  // owner must decide: a message to the owner needs no approval; a reply into a group
  // whose policy is auto is sent as it is (the owner is told afterwards) unless the group
  // sets reply: confirm. Anything the bridge cannot place in a known group is asked.
  async autoApproves(action) {
    if (action.channel !== 'feishu') return null;
    if (action.kind === 'send' && this.isOwner(action.target)) return this.config.auto_approve_to_owner ? 'a message to the owner' : null;
    const chatId = await this.actionChat(action);
    if (!chatId) return null;
    const group = this.config.groups[chatId];
    const chat = this.knownChats?.[chatId];
    if (!group && !chat) return null;
    const reply = group?.reply ?? this.policy(chatId, chat);
    return reply === 'auto' ? `${this.chatName(chatId)} sends replies without approval` : null;
  }

  async actionChat(action) {
    if (action.kind === 'send') return /^oc_/.test(action.target ?? '') ? action.target : null;
    if (action.kind !== 'reply' || !action.target) return null;
    const known = this.state.handled[action.target]?.chat;
    if (known) return known;
    try { return (await this.feishu.getMessage(action.target))?.chat_id ?? null; } catch { return null; }
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
        if (action.kind === 'reply') messageId = await this.feishu.replyText(action.target, this.withMentions(action.text), { uuid });
        else if (action.kind === 'send') messageId = await this.feishu.sendText(action.target, this.withMentions(action.text), { uuid });
        else throw new Error(`unsupported feishu action kind ${action.kind}`);
        this.state.executed[attention.attention_id] = messageId;
        await this.save();
      }
      await this.hub.execution(attention.attention_id, { status: 'executed', result: { message_id: messageId, channel: 'feishu', kind: action.kind, target: action.target }, by: 'bridge:feishu' });
      if (action.kind === 'reply') await this.followReplyThread(action.target, messageId).catch((error) => this.log(`follow thread of ${messageId}: ${error.message}`));
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

  // In an ordinary group an @ has no thread until someone replies in one. When the
  // seat's reply to such an @ opens the thread, follow it under the task's key
  // (feishu:<@ message>) so later messages in it reach the same task.
  async followReplyThread(target, messageId) {
    const opened = this.state.handled[target];
    if (!opened?.task || opened.thread || !opened.loose) return;
    const threadId = (await this.feishu.getMessage(messageId))?.thread_id ?? null;
    if (!threadId || this.state.threads[threadId]) return;
    this.state.threads[threadId] = target;
    this.state.threadKeys[threadId] = opened.thread_key ?? `feishu:${target}`;
    this.state.looseThreads[threadId] = seconds(this.now());
    opened.thread = threadId;
    this.log(`following thread ${threadId} opened by the reply to ${target}`);
  }

  // ---- the tick ------------------------------------------------------------

  track(mid, result) {
    if (result?.thread && ['dispatched', 'queued', 'observed'].includes(result.state)) {
      this.state.threads[result.thread] = mid;
      if (result.loose) this.state.looseThreads[result.thread] = seconds(this.now());
    }
    if (result?.state === 'ignored' && result.thread) {
      delete this.state.threads[result.thread];
      delete this.state.threadKeys[result.thread];
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
      this.state.lastOkAt = nowS;
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
    this.knownChats = chats;
    // A group seen for the first time starts at the previous tick, not at now: the bot
    // can be @'d in the seconds between being added and the bridge noticing the group.
    const newChats = Object.keys(chats).filter((chat) => !(chat in this.state.cursor));
    for (const chat of newChats) this.follow(chat, this.state.lastOkAt ?? nowS);

    // A message inside a followed thread is a follow-up to that task whether or not it
    // @s the bot: people @ to address, not to open something new. Only an @ outside
    // any followed thread opens a task.
    const groupRoute = (message) => {
      if (message.sender?.sender_type !== 'user' && !this.trustedBot(message)) return null;
      if (message.thread_id && this.state.threads[message.thread_id]) return (m) => this.onThreadFollowup(m);
      if (this.mentionsBot(message)) return (m) => this.onMention(m, chats[m.chat_id]);
      return null;
    };
    for (const chatId of Object.keys(chats)) {
      try {
        for (const message of await this.feishu.chatMessagesSince(chatId, this.state.cursor[chatId] - OVERLAP_S)) {
          await this.process({ ...message, chat_id: chatId }, groupRoute);
        }
        this.state.cursor[chatId] = nowS;
      } catch (error) {
        fail(chatId, error);
      }
    }

    // Threads others opened: in an ordinary group the chat listing shows a thread's root
    // (with its thread_id once it has replies) but never the replies, so an @ inside such
    // a thread is invisible unless that thread is polled. Every thread_scan_interval_s the
    // recent roots of each group are re-listed and their threads noted.
    const ttl = this.config.loose_ttl_days * 86400;
    if (nowS - (this.state.threadScanAt ?? 0) >= this.config.thread_scan_interval_s) {
      let scanOk = true;
      for (const chatId of Object.keys(chats)) {
        try {
          for (const row of await this.feishu.chatMessagesSince(chatId, nowS - this.config.thread_scan_hours * 3600)) {
            if (!row.thread_id) continue;
            const known = this.state.knownThreads[row.thread_id];
            this.state.knownThreads[row.thread_id] = { chat: chatId, at: Math.max(known?.at ?? 0, seconds(Number(row.create_time))) };
          }
        } catch (error) {
          fail(`${chatId}-threads`, error);
          scanOk = false;
        }
      }
      if (scanOk) this.state.threadScanAt = nowS;
      // Keep the most recently active few per group, and nothing older than the TTL.
      // A thread with a live task of ours is polled regardless and is not counted.
      const byChat = {};
      for (const [threadId, info] of Object.entries(this.state.knownThreads)) {
        if (this.state.threads[threadId]) continue;
        if (nowS - info.at > ttl || !chats[info.chat]) delete this.state.knownThreads[threadId];
        else (byChat[info.chat] ??= []).push([threadId, info.at]);
      }
      for (const list of Object.values(byChat)) {
        for (const [threadId] of list.sort((a, b) => b[1] - a[1]).slice(this.config.thread_max_per_chat)) delete this.state.knownThreads[threadId];
      }
    }

    // Threads are polled one by one: the ones our own work opened (looseThreads, for a
    // bounded time) and the discovered ones.
    for (const [threadId, since] of Object.entries(this.state.looseThreads)) {
      if (nowS - since > ttl) {
        delete this.state.looseThreads[threadId];
        delete this.state.threads[threadId];
        delete this.state.threadKeys[threadId];
      }
    }
    const threadStart = (this.state.threadCursor ?? nowS) - OVERLAP_S;
    let threadsOk = true;
    for (const threadId of new Set([...Object.keys(this.state.looseThreads), ...Object.keys(this.state.knownThreads)])) {
      try {
        const rows = (await this.feishu.threadMessages(threadId)).filter((row) => Number(row.create_time) / 1000 >= threadStart).reverse();
        for (const message of rows) await this.process({ ...message, thread_id: threadId }, groupRoute);
        const known = this.state.knownThreads[threadId];
        if (known && rows.length) known.at = Math.max(known.at, ...rows.map((row) => seconds(Number(row.create_time))));
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
      knownThreads: Object.keys(this.state?.knownThreads ?? {}).length,
      pendingApprovals: Object.values(this.state?.approvals ?? {}),
      pendingQuestions: Object.values(this.state?.questions ?? {}),
      pendingConfirms: Object.keys(this.state?.confirms ?? {}).length,
      eventCursor: this.state?.eventCursor ?? null,
    };
  }
}

export { messageText };
