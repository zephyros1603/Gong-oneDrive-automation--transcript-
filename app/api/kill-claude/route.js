export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { scanClaudeProcesses, killClaudePids, cancelAll } from '@/claude-runner.js';

export async function POST(req) {
  const body = await readBody(req);

  // Specific pids — one row's Stop button on the Cron Jobs page. Scoped to
  // exactly what was asked for, no blanket cancelAll() side effect the way
  // the bulk path below has; a single 'app'-kind process is better stopped
  // through POST /api/cancel {id} instead, which is the proper per-job
  // cancel (usage recorded, reply finalised) — this raw path stays for
  // 'terminal'/'ide' processes the app never tracked in the first place.
  if (Array.isArray(body.pids) && body.pids.length) {
    return json({ cancelled: 0, killed: killClaudePids(body.pids), kinds: null });
  }

  const kinds = Array.isArray(body.kinds) && body.kinds.length
    ? body.kinds
    : ['app', 'terminal', 'ide'];

  // Runs this server started are cancelled properly first, so their usage is
  // recorded and their chat reply is finalised rather than left pending.
  const cancelled = kinds.includes('app') ? cancelAll() : 0;

  const pids = scanClaudeProcesses()
    .filter((p) => kinds.includes(p.kind))
    .map((p) => p.pid);

  return json({ cancelled, killed: killClaudePids(pids), kinds });
}
