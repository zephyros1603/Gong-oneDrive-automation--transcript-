/**
 * core/db/schema.js — the shape of everything that persists.
 *
 * SQLite because it is one file with no server to run, and Drizzle because it
 * gives structured queries without a migration toolchain in the loop.
 * Swapping to Postgres later is a driver change plus these definitions.
 *
 * Plain JavaScript, not TypeScript, because the CLI and the old server import
 * it under bare `node`, which cannot load a .ts file. The app/ code above it
 * is TypeScript and infers its types from these table definitions anyway.
 *
 * JSON-shaped columns are stored as text and parsed at the edges. SQLite has
 * no native JSON column and the alternative — a table per nested shape — buys
 * nothing here, since nothing queries inside those blobs.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/** One customer: their transcripts, their conversation, their Claude session. */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  folder: text('folder').notNull(),
  customer: text('customer'),
  /** The Claude conversation this project continues. Null starts fresh. */
  sessionId: text('session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Which files belong to a project. A row per path rather than a JSON array,
 * so the organizer can add one without rewriting the project.
 */
export const projectTranscripts = sqliteTable('project_transcripts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: text('project_id').notNull(),
  path: text('path').notNull(),
  addedAt: integer('added_at').notNull(),
}, (t) => [index('pt_project').on(t.projectId)]);

/** A turn in a project conversation. */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  role: text('role').notNull(),               // 'user' | 'claude'
  text: text('text').notNull().default(''),
  runId: text('run_id'),
  pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
  cancelled: integer('cancelled', { mode: 'boolean' }).notNull().default(false),
  sessionReset: integer('session_reset', { mode: 'boolean' }).notNull().default(false),
  cost: integer('cost'),                      // micro-dollars; see toMicros()
  durationMs: integer('duration_ms'),
  turns: integer('turns'),
  skill: text('skill'),                       // JSON {id,label}
  files: text('files'),                       // JSON [{path,name}]
  documents: text('documents'),               // JSON [{path,name,size}]
  at: integer('at').notNull(),
}, (t) => [index('msg_project').on(t.projectId, t.at)]);

/**
 * A unit of work the server owns. Persisted — unlike the in-memory registry
 * it replaces — so history survives a restart. Only the live cancel closure
 * stays in memory, which is correct: after a restart there is nothing to kill.
 */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),               // 'chat' | 'automation'
  projectId: text('project_id'),
  label: text('label').notNull().default(''),
  status: text('status').notNull(),           // 'running' | 'done' | 'cancelled' | 'error'
  text: text('text').notNull().default(''),   // accumulated assistant prose
  meta: text('meta'),                         // JSON
  summary: text('summary'),                   // JSON
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
}, (t) => [index('run_status').on(t.status), index('run_project').on(t.projectId)]);

/** Every event a run emitted, in order. This is what makes replay work. */
export const runEvents = sqliteTable('run_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  payload: text('payload').notNull(),         // JSON
}, (t) => [index('ev_run').on(t.runId, t.seq)]);

/** UI state that is not a credential. Credentials stay in gong.env. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),             // JSON
});

/** What each run cost, so the total is a query rather than a running tally. */
export const usage = sqliteTable('usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  actionId: text('action_id'),
  label: text('label'),
  costUsd: integer('cost_usd'),               // micro-dollars
  durationMs: integer('duration_ms'),
  turns: integer('turns'),
  files: integer('files'),
  cancelled: integer('cancelled', { mode: 'boolean' }).notNull().default(false),
}, (t) => [index('usage_at').on(t.at)]);

/** Scheduler outcomes, including the days that were skipped. */
export const automationHistory = sqliteTable('automation_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  kind: text('kind').notNull(),               // 'ok' | 'error' | 'missed'
  trigger: text('trigger'),                   // 'manual' | 'schedule'
  pulled: integer('pulled').notNull().default(0),
  organized: integer('organized').notNull().default(0),
  projects: integer('projects').notNull().default(0),
  durationMs: integer('duration_ms'),
  errors: text('errors'),                     // JSON []
});

/**
 * Money is stored as an integer of micro-dollars.
 *
 * SQLite REALs would accumulate float error across a usage table that is only
 * ever summed, and $0.096229 is six significant decimals — exactly the range
 * where that starts to show.
 */
export const toMicros = (usd) =>
  usd == null ? null : Math.round(usd * 1e6);
export const fromMicros = (micros) =>
  micros == null ? null : micros / 1e6;
