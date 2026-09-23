const { randomUUID } = require('crypto');
const db = require('./db');
const config = require('../project.config');

function now() {
  return new Date().toISOString();
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

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  db.exec(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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

function initDb() {
  db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
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
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);

  const count = db.getOne('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    db.exec(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        seed.collection,
        status,
        titleFor(collectionConfig, data),
        JSON.stringify(data),
        createdAt,
        seed.updatedAt || createdAt
      ]
    );
    insertEvent({
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

function loadRecord(collection, id) {
  const row = db.getOne(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;',
    [collection, id]
  );
  return row ? toRecord(row) : null;
}

function listRecords(collection) {
  return db
    .query('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [collection])
    .map(toRecord);
}

// 事务内保存：不落盘，由外层 correctionStore 事务统一提交
function saveRecordInTx(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  db.query(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?;',
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
}

function saveRecord(collection, id, data, status) {
  saveRecordInTx(collection, id, data, status);
  db.persist();
}

function insertRecord({ collection, id, data, status }) {
  const collectionConfig = findCollection(collection);
  const createdAt = now();
  db.exec(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
  );
}

function insertEventInTx({ recordId, collection, action, status, actor, note, data }) {
  db.query(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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

function listEvents(recordId) {
  return db
    .query('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

function deleteRecord(collection, id) {
  db.exec('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, id]);
  db.exec('DELETE FROM events WHERE record_id = ?;', [id]);
}

module.exports = {
  now,
  toRecord,
  findCollection,
  titleFor,
  validate,
  initDb,
  loadRecord,
  listRecords,
  saveRecord,
  saveRecordInTx,
  insertRecord,
  insertEvent,
  insertEventInTx,
  listEvents,
  deleteRecord
};
