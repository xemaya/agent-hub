import WebSocket from 'ws';

export function desktopError(message, outcomeUnknown = false) {
  return Object.assign(new Error(message), { code: 'codex_desktop_failed', outcomeUnknown });
}

export function loopbackServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !url.port || url.pathname !== '/') {
    throw new Error('Desktop app-server URL must be ws://127.0.0.1:PORT or ws://[::1]:PORT without credentials');
  }
  return url.href;
}

export class CodexSharedServer {
  constructor({ url, WebSocketClass = WebSocket, timeoutMs = 15000 } = {}) {
    this.url = loopbackServerUrl(url);
    this.WebSocketClass = WebSocketClass;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  async connect() {
    this.socket = new this.WebSocketClass(this.url, { maxPayload: 16 * 1024 * 1024 });
    const socket = this.socket;
    socket.on('message', data => {
      try {
        const message = JSON.parse(String(data));
        if (message.method && message.id !== undefined) {
          // Do not answer an approval on the user's behalf, even with a denial.
          // Disconnect if this server routes it here instead of the desktop.
          this.close(desktopError('App-server routed an interactive request to the bridge; handle it in the desktop UI', true));
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(desktopError(message.error.message ?? 'App-server request failed'));
          else pending.resolve(message.result);
        } else this.onNotification?.(message);
      } catch (error) { this.close(desktopError(error.message, true)); }
    });
    socket.on('close', () => this.close(desktopError('Shared Codex app-server disconnected', true)));
    socket.on('error', error => this.close(desktopError(error.message, true)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(desktopError('Shared Codex app-server connection timed out')); this.close(); }, this.timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); reject(desktopError('Shared Codex app-server closed before opening')); });
    });
    await this.request('initialize', {
      clientInfo: { name: 'agent_hub_desktop_bridge', title: 'Agent Hub Desktop Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  }

  request(method, params) {
    if (this.closed || this.socket?.readyState !== this.WebSocketClass.OPEN) return Promise.reject(desktopError('Shared Codex app-server is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = desktopError(`Shared Codex request timed out: ${method}`, method === 'thread/queue/add');
        this.pending.delete(id);
        reject(error);
        this.close(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.close(desktopError(error.message, true)); });
    });
  }

  close(error = desktopError('Desktop bridge closed', true)) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.socket?.terminate();
    this.onClose?.(error);
  }
}
