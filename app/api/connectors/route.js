export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { listConnectors } from '@/core/connectors/registry.js';

export async function GET() {
  return json({ connectors: await listConnectors() });
}
