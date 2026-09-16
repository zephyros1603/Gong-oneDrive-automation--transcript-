export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { writeAutomation, schedulerState } from '@/automation.js';
import * as runs from '@/runs.js';

const withRuns = () => ({
  ...schedulerState(),
  active: runs.list({ active: true }).filter((r) => r.kind === 'automation'),
  recent: runs.list({}).filter((r) => r.kind === 'automation').slice(0, 5),
});

export async function GET() {
  return json(withRuns());
}

export async function POST(req) {
  const body = await readBody(req);
  const patch = {};
  for (const k of [
    'enabled', 'time', 'days', 'daysBack', 'organize',
    'organizeBy', 'organizeMode', 'graceMinutes',
  ]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  writeAutomation(patch);
  return json(withRuns());
}
