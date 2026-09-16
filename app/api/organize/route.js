export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { organize } from '@/organize.js';

export async function POST(req) {
  const body = await readBody(req);
  try {
    return json(organize({
      by: body.by,
      src: body.src || undefined,
      out: body.out || undefined,
      mode: body.mode,
      dryRun: Boolean(body.dryRun),
    }));
  } catch (err) {
    return fail(err);
  }
}
