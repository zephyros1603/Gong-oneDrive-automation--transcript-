export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { proposeNote } from '@/core/connectors/cxportal-note.js';

/**
 * Propose a note for the CX Portal Activity Timeline — never posts. Creates
 * a pending `kind:'cxp_note'` approval; the real write only happens from
 * `core/approvals/store.js`'s `decide()`, on a human's approve click in the
 * Approvals page. This route used to post directly; it doesn't any more —
 * every CX Portal write goes through the approval queue now, no exceptions.
 *
 * `cxpProjectId` (+ `projectName`), when given, skips the fuzzy
 * customer-name search — the Approvals compose form sends this whenever the
 * customer picked is an already-linked Warp project, so picking one from
 * the list can't fail the way typing a name that doesn't exactly match CX
 * Portal's spelling can. `customerName` alone still works as the fallback
 * for anything not yet a Warp project.
 */
export async function POST(req) {
  const body = await readBody(req);
  const { customerName, cxpProjectId, projectName, text, shareToSlack } = body;

  if (!customerName && !cxpProjectId) return json({ error: 'customerName is required' }, 400);
  if (!text?.trim()) return json({ error: 'text is required' }, 400);

  try {
    const approval = await proposeNote({
      customerName, cxpProjectId, projectName, text, shareToSlack: Boolean(shareToSlack),
    });
    return json({ approval });
  } catch (err) {
    return fail(err);
  }
}
