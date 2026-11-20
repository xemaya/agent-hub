import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, waitFor } from './helpers.js';

const channelEvents = (context, workerId) => context.hub.store.listEvents(1000)
  .filter((event) => event.worker_id === workerId && event.event_type.startsWith('worker.channel_'))
  .map((event) => event.event_type)
  .reverse();

test('A Channel re-reported without a change records no new event', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker();
  assert.deepEqual(channelEvents(context, worker.worker_id), ['worker.channel_attached']);

  // What every Connector reconnect does: report each live Channel again.
  await context.connector.announceChannel(worker.worker_id, true);
  await context.connector.announceChannel(worker.worker_id, true);
  assert.deepEqual(channelEvents(context, worker.worker_id), ['worker.channel_attached']);

  await context.detachWorker(worker);
  await context.connector.announceChannel(worker.worker_id, false);
  assert.deepEqual(channelEvents(context, worker.worker_id), ['worker.channel_attached', 'worker.channel_detached']);
});

test('Presence events older than the retention are pruned at most hourly, and other events are kept', async (t) => {
  const context = await createTestContext(t, { hub: { presenceEventRetentionMs: 24 * 60 * 60 * 1000 } });
  const { hub } = context;
  await context.registerWorker();
  hub.emit('task.created', { type: 'hub', id: 'test' }, { payload: { title: 'old task' } });
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  hub.store.db.prepare('UPDATE events SET created_at = ?').run(old);
  hub.emit('connector.online', { type: 'hub', id: 'test' }, { connector_id: context.connector.connectorId });

  const types = () => hub.store.listEvents(1000).map((event) => event.event_type).sort();
  const before = types();
  assert.ok(before.includes('worker.channel_attached'));

  const nowMs = Date.now();
  const removed = hub.prunePresenceEvents(nowMs);
  assert.ok(removed >= 2, 'the old attach and online events go');
  const after = types();
  assert.equal(after.includes('worker.channel_attached'), false);
  assert.ok(after.includes('task.created'), 'a non-presence event is kept however old');
  assert.equal(after.filter((type) => type === 'connector.online').length, 1, 'a recent presence event is kept');

  hub.store.db.prepare('UPDATE events SET created_at = ?').run(old);
  assert.equal(hub.prunePresenceEvents(nowMs + 60_000), 0, 'not again within the hour');
  assert.equal(hub.prunePresenceEvents(nowMs + 61 * 60_000), 1);
});

test('A retention of 0 keeps presence events', async (t) => {
  const context = await createTestContext(t, { hub: { presenceEventRetentionMs: 0 } });
  context.hub.store.db.prepare('UPDATE events SET created_at = ?').run('2000-01-01T00:00:00.000Z');
  const count = context.hub.store.listEvents(1000).length;
  assert.equal(context.hub.prunePresenceEvents(), 0);
  assert.equal(context.hub.store.listEvents(1000).length, count);
});

test('A filtered event cursor moves to the present, so pruning the event it started on does not strand it', async (t) => {
  const context = await createTestContext(t);
  const start = await context.admin('/api/v1/events?after=&types=attention.created');
  const cursor = start.payload.cursor;
  assert.ok(cursor);
  context.hub.emit('connector.online', { type: 'hub', id: 'test' }, { connector_id: context.connector.connectorId });
  const next = await context.admin(`/api/v1/events?after=${encodeURIComponent(cursor)}&types=attention.created`);
  assert.deepEqual(next.payload.events, []);
  assert.equal(next.payload.cursor, context.hub.store.latestEventId(), 'past the filtered-out event');

  // Delete the event the old cursor pointed at; the new cursor still works.
  context.hub.store.db.prepare('DELETE FROM events WHERE event_id = ?').run(cursor);
  const later = await context.admin(`/api/v1/events?after=${encodeURIComponent(next.payload.cursor)}&types=attention.created`);
  assert.equal(later.response.status, 200);

  // A full page keeps the cursor on the last returned event.
  for (let i = 0; i < 3; i += 1) context.hub.emit('attention.created', { type: 'hub', id: 'test' }, {});
  const page = await context.admin(`/api/v1/events?after=${encodeURIComponent(next.payload.cursor)}&types=attention.created&limit=2`);
  assert.equal(page.payload.events.length, 2);
  assert.equal(page.payload.cursor, page.payload.events[1].event_id);
});

test('After a reconnect the Connector records which finished commands the Hub has, and only those can be pruned', async (t) => {
  const context = await createTestContext(t);
  const worker = await context.registerWorker();
  const dispatched = await context.admin('/api/v1/commands', { method: 'POST', body: { worker_id: worker.worker_id, input: 'hello' } });
  const commandId = dispatched.payload.command.command_id;
  await waitFor(async () => (await context.admin(`/api/v1/commands/${commandId}`)).payload.command.status === 'succeeded');
  // A local record the Hub has never heard of, as after the Hub deleted its task.
  await context.connector.store.acceptCommand({ command_id: 'cmd_gone', task_id: null, worker_id: worker.worker_id, kind: 'task', input: 'x' });
  await context.connector.store.updateCommand('cmd_gone', { status: 'failed', error: { message: 'x' } });
  assert.equal(context.connector.store.getCommand(commandId).hub_synced_at, undefined);

  await context.restartConnector();
  const store = context.connector.store;
  await waitFor(() => store.getCommand(commandId)?.hub_synced_at && store.getCommand('cmd_gone')?.hub_synced_at);
  const { commands } = await store.prune({ now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
  assert.equal(commands, 2);
  assert.equal(store.getCommand(commandId), null);
});
