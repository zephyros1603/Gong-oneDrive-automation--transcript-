export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { usageSummary } from '@/settings.js';

export async function GET() {
  return json(usageSummary());
}
