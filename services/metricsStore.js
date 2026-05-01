/**
 * metricsStore.js
 * SQLite time-series store for server metrics.
 * Provides write, read (hourly aggregation & raw), prune with prune-guard,
 * and a meta table for persisting operational state.
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.METRICS_DB_PATH || path.join(__dirname, '../data/metrics.db');
const RETENTION_DAYS = parseInt(process.env.METRICS_RETENTION_DAYS || '30', 10);

let db = null;

/**
 * Initialise the SQLite database — create tables and indexes if absent.
 * Safe to call multiple times (idempotent).
 */
function init() {
  if (db) return db;

  // Ensure the data directory exists (mirrors what config/auth.js does for users.json)
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Use WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      server    TEXT    NOT NULL,
      ts        INTEGER NOT NULL,        -- Unix epoch seconds
      cpu_pct   REAL,
      mem_pct   REAL,
      disk_pct  REAL
    );

    CREATE INDEX IF NOT EXISTS idx_server_ts ON metrics (server, ts);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

/**
 * Write a metrics snapshot for a server.
 * @param {string} serverId
 * @param {{ cpu_pct?: number, mem_pct?: number, disk_pct?: number }} metrics
 */
function write(serverId, metrics) {
  const store = init();
  const ts = Math.floor(Date.now() / 1000);
  const stmt = store.prepare(
    'INSERT INTO metrics (server, ts, cpu_pct, mem_pct, disk_pct) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.run(
    serverId,
    ts,
    metrics.cpu_pct != null ? parseFloat(metrics.cpu_pct) : null,
    metrics.mem_pct != null ? parseFloat(metrics.mem_pct) : null,
    metrics.disk_pct != null ? parseFloat(metrics.disk_pct) : null
  );
}

/**
 * Read hourly-aggregated metrics for a server.
 * Groups rows into 1-hour buckets (floor to hour), returns AVG per bucket.
 * Capped at 168 rows (7d × 24h per day).
 *
 * @param {string} serverId
 * @param {number} days  Default 7
 * @returns {Array<{ bucket: number, cpu_pct: number|null, mem_pct: number|null, disk_pct: number|null }>}
 */
function readHourly(serverId, days = 7) {
  const store = init();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = store.prepare(`
    SELECT
      (ts / 3600) * 3600 AS bucket,
      AVG(cpu_pct)        AS cpu_pct,
      AVG(mem_pct)        AS mem_pct,
      AVG(disk_pct)       AS disk_pct
    FROM metrics
    WHERE server = ? AND ts >= ?
    GROUP BY bucket
    ORDER BY bucket ASC
    LIMIT 168
  `).all(serverId, since);
  return rows;
}

/**
 * Read raw metrics for a server, capped at 500 rows.
 *
 * @param {string} serverId
 * @param {number} days  Default 7
 * @returns {Array<{ ts: number, cpu_pct: number|null, mem_pct: number|null, disk_pct: number|null }>}
 */
function readRaw(serverId, days = 7) {
  const store = init();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = store.prepare(`
    SELECT ts, cpu_pct, mem_pct, disk_pct
    FROM metrics
    WHERE server = ? AND ts >= ?
    ORDER BY ts ASC
    LIMIT 500
  `).all(serverId, since);
  return rows;
}

/**
 * Return the count of data points for a server over the last N days.
 * Used by the advisor confidence gate.
 *
 * @param {string} serverId
 * @param {number} days
 * @returns {number}
 */
function countPoints(serverId, days) {
  const store = init();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const row = store.prepare(
    'SELECT COUNT(*) AS cnt FROM metrics WHERE server = ? AND ts >= ?'
  ).get(serverId, since);
  return row ? row.cnt : 0;
}

/**
 * Return the age of the oldest row for a server (in days).
 * Returns 0 if no rows exist.
 *
 * @param {string} serverId
 * @returns {number}
 */
function dataAgeDays(serverId) {
  const store = init();
  const row = store.prepare(
    'SELECT MIN(ts) AS min_ts FROM metrics WHERE server = ?'
  ).get(serverId);
  if (!row || !row.min_ts) return 0;
  return (Date.now() / 1000 - row.min_ts) / 86400;
}

/**
 * Compute p95 value from an array of numbers (nulls excluded).
 * Returns null if the array is empty.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function p95(values) {
  const clean = values.filter(v => v != null).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const idx = Math.floor(clean.length * 0.95);
  return clean[Math.min(idx, clean.length - 1)];
}

/**
 * Fetch raw 7-day rows and compute p95 for cpu, mem, disk.
 *
 * @param {string} serverId
 * @returns {{ cpu: number|null, mem: number|null, disk: number|null }}
 */
function computeP95(serverId) {
  const store = init();
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const rows = store.prepare(
    'SELECT cpu_pct, mem_pct, disk_pct FROM metrics WHERE server = ? AND ts >= ?'
  ).all(serverId, since);
  return {
    cpu:  p95(rows.map(r => r.cpu_pct)),
    mem:  p95(rows.map(r => r.mem_pct)),
    disk: p95(rows.map(r => r.disk_pct))
  };
}

/**
 * Prune rows older than RETENTION_DAYS.
 * PRUNE GUARD: only runs once per UTC day (tracks `lastPrunedAt` in meta table).
 */
function prune() {
  const store = init();

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const meta = store.prepare("SELECT value FROM meta WHERE key = 'lastPrunedAt'").get();
  if (meta && meta.value === today) {
    // Already pruned today — skip
    return;
  }

  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  const result = store.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  console.log(`[metricsStore] Pruned ${result.changes} rows older than ${RETENTION_DAYS} days`);

  store.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastPrunedAt', ?)").run(today);
}

/**
 * Get a meta value by key.
 * @param {string} key
 * @returns {string|null}
 */
function getMeta(key) {
  const store = init();
  const row = store.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Set a meta value.
 * @param {string} key
 * @param {string} value
 */
function setMeta(key, value) {
  const store = init();
  store.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = {
  init,
  write,
  readHourly,
  readRaw,
  countPoints,
  dataAgeDays,
  computeP95,
  prune,
  getMeta,
  setMeta
};
