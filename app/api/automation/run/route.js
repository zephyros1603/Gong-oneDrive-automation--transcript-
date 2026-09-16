export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { startPipelineRun } from '@/automation.js';
import * as runs from '@/runs.js';

export async function POST(req) {
  const body = await readBody(req);
  const run = startPipelineRun({ trigger: 'manual', daysBack: body.daysBack });
  return json(runs.summarise(run));
}
