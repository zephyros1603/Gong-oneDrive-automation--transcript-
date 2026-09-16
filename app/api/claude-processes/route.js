export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { scanClaudeProcesses } from '@/claude-runner.js';

export async function GET() {
  return json(scanClaudeProcesses());
}
