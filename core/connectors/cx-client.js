/**
 * core/connectors/cx-client.js — one configured CX Portal client.
 *
 * Every call site needs the same three things: config from gong.env, the
 * refresh token if there is one, and somewhere to persist a token that gets
 * renewed mid-flight. Doing that in one place is what stops a refreshed token
 * being minted and then thrown away by whichever module happened to trigger it.
 */

import { loadConfig } from '../../gong.js';
import { saveEnv } from '../env.js';
import { CxPortal } from './cxportal.js';

export function cxClient(overrides = {}) {
  const cfg = loadConfig();
  return new CxPortal({
    host: overrides.host || cfg.cxHost,
    token: overrides.token ?? cfg.cxToken,
    refreshToken: overrides.refreshToken ?? cfg.cxRefreshToken,
    onToken: ({ accessToken, refreshToken }) => {
      // Persist immediately. A renewed token that lives only in memory means
      // the next process refreshes again, and Cognito rate-limits that.
      //
      // The refresh token is written back only when the pool actually rotated
      // it. Writing the old value back every time would be harmless but would
      // also make a real rotation indistinguishable from a no-op in the file's
      // history, which is the one thing worth being able to see here.
      const patch = { CXPORTAL_TOKEN: accessToken };
      if (refreshToken) patch.CXPORTAL_REFRESH_TOKEN = refreshToken;
      try { saveEnv(patch); } catch { /* read-only disk */ }
    },
  });
}
