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
    retired_at: row.retired_at ?? null,
  };
}

function workerDirectoryView(worker) {
  if (!worker) return null;
  return {
    worker_id: worker.worker_id,
    connector_name: worker.connector_name,
    name: worker.name,
    runtime: worker.runtime,
    capabilities: worker.capabilities,
    description: typeof worker.metadata?.description === 'string' ? worker.metadata.description.slice(0, 2000) : '',
    push_capable: worker.push_capable,
    presence: worker.presence,
    work_state: worker.work_state,
  };
}

function taskView(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    task_number: row.task_number == null ? null : Number(row.task_number),
    title: row.title,
    goal: row.goal,
    context: row.context,
    acceptance: parseJson(row.acceptance_json, []),
    assignee_worker_id: row.assignee_worker_id,
    assignee_name: row.assignee_name ?? null,
    status: row.status,
    deleted_at: row.deleted_at ?? null,
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
    sender_worker_id: row.sender_worker_id ?? null,
    sender_name: row.sender_name ?? null,
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
    last_activity_at: row.last_activity_at ?? null,
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

function coordinatorConfigView(row) {
  if (!row) return { worker_id: null, enabled: false, max_steps: 4, updated_at: null };
  return {
    worker_id: row.worker_id,
    enabled: Boolean(row.enabled),
    max_steps: row.max_steps,
    updated_at: row.updated_at,
  };
}

function orchestrationView(row) {
  if (!row) return null;
  return {
    orchestration_id: row.orchestration_id,
    parent_task_id: row.parent_task_id,
    coordinator_worker_id: row.coordinator_worker_id,
    status: row.status,
    summary: row.summary,
    steps: parseJson(row.steps_json, []),
    error: parseJson(row.error_json, null),
    auto_start: row.auto_start === undefined ? true : Boolean(row.auto_start),
    source_message_id: row.source_message_id ?? null,
    review_reason: row.review_reason ?? '',
    recovery_count: Number(row.recovery_count ?? 0),
    review_command_id: row.review_command_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function chatMessageView(row) {
  if (!row) return null;
  return {
    message_id: row.message_id,
    role: row.role,
    content: row.content,
    status: row.status,
    request_id: row.request_id,
    command_id: row.command_id,
    task_id: row.task_id,
    source_key: row.source_key,
    mentions: parseJson(row.mentions_json ?? '[]', []),
    conversation_epoch: Number(row.conversation_epoch ?? 0),
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
  SELECT cmd.*, w.name AS worker_name, sender.name AS sender_name
  FROM commands cmd
  JOIN workers w ON w.worker_id = cmd.worker_id
  LEFT JOIN workers sender ON sender.worker_id = cmd.sender_worker_id
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
        mode TEXT NOT NULL DEFAULT 'external' CHECK(mode = 'external'),
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
        retired_at TEXT,
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
        sender_worker_id TEXT REFERENCES workers(worker_id),
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
        last_activity_at TEXT,
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
      CREATE TABLE IF NOT EXISTS coordinator_config (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        worker_id TEXT REFERENCES workers(worker_id),
        enabled INTEGER NOT NULL,
        max_steps INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordinator_orchestrations (
        orchestration_id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
        coordinator_worker_id TEXT NOT NULL REFERENCES workers(worker_id),
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        auto_start INTEGER NOT NULL DEFAULT 1,
        source_message_id TEXT UNIQUE,
        review_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordinator_chat_messages (
        message_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('user', 'coordinator', 'activity')),
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending', 'done', 'failed')),
        request_id TEXT UNIQUE,
        command_id TEXT UNIQUE REFERENCES commands(command_id),
        task_id TEXT REFERENCES tasks(task_id),
        source_key TEXT UNIQUE,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        conversation_epoch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordinator_chat_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_workers_connector ON workers(connector_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_worker_id);
      CREATE INDEX IF NOT EXISTS idx_commands_worker ON commands(worker_id, status);
      CREATE INDEX IF NOT EXISTS idx_commands_task ON commands(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_coordinator_orchestrations_status ON coordinator_orchestrations(status);
      CREATE INDEX IF NOT EXISTS idx_coordinator_chat_created ON coordinator_chat_messages(created_at);
    `);
    this.migrate();
  }

  migrate() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(coordinator_orchestrations)').all().map((column) => column.name));
    const additions = {
      auto_start: 'INTEGER NOT NULL DEFAULT 1',
      source_message_id: 'TEXT',
      review_reason: "TEXT NOT NULL DEFAULT ''",
      recovery_count: 'INTEGER NOT NULL DEFAULT 0',
      review_command_id: 'TEXT',
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE coordinator_orchestrations ADD COLUMN ${name} ${definition}`);
    }
    const chatColumns = new Set(this.db.prepare('PRAGMA table_info(coordinator_chat_messages)').all().map((column) => column.name));
    if (!chatColumns.has('mentions_json')) {
      this.db.exec("ALTER TABLE coordinator_chat_messages ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!chatColumns.has('conversation_epoch')) {
      this.db.exec('ALTER TABLE coordinator_chat_messages ADD COLUMN conversation_epoch INTEGER NOT NULL DEFAULT 0');
    }
    const workerColumns = new Set(this.db.prepare('PRAGMA table_info(workers)').all().map((column) => column.name));
    if (!workerColumns.has('retired_at')) {
      this.db.exec('ALTER TABLE workers ADD COLUMN retired_at TEXT');
    }
    const taskColumns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name));
    if (!taskColumns.has('task_number')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN task_number INTEGER');
    }
    if (!taskColumns.has('deleted_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT');
    }
    const commandColumns = new Set(this.db.prepare('PRAGMA table_info(commands)').all().map((column) => column.name));
    if (!commandColumns.has('sender_worker_id')) {
      this.db.exec('ALTER TABLE commands ADD COLUMN sender_worker_id TEXT REFERENCES workers(worker_id)');
    }
    if (!commandColumns.has('last_activity_at')) {
      this.db.exec('ALTER TABLE commands ADD COLUMN last_activity_at TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_number_sequence (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        next_number INTEGER NOT NULL
      );
      UPDATE tasks SET task_number = (
        SELECT COUNT(*) FROM tasks AS previous WHERE previous.rowid <= tasks.rowid
      ) WHERE task_number IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_task_number ON tasks(task_number);
      INSERT INTO task_number_sequence (singleton, next_number)
        SELECT 1, COALESCE(MAX(task_number), 0) + 1 FROM tasks WHERE true
      ON CONFLICT(singleton) DO UPDATE SET
        next_number = MAX(task_number_sequence.next_number, excluded.next_number);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_orchestrations_source
        ON coordinator_orchestrations(source_message_id) WHERE source_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_commands_sender ON commands(sender_worker_id);
      UPDATE commands SET last_activity_at = COALESCE(started_at, accepted_at, created_at)
        WHERE last_activity_at IS NULL;
      UPDATE workers SET mode = 'external', push_capable = 0 WHERE mode <> 'external';
      PRAGMA user_version = 11;
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
        last_seen_at = excluded.last_seen_at, retired_at = NULL
    `).run(
      workerId,
      connectorId,
      data.name,
      data.runtime,
      'external',
      data.runtime_session_id,
      stringifyJson(data.capabilities ?? []),
      data.cwd,
      stringifyJson(data.metadata ?? {}),
      0,
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

  getWorkerBySession(connectorId, runtime, sessionId) {
    return workerView(this.db.prepare(`${WORKER_SELECT} WHERE w.connector_id = ? AND w.runtime = ? AND w.runtime_session_id = ?`).get(connectorId, runtime, sessionId));
  }

  listWorkers({ includeRetired = false } = {}) {
    const where = includeRetired ? '' : 'WHERE w.retired_at IS NULL';
    return this.db.prepare(`${WORKER_SELECT} ${where} ORDER BY w.created_at DESC, w.rowid DESC`).all().map(workerView);
  }

  listWorkerDirectory({ excludeWorkerId = null } = {}) {
    return this.listWorkers()
      .filter((worker) => worker.worker_id !== excludeWorkerId)
      .map(workerDirectoryView);
  }

  retireWorker(workerId, { connectorId = null } = {}) {
    return this.transaction(() => {
      const worker = this.getWorker(workerId);
      if (!worker || (connectorId && worker.connector_id !== connectorId)) return null;
      if (worker.retired_at) return worker;
      const fail = (message, code) => {
        const error = new Error(message);
        error.code = code;
        error.statusCode = 409;
        throw error;
      };
      const config = this.getCoordinatorConfig();
      if (config.enabled && config.worker_id === workerId) {
        fail('The active Coordinator cannot be retired', 'worker_coordinator_active');
      }
      const activeCommands = this.db.prepare(`
        SELECT COUNT(*) AS count FROM commands
        WHERE (worker_id = ? OR sender_worker_id = ?)
          AND status IN ('queued', 'accepted', 'running', 'waiting_manual')
      `).get(workerId, workerId).count;
      const activeTasks = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE assignee_worker_id = ? AND status = 'in_progress'").get(workerId).count;
      const activeSteps = this.listOrchestrations().filter((orchestration) => (
        ['ready', 'planning', 'in_progress'].includes(orchestration.status)
        || (orchestration.status === 'review' && !orchestration.error)
      )).flatMap((orchestration) => (
        orchestration.steps.filter((step) => step.worker_id === workerId && !['done', 'blocked'].includes(step.status))
      ));
      if (activeCommands || activeTasks || activeSteps.length) {
        fail('Worker has active work and cannot be retired', 'worker_active_work');
      }
      const timestamp = now();
      this.db.prepare(`
        UPDATE workers SET retired_at = ?, work_state = 'idle', current_task_id = NULL, updated_at = ?
        WHERE worker_id = ?
      `).run(timestamp, timestamp, workerId);
      return this.getWorker(workerId);
    });
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

  // Push capability always follows the attached interactive Channel.
  setWorkerChannel(connectorId, workerId, attached) {
    const worker = this.getWorkerForConnector(workerId, connectorId);
    if (!worker) return null;
    const timestamp = now();
    this.db.prepare('UPDATE workers SET push_capable = ?, updated_at = ?, last_seen_at = ? WHERE worker_id = ?')
      .run(attached ? 1 : 0, timestamp, timestamp, workerId);
    return this.getWorker(workerId);
  }

  insertTask(data, taskId, timestamp) {
    const taskNumber = this.db.prepare(`
      INSERT INTO task_number_sequence (singleton, next_number) VALUES (1, 2)
      ON CONFLICT(singleton) DO UPDATE SET next_number = task_number_sequence.next_number + 1
      RETURNING next_number - 1 AS task_number
    `).get().task_number;
    this.db.prepare(`
      INSERT INTO tasks (
        task_id, task_number, title, goal, context, acceptance_json, assignee_worker_id,
        status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
    `).run(
      taskId,
      taskNumber,
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
  }

  createTask(data) {
    const taskId = createId('task');
    this.transaction(() => this.insertTask(data, taskId, now()));
    return this.getTask(taskId);
  }

  getTask(taskId) {
    return taskView(this.db.prepare(`${TASK_SELECT} WHERE t.task_id = ?`).get(taskId));
  }

  listTasks({ includeDeleted = false } = {}) {
    const where = includeDeleted ? '' : 'WHERE t.deleted_at IS NULL';
    return this.db.prepare(`${TASK_SELECT} ${where} ORDER BY t.created_at DESC, t.rowid DESC`).all().map(taskView);
  }

  updateTask(taskId, data) {
    const current = this.getTask(taskId);
    if (!current) return null;
    if (current.deleted_at) {
      const error = new Error('Deleted tasks cannot be updated');
      error.code = 'task_deleted';
      error.statusCode = 409;
      throw error;
    }
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

  deleteTask(taskId) {
    const current = this.getTask(taskId);
    if (!current) {
      const error = new Error('Task not found');
      error.code = 'task_not_found';
      error.statusCode = 404;
      throw error;
    }
    const orchestration = this.getOrchestrationByTask(taskId);
    const childPlan = this.listOrchestrations().find((item) => item.steps.some((step) => step.task_id === taskId));
    if (childPlan) {
      const error = new Error('Delete the parent task of an orchestration');
      error.code = 'task_orchestration_child';
      error.statusCode = 409;
      throw error;
    }
    const taskIds = [...new Set([taskId, ...(orchestration?.steps ?? []).map((step) => step.task_id).filter(Boolean)])];
    if (current.deleted_at) return { task: current, deleted_task_ids: taskIds };
    if (orchestration && (['planning', 'in_progress'].includes(orchestration.status) || (orchestration.status === 'review' && !orchestration.error))) {
      const error = new Error('Cannot delete a task while its orchestration is active');
      error.code = 'task_active';
      error.statusCode = 409;
      throw error;
    }
    const placeholders = taskIds.map(() => '?').join(',');
    const activeCommand = this.db.prepare(`SELECT command_id FROM commands WHERE task_id IN (${placeholders}) AND status IN ('queued', 'accepted', 'running', 'waiting_manual') LIMIT 1`).get(...taskIds);
    const activeTask = this.db.prepare(`SELECT task_id FROM tasks WHERE task_id IN (${placeholders}) AND status = 'in_progress' LIMIT 1`).get(...taskIds);
    if (activeCommand || activeTask) {
      const error = new Error('Cannot delete a task while work is active');
      error.code = 'task_active';
      error.statusCode = 409;
      throw error;
    }
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare(`UPDATE tasks SET deleted_at = ? WHERE task_id IN (${placeholders})`).run(timestamp, ...taskIds);
      this.db.prepare(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE current_task_id IN (${placeholders})`).run(timestamp, ...taskIds);
    });
    return { task: this.getTask(taskId), deleted_task_ids: taskIds };
  }

  createCommand(data) {
    if (data.task_id && this.getTask(data.task_id)?.deleted_at) {
      const error = new Error('Deleted tasks cannot receive new commands');
      error.code = 'task_deleted';
      error.statusCode = 409;
      throw error;
    }
    const worker = this.getWorker(data.worker_id);
    if (worker?.retired_at) {
      const error = new Error('Retired Workers cannot receive new commands');
      error.code = 'worker_retired';
      error.statusCode = 409;
      throw error;
    }
    const kind = data.kind ?? 'prompt';
    if ((kind === 'worker_message') !== Boolean(data.sender_worker_id)) {
      const error = new Error('worker_message requires a sender and other commands cannot declare one');
      error.statusCode = 400;
      throw error;
    }
    if (data.sender_worker_id) {
      const sender = this.getWorker(data.sender_worker_id);
      if (!sender || sender.retired_at || sender.worker_id === worker?.worker_id) {
        const error = new Error('Worker message sender is unavailable or matches the recipient');
        error.statusCode = 400;
        throw error;
      }
    }
    const timestamp = now();
    const commandId = createId('cmd');
    const status = data.push_capable ? 'queued' : 'waiting_manual';
    this.db.prepare(`
      INSERT INTO commands (command_id, task_id, worker_id, sender_worker_id, kind, input, status, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      commandId,
      data.task_id ?? null,
      data.worker_id,
      data.sender_worker_id ?? null,
      kind,
      data.input,
      status,
      timestamp,
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

  listRunningCommands() {
    return this.db.prepare(`${COMMAND_SELECT} WHERE cmd.status = 'running' ORDER BY cmd.created_at ASC, cmd.rowid ASC`)
      .all().map(commandView);
  }

  getRunningCommandForWorker(workerId) {
    return commandView(this.db.prepare(`${COMMAND_SELECT} WHERE cmd.worker_id = ? AND cmd.status = 'running' ORDER BY cmd.started_at ASC LIMIT 1`)
      .get(workerId));
  }

  listQueuedCommands(connectorId) {
    return this.db.prepare(`
      ${COMMAND_SELECT}
      WHERE w.connector_id = ? AND cmd.status = 'queued' AND w.push_capable = 1
      ORDER BY cmd.created_at ASC, cmd.rowid ASC
    `).all(connectorId).map(commandView);
  }

  acceptCommand(commandId, connectorId) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE commands SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?), last_activity_at = ?
      WHERE command_id = ? AND status = 'queued'
        AND worker_id IN (SELECT worker_id FROM workers WHERE connector_id = ?)
    `).run(timestamp, timestamp, commandId, connectorId);
    return this.getCommand(commandId);
  }

  startCommand(commandId, connectorId) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE commands SET status = 'running', started_at = COALESCE(started_at, ?), last_activity_at = ?
      WHERE command_id = ? AND status IN ('queued', 'accepted')
        AND worker_id IN (SELECT worker_id FROM workers WHERE connector_id = ?)
    `).run(timestamp, timestamp, commandId, connectorId);
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
    this.db.prepare('UPDATE commands SET output_text = ?, output_truncated = ?, last_activity_at = ? WHERE command_id = ?')
      .run(output, truncated ? 1 : 0, now(), commandId);
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

  cancelCommand(commandId, { code = 'command_cancelled', message = 'Command cancelled' } = {}) {
    const current = this.getCommand(commandId);
    if (!current) return { command: null, changed: false };
    const error = { code, message };
    const result = this.db.prepare(`
      UPDATE commands SET status = 'failed', result_json = NULL, error_json = ?,
        outcome_unknown = 1, finished_at = ?
      WHERE command_id = ? AND status IN ('queued', 'accepted', 'running', 'waiting_manual')
    `).run(stringifyJson(error), now(), commandId);
    return { command: this.getCommand(commandId), changed: result.changes === 1 };
  }

  getCoordinatorConfig() {
    return coordinatorConfigView(this.db.prepare('SELECT * FROM coordinator_config WHERE singleton = 1').get());
  }

  setCoordinatorConfig({ workerId, enabled, maxSteps }) {
    this.db.prepare(`
      INSERT INTO coordinator_config (singleton, worker_id, enabled, max_steps, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        worker_id = excluded.worker_id, enabled = excluded.enabled,
        max_steps = excluded.max_steps, updated_at = excluded.updated_at
    `).run(workerId ?? null, enabled ? 1 : 0, maxSteps, now());
    return this.getCoordinatorConfig();
  }

  createOrchestratedTask({ title, goal, context, acceptance, createdBy, coordinatorWorkerId, sourceMessageId = null, autoStart = true }) {
    if (sourceMessageId) {
      const existing = this.getOrchestrationBySourceMessage(sourceMessageId);
      if (existing) return { task: this.getTask(existing.parent_task_id), orchestration: existing };
    }
    const parentTaskId = createId('task');
    const orchestrationId = createId('orch');
    const timestamp = now();
    this.transaction(() => {
      this.insertTask({
        title,
        goal,
        context,
        acceptance,
        assignee_worker_id: null,
        created_by: createdBy,
      }, parentTaskId, timestamp);
      this.db.prepare(`
        INSERT INTO coordinator_orchestrations (
          orchestration_id, parent_task_id, coordinator_worker_id,
          status, auto_start, source_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'planning', ?, ?, ?, ?)
      `).run(orchestrationId, parentTaskId, coordinatorWorkerId, autoStart ? 1 : 0, sourceMessageId, timestamp, timestamp);
    });
    return { task: this.getTask(parentTaskId), orchestration: this.getOrchestration(orchestrationId) };
  }

  getOrchestration(orchestrationId) {
    return orchestrationView(this.db.prepare(`
      SELECT * FROM coordinator_orchestrations WHERE orchestration_id = ?
    `).get(orchestrationId));
  }

  getOrchestrationByTask(parentTaskId) {
    return orchestrationView(this.db.prepare(`
      SELECT * FROM coordinator_orchestrations WHERE parent_task_id = ?
    `).get(parentTaskId));
  }

  getOrchestrationBySourceMessage(messageId) {
    return orchestrationView(this.db.prepare(`
      SELECT * FROM coordinator_orchestrations WHERE source_message_id = ?
    `).get(messageId));
  }

  listOrchestrations({ active = false } = {}) {
    const where = active ? "AND o.status IN ('planning', 'in_progress', 'review')" : '';
    return this.db.prepare(`
      SELECT o.* FROM coordinator_orchestrations o
      JOIN tasks t ON t.task_id = o.parent_task_id
      WHERE t.deleted_at IS NULL ${where}
      ORDER BY o.created_at DESC, o.rowid DESC
    `).all().map(orchestrationView);
  }

  updateOrchestration(orchestrationId, data) {
    const current = this.getOrchestration(orchestrationId);
    if (!current) return null;
    const status = data.status ?? current.status;
    const summary = data.summary ?? current.summary;
    const steps = data.steps === undefined ? current.steps : data.steps;
    const error = data.error === undefined ? current.error : data.error;
    const reviewReason = data.reviewReason ?? current.review_reason;
    const recoveryCount = data.recoveryCount ?? current.recovery_count;
    const reviewCommandId = data.reviewCommandId === undefined ? current.review_command_id : data.reviewCommandId;
    this.db.prepare(`
      UPDATE coordinator_orchestrations
      SET status = ?, summary = ?, steps_json = ?, error_json = ?, review_reason = ?,
        recovery_count = ?, review_command_id = ?, updated_at = ?
      WHERE orchestration_id = ?
    `).run(status, summary, stringifyJson(steps), stringifyJson(error), reviewReason, recoveryCount, reviewCommandId, now(), orchestrationId);
    return this.getOrchestration(orchestrationId);
  }

  createChatMessage({ role, content = '', status = 'done', requestId = null, commandId = null, taskId = null, sourceKey = null, mentions = [] }) {
    const existing = requestId
      ? this.getChatMessageByRequestId(requestId)
      : sourceKey
        ? this.getChatMessageBySourceKey(sourceKey)
        : null;
    if (existing) return existing;
    const messageId = createId('chat');
    const conversationEpoch = this.conversationEpoch();
    this.db.prepare(`
      INSERT INTO coordinator_chat_messages (
        message_id, role, content, status, request_id, command_id, task_id, source_key, mentions_json, conversation_epoch, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, role, content, status, requestId, commandId, taskId, sourceKey, stringifyJson(mentions), conversationEpoch, now());
    return this.getChatMessage(messageId);
  }

  getChatMessage(messageId) {
    return chatMessageView(this.db.prepare(`
      SELECT * FROM coordinator_chat_messages WHERE message_id = ?
    `).get(messageId));
  }

  getChatMessageByRequestId(requestId) {
    return chatMessageView(this.db.prepare(`
      SELECT * FROM coordinator_chat_messages WHERE request_id = ?
    `).get(requestId));
  }

  getChatMessageBySourceKey(sourceKey) {
    return chatMessageView(this.db.prepare(`
      SELECT * FROM coordinator_chat_messages WHERE source_key = ?
    `).get(sourceKey));
  }

  getChatMessageByCommand(commandId) {
    return chatMessageView(this.db.prepare(`
      SELECT * FROM coordinator_chat_messages WHERE command_id = ?
    `).get(commandId));
  }

  conversationEpoch() {
    return Number(this.db.prepare('SELECT epoch FROM coordinator_chat_state WHERE singleton = 1').get()?.epoch ?? 0);
  }

  clearConversation() {
    return Number(this.db.prepare(`
      INSERT INTO coordinator_chat_state (singleton, epoch) VALUES (1, 1)
      ON CONFLICT(singleton) DO UPDATE SET epoch = coordinator_chat_state.epoch + 1
      RETURNING epoch
    `).get().epoch);
  }

  listChatMessages({ limit = 200, epoch = null } = {}) {
    const where = epoch === null ? '' : 'WHERE conversation_epoch = ?';
    const values = epoch === null ? [limit] : [epoch, limit];
    return this.db.prepare(`
      SELECT * FROM coordinator_chat_messages ${where}
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...values).map(chatMessageView).reverse();
  }

  listPendingChatMessages() {
    return this.db.prepare(`
      SELECT * FROM coordinator_chat_messages
      WHERE role = 'coordinator' AND status = 'pending'
      ORDER BY created_at ASC, rowid ASC
    `).all().map(chatMessageView);
  }

  updateChatMessage(messageId, data) {
    const current = this.getChatMessage(messageId);
    if (!current) return null;
    const content = data.content ?? current.content;
    const status = data.status ?? current.status;
    const commandId = data.commandId === undefined ? current.command_id : data.commandId;
    const taskId = data.taskId === undefined ? current.task_id : data.taskId;
    this.db.prepare(`
      UPDATE coordinator_chat_messages
      SET content = ?, status = ?, command_id = ?, task_id = ?
      WHERE message_id = ?
    `).run(content, status, commandId, taskId, messageId);
    return this.getChatMessage(messageId);
  }

  assertHistoryClearable() {
    const active = {
      commands: this.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE status IN ('queued', 'accepted', 'running', 'waiting_manual')").get().count,
      tasks: this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'in_progress'").get().count,
      orchestrations: this.db.prepare("SELECT COUNT(*) AS count FROM coordinator_orchestrations WHERE status IN ('planning', 'in_progress') OR (status = 'review' AND error_json IS NULL)").get().count,
      pending_messages: this.db.prepare("SELECT COUNT(*) AS count FROM coordinator_chat_messages WHERE status = 'pending'").get().count,
    };
    if (Object.values(active).some((count) => count > 0)) {
      const error = new Error('Cannot clear history while work is active');
      error.code = 'history_active';
      error.statusCode = 409;
      error.active = active;
      throw error;
    }
  }

  backup(filename) {
    this.db.prepare('VACUUM INTO ?').run(filename);
  }

  clearHistory() {
    this.assertHistoryClearable();
    const tables = ['coordinator_chat_messages', 'coordinator_orchestrations', 'events', 'commands', 'tasks'];
    const cleared = Object.fromEntries(tables.map((table) => [
      table,
      this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]));
    this.transaction(() => {
      for (const table of tables) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec('DELETE FROM coordinator_chat_state');
      this.db.prepare("UPDATE workers SET work_state = 'idle', current_task_id = NULL, updated_at = ?").run(now());
    });
    return cleared;
  }

  latestTaskEvent(taskId, eventType) {
    return eventView(this.db.prepare(`
      SELECT * FROM events WHERE task_id = ? AND event_type = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId, eventType));
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
