/**
 * core/graph/build.js — turn a policy into a tree.
 *
 * The tree is computed on read, never stored. That is the whole design: a
 * graph stays current as transcripts arrive and Claude writes documents,
 * because there is nothing cached that could go stale and nothing that has to
 * remember to update itself.
 *
 * A policy is defaults plus per-client overrides:
 *
 *   {
 *     defaults: { sources: ['transcript','document','run'], window: 'all' },
 *     rules: [{ projectId: 'abc', sources: ['transcript'], window: 'last30d' }],
 *     exclude: ['projectId', …]
 *   }
 *
 * `rules` is what "policy per client, at different levels" means in practice:
 * the defaults apply to every customer, and a rule narrows one of them.
 */

import { desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  projects as projectsTable, projectTranscripts, runs as runsTable, runFiles,
} from '../db/schema.js';
import * as library from '../../library.js';

export const SOURCES = ['transcript', 'document', 'run'];
export const WINDOWS = { all: 0, last7d: 7, last30d: 30, last90d: 90 };

export const DEFAULT_POLICY = {
  defaults: { sources: [...SOURCES], window: 'all' },
  rules: [],
  exclude: [],
};

/** The policy that applies to one project: defaults, narrowed by any rule. */
export function policyFor(policy, projectId) {
  const base = { ...DEFAULT_POLICY.defaults, ...(policy?.defaults || {}) };
  const rule = (policy?.rules || []).find((r) => r.projectId === projectId);
  return rule ? { ...base, ...rule } : base;
}

const node = (id, name, kind, children = [], extra = {}) =>
  ({ id, name, kind, children, ...extra });

function group(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.projectId) continue;
    if (!m.has(r.projectId)) m.set(r.projectId, []);
    m.get(r.projectId).push(r);
  }
  return m;
}

export function buildGraph(policy = DEFAULT_POLICY) {
  const excluded = new Set(policy?.exclude || []);
  const docs = library.listFiles().filter((f) => f.kind === 'output');

  const tGroups = group(db.select({
    projectId: projectTranscripts.projectId,
    path: projectTranscripts.path,
    addedAt: projectTranscripts.addedAt,
  }).from(projectTranscripts).orderBy(desc(projectTranscripts.addedAt)).all());

  const rGroups = group(db.select({
    projectId: runsTable.projectId, id: runsTable.id, label: runsTable.label,
    status: runsTable.status, endedAt: runsTable.endedAt,
  }).from(runsTable).orderBy(desc(runsTable.startedAt)).all());

  // Documents a run actually produced, when the run recorded them. This is
  // what makes generated documents attach to the right customer rather than
  // being matched on a filename.
  const producedBy = new Map(
    db.select({ runId: runFiles.runId, path: runFiles.path }).from(runFiles).all()
      .map((r) => [r.path, r.runId])
  );

  const children = db.select().from(projectsTable).orderBy(projectsTable.name).all()
    .filter((p) => !excluded.has(p.id))
    .map((p) => {
      const rule = policyFor(policy, p.id);
      const cutoff = WINDOWS[rule.window] ? Date.now() - WINDOWS[rule.window] * 86400e3 : 0;
      const recent = (ts) => !cutoff || (ts || 0) >= cutoff;

      const t = (tGroups.get(p.id) || []).filter((x) => recent(x.addedAt));
      const r = (rGroups.get(p.id) || []).filter((x) => recent(x.endedAt));
      const runIds = new Set(r.map((x) => x.id));
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '');

      const d = docs.filter((f) => {
        if (!recent(f.mtime)) return false;
        const run = producedBy.get(f.path);
        // Prefer the recorded link; fall back to the name only for documents
        // generated before run_files existed.
        return run
          ? runIds.has(run)
          : f.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(slug);
      });

      const groups = [];
      if (rule.sources.includes('transcript') && t.length) {
        groups.push(node(`${p.id}:t`, 'Transcripts', 'group', t.slice(0, 40).map((x) =>
          node(x.path, x.path.split('/').pop(), 'transcript', [], { at: x.addedAt }))));
      }
      if (rule.sources.includes('document') && d.length) {
        groups.push(node(`${p.id}:d`, 'Documents', 'group', d.slice(0, 40).map((x) =>
          node(x.path, x.name, 'document', [], { at: x.mtime }))));
      }
      if (rule.sources.includes('run') && r.length) {
        groups.push(node(`${p.id}:r`, 'Runs', 'group', r.slice(0, 40).map((x) =>
          node(x.id, x.label || 'Run', 'run', [], { at: x.endedAt, status: x.status }))));
      }

      // Counts follow the policy too. Reporting documents a policy excludes
      // makes the totals disagree with the tree directly under them.
      const on = (kind, n) => (rule.sources.includes(kind) ? n : 0);

      // Flag only an explicit per-customer rule. Comparing against the full
      // source list instead marks every customer the moment the *defaults*
      // narrow anything, which says nothing about this one.
      const hasOwnRule = (policy?.rules || []).some((r) => r.projectId === p.id);

      return node(p.id, p.name, 'project', groups, {
        counts: {
          transcripts: on('transcript', t.length),
          documents: on('document', d.length),
          runs: on('run', r.length),
        },
        rule: hasOwnRule ? rule : null,
      });
    });

  const totals = children.reduce((a, c) => ({
    transcripts: a.transcripts + c.counts.transcripts,
    documents: a.documents + c.counts.documents,
    runs: a.runs + c.counts.runs,
  }), { transcripts: 0, documents: 0, runs: 0 });

  return {
    tree: node('root', 'All customers', 'root', children),
    totals: { projects: children.length, ...totals },
  };
}
