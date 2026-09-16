export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import * as projects from '@/projects.js';
import * as runs from '@/runs.js';

export async function GET(req, { params }) {
  const { id } = await params;
  const project = projects.getProject(id);
  if (!project) return json({ error: 'no such project' }, 404);
  return json({ project, active: runs.list({ projectId: id, active: true }) });
}

export async function POST(req, { params }) {
  const { id } = await params;
  try {
    return json({ project: projects.updateProject(id, await readBody(req)) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req, { params }) {
  const { id } = await params;
  return json({ deleted: projects.deleteProject(id) });
}
