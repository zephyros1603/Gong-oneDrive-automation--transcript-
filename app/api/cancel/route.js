export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { cancelJob, cancelAll } from '@/claude-runner.js';

export async function POST(req) {
  const body = await readBody(req);
  if (body.id) return json({ cancelled: cancelJob(body.id) ? 1 : 0 });
  return json({ cancelled: cancelAll() });
}
