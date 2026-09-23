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
  kind TEXT NOT NULL DEFAULT 'transcript',
  source TEXT,
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
  path TEXT NOT NULL,
  at INTEGER
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

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  workflow_id TEXT,
  project_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  path TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS appr_status ON approvals (status, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  workflow_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notif_at ON notifications (at);
CREATE INDEX IF NOT EXISTS notif_read ON notifications (read);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
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
  migrateColumns(sqlite);
  // After the ALTERs, never before: an index over a column that migrateColumns
  // has yet to add would abort the whole DDL batch on an older database.
  sqlite.exec(ADDED_INDEXES);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

/**
 * Columns added after a table first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so a new
 * column needs an explicit ALTER. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * hence the pragma check — and a duplicate-column error is swallowed rather
 * than crashing a server that is otherwise fine.
 */
const ADDED_COLUMNS = [
  ['workflows', 'source', "TEXT NOT NULL DEFAULT 'gong'"],
  ['workflows', 'destination', "TEXT NOT NULL DEFAULT 'claude'"],
  ['workflows', 'pull', 'TEXT'],
  ['usage', 'input_tokens', 'INTEGER'],
  ['usage', 'output_tokens', 'INTEGER'],
  ['usage', 'cache_read_tokens', 'INTEGER'],
  ['usage', 'cache_write_tokens', 'INTEGER'],
  ['run_files', 'at', 'INTEGER'],
  ['project_transcripts', 'kind', "TEXT NOT NULL DEFAULT 'transcript'"],
  ['project_transcripts', 'source', 'TEXT'],
  ['workflows', 'source_instructions', 'TEXT'],
];

/** Indexes over columns that ADDED_COLUMNS introduces. */
const ADDED_INDEXES = `
CREATE INDEX IF NOT EXISTS rf_at ON run_files (at);
CREATE INDEX IF NOT EXISTS pt_kind ON project_transcripts (kind);
`;

function migrateColumns(sqlite) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    try {
      const has = sqlite.prepare(`PRAGMA table_info(${table})`).all()
        .some((c) => c.name === column);
      if (!has) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch { /* the table may not exist yet on a first run; DDL covers it */ }
  }
}

const store = (globalForDb.__gong_db ??= open());

export const sqlite = store.sqlite;
export const db = store.db;
export { schema };
