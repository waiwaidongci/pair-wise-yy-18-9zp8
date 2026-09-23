// 接口入口：/api/corrections* 路由，只负责解析请求与拼装响应。
// 业务规则在 lib/review.js，存取在 lib/correctionStore.js，三者分开承担。
const express = require('express');
const review = require('../review');
const store = require('../correctionStore');

const router = express.Router();

// 提交纠错单。
// body: { targetCollection, targetId, changes: [{field, newValue}] 或 field/newValue,
//         evidence: {type, ref, note, attachments} 或凭证字符串, submitter, reason }
// - 凭证缺失 / 新值与当前档案相同：直接退回（200，status=已退回），单据留存
// - 同一件已有待审单：沿用首次结果（200，duplicate=true）
router.post('/', async (req, res, next) => {
  try {
    const result = await review.submitCorrection(req.body || {});
    if (result.duplicate) {
      return res.status(200).json({ duplicate: true, correction: result.correction });
    }
    return res.status(result.returned ? 200 : 201).json({
      duplicate: false,
      correction: result.correction
    });
  } catch (error) {
    next(error);
  }
});

// 查询纠错单：?status=&targetCollection=&targetId=
router.get('/', async (req, res, next) => {
  try {
    const corrections = await store.listCorrections({
      status: req.query.status || '',
      targetCollection: req.query.targetCollection || '',
      targetId: req.query.targetId || ''
    });
    res.json(corrections);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const correction = await store.getCorrection(req.params.id);
    if (!correction) return res.status(404).json({ error: 'not found' });
    res.json(correction);
  } catch (error) {
    next(error);
  }
});

// 审核通过：新值生效、旧值留痕、在途装箱单与缺损单转待复核。body: { reviewer }
router.post('/:id/approve', async (req, res, next) => {
  try {
    const result = await review.approveCorrection(req.params.id, req.body || {});
    res.status(200).json({
      correction: result.correction,
      cascaded: result.cascaded,
      noop: result.noop || false
    });
  } catch (error) {
    if (error.correction) {
      return res.status(error.status || 409).json({
        error: error.message,
        correction: error.correction
      });
    }
    next(error);
  }
});

// 审核退回：body: { reviewer, reason }
router.post('/:id/return', async (req, res, next) => {
  try {
    const correction = await review.returnCorrection(req.params.id, req.body || {});
    res.json(correction);
  } catch (error) {
    if (error.correction) {
      return res.status(error.status || 409).json({
        error: error.message,
        correction: error.correction
      });
    }
    next(error);
  }
});

module.exports = router;
