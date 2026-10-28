import { randomUUID } from 'node:crypto';
import { CodexSharedServer, desktopError } from '../codex-shared-server.js';

// Attaches to the desktop's already-loaded thread on the SAME app-server.
// It neither spawns Codex nor loads a persisted desktop thread in another engine.
export class CodexDesktopDriver {
  constructor({ sessionId, url, client = new CodexSharedServer({ url }) } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('A verified native desktop Session ID is required');
    this.sessionId = sessionId;
    this.client = client;
    this.active = null;
    this.closed = false;
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    client.onNotification = message => this.handleMessage(message);
    client.onClose = error => {
      this.closed = true;
      this.active?.reject(error);
      this.resolveExit(this.stopping ? 0 : 1);
      this.onClose?.();
    };
  }

  async start() {
    if (this.started) return;
    try {
      await this.client.connect();
      let cursor = null, loaded = false;
      do {
        const page = await this.client.request('thread/loaded/list', { cursor });
        loaded ||= page.data.includes(this.sessionId);
        cursor = page.nextCursor;
      } while (!loaded && cursor);
      if (!loaded) throw desktopError('This desktop thread is not loaded on the shared server. Reopen it in the desktop connected through CODEX_APP_SERVER_WS_URL; refusing to resume it in another runtime.');
      const read = await this.client.request('thread/read', { threadId: this.sessionId, includeTurns: false });
      if (read.thread?.id !== this.sessionId || read.thread.status?.type === 'notLoaded') throw desktopError('Desktop thread identity or live ownership could not be verified');
      // On this already-verified running engine, resume only subscribes this
      // additional client. No model/permission/config overrides are supplied.
      const attached = await this.client.request('thread/resume', { threadId: this.sessionId, excludeTurns: true });
      if (attached.thread?.id !== this.sessionId) throw desktopError('Shared app-server attached a different thread');
      this.started = true;
    } catch (error) { this.client.close(error); throw error; }
  }

  async execute({ command, onState }) {
    if (!this.started || this.closed) throw desktopError('Desktop bridge is not connected');
    if (this.active) throw desktopError('Desktop bridge already has a Hub command in flight');
    const clientMessageId = randomUUID();
    const marker = `[Agent Hub command ${command.command_id}; receipt ${clientMessageId}]`;
    let resolve, reject;
    const completion = new Promise((a, b) => { resolve = a; reject = b; });
    completion.catch(() => {});
    const job = { clientMessageId, marker, turnId: null, text: '', resolve, reject, acknowledged: false, events: [] };
    this.active = job;
    try {
      const result = await this.client.request('thread/queue/add', {
        threadId: this.sessionId, clientUserMessageId: clientMessageId,
        input: [{ type: 'text', text: `${marker}\n\n${command.input}` }],
      });
      const submission = result?.queuedSubmission;
      if (!submission?.id || submission.clientUserMessageId !== clientMessageId) {
        throw desktopError('Native queued submission identity did not match the Hub command', true);
      }
      job.submissionId = submission.id;
      await onState?.({ started: true, session_id: this.sessionId, prompt_id: command.command_id });
      job.acknowledged = true;
      for (const event of job.events.splice(0)) this.handleMessage(event);
      return await completion;
    } catch (error) {
      // A request may have reached the native queue even when the response was
      // lost. Detach instead of replaying or interrupting the user's thread.
      if (error.outcomeUnknown || (job.submissionId && !job.finished)) this.client.close(desktopError(error.message, true));
      throw error;
    } finally { this.active = null; }
  }

  handleMessage(message) {
    const job = this.active;
    const p = message.params ?? {};
    if (!job || p.threadId !== this.sessionId) return;
    if (!job.acknowledged) { job.events.push(message); return; }
    const turnId = p.turnId ?? p.turn?.id;
    if (['item/started', 'item/completed'].includes(message.method) && p.item?.type === 'userMessage') {
      const text = (p.item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const ours = p.item.id === job.clientMessageId || text.startsWith(job.marker);
      if (ours) {
        if (job.turnId && job.turnId !== turnId) return this.client.close(desktopError('Hub submission appeared in multiple native turns', true));
        job.turnId = turnId;
      } else if (job.turnId === turnId) {
        this.client.close(desktopError('Desktop user input changed the active Hub turn; result attribution is unknown', true));
      }
      return;
    }
    if (!job.turnId || turnId !== job.turnId) return;
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage'
      && (!p.item.phase || p.item.phase === 'final_answer') && typeof p.item.text === 'string') job.text = p.item.text;
    if (message.method === 'turn/completed') {
      job.finished = true;
      if (p.turn.status === 'completed') job.resolve({ text: job.text, session_id: this.sessionId, output_gap: !job.text });
      else job.reject(desktopError(p.turn.error?.message ?? `Desktop turn ${p.turn.status}`));
    }
  }

  run() { return this.exit; }
  close() { this.stopping = true; this.client.close(); }
}
