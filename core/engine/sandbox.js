/**
 * core/engine/sandbox.js — running someone's script without trusting it.
 *
 * Node's `vm` module is not a hard security boundary — a determined script
 * can still find ways out of a `vm` context, and this is not a defence
 * against a malicious author. What it does buy: an *accidental* mistake
 * (`require('fs')`, `process.exit()`, reading `process.env` for a credential)
 * fails immediately and loudly instead of silently working, because none of
 * those names exist in the context at all. That is the right bar for a
 * single-operator server where the scripts are the operator's own — not for
 * running anyone else's code.
 *
 * The curated API (core/engine/api.js) is the actual boundary. A script can
 * only do what that object lets it do, and that object is built fresh, with
 * nothing captured from outside it, for every run.
 */

import vm from 'node:vm';
import { buildApi } from './api.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param code     the body of an async function — `return` is valid, `await`
 *                  is valid, nothing else about it is checked
 * @param onEvent   {type:'call'|'log'|'error', ...} as the script runs
 * @returns {Promise<{ok, result?, error?}>}
 */
export async function runScript(code, { onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const api = buildApi({ onEvent });

  // A fresh, minimal context. No `require`, no `process`, no `fs`, no real
  // `globalThis` — only what is explicitly handed in below. `console` is
  // wired to the same event stream a script's own `log()` uses, since a
  // script author reaching for `console.log` out of habit should not be
  // met with silence.
  const sandboxConsole = {
    log: (...a) => onEvent({ type: 'log', message: a.map(String).join(' ') }),
    error: (...a) => onEvent({ type: 'log', message: `[error] ${a.map(String).join(' ')}` }),
    warn: (...a) => onEvent({ type: 'log', message: `[warn] ${a.map(String).join(' ')}` }),
  };

  const context = vm.createContext({
    warp: api,
    console: sandboxConsole,
    // Timers are genuinely useful (rate-limiting a loop over customers) and
    // carry no capability a script does not already have through `warp`.
    setTimeout, clearTimeout,
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Map, Set,
  });

  let script;
  try {
    // Wrapped as an async IIFE so `await` and a bare `return` both work in
    // what the author writes, without them needing to know it is wrapped.
    script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'script.js' });
  } catch (err) {
    return { ok: false, error: `syntax error: ${err.message}` };
  }

  try {
    // Two different timeouts for two different failure modes. `vm`'s own
    // `timeout` uses V8's interrupt mechanism and is the only thing that can
    // stop a synchronous infinite loop (`while (true) {}`) — without it,
    // that loop blocks the entire Node process, not just the sandbox, since
    // everything here is single-threaded. `runWithTimeout` below covers the
    // other failure mode instead: an async script that never resolves
    // (an await on something that hangs), which the synchronous `vm` timeout
    // cannot see because control has already returned to the event loop.
    const promise = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: true });
    const result = await runWithTimeout(promise, timeoutMs);
    return { ok: true, result };
  } catch (err) {
    onEvent({ type: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
}

function runWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`script exceeded ${ms}ms and was abandoned`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
