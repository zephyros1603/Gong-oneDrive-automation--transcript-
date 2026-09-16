export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as runs from '@/runs.js';

export async function GET(req, { params }) {
  const { id } = await params;
  const run = runs.get(id);
  if (!run) return json({ error: 'no such run' }, 404);
  return json(runs.summarise(run));
}
