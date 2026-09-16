export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { envDefaults } from '@/core/env.js';

export async function GET() {
  return json(envDefaults());
}
