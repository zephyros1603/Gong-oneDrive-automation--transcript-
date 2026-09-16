export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { scanClaudeProcesses, killClaudePids, cancelAll } from '@/claude-runner.js';

export async function POST(req) {
  const body = await readBody(req);
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
