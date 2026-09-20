/**
 * runs.js — server-owned jobs whose output survives the page.
 *
 * A run streamed straight down the request that started it would both lose
 * the transcript of what happened on a tab switch and kill the job. Here the
 * run belongs to the server: every event is recorded, and a page can
 * subscribe at any time to replay what it missed and then follow live. That
 * is what makes a project chat look the same when you come back mid-analysis.
 *
 * Events live in SQLite rather than a Map, so run history also survives a
 * server restart. Two things stay in memory, and only two:
 *
 *   - the live subscriber callbacks, which are per-process by definition
 *   - the cancel closure over a running child, which cannot be serialised
 *
 * Both are pinned to globalThis because Next re-evaluates modules on edit,
 * and losing the cancel closure mid-run would orphan a billing child process.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, lt, desc, sql } from 'drizzle-orm';
import { db } from './core/db/client.js';
import { runs as runsTable, runEvents } from './core/db/schema.js';

/** Bounded so a pathological run cannot grow the database without limit. */
const MAX_EVENTS = 4000;

const mem = (globalThis.__gong_runs ??= {
  listeners: new Map(),   // runId -> Set<fn>
  cancels: new Map(),     // runId -> () => void
  text: new Map(),        // runId -> accumulated prose, flushed on finish
  seq: new Map(),         // runId -> next event sequence number
});

const parse = (s, fallback = null) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

/** A database row as the rest of the app expects a run to look. */
function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    label: row.label,
    meta: parse(row.meta, {}),
    status: row.status,
    text: mem.text.get(row.id) ?? row.text ?? '',
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    summary: parse(row.summary, null),
    get cancel() { return mem.cancels.get(row.id) || null; },
    set cancel(fn) { mem.cancels.set(row.id, fn); },
  };
}

export function createRun({ kind = 'chat', projectId = null, label = '', meta = {} }) {
  const id = randomUUID();
  const now = Date.now();

  db.insert(runsTable).values({
    id, kind, projectId, label, status: 'running', text: '',
    meta: JSON.stringify(meta), summary: null, startedAt: now, endedAt: null,
  }).run();

  mem.listeners.set(id, new Set());
  mem.text.set(id, '');
  mem.seq.set(id, 0);

  return hydrate({ id, kind, projectId, label, status: 'running', text: '',
    meta: JSON.stringify(meta), summary: null, startedAt: now, endedAt: null });
}

export function push(id, event) {
  const seq = mem.seq.get(id) ?? nextSeq(id);
  mem.seq.set(id, seq + 1);

  db.insert(runEvents).values({ runId: id, seq, payload: JSON.stringify(event) }).run();

  // Keep the tail if a run somehow floods; the head holds the useful context.
  if (seq > 0 && seq % 500 === 0) trim(id);

  if (event.type === 'text' && event.text) {
    mem.text.set(id, (mem.text.get(id) || '') + event.text);
  }
  if (event.type === 'done' && event.result) mem.text.set(id, event.result);

  for (const fn of mem.listeners.get(id) || []) {
    try { fn(event); } catch { /* a dead subscriber must not break the run */ }
  }
}

/** Recover the sequence counter for a run this process did not start. */
function nextSeq(id) {
  const row = db.select({ n: sql`COALESCE(MAX(seq), -1)` })
    .from(runEvents).where(eq(runEvents.runId, id)).get();
  return Number(row?.n ?? -1) + 1;
}

function trim(id) {
  const keep = db.select({ seq: runEvents.seq }).from(runEvents)
    .where(eq(runEvents.runId, id)).orderBy(desc(runEvents.seq)).limit(MAX_EVENTS).all();
  const floor = keep.at(-1)?.seq;
  if (floor == null) return;
  db.delete(runEvents)
    .where(and(eq(runEvents.runId, id), lt(runEvents.seq, floor))).run();
}

export function finish(id, patch = {}) {
  const run = get(id);
  if (!run) return null;

  const status = patch.status || 'done';
  const summary = { ...(run.summary || {}), ...patch };

  db.update(runsTable).set({
    status,
    endedAt: Date.now(),
    text: mem.text.get(id) ?? '',
    summary: JSON.stringify(summary),
  }).where(eq(runsTable.id, id)).run();

  push(id, { type: 'finished', status, summary });

  // The child is gone; nothing may hold a closure over it.
  mem.cancels.delete(id);
  return get(id);
}

/**
 * Follow a run. Recorded events replay immediately, so a page that arrives
 * late — or comes back after a tab switch, or after a server restart — sees
 * the whole story.
 */
export function subscribe(id, onEvent) {
  const run = get(id);
  if (!run) return null;

  const rows = db.select({ payload: runEvents.payload }).from(runEvents)
    .where(eq(runEvents.runId, id)).orderBy(runEvents.seq).all();
  for (const r of rows) {
    const e = parse(r.payload);
    if (e) onEvent(e);
  }

  if (run.status !== 'running') {
    onEvent({ type: 'closed-buffer', status: run.status });
    return () => {};
  }

  const set = mem.listeners.get(id) || new Set();
  mem.listeners.set(id, set);
  set.add(onEvent);
  return () => set.delete(onEvent);
}

export const get = (id) =>
  hydrate(db.select().from(runsTable).where(eq(runsTable.id, id)).get());

/** Attach the cancel closure. Separate because it cannot be persisted. */
export function setCancel(id, fn) {
  mem.cancels.set(id, fn);
}

export function list({ projectId, active } = {}) {
  const rows = db.select().from(runsTable).orderBy(desc(runsTable.startedAt)).all();
  return rows
    .filter((r) => (projectId === undefined || r.projectId === projectId))
    .filter((r) => (active === undefined || (r.status === 'running') === active))
    .map((r) => summarise(hydrate(r)));
}

/** A run without its events, for listings. */
export function summarise(run) {
  if (!run) return null;
  const n = db.select({ c: sql`COUNT(*)` }).from(runEvents)
    .where(eq(runEvents.runId, run.id)).get();
  return {
    id: run.id, kind: run.kind, projectId: run.projectId, label: run.label,
    status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
    meta: run.meta, summary: run.summary,
    events: Number(n?.c ?? 0),
  };
}

export function cancel(id) {
  const run = get(id);
  if (!run || run.status !== 'running') return false;
  const fn = mem.cancels.get(id);
  if (!fn) return false;
  fn();
  return true;
}

/**
 * A run marked running with no cancel closure in this process was started by
 * a process that is now gone — its child died with it. Called once at boot so
 * the UI does not show a permanently spinning job it can never stop.
 */
export function reapOrphans() {
  const stuck = db.select().from(runsTable).where(eq(runsTable.status, 'running')).all();
  let n = 0;
  for (const r of stuck) {
    if (mem.cancels.has(r.id)) continue;
    db.update(runsTable).set({
      status: 'cancelled',
      endedAt: r.endedAt || Date.now(),
      summary: JSON.stringify({ status: 'cancelled', reason: 'server restarted' }),
    }).where(eq(runsTable.id, r.id)).run();
    n += 1;
  }
  return n;
}

/** Drop finished runs once their chat has them, keeping the database flat. */
export function prune(keepMs = 6 * 3600e3) {
  const cutoff = Date.now() - keepMs;
  const old = db.select({ id: runsTable.id }).from(runsTable)
    .where(and(lt(runsTable.endedAt, cutoff), sql`status != 'running'`)).all();

  for (const { id } of old) {
    // run_files is deliberately left behind. This table is a replay buffer;
    // that one is the record of which transcripts have been processed, and it
    // has to outlive the six-hour window or the number is meaningless. It
    // carries its own timestamp so it needs nothing from here.
    db.delete(runEvents).where(eq(runEvents.runId, id)).run();
    db.delete(runsTable).where(eq(runsTable.id, id)).run();
    mem.listeners.delete(id);
    mem.cancels.delete(id);
    mem.text.delete(id);
    mem.seq.delete(id);
  }
  return old.length;
}
