/**
 * core/connectors/cxportal-token.js — taking delivery of a CX Portal token.
 *
 * The Chrome extension pushes the browser's CX Portal Cognito tokens here,
 * read out of the portal page's own localStorage (`accessToken` /
 * `refreshToken` — see core/connectors/registry.js's credentialSchema hints,
 * which document those as the exact keys). Same shape as
 * core/gong/cookie.js's receiveCookie() for the Gong session cookie: nothing
 * is written until it has been proved to work, so a stale or wrong token can
 * never replace one that still works.
 *
 * "Proved to work" is the registry's own cxportal.test() — the same check
 * the Credentials tab's Test button already runs, reused rather than
 * reimplemented, so this and a human pasting a token by hand get identical
 * validation (including the classic idToken-instead-of-accessToken mixup).
 */

import { saveEnv } from '../env.js';
import { getConnector } from './registry.js';

// Bumped whenever the token changes on disk, so an open UI can notice the
// extension delivered a fresh one and refill itself — mirrors
// core/gong/cookie.js's cookieVersion().
let version = Date.now();
export const cxpTokenVersion = () => version;

export async function receiveCxpToken(body) {
  const token = String(body.token || '').trim();
  if (!token) return { ok: false, fatal: 'no token in the request' };

  const refreshToken = String(body.refreshToken || '').trim();

  const cxportal = getConnector('cxportal');
  const result = await cxportal.test({
    CXPORTAL_TOKEN: token,
    CXPORTAL_REFRESH_TOKEN: refreshToken,
  });

  if (!result.ok) return { ...result, saved: false };

  const patch = { CXPORTAL_TOKEN: token };
  // A missing refresh token is not itself a reason to overwrite a good one
  // already on file — the extension may simply have been pointed at a
  // moment where the portal hadn't (re)written it to localStorage yet.
  if (refreshToken) patch.CXPORTAL_REFRESH_TOKEN = refreshToken;

  saveEnv(patch);
  version = Date.now();

  const tokenCheck = result.checks?.find((c) => c.step === 'token');
  console.log(
    `  ✓ CX Portal token received from ${body.source || 'extension'} — ${tokenCheck?.detail || 'ok'}` +
    (refreshToken ? ', refresh token included' : ', no refresh token')
  );
  return { ...result, saved: true };
}
