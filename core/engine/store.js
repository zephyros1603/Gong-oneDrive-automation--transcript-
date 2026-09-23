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
import { scripts } from '../db/schema.js';
import * as runs from '../../runs.js';
import { runScript } from './sandbox.js';

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
  return db.delete(scripts).where(eq(scripts.id, id)).run().changes > 0;
}

/**
 * Run a script as a tracked run. Fire-and-forget, like startChatRun — the
 * caller follows the returned run id through runs.subscribe().
 */
export function runStoredScript(scriptId, { trigger = 'manual' } = {}) {
  const script = getScript(scriptId);
  if (!script) throw new Error('no such script');

  const run = runs.createRun({
    kind: 'script',
    label: script.name,
    meta: { scriptId, trigger },
  });

  (async () => {
    const result = await runScript(script.code, {
      onEvent: (e) => runs.push(run.id, e),
      timeoutMs: 60_000,
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
