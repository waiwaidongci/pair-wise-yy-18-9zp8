const { randomUUID, createHash } = require('crypto');
const db = require('./db');
const store = require('./recordStore');
const config = require('../project.config');

const correctionConfig = config.corrections;
const STATUS_PENDING = '待审';
const STATUS_APPROVED = '已通过';
const STATUS_REJECTED = '已退回';

function now() {
  return new Date().toISOString();
}

function normalize(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toCorrection(row) {
  if (!row) return null;
  return {
    id: row.id,
    targetCollection: row.target_collection,
    targetId: row.target_id,
    status: row.status,
    changes: JSON.parse(row.changes_json || '[]'),
    reason: row.reason,
    submittedBy: row.submitted_by,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// 去重指纹：同一件 + 同一批「字段→新值 + 凭证」视为重复提交，沿用首次结果
function buildDedupeKey(targetCollection, targetId, changes) {
  const canonical = JSON.stringify(
    changes
      .map((change) => ({
        field: change.field,
        newValue: change.newValue,
        evidence: change.evidence
      }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
  );
  return createHash('sha256')
    .update([targetCollection, targetId, canonical].join(''))
    .digest('hex');
}

function initCorrections() {
  db.exec(`
CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  target_collection TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  reason TEXT,
  submitted_by TEXT,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_collection, target_id);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_corrections_dedupe ON corrections(dedupe_key);
`);
}

function listCorrections(filters = {}) {
  let sql = 'SELECT * FROM corrections';
  const where = [];
  const params = [];
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.targetCollection) {
    where.push('target_collection = ?');
    params.push(filters.targetCollection);
  }
  if (filters.targetId) {
    where.push('target_id = ?');
    params.push(filters.targetId);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC;';
  return db.query(sql, params).map(toCorrection);
}

function loadCorrection(id) {
  return toCorrection(db.getOne('SELECT * FROM corrections WHERE id = ? LIMIT 1;', [id]));
}

function findByDedupeKey(dedupeKey) {
  return toCorrection(
    db.getOne('SELECT * FROM corrections WHERE dedupe_key = ? LIMIT 1;', [dedupeKey])
  );
}

function findPendingForTarget(targetCollection, targetId) {
  return toCorrection(
    db.getOne(
      'SELECT * FROM corrections WHERE target_collection = ? AND target_id = ? AND status = ? LIMIT 1;',
      [targetCollection, targetId, STATUS_PENDING]
    )
  );
}

function insertCorrection({
  targetCollection,
  targetId,
  changes,
  reason,
  submittedBy,
  dedupeKey,
  status = STATUS_PENDING,
  reviewNote = '',
  reviewedBy = ''
}) {
  const id = randomUUID();
  const ts = now();
  db.query(
    'INSERT INTO corrections (id, target_collection, target_id, status, changes_json, reason, submitted_by, review_note, reviewed_by, reviewed_at, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      targetCollection,
      targetId,
      status,
      JSON.stringify(changes),
      reason || '',
      submittedBy || '',
      reviewNote,
      reviewedBy,
      status === STATUS_PENDING ? null : ts,
      dedupeKey,
      ts,
      ts
    ]
  );
  return loadCorrection(id);
}

function markReviewed(id, status, reviewedBy, reviewNote) {
  db.query(
    'UPDATE corrections SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?;',
    [status, reviewedBy || '', reviewNote || '', now(), now(), id]
  );
  return loadCorrection(id);
}

// 收集纠错通过后受牵连、尚未结束的装箱单与缺损单
function collectImpacted(targetCollection, targetId, targetRecord) {
  const impacted = [];
  const unfinishedCfg = correctionConfig.unfinished || {};
  const reviewStatus = correctionConfig.reviewStatus;

  function pushImpacted(collection, record, reason) {
    impacted.push({
      collection,
      id: record.id,
      statusBefore: record.status,
      reason
    });
  }

  // 装箱单：headIds / accessoryIds 直接引用了被纠错物件
  const boxCfg = unfinishedCfg.tourBoxes;
  const impactedBoxIds = new Set();
  if (boxCfg) {
    const refField = Object.entries(boxCfg.refs || {}).find(([, coll]) => coll === targetCollection)?.[0];
    if (refField) {
      for (const box of store.listRecords('tourBoxes')) {
        if ((boxCfg.terminal || []).includes(box.status)) continue;
        const refs = Array.isArray(box[refField]) ? box[refField] : [];
        if (refs.includes(targetId)) {
          impactedBoxIds.add(box.id);
          pushImpacted('tourBoxes', box, '引用的' + (config.collections[targetCollection].label || targetCollection) + '档案已纠错');
        }
      }
    }
  }

  // 缺损单：
  // 1) 其所属装箱单引用了被纠错物件（以箱号/剧目/角色建档时仍能追溯到同一批巡演）
  // 2) 偶头缺损单按 puppetHeadId 直接关联；配件缺损单按名称+剧目+角色匹配
  const lossCfg = unfinishedCfg.lossReports;
  if (lossCfg) {
    for (const loss of store.listRecords('lossReports')) {
      if ((lossCfg.terminal || []).includes(loss.status)) continue;
      let hit = false;
      if (impactedBoxIds.has(loss.tourBoxId)) hit = true;
      if (!hit && targetCollection === 'puppetHeads' && loss.itemType !== '配件' && loss.puppetHeadId === targetId) {
        hit = true;
      }
      if (!hit && targetCollection === 'accessories') {
        hit =
          loss.itemType === '配件' &&
          loss.itemName === targetRecord.name &&
          (loss.play ? loss.play === targetRecord.play : true) &&
          (loss.role ? loss.role === targetRecord.role : true);
      }
      if (hit) pushImpacted('lossReports', loss, '关联物件档案已纠错');
    }
  }

  return { impacted, reviewStatus };
}

module.exports = {
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_REJECTED,
  normalize,
  toCorrection,
  buildDedupeKey,
  initCorrections,
  listCorrections,
  loadCorrection,
  findByDedupeKey,
  findPendingForTarget,
  insertCorrection,
  markReviewed,
  collectImpacted
};
