const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;
let SQL = null;

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const bytes = Buffer.from(db.export());
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, DB_FILE);
}

async function init() {
  SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  return { db, persist };
}

function requireDb() {
  if (!db) throw new Error('database not initialized');
  return db;
}

// 参数化查询，返回对象数组；? 位置参数
function query(sql, params = []) {
  const stmt = requireDb().prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function getOne(sql, params = []) {
  return query(sql, params)[0] || null;
}

// 事务内执行；fn 中只读写内存，结束后一次性落盘
function transaction(fn) {
  requireDb().run('BEGIN');
  try {
    const result = fn();
    requireDb().run('COMMIT');
    persist();
    return result;
  } catch (error) {
    requireDb().run('ROLLBACK');
    throw error;
  }
}

// 无事务的写操作；多语句脚本（如建表 DDL）直接 run，参数化语句走 prepare
function exec(sql, params) {
  if (params === undefined) {
    requireDb().run(sql);
  } else {
    const stmt = requireDb().prepare(sql);
    try {
      stmt.run(params);
    } finally {
      stmt.free();
    }
  }
  persist();
}

module.exports = { init, query, getOne, exec, transaction, persist, DB_FILE };
