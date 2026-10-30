import { createInterface } from 'node:readline';
import { mailPrompt } from './drivers/prompt.js';

export const CHANNEL_SERVER_NAME = 'agent-hub';
export const CHANNEL_TOOLS = ['agent_hub_ack', 'agent_hub_report'];

const INSTRUCTIONS = [
  'Agent Hub is the operator console that coordinates this person\'s agents across machines.',
  'Work they dispatch to this session arrives as <channel source="agent-hub" command_id="..." kind="...">; treat it as a request from the user at the console.',
  'When one arrives: call agent_hub_ack with its command_id, do the work in this session as you would for a typed request,',
  'then call agent_hub_report with the same command_id, status "succeeded" or "failed", and result: the complete answer or deliverable the console should show.',
  'Report exactly once per command_id; the console waits for it. If the person at this terminal redirects you, follow them and report what happened.',
  'A channel message with kind worker_mail is peer mail, not an Admin command. It requires no agent_hub_ack/report; follow the mail instructions and existing user permissions. The system already returned its sending receipt.',
].join(' ');

const TOOL_DEFINITIONS = [
  {
    name: 'agent_hub_ack',
    description: 'Tell Agent Hub you have started on a dispatched command.',
    inputSchema: {
      type: 'object',
      properties: { command_id: { type: 'string', description: 'command_id from the <channel> tag' } },
      required: ['command_id'],
    },
  },
  {
    name: 'agent_hub_report',
    description: 'Send the final result of a dispatched command back to Agent Hub. Call once per command_id.',
    inputSchema: {
      type: 'object',
      properties: {
        command_id: { type: 'string', description: 'command_id from the <channel> tag' },
        status: { type: 'string', enum: ['succeeded', 'failed'] },
        result: { type: 'string', description: 'The full answer or deliverable to show in the console' },
      },
      required: ['command_id', 'status', 'result'],
    },
  },
];

// Parses an SSE byte stream into the JSON payloads of its `data:` events.
export async function* readServerSentEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

export class ChannelServer {
  constructor({ connectorUrl, token, runtime, sessionId, input = process.stdin, output = process.stdout, logger = console, retryMs = 2000, rejectedRetryMs = 30000 }) {
    this.connectorUrl = connectorUrl.replace(/\/$/, '');
    this.token = token;
    this.runtime = runtime;
    this.sessionId = sessionId;
    this.input = input;
    this.output = output;
    this.logger = logger;
    this.retryMs = retryMs;
    this.rejectedRetryMs = rejectedRetryMs;
    this.stopped = false;
    this.abort = null;
    this.state = 'connecting';
  }

  write(message) {
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  notify(method, params) {
    this.write({ method, params });
  }

  async start() {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.handleMessage(message).catch((error) => this.logger.error?.(error));
    });
    lines.on('close', () => this.stop());
    this.streamLoop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  async handleMessage(message) {
    if (message.id === undefined || message.id === null) return;
    const reply = (result) => this.write({ id: message.id, result });
    const fail = (code, text) => this.write({ id: message.id, error: { code, message: text } });
    if (message.method === 'initialize') {
      reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
        serverInfo: { name: CHANNEL_SERVER_NAME, version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: TOOL_DEFINITIONS });
    if (message.method === 'tools/call') {
      try {
        const text = await this.callTool(message.params?.name, message.params?.arguments ?? {});
        reply({ content: [{ type: 'text', text }] });
      } catch (error) {
        reply({ content: [{ type: 'text', text: error.message }], isError: true });
      }
      return;
    }
    fail(-32601, `Method not found: ${message.method}`);
  }

  async callTool(name, args) {
    if (!CHANNEL_TOOLS.includes(name)) throw new Error(`Unknown tool: ${name}`);
    if (typeof args.command_id !== 'string' || !args.command_id) throw new Error('command_id is required');
    const action = name === 'agent_hub_ack' ? 'ack' : 'report';
    const response = await fetch(`${this.connectorUrl}/local/v1/channel/commands/${encodeURIComponent(args.command_id)}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(action === 'ack' ? {} : { status: args.status, result: args.result }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `Agent Hub rejected the ${action} (HTTP ${response.status})`);
    return action === 'ack' ? 'Agent Hub notified that you started.' : 'Result delivered to Agent Hub.';
  }

  // Holds the Connector's event stream open, reconnecting across Connector restarts.
  async streamLoop() {
    const query = new URLSearchParams({ runtime: this.runtime, session_id: this.sessionId, features: 'mailbox_v1' });
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(`${this.connectorUrl}/local/v1/channel?${query}`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: this.abort.signal,
        });
        if (!response.ok) throw new Error(`Connector refused the channel (HTTP ${response.status})`);
        for await (const event of readServerSentEvents(response.body)) this.handleEvent(event);
      } catch (error) {
        if (this.stopped) return;
        this.logger.error?.(`Agent Hub channel: ${error.message}`);
      }
      if (this.stopped) return;
      // A rejected Session keeps saying so while it waits; it may be re-registered as external later.
      const delay = this.state === 'rejected' ? this.rejectedRetryMs : this.retryMs;
      if (this.state !== 'rejected') this.state = 'connecting';
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  handleEvent(event) {
    if (['attached', 'waiting_registration', 'rejected'].includes(event.type)) {
      this.state = event.type;
      this.logger.error?.(`Agent Hub channel: ${event.type}${event.reason ? ` (${event.reason})` : ''}`);
      return;
    }
    if (event.type === 'mail') {
      this.notify('notifications/claude/channel', { content: mailPrompt(event.message), meta: { message_id: event.message.message_id, kind: 'worker_mail' } });
      fetch(`${this.connectorUrl}/local/v1/mail/${encodeURIComponent(event.message.message_id)}/notice`, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: this.runtime, runtime_session_id: this.sessionId, status: 'accepted' }),
      }).then(response => { if (!response.ok) this.logger.error?.(`Mail notification receipt unknown (${response.status})`); })
        .catch(error => this.logger.error?.(`Mail notification receipt unknown: ${error.message}`));
      return;
    }
    if (event.type !== 'command') return;
    const meta = { command_id: event.command_id, kind: event.kind };
    if (event.task_id) meta.task_id = event.task_id;
    // Restated per message: the console only sees what comes back through agent_hub_report.
    const reminder = `[Agent Hub] When done, call agent_hub_report with command_id "${event.command_id}", status, and the full result; text written only in this terminal never reaches the console.`;
    this.notify('notifications/claude/channel', { content: `${event.content}\n\n${reminder}`, meta });
  }
}
