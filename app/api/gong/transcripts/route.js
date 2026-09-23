export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as library from '@/library.js';

/**
 * My transcripts, as already pulled and on disk — the read side of the Gong
 * connector. `warp.gong.transcripts()` on the script engine wraps the exact
 * same call; this route is the same capability for anything that isn't a
 * script. For pulling *new* transcripts with the connector's full
 * configuration (mode, date range, format), see `POST /api/run` — it
 * already accepts everything `core/gong/pull.js`'s `pullTranscripts()`
 * supports, which is why this route doesn't duplicate that surface.
 */
export async function GET() {
  const files = library.listFiles()
    .filter((f) => f.kind === 'input')
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => ({ path: f.path, name: f.name, mtime: f.mtime, group: f.group, root: f.root }));

  return json({ transcripts: files });
}
