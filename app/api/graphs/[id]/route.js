export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { getGraph, saveGraph, deleteGraph } from '@/core/graph/store.js';
import { buildGraph } from '@/core/graph/build.js';
import { listProjects } from '@/projects.js';

export async function GET(req, { params }) {
  const { id } = await params;
  const g = getGraph(id);
  if (!g) return json({ error: 'no such graph' }, 404);

  // Built on read, never stored — that is what keeps it current as documents
  // are generated without anything having to invalidate a cache.
  const built = buildGraph(g.policy);
  return json({
    graph: g,
    ...built,
    projects: listProjects().map((p) => ({ id: p.id, name: p.name })),
  });
}

export async function POST(req, { params }) {
  const { id } = await params;
  const g = getGraph(id);
  if (!g) return json({ error: 'no such graph' }, 404);
  try {
    return json({ graph: saveGraph({ ...(await readBody(req)), id }) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req, { params }) {
  const { id } = await params;
  try {
    return json({ deleted: deleteGraph(id) });
  } catch (err) {
    return fail(err);
  }
}
