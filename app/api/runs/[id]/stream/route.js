export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, sseResponse } from '@/core/http.js';
import * as runs from '@/runs.js';

/**
 * Attach to a run. Recorded events replay first, then live ones follow.
 *
 * Detaching must NOT cancel: switching tabs is not a reason to throw away
 * work that is already being paid for. The unsubscribe below is the only
 * thing a disconnect does.
 */
export async function GET(req, { params }) {
  const { id } = await params;
  const run = runs.get(id);
  if (!run) return json({ error: 'no such run' }, 404);

  return sseResponse((stream) => {
    const off = runs.subscribe(id, (e) => {
      stream.send(e);
      if (e.type === 'finished') {
        stream.send({ type: 'closed-buffer', status: e.status });
        off?.();
        stream.end();
      }
    });

    if (runs.get(id)?.status !== 'running') {
      off?.();
      return stream.end();
    }
    stream.onCancel(() => off?.());
  });
}
