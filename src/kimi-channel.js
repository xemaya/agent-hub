import { readServerSentEvents } from './channel.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class KimiChannel {
  constructor({
    connectorUrl,
    token,
    sessionId,
    driver,
    cwd = process.cwd(),
    logger = {},
    retryMs = 2000,
  }) {
    this.connectorUrl = connectorUrl.replace(/\/$/, '');
    this.token = token;
    this.sessionId = sessionId;
    this.driver = driver;
    this.worker = { runtime_session_id: sessionId, cwd, metadata: {} };
    this.logger = logger;
    this.retryMs = retryMs;
    this.state = 'connecting';
    this.stopped = false;
    this.abort = null;
    this.activeCommandId = null;
  }

  async start() {
    await this.driver.start?.();
    this.streamLoop();
  }

  async run() {
    return this.driver.run();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  async callConnector(commandId, action, body = {}) {
    const response = await fetch(`${this.connectorUrl}/local/v1/channel/commands/${encodeURIComponent(commandId)}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `Agent Hub rejected the ${action} (HTTP ${response.status})`);
    return payload;
  }

  async execute(event) {
    if (this.activeCommandId) throw new Error('Kimi Channel received concurrent commands');
    this.activeCommandId = event.command_id;
    let acknowledged = false;
    try {
      this.driver.showInbound?.(event.content);
      const result = await this.driver.execute({
        worker: this.worker,
        command: {
          command_id: event.command_id,
          kind: event.kind,
          input: event.content,
        },
        onOutput() {},
        onState: async () => {
          if (acknowledged) return;
          acknowledged = true;
          await this.callConnector(event.command_id, 'ack');
        },
      });
      if (this.stopped) return;
      await this.callConnector(event.command_id, 'report', {
        status: 'succeeded',
        result: result.text,
        output_gap: result.output_gap === true,
      });
    } catch (error) {
      if (this.stopped) return;
      this.logger.error?.(`Kimi command failed: ${error.message}`);
      await this.callConnector(event.command_id, 'report', {
        status: 'failed',
        result: error.message,
      });
    } finally {
      this.activeCommandId = null;
    }
  }

  async handleEvent(event) {
    if (['attached', 'waiting_registration', 'rejected'].includes(event.type)) {
      this.state = event.type;
      this.logger.error?.(`Agent Hub channel: ${event.type}${event.reason ? ` (${event.reason})` : ''}`);
      return;
    }
    if (event.type === 'command') await this.execute(event);
  }

  async streamLoop() {
    const query = new URLSearchParams({ runtime: 'kimi', session_id: this.sessionId });
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(`${this.connectorUrl}/local/v1/channel?${query}`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: this.abort.signal,
        });
        if (!response.ok) throw new Error(`Connector refused the channel (HTTP ${response.status})`);
        for await (const event of readServerSentEvents(response.body)) await this.handleEvent(event);
      } catch (error) {
        if (this.stopped) return;
        this.logger.error?.(`Agent Hub channel: ${error.message}`);
      }
      if (this.stopped) return;
      this.state = 'connecting';
      await sleep(this.retryMs);
    }
  }
}
