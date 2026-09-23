/**
 * core/notify.js — facts worth surfacing without anyone asking.
 *
 * A scheduled sync runs unattended by design, so the moment it matters is not
 * "the request came back" — nobody made one — it is whenever someone next
 * looks at the app. Every notification is a row, not just an in-memory event,
 * because the whole point is to be seen *later*.
 *
 * Delivery is two layers, same shape as runs.js:
 *   - persisted, so a page opened an hour later still sees it
 *   - fanned out live to whoever is already looking, over SSE
 *
 * Pinned to globalThis for the same reason as runs.js: Next re-evaluates
 * modules on every edit in dev, and a fresh Set of subscribers on every edit
 * would silently drop whoever was already connected.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { notifications } from './db/schema.js';
import * as runs from '../runs.js';

const g = globalThis;
const mem = (g.__gong_notify ??= { subscribers: new Set() });

const row2notification = (r) => r && ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body || '',
  runId: r.runId,
  workflowId: r.workflowId,
  read: Boolean(r.read),
  at: r.at,
});

/**
 * Record a notification and push it to every live subscriber.
 *
 * Never throws into the caller — a scheduler tick that failed to notify must
 * still have run the actual sync; losing the toast is not worth losing the
 * work over.
 */
export function notify({ kind, title, body = '', runId = null, workflowId = null }) {
  const row = {
    id: randomUUID(), kind, title, body,
    runId, workflowId, read: false, at: Date.now(),
  };
  try {
    db.insert(notifications).values(row).run();
  } catch (err) {
    console.error('  ! notify() failed to persist:', err?.message || err);
  }

  const payload = row2notification(row);
  for (const fn of mem.subscribers) {
    try { fn(payload); } catch { /* one bad listener must not break the rest */ }
  }
  return payload;
}

/** A page's live feed. Returns the unsubscribe function. */
export function subscribe(fn) {
  mem.subscribers.add(fn);
  return () => mem.subscribers.delete(fn);
}

export function list({ limit = 50, unreadOnly = false } = {}) {
  const rows = unreadOnly
    ? db.select().from(notifications).where(eq(notifications.read, false))
        .orderBy(desc(notifications.at)).limit(limit).all()
    : db.select().from(notifications).orderBy(desc(notifications.at)).limit(limit).all();
  return rows.map(row2notification);
}

export function unreadCount() {
  const r = db.select({ n: sql`COUNT(*)` }).from(notifications)
    .where(eq(notifications.read, false)).get();
  return Number(r?.n ?? 0);
}

export function markRead(id) {
  db.update(notifications).set({ read: true }).where(eq(notifications.id, id)).run();
}

export function markAllRead() {
  db.update(notifications).set({ read: true }).where(eq(notifications.read, false)).run();
}

/**
 * Notify on start, then watch the run to notify again on completion.
 *
 * One place for this because both schedulers — the legacy pipeline and
 * per-workflow schedules — need the same two-part behaviour, and getting the
 * "done" half right depends on runs.js internals (the `finished` event,
 * subscribing before it fires) that a scheduler module should not have to
 * know about twice.
 */
export function notifyScheduledRun({ runId, workflowId, label }) {
  notify({
    kind: 'schedule_started',
    title: `${label || 'Scheduled sync'} started`,
    body: 'Running now — this page will update when it finishes.',
    runId, workflowId,
  });

  const unsubscribe = runs.subscribe(runId, (e) => {
    if (e.type !== 'finished' && e.type !== 'closed-buffer') return;

    const status = e.status;
    if (status === 'running') return;   // closed-buffer replay of a live run

    unsubscribe?.();
    if (status === 'done') {
      const summary = e.summary || {};
      const bits = [];
      if (summary.pulled != null) bits.push(`${summary.pulled} call(s) pulled`);
      if (summary.organized != null) bits.push(`${summary.organized} organised`);
      notify({
        kind: 'schedule_done',
        title: `${label || 'Scheduled sync'} finished`,
        body: bits.length ? bits.join(', ') : 'Completed — check Approvals for anything it produced.',
        runId, workflowId,
      });
    } else if (status === 'cancelled') {
      notify({
        kind: 'schedule_error', title: `${label || 'Scheduled sync'} was cancelled`,
        body: '', runId, workflowId,
      });
    } else {
      notify({
        kind: 'schedule_error', title: `${label || 'Scheduled sync'} failed`,
        body: (e.summary?.errors || []).join('; ') || 'Check the run log for details.',
        runId, workflowId,
      });
    }
  });
}

/** Keep the table from growing forever; a month of history is plenty. */
export function prune(keepMs = 30 * 24 * 3600e3) {
  const cutoff = Date.now() - keepMs;
  return db.delete(notifications).where(sql`at < ${cutoff}`).run().changes;
}
