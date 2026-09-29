// scripts/daily-context-sync-yesterday.js — same daily pipeline as
// daily-context-sync.js, but every step is scoped to YESTERDAY (the last
// complete calendar day) instead of "this week so far":
//   1. warp.gong.pull()     — pulls enough days back to fully cover yesterday
//   2. warp.gong.organize() — unchanged, idempotent regroup
//   3. warp.projects.syncFromCxp() — unchanged
//   4. warp.context.update() per project — window = yesterday only
//
// "Yesterday" comes from warp.window.resolve({ preset: 'day', anchor: 'previous' }).
// anchor 'previous' means the last *complete* day, so a 09:00 run on the
// 29th covers 00:00 on the 28th up to 00:00 on the 29th (`to` is exclusive).
// This uses the same resolver every scheduled workflow uses, so the dates
// match what the rest of Warp calls "yesterday".
//
// STRICT SAFETY NOTE: unchanged — nothing here posts anywhere
// customer-visible. Pull, organize and context rewrite are read/derive-only.

// ============================================================
// CONFIGURATION
// ============================================================

// On a Monday, "yesterday" is Sunday, which usually has no calls. With this
// on, a Monday run covers Friday 00:00 → Monday 00:00 instead, so Friday's
// calls aren't skipped. Set to false for strict "calendar yesterday".
const MONDAY_COVERS_WEEKEND = true;

// Resolve yesterday's window once, so every step uses the same dates
const yesterday = warp.window.resolve({ preset: 'day', anchor: 'previous' });
const DAY_MS = 86400e3;
const isMonday = new Date().getDay() === 1;

// warp.window.resolve({from, to}) treats an explicit range as calendar days
// and always adds one more day to `to` to make it exclusive — right for a
// raw date, but yesterday.to is already an exact, already-exclusive
// boundary (today's midnight). Passing it straight through as `to` (an
// earlier version of this file did exactly that) silently pushed the
// window one extra day forward: a Monday run resolved to Fri 00:00 →
// Tue 00:00, not Fri 00:00 → Mon 00:00 as the comment here always claimed,
// quietly pulling Monday's still-in-progress calls into "yesterday" —
// confirmed by simulation, not just by reading. `to: yesterday.to - DAY_MS`
// is a point inside Sunday instead of Monday's boundary itself, so
// resolveWindow's own "day, then +1 to make it exclusive" rule lands back
// on the correct Monday-midnight boundary. This has to be the fix (rather
// than building the final range by hand and skipping resolveWindow) because
// `warp.context.update({ window: WINDOW })` below re-resolves whatever
// spec it's given the exact same way — WINDOW has to already be correct
// under that same transform, not just under this file's own reading of it.
const WINDOW = MONDAY_COVERS_WEEKEND && isMonday
  ? { from: yesterday.from - 2 * DAY_MS, to: yesterday.to - DAY_MS }   // Fri 00:00 → Mon 00:00
  : { preset: 'day', anchor: 'previous' };                            // yesterday 00:00 → today 00:00

const resolved = warp.window.resolve(WINDOW);

// days back for the pull: from the window start to now, rounded up.
// Normally 2 (yesterday + today so far); 4 on a Monday with the weekend option.
// pull() skips a call already on disk, so the overlap with today costs nothing.
const PULL_DAYS = Math.max(1, Math.ceil((Date.now() - resolved.from) / DAY_MS));

// Pause between projects in step 4 (each non-cached update is a Claude call)
const PACE_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

console.log(`Window: ${resolved.label || 'yesterday'} — ${fmt(resolved.from)} → ${fmt(resolved.to)} (to exclusive)`);

// ============================================================
// 1. PULL — calls covering the window
// ============================================================

console.log(`Pulling calls from the last ${PULL_DAYS} day(s) to cover the window…`);
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
// 4. UPDATE CONTEXT — every linked project, yesterday's window, hash-gated
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
  `[${fmt(resolved.from).slice(0, 10)}${isMonday && MONDAY_COVERS_WEEKEND ? ' → weekend' : ''}] ` +
  `${pulled.ok} call(s) pulled, ${sync.created?.length || 0} new project(s), ` +
  `${updated.length} context rewritten, ${cached.length} unchanged, ${failed.length} failed`;
console.log(`Done: ${summaryLine}`);

warp.notify.say('Daily context sync (yesterday)', summaryLine);

return {
  window: { from: resolved.from, to: resolved.to, label: resolved.label },
  pullDays: PULL_DAYS,
  pulled, organized, sync,
  targeted: targets.length,
  updated: updated.length,
  cached: cached.length,
  failed,
};