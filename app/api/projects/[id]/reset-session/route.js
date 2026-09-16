export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as projects from '@/projects.js';

export async function POST(req, { params }) {
  const { id } = await params;
  return json({ project: projects.resetSession(id) });
}
