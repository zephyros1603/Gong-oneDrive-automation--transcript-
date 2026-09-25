// scripts/wsr-weekly-prep.js — data prep for the weekly-status-report skill,
// across every active customer. Does NOT produce a .docx.
//
// Why this doesn't just build the WSR end to end: skills/weekly-status-report
// produces its fixed navy-title-block .docx by running scripts/build_wsr.js
// with real filesystem access — that only happens inside a real Claude Code
// CLI turn. warp.claude.run(), the only way an Engine script can invoke
// Claude, hardcodes silent:true (core/engine/api.js) with no override. A
// silent run forces wantsDocument:false, which — per claude-runner.js's own
// comment — exists specifically to make the model answer inline instead of
// writing a file, and it also skips proposeFromRun() (core/chat.js), so
// nothing would reach Approvals even if a file somehow got written. There is
// also no warp.docx/warp.word capability mirroring warp.excel for a script
// to build the layout itself. Concretely: running this skill through
// warp.claude.run() would very likely just narrate the report as chat text,
// not produce the real file.
//
// The actual .docx has to come from a real (non-silent) run — a Workbench
// automation per customer (pull -> scope -> skill: weekly-status-report ->
// schedule) is the fit, since only that path is allowed to write files and
// goes through proposeFromRun() into Approvals as an editable .docx.
//
// What THIS script is for: make sure that when those workflows fire, the
// data is already fresh. For every active customer (same hideClosed:true
// definition of "active" as scripts/workbook-all-projects.js) it:
//   1. Pulls this week's Gong calls once, for everyone.
//   2. Makes sure every CX Portal project assigned to me has a Warp project
//      (cheap — no Claude call — see syncProjectsFromCxp()).
//   3. Refreshes each active customer's shared context.md with fresh CX
//      Portal data + this week's Gong transcripts (one Claude call per
//      customer, hash-gated — a customer with nothing new is a cache hit).
//   4. Reports which active customers actually had a call this week — those
//      are the ones worth running a WSR for; the rest have nothing new to
//      write up.

// ============================================================
// CONFIGURATION
// ============================================================

// Monday-to-now, not a rolling 7 days — matches the skill's own "Week Of"
// convention (Monday-Friday) and scripts/update-context.js's reasoning.
const WINDOW = { preset: 'week', anchor: 'this' };

// Milliseconds between customers during the context-refresh pass — a small
// pause so a big sweep doesn't burst every non-cached update's Claude call.
const PACE_MS = 1500;

// ============================================================
// HELPERS
// ============================================================

// Same field mapping and hideClosed:true "active" definition as
// scripts/workbook-all-projects.js — see that script's header for why
// hideClosed is the right notion of active/not-churned here.
async function fetchActiveProjectsByCustomer() {

  const rows = [];
  let cursor = null;
  let total = Infinity;

  for (let page = 0; page < 20 && rows.length < total; page++) {

    const result = await warp.cxp.myProjects({
      size: 200,
      cursor,
      hideClosed: true
    });

    rows.push(...(result.projects || []));
    total = result.total ?? rows.length;
    cursor = result.nextCursor || null;

    if (!cursor) break;
  }

  const byCustomer = new Map();

  for (const row of rows) {

    const cxpProjectId = row.projectId || row.displayId;
    if (!cxpProjectId) continue;

    const customerName = row.customerName || row.name || "Unknown Customer";

    if (!byCustomer.has(customerName)) {
      byCustomer.set(customerName, []);
    }

    byCustomer.get(customerName).push({
      cxpProjectId,
      displayId: row.displayId || null,
      name: row.name || row.displayId || cxpProjectId
    });
  }

  return byCustomer;
}

// ============================================================
// 1. PULL THIS WEEK'S GONG CALLS — once, for every customer
// ============================================================

const w = warp.window.resolve(WINDOW);

console.log(`Window: ${w.label} (${w.fromDay} to ${w.toDay})`);
console.log("Pulling this week's Gong calls...");

// warp.gong.pull()'s from/to reach Gong's own filterDates() unmodified
// (gong.js), which expects "YYYY-MM-DD" strings — the same shape ymd()
// produces for every other caller — not the epoch-ms numbers
// warp.window.resolve() returns. Sending epoch-ms here produced a malformed
// filter and a bare HTTP 500 {"error":true} from Gong. `w.to` is exclusive,
// so back it off one millisecond before converting to a day.
const toDayInclusive = new Date(w.to - 1).toISOString().slice(0, 10);
const fromDay = new Date(w.from).toISOString().slice(0, 10);

const pullResult = await warp.gong.pull({ mode: "me", from: fromDay, to: toDayInclusive });

console.log(
  `Pull done: ${pullResult.calls?.length ?? 0} call(s), ` +
  `${pullResult.skipped ?? 0} skipped, ${pullResult.failed ?? 0} failed.`
);

// ============================================================
// 2. MAKE SURE EVERY CX PORTAL PROJECT HAS A WARP PROJECT
//
// No Claude call either way (syncProjectsFromCxp() only creates a stub
// context.md for anything new) — wrapped in try/catch because a
// consultant-name misconfiguration throws here rather than silently doing
// nothing, and that must not take down the whole prep run.
// ============================================================

try {
  const synced = await warp.projects.syncFromCxp();
  if (synced.created.length) {
    console.log(`Created ${synced.created.length} new Warp project(s) from CX Portal.`);
  }
} catch (err) {
  console.error(`Could not sync projects from CX Portal: ${err.message}`);
}

// ============================================================
// 3. ACTIVE CUSTOMERS + WHICH ONES HAD A CALL THIS WEEK
// ============================================================

const activeByCustomer = await fetchActiveProjectsByCustomer();

console.log(`Found ${activeByCustomer.size} customer(s) with at least one active project.`);

const gongFiles = warp.gong.transcripts()
  .filter(f => f.mtime >= w.from && f.mtime < w.to && f.group);

const gongGroups = [...new Set(gongFiles.map(f => f.group))];

// Gong groups are hyphenated slugs (e.g. "RW-Supply-and-Design-LLC") — the
// same de-slugging core/workflow/projectContext.js's gongInputsFor() does
// before comparing against a real customer name.
const correlation = warp.correlate.customers(
  gongGroups.map(g => g.replace(/-/g, " ")),
  [...activeByCustomer.keys()],
  { minimum: "strong" }
);

const customersWithCallsThisWeek = new Set(correlation.matched.map(m => m.cxportal));

// ============================================================
// 4. REFRESH EACH ACTIVE CUSTOMER'S SHARED CONTEXT — ONE CALL PER
//    CUSTOMER, NOT PER PROJECT (context.update() covers every sibling
//    project under the same customer in a single call)
// ============================================================

const warpProjectsByCxpId = new Map(
  warp.projects.list()
    .filter(p => p.cxpProjectId)
    .map(p => [p.cxpProjectId, p])
);

const results = [];

for (const [customerName, projectRefs] of activeByCustomer) {

  const hasCallsThisWeek = customersWithCallsThisWeek.has(customerName);

  const representative = projectRefs
    .map(ref => warpProjectsByCxpId.get(ref.cxpProjectId))
    .find(Boolean);

  if (!representative) {
    console.log(`  ! ${customerName} — no linked Warp project found, skipping context refresh`);
    results.push({ customer: customerName, status: "no-warp-project", hasCallsThisWeek });
    await new Promise(resolve => setTimeout(resolve, PACE_MS));
    continue;
  }

  try {

    const r = await warp.context.update(representative.id, { window: WINDOW });

    console.log(
      `  ${hasCallsThisWeek ? "✓" : "·"} ${customerName} — ` +
      `context ${r.cached ? "unchanged" : "refreshed"}` +
      (hasCallsThisWeek ? "" : " (no calls this week)")
    );

    results.push({
      customer: customerName,
      warpProjectId: representative.id,
      activeProjects: projectRefs.length,
      hasCallsThisWeek,
      contextCached: r.cached,
      status: "ready"
    });

  } catch (err) {

    console.error(`  ! ${customerName} — ${err.message}`);

    results.push({
      customer: customerName,
      status: "failed",
      error: err.message,
      hasCallsThisWeek
    });
  }

  await new Promise(resolve => setTimeout(resolve, PACE_MS));
}

// ============================================================
// 5. SUMMARY — who is actually worth a WSR run this week
// ============================================================

const ready = results.filter(r => r.status === "ready");
const readyWithCalls = ready.filter(r => r.hasCallsThisWeek);
const failed = results.filter(r => r.status !== "ready");

console.log(
  `\n${readyWithCalls.length} of ${activeByCustomer.size} active customer(s) had a call this week ` +
  `and are ready for their WSR workflow to run.`
);

warp.notify.say(
  "WSR weekly prep finished",
  `${readyWithCalls.length} customer(s) ready with fresh calls this week; ` +
  `${ready.length - readyWithCalls.length} active but no new calls; ` +
  `${failed.length} failed/skipped.`
);

return {
  window: w.label,
  activeCustomers: activeByCustomer.size,
  readyWithCallsThisWeek: readyWithCalls.map(r => r.customer),
  readyNoCallsThisWeek: ready.filter(r => !r.hasCallsThisWeek).map(r => r.customer),
  failed,
  results
};
