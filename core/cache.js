/**
 * core/cache.js — short-lived memoisation for things that are expensive and
 * asked for far more often than they change.
 *
 * Measured before writing any of this:
 *
 *   scanClaudeProcesses()  41.8 ms   — execSync('/bin/ps'), BLOCKS the event loop
 *   library.listFiles()     3.4 ms   — walks the whole transcript tree
 *   library.version()       2.0 ms   — walks it again
 *
 * The first one is the problem. `execSync` on the single thread that serves
 * every request means a 42ms stall for everybody, and three separate pollers
 * (Workbench every 8s, the dashboard every 15s, the shell every 3s) each
 * triggered their own. A one-second TTL collapses them into one spawn without
 * making the UI feel stale.
 *
 * Deliberately not an LRU or a real cache library: these are a handful of
 * fixed keys with sub-second lifetimes.
 */

const store = (globalThis.__warp_cache ??= new Map());

/**
 * Run `fn` at most once per `ttl` milliseconds for a given key.
 *
 * In-flight de-duplication matters as much as the TTL: three pollers landing
 * in the same tick would otherwise each start their own `ps`.
 */
export function memo(key, ttl, fn) {
  const hit = store.get(key);
  const now = Date.now();

  if (hit && now - hit.at < ttl) return hit.value;

  const value = fn();
  store.set(key, { at: now, value });
  return value;
}

/** Same, for promises — keeps the pending promise so callers share one call. */
export async function memoAsync(key, ttl, fn) {
  const hit = store.get(key);
  const now = Date.now();

  if (hit && now - hit.at < ttl) return hit.value;
  if (hit?.pending) return hit.pending;

  const pending = Promise.resolve().then(fn);
  store.set(key, { at: now, pending, value: hit?.value });

  try {
    const value = await pending;
    store.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    store.delete(key);
    throw err;
  }
}

/** Drop a key, or everything. Called after anything that writes files. */
export function invalidate(prefix) {
  if (!prefix) { store.clear(); return; }
  for (const k of store.keys()) {
    if (k === prefix || k.startsWith(`${prefix}:`)) store.delete(k);
  }
}
