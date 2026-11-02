// The few Feishu (Lark) Open API calls a channel bridge needs, over plain fetch.
// The bridge is the only process that holds the bot's credentials: Workers
// never talk to Feishu, they describe what should go out and the bridge sends it.

const TOKEN_EXPIRED = new Set([99991661, 99991663, 99991668]);
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export class FeishuError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.status = status;
  }
}

export class FeishuApi {
  constructor({ appId, appSecret, baseUrl = 'https://open.feishu.cn', fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 20000 }) {
    if (!appId || !appSecret) throw new Error('Feishu app_id and app_secret are required');
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async tenantToken() {
    if (this.token && this.now() < this.tokenExpiresAt - TOKEN_MARGIN_MS) return this.token;
    const payload = await this.raw('POST', '/open-apis/auth/v3/tenant_access_token/internal', { body: { app_id: this.appId, app_secret: this.appSecret } });
    if (payload.code !== 0 || !payload.tenant_access_token) throw new FeishuError(`tenant_access_token failed: ${payload.msg ?? payload.code}`, { code: payload.code });
    this.token = payload.tenant_access_token;
    this.tokenExpiresAt = this.now() + Number(payload.expire ?? 7200) * 1000;
    return this.token;
  }

  async raw(method, pathname, { query = null, body = undefined, token = null } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new FeishuError(`Feishu returned non-JSON (HTTP ${response.status})`, { status: response.status });
      }
      if (!response.ok && payload.code === undefined) throw new FeishuError(`Feishu HTTP ${response.status}`, { status: response.status });
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // One authenticated call; an expired token is refreshed and the call retried once.
  async call(method, pathname, options = {}) {
    let token = await this.tenantToken();
    let payload = await this.raw(method, pathname, { ...options, token });
    if (TOKEN_EXPIRED.has(payload.code)) {
      this.token = null;
      token = await this.tenantToken();
      payload = await this.raw(method, pathname, { ...options, token });
    }
    if (payload.code !== 0) throw new FeishuError(`Feishu ${method} ${pathname} failed: ${payload.code} ${payload.msg ?? ''}`.trim(), { code: payload.code });
    return payload.data ?? {};
  }

  async paged(pathname, query, { maxPages = 20 } = {}) {
    const items = [];
    let pageToken = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.call('GET', pathname, { query: { ...query, page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) } });
      items.push(...(data.items ?? []));
      pageToken = data.page_token;
      if (!data.has_more || !pageToken) return items;
    }
    throw new FeishuError(`Feishu listing ${pathname} exceeded ${maxPages} pages`);
  }

  // Chats the bot is in: { chat_id, name, external, ... }.
  listChats() {
    return this.paged('/open-apis/im/v1/chats', {});
  }

  // Messages of a chat created at or after `startSeconds`, oldest first. In a
  // topic-mode chat this includes replies inside topics; in an ordinary chat it
  // does not (see threadMessages).
  chatMessagesSince(chatId, startSeconds) {
    return this.paged('/open-apis/im/v1/messages', {
      container_id_type: 'chat', container_id: chatId, start_time: String(Math.floor(startSeconds)), sort_type: 'ByCreateTimeAsc',
    });
  }

  // The newest page of a thread, newest first. The thread container ignores
  // time filters, so callers filter locally.
  async threadMessages(threadId) {
    const data = await this.call('GET', '/open-apis/im/v1/messages', { query: { container_id_type: 'thread', container_id: threadId, sort_type: 'ByCreateTimeDesc', page_size: 50 } });
    return data.items ?? [];
  }

  async getMessage(messageId) {
    const data = await this.call('GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
    return data.items?.[0] ?? null;
  }

  // `uuid` is Feishu's idempotency key: the same uuid within 7 days sends once.
  async replyText(messageId, text, { uuid, inThread = true } = {}) {
    const data = await this.call('POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: inThread, ...(uuid ? { uuid } : {}) },
    });
    return data.message_id ?? null;
  }

  async sendText(receiveId, text, { uuid } = {}) {
    const type = receiveId.startsWith('oc_') ? 'chat_id' : receiveId.startsWith('ou_') ? 'open_id' : receiveId.startsWith('on_') ? 'union_id' : 'user_id';
    const data = await this.call('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: type },
      body: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }), ...(uuid ? { uuid } : {}) },
    });
    return data.message_id ?? null;
  }
}

// Plain text of a text or post message; other kinds read as empty.
export function messageText(message) {
  if (!message || message.deleted || !['text', 'post'].includes(message.msg_type)) return '';
  let content;
  try {
    content = JSON.parse(message.body?.content ?? '{}');
  } catch {
    return '';
  }
  if (message.msg_type === 'text') return String(content.text ?? '');
  const body = 'content' in content ? content : Object.values(content)[0] ?? {};
  return (body.content ?? []).flat().filter((node) => node && typeof node === 'object').map((node) => node.text ?? '').join(' ');
}

// Mention placeholders ("@_user_1") become readable names.
export function readableText(message) {
  let text = messageText(message);
  for (const mention of message?.mentions ?? []) {
    if (mention.key) text = text.split(mention.key).join(`@${mention.name ?? ''}`);
  }
  return text.trim();
}
