// 存储层：纠错单（corrections）的落盘与查询。
// 同一件只留一份待审由审核层保证，这里只提供唯一索引兜底。
const { randomUUID } = require('crypto');
const db = require('./db');
const recordsStore = require('./records');

const STATUS_PENDING = '待审核';
const STATUS_APPROVED = '已通过';
const STATUS_RETURNED = '已退回';

function toCorrection(row) {
  return {
    id: row.id,
    targetCollection: row.target_collection,
    targetId: row.target_id,
    status: row.status,
    submitter: row.submitter,
    reason: row.reason,
    evidence: JSON.parse(row.evidence || '{}'),
    changes: JSON.parse(row.changes || '[]'),
    returnReason: row.return_reason || '',
    reviewResult: JSON.parse(row.review_result || '{}'),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null
  };
}

async function initSchema() {
  await db.run(`
CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  target_collection TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  submitter TEXT,
  reason TEXT,
  evidence TEXT NOT NULL,
  changes TEXT NOT NULL,
  return_reason TEXT,
  review_result TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);`);
  // 同一件最多一条待审核；其他状态不进唯一索引，放行历史并存。
  await db.run(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_corrections_one_pending
  ON corrections(target_collection, target_id) WHERE status = '${STATUS_PENDING}';`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_collection, target_id);');
  await db.run('CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status);');
}

async function insertCorrection({ targetCollection, targetId, submitter, reason, evidence, changes }) {
  const id = randomUUID();
  const createdAt = recordsStore.now();
  await db.run(
    `INSERT INTO corrections
       (id, target_collection, target_id, status, submitter, reason, evidence, changes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      targetCollection,
      targetId,
      STATUS_PENDING,
      submitter || '',
      reason || '',
      JSON.stringify(evidence || {}),
      JSON.stringify(changes || []),
      createdAt
    ]
  );
  return getCorrection(id);
}

async function getCorrection(id) {
  const row = await db.get('SELECT * FROM corrections WHERE id = ? LIMIT 1;', [id]);
  return row ? toCorrection(row) : null;
}

async function findPendingCorrection(targetCollection, targetId) {
  const row = await db.get(
    'SELECT * FROM corrections WHERE target_collection = ? AND target_id = ? AND status = ? LIMIT 1;',
    [targetCollection, targetId, STATUS_PENDING]
  );
  return row ? toCorrection(row) : null;
}

async function listCorrections({ targetCollection, targetId, status } = {}) {
  const where = [];
  const params = [];
  if (targetCollection) {
    where.push('target_collection = ?');
    params.push(targetCollection);
  }
  if (targetId) {
    where.push('target_id = ?');
    params.push(targetId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const sql = 'SELECT * FROM corrections' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC;';
  return (await db.all(sql, params)).map(toCorrection);
}

async function markReturned(id, returnReason) {
  await db.run(
    'UPDATE corrections SET status = ?, return_reason = ?, reviewed_at = ? WHERE id = ?;',
    [STATUS_RETURNED, returnReason, recordsStore.now(), id]
  );
  return getCorrection(id);
}

async function markApproved(id, reviewResult) {
  await db.run(
    'UPDATE corrections SET status = ?, review_result = ?, reviewed_at = ? WHERE id = ?;',
    [STATUS_APPROVED, JSON.stringify(reviewResult || {}), recordsStore.now(), id]
  );
  return getCorrection(id);
}

module.exports = {
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_RETURNED,
  initSchema,
  insertCorrection,
  getCorrection,
  findPendingCorrection,
  listCorrections,
  markReturned,
  markApproved
};
