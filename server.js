const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const db = require('./lib/db');
const store = require('./lib/recordStore');
const correctionStore = require('./lib/correctionStore');
const correctionService = require('./lib/correctionService');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

// ---------- 纠错单接口入口（独立于通用档案入口） ----------

// 纠错单列表：/api/corrections?status=待审&targetCollection=puppetHeads&targetId=...
app.get('/api/corrections', (req, res, next) => {
  try {
    const rows = correctionStore.listCorrections({
      status: req.query.status,
      targetCollection: req.query.targetCollection,
      targetId: req.query.targetId
    });
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? rows.slice(0, limit) : rows);
  } catch (error) {
    next(error);
  }
});

// 提交纠错单：同一件只留一份待审；重复提交沿用首次结果；
// 凭证缺失或新值与当前档案相同则退回。
app.post('/api/corrections', (req, res, next) => {
  try {
    const result = correctionService.submit(req.body || {});
    if (result.reused) {
      // 重复提交：返回首次处理结果，不新建单据
      return res.status(200).json({ reused: true, ...result.correction });
    }
    if (result.rejected) {
      // 凭证缺失或新值与当前档案相同：单据留档为已退回
      return res.status(422).json({ reused: false, ...result.correction });
    }
    return res.status(201).json({ reused: false, ...result.correction });
  } catch (error) {
    next(error);
  }
});

// 纠错单详情（含目标档案当前值与审核履历）
app.get('/api/corrections/:id', (req, res, next) => {
  try {
    const correction = correctionStore.loadCorrection(req.params.id);
    if (!correction) return res.status(404).json({ error: 'not found' });
    const target = store.loadRecord(correction.targetCollection, correction.targetId);
    const events = store.listEvents(req.params.id);
    res.json({
      ...correction,
      targetCurrent: target
        ? {
            id: target.id,
            collection: correction.targetCollection,
            status: target.status,
            fields: Object.fromEntries(
              correction.changes.map((change) => [change.field, target[change.field] ?? null])
            )
          }
        : null,
      events
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/corrections/:id/approve', (req, res, next) => {
  try {
    const result = correctionService.approve(
      req.params.id,
      String((req.body || {}).actor || '').trim(),
      (req.body || {}).reviewNote
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/corrections/:id/reject', (req, res, next) => {
  try {
    const result = correctionService.reject(
      req.params.id,
      String((req.body || {}).actor || '').trim(),
      (req.body || {}).reviewNote
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---------- 通用档案接口 ----------

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    corrections: config.corrections,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  try {
    store.findCollection(req.params.collection);
    const rows = store.listRecords(req.params.collection);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = store.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    store.validate(collectionConfig, data);
    const id = randomUUID();
    store.insertRecord({ collection: req.params.collection, id, data, status });
    store.insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(store.loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    store.findCollection(req.params.collection);
    const record = store.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    store.findCollection(req.params.collection);
    const record = store.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    store.saveRecord(req.params.collection, req.params.id, nextData, status);
    store.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(store.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = store.findCollection(req.params.collection);
    const record = store.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    store.saveRecord(req.params.collection, req.params.id, nextData, status);
    store.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(store.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    store.findCollection(req.params.collection);
    const record = store.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: store.listEvents(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    store.findCollection(req.params.collection);
    store.deleteRecord(req.params.collection, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  if (error instanceof correctionService.ServiceError) {
    const body = { error: error.message };
    if (error.correctionId) body.correctionId = error.correctionId;
    return res.status(error.status || 400).json(body);
  }
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

async function start() {
  await db.init();
  store.initDb();
  correctionStore.initCorrections();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
