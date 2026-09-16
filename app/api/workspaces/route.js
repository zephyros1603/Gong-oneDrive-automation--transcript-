export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { loadConfig, Gong } from '@/gong.js';

export async function POST(req) {
  const body = await readBody(req);
  try {
    const cfg = loadConfig(body.GONG_COOKIE ? { GONG_COOKIE: body.GONG_COOKIE } : {});
    const gong = new Gong(cfg);
    const res = await fetch(`${cfg.base}/ajax/common/rtkn`, {
      headers: { cookie: cfg.cookie, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching the CSRF token`);
    gong.csrf = (await res.json()).token;
    return json({ workspaces: await gong.workspaces() });
  } catch (err) {
    return fail(err);
  }
}
