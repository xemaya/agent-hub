import { DatabaseSync } from 'node:sqlite';
import { createId } from './ids.js';
import { parseJson, stringifyJson } from './json.js';

const now = () => new Date().toISOString();
const OUTPUT_LIMIT = 256 * 1024;

function connectorView(row) {
  if (!row) return null;
  return {
    connector_id: row.connector_id,
    name: row.name,
    hostname: row.hostname,
    online: Boolean(row.online),
    connected_at: row.connected_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function workerView(row) {
  if (!row) return null;
  return {
    worker_id: row.worker_id,
    connector_id: row.connector_id,
    connector_name: row.connector_name,
    name: row.name,
    runtime: row.runtime,
    mode: row.mode,
    runtime_session_id: row.runtime_session_id,
    capabilities: parseJson(row.capabilities_json, []),
    cwd: row.cwd,
    metadata: parseJson(row.metadata_json, {}),
    push_capable: Boolean(row.push_capable),
    presence: row.connector_online ? 'online' : 'offline',
    work_state: row.work_state,
    current_task_id: row.current_task_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
  };
}

function taskView(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    title: row.title,
    goal: row.goal,
    context: row.context,
    acceptance: parseJson(row.acceptance_json, []),
    assignee_worker_id: row.assignee_worker_id,
    assignee_name: row.assignee_name ?? null,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function commandView(row) {
  if (!row) return null;
  return {
    command_id: row.command_id,
    task_id: row.task_id,
    worker_id: row.worker_id,
    worker_name: row.worker_name,
    kind: row.kind,
    input: row.input,
    status: row.status,
    output_text: row.output_text ?? '',
    output_truncated: Boolean(row.output_truncated),
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    outcome_unknown: Boolean(row.outcome_unknown),
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function eventView(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    connector_id: row.connector_id,
    worker_id: row.worker_id,
    task_id: row.task_id,
    command_id: row.command_id,
    payload: parseJson(row.payload_json, {}),
    created_at: row.created_at,
  };
}

const WORKER_SELECT = `
  SELECT w.*, c.name AS connector_name, c.online AS connector_online
  FROM workers w JOIN connectors c ON c.connector_id = w.connector_id
`;
const TASK_SELECT = `
  SELECT t.*, w.name AS assignee_name
  FROM tasks t LEFT JOIN workers w ON w.worker_id = t.assignee_worker_id
`;
const COMMAND_SELECT = `
  SELECT cmd.*, w.name AS worker_name
  FROM commands cmd JOIN workers w ON w.worker_id = cmd.worker_id
`;

export class HubStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        connector_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hostname TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        online INTEGER NOT NULL DEFAULT 0,
        connected_at TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connectors(connector_id),
        name TEXT NOT NULL,
        runtime TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('managed', 'external')),
        runtime_session_id TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        push_capable INTEGER NOT NULL,
        work_state TEXT NOT NULL,
        current_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(connector_id, runtime, runtime_session_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        context TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        assignee_worker_id TEXT REFERENCES workers(worker_id),
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(task_id),
        worker_id TEXT NOT NULL REFERENCES workers(worker_id),
        kind TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        output_text TEXT NOT NULL DEFAULT '',
        output_truncated INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_json TEXT,
        outcome_unknown INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        connector_id TEXT,
        worker_id TEXT,
        task_id TEXT,
        command_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workers_connector ON workers(connector_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_worker_id);
      CREATE INDEX IF NOT EXISTS idx_commands_worker ON commands(worker_id, status);
      CREATE INDEX IF NOT EXISTS idx_commands_task ON commands(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      PRAGMA user_version = 1;
    `);
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createConnector({ name, hostname = null, tokenHash }) {
    const timestamp = now();
    const connectorId = createId('connector');
    this.db.prepare(`
      INSERT INTO connectors (connector_id, name, hostname, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(connectorId, name, hostname, tokenHash, timestamp);
    return this.getConnector(connectorId);
  }

  getConnector(connectorId) {
    return connectorView(this.db.prepare('SELECT * FROM connectors WHERE connector_id = ?').get(connectorId));
  }

  getConnectorByTokenHash(tokenHash) {
    return connectorView(this.db.prepare('SELECT * FROM connectors WHERE token_hash = ?').get(tokenHash));
  }

  listConnectors() {
    return this.db.prepare('SELECT * FROM connectors ORDER BY created_at DESC, rowid DESC').all().map(connectorView);
  }

  setConnectorOnline(connectorId, online) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE connectors SET online = ?, last_seen_at = ?,
        connected_at = CASE WHEN ? = 1 THEN ? ELSE connected_at END
      WHERE connector_id = ?
    `).run(online ? 1 : 0, timestamp, online ? 1 : 0, timestamp, connectorId);
    this.db.prepare('UPDATE workers SET last_seen_at = ? WHERE connector_id = ?').run(timestamp, connectorId);
    return this.getConnector(connectorId);
  }

  touchConnector(connectorId) {
    const timestamp = now();
    this.db.prepare('UPDATE connectors SET last_seen_at = ? WHERE connector_id = ?').run(timestamp, connectorId);
    this.db.prepare('UPDATE workers SET last_seen_at = ? WHERE connector_id = ?').run(timestamp, connectorId);
  }

  registerWorker(connectorId, data) {
    const timestamp = now();
    const existing = this.db.prepare(`
      SELECT worker_id FROM workers
      WHERE connector_id = ? AND runtime = ? AND runtime_session_id = ?
    `).get(connectorId, data.runtime, data.runtime_session_id);
    const workerId = existing?.worker_id ?? createId('worker');
    this.db.prepare(`
      INSERT INTO workers (
        worker_id, connector_id, name, runtime, mode, runtime_session_id,
        capabilities_json, cwd, metadata_json, push_capable, work_state,
        created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
      ON CONFLICT(connector_id, runtime, runtime_session_id) DO UPDATE SET
        name = excluded.name, mode = excluded.mode, capabilities_json = excluded.capabilities_json,
        cwd = excluded.cwd, metadata_json = excluded.metadata_json,
        push_capable = excluded.push_capable, updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).run(
      workerId,
      connectorId,
      data.name,
      data.runtime,
      data.mode,
      data.runtime_session_id,
      stringifyJson(data.capabilities ?? []),
      data.cwd,
      stringifyJson(data.metadata ?? {}),
      data.mode === 'managed' ? 1 : 0,
      timestamp,
      timestamp,
      timestamp,
    );
    return this.getWorker(workerId);
  }

  getWorker(workerId) {
    return workerView(this.db.prepare(`${WORKER_SELECT} WHERE w.worker_id = ?`).get(workerId));
  }

  getWorkerForConnector(workerId, connectorId) {
    return workerView(this.db.prepare(`${WORKER_SELECT} WHERE w.worker_id = ? AND w.connector_id = ?`).get(workerId, connectorId));
  }

  listWorkers() {
    return this.db.prepare(`${WORKER_SELECT} ORDER BY w.created_at DESC, w.rowid DESC`).all().map(workerView);
  }

  updateWorkerStatus(connectorId, workerId, { work_state: workState, current_task_id: currentTaskId }) {
    const worker = this.getWorkerForConnector(workerId, connectorId);
    if (!worker) return null;
    const timestamp = now();
    this.db.prepare(`
      UPDATE workers SET work_state = ?, current_task_id = ?, updated_at = ?, last_seen_at = ?
      WHERE worker_id = ?
    `).run(
      workState ?? worker.work_state,
      currentTaskId === undefined ? worker.current_task_id : currentTaskId,
      timestamp,
      timestamp,
      workerId,
    );
    return this.getWorker(workerId);
  }

  createTask(data) {
    const timestamp = now();
    const taskId = createId('task');
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks (
          task_id, title, goal, context, acceptance_json, assignee_worker_id,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
      `).run(
        taskId,
        data.title,
        data.goal ?? '',
        data.context ?? '',
        stringifyJson(data.acceptance ?? []),
        data.assignee_worker_id ?? null,
        data.created_by ?? 'admin',
        timestamp,
        timestamp,
      );
      if (data.assignee_worker_id) {
        this.db.prepare('UPDATE workers SET current_task_id = ?, updated_at = ? WHERE worker_id = ?')
          .run(taskId, timestamp, data.assignee_worker_id);
      }
    });
    return this.getTask(taskId);
  }

  getTask(taskId) {
    return taskView(this.db.prepare(`${TASK_SELECT} WHERE t.task_id = ?`).get(taskId));
  }

  listTasks() {
    return this.db.prepare(`${TASK_SELECT} ORDER BY t.created_at DESC, t.rowid DESC`).all().map(taskView);
  }

  updateTask(taskId, data) {
    const current = this.getTask(taskId);
    if (!current) return null;
    const timestamp = now();
    const next = {
      title: data.title ?? current.title,
      goal: data.goal ?? current.goal,
      context: data.context ?? current.context,
      acceptance: data.acceptance ?? current.acceptance,
      status: data.status ?? current.status,
      assignee: data.assignee_worker_id === undefined ? current.assignee_worker_id : data.assignee_worker_id,
    };
    this.transaction(() => {
      this.db.prepare(`
        UPDATE tasks SET title = ?, goal = ?, context = ?, acceptance_json = ?,
          status = ?, assignee_worker_id = ?, updated_at = ? WHERE task_id = ?
      `).run(
        next.title,
        next.goal,
        next.context,
        stringifyJson(next.acceptance),
        next.status,
        next.assignee,
        timestamp,
        taskId,
      );
      if (next.assignee !== current.assignee_worker_id) {
        if (current.assignee_worker_id) {
          this.db.prepare('UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE worker_id = ? AND current_task_id = ?')
            .run(timestamp, current.assignee_worker_id, taskId);
        }
        if (next.assignee) {
          this.db.prepare('UPDATE workers SET current_task_id = ?, updated_at = ? WHERE worker_id = ?')
            .run(taskId, timestamp, next.assignee);
        }
      }
      if (next.status === 'done' || next.status === 'cancelled') {
        this.db.prepare('UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE current_task_id = ?')
          .run(timestamp, taskId);
      }
    });
    return this.getTask(taskId);
  }

  createCommand(data) {
    const timestamp = now();
    const commandId = createId('cmd');
    const status = data.push_capable ? 'queued' : 'waiting_manual';
    this.db.prepare(`
      INSERT INTO commands (command_id, task_id, worker_id, kind, input, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      commandId,
      data.task_id ?? null,
      data.worker_id,
      data.kind ?? 'prompt',
      data.input,
      status,
      timestamp,
    );
    return this.getCommand(commandId);
  }

  getCommand(commandId) {
    return commandView(this.db.prepare(`${COMMAND_SELECT} WHERE cmd.command_id = ?`).get(commandId));
  }

  listCommands({ workerId, taskId, limit = 200 } = {}) {
    const conditions = [];
    const values = [];
    if (workerId) {
      conditions.push('cmd.worker_id = ?');
      values.push(workerId);
    }
    if (taskId) {
      conditions.push('cmd.task_id = ?');
      values.push(taskId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`${COMMAND_SELECT} ${where} ORDER BY cmd.created_at DESC, cmd.rowid DESC LIMIT ?`)
      .all(...values, limit).map(commandView);
  }

  listQueuedCommands(connectorId) {
    return this.db.prepare(`
      ${COMMAND_SELECT}
      WHERE w.connector_id = ? AND cmd.status = 'queued' AND w.push_capable = 1
      ORDER BY cmd.created_at ASC, cmd.rowid ASC
    `).all(connectorId).map(commandView);
  }

  acceptCommand(commandId, connectorId) {
    this.db.prepare(`
      UPDATE commands SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?)
      WHERE command_id = ? AND status = 'queued'
        AND worker_id IN (SELECT worker_id FROM workers WHERE connector_id = ?)
    `).run(now(), commandId, connectorId);
    return this.getCommand(commandId);
  }

  startCommand(commandId, connectorId) {
    this.db.prepare(`
      UPDATE commands SET status = 'running', started_at = COALESCE(started_at, ?)
      WHERE command_id = ? AND status IN ('queued', 'accepted')
        AND worker_id IN (SELECT worker_id FROM workers WHERE connector_id = ?)
    `).run(now(), commandId, connectorId);
    return this.getCommand(commandId);
  }

  appendCommandOutput(commandId, connectorId, chunk) {
    const current = this.getCommand(commandId);
    if (!current || current.worker_id !== this.getWorkerForConnector(current.worker_id, connectorId)?.worker_id) return null;
    let output = current.output_text + String(chunk ?? '');
    let truncated = current.output_truncated;
    if (output.length > OUTPUT_LIMIT) {
      output = output.slice(-OUTPUT_LIMIT);
      truncated = true;
    }
    this.db.prepare('UPDATE commands SET output_text = ?, output_truncated = ? WHERE command_id = ?')
      .run(output, truncated ? 1 : 0, commandId);
    return this.getCommand(commandId);
  }

  finishCommand(commandId, connectorId, { status, result = null, error = null, outcomeUnknown = false }) {
    const current = this.getCommand(commandId);
    if (!current || !this.getWorkerForConnector(current.worker_id, connectorId)) return null;
    if (['succeeded', 'failed'].includes(current.status)) return current;
    const timestamp = now();
    this.db.prepare(`
      UPDATE commands SET status = ?, result_json = ?, error_json = ?, outcome_unknown = ?, finished_at = ?
      WHERE command_id = ?
    `).run(status, stringifyJson(result), stringifyJson(error), outcomeUnknown ? 1 : 0, timestamp, commandId);
    return this.getCommand(commandId);
  }

  recordEvent({ event_type: eventType, actor_type: actorType, actor_id: actorId, ...refs }) {
    const eventId = createId('evt');
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO events (
        event_id, event_type, actor_type, actor_id, connector_id, worker_id,
        task_id, command_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      eventType,
      actorType,
      actorId,
      refs.connector_id ?? null,
      refs.worker_id ?? null,
      refs.task_id ?? null,
      refs.command_id ?? null,
      stringifyJson(refs.payload ?? {}),
      timestamp,
    );
    return eventView(this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
  }

  listEvents(limit = 300) {
    return this.db.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).map(eventView);
  }
}
