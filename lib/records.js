// 存储层：偶头/配件/装箱单等档案、履历事件、字段变更留痕的读写。
// 只负责落盘与取数，字段能不能改、什么状态该联动由审核层决定。
const { randomUUID } = require('crypto');
const db = require('./db');
const config = require('../project.config');

function now() {
  return new Date().toISOString();
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

async function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  await db.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
    [
      randomUUID(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

// 纠错通过后每个字段的旧值/新值留痕：履历按时间排，旧值按字段随时可查。
async function insertFieldHistory({ correctionId, recordId, collection, field, oldValue, newValue, evidence, actor }) {
  await db.run(
    `INSERT INTO field_history
       (id, correction_id, record_id, collection, field, old_value, new_value, evidence, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      randomUUID(),
      correctionId,
      recordId,
      collection,
      field,
      oldValue === null || oldValue === undefined ? null : String(oldValue),
      newValue === null || newValue === undefined ? null : String(newValue),
      JSON.stringify(evidence || {}),
      actor || '',
      now()
    ]
  );
}

async function listFieldHistory(collection, recordId) {
  const rows = await db.all(
    'SELECT * FROM field_history WHERE collection = ? AND record_id = ? ORDER BY created_at ASC;',
    [collection, recordId]
  );
  return rows.map((row) => ({
    id: row.id,
    correctionId: row.correction_id,
    recordId: row.record_id,
    collection: row.collection,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    evidence: JSON.parse(row.evidence || '{}'),
    actor: row.actor,
    createdAt: row.created_at
  }));
}

async function loadRecord(collection, id) {
  const row = await db.get('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [collection, id]);
  return row ? toRecord(row) : null;
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  return db.run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?;',
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
}

async function insertRecord(collection, data, status) {
  const collectionConfig = findCollection(collection);
  const id = randomUUID();
  const createdAt = now();
  await db.run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
    [id, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
  );
  return { id, createdAt };
}

async function listRecords(collection) {
  const rows = await db.all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [collection]);
  return rows.map(toRecord);
}

async function initSchema() {
  await db.run(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);');
  await db.run('CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);');
  await db.run(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);');
  await db.run(`
CREATE TABLE IF NOT EXISTS field_history (
  id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  evidence TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL
);`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_history_record ON field_history(record_id);');
  await db.run('CREATE INDEX IF NOT EXISTS idx_history_correction ON field_history(correction_id);');
}

async function seedData() {
  const row = await db.get('SELECT COUNT(*) AS count FROM records;');
  if (row.count > 0) return;
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    await db.run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      [id, seed.collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, seed.updatedAt || createdAt]
    );
    await insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
}

module.exports = {
  now,
  toRecord,
  findCollection,
  titleFor,
  insertEvent,
  insertFieldHistory,
  listFieldHistory,
  loadRecord,
  saveRecord,
  insertRecord,
  listRecords,
  initSchema,
  seedData
};
