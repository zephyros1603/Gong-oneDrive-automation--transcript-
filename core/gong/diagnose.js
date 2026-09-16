/**
 * core/gong/diagnose.js — what is wrong with this session, and why.
 *
 * Two jobs: read what the cookie says about itself, and probe the API in the
 * order things actually fail. Kept apart from the HTTP layer so the same
 * checks can run from a route, a CLI or a scheduled health check.
 */

import { Gong, loadConfig, filterMe } from '../../gong.js';

const jsonOrNull = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** "a=1; b=2" -> Map. Values may themselves contain "=" (JWTs, base64). */
export function cookieMap(raw) {
  const m = new Map();
  for (const part of String(raw).split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    m.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return m;
}

export function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
  } catch {
    return null;
  }
}

/**
 * The cookie is self-describing if you read it: `cell` and `last-login` are
 * JWTs carrying the account email (`gu`) and an expiry (`exp`), and
 * cf_clearance embeds its issue time as the second dash-separated field. So
 * a fair amount can be reported before making a single request.
 */
export function inspectCookie(raw) {
  const jar = cookieMap(raw);

  // Determined by dropping cookies one at a time against the live API:
  // `last-login` alone authenticates AND searches successfully. `g-session`,
  // `cf_clearance`, `cell`, `__cf_bm` and `AWSALB` are all individually
  // droppable, and cf_clearance is frequently absent entirely because
  // Cloudflare only issues it after a challenge. So `last-login` is the only
  // cookie worth blocking on; everything else is sent because a browser
  // would send it, not because it is known to be needed.
  const critical = ['last-login'];
  const helpful = ['g-session', 'cell', 'cf_clearance', '__cf_bm', 'AWSALB', 'ajs_user_id'];

  const cell = jwtPayload(jar.get('cell'));
  const lastLogin = jwtPayload(jar.get('last-login'));

  let cfIssued = null;
  const cf = jar.get('cf_clearance');
  if (cf) {
    const ts = Number(String(cf).split('-')[1]);
    if (Number.isFinite(ts) && ts > 1e9) cfIssued = ts * 1000;
  }

  return {
    count: jar.size,
    bytes: String(raw).length,
    missing: critical.filter((k) => !jar.has(k)),
    absentHelpful: helpful.filter((k) => !jar.has(k)),
    email: cell?.gu || lastLogin?.gu || null,
    cellExpires: cell?.exp ? cell.exp * 1000 : null,
    loginExpires: lastLogin?.exp ? lastLogin.exp * 1000 : null,
    identityProvider: lastLogin?.gp || null,
    cfIssued,
    cellRegion: cell?.cell || null,
  };
}

/**
 * Probe the session in the order things actually fail: cookie shape, then
 * auth, then workspace listing, then an actual filtered search. A cookie can
 * authenticate and still be unable to search, so the last step is the one
 * that proves the app will work.
 */
export async function testConnection(body = {}) {
  const overrides = {};
  if (body.GONG_COOKIE) overrides.GONG_COOKIE = body.GONG_COOKIE;
  if (body.GONG_HOST) overrides.GONG_HOST = body.GONG_HOST;
  if (body.GONG_WORKSPACE_ID) overrides.GONG_WORKSPACE_ID = body.GONG_WORKSPACE_ID;

  const cfg = loadConfig(overrides);
  const cookie = inspectCookie(cfg.cookie);
  const checks = [];
  const result = { host: cfg.host, cookie, checks, ok: false };

  if (cookie.missing.length) {
    checks.push({
      step: 'cookie', ok: false,
      detail: `missing ${cookie.missing.join(', ')} — the session cookie is not present, sign in to Gong first`,
    });
    return result;
  }
  checks.push({ step: 'cookie', ok: true, detail: `${cookie.count} cookies, all critical ones present` });

  const gong = new Gong(cfg);

  // 1. auth
  const started = Date.now();
  let rtkn;
  try {
    rtkn = await fetch(`${cfg.base}/ajax/common/rtkn`, {
      headers: { cookie: cfg.cookie, accept: 'application/json' },
    });
  } catch (err) {
    checks.push({ step: 'auth', ok: false, detail: `cannot reach ${cfg.host}: ${err.message}` });
    return result;
  }
  if (!rtkn.ok) {
    // A wrong tenant host answers 401 too, so name both causes rather than
    // sending someone off to re-copy a cookie that was fine.
    const why = rtkn.status === 401 || rtkn.status === 403
      ? `the cookie has expired, or ${cfg.host} is not your tenant`
      : 'unexpected response';
    checks.push({ step: 'auth', ok: false, detail: `HTTP ${rtkn.status} — ${why}` });
    return result;
  }

  const token = jsonOrNull(await rtkn.text())?.token;
  if (!token) {
    checks.push({ step: 'auth', ok: false, detail: 'no CSRF token returned' });
    return result;
  }
  gong.csrf = token;
  const jwt = jwtPayload(token);
  gong.userId = cfg.userId || (jwt?.userId != null ? String(jwt.userId) : null);
  result.userId = gong.userId;
  result.csrfExpires = jwt?.exp ? jwt.exp * 1000 : null;
  checks.push({
    step: 'auth', ok: true,
    detail: `authenticated as ${cookie.email || gong.userId} in ${Date.now() - started} ms`,
  });

  // 2. workspaces
  try {
    result.workspaces = await gong.workspaces();
    gong.workspaceId = cfg.workspaceId || result.workspaces[0]?.id;
    checks.push({
      step: 'workspaces', ok: true,
      detail: result.workspaces.map((w) => w.name).join(', ') || 'none visible',
    });
  } catch (err) {
    checks.push({ step: 'workspaces', ok: false, detail: err.message });
    return result;
  }

  // 3. the search that the app actually depends on
  try {
    const page = await gong.post(
      `/conversations/ajax/results?workspace-id=${gong.workspaceId}`,
      {
        callsSearchJson: JSON.stringify({
          search: { type: 'And', filters: [filterMe(gong.userId)] },
          sort: null,
        }),
        pageSize: 1,
        callsOffset: 0,
      }
    );
    result.myCalls = page.numOfTotalItemsThatPassedFilter ?? 0;
    checks.push({
      step: 'search', ok: true,
      detail: `${result.myCalls} call${result.myCalls === 1 ? '' : 's'} visible to you`,
    });
  } catch (err) {
    checks.push({
      step: 'search', ok: false,
      detail: `${err.message} — auth works but search does not; try another workspace`,
    });
    return result;
  }

  result.ok = true;
  return result;
}
