export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listSyncs, getSyncType, saveWorkflow, ensureBuiltins } from '@/core/workflow/store.js';
import { listProjects } from '@/projects.js';

export async function GET() {
  ensureBuiltins();
  return json({ syncs: listSyncs(), projects: listProjects().map((p) => ({ id: p.id, name: p.name })) });
}

/** Create an automation under a sync type — one per customer. */
export async function POST(req) {
  const body = await readBody(req);
  const type = getSyncType(body.typeId);
  if (!type) return json({ error: 'no such sync type' }, 404);
  if (!type.available) return json({ error: `${type.name} is not available yet` }, 400);

  try {
    const workflow = saveWorkflow({
      name: body.name || `${type.name} automation`,
      description: body.description || '',
      source: type.source,
      destination: type.destination,
      skill: body.skill || null,
      instruction: body.instruction || '',
      scope: body.scope || { projectId: null, sources: ['transcript'], window: 'last7d' },
      pull: body.pull || { enabled: true, days: 2, organize: true, organizeBy: 'customer' },
      outputs: body.outputs || { formats: ['docx'] },
    });
    return json({ workflow });
  } catch (err) {
    return fail(err);
  }
}
