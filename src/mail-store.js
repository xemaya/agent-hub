import { createId } from './ids.js';

function mailError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: 'mailbox_error' });
}

const SELECT = `SELECT m.*, s.name AS sender_name, r.name AS recipient_name
  FROM worker_mail m JOIN workers s ON s.worker_id=m.sender_worker_id
  JOIN workers r ON r.worker_id=m.recipient_worker_id`;

function view(row) {
  if (!row) return null;
  const { sequence, ...message } = row;
  return { ...message, sequence: Number(sequence) };
}

export class MailStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_mail (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        sender_worker_id TEXT NOT NULL REFERENCES workers(worker_id),
        recipient_worker_id TEXT NOT NULL REFERENCES workers(worker_id),
        client_message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        in_reply_to TEXT REFERENCES worker_mail(message_id),
        command_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        inbox_delivered_at TEXT NOT NULL,
        read_at TEXT,
        notification_status TEXT NOT NULL DEFAULT 'pending',
        notification_attempted_at TEXT,
        notified_at TEXT,
        notification_error TEXT,
        UNIQUE(sender_worker_id, client_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mail_inbox ON worker_mail(recipient_worker_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_mail_outbox ON worker_mail(sender_worker_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_mail_pending ON worker_mail(recipient_worker_id, notification_status);
    `);
  }

  get(messageId) {
    return view(this.db.prepare(`${SELECT} WHERE m.message_id=?`).get(messageId));
  }

  byClientId(senderId, clientMessageId) {
    return view(this.db.prepare(`${SELECT} WHERE m.sender_worker_id=? AND m.client_message_id=?`).get(senderId, clientMessageId));
  }

  forWorker(messageId, workerId) {
    const message = this.get(messageId);
    if (!message || ![message.sender_worker_id, message.recipient_worker_id].includes(workerId)) {
      throw mailError('Message not found in this Worker mailbox', 404);
    }
    return message;
  }

  create({ senderId, recipientId, clientMessageId, subject, body, commandId = null, inReplyTo = null }) {
    const existing = this.db.prepare('SELECT message_id FROM worker_mail WHERE sender_worker_id=? AND client_message_id=?')
      .get(senderId, clientMessageId);
    if (existing) {
      const message = this.get(existing.message_id);
      if (message.recipient_worker_id !== recipientId || message.subject !== subject || message.body !== body
        || message.command_id !== commandId || message.in_reply_to !== inReplyTo) {
        throw mailError('client_message_id was already used with different message contents', 409);
      }
      return { message, duplicate: true };
    }
    let conversationId = createId('conversation');
    if (inReplyTo) {
      const parent = this.forWorker(inReplyTo, senderId);
      if (![parent.sender_worker_id, parent.recipient_worker_id].includes(recipientId) || recipientId === senderId) {
        throw mailError('A reply must address the other participant of the original message', 403);
      }
      conversationId = parent.conversation_id;
    }
    const id = createId('mail');
    const timestamp = new Date().toISOString();
    // One durable row is both the sender's outbox entry and the recipient's
    // inbox entry. Acceptance never depends on a live session or model reply.
    this.db.prepare(`INSERT INTO worker_mail
      (message_id,sender_worker_id,recipient_worker_id,client_message_id,conversation_id,in_reply_to,command_id,subject,body,accepted_at,inbox_delivered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, senderId, recipientId, clientMessageId, conversationId, inReplyTo, commandId, subject, body, timestamp, timestamp);
    return { message: this.get(id), duplicate: false };
  }

  list(workerId, { folder = 'inbox', limit = 50, before = null, unread = false } = {}) {
    if (!['inbox', 'outbox'].includes(folder)) throw mailError('folder must be inbox or outbox');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw mailError('limit must be between 1 and 100');
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw mailError('Invalid mailbox cursor');
    if (unread && folder !== 'inbox') throw mailError('unread is only supported for inbox');
    const column = folder === 'inbox' ? 'recipient_worker_id' : 'sender_worker_id';
    const rows = this.db.prepare(`${SELECT} WHERE m.${column}=? ${before === null ? '' : 'AND m.sequence < ?'}
      ${unread ? 'AND m.read_at IS NULL' : ''} ORDER BY m.sequence DESC LIMIT ?`)
      .all(workerId, ...(before === null ? [] : [before]), limit + 1);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(row => {
      const { body, ...message } = view(row);
      return { ...message, preview: body.slice(0, 600), body_length: body.length };
    });
    return { folder, messages, next_cursor: hasMore ? messages.at(-1).sequence : null,
      unread_count: Number(this.db.prepare('SELECT count(*) AS count FROM worker_mail WHERE recipient_worker_id=? AND read_at IS NULL').get(workerId).count) };
  }

  read(messageId, workerId) {
    const message = this.forWorker(messageId, workerId);
    if (message.recipient_worker_id !== workerId) return message;
    this.db.prepare('UPDATE worker_mail SET read_at=COALESCE(read_at,?) WHERE message_id=?')
      .run(new Date().toISOString(), messageId);
    return this.get(messageId);
  }

  pending(workerId) {
    return this.db.prepare(`${SELECT} WHERE m.recipient_worker_id=? AND m.notification_status='pending' AND m.read_at IS NULL ORDER BY m.sequence ASC LIMIT 50`)
      .all(workerId).map(view);
  }

  offer(messageId) {
    const changed = this.db.prepare(`UPDATE worker_mail SET notification_status='offered',notification_attempted_at=?
      WHERE message_id=? AND notification_status='pending' AND read_at IS NULL`).run(new Date().toISOString(), messageId).changes;
    return changed ? this.get(messageId) : null;
  }

  notification(messageId, status, error = null) {
    if (!['pending', 'accepted', 'unknown', 'unsupported'].includes(status)) throw mailError('Invalid notification status');
    this.db.prepare(`UPDATE worker_mail SET notification_status=?,notification_error=?,
      notified_at=CASE WHEN ?='accepted' THEN COALESCE(notified_at,?) ELSE notified_at END
      WHERE message_id=? AND notification_status<>'accepted'`)
      .run(status, error, status, new Date().toISOString(), messageId);
    return this.get(messageId);
  }

  retryUnsupported(workerId) {
    this.db.prepare(`UPDATE worker_mail SET notification_status='pending',notification_error=NULL
      WHERE recipient_worker_id=? AND notification_status='unsupported' AND read_at IS NULL`).run(workerId);
  }
}
