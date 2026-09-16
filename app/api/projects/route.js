export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import * as projects from '@/projects.js';
import * as runs from '@/runs.js';

export async function GET() {
  return json({
    projects: projects.listProjects(),
    active: runs.list({ active: true }),
  });
}

export async function POST(req) {
  const body = await readBody(req);
  try {
    if (body.sync) return json(projects.syncFromLibrary());
    return json({ project: projects.createProject(body) });
  } catch (err) {
    return fail(err);
  }
}
