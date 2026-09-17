/**
 * core/workflow/store.js — workflows and the schedules that fire them.
 *
 * Two tables rather than one: a workflow is *what to do*, a schedule is *when*.
 * Folding them together would mean duplicating a prompt to run it for a second
 * customer, and duplicated prompts drift.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workflows, schedules } from '../db/schema.js';

const parse = (s, f = null) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

const hydrate = (r) => r && ({
  ...r,
  scope: parse(r.scope, { projectId: null, sources: ['transcript'], window: 'last7d' }),
  outputs: parse(r.outputs, { dir: null, formats: ['docx'] }),
  builtin: Boolean(r.builtin),
});

export function listWorkflows() {
  return db.select().from(workflows).orderBy(desc(workflows.updatedAt)).all().map(hydrate);
}

export const getWorkflow = (id) =>
  hydrate(db.select().from(workflows).where(eq(workflows.id, id)).get());

export function saveWorkflow(w) {
  const now = Date.now();
  const id = w.id || randomUUID();
  const row = {
    id,
    name: String(w.name || 'Untitled workflow').slice(0, 80),
    description: String(w.description || '').slice(0, 280),
    skill: w.skill || null,
    instruction: String(w.instruction || ''),
    scope: JSON.stringify(w.scope || {}),
    outputs: JSON.stringify(w.outputs || {}),
    updatedAt: now,
  };

  const existing = w.id && db.select().from(workflows).where(eq(workflows.id, w.id)).get();

  // `builtin` belongs to the record, not to the edit — same reasoning as
  // core/graph/store.js.
  if (existing) {
    db.update(workflows).set(row).where(eq(workflows.id, id)).run();
  } else {
    db.insert(workflows).values({ ...row, builtin: Boolean(w.builtin), createdAt: now }).run();
  }
  return getWorkflow(id);
}

export function deleteWorkflow(id) {
  db.delete(schedules).where(eq(schedules.workflowId, id)).run();
  return db.delete(workflows).where(eq(workflows.id, id)).run().changes > 0;
}

/* ------------------------------------------------------------- schedules */

const hydrateSchedule = (r) => r && ({ ...r, days: parse(r.days, [1, 2, 3, 4, 5]), enabled: Boolean(r.enabled) });

export function listSchedules() {
  return db.select().from(schedules).orderBy(schedules.time).all().map((s) => {
    const w = getWorkflow(s.workflowId);
    return { ...hydrateSchedule(s), workflow: w ? { id: w.id, name: w.name, skill: w.skill } : null };
  });
}

export const getSchedule = (id) =>
  hydrateSchedule(db.select().from(schedules).where(eq(schedules.id, id)).get());

export function saveSchedule(s) {
  const id = s.id || randomUUID();
  const row = {
    id,
    workflowId: s.workflowId,
    name: String(s.name || '').slice(0, 80),
    enabled: Boolean(s.enabled),
    time: s.time || '09:00',
    days: JSON.stringify(Array.isArray(s.days) ? s.days : [1, 2, 3, 4, 5]),
    graceMinutes: Number(s.graceMinutes) || 20,
  };
  const existing = s.id && db.select().from(schedules).where(eq(schedules.id, s.id)).get();
  if (existing) db.update(schedules).set(row).where(eq(schedules.id, id)).run();
  else db.insert(schedules).values({ ...row, createdAt: Date.now() }).run();
  return getSchedule(id);
}

export const deleteSchedule = (id) =>
  db.delete(schedules).where(eq(schedules.id, id)).run().changes > 0;

export function markScheduleRan(id, slot) {
  db.update(schedules).set({ lastSlot: slot, lastRunAt: Date.now() })
    .where(eq(schedules.id, id)).run();
}

/**
 * The pull → organize → projects pipeline, as a workflow rather than a special
 * case. Seeded once so Automation has something real to schedule on day one.
 */
export function ensureBuiltins() {
  const have = db.select().from(workflows).where(eq(workflows.builtin, true)).all();
  if (have.length) return have.map(hydrate);
  return [saveWorkflow({
    name: 'Daily transcript sync',
    description: 'Pull recent Gong calls, group them by customer, and attach them to projects.',
    skill: null,
    instruction: '',
    scope: { projectId: null, sources: ['transcript'], window: 'last2d' },
    outputs: { kind: 'pipeline' },
    builtin: true,
  })];
}
