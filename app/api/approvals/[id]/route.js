export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { updateNoteText } from '@/core/approvals/store.js';

/**
 * Edit a still-pending CX Portal note's text. Never decides anything, never
 * touches CX Portal — approving/rejecting stays on the collection route
 * (POST /api/approvals), same as always. This exists so a note can be
 * fixed up before it's posted, not after.
 */
export async function POST(req, { params }) {
  const { id } = await params;
  const { text } = await readBody(req);
  try {
    return json({ approval: updateNoteText(id, text) });
  } catch (err) {
    return fail(err);
  }
}
