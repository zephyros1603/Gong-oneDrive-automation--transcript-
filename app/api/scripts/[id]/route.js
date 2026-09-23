export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import * as runs from '@/runs.js';
import { getScript, saveScript, deleteScript, runStoredScript } from '@/core/engine/store.js';

export async function GET(req, { params }) {
  const { id } = await params;
  const script = getScript(id);
  if (!script) return json({ error: 'no such script' }, 404);
  return json({ script });
}

export async function POST(req, { params }) {
  const { id } = await params;
  if (!getScript(id)) return json({ error: 'no such script' }, 404);

  const body = await readBody(req);
  try {
    if (body.action === 'run') {
      const started = runStoredScript(id, { trigger: 'manual' });
      return json({ ...started, run: runs.summarise(runs.get(started.runId)) });
    }
    return json({ script: saveScript({ ...body, id }) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req, { params }) {
  const { id } = await params;
  return json({ deleted: deleteScript(id) });
}
