export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as runs from '@/runs.js';

export async function POST(req, { params }) {
  const { id } = await params;
  return json({ cancelled: runs.cancel(id) });
}
