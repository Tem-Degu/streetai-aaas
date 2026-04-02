import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const MAX_ROWS = 100;
const dbCache = {};

function getDb(paths) {
  const dbPath = path.join(paths.data, 'database.sqlite');
  if (!dbCache[dbPath]) {
    fs.mkdirSync(paths.data, { recursive: true });
    dbCache[dbPath] = new Database(dbPath);
    dbCache[dbPath].pragma('journal_mode = WAL');
  }
  return dbCache[dbPath];
}

/**
 * Execute a SQL query against the workspace SQLite database.
 */
export function runQuery(paths, { sql, params }) {
  if (!sql) return JSON.stringify({ error: 'sql is required.' });

  const db = getDb(paths);
  const trimmed = sql.trim().toUpperCase();
  const isRead = trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('EXPLAIN');

  try {
    if (isRead) {
      const stmt = db.prepare(sql);
      const rows = params ? stmt.all(...(Array.isArray(params) ? params : [params])) : stmt.all();
      const limited = rows.slice(0, MAX_ROWS);
      return JSON.stringify({
        rows: limited,
        count: limited.length,
        total: rows.length,
        truncated: rows.length > MAX_ROWS,
      });
    } else {
      const stmt = db.prepare(sql);
      const result = params ? stmt.run(...(Array.isArray(params) ? params : [params])) : stmt.run();
      return JSON.stringify({
        ok: true,
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

/**
 * List all tables in the database.
 */
export function listTables(paths) {
  const db = getDb(paths);
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    return JSON.stringify({ tables });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
