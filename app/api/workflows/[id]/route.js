export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { getWorkflow, saveWorkflow, deleteWorkflow } from '@/core/workflow/store.js';
import { runWorkflow, resolveScope } from '@/core/workflow/run.js';
import * as runs from '@/runs.js';
import { listProjects } from '@/projects.js';

export async function GET(req, { params }) {
  const { id } = await params;
  const w = getWorkflow(id);
  if (!w) return json({ error: 'no such workflow' }, 404);
  // The customer list ships with the workflow: without it the scope <select>
  // has no option matching the saved projectId and silently displays "All
  // customers" while actually being scoped to one.
  return json({
    workflow: w,
    inScope: resolveScope(w.scope).length,
    projects: listProjects().map((p) => ({ id: p.id, name: p.name })),
  });
}

export async function POST(req, { params }) {
  const { id } = await params;
  const w = getWorkflow(id);
  if (!w) return json({ error: 'no such workflow' }, 404);

  const body = await readBody(req);
  try {
    if (body.action === 'run' || body.action === 'test') {
      const started = await runWorkflow(w, {
        trigger: body.action === 'test' ? 'test' : 'manual',
        dryRun: Boolean(body.dryRun),
      });
      return json(started.runId ? { ...started, run: runs.summarise(runs.get(started.runId)) } : started);
    }
    return json({ workflow: saveWorkflow({ ...body, id }) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req, { params }) {
  const { id } = await params;
  return json({ deleted: deleteWorkflow(id) });
}
