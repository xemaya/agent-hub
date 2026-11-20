import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createToken } from './ids.js';

const timestamp = () => new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['succeeded', 'failed']);

export class ConnectorStore {
  constructor(dataDir, state) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'connector.json');
    this.state = state;
    this.writeChain = Promise.resolve();
  }

  static async load(dataDir, { hubUrl, name, hostname }) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'connector.json');
    let state;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot load Connector state: ${error.message}`);
      state = null;
    }
    state ??= {
      version: 1,
      connectorId: null,
      token: null,
      localToken: createToken('ah_local'),
      hubUrl,
      name,
      hostname,
      workers: [],
      commands: [],
    };
    state.hubUrl = hubUrl ?? state.hubUrl;
    state.name = name ?? state.name;
    state.hostname = hostname ?? state.hostname;
    state.localToken ??= createToken('ah_local');
    state.workers ??= [];
    state.workers = state.workers.map((worker) => (
      worker.mode === 'external'
        ? worker
        : { ...worker, mode: 'external', push_capable: false, driver_state: {} }
    ));
    state.commands ??= [];
    state.mailNotifications ??= {};
    // Notices written before saved_at existed age from the first load that sees them.
    for (const notice of Object.values(state.mailNotifications)) notice.saved_at ??= timestamp();
    const store = new ConnectorStore(dataDir, state);
    await store.save();
    return store;
  }

  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }

  get credentials() {
    return {
      connectorId: this.state.connectorId,
      token: this.state.token,
      localToken: this.state.localToken,
    };
  }

  get hubUrl() {
    return this.state.hubUrl;
  }

  get name() {
    return this.state.name;
  }

  get hostname() {
    return this.state.hostname;
  }

  async setEnrollment({ hubUrl, connectorId, token }) {
    this.state.hubUrl = hubUrl;
    this.state.connectorId = connectorId;
    this.state.token = token;
    await this.save();
  }

  listWorkers({ includeRetired = false } = {}) {
    return structuredClone(this.state.workers.filter((worker) => includeRetired || !worker.retired_at));
  }

  getWorker(workerId) {
    const worker = this.state.workers.find((item) => item.worker_id === workerId);
    return worker ? structuredClone(worker) : null;
  }

  getWorkerBySession(runtime, sessionId) {
    const worker = this.state.workers.find((item) => (
      item.runtime === runtime && item.runtime_session_id === sessionId
    ));
    return worker ? structuredClone(worker) : null;
  }

  setWorkerPushCapability(workerId, pushCapable) {
    const worker = this.state.workers.find((item) => item.worker_id === workerId);
    if (!worker) return null;
    worker.push_capable = Boolean(pushCapable);
    return this.getWorker(workerId);
  }

  async upsertWorker(worker) {
    const index = this.state.workers.findIndex((item) => item.worker_id === worker.worker_id);
    if (index === -1) this.state.workers.push(structuredClone(worker));
    else this.state.workers[index] = { ...this.state.workers[index], ...structuredClone(worker) };
    await this.save();
    return this.getWorker(worker.worker_id);
  }

  async retireWorker(workerId, { retiredAt = timestamp() } = {}) {
    const worker = this.state.workers.find((item) => item.worker_id === workerId);
    if (!worker) return null;
    if (!worker.retired_at) {
      worker.retired_at = retiredAt;
      worker.work_state = 'idle';
      worker.current_task_id = null;
      await this.save();
    }
    return this.getWorker(workerId);
  }

  async updateDriverState(workerId, driverState) {
    const worker = this.state.workers.find((item) => item.worker_id === workerId);
    if (!worker) throw new Error('Worker not found');
    worker.driver_state = structuredClone(driverState);
    await this.save();
  }

  getCommand(commandId) {
    const command = this.state.commands.find((item) => item.command_id === commandId);
    return command ? structuredClone(command) : null;
  }

  listCommands() {
    return structuredClone(this.state.commands);
  }

  getMailNotification(messageId) {
    const notice = this.state.mailNotifications?.[messageId];
    return notice ? structuredClone(notice) : null;
  }

  async saveMailNotification(messageId, notice) {
    this.state.mailNotifications ??= {};
    this.state.mailNotifications[messageId] = { ...structuredClone(notice), saved_at: timestamp() };
    await this.save();
  }

  // The Hub has the final state of this command, or no longer has the command at all,
  // so it will never dispatch it again and the local record can eventually go.
  async markCommandSynced(commandId) {
    const command = this.state.commands.find((item) => item.command_id === commandId);
    if (!command || !TERMINAL.has(command.status) || command.hub_synced_at) return false;
    command.hub_synced_at = timestamp();
    await this.save();
    return true;
  }

  // Every command stays in connector.json, with its directory and task snapshot, and the
  // whole file is rewritten on each change. Drop finished commands the Hub has confirmed
  // once they are a week old, and mail notices after a month. An unconfirmed command is
  // kept however old: a Hub that still has it queued would otherwise run it again.
  async prune({ now = Date.now(), commandMaxAgeMs = 7 * DAY_MS, mailMaxAgeMs = 30 * DAY_MS } = {}) {
    const commandCutoff = new Date(now - commandMaxAgeMs).toISOString();
    const mailCutoff = new Date(now - mailMaxAgeMs).toISOString();
    const before = this.state.commands.length;
    this.state.commands = this.state.commands.filter((command) => !(
      TERMINAL.has(command.status) && command.hub_synced_at && (command.finished_at ?? command.updated_at ?? '') < commandCutoff
    ));
    let mail = 0;
    for (const [messageId, notice] of Object.entries(this.state.mailNotifications)) {
      if ((notice.saved_at ?? '') < mailCutoff) {
        delete this.state.mailNotifications[messageId];
        mail += 1;
      }
    }
    const commands = before - this.state.commands.length;
    if (commands || mail) await this.save();
    return { commands, mail };
  }

  nextAcceptedCommand(workerId) {
    const command = this.state.commands.find((item) => (
      item.worker_id === workerId && item.status === 'accepted'
    ));
    return command ? structuredClone(command) : null;
  }

  async acceptCommand(command) {
    const existing = this.getCommand(command.command_id);
    if (existing) return existing;
    const accepted = {
      command_id: command.command_id,
      task_id: command.task_id,
      worker_id: command.worker_id,
      sender_worker_id: command.sender_worker_id ?? null,
      sender_name: command.sender_name ?? null,
      kind: command.kind,
      input: command.input,
      task_snapshot: command.task ?? null,
      directory: command.directory ?? [],
      status: 'accepted',
      accepted_at: timestamp(),
      result: null,
      error: null,
      outcome_unknown: false,
    };
    this.state.commands.push(accepted);
    await this.save();
    return structuredClone(accepted);
  }

  async updateCommand(commandId, patch) {
    const command = this.state.commands.find((item) => item.command_id === commandId);
    if (!command) return null;
    const now = timestamp();
    const changes = structuredClone(patch);
    if (changes.status === 'running' && !command.started_at) changes.started_at = now;
    if (['succeeded', 'failed'].includes(changes.status) && !command.finished_at) {
      changes.finished_at = now;
    }
    Object.assign(command, changes, { updated_at: now });
    await this.save();
    return this.getCommand(commandId);
  }

  async recoverInterruptedCommands() {
    const interrupted = this.state.commands.filter((command) => command.status === 'running');
    for (const command of interrupted) {
      command.status = 'failed';
      command.outcome_unknown = true;
      command.error = {
        message: 'Connector stopped while this command was running; outcome is unknown',
        code: 'connector_interrupted',
      };
      command.updated_at = timestamp();
      command.finished_at = command.updated_at;
    }
    if (interrupted.length) await this.save();
    return structuredClone(interrupted);
  }

  async failRunningCommands() {
    return this.recoverInterruptedCommands();
  }
}
