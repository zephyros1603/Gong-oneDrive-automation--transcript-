export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { saveEnv } from '@/core/env.js';

export async function POST(req) {
  try {
    return json(saveEnv(await readBody(req)));
  } catch (err) {
    return fail(err);
  }
}
