import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = join(__dirname, '../../data/jobs.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  data_json   TEXT,
  result_json TEXT,
  log_json    TEXT NOT NULL DEFAULT '[]',
  error       TEXT,
  warnings    TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
`;

let db;

export function getDb(path = process.env.JOBS_DB_PATH || DEFAULT_DB) {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function createJob(id, source, jobData) {
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO jobs (id, source, status, data_json, log_json, warnings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, source, 'pending', JSON.stringify(jobData), '[]', '[]', now, now);
}

export function getJob(id) {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    data: tryParse(row.data_json),
    result: tryParse(row.result_json),
    log: tryParse(row.log_json) || [],
    error: row.error,
    warnings: tryParse(row.warnings) || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function updateJobStatus(id, status, result = null, error = null) {
  const now = new Date().toISOString();
  getDb().prepare(
    'UPDATE jobs SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?'
  ).run(status, result ? JSON.stringify(result) : null, error, now, id);
}

export function appendJobLog(id, entry) {
  const job = getDb().prepare('SELECT log_json FROM jobs WHERE id = ?').get(id);
  if (!job) return;
  const log = tryParse(job.log_json) || [];
  log.push(entry);
  const now = new Date().toISOString();
  getDb().prepare('UPDATE jobs SET log_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(log), now, id);
}

export function appendJobWarnings(id, warnings) {
  if (!warnings?.length) return;
  const job = getDb().prepare('SELECT warnings FROM jobs WHERE id = ?').get(id);
  if (!job) return;
  const existing = tryParse(job.warnings) || [];
  existing.push(...warnings);
  const now = new Date().toISOString();
  getDb().prepare('UPDATE jobs SET warnings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(existing), now, id);
}

export function cleanupOldJobs(ttlDays = 30) {
  const cutoff = new Date(Date.now() - ttlDays * 86400_000).toISOString();
  const { changes } = getDb().prepare("DELETE FROM jobs WHERE created_at < ? AND status IN ('done','error')").run(cutoff);
  return changes;
}

function tryParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// --- In-memory SSE listener registry (ephemeral, not persisted) ---
const listeners = new Map();

export function addListener(jobId, fn) {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId).add(fn);
}

export function removeListener(jobId, fn) {
  const set = listeners.get(jobId);
  if (set) { set.delete(fn); if (!set.size) listeners.delete(jobId); }
}

export function emitToListeners(jobId, event) {
  const set = listeners.get(jobId);
  if (set) for (const fn of set) fn(event);
}
