export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { sseResponse, readBody } from '@/core/http.js';
import { pullTranscripts } from '@/core/gong/pull.js';

/** The Pull tab. Streams progress; the pull itself lives in core/gong/pull.js. */
export async function POST(req) {
  const params = await readBody(req);
  return sseResponse(async (stream) => {
    try {
      await pullTranscripts(params, (e) => stream.send(e));
    } catch (err) {
      stream.send({ type: 'error', message: err?.message || String(err) });
    }
    stream.end();
  });
}
