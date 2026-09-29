export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody, extensionCors } from '@/core/http.js';
import { loadConfig } from '@/gong.js';
import { receiveCxpToken } from '@/core/connectors/cxportal-token.js';

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: extensionCors(req) || {} });
}

/** The extension's reachability probe — same shape as /api/cookie's. */
export async function GET(req) {
  return json({ up: true, host: loadConfig().cxHost }, 200, extensionCors(req) || {});
}

export async function POST(req) {
  const cors = extensionCors(req) || {};
  try {
    return json(await receiveCxpToken(await readBody(req)), 200, cors);
  } catch (err) {
    return json({ ok: false, saved: false, fatal: err?.message || String(err) }, 200, cors);
  }
}
