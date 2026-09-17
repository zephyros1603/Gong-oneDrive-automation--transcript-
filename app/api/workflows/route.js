export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listWorkflows, saveWorkflow, ensureBuiltins } from '@/core/workflow/store.js';

export async function GET() {
  ensureBuiltins();
  return json({ workflows: listWorkflows() });
}

export async function POST(req) {
  try {
    return json({ workflow: saveWorkflow(await readBody(req)) });
  } catch (err) {
    return fail(err);
  }
}
