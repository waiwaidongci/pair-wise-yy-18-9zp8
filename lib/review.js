// 审核层：纠错单的全部业务规则。
// - 提交：校验目标、字段、凭证、新旧值差异；同一件只保留一份待审，重复提交沿用首次结果
// - 审核：通过时新值生效、旧值留痕（field_history + 履历事件），在途装箱单/缺损单转待复核
// - 退回：凭证缺失、新值与当前档案相同或审核人驳回，单据留存可查
// 已完成/已闭环单据不联动，修补记录不联动。
const config = require('../project.config');
const db = require('./db');
const records = require('./records');
const store = require('./correctionStore');

function fail(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra || {});
  throw error;
}

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// 凭证来源接受多种写法：evidence 字符串/对象、source，或 evidenceRef/evidenceType 散字段。
function normalizeEvidence(body) {
  let raw = body.evidence !== undefined ? body.evidence : body.source;
  if (raw === undefined && (body.evidenceRef || body.evidenceType)) {
    raw = { type: body.evidenceType, ref: body.evidenceRef, note: body.evidenceNote };
  }
  let evidence;
  if (typeof raw === 'string') {
    evidence = { type: '', ref: raw.trim(), note: '', attachments: [] };
  } else if (raw && typeof raw === 'object') {
    const attachments = Array.isArray(raw.attachments)
      ? raw.attachments.map(asText).filter(Boolean)
      : [];
    evidence = {
      type: asText(raw.type),
      ref: asText(raw.ref),
      note: asText(raw.note),
      attachments
    };
  } else {
    evidence = { type: '', ref: '', note: '', attachments: [] };
  }
  // 凭证必须能定位到外部来源：来源编号或附件至少一项，说明文字不算凭证。
  evidence.missing = !evidence.ref && evidence.attachments.length === 0;
  return evidence;
}

// 入参支持 changes 列表，也支持 field/newValue 单字段写法。
function normalizeChanges(body) {
  let items = [];
  if (Array.isArray(body.changes)) {
    items = body.changes;
  } else if (body.field !== undefined || body.newValue !== undefined) {
    items = [{ field: body.field, newValue: body.newValue }];
  }
  if (!items.length) fail(400, '缺少纠错内容：请提供 changes 列表或 field/newValue');

  const changes = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') fail(400, 'changes 每一项必须是 {field, newValue} 对象');
    const field = asText(item.field);
    if (!field) fail(400, 'changes 中存在空字段名');
    if (seen.has(field)) fail(400, '同一字段在一张纠错单中出现多次：' + field);
    seen.add(field);
    const newValue = asText(item.newValue);
    if (!newValue) fail(400, '字段 ' + field + ' 的新值不能为空');
    changes.push({ field, newValue });
  }
  return changes;
}

async function submitCorrection(body) {
  const targetCollection = asText(body.targetCollection);
  const targetId = asText(body.targetId);
  if (!targetCollection || !targetId) fail(400, '缺少 targetCollection 或 targetId');

  const allowedFields = config.correctionFields[targetCollection];
  if (!allowedFields) {
    fail(400, '该档案类型不支持纠错单：' + targetCollection + '（仅支持偶头档案、服装配件）');
  }

  const changes = normalizeChanges(body);
  for (const change of changes) {
    if (!allowedFields.includes(change.field)) {
      fail(400, '字段不允许纠错：' + change.field + '（允许：' + allowedFields.join('、') + '）');
    }
  }

  const record = await records.loadRecord(targetCollection, targetId);
  if (!record) fail(404, '目标档案不存在：' + targetCollection + '/' + targetId);

  // 同一件只留一份待审：重复提交直接沿用首次提交的处理结果。
  const pending = await store.findPendingCorrection(targetCollection, targetId);
  if (pending) {
    return { duplicate: true, correction: pending };
  }

  const evidence = normalizeEvidence(body);

  // 旧值以提交时档案为准固化到单上，审核时再与当前值比对。
  const valuedChanges = changes.map((change) => ({
    field: change.field,
    oldValue: asText(record[change.field]),
    newValue: change.newValue
  }));

  const sameValueFields = valuedChanges.filter((change) => change.oldValue === change.newValue);
  const invalidReasons = [];
  if (evidence.missing) invalidReasons.push('来源凭证缺失（需提供凭证编号或附件）');
  if (sameValueFields.length) {
    invalidReasons.push('新值与当前档案相同：' + sameValueFields.map((c) => c.field).join('、'));
  }

  const created = await store.insertCorrection({
    targetCollection,
    targetId,
    submitter: asText(body.submitter),
    reason: asText(body.reason),
    evidence,
    changes: valuedChanges
  });

  if (invalidReasons.length) {
    const returnReason = invalidReasons.join('；');
    await records.insertEvent({
      recordId: targetId,
      collection: targetCollection,
      action: '纠错退回',
      status: record.status,
      actor: asText(body.submitter),
      note: returnReason,
      data: { correctionId: created.id, changes: valuedChanges, evidence }
    });
    const returned = await store.markReturned(created.id, returnReason);
    return { duplicate: false, correction: returned, returned: true };
  }

  await records.insertEvent({
    recordId: targetId,
    collection: targetCollection,
    action: '提交纠错',
    status: record.status,
    actor: asText(body.submitter),
    note: asText(body.reason),
    data: { correctionId: created.id, changes: valuedChanges, evidence }
  });
  return { duplicate: false, correction: created, returned: false };
}

function stripMeta(data) {
  const next = { ...data };
  delete next.id;
  delete next.collection;
  delete next.createdAt;
  delete next.updatedAt;
  delete next.status;
  return next;
}

function itemTypeMatches(itemType, targetCollection) {
  const text = asText(itemType);
  if (targetCollection === 'puppetHeads') return text.includes('偶头') || /head/i.test(text);
  if (targetCollection === 'accessories') return text.includes('配件') || /accessor/i.test(text);
  return false;
}

// 纠错通过后联动：尚未结束的装箱单、缺损单转待复核；已闭环/已补齐等不动。
// 已经处于待复核的单据仍算在途：保留最早来源状态，追加新的纠错单编号。
async function cascadeReview({ targetCollection, targetId, record, appliedChanges, correctionId, reviewer }) {
  const reviewAt = records.now();
  const note = '关联档案纠错通过（纠错单 ' + correctionId + '），内容待复核';
  const cascaded = { tourBoxes: [], lossReports: [] };
  const REVIEW_STATUS = '待复核';

  function mergePendingReview(existing, reason) {
    if (!existing) {
      return { fromStatus: null, reason, correctionIds: [correctionId], reviewer, at: reviewAt };
    }
    const correctionIds = Array.isArray(existing.correctionIds) ? existing.correctionIds : [];
    if (!correctionIds.includes(correctionId)) correctionIds.push(correctionId);
    return { ...existing, reason, correctionIds, latestReviewer: reviewer, latestAt: reviewAt };
  }

  const tourRule = config.cascadeReview.tourBoxes;
  const boxes = await records.listRecords('tourBoxes');
  const affectedBoxIds = new Set();
  for (const box of boxes) {
    // 已闭环不动；待复核（上一次纠错留下的）同样在途，继续追加联动。
    const inScope = tourRule.activeStatuses.includes(box.status) || box.status === REVIEW_STATUS;
    if (!inScope) continue;
    const headIds = Array.isArray(box.headIds) ? box.headIds : [];
    const accessoryIds = Array.isArray(box.accessoryIds) ? box.accessoryIds : [];
    const linked =
      (targetCollection === 'puppetHeads' && headIds.includes(targetId)) ||
      (targetCollection === 'accessories' && accessoryIds.includes(targetId));
    if (!linked) continue;

    affectedBoxIds.add(box.id);
    const nextData = Object.assign(stripMeta(box), {
      pendingReview: mergePendingReview(box.pendingReview, note)
    });
    nextData.pendingReview.fromStatus = box.pendingReview ? box.pendingReview.fromStatus : box.status;
    await records.saveRecord('tourBoxes', box.id, nextData, REVIEW_STATUS);
    await records.insertEvent({
      recordId: box.id,
      collection: 'tourBoxes',
      action: '转待复核',
      status: REVIEW_STATUS,
      actor: reviewer,
      note,
      data: { correctionId, targetCollection, targetId }
    });
    cascaded.tourBoxes.push(box.id);
  }

  const lossRule = config.cascadeReview.lossReports;
  const candidateNames = new Set([asText(record.name), asText(record.role)].filter(Boolean));
  for (const change of appliedChanges) {
    if (change.oldValue) candidateNames.add(change.oldValue);
  }
  const lossReports = await records.listRecords('lossReports');
  for (const report of lossReports) {
    const inScope = lossRule.activeStatuses.includes(report.status) || report.status === REVIEW_STATUS;
    if (!inScope) continue;
    const directLink =
      itemTypeMatches(report.itemType, targetCollection) &&
      (asText(report.itemId) === targetId || candidateNames.has(asText(report.itemName)));
    if (!directLink && !affectedBoxIds.has(asText(report.tourBoxId))) continue;

    const reason = directLink ? note : '所在装箱单 ' + asText(report.tourBoxId) + ' 关联档案纠错，待复核';
    const nextData = Object.assign(stripMeta(report), {
      pendingReview: mergePendingReview(report.pendingReview, reason)
    });
    nextData.pendingReview.fromStatus = report.pendingReview ? report.pendingReview.fromStatus : report.status;
    await records.saveRecord('lossReports', report.id, nextData, REVIEW_STATUS);
    await records.insertEvent({
      recordId: report.id,
      collection: 'lossReports',
      action: '转待复核',
      status: REVIEW_STATUS,
      actor: reviewer,
      note,
      data: { correctionId, targetCollection, targetId, directLink, tourBoxId: report.tourBoxId }
    });
    cascaded.lossReports.push(report.id);
  }

  return cascaded;
}

async function approveCorrection(id, body) {
  const reviewer = asText(body && body.reviewer);
  if (!reviewer) fail(400, '缺少审核人 reviewer');

  const correction = await store.getCorrection(id);
  if (!correction) fail(404, '纠错单不存在：' + id);
  if (correction.status !== store.STATUS_PENDING) {
    // 首次处理结果已经产生，重复审核不产生新结果。
    fail(409, '纠错单已是「' + correction.status + '」状态，沿用首次处理结果', { correction });
  }

  const record = await records.loadRecord(correction.targetCollection, correction.targetId);
  if (!record) fail(422, '目标档案已不存在，无法通过：' + correction.targetId);

  // 通过时与当前档案再比一次：期间被别处改对的字段跳过，不重复落痕。
  const results = correction.changes.map((change) => ({
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
    applied: asText(record[change.field]) !== change.newValue
  }));
  const applied = results.filter((r) => r.applied);
  if (!applied.length) {
    const reason = '审核时复核：新值与当前档案相同，未作改动';
    await records.insertEvent({
      recordId: correction.targetId,
      collection: correction.targetCollection,
      action: '纠错退回',
      status: record.status,
      actor: reviewer,
      note: reason,
      data: { correctionId: id, changes: results }
    });
    const returned = await store.markReturned(id, reason);
    return { correction: returned, cascaded: { tourBoxes: [], lossReports: [] }, noop: true };
  }

  const nextData = stripMeta(record);
  for (const result of applied) nextData[result.field] = result.newValue;

  const reviewResult = { reviewer, changes: results };
  // 档案改值、留痕、在途单据联动与单据状态在同一事务内提交。
  await db.tx([
    async () => {
      await records.saveRecord(correction.targetCollection, correction.targetId, nextData, record.status);
      await records.insertEvent({
        recordId: correction.targetId,
        collection: correction.targetCollection,
        action: '纠错通过',
        status: record.status,
        actor: reviewer,
        note: correction.reason,
        data: { correctionId: id, changes: applied, evidence: correction.evidence }
      });
      for (const result of applied) {
        await records.insertFieldHistory({
          correctionId: id,
          recordId: correction.targetId,
          collection: correction.targetCollection,
          field: result.field,
          oldValue: asText(record[result.field]),
          newValue: result.newValue,
          evidence: correction.evidence,
          actor: reviewer
        });
      }
      reviewResult.cascaded = await cascadeReview({
        targetCollection: correction.targetCollection,
        targetId: correction.targetId,
        record,
        appliedChanges: applied,
        correctionId: id,
        reviewer
      });
      await store.markApproved(id, reviewResult);
    }
  ]);

  return { correction: await store.getCorrection(id), cascaded: reviewResult.cascaded, noop: false };
}

async function returnCorrection(id, body) {
  const reviewer = asText(body && body.reviewer);
  const reason = asText(body && body.reason);
  if (!reviewer) fail(400, '缺少审核人 reviewer');
  if (!reason) fail(400, '退回必须填写 reason');

  const correction = await store.getCorrection(id);
  if (!correction) fail(404, '纠错单不存在：' + id);
  if (correction.status !== store.STATUS_PENDING) {
    fail(409, '纠错单已是「' + correction.status + '」状态，沿用首次处理结果', { correction });
  }

  const record = await records.loadRecord(correction.targetCollection, correction.targetId);
  await records.insertEvent({
    recordId: correction.targetId,
    collection: correction.targetCollection,
    action: '纠错退回',
    status: record ? record.status : '',
    actor: reviewer,
    note: reason,
    data: { correctionId: id, changes: correction.changes }
  });
  return store.markReturned(id, reason);
}

module.exports = {
  submitCorrection,
  approveCorrection,
  returnCorrection
};
