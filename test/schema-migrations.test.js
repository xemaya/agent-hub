import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { HubStore, LEGACY_SCHEMA_VERSION, SCHEMA_VERSION } from '../src/db.js';

async function databaseRoot(t) {
  const parent = path.resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// What a database's structure is, independent of column order and of whether a
// column arrived in CREATE TABLE or a later ALTER TABLE.
function shape(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const result = {};
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all()
      .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`).sort();
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${name})`).all()
      .map((f) => `${f.from} -> ${f.table}(${f.to ?? ''})`).sort();
    const indexes = db.prepare(`PRAGMA index_list(${name})`).all()
      .map((index) => {
        const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map((c) => c.name).join(',');
        // Autoindex names depend on declaration order; describe them by what they enforce.
        const label = index.origin === 'c' ? index.name : `${index.origin}:${columns}`;
        return `${label} unique=${index.unique} partial=${index.partial} on=${columns}`;
      }).sort();
    result[name] = { columns, foreignKeys, indexes };
  }
  return result;
}

async function legacyDatabase(t, fixture) {
  const { user_version: version, statements } = JSON.parse(await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'));
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  const db = new DatabaseSync(filename);
  for (const statement of statements) db.exec(statement);
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return filename;
}

async function freshShape(t) {
  const root = await databaseRoot(t);
  const store = new HubStore(path.join(root, 'hub.db'));
  const result = shape(store.db);
  store.close();
  return result;
}

// Known, harmless differences between an upgraded database and a new one. Schema-1
// databases (the production Hub's among them) have workers.mode without its later
// DEFAULT 'external'; every INSERT sets mode, so the default is never used. Remove the
// entry when a migration drops or rebuilds workers.mode.
const KNOWN_DIFFERENCES = {
  'schema-v1.json': (actual) => {
    const columns = actual.workers.columns;
    const index = columns.indexOf('mode TEXT notnull=1 default=null pk=0');
    if (index >= 0) columns[index] = "mode TEXT notnull=1 default='external' pk=0";
  },
};

for (const fixture of ['schema-v1.json', 'schema-v17.json']) {
  test(`A database created by an older release (${fixture}) upgrades to the same structure as a new one`, async (t) => {
    const filename = await legacyDatabase(t, fixture);
    const store = new HubStore(filename);
    t.after(() => store.close());
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    const actual = shape(store.db);
    KNOWN_DIFFERENCES[fixture]?.(actual);
    assert.deepEqual(actual, await freshShape(t));
  });
}

test('A database already at the current schema skips the legacy upgrade', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  let store = new HubStore(filename);
  t.after(() => store?.close());
  // A column the legacy upgrade would add back if it ran again.
  store.db.exec('ALTER TABLE roles DROP COLUMN alert_role');
  store.close();
  store = new HubStore(filename);
  const columns = store.db.prepare('PRAGMA table_info(roles)').all().map((column) => column.name);
  assert.equal(columns.includes('alert_role'), false);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
});

test('Migrations run once in order, and a failing one rolls back and keeps the previous version', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  const ran = [];
  const migrations = [
    { version: LEGACY_SCHEMA_VERSION + 1, up(db) { ran.push('a'); db.exec('CREATE TABLE probe_a (id INTEGER PRIMARY KEY)'); } },
    { version: LEGACY_SCHEMA_VERSION + 2, up(db) { ran.push('b'); db.exec('CREATE TABLE probe_b (id INTEGER PRIMARY KEY)'); } },
  ];
  let store = new HubStore(filename, { migrations });
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(store.schemaVersion(), LEGACY_SCHEMA_VERSION + 2);
  store.close();

  store = new HubStore(filename, { migrations });
  assert.deepEqual(ran, ['a', 'b'], 'reopening runs nothing again');
  store.close();

  const failing = [...migrations, {
    version: LEGACY_SCHEMA_VERSION + 3,
    up(db) { db.exec('CREATE TABLE probe_c (id INTEGER PRIMARY KEY)'); throw new Error('boom'); },
  }];
  assert.throws(() => new HubStore(filename, { migrations: failing }), /boom/);
  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, LEGACY_SCHEMA_VERSION + 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'probe_c'").get().n, 0);
});

test('A table rebuild runs with foreign keys off and is refused if it breaks them', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  const rebuild = {
    version: LEGACY_SCHEMA_VERSION + 1,
    rebuildsTable: true,
    up(db) {
      db.exec("INSERT INTO handoffs (handoff_id, task_id, role_key, reason, status, not_before, created_at) VALUES ('h1', 'task_missing', 'qa', 'initial', 'open', 'x', 'x')");
    },
  };
  assert.throws(() => new HubStore(filename, { migrations: [rebuild] }), /break foreign keys/);
  const store = new HubStore(filename);
  t.after(() => store.close());
  assert.equal(store.schemaVersion(), LEGACY_SCHEMA_VERSION);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n, 0);
});

test('A database newer than this code is refused instead of being written to', async (t) => {
  const root = await databaseRoot(t);
  const filename = path.join(root, 'hub.db');
  new HubStore(filename).close();
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => new HubStore(filename), /newer than this agent-hub/);
});
