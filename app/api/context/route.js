export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { digestStatus, refreshDigest } from '@/core/workflow/digest.js';

export async function GET() {
  return json({ customers: digestStatus() });
}

/** `{ projectId }` refreshes one customer; `{ all: true }` refreshes every stale one. */
export async function POST(req) {
  const body = await readBody(req);
  try {
    if (body.all) {
      const stale = digestStatus().filter((c) => !c.fresh && c.inputs > 0);
      const results = [];
      for (const c of stale) {
        try { results.push({ id: c.id, ...(await refreshDigest(c.id)) }); }
        catch (err) { results.push({ id: c.id, error: err.message }); }
      }
      return json({ refreshed: results.length, results, customers: digestStatus() });
    }
    if (!body.projectId) return json({ error: 'projectId required' }, 400);
    const result = await refreshDigest(body.projectId, { force: Boolean(body.force) });
    return json({ result, customers: digestStatus() });
  } catch (err) {
    return fail(err);
  }
}
