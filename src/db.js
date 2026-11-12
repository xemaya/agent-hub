import { DatabaseSync } from 'node:sqlite';
import { createId } from './ids.js';
import { parseJson, stringifyJson } from './json.js';
import { MailStore } from './mail-store.js';

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
    role_key: row.role_key ?? null,
    detached_at: row.detached_at ?? null,
    // presence is the Connector's; session_online is this Session's own Channel.
    session_online: Boolean(row.push_capable),
    session_cwd: row.session_cwd ?? null,
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
    role: worker.role_key,
    push_capable: worker.push_capable,
    session_online: worker.session_online,
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
    thread_key: row.thread_key ?? null,
    role_key: row.role_key ?? null,
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

function attentionView(row) {
  if (!row) return null;
  return {
    attention_id: row.attention_id,
    command_id: row.command_id,
    task_id: row.task_id,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    task_title: row.task_title ?? null,
    task_number: row.task_number == null ? null : Number(row.task_number),
    // The Role the work belongs to (the task's, else the seat's): a channel bridge
    // serving one Role leaves another Role's approvals and questions alone.
    role_key: row.task_role_key ?? row.worker_role_key ?? null,
    orchestration_id: row.orchestration_id ?? null,
    step_key: row.step_key ?? null,
    outcome: row.outcome,
    question: row.question,
    // needs_approval: the outward action waiting for a person's approval; the
    // channel bridge that owns `action.channel` executes it once approved.
    action: row.action_json ? parseJson(row.action_json, null) : null,
    status: row.status,
    answer: row.answer ?? null,
    answer_command_id: row.answer_command_id ?? null,
    decided_by: row.decided_by ?? null,
    execution: row.execution_json ? parseJson(row.execution_json, null) : null,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
  };
}

function roleView(row) {
  if (!row) return null;
  return {
    role_key: row.role_key,
    name: row.name,
    description: row.description,
    takeover_after_ms: Number(row.takeover_after_ms),
    workdir: row.workdir ?? null,
    alert_role: row.alert_role ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function handoffView(row) {
  if (!row) return null;
  return {
    handoff_id: row.handoff_id,
    task_id: row.task_id,
    task_title: row.task_title ?? null,
    task_number: row.task_number == null ? null : Number(row.task_number),
    role_key: row.role_key,
    reason: row.reason,
    input: row.input,
    from_worker_id: row.from_worker_id ?? null,
    from_command_id: row.from_command_id ?? null,
    status: row.status,
    worker_id: row.worker_id ?? null,
    command_id: row.command_id ?? null,
    not_before: row.not_before,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    alerted_at: row.alerted_at ?? null,
  };
}

const HANDOFF_SELECT = `
  SELECT h.*, t.title AS task_title, t.task_number AS task_number
  FROM handoffs AS h LEFT JOIN tasks AS t ON t.task_id = h.task_id
`;

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
    handback_reason: row.handback_reason ?? null,
    queued: Boolean(row.queued),
    batch_command_id: row.batch_command_id ?? null,
    created_at: row.created_at,
  };
}

const ATTENTION_SELECT = `
  SELECT a.*, w.name AS worker_name, t.title AS task_title, t.task_number AS task_number,
    t.role_key AS task_role_key, w.role_key AS worker_role_key
  FROM attentions AS a
  LEFT JOIN workers AS w ON w.worker_id = a.worker_id
  LEFT JOIN tasks AS t ON t.task_id = a.task_id
`;

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
      CREATE TABLE IF NOT EXISTS watchdog_config (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        worker_id TEXT REFERENCES workers(worker_id),
        enabled INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL,
        min_running_ms INTEGER NOT NULL,
        nudge_cooldown_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attentions (
        attention_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
        task_id TEXT REFERENCES tasks(task_id),
        worker_id TEXT NOT NULL REFERENCES workers(worker_id),
        orchestration_id TEXT,
        step_key TEXT,
        outcome TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'answered', 'dismissed', 'approved', 'executed', 'failed')),
        answer TEXT,
        answer_command_id TEXT,
        action_json TEXT,
        execution_json TEXT,
        decided_by TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS triggers (
        trigger_key TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        source TEXT NOT NULL,
        routed TEXT NOT NULL,
        task_id TEXT,
        command_id TEXT,
        attention_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roles (
        role_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        takeover_after_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        role_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '',
        from_worker_id TEXT,
        from_command_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('open', 'dispatched', 'cancelled')),
        worker_id TEXT,
        command_id TEXT,
        not_before TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
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
      CREATE INDEX IF NOT EXISTS idx_events_command ON events(command_id, event_type);
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
    if (!chatColumns.has('handback_reason')) this.db.exec('ALTER TABLE coordinator_chat_messages ADD COLUMN handback_reason TEXT');
    if (!chatColumns.has('queued')) this.db.exec('ALTER TABLE coordinator_chat_messages ADD COLUMN queued INTEGER NOT NULL DEFAULT 0');
    if (!chatColumns.has('batch_command_id')) this.db.exec('ALTER TABLE coordinator_chat_messages ADD COLUMN batch_command_id TEXT');
    const workerColumns = new Set(this.db.prepare('PRAGMA table_info(workers)').all().map((column) => column.name));
    if (!workerColumns.has('retired_at')) {
      this.db.exec('ALTER TABLE workers ADD COLUMN retired_at TEXT');
    }
    if (!workerColumns.has('role_key')) this.db.exec('ALTER TABLE workers ADD COLUMN role_key TEXT');
    if (!workerColumns.has('detached_at')) this.db.exec('ALTER TABLE workers ADD COLUMN detached_at TEXT');
    if (!workerColumns.has('session_cwd')) this.db.exec('ALTER TABLE workers ADD COLUMN session_cwd TEXT');
    const roleColumns = new Set(this.db.prepare('PRAGMA table_info(roles)').all().map((column) => column.name));
    if (!roleColumns.has('workdir')) this.db.exec('ALTER TABLE roles ADD COLUMN workdir TEXT');
    const taskColumns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name));
    if (!taskColumns.has('task_number')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN task_number INTEGER');
    }
    if (!taskColumns.has('deleted_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT');
    }
    if (!taskColumns.has('thread_key')) this.db.exec('ALTER TABLE tasks ADD COLUMN thread_key TEXT');
    if (!taskColumns.has('role_key')) this.db.exec('ALTER TABLE tasks ADD COLUMN role_key TEXT');
    const commandColumns = new Set(this.db.prepare('PRAGMA table_info(commands)').all().map((column) => column.name));
    if (!commandColumns.has('sender_worker_id')) {
      this.db.exec('ALTER TABLE commands ADD COLUMN sender_worker_id TEXT REFERENCES workers(worker_id)');
    }
    if (!commandColumns.has('last_activity_at')) {
      this.db.exec('ALTER TABLE commands ADD COLUMN last_activity_at TEXT');
    }
    // schema 17: approval Attentions need new statuses, and SQLite cannot widen
    // a CHECK constraint in place, so the table is rebuilt once.
    const attentionColumns = new Set(this.db.prepare('PRAGMA table_info(attentions)').all().map((column) => column.name));
    if (!attentionColumns.has('action_json')) {
      this.db.exec(`
        CREATE TABLE attentions_v17 (
          attention_id TEXT PRIMARY KEY,
          command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
          task_id TEXT REFERENCES tasks(task_id),
          worker_id TEXT NOT NULL REFERENCES workers(worker_id),
          orchestration_id TEXT,
          step_key TEXT,
          outcome TEXT NOT NULL,
          question TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('open', 'answered', 'dismissed', 'approved', 'executed', 'failed')),
          answer TEXT,
          answer_command_id TEXT,
          action_json TEXT,
          execution_json TEXT,
          decided_by TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        INSERT INTO attentions_v17 (attention_id, command_id, task_id, worker_id, orchestration_id, step_key, outcome, question,
          status, answer, answer_command_id, created_at, resolved_at)
          SELECT attention_id, command_id, task_id, worker_id, orchestration_id, step_key, outcome, question,
            status, answer, answer_command_id, created_at, resolved_at FROM attentions;
        DROP TABLE attentions;
        ALTER TABLE attentions_v17 RENAME TO attentions;
      `);
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
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_key) WHERE thread_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_chat_batch ON coordinator_chat_messages(batch_command_id) WHERE batch_command_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_attentions_status ON attentions(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_open_task ON handoffs(task_id) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_workers_role ON workers(role_key) WHERE role_key IS NOT NULL;
      UPDATE commands SET last_activity_at = COALESCE(started_at, accepted_at, created_at)
        WHERE last_activity_at IS NULL;
      UPDATE workers SET mode = 'external', push_capable = 0 WHERE mode <> 'external';
    `);
    // Schema 18: a Role may name another Role that is told when its work stalls.
    if (!roleColumns.has('alert_role')) this.db.exec('ALTER TABLE roles ADD COLUMN alert_role TEXT');
    const handoffColumns = new Set(this.db.prepare('PRAGMA table_info(handoffs)').all().map((column) => column.name));
    if (!handoffColumns.has('alerted_at')) this.db.exec('ALTER TABLE handoffs ADD COLUMN alerted_at TEXT');
    // Schema 19: a channel platform (Feishu) pushes events to the Hub's public URL; the
    // bridge for that app registers how to verify them and pulls them in order.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_webhooks (
        channel TEXT NOT NULL,
        app_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        encrypt_key TEXT,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (channel, app_id)
      );
      CREATE TABLE IF NOT EXISTS channel_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        app_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_events_id ON channel_events(channel, app_id, event_id);
    `);
    this.mailbox = new MailStore(this.db);
    this.db.exec('PRAGMA user_version = 19');
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
      SELECT worker_id, capabilities_json, metadata_json FROM workers
      WHERE connector_id = ? AND runtime = ? AND runtime_session_id = ?
    `).get(connectorId, data.runtime, data.runtime_session_id);
    const workerId = existing?.worker_id ?? createId('worker');
    // Re-registering updates what it names and keeps what it leaves out.
    const capabilities = data.capabilities?.length ? data.capabilities : parseJson(existing?.capabilities_json, []);
    const metadata = { ...parseJson(existing?.metadata_json, {}), ...data.metadata };
    this.db.prepare(`
      INSERT INTO workers (
        worker_id, connector_id, name, runtime, mode, runtime_session_id,
        capabilities_json, cwd, metadata_json, push_capable, work_state,
        created_at, updated_at, last_seen_at, session_cwd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)
      ON CONFLICT(connector_id, runtime, runtime_session_id) DO UPDATE SET
        name = excluded.name, mode = excluded.mode, capabilities_json = excluded.capabilities_json,
        cwd = excluded.cwd, metadata_json = excluded.metadata_json,
        push_capable = excluded.push_capable, updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at, retired_at = NULL,
        session_cwd = COALESCE(excluded.session_cwd, workers.session_cwd)
    `).run(
      workerId,
      connectorId,
      data.name,
      data.runtime,
      'external',
      data.runtime_session_id,
      stringifyJson(capabilities),
      data.cwd,
      stringifyJson(metadata),
      0,
      timestamp,
      timestamp,
      timestamp,
      data.session_cwd ?? null,
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
  setWorkerChannel(connectorId, workerId, attached, sessionCwd = null) {
    const worker = this.getWorkerForConnector(workerId, connectorId);
    if (!worker) return null;
    const timestamp = now();
    this.db.prepare(`
      UPDATE workers SET push_capable = ?, updated_at = ?, last_seen_at = ?,
        detached_at = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(detached_at, ?) END,
        session_cwd = CASE WHEN ? = 1 THEN ? ELSE session_cwd END
      WHERE worker_id = ?
    `).run(attached ? 1 : 0, timestamp, timestamp, attached ? 1 : 0, timestamp, attached ? 1 : 0, sessionCwd, workerId);
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
        status, created_by, created_at, updated_at, thread_key, role_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)
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
      data.thread_key ?? null,
      data.role_key ?? null,
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
      role: data.role_key === undefined ? current.role_key : data.role_key,
    };
    this.transaction(() => {
      this.db.prepare(`
        UPDATE tasks SET title = ?, goal = ?, context = ?, acceptance_json = ?,
          status = ?, assignee_worker_id = ?, role_key = ?, updated_at = ? WHERE task_id = ?
      `).run(
        next.title,
        next.goal,
        next.context,
        stringifyJson(next.acceptance),
        next.status,
        next.assignee,
        next.role,
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

  getRole(roleKey) {
    return roleView(this.db.prepare('SELECT * FROM roles WHERE role_key = ?').get(roleKey));
  }

  listRoles() {
    return this.db.prepare('SELECT * FROM roles ORDER BY role_key').all().map(roleView);
  }

  upsertRole({ roleKey, name, description, takeoverAfterMs, workdir, alertRole }) {
    const timestamp = now();
    const current = this.getRole(roleKey);
    this.db.prepare(`
      INSERT INTO roles (role_key, name, description, takeover_after_ms, workdir, alert_role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role_key) DO UPDATE SET name = excluded.name, description = excluded.description,
        takeover_after_ms = excluded.takeover_after_ms, workdir = excluded.workdir, alert_role = excluded.alert_role,
        updated_at = excluded.updated_at
    `).run(
      roleKey,
      name ?? current?.name ?? roleKey,
      description ?? current?.description ?? '',
      takeoverAfterMs ?? current?.takeover_after_ms ?? 3 * 60 * 1000,
      workdir === undefined ? current?.workdir ?? null : workdir || null,
      alertRole === undefined ? current?.alert_role ?? null : alertRole || null,
      timestamp,
      timestamp,
    );
    return this.getRole(roleKey);
  }

  setWorkerRole(workerId, roleKey) {
    this.db.prepare('UPDATE workers SET role_key = ?, updated_at = ? WHERE worker_id = ?').run(roleKey ?? null, now(), workerId);
    return this.getWorker(workerId);
  }

  listRoleWorkers(roleKey) {
    return this.db.prepare(`${WORKER_SELECT} WHERE w.role_key = ? AND w.retired_at IS NULL ORDER BY w.last_seen_at DESC, w.rowid DESC`)
      .all(roleKey).map(workerView);
  }

  activeCommandCount(workerId) {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM commands WHERE worker_id = ? AND status IN ('queued', 'accepted', 'running')
    `).get(workerId).count;
  }

  // Work queued on a seat but not started: safe to move to another seat.
  listUnstartedTaskCommands(taskId, workerId) {
    return this.db.prepare(`
      ${COMMAND_SELECT} WHERE cmd.task_id = ? AND cmd.worker_id = ? AND cmd.started_at IS NULL
        AND cmd.status IN ('queued', 'accepted', 'waiting_manual')
      ORDER BY cmd.created_at ASC, cmd.rowid ASC
    `).all(taskId, workerId).map(commandView);
  }

  listLiveRoleTasks() {
    return this.db.prepare(`
      ${TASK_SELECT} WHERE t.role_key IS NOT NULL AND t.deleted_at IS NULL
        AND t.status NOT IN ('done', 'cancelled') AND t.assignee_worker_id IS NOT NULL
    `).all().map(taskView);
  }

  // The task's own execution history, oldest first: what a new seat reads.
  listTaskWorkCommands(taskId, limit = 20) {
    return this.db.prepare(`
      SELECT * FROM (${COMMAND_SELECT} WHERE cmd.task_id = ? ORDER BY cmd.created_at DESC, cmd.rowid DESC LIMIT ?)
      ORDER BY created_at ASC
    `).all(taskId, limit).map(commandView);
  }

  createHandoff({ taskId, roleKey, reason, input = '', fromWorkerId = null, fromCommandId = null, notBefore }) {
    const handoffId = createId('handoff');
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO handoffs (handoff_id, task_id, role_key, reason, input, from_worker_id, from_command_id, status, not_before, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(handoffId, taskId, roleKey, reason, input, fromWorkerId, fromCommandId, notBefore ?? timestamp, timestamp);
    return this.getHandoff(handoffId);
  }

  getHandoff(handoffId) {
    return handoffView(this.db.prepare(`${HANDOFF_SELECT} WHERE h.handoff_id = ?`).get(handoffId));
  }

  openHandoffForTask(taskId) {
    return handoffView(this.db.prepare(`${HANDOFF_SELECT} WHERE h.task_id = ? AND h.status = 'open'`).get(taskId));
  }

  listHandoffs({ status = null, roleKey = null, taskId = null, limit = 200 } = {}) {
    const conditions = [];
    const values = [];
    if (status) { conditions.push('h.status = ?'); values.push(status); }
    if (roleKey) { conditions.push('h.role_key = ?'); values.push(roleKey); }
    if (taskId) { conditions.push('h.task_id = ?'); values.push(taskId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`${HANDOFF_SELECT} ${where} ORDER BY h.created_at ASC, h.rowid ASC LIMIT ?`).all(...values, limit).map(handoffView);
  }

  countHandoffs(taskId, reason) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM handoffs WHERE task_id = ? AND reason = ?').get(taskId, reason).count;
  }

  // Later work for a task that still waits for a seat joins the same handoff.
  mergeHandoff(handoffId, { input, fromCommandId, notBefore }) {
    const current = this.getHandoff(handoffId);
    const merged = [current.input, input].filter(Boolean).join('\n\n---\n\n');
    this.db.prepare(`
      UPDATE handoffs SET input = ?, from_command_id = COALESCE(?, from_command_id),
        not_before = MIN(not_before, ?) WHERE handoff_id = ? AND status = 'open'
    `).run(merged, fromCommandId ?? null, notBefore ?? current.not_before, handoffId);
    return this.getHandoff(handoffId);
  }

  // The stall alert for a handoff goes out once; the mark survives restarts.
  markHandoffAlerted(handoffId) {
    this.db.prepare('UPDATE handoffs SET alerted_at = ? WHERE handoff_id = ? AND alerted_at IS NULL').run(now(), handoffId);
    return this.getHandoff(handoffId);
  }

  resolveHandoff(handoffId, { status, workerId = null, commandId = null }) {
    const result = this.db.prepare(`
      UPDATE handoffs SET status = ?, worker_id = ?, command_id = ?, resolved_at = ?
      WHERE handoff_id = ? AND status = 'open'
    `).run(status, workerId, commandId, now(), handoffId);
    return { handoff: this.getHandoff(handoffId), changed: result.changes === 1 };
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

  getWatchdogConfig() {
    const row = this.db.prepare('SELECT * FROM watchdog_config WHERE singleton = 1').get();
    return row
      ? {
        worker_id: row.worker_id,
        enabled: Boolean(row.enabled),
        interval_ms: row.interval_ms,
        min_running_ms: row.min_running_ms,
        nudge_cooldown_ms: row.nudge_cooldown_ms,
        updated_at: row.updated_at,
      }
      : { worker_id: null, enabled: false, interval_ms: null, min_running_ms: null, nudge_cooldown_ms: null, updated_at: null };
  }

  setWatchdogConfig({ workerId, enabled, intervalMs, minRunningMs, nudgeCooldownMs }) {
    this.db.prepare(`
      INSERT INTO watchdog_config (singleton, worker_id, enabled, interval_ms, min_running_ms, nudge_cooldown_ms, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        worker_id = excluded.worker_id, enabled = excluded.enabled, interval_ms = excluded.interval_ms,
        min_running_ms = excluded.min_running_ms, nudge_cooldown_ms = excluded.nudge_cooldown_ms,
        updated_at = excluded.updated_at
    `).run(workerId ?? null, enabled ? 1 : 0, intervalMs, minRunningMs, nudgeCooldownMs, now());
    return this.getWatchdogConfig();
  }

  hasActiveCommand(workerId) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM commands WHERE worker_id = ? AND status IN ('queued', 'accepted', 'running') LIMIT 1
    `).get(workerId));
  }

  // A pointer to a command's result is a capability handed out in a prompt: a
  // Worker may read a result that appears in one of its own command inputs.
  commandReferencedBy(workerId, commandId) {
    return Boolean(this.db.prepare('SELECT 1 FROM commands WHERE worker_id = ? AND instr(input, ?) > 0 LIMIT 1').get(workerId, commandId));
  }

  listQueuedChatMessages() {
    return this.db.prepare(`
      SELECT * FROM coordinator_chat_messages
      WHERE role = 'coordinator' AND status = 'pending' AND queued = 1
      ORDER BY created_at ASC, rowid ASC
    `).all().map(chatMessageView);
  }

  listChatMessagesByBatch(commandId) {
    return this.db.prepare('SELECT * FROM coordinator_chat_messages WHERE batch_command_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(commandId).map(chatMessageView);
  }

  // With a roleKey only that Role's live Task follows the thread: two bridges (qa, hb-agent)
  // follow the same Feishu topic, and 11-10 an @ to the QA bot became a follow-up of the
  // hb-agent's live Task because it was simply the newest one on the thread.
  liveTaskByThread(threadKey, roleKey = null) {
    const row = this.db.prepare(`
      SELECT task_id FROM tasks
      WHERE thread_key = ? AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled')
        AND (? IS NULL OR role_key = ?)
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(threadKey, roleKey, roleKey);
    return row ? this.getTask(row.task_id) : null;
  }

  getTrigger(triggerKey) {
    return this.db.prepare('SELECT * FROM triggers WHERE trigger_key = ?').get(triggerKey) ?? null;
  }

  // ---- channel webhooks: platform events pushed to the Hub, pulled by a bridge ----

  registerChannelWebhook({ channel, appId, tokenHash, encryptKey = null }) {
    this.db.prepare(`
      INSERT INTO channel_webhooks (channel, app_id, token_hash, encrypt_key, registered_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, app_id) DO UPDATE SET token_hash = excluded.token_hash, encrypt_key = excluded.encrypt_key, registered_at = excluded.registered_at
    `).run(channel, appId, tokenHash, encryptKey, now());
    return this.getChannelWebhook(channel, appId);
  }

  getChannelWebhook(channel, appId) {
    return this.db.prepare('SELECT * FROM channel_webhooks WHERE channel = ? AND app_id = ?').get(channel, appId) ?? null;
  }

  // Stores one pushed event; the same event_id (platforms retry) is kept once. Returns the
  // row or null for a repeat. Events older than keepDays go as new ones come in.
  addChannelEvent({ channel, appId, eventId, eventType = null, payload, keepDays = 7 }) {
    // Checked before inserting: an ignored conflict would still spend a seq number, and the
    // bridge's cursor reads better without gaps.
    if (this.db.prepare('SELECT 1 FROM channel_events WHERE channel = ? AND app_id = ? AND event_id = ?').get(channel, appId, eventId)) return null;
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO channel_events (channel, app_id, event_id, event_type, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(channel, appId, eventId, eventType, stringifyJson(payload), now());
    if (!inserted.changes) return null;
    this.db.prepare('DELETE FROM channel_events WHERE received_at < ?').run(new Date(Date.now() - keepDays * 86400000).toISOString());
    return this.db.prepare('SELECT * FROM channel_events WHERE seq = ?').get(inserted.lastInsertRowid);
  }

  listChannelEventsAfter(channel, appId, afterSeq, { limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT * FROM channel_events WHERE channel = ? AND app_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(channel, appId, afterSeq, limit).map((row) => ({ ...row, payload: parseJson(row.payload) }));
  }

  latestChannelEventSeq(channel, appId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM channel_events WHERE channel = ? AND app_id = ?').get(channel, appId).seq;
  }

  recordTrigger({ triggerKey, threadKey, source, routed, taskId = null, commandId = null, attentionId = null }) {
    this.db.prepare(`
      INSERT INTO triggers (trigger_key, thread_key, source, routed, task_id, command_id, attention_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(triggerKey, threadKey, source, routed, taskId, commandId, attentionId, now());
    return this.getTrigger(triggerKey);
  }

  createAttention({ commandId, taskId = null, workerId, orchestrationId = null, stepKey = null, outcome, question, action = null }) {
    const existing = this.db.prepare('SELECT attention_id FROM attentions WHERE command_id = ?').get(commandId);
    if (existing) return this.getAttention(existing.attention_id);
    const attentionId = createId('attn');
    this.db.prepare(`
      INSERT INTO attentions (attention_id, command_id, task_id, worker_id, orchestration_id, step_key, outcome, question, action_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(attentionId, commandId, taskId, workerId, orchestrationId, stepKey, outcome, question, action ? stringifyJson(action) : null, now());
    return this.getAttention(attentionId);
  }

  getAttention(attentionId) {
    return attentionView(this.db.prepare(`${ATTENTION_SELECT} WHERE a.attention_id = ?`).get(attentionId));
  }

  listAttentions({ status = 'open' } = {}) {
    const where = status ? 'WHERE a.status = ?' : '';
    return this.db.prepare(`${ATTENTION_SELECT} ${where} ORDER BY a.created_at ASC, a.rowid ASC LIMIT 200`)
      .all(...(status ? [status] : [])).map(attentionView);
  }

  // The newest Attention of the task that still waits for a person: open, or
  // approved but not yet executed by its channel. `outcomes` narrows the kind.
  openAttentionForTask(taskId, { outcomes = null } = {}) {
    const kinds = outcomes ? `AND outcome IN (${outcomes.map(() => '?').join(', ')})` : '';
    const row = this.db.prepare(`
      SELECT attention_id FROM attentions WHERE task_id = ? AND status IN ('open', 'approved') ${kinds}
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId, ...(outcomes ?? []));
    return row ? this.getAttention(row.attention_id) : null;
  }

  resolveAttention(attentionId, { status, answer = null, answerCommandId = null, decidedBy = null }) {
    const result = this.db.prepare(`
      UPDATE attentions SET status = ?, answer = ?, answer_command_id = ?, decided_by = ?, resolved_at = ?
      WHERE attention_id = ? AND status = 'open'
    `).run(status, answer, answerCommandId, decidedBy, now(), attentionId);
    return { attention: this.getAttention(attentionId), changed: result.changes === 1 };
  }

  // An approved outward action was carried out (or could not be) by its channel.
  settleAttention(attentionId, { status, execution }) {
    const result = this.db.prepare(`
      UPDATE attentions SET status = ?, execution_json = ?, resolved_at = ?
      WHERE attention_id = ? AND status = 'approved'
    `).run(status, stringifyJson(execution ?? {}), now(), attentionId);
    return { attention: this.getAttention(attentionId), changed: result.changes === 1 };
  }

  setAttentionAnswerCommand(attentionId, commandId) {
    this.db.prepare('UPDATE attentions SET answer_command_id = ? WHERE attention_id = ?').run(commandId, attentionId);
    return this.getAttention(attentionId);
  }

  latestCommandOfKind(kind) {
    return commandView(this.db.prepare(`${COMMAND_SELECT} WHERE cmd.kind = ? ORDER BY cmd.created_at DESC, cmd.rowid DESC LIMIT 1`).get(kind));
  }

  latestCommandEvent(commandId, eventType) {
    return eventView(this.db.prepare(`
      SELECT * FROM events WHERE command_id = ? AND event_type = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(commandId, eventType));
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
    const handbackReason = data.handbackReason === undefined ? current.handback_reason : data.handbackReason;
    const queued = data.queued === undefined ? current.queued : data.queued;
    const batchCommandId = data.batchCommandId === undefined ? current.batch_command_id : data.batchCommandId;
    this.db.prepare(`
      UPDATE coordinator_chat_messages
      SET content = ?, status = ?, command_id = ?, task_id = ?, handback_reason = ?, queued = ?, batch_command_id = ?
      WHERE message_id = ?
    `).run(content, status, commandId, taskId, handbackReason, queued ? 1 : 0, batchCommandId, messageId);
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
    const tables = ['handoffs', 'attentions', 'triggers', 'coordinator_chat_messages', 'coordinator_orchestrations', 'events', 'commands', 'tasks'];
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

  // Events after a known one, oldest first: a cursor for bridges that turn Hub
  // events into notifications. An empty `after` starts from the latest event.
  listEventsAfter(afterEventId, { limit = 200, types = null } = {}) {
    let since = 0;
    if (afterEventId) {
      const row = this.db.prepare('SELECT rowid FROM events WHERE event_id = ?').get(afterEventId);
      if (!row) return null;
      since = row.rowid;
    } else {
      since = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS rowid FROM events').get().rowid;
    }
    const kinds = types?.length ? `AND event_type IN (${types.map(() => '?').join(', ')})` : '';
    return this.db.prepare(`SELECT * FROM events WHERE rowid > ? ${kinds} ORDER BY rowid ASC LIMIT ?`)
      .all(since, ...(types ?? []), limit).map(eventView);
  }

  latestEventId() {
    return this.db.prepare('SELECT event_id FROM events ORDER BY rowid DESC LIMIT 1').get()?.event_id ?? null;
  }
}
