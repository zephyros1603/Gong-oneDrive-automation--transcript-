/**
 * core/run-files.js — which files a run actually consumed.
 *
 * `runs.meta.files` is a count, so it can tell you a run read four things but
 * never which four. That makes "transcripts processed" unanswerable and leaves
 * the graph unable to draw the edge from a customer's call to the document it
 * produced. The paths go here instead, written once at the point a run is
 * handed its inputs.
 *
 * Both entry points — a Workbench chat and a scheduled workflow — record
 * through this, or the number would only ever count half the work.
 */

import { db } from './db/client.js';
import { runFiles } from './db/schema.js';

export function recordRunFiles(runId, paths = [], at = Date.now()) {
  if (!runId || !paths.length) return 0;

  // A run may be handed the same transcript twice — once attached, once in
  // project scope — and counting it twice would overstate the total.
  const seen = [...new Set(paths.filter(Boolean).map(String))];

  const insert = db.insert(runFiles);
  for (const path of seen) {
    try {
      insert.values({ runId, path, at }).run();
    } catch { /* bookkeeping must never fail a run */ }
  }
  return seen.length;
}
