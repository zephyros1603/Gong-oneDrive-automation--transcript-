/**
 * core/gong/cookie.js — taking delivery of a session cookie.
 *
 * The Chrome extension pushes the browser's Gong cookies here. Nothing is
 * written until it has been proved to work, so a stale or partial jar can
 * never replace a cookie that was still good.
 */

import { loadConfig } from '../../gong.js';
import { saveEnv } from '../env.js';
import { testConnection } from './diagnose.js';

// Bumped whenever the cookie changes on disk, so an open UI can notice that
// the extension delivered a fresh one and refill itself.
let version = Date.now();

/** Last time the stored cookie changed. Polled by /api/pulse. */
export const cookieVersion = () => version;

export async function receiveCookie(body) {
  const cookie = String(body.cookie || '').trim();
  if (!cookie) return { ok: false, fatal: 'no cookie in the request' };

  const host = String(body.host || '').trim() || loadConfig().host;
  const test = await testConnection({ GONG_COOKIE: cookie, GONG_HOST: host });

  if (!test.ok) return { ...test, saved: false };

  saveEnv({ GONG_COOKIE: cookie, GONG_HOST: host });
  version = Date.now();

  console.log(
    `  ✓ cookie received from ${body.source || 'extension'} — ` +
    `${test.cookie.email || test.userId}, ${test.myCalls} calls, ` +
    `expires ${new Date(test.cookie.cellExpires).toLocaleString()}`
  );
  return { ...test, saved: true };
}
