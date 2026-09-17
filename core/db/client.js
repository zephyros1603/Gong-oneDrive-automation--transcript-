/**
 * core/db/client.js — the one database handle.
 *
 * Pinned to globalThis rather than held in a module binding. Next's dev server
 * re-evaluates modules on every edit, and a fresh better-sqlite3 handle per
 * reload would leak file descriptors and, worse, run the DDL again while the
 * previous handle still held a write lock.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../paths.js';
import * as schema from './schema.js';

export const DB_PATH = join(PROJECT_ROOT, 'data.db');

/**
 * Idempotent DDL, run at open.
 *
 * Deliberately not drizzle-kit migrations: this is a single-file local
 * database with one writer, and a migrations folder plus a generate step buys
 * nothing over `CREATE TABLE IF NOT EXISTS` until someone else has a copy of
 * the schema to keep in step with.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  customer TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS pt_project ON project_transcripts (project_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  session_reset INTEGER NOT NULL DEFAULT 0,
  cost INTEGER,
  duration_ms INTEGER,
  turns INTEGER,
  skill TEXT,
  files TEXT,
  documents TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_project ON messages (project_id, at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  meta TEXT,
  summary TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS run_status ON runs (status);
CREATE INDEX IF NOT EXISTS run_project ON runs (project_id);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ev_run ON run_events (run_id, seq);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action_id TEXT,
  label TEXT,
  cost_usd INTEGER,
  duration_ms INTEGER,
  turns INTEGER,
  files INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  skill TEXT,
  instruction TEXT NOT NULL DEFAULT '',
  scope TEXT,
  outputs TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  time TEXT NOT NULL DEFAULT '09:00',
  days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  grace_minutes INTEGER NOT NULL DEFAULT 20,
  last_slot TEXT,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sched_workflow ON schedules (workflow_id);

CREATE TABLE IF NOT EXISTS run_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rf_run ON run_files (run_id);

CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  policy TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  trigger TEXT,
  pulled INTEGER NOT NULL DEFAULT 0,
  organized INTEGER NOT NULL DEFAULT 0,
  projects INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  errors TEXT
);
`;

const globalForDb = globalThis;

function open() {
  const sqlite = new Database(DB_PATH);

  // WAL lets the scheduler write history while a page reads the project list.
  // Without it the reader blocks and the UI stutters during a pipeline run.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const store = (globalForDb.__gong_db ??= open());

export const sqlite = store.sqlite;
export const db = store.db;
export { schema };
