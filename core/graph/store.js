/**
 * core/graph/store.js — saved graphs.
 *
 * A graph is a name and a policy. Everything visible in it is derived, so
 * saving one costs nothing and there is no rebuild step.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { graphs } from '../db/schema.js';
import { DEFAULT_POLICY } from './build.js';

const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const hydrate = (r) => r && ({ ...r, policy: parse(r.policy, DEFAULT_POLICY), builtin: Boolean(r.builtin) });

export const listGraphs = () =>
  db.select().from(graphs).orderBy(desc(graphs.updatedAt)).all().map(hydrate);

export const getGraph = (id) =>
  hydrate(db.select().from(graphs).where(eq(graphs.id, id)).get());

export function saveGraph(g) {
  const now = Date.now();
  const id = g.id || randomUUID();
  const row = {
    id,
    name: String(g.name || 'Untitled graph').slice(0, 80),
    description: String(g.description || '').slice(0, 280),
    policy: JSON.stringify(g.policy || DEFAULT_POLICY),
    updatedAt: now,
  };
  const existing = g.id && db.select().from(graphs).where(eq(graphs.id, g.id)).get();

  // `builtin` belongs to the record, not to the edit. Taking it from the
  // caller meant any save that omitted it demoted the default graph, which
  // then let it be deleted and made ensureDefaultGraph() create a duplicate.
  if (existing) {
    db.update(graphs).set(row).where(eq(graphs.id, id)).run();
  } else {
    db.insert(graphs).values({ ...row, builtin: Boolean(g.builtin), createdAt: now }).run();
  }
  return getGraph(id);
}

export function deleteGraph(id) {
  const g = getGraph(id);
  if (g?.builtin) throw new Error('the default graph cannot be deleted');
  return db.delete(graphs).where(eq(graphs.id, id)).run().changes > 0;
}

/** Everything, unfiltered — the graph you get before defining any policy. */
export function ensureDefaultGraph() {
  const have = db.select().from(graphs).where(eq(graphs.builtin, true)).get();
  if (have) return hydrate(have);
  return saveGraph({
    name: 'All activity',
    description: 'Every customer, every source. The starting point before any policy is applied.',
    policy: DEFAULT_POLICY,
    builtin: true,
  });
}
