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
import { getScript } from '../engine/store.js';

const parse = (s, f = null) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

const hydrate = (r) => r && ({
  ...r,
  scope: parse(r.scope, { projectId: null, sources: ['transcript'], window: { preset: 'week', anchor: 'this' } }),
  outputs: parse(r.outputs, { dir: null, formats: ['docx'] }),
  pull: parse(r.pull, { enabled: true, days: 2, organize: true, organizeBy: 'customer' }),
  sourceInstructions: parse(r.sourceInstructions, { transcript: '', cxportal: '', combined: '' }),
  builtin: Boolean(r.builtin),
});

export function listWorkflows() {
  return db.select().from(workflows).orderBy(desc(workflows.updatedAt)).all().map(hydrate);
}

export const getWorkflow = (id) =>
  hydrate(db.select().from(workflows).where(eq(workflows.id, id)).get());

export function saveWorkflow(patch) {
  const now = Date.now();
  const id = patch.id || randomUUID();

  // Merge onto what is stored, rather than rebuilding every column from the
  // body. Each field below has a default, so a request carrying only `scope`
  // used to reset the name to "Untitled workflow", blank the instruction and
  // send `source` back to 'gong' — which silently moved the automation into a
  // different sync. A partial update has to stay partial.
  const current = patch.id ? getWorkflow(patch.id) : null;
  const w = current ? { ...current, ...patch } : patch;

  const row = {
    id,
    name: String(w.name || 'Untitled workflow').slice(0, 80),
    description: String(w.description || '').slice(0, 280),
    source: w.source || 'gong',
    destination: w.destination || 'claude',
    pull: JSON.stringify(w.pull || {}),
    skill: w.skill || null,
    instruction: String(w.instruction || ''),
    sourceInstructions: JSON.stringify(w.sourceInstructions || {}),
    scope: JSON.stringify(w.scope || {}),
    outputs: JSON.stringify(w.outputs || {}),
    updatedAt: now,
  };

  const existing = Boolean(current);

  // `builtin` belongs to the record, not to the edit — same reasoning as
  // core/graph/store.js.
  if (existing) {
    db.update(workflows).set(row).where(eq(workflows.id, id)).run();
  } else {
    db.insert(workflows).values({ ...row, builtin: Boolean(patch.builtin), createdAt: now }).run();
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
    const w = s.workflowId ? getWorkflow(s.workflowId) : null;
    const script = s.scriptId ? getScript(s.scriptId) : null;
    return {
      ...hydrateSchedule(s),
      workflow: w ? { id: w.id, name: w.name, skill: w.skill } : null,
      script: script ? { id: script.id, name: script.name } : null,
    };
  });
}

export const getSchedule = (id) =>
  hydrateSchedule(db.select().from(schedules).where(eq(schedules.id, id)).get());

/**
 * @param s.workflowId  set to run a workflow — mutually exclusive with scriptId
 * @param s.scriptId    set to run a script instead — see the `schedules`
 *   table's own comment in core/db/schema.js for why this is `''` rather
 *   than `null` on the stored row when a script is what's scheduled.
 */
export function saveSchedule(s) {
  const workflowId = s.workflowId || '';
  const scriptId = s.scriptId || null;
  if (!workflowId && !scriptId) throw new Error('a schedule needs a workflow or a script');
  if (workflowId && scriptId) throw new Error('a schedule runs a workflow or a script, not both');

  const id = s.id || randomUUID();
  const row = {
    id,
    workflowId,
    scriptId,
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
 * Sync types, for the Workbench card list.
 *
 * A sync is a source → destination pair. Grouping workflows by that pair is
 * what makes "Gong → Claude" a card with N configured automations under it,
 * rather than a flat list nobody can scan.
 */
export const SYNC_TYPES = [
  {
    id: 'gong-claude',
    source: 'gong',
    destination: 'claude',
    name: 'Gong → Claude',
    summary: 'Pull call transcripts, then generate documents from them.',
    available: true,
  },
  {
    id: 'gong-cxportal-claude',
    source: 'gong+cxportal',
    destination: 'claude',
    name: 'Gong + CX Portal → Claude',
    summary: 'Calls and delivery state together, correlated by customer. Pick either side or both.',
    available: true,
    // What makes this one different: the sources are a per-automation choice
    // rather than a property of the sync, and each choice gets its own steer.
    multiSource: true,
  },
  {
    id: 'cxportal-warp',
    source: 'cxportal',
    destination: 'projects',
    name: 'CX Portal → Projects',
    summary: 'Import the project tracker so Warp names customers the way the tracker does.',
    available: true,
  },
  {
    id: 'gong-cxportal',
    source: 'gong',
    destination: 'cxportal',
    name: 'Gong → CX Portal',
    summary: 'Push call commitments back into the tracker. Needs write endpoints.',
    available: false,
  },
  {
    id: 'gong-jira',
    source: 'gong',
    destination: 'jira',
    name: 'Gong → Jira',
    summary: 'Turn call commitments into issues. Needs the Jira application.',
    available: false,
  },
  {
    id: 'm365-claude',
    source: 'm365',
    destination: 'claude',
    name: 'Microsoft 365 → Claude',
    summary: 'Mail and calendar as a second source of commitments.',
    available: false,
  },
];

/** Every sync type, with the workflows configured against it. */
export function listSyncs() {
  const all = listWorkflows();
  return SYNC_TYPES.map((t) => {
    const workflows = all.filter((w) => w.source === t.source && w.destination === t.destination);
    const ids = new Set(workflows.map((w) => w.id));
    const schedules = listSchedules().filter((s) => ids.has(s.workflowId));
    return {
      ...t,
      workflows,
      counts: {
        configured: workflows.length,
        scheduled: schedules.filter((s) => s.enabled).length,
      },
    };
  });
}

export const getSyncType = (id) => SYNC_TYPES.find((t) => t.id === id) || null;

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
    scope: { projectId: null, sources: ['transcript'], window: { preset: 'day', anchor: 'this' } },
    outputs: { kind: 'pipeline' },
    builtin: true,
  })];
}
