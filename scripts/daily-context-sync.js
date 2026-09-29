// scripts/daily-context-sync.js — the daily pipeline: pull Gong calls,
// organize them by customer, make sure every CX Portal project assigned to
// me already has a Warp project, then refresh each one's shared context.md.
//
// Meant to run once a day on a schedule (Engine → this script → Schedule),
// not by hand. Every step is safe to re-run and cheap when there's nothing
// new:
//   1. warp.gong.pull()     — skips a call already on disk, never re-fetches it
//   2. warp.gong.organize() — idempotent regroup into the per-customer tree
//      updateProjectContext() actually reads (it never looks at raw pull
//      output — see core/workflow/projectContext.js)
//   3. warp.projects.syncFromCxp() — only ever adds a Warp project for a CX
//      Portal project that doesn't have one yet; no Claude call either way
//   4. warp.context.update() per project — hash-gated (see
//      core/workflow/projectContext.js's updateProjectContext()): a
//      customer with nothing new since the last run costs zero Claude calls
//
// STRICT SAFETY NOTE: nothing here posts anywhere customer-visible. Pulling
// Gong calls, organizing files, and rewriting context.md are all
// read/derive-only. The one write-adjacent action in this app — a CX Portal
// note — is a separate script (propose-notes-all-active.js) and this one
// never touches it.

// ============================================================
// CONFIGURATION
// ============================================================

// How many days back to pull each run. >1 on purpose: if the server was
// asleep or down yesterday (see automation.js's own header comment on why
// that happens), this still catches what was missed — an already-downloaded
// call is skipped, never re-fetched, so pulling the same day twice is free.
const PULL_DAYS = 2;

// Gong transcripts from this past Monday through now — a calendar week, not
// a rolling 7 days, so the window a context rewrite looks at lines up with a
// working week rather than creeping a day later every time this runs.
// Matches scripts/update-context.js's own default.
const WINDOW = { preset: 'week', anchor: 'this' };

// Milliseconds to wait between projects in step 4. Each update that isn't a
// cache hit is a real Claude call; a small pause keeps a big sweep from
// bursting them all at once.
const PACE_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// 1. PULL — recent Gong calls
// ============================================================

console.log(`Pulling calls from the last ${PULL_DAYS} day(s)…`);
const pulled = await warp.gong.pull({ mode: 'me', days: PULL_DAYS });
console.log(`Pulled: ${pulled.ok} saved · ${pulled.skipped} already had · ${pulled.failed} failed`);

// ============================================================
// 2. ORGANIZE — group into the per-customer tree context reads from
// ============================================================

const organized = warp.gong.organize({ by: 'customer' });
console.log(`Organized ${organized.done} file(s) into ${organized.groups.length} customer folder(s)`);

// ============================================================
// 3. MATCH — every CX Portal project assigned to me gets a Warp project
// ============================================================

const sync = await warp.projects.syncFromCxp();
console.log(`CX Portal sync: ${sync.created?.length || 0} new project(s) · ${sync.existing?.length || 0} already linked`);

// ============================================================
// 4. UPDATE CONTEXT — every linked project, hash-gated
// ============================================================

const targets = warp.projects.list().filter((p) => p.cxpProjectId);
console.log(`Updating context for ${targets.length} linked project(s)…`);

const updated = [];
const cached = [];
const failed = [];

for (const p of targets) {
  try {
    const r = await warp.context.update(p.id, { window: WINDOW });
    if (r.cached) {
      cached.push(p.name);
      console.log(`  = ${p.name} — nothing new, skipped`);
    } else {
      updated.push(p.name);
      console.log(`  ✓ ${p.name} — rewritten from ${r.rebuiltFrom ?? '?'} gong file(s)`);
    }
  } catch (err) {
    failed.push({ name: p.name, error: err.message });
    console.log(`  ! ${p.name} — ${err.message}`);
  }
  await sleep(PACE_MS);
}

// ============================================================
// SUMMARY
// ============================================================

const summaryLine =
  `${pulled.ok} call(s) pulled, ${sync.created?.length || 0} new project(s), ` +
  `${updated.length} context rewritten, ${cached.length} unchanged, ${failed.length} failed`;
console.log(`Done: ${summaryLine}`);

warp.notify.say('Daily context sync', summaryLine);

return { pulled, organized, sync, targeted: targets.length, updated: updated.length, cached: cached.length, failed };
