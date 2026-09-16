export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { testConnection } from '@/core/gong/diagnose.js';

export async function POST(req) {
  return json(await testConnection(await readBody(req)));
}
