const express = require('express');
const config = require('./project.config');
const db = require('./lib/db');
const records = require('./lib/records');
const correctionStore = require('./lib/correctionStore');
const correctionsRouter = require('./lib/routes/corrections');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function applyQuery(rows, query) {
  return rows.filter((record) => {
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

async function initDb() {
  await records.initSchema();
  await correctionStore.initSchema();
  await records.seedData();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    correctionFields: config.correctionFields,
    examples: config.examples || []
  });
});

// 纠错单接口入口须在通用 :collection 路由之前挂载。
app.use('/api/corrections', correctionsRouter);

app.get('/api/:collection', async (req, res, next) => {
  try {
    records.findCollection(req.params.collection);
    const rows = await records.listRecords(req.params.collection);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', async (req, res, next) => {
  try {
    const collectionConfig = records.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const { id } = await records.insertRecord(req.params.collection, data, status);
    await records.insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(await records.loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', async (req, res, next) => {
  try {
    records.findCollection(req.params.collection);
    const record = await records.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', async (req, res, next) => {
  try {
    records.findCollection(req.params.collection);
    const record = await records.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    await records.saveRecord(req.params.collection, req.params.id, nextData, status);
    await records.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(await records.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', async (req, res, next) => {
  try {
    const collectionConfig = records.findCollection(req.params.collection);
    const record = await records.loadRecord(req.params.collection, req.params.id);
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
    await records.saveRecord(req.params.collection, req.params.id, nextData, status);
    await records.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(await records.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', async (req, res, next) => {
  try {
    records.findCollection(req.params.collection);
    const record = await records.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const fieldHistory = await records.listFieldHistory(req.params.collection, req.params.id).catch(() => []);
    const rows = await db.all(
      'SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;',
      [req.params.id]
    );
    res.json({
      record,
      events: rows.map((event) => ({
        id: event.id,
        action: event.action,
        status: event.status,
        actor: event.actor,
        note: event.note,
        data: JSON.parse(event.data || '{}'),
        createdAt: event.created_at
      })),
      // 旧值留痕单独挂出：当前档案按新值显示，旧值在这里继续可查。
      fieldHistory
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', async (req, res, next) => {
  try {
    records.findCollection(req.params.collection);
    await db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [req.params.collection, req.params.id]);
    await db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(config.title + ' API running at http://localhost:' + PORT);
    });
  })
  .catch((err) => {
    console.error('failed to initialize database:', err);
    process.exit(1);
  });
