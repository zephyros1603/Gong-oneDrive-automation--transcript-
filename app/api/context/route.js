export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { contextStatus, updateProjectContext } from '@/core/workflow/projectContext.js';

export async function GET() {
  return json({ customers: contextStatus() });
}

/** `{ projectId }` updates one project; `{ all: true }` updates every linked one. */
export async function POST(req) {
  const body = await readBody(req);
  try {
    if (body.all) {
      const linked = contextStatus().filter((c) => c.linked);
      const results = [];
      for (const c of linked) {
        try { results.push({ id: c.id, ...(await updateProjectContext(c.id, { force: Boolean(body.force) })) }); }
        catch (err) { results.push({ id: c.id, error: err.message }); }
      }
      return json({ refreshed: results.length, results, customers: contextStatus() });
    }
    if (!body.projectId) return json({ error: 'projectId required' }, 400);
    const result = await updateProjectContext(body.projectId, { force: Boolean(body.force) });
    return json({ result, customers: contextStatus() });
  } catch (err) {
    return fail(err);
  }
}
