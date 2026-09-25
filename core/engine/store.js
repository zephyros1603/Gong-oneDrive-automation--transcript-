/**
 * core/engine/store.js — scripts as records, and running one as a run.
 *
 * A script executes through runs.js, the same server-owned mechanism as a
 * chat or a workflow, for the same reasons: it streams, it survives a tab
 * switch, it is cancellable, and history is free. `runScript`'s own event
 * stream (`call` / `log` / `error`) is pushed into the run exactly like a
 * chat's `text`/`tool` events are.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scripts, schedules } from '../db/schema.js';
import * as runs from '../../runs.js';
import { runScript } from './sandbox.js';

// sandbox.js's own 60s default was sized for the short, single-call utility
// scripts this engine started with (a pull, a correlate check, a quick
// return). A script that makes one warp.claude.run() call per customer in a
// loop (e.g. scripts/wsr-build-docx.js) genuinely needs minutes, not
// seconds — and when the old 60s timeout won its Promise.race against a
// script mid-await, the script kept running anyway (vm's synchronous
// timeout can't interrupt an await), just with the run already marked
// "abandoned" and no further run-log visibility into what it did. Raised
// here rather than left unbounded, so a script that's truly hung still
// gets caught eventually.
const SCRIPT_TIMEOUT_MS = 20 * 60 * 1000;

const hydrate = (r) => r && ({
  id: r.id, name: r.name, description: r.description, code: r.code,
  enabled: Boolean(r.enabled),
  lastRunAt: r.lastRunAt, lastStatus: r.lastStatus, lastError: r.lastError,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export function listScripts() {
  return db.select().from(scripts).orderBy(desc(scripts.updatedAt)).all().map(hydrate);
}

export const getScript = (id) =>
  hydrate(db.select().from(scripts).where(eq(scripts.id, id)).get());

export function saveScript(patch) {
  const now = Date.now();
  const id = patch.id || randomUUID();
  const current = patch.id ? getScript(patch.id) : null;
  const merged = current ? { ...current, ...patch } : patch;

  const row = {
    id,
    name: String(merged.name || 'Untitled script').slice(0, 80),
    description: String(merged.description || '').slice(0, 280),
    code: String(merged.code || ''),
    enabled: merged.enabled !== false,
    updatedAt: now,
  };

  if (current) {
    db.update(scripts).set(row).where(eq(scripts.id, id)).run();
  } else {
    db.insert(scripts).values({ ...row, createdAt: now }).run();
  }
  return getScript(id);
}

export function deleteScript(id) {
  // Same cascade core/workflow/store.js's deleteWorkflow() applies —
  // a schedule pointing at a deleted script is a schedule that silently
  // fires nothing, forever, which is worse than one that's just gone.
  db.delete(schedules).where(eq(schedules.scriptId, id)).run();
  return db.delete(scripts).where(eq(scripts.id, id)).run().changes > 0;
}

/**
 * Run a script as a tracked run. Fire-and-forget, like startChatRun — the
 * caller follows the returned run id through runs.subscribe().
 *
 * @param scheduleId  set only when the scheduler is the caller — carried
 *   into the run's meta so core/workflow/scheduler.js's double-fire guard
 *   (a slow run still active when the next tick lands) can recognise this
 *   run as already covering the slot, the same way it does for a workflow.
 */
export function runStoredScript(scriptId, { trigger = 'manual', scheduleId = null } = {}) {
  const script = getScript(scriptId);
  if (!script) throw new Error('no such script');

  const run = runs.createRun({
    kind: 'script',
    label: script.name,
    meta: { scriptId, trigger, scheduleId },
  });

  (async () => {
    const result = await runScript(script.code, {
      onEvent: (e) => runs.push(run.id, e),
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });

    db.update(scripts).set({
      lastRunAt: Date.now(),
      lastStatus: result.ok ? 'ok' : 'error',
      lastError: result.ok ? null : result.error,
    }).where(eq(scripts.id, scriptId)).run();

    if (result.ok) {
      runs.push(run.id, { type: 'result', value: result.result });
      runs.finish(run.id, { status: 'done' });
    } else {
      runs.push(run.id, { type: 'error', message: result.error });
      runs.finish(run.id, { status: 'error', errors: [result.error] });
    }
  })();

  return { runId: run.id };
}
