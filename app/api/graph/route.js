export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { sql, eq, desc } from 'drizzle-orm';
import { db } from '@/core/db/client.js';
import {
  projects as projectsTable, projectTranscripts, runs as runsTable,
} from '@/core/db/schema.js';
import * as library from '@/library.js';

/**
 * Client → project → activity, as a tree.
 *
 * A tree rather than a graph because the relationships here are strictly
 * hierarchical. The day a project-management connector supplies cross-links
 * (an issue blocking two projects) is the day this needs to become a graph,
 * and not before.
 */
export async function GET() {
  const docs = library.listFiles().filter((f) => f.kind === 'output');

  const transcripts = db.select({
    projectId: projectTranscripts.projectId,
    path: projectTranscripts.path,
    addedAt: projectTranscripts.addedAt,
  }).from(projectTranscripts).orderBy(desc(projectTranscripts.addedAt)).all();

  const runRows = db.select({
    projectId: runsTable.projectId,
    id: runsTable.id,
    label: runsTable.label,
    status: runsTable.status,
    endedAt: runsTable.endedAt,
  }).from(runsTable).orderBy(desc(runsTable.startedAt)).all();

  const byProject = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!r.projectId) continue;
      if (!m.has(r.projectId)) m.set(r.projectId, []);
      m.get(r.projectId).push(r);
    }
    return m;
  };

  const tGroups = byProject(transcripts);
  const rGroups = byProject(runRows);

  const children = db.select().from(projectsTable).orderBy(projectsTable.name).all().map((p) => {
    const t = tGroups.get(p.id) || [];
    const r = rGroups.get(p.id) || [];
    // Documents are not yet linked to a project in the schema, so match on the
    // customer name. Honest approximation, and it stops being one when
    // run_files is populated for every run.
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const d = docs.filter((f) => f.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(slug));

    return {
      id: p.id,
      name: p.name,
      kind: 'project',
      counts: { transcripts: t.length, documents: d.length, runs: r.length },
      children: [
        { id: `${p.id}:t`, name: 'Transcripts', kind: 'group',
          children: t.slice(0, 20).map((x) => ({
            id: x.path, name: x.path.split('/').pop(), kind: 'transcript', at: x.addedAt })) },
        { id: `${p.id}:d`, name: 'Documents', kind: 'group',
          children: d.slice(0, 20).map((x) => ({
            id: x.path, name: x.name, kind: 'document', at: x.mtime })) },
        { id: `${p.id}:r`, name: 'Runs', kind: 'group',
          children: r.slice(0, 20).map((x) => ({
            id: x.id, name: x.label || 'Run', kind: 'run', status: x.status, at: x.endedAt })) },
      ].filter((g) => g.children.length > 0),
    };
  });

  return json({
    tree: { id: 'root', name: 'All customers', kind: 'root', children },
    totals: {
      projects: children.length,
      transcripts: transcripts.length,
      documents: docs.length,
      runs: runRows.length,
    },
  });
}
