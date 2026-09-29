export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listApprovals, decide, decideMany, counts } from '@/core/approvals/store.js';

// `kind=files` -> document/email (the Approvals page); `kind=cxp_note` ->
// just notes (the Approvals/Notes page). Omitted -> every kind, unchanged
// from before there were two pages.
const KIND_GROUPS = { files: ['document', 'email'], cxp_note: ['cxp_note'] };

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const status = params.get('status') || 'pending';
  const kinds = KIND_GROUPS[params.get('kind')];
  return json({ approvals: listApprovals({ status, kinds }), counts: counts({ kinds }) });
}

export async function POST(req) {
  const body = await readBody(req);
  try {
    if (Array.isArray(body.ids)) {
      return json({ decided: await decideMany(body.ids, body.status, body.note), counts: counts() });
    }
    return json({ approval: await decide(body.id, body.status, body.note), counts: counts() });
  } catch (err) {
    return fail(err);
  }
}
