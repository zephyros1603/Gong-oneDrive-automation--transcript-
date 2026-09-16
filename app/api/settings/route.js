export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { readSettings, writeSettings } from '@/settings.js';

export async function GET() {
  return json(readSettings());
}

export async function POST(req) {
  return json(writeSettings(await readBody(req)));
}
