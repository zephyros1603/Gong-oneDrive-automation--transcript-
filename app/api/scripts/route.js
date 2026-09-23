export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listScripts, saveScript } from '@/core/engine/store.js';

export async function GET() {
  return json({ scripts: listScripts() });
}

export async function POST(req) {
  const body = await readBody(req);
  try {
    return json({ script: saveScript(body) });
  } catch (err) {
    return fail(err);
  }
}
