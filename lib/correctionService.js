const db = require('./db');
const store = require('./recordStore');
const corrections = require('./correctionStore');
const config = require('../project.config');

const {
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_REJECTED
} = corrections;

class ServiceError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// 解析并校验提交体：只做结构与业务规则校验，不写库
function parseSubmission(body = {}) {
  const targets = config.corrections.targets;
  const targetCollection = corrections.normalize(body.targetCollection);
  const targetId = corrections.normalize(body.targetId);
  if (!targetCollection || !targetId) {
    throw new ServiceError(400, 'targetCollection 与 targetId 必填');
  }
  const targetConfig = targets[targetCollection];
  if (!targetConfig) {
    throw new ServiceError(400, '该档案不支持纠错：' + targetCollection);
  }
  if (!Array.isArray(body.changes) || body.changes.length === 0) {
    throw new ServiceError(400, 'changes 至少包含一条字段变更');
  }

  const seen = new Set();
  const changes = [];
  for (const raw of body.changes) {
    const field = corrections.normalize(raw?.field);
    const fieldConfig = targetConfig.fields[field];
    if (!fieldConfig) {
      throw new ServiceError(400, '不允许纠错的字段：' + field);
    }
    if (seen.has(field)) {
      throw new ServiceError(400, '同一字段在一张纠错单中只能出现一次：' + field);
    }
    seen.add(field);
    const newValue = corrections.normalize(raw.newValue);
    const evidence = corrections.normalize(raw.evidence);
    if (!newValue) {
      throw new ServiceError(400, '字段 ' + field + ' 的 new value 不能为空');
    }
    changes.push({
      field,
      fieldLabel: fieldConfig.label,
      oldValue: '',
      newValue,
      evidence,
      evidenceType: corrections.normalize(raw?.evidenceType)
    });
  }

  changes.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return {
    targetCollection,
    targetId,
    changes,
    reason: corrections.normalize(body.reason),
    submittedBy: corrections.normalize(body.submittedBy)
  };
}

// 提交纠错单。返回 { created, correction }：
// - 重复提交沿用首次结果（任意状态都直接返回原单）
// - 同一件已有待审单 → 冲突退回
// - 凭证缺失 / 新值与当前档案相同 → 记录为已退回
function submit(body) {
  const parsed = parseSubmission(body);

  const target = store.loadRecord(parsed.targetCollection, parsed.targetId);
  if (!target) {
    throw new ServiceError(404, '未找到对应档案：' + parsed.targetCollection + '/' + parsed.targetId);
  }

  // 旧值取自当前档案快照；凭证缺失或新旧相同直接退回
  const problems = [];
  for (const change of parsed.changes) {
    change.oldValue = target[change.field] === undefined || target[change.field] === null
      ? ''
      : String(target[change.field]);
    if (!change.evidence) {
      problems.push(change.fieldLabel + '（' + change.field + '）缺少来源凭证');
    }
    if (change.oldValue === change.newValue) {
      problems.push(change.fieldLabel + '（' + change.field + '）新值与当前档案相同');
    }
  }

  const dedupeKey = corrections.buildDedupeKey(
    parsed.targetCollection,
    parsed.targetId,
    parsed.changes
  );

  return db.transaction(() => {
    // 先查重：重复提交沿用首次处理结果
    const existing = corrections.findByDedupeKey(dedupeKey);
    if (existing) {
      return { created: false, reused: true, correction: existing };
    }

    // 同一件只留一份待审：先到先占，后来者冲突，不另立单据
    const pending = corrections.findPendingForTarget(parsed.targetCollection, parsed.targetId);
    if (pending) {
      throw new ServiceError(409, '同一件已有待审纠错单：' + pending.id, {
        correctionId: pending.id,
        pendingStatus: pending.status
      });
    }

    if (problems.length) {
      const note = '系统退回：' + problems.join('；');
      const rejected = corrections.insertCorrection({
        targetCollection: parsed.targetCollection,
        targetId: parsed.targetId,
        changes: parsed.changes,
        reason: parsed.reason,
        submittedBy: parsed.submittedBy,
        dedupeKey,
        status: STATUS_REJECTED,
        reviewNote: note,
        reviewedBy: 'system'
      });
      store.insertEventInTx({
        recordId: rejected.id,
        collection: 'corrections',
        action: '纠错单已退回',
        status: STATUS_REJECTED,
        actor: 'system',
        note,
        data: { targetCollection: parsed.targetCollection, targetId: parsed.targetId, changes: parsed.changes }
      });
      // 退回单同样留档：再次提交相同内容时沿用本次结果
      return { created: true, reused: false, rejected: true, correction: rejected };
    }

    const correction = corrections.insertCorrection({
      targetCollection: parsed.targetCollection,
      targetId: parsed.targetId,
      changes: parsed.changes,
      reason: parsed.reason,
      submittedBy: parsed.submittedBy,
      dedupeKey
    });
    store.insertEventInTx({
      recordId: correction.id,
      collection: 'corrections',
      action: '提交纠错单',
      status: STATUS_PENDING,
      actor: parsed.submittedBy,
      note: parsed.reason,
      data: { targetCollection: parsed.targetCollection, targetId: parsed.targetId, changes: parsed.changes }
    });
    return { created: true, reused: false, correction };
  });
}

// 审核通过：旧值留在纠错单与履历事件中可查；当前档案按新值显示；
// 尚未结束的装箱单与缺损单转待复核；已完成记录不改。
function approve(id, actor, note) {
  const reviewNote = corrections.normalize(note);
  return db.transaction(() => {
    const correction = corrections.loadCorrection(id);
    if (!correction) throw new ServiceError(404, '未找到纠错单：' + id);
    if (correction.status !== STATUS_PENDING) {
      throw new ServiceError(409, '只有待审纠错单可以通过，当前状态：' + correction.status, {
        correction
      });
    }

    const target = store.loadRecord(correction.targetCollection, correction.targetId);
    if (!target) {
      throw new ServiceError(404, '对应档案已不存在：' + correction.targetCollection + '/' + correction.targetId);
    }

    // 通过时以当前档案再核一遍旧值；期间若已被改到与新值一致，则无需改动该字段
    const applied = [];
    const skipped = [];
    for (const change of correction.changes) {
      const currentValue = target[change.field] === undefined || target[change.field] === null
        ? ''
        : String(target[change.field]);
      if (currentValue === change.newValue) {
        skipped.push({ ...change, currentValue });
        continue;
      }
      applied.push({ ...change, valueAtReview: currentValue });
      target[change.field] = change.newValue;
    }

    const { impacted, reviewStatus } = corrections.collectImpacted(
      correction.targetCollection,
      correction.targetId,
      target
    );

    if (applied.length > 0) {
      store.saveRecordInTx(correction.targetCollection, correction.targetId, target, target.status);
    }

    // 物件履历：旧值继续可查
    store.insertEventInTx({
      recordId: correction.targetId,
      collection: correction.targetCollection,
      action: '档案纠错通过',
      status: target.status,
      actor: corrections.normalize(actor),
      note: reviewNote,
      data: {
        correctionId: correction.id,
        applied,
        skipped,
        evidence: correction.changes.map((c) => ({ field: c.field, evidence: c.evidence }))
      }
    });

    // 尚未结束的装箱单、缺损单转待复核（已闭环/已补齐/确认为遗失不动）
    const impactedSummary = [];
    for (const item of impacted) {
      const record = store.loadRecord(item.collection, item.id);
      if (!record || record.status === reviewStatus) continue;
      const statusBefore = record.status;
      const nextData = { ...record, status: reviewStatus };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      store.saveRecordInTx(item.collection, item.id, nextData, reviewStatus);
      store.insertEventInTx({
        recordId: item.id,
        collection: item.collection,
        action: '纠错联动转待复核',
        status: reviewStatus,
        actor: corrections.normalize(actor),
        note: '纠错单 ' + correction.id + ' 通过：' + item.reason,
        data: { correctionId: correction.id, statusBefore, targetCollection: correction.targetCollection, targetId: correction.targetId }
      });
      impactedSummary.push({ collection: item.collection, id: item.id, statusBefore, statusAfter: reviewStatus });
    }

    const approved = corrections.markReviewed(id, STATUS_APPROVED, actor, reviewNote);
    store.insertEventInTx({
      recordId: id,
      collection: 'corrections',
      action: '纠错单审核通过',
      status: STATUS_APPROVED,
      actor: corrections.normalize(actor),
      note: reviewNote,
      data: { applied, skipped, impacted: impactedSummary }
    });

    return { correction: approved, applied, skipped, impacted: impactedSummary };
  });
}

// 审核退回：审核人必须写明退回原因
function reject(id, actor, note) {
  const reviewNote = corrections.normalize(note);
  if (!reviewNote) {
    throw new ServiceError(400, '退回必须写明原因（reviewNote）');
  }
  return db.transaction(() => {
    const correction = corrections.loadCorrection(id);
    if (!correction) throw new ServiceError(404, '未找到纠错单：' + id);
    if (correction.status !== STATUS_PENDING) {
      throw new ServiceError(409, '只有待审纠错单可以退回，当前状态：' + correction.status, {
        correction
      });
    }
    const rejected = corrections.markReviewed(id, STATUS_REJECTED, actor, reviewNote);
    store.insertEventInTx({
      recordId: id,
      collection: 'corrections',
      action: '纠错单审核退回',
      status: STATUS_REJECTED,
      actor: corrections.normalize(actor),
      note: reviewNote,
      data: { targetCollection: correction.targetCollection, targetId: correction.targetId }
    });
    return { correction: rejected };
  });
}

module.exports = { submit, approve, reject, ServiceError };
