// Feishu 事件订阅 over the long connection (「使用长连接接收事件」): the app asks
// /callback/ws/endpoint for a WebSocket URL, keeps it open with pings, and receives each
// event as a protobuf frame whose payload is the event JSON (the same shape a webhook push
// has, never encrypted). Each event frame is answered with the same frame carrying
// {"code":200}. Written from the protocol the official node SDK speaks (pbbp2.Frame), so
// the bridge needs no 30 MB SDK on the Hub box.
import WebSocket from 'ws';

const CONTROL = 0;
const DATA = 1;
const DEFAULTS = { pingIntervalMs: 120_000, reconnectIntervalMs: 120_000, reconnectNonceMs: 30_000, reconnectCount: -1 };

// ---- pbbp2 wire format: a minimal protobuf codec for Frame / Header ------------------

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let position = offset;
  for (;;) {
    if (position >= buffer.length) throw new Error('truncated varint');
    const byte = buffer[position];
    position += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, position];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
}

function writeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function readFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    let tag;
    [tag, offset] = readVarint(buffer, offset);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let value;
      [value, offset] = readVarint(buffer, offset);
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      let length;
      [length, offset] = readVarint(buffer, offset);
      const end = offset + Number(length);
      if (end > buffer.length) throw new Error('truncated length-delimited field');
      fields.push({ field, wire, value: buffer.subarray(offset, end) });
      offset = end;
    } else if (wire === 1) {
      fields.push({ field, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 5) {
      fields.push({ field, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

const lengthDelimited = (field, bytes) => Buffer.concat([writeVarint((field << 3) | 2), writeVarint(bytes.length), bytes]);
const varintField = (field, value) => Buffer.concat([writeVarint(field << 3), writeVarint(value)]);

export function decodeFrame(buffer) {
  const frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [], payload: null, payloadEncoding: null, payloadType: null, LogIDNew: null };
  for (const { field, wire, value } of readFields(buffer)) {
    if (field === 1 && wire === 0) frame.SeqID = value;
    else if (field === 2 && wire === 0) frame.LogID = value;
    else if (field === 3 && wire === 0) frame.service = Number(BigInt.asIntN(32, value));
    else if (field === 4 && wire === 0) frame.method = Number(BigInt.asIntN(32, value));
    else if (field === 5 && wire === 2) {
      const header = { key: '', value: '' };
      for (const part of readFields(value)) {
        if (part.field === 1 && part.wire === 2) header.key = part.value.toString('utf8');
        if (part.field === 2 && part.wire === 2) header.value = part.value.toString('utf8');
      }
      frame.headers.push(header);
    } else if (field === 6 && wire === 2) frame.payloadEncoding = value.toString('utf8');
    else if (field === 7 && wire === 2) frame.payloadType = value.toString('utf8');
    else if (field === 8 && wire === 2) frame.payload = Buffer.from(value);
    else if (field === 9 && wire === 2) frame.LogIDNew = value.toString('utf8');
  }
  return frame;
}

export function encodeFrame(frame) {
  const parts = [
    varintField(1, frame.SeqID ?? 0),
    varintField(2, frame.LogID ?? 0),
    varintField(3, BigInt.asUintN(64, BigInt(frame.service ?? 0))),
    varintField(4, BigInt.asUintN(64, BigInt(frame.method ?? 0))),
  ];
  for (const header of frame.headers ?? []) {
    parts.push(lengthDelimited(5, Buffer.concat([lengthDelimited(1, Buffer.from(header.key, 'utf8')), lengthDelimited(2, Buffer.from(header.value, 'utf8'))])));
  }
  if (frame.payloadEncoding) parts.push(lengthDelimited(6, Buffer.from(frame.payloadEncoding, 'utf8')));
  if (frame.payloadType) parts.push(lengthDelimited(7, Buffer.from(frame.payloadType, 'utf8')));
  if (frame.payload) parts.push(lengthDelimited(8, Buffer.from(frame.payload)));
  if (frame.LogIDNew) parts.push(lengthDelimited(9, Buffer.from(frame.LogIDNew, 'utf8')));
  return Buffer.concat(parts);
}

const header = (frame, key) => frame.headers.find((item) => item.key === key)?.value;

// ---- the connection -------------------------------------------------------------------

export class FeishuEventSocket {
  // onEvent(payload) receives each event's JSON (schema 2.0: header + event) once per
  // message_id; its promise is awaited before Feishu is answered, so throwing makes Feishu
  // redeliver. endpoint is overridable for tests.
  constructor({ appId, appSecret, onEvent, fetch: fetchImpl = globalThis.fetch, logger = console, endpoint = 'https://open.feishu.cn/callback/ws/endpoint', now = () => Date.now(), WebSocketImpl = WebSocket }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.onEvent = onEvent;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.endpoint = endpoint;
    this.now = now;
    this.WebSocket = WebSocketImpl;
    this.config = { ...DEFAULTS, url: null, serviceId: 0 };
    this.socket = null;
    this.stopped = true;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.attempts = 0;
    this.fragments = new Map(); // message_id → { parts: [], at }
    this.seen = new Map(); // message_id → when answered; Feishu redelivers unanswered frames
    this.connectedAt = null;
    this.lastEventAt = null;
    this.lastError = null;
  }

  log(text) { this.logger.log?.(`${new Date(this.now()).toISOString()} feishu-events ${text}`); }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* closing */ }
      this.socket = null;
    }
  }

  status() {
    return { connected: this.socket?.readyState === 1, connectedAt: this.connectedAt, lastEventAt: this.lastEventAt, attempts: this.attempts, lastError: this.lastError };
  }

  async pullConfig() {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', locale: 'zh', 'user-agent': 'agent-hub-bridge-feishu' },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.code !== 0 || !payload.data?.URL) {
      const error = new Error(`ws endpoint: code ${payload.code ?? response.status} ${payload.msg ?? ''}`.trim());
      error.retryable = payload.code === undefined || payload.code === 1000040343 /* internal */ || response.status >= 500;
      throw error;
    }
    const url = new URL(payload.data.URL);
    const client = payload.data.ClientConfig ?? {};
    this.config = {
      url: payload.data.URL,
      serviceId: Number(url.searchParams.get('service_id') ?? 0),
      deviceId: url.searchParams.get('device_id') ?? null,
      pingIntervalMs: (client.PingInterval ?? 120) * 1000,
      reconnectIntervalMs: (client.ReconnectInterval ?? 120) * 1000,
      reconnectNonceMs: (client.ReconnectNonce ?? 30) * 1000,
      reconnectCount: client.ReconnectCount ?? -1,
    };
  }

  async connect() {
    if (this.stopped) return;
    try {
      await this.pullConfig();
    } catch (error) {
      this.lastError = error.message;
      this.log(`connect config failed: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    const socket = new this.WebSocket(this.config.url);
    this.socket = socket;
    socket.on('open', () => {
      this.attempts = 0;
      this.connectedAt = new Date(this.now()).toISOString();
      this.lastError = null;
      this.log(`connected (service ${this.config.serviceId}, ping every ${this.config.pingIntervalMs / 1000}s)`);
      this.schedulePing();
    });
    socket.on('message', (data) => { this.onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data)).catch((error) => this.log(`frame failed: ${error.message}`)); });
    socket.on('unexpected-response', (_request, response) => {
      this.lastError = `handshake ${response.statusCode} ${response.headers['handshake-msg'] ?? ''}`.trim();
      this.log(this.lastError);
    });
    socket.on('error', (error) => { this.lastError = error.message; this.log(`socket error: ${error.message}`); });
    socket.on('close', (code) => {
      if (this.socket === socket) this.socket = null;
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      this.log(`closed (${code}); reconnecting`);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    if (this.config.reconnectCount >= 0 && this.attempts > this.config.reconnectCount) {
      this.log(`giving up after ${this.attempts - 1} attempts`);
      return;
    }
    const delay = (this.attempts === 1 ? 1000 : this.config.reconnectIntervalMs) + Math.floor(Math.random() * this.config.reconnectNonceMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => { this.log(`reconnect failed: ${error.message}`); this.scheduleReconnect(); });
    }, delay);
  }

  schedulePing() {
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.send({ SeqID: 0n, LogID: 0n, service: this.config.serviceId, method: CONTROL, headers: [{ key: 'type', value: 'ping' }] });
      this.schedulePing();
    }, this.config.pingIntervalMs);
  }

  send(frame) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(encodeFrame(frame));
    return true;
  }

  async onFrame(buffer) {
    const frame = decodeFrame(buffer);
    const type = header(frame, 'type');
    if (frame.method === CONTROL) {
      if (type === 'pong' && frame.payload?.length) {
        try {
          const pong = JSON.parse(frame.payload.toString('utf8'));
          if (pong.PingInterval) this.config.pingIntervalMs = pong.PingInterval * 1000;
          if (pong.ReconnectInterval) this.config.reconnectIntervalMs = pong.ReconnectInterval * 1000;
          if (pong.ReconnectNonce !== undefined) this.config.reconnectNonceMs = pong.ReconnectNonce * 1000;
          if (pong.ReconnectCount !== undefined) this.config.reconnectCount = pong.ReconnectCount;
        } catch { /* a pong we cannot read changes nothing */ }
      }
      return;
    }
    if (frame.method !== DATA || type !== 'event') return;
    const messageId = header(frame, 'message_id') ?? `${frame.LogID}`;
    const sum = Number(header(frame, 'sum') ?? 1);
    const seq = Number(header(frame, 'seq') ?? 0);
    const merged = this.merge(messageId, sum, seq, frame.payload ?? Buffer.alloc(0));
    if (!merged) return;
    let code = 200;
    if (!this.seen.has(messageId)) {
      let payload;
      try {
        payload = JSON.parse(merged.toString('utf8'));
      } catch (error) {
        this.log(`event ${messageId} is not JSON: ${error.message}`);
        payload = null;
      }
      if (payload) {
        this.lastEventAt = new Date(this.now()).toISOString();
        try {
          await this.onEvent(payload);
          this.seen.set(messageId, this.now());
        } catch (error) {
          code = 500;
          this.log(`event ${messageId} handler failed: ${error.message}`);
        }
      }
    }
    if (this.seen.size > 2000) for (const key of [...this.seen.keys()].slice(0, 1000)) this.seen.delete(key);
    this.send({ ...frame, headers: [...frame.headers, { key: 'biz_rt', value: '0' }], payload: Buffer.from(JSON.stringify({ code }), 'utf8') });
  }

  merge(messageId, sum, seq, part) {
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) throw new Error(`bad fragment metadata sum=${sum} seq=${seq}`);
    if (sum === 1) return part;
    const entry = this.fragments.get(messageId) ?? { parts: new Array(sum).fill(null), at: this.now() };
    entry.parts[seq] = part;
    this.fragments.set(messageId, entry);
    for (const [key, value] of this.fragments) if (this.now() - value.at > 60_000) this.fragments.delete(key);
    if (entry.parts.some((item) => item === null)) return null;
    this.fragments.delete(messageId);
    return Buffer.concat(entry.parts);
  }
}
