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
  // 'transcript' is a Gong call; 'context' is rendered from a connector that
  // is not files — the CX Portal tracker today. They live in one table because
  // both answer "what may a run about this customer see", but they are pruned
  // separately: syncFromLibrary rebuilds transcripts from the sorted tree and
  // would otherwise delete every context file on its next pass.
  kind: text('kind').notNull().default('transcript'),
  source: text('source'),                     // 'gong' | 'cxportal' | null
  addedAt: integer('added_at').notNull(),
}, (t) => [index('pt_project').on(t.projectId), index('pt_kind').on(t.kind)]);

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
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
}, (t) => [index('usage_at').on(t.at)]);

/**
 * A reusable recipe: what to run, over which inputs, producing what.
 *
 * Authored and tested in Workbench, scheduled from Automation, executed by one
 * `runWorkflow()` — so what was tested is literally what runs. Kept separate
 * from `schedules` so one definition can run daily for one customer and weekly
 * for another without the prompt being copy-pasted and then drifting.
 */
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // A sync is source → destination. Today only gong → claude exists, but
  // naming it now is what lets the Workbench list sync *types* as cards
  // rather than hard-coding the one that happens to exist.
  source: text('source').notNull().default('gong'),
  destination: text('destination').notNull().default('claude'),
  skill: text('skill'),                       // installed skill, or null
  instruction: text('instruction').notNull().default(''),
  // Per-source steers, appended to `instruction` only when that source is
  // actually in scope. A run over calls alone and a run over the tracker alone
  // want different things asked of them, and a run over both wants a third
  // thing — reconciling what was said against what was recorded. One prompt
  // covering all three says nothing specific about any of them.
  sourceInstructions: text('source_instructions'),   // JSON {transcript,cxportal,combined}
  pull: text('pull'),                         // JSON: days, format, organize
  scope: text('scope'),                       // JSON {projectId, sources[], window}
  outputs: text('outputs'),                   // JSON {dir, formats[]}
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** When a workflow runs. Many schedules may point at one workflow. */
export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  name: text('name').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  time: text('time').notNull().default('09:00'),
  days: text('days').notNull().default('[1,2,3,4,5]'),   // JSON, 0 = Sunday
  graceMinutes: integer('grace_minutes').notNull().default(20),
  lastSlot: text('last_slot'),                // YYYY-MM-DD already handled
  lastRunAt: integer('last_run_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('sched_workflow').on(t.workflowId)]);

/** Which transcripts a run actually consumed. */
export const runFiles = sqliteTable('run_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  path: text('path').notNull(),
  // Its own timestamp, deliberately. `runs` is a six-hour replay buffer that
  // prune() empties, so a row here that leaned on the run for its date would
  // lose it by the afternoon — and "transcripts processed" would read zero on
  // a system that had processed hundreds.
  at: integer('at'),
}, (t) => [index('rf_run').on(t.runId), index('rf_at').on(t.at)]);

/**
 * A saved graph: a name plus a policy describing what belongs in it.
 *
 * The tree is never stored — it is computed from the policy every time it is
 * read. That is what makes a graph stay current as transcripts arrive and
 * documents are generated, without anything having to remember to update it.
 */
export const graphs = sqliteTable('graphs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  policy: text('policy'),                     // JSON, see core/graph/build.js
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Something a run produced that a person should see before it goes anywhere.
 *
 * The argument for this queue is in docs/product-notes.md: at volume a
 * 90%-accurate system writing straight into a system of record produces wrong
 * updates faster than anyone notices, and trust is lost once. The goal is not
 * less human involvement — it is *cheaper* human involvement, which means
 * approving a diff rather than authoring a document.
 */
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  workflowId: text('workflow_id'),
  projectId: text('project_id'),
  kind: text('kind').notNull(),            // 'document' | 'email'
  title: text('title').notNull().default(''),
  path: text('path'),                      // for documents
  body: text('body'),                      // for emails, and the diff source
  status: text('status').notNull().default('pending'),  // pending | approved | rejected
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
}, (t) => [index('appr_status').on(t.status, t.createdAt)]);

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

/**
 * A notification — a fact worth surfacing without anyone asking for it.
 *
 * Exists because a scheduled sync runs unattended by design, and a person who
 * opens the app hours later has no way to tell "nothing happened" from
 * "something happened and quietly failed" without one. `runs` cannot serve
 * this: it is a six-hour buffer, pruned, and per-run rather than global — a
 * notification has to outlive the run it describes and be visible from any
 * page, not just the one that started it.
 */
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),          // 'schedule_started' | 'schedule_done' | 'schedule_error' | 'schedule_missed'
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  runId: text('run_id'),
  workflowId: text('workflow_id'),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  at: integer('at').notNull(),
}, (t) => [index('notif_at').on(t.at), index('notif_read').on(t.read)]);

/**
 * A user-authored automation — real JavaScript, run inside a sandbox that
 * exposes a curated set of functions (core/engine/api.js) rather than the
 * whole Node runtime. Separate from `workflows`: a workflow is a skill plus a
 * scope, declarative enough to render as a form; a script is code, for
 * whoever needs flexibility the form cannot express.
 */
export const scripts = sqliteTable('scripts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  code: text('code').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at'),
  lastStatus: text('last_status'),        // 'ok' | 'error' | null (never run)
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
