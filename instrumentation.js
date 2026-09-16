/**
 * instrumentation.js — the entry point Next calls once per server process.
 *
 * Deliberately almost empty. Next compiles this file for *every* runtime it
 * targets, edge included, and the edge runtime has no `fs` — so the moment
 * anything here reaches better-sqlite3 or child_process, the build fails with
 * "Module not found: Can't resolve 'fs'".
 *
 * The positive `=== 'nodejs'` test is what makes that safe, and it has to be
 * this shape. Webpack inlines NEXT_RUNTIME per compilation, so in the edge
 * pass this becomes `'edge' === 'nodejs'` and the whole branch — including the
 * import inside it — is eliminated before resolution. An early
 * `if (… !== 'nodejs') return;` reads identically but does not work: the
 * import is then a sibling statement, not inside an eliminable branch, and
 * webpack still resolves it.
 *
 * Everything real lives in instrumentation.node.js.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node.js');
  }
}
