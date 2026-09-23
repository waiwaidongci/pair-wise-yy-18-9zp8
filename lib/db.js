// 存储层：SQLite 连接与基础读写原语，不含任何业务规则。
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(DB_FILE);
db.run('PRAGMA foreign_keys = ON;');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return all(sql, params).then((rows) => rows[0] || null);
}

// 同一连接天然串行：多条语句顺序提交，避免并发写入互相穿插。
async function tx(statements) {
  await run('BEGIN IMMEDIATE;');
  try {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt());
    }
    await run('COMMIT;');
    return results;
  } catch (err) {
    await run('ROLLBACK;');
    throw err;
  }
}

module.exports = { DB_FILE, run, all, get, tx };
