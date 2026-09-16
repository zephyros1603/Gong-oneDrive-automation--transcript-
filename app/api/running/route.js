export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { listJobs } from '@/claude-runner.js';
import { usageSummary } from '@/settings.js';

export async function GET() {
  return json({ jobs: listJobs(), usage: usageSummary() });
}
