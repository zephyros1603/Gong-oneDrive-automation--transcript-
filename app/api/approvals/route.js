export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listApprovals, decide, decideMany, counts } from '@/core/approvals/store.js';

export async function GET(req) {
  const status = new URL(req.url).searchParams.get('status') || 'pending';
  return json({ approvals: listApprovals({ status }), counts: counts() });
}

export async function POST(req) {
  const body = await readBody(req);
  try {
    if (Array.isArray(body.ids)) {
      return json({ decided: decideMany(body.ids, body.status, body.note), counts: counts() });
    }
    return json({ approval: decide(body.id, body.status, body.note), counts: counts() });
  } catch (err) {
    return fail(err);
  }
}
