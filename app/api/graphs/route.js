export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listGraphs, saveGraph, ensureDefaultGraph } from '@/core/graph/store.js';

export async function GET() {
  ensureDefaultGraph();
  return json({ graphs: listGraphs() });
}

export async function POST(req) {
  try {
    return json({ graph: saveGraph(await readBody(req)) });
  } catch (err) {
    return fail(err);
  }
}
