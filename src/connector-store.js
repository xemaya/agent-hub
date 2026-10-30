import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createToken } from './ids.js';

const timestamp = () => new Date().toISOString();

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
    this.state.mailNotifications[messageId] = structuredClone(notice);
    await this.save();
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
