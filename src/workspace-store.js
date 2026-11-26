import { createId } from './ids.js';
import { parseJson } from './json.js';

// Workspaces live in their own ws_* tables next to the Hub's, created with
// IF NOT EXISTS like the mailbox, so they never touch the versioned schema of
// Workers, Tasks and Commands. A workspace member is not a Hub Worker: it is
// a seat (cc-1, codex-1 …) bound to one native session on one Connector.

const now = () => new Date().toISOString();

export const MEMBER_STATES = Object.freeze(['requested', 'launching', 'launched', 'joined', 'failed', 'left']);
export const MESSAGE_KINDS = Object.freeze(['chat', 'handoff', 'owner', 'system']);
export const NOTE_KINDS = Object.freeze(['decision', 'fact', 'link', 'note']);

function storeError(message, statusCode = 400, code = 'workspace_error') {
  return Object.assign(new Error(message), { statusCode, code });
}

function workspaceView(row) {
  if (!row) return null;
  return {
    workspace_id: row.workspace_id,
    name: row.name,
    title: row.title,
    goal: row.goal,
    brief: row.brief,
    brief_version: Number(row.brief_version),
    project_key: row.project_key,
    branch: row.branch,
    status: row.status,
    gather_ms: Number(row.gather_ms),
    leader_member_id: row.leader_member_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    close_summary: row.close_summary,
  };
}

function memberView(row) {
  if (!row) return null;
  return {
    member_id: row.member_id,
    workspace_id: row.workspace_id,
    seat: row.seat,
    role: row.role,
    job: row.job,
    runtime: row.runtime,
    connector_id: row.connector_id,
    session_id: row.session_id,
    model: row.model,
    state: row.state,
    state_detail: row.state_detail,
    launch: parseJson(row.launch, {}),
    read_seq: Number(row.read_seq),
    notes_read_seq: Number(row.notes_read_seq),
    notified_seq: Number(row.notified_seq),
    notified_at: row.notified_at,
    wake_due_at: row.wake_due_at,
    wake_status: row.wake_status,
    wake_detail: row.wake_detail,
    listening: Boolean(row.listening),
    last_active_at: row.last_active_at,
    joined_at: row.joined_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function messageView(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    message_id: row.message_id,
    workspace_id: row.workspace_id,
    sender_member_id: row.sender_member_id,
    sender: row.sender_label,
    kind: row.kind,
    recipients: parseJson(row.recipients, []),
    mentions: parseJson(row.mentions, []),
    body: row.body,
    created_at: row.created_at,
  };
}

function noteView(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    note_id: row.note_id,
    workspace_id: row.workspace_id,
    author_member_id: row.author_member_id,
    author: row.author_label,
    kind: row.kind,
    body: row.body,
    created_at: row.created_at,
  };
}

function fileView(row) {
  if (!row) return null;
  return {
    file_id: row.file_id,
    workspace_id: row.workspace_id,
    uploader_member_id: row.uploader_member_id,
    uploader: row.uploader_label,
    name: row.name,
    size: Number(row.size),
    sha256: row.sha256,
    content_type: row.content_type,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function projectView(row) {
  if (!row) return null;
  return {
    project_key: row.project_key,
    title: row.title,
    git_remote: row.git_remote,
    default_branch: row.default_branch,
    paths: parseJson(row.paths, {}),
    antigravity_projects: parseJson(row.antigravity_projects, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function doorView(row) {
  if (!row) return null;
  return {
    connector_id: row.connector_id,
    runtime: row.runtime,
    kind: row.kind,
    online: Boolean(row.online),
    detail: parseJson(row.detail, {}),
    updated_at: row.updated_at,
  };
}

// A member sees group messages, messages addressed to it, and what it sent.
function visibleTo(message, memberId) {
  if (message.sender_member_id === memberId) return true;
  return message.recipients.length === 0 || message.recipients.includes(memberId);
}

export class WorkspaceStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS ws_projects (
        project_key TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        git_remote TEXT,
        default_branch TEXT,
        paths TEXT NOT NULL DEFAULT '{}',
        antigravity_projects TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ws_workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        brief TEXT NOT NULL DEFAULT '',
        brief_version INTEGER NOT NULL DEFAULT 0,
        project_key TEXT,
        branch TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        gather_ms INTEGER NOT NULL DEFAULT 180000,
        leader_member_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        close_summary TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_active_name ON ws_workspaces(name) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS ws_members (
        member_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ws_workspaces(workspace_id),
        seat TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        job TEXT NOT NULL DEFAULT '',
        runtime TEXT NOT NULL,
        connector_id TEXT,
        session_id TEXT,
        model TEXT,
        ticket_hash TEXT,
        state TEXT NOT NULL,
        state_detail TEXT,
        launch TEXT NOT NULL DEFAULT '{}',
        read_seq INTEGER NOT NULL DEFAULT 0,
        notes_read_seq INTEGER NOT NULL DEFAULT 0,
        notified_seq INTEGER NOT NULL DEFAULT 0,
        notified_at TEXT,
        wake_due_at TEXT,
        wake_status TEXT,
        wake_detail TEXT,
        listening INTEGER NOT NULL DEFAULT 0,
        last_active_at TEXT,
        joined_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, seat)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_members_session ON ws_members(connector_id, runtime, session_id);
      CREATE INDEX IF NOT EXISTS idx_ws_members_ticket ON ws_members(ticket_hash);
      CREATE TABLE IF NOT EXISTS ws_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES ws_workspaces(workspace_id),
        sender_member_id TEXT,
        sender_label TEXT NOT NULL,
        kind TEXT NOT NULL,
        recipients TEXT NOT NULL DEFAULT '[]',
        mentions TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_messages_ws ON ws_messages(workspace_id, seq);
      CREATE TABLE IF NOT EXISTS ws_notes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES ws_workspaces(workspace_id),
        author_member_id TEXT,
        author_label TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_notes_ws ON ws_notes(workspace_id, seq);
      CREATE TABLE IF NOT EXISTS ws_files (
        file_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ws_workspaces(workspace_id),
        uploader_member_id TEXT,
        uploader_label TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        content_type TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'uploading',
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ws_files_ws ON ws_files(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS ws_doors (
        connector_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        kind TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connector_id, runtime)
      );
    `);
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

  // ---- projects ----------------------------------------------------------

  getProject(projectKey) {
    return projectView(this.db.prepare('SELECT * FROM ws_projects WHERE project_key = ?').get(projectKey));
  }

  listProjects() {
    return this.db.prepare('SELECT * FROM ws_projects ORDER BY project_key').all().map(projectView);
  }

  // Each Connector records only its own path; other machines' paths are kept.
  upsertProject({ projectKey, title, gitRemote, defaultBranch, connectorId, path, antigravityProject }) {
    const timestamp = now();
    const existing = this.getProject(projectKey);
    const paths = { ...(existing?.paths ?? {}) };
    const antigravity = { ...(existing?.antigravity_projects ?? {}) };
    if (connectorId && path) paths[connectorId] = path;
    if (connectorId && path === null) delete paths[connectorId];
    if (connectorId && antigravityProject) antigravity[connectorId] = antigravityProject;
    if (existing) {
      this.db.prepare(`
        UPDATE ws_projects SET title = ?, git_remote = ?, default_branch = ?, paths = ?, antigravity_projects = ?, updated_at = ?
        WHERE project_key = ?
      `).run(title ?? existing.title, gitRemote ?? existing.git_remote, defaultBranch ?? existing.default_branch,
        JSON.stringify(paths), JSON.stringify(antigravity), timestamp, projectKey);
    } else {
      this.db.prepare(`
        INSERT INTO ws_projects (project_key, title, git_remote, default_branch, paths, antigravity_projects, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectKey, title ?? '', gitRemote ?? null, defaultBranch ?? null, JSON.stringify(paths), JSON.stringify(antigravity), timestamp, timestamp);
    }
    return this.getProject(projectKey);
  }

  // ---- doors -------------------------------------------------------------

  // A Connector reports its whole set of doors; anything it no longer lists goes offline.
  replaceDoors(connectorId, doors) {
    const timestamp = now();
    return this.transaction(() => {
      this.db.prepare('UPDATE ws_doors SET online = 0, updated_at = ? WHERE connector_id = ?').run(timestamp, connectorId);
      for (const door of doors) {
        this.db.prepare(`
          INSERT INTO ws_doors (connector_id, runtime, kind, online, detail, updated_at) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(connector_id, runtime) DO UPDATE SET kind = excluded.kind, online = 1, detail = excluded.detail, updated_at = excluded.updated_at
        `).run(connectorId, door.runtime, door.kind, JSON.stringify(door.detail ?? {}), timestamp);
      }
      return this.listDoors({ connectorId });
    });
  }

  setDoorsOffline(connectorId) {
    this.db.prepare('UPDATE ws_doors SET online = 0, updated_at = ? WHERE connector_id = ?').run(now(), connectorId);
  }

  listDoors({ connectorId = null } = {}) {
    const rows = connectorId
      ? this.db.prepare('SELECT * FROM ws_doors WHERE connector_id = ? ORDER BY runtime').all(connectorId)
      : this.db.prepare('SELECT * FROM ws_doors ORDER BY connector_id, runtime').all();
    return rows.map(doorView);
  }

  getDoor(connectorId, runtime) {
    return doorView(this.db.prepare('SELECT * FROM ws_doors WHERE connector_id = ? AND runtime = ?').get(connectorId, runtime));
  }

  // ---- workspaces --------------------------------------------------------

  getWorkspace(workspaceId) {
    return workspaceView(this.db.prepare('SELECT * FROM ws_workspaces WHERE workspace_id = ?').get(workspaceId));
  }

  getActiveWorkspaceByName(name) {
    return workspaceView(this.db.prepare("SELECT * FROM ws_workspaces WHERE name = ? AND status = 'active'").get(name));
  }

  listWorkspaces({ status = null, limit = 100 } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM ws_workspaces WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare("SELECT * FROM ws_workspaces ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT ?").all(limit);
    return rows.map(workspaceView);
  }

  createWorkspace({ name, title, goal = '', brief = '', projectKey = null, branch = null, gatherMs }) {
    if (this.getActiveWorkspaceByName(name)) throw storeError(`An active workspace named ${name} already exists`, 409, 'workspace_exists');
    const timestamp = now();
    const workspaceId = createId('ws');
    this.db.prepare(`
      INSERT INTO ws_workspaces (workspace_id, name, title, goal, brief, brief_version, project_key, branch, status, gather_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(workspaceId, name, title, goal, brief, brief ? 1 : 0, projectKey, branch, gatherMs, timestamp, timestamp);
    return this.getWorkspace(workspaceId);
  }

  setLeader(workspaceId, memberId) {
    this.db.prepare('UPDATE ws_workspaces SET leader_member_id = ?, updated_at = ? WHERE workspace_id = ?').run(memberId, now(), workspaceId);
    return this.getWorkspace(workspaceId);
  }

  setBrief(workspaceId, brief) {
    this.db.prepare('UPDATE ws_workspaces SET brief = ?, brief_version = brief_version + 1, updated_at = ? WHERE workspace_id = ?')
      .run(brief, now(), workspaceId);
    return this.getWorkspace(workspaceId);
  }

  closeWorkspace(workspaceId, summary = null) {
    const timestamp = now();
    this.db.prepare("UPDATE ws_workspaces SET status = 'closed', closed_at = ?, close_summary = ?, updated_at = ? WHERE workspace_id = ?")
      .run(timestamp, summary, timestamp, workspaceId);
    return this.getWorkspace(workspaceId);
  }

  // Removes a workspace and everything in it; returns the file ids whose bodies the caller deletes.
  deleteWorkspace(workspaceId) {
    return this.transaction(() => {
      const files = this.db.prepare('SELECT file_id FROM ws_files WHERE workspace_id = ?').all(workspaceId).map((row) => row.file_id);
      for (const table of ['ws_messages', 'ws_notes', 'ws_files', 'ws_members', 'ws_workspaces']) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      }
      return files;
    });
  }

  touchWorkspace(workspaceId) {
    this.db.prepare('UPDATE ws_workspaces SET updated_at = ? WHERE workspace_id = ?').run(now(), workspaceId);
  }

  // ---- members -----------------------------------------------------------

  getMember(memberId) {
    return memberView(this.db.prepare('SELECT * FROM ws_members WHERE member_id = ?').get(memberId));
  }

  getMemberBySeat(workspaceId, seat) {
    return memberView(this.db.prepare('SELECT * FROM ws_members WHERE workspace_id = ? AND seat = ?').get(workspaceId, seat));
  }

  listMembers(workspaceId) {
    return this.db.prepare(`
      SELECT * FROM ws_members WHERE workspace_id = ?
      ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, created_at, seat
    `).all(workspaceId).map(memberView);
  }

  // The seat a native session currently holds in an active workspace, if any.
  findActiveMemberBySession(connectorId, runtime, sessionId) {
    return memberView(this.db.prepare(`
      SELECT m.* FROM ws_members m JOIN ws_workspaces w ON w.workspace_id = m.workspace_id
      WHERE m.connector_id = ? AND m.runtime = ? AND m.session_id = ? AND w.status = 'active' AND m.state = 'joined'
      ORDER BY m.joined_at DESC LIMIT 1
    `).get(connectorId, runtime, sessionId));
  }

  // The most recent seat (any workspace state) of a native session, for leaving and history.
  findLatestMemberBySession(connectorId, runtime, sessionId) {
    return memberView(this.db.prepare(`
      SELECT * FROM ws_members WHERE connector_id = ? AND runtime = ? AND session_id = ?
      ORDER BY COALESCE(joined_at, created_at) DESC LIMIT 1
    `).get(connectorId, runtime, sessionId));
  }

  findMemberByTicket(ticketHash) {
    return memberView(this.db.prepare('SELECT * FROM ws_members WHERE ticket_hash = ?').get(ticketHash));
  }

  createMember({ workspaceId, seat, role = 'member', job = '', runtime, connectorId = null, sessionId = null, model = null,
    ticketHash = null, state = 'requested', stateDetail = null, launch = {} }) {
    if (this.getMemberBySeat(workspaceId, seat)) throw storeError(`Seat ${seat} already exists in this workspace`, 409, 'seat_exists');
    const timestamp = now();
    const memberId = createId('wsm');
    const joined = state === 'joined';
    this.db.prepare(`
      INSERT INTO ws_members (member_id, workspace_id, seat, role, job, runtime, connector_id, session_id, model, ticket_hash,
        state, state_detail, launch, joined_at, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memberId, workspaceId, seat, role, job, runtime, connectorId, sessionId, model, ticketHash,
      state, stateDetail, JSON.stringify(launch), joined ? timestamp : null, joined ? timestamp : null, timestamp, timestamp);
    return this.getMember(memberId);
  }

  updateMember(memberId, fields) {
    const columns = {
      state: 'state', state_detail: 'state_detail', connector_id: 'connector_id', session_id: 'session_id',
      ticket_hash: 'ticket_hash', read_seq: 'read_seq', notes_read_seq: 'notes_read_seq', notified_seq: 'notified_seq',
      notified_at: 'notified_at', wake_due_at: 'wake_due_at', wake_status: 'wake_status', wake_detail: 'wake_detail',
      listening: 'listening', last_active_at: 'last_active_at', joined_at: 'joined_at', job: 'job', model: 'model', runtime: 'runtime',
    };
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'launch') {
        sets.push('launch = ?');
        values.push(JSON.stringify(value ?? {}));
        continue;
      }
      if (!columns[key]) throw new Error(`Unknown member field ${key}`);
      sets.push(`${columns[key]} = ?`);
      values.push(key === 'listening' ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return this.getMember(memberId);
    sets.push('updated_at = ?');
    values.push(now(), memberId);
    this.db.prepare(`UPDATE ws_members SET ${sets.join(', ')} WHERE member_id = ?`).run(...values);
    return this.getMember(memberId);
  }

  // Members whose batched doorbell is due, across all active workspaces.
  listDueWakes(at) {
    return this.db.prepare(`
      SELECT m.* FROM ws_members m JOIN ws_workspaces w ON w.workspace_id = m.workspace_id
      WHERE w.status = 'active' AND m.state = 'joined' AND m.wake_due_at IS NOT NULL AND m.wake_due_at <= ?
    `).all(at).map(memberView);
  }

  // Joined members that were told about mail they still have not read.
  listUnreadAfterRing(before) {
    return this.db.prepare(`
      SELECT m.* FROM ws_members m JOIN ws_workspaces w ON w.workspace_id = m.workspace_id
      WHERE w.status = 'active' AND m.state = 'joined' AND m.read_seq < m.notified_seq
        AND m.notified_at IS NOT NULL AND m.notified_at <= ? AND m.wake_due_at IS NULL
    `).all(before).map(memberView);
  }

  listJoinedMembersOnConnector(connectorId) {
    return this.db.prepare(`
      SELECT m.* FROM ws_members m JOIN ws_workspaces w ON w.workspace_id = m.workspace_id
      WHERE w.status = 'active' AND m.state = 'joined' AND m.connector_id = ?
    `).all(connectorId).map(memberView);
  }

  listLaunchingMembers() {
    return this.db.prepare(`
      SELECT m.* FROM ws_members m JOIN ws_workspaces w ON w.workspace_id = m.workspace_id
      WHERE w.status = 'active' AND m.state IN ('requested', 'launching', 'launched')
    `).all().map(memberView);
  }

  // ---- messages ----------------------------------------------------------

  addMessage({ workspaceId, senderMemberId = null, senderLabel, kind, recipients = [], mentions = [], body }) {
    if (!MESSAGE_KINDS.includes(kind)) throw storeError(`Unknown message kind ${kind}`);
    const timestamp = now();
    const messageId = createId('wsmsg');
    this.db.prepare(`
      INSERT INTO ws_messages (message_id, workspace_id, sender_member_id, sender_label, kind, recipients, mentions, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, workspaceId, senderMemberId, senderLabel, kind, JSON.stringify(recipients), JSON.stringify(mentions), body, timestamp);
    this.touchWorkspace(workspaceId);
    return messageView(this.db.prepare('SELECT * FROM ws_messages WHERE message_id = ?').get(messageId));
  }

  listMessages(workspaceId, { after = 0, limit = 200, before = null } = {}) {
    if (before !== null) {
      return this.db.prepare('SELECT * FROM ws_messages WHERE workspace_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(workspaceId, before, limit).map(messageView).reverse();
    }
    return this.db.prepare('SELECT * FROM ws_messages WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(workspaceId, after, limit).map(messageView);
  }

  recentMessages(workspaceId, limit = 200) {
    return this.db.prepare('SELECT * FROM ws_messages WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?')
      .all(workspaceId, limit).map(messageView).reverse();
  }

  // Messages a member can see after `after`, never its own.
  unreadFor(member, { after = member.read_seq, limit = 500 } = {}) {
    return this.listMessages(member.workspace_id, { after, limit })
      .filter((message) => message.sender_member_id !== member.member_id && visibleTo(message, member.member_id));
  }

  visibleRecent(member, limit = 20) {
    return this.recentMessages(member.workspace_id, limit * 4)
      .filter((message) => visibleTo(message, member.member_id))
      .slice(-limit);
  }

  latestSeq(workspaceId) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM ws_messages WHERE workspace_id = ?').get(workspaceId).seq);
  }

  // ---- notes -------------------------------------------------------------

  addNote({ workspaceId, authorMemberId = null, authorLabel, kind = 'note', body }) {
    if (!NOTE_KINDS.includes(kind)) throw storeError(`Note kind must be one of ${NOTE_KINDS.join(', ')}`);
    const timestamp = now();
    const noteId = createId('wsnote');
    this.db.prepare(`
      INSERT INTO ws_notes (note_id, workspace_id, author_member_id, author_label, kind, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(noteId, workspaceId, authorMemberId, authorLabel, kind, body, timestamp);
    this.touchWorkspace(workspaceId);
    return noteView(this.db.prepare('SELECT * FROM ws_notes WHERE note_id = ?').get(noteId));
  }

  listNotes(workspaceId, { after = 0, limit = 500 } = {}) {
    return this.db.prepare('SELECT * FROM ws_notes WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(workspaceId, after, limit).map(noteView);
  }

  // ---- files -------------------------------------------------------------

  createFile({ workspaceId, uploaderMemberId = null, uploaderLabel, name, contentType = null, note = null }) {
    const timestamp = now();
    const fileId = createId('wsfile');
    this.db.prepare(`
      INSERT INTO ws_files (file_id, workspace_id, uploader_member_id, uploader_label, name, content_type, note, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?)
    `).run(fileId, workspaceId, uploaderMemberId, uploaderLabel, name, contentType, note, timestamp);
    return this.getFile(fileId);
  }

  completeFile(fileId, { size, sha256 }) {
    this.db.prepare("UPDATE ws_files SET status = 'ready', size = ?, sha256 = ?, completed_at = ? WHERE file_id = ?")
      .run(size, sha256, now(), fileId);
    const file = this.getFile(fileId);
    if (file) this.touchWorkspace(file.workspace_id);
    return file;
  }

  failFile(fileId) {
    this.db.prepare("UPDATE ws_files SET status = 'failed', completed_at = ? WHERE file_id = ?").run(now(), fileId);
    return this.getFile(fileId);
  }

  getFile(fileId) {
    return fileView(this.db.prepare('SELECT * FROM ws_files WHERE file_id = ?').get(fileId));
  }

  listFiles(workspaceId) {
    return this.db.prepare("SELECT * FROM ws_files WHERE workspace_id = ? AND status = 'ready' ORDER BY created_at").all(workspaceId).map(fileView);
  }
}
