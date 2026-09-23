// scripts/update-context.js — the update run, as an Engine script.
//
// For every Warp project linked to a CX Portal project, fetches fresh CX
// Portal data plus whatever Gong transcripts are already pulled+organized
// for that customer, and has Claude rewrite the project's one context.md.
// Content-hash-gated: a project with nothing new since the last run is
// skipped without a Claude call, so running this daily costs nothing extra
// on quiet days.
//
// Read-only against CX Portal (projectDetail — all GET). Never posts
// anything, never touches the CX Portal write path — that's a completely
// separate script (scripts/propose-note.js).
//
// Schedule this from the Engine page once saved. If you'd rather run it
// per-project on separate schedules instead of all-at-once, change ONLY_IDS
// below to a single project's id and give each project its own copy of this
// script.

// ============================================================
// CONFIGURATION
// ============================================================

// Leave empty to update every linked project. Fill in specific Warp project
// ids (from warp.projects.list()) to scope this to a subset — e.g. one
// schedule per project instead of one schedule for everyone.
const ONLY_IDS = [];

// Milliseconds to wait between projects. Each update that isn't cache-hit is
// a real Claude call; a small pause keeps a big sweep from bursting them all
// at once.
const PACE_MS = 2000;

// ============================================================
// RUN
// ============================================================

const all = warp.projects.list().filter((p) => p.cxpProjectId);
const targets = ONLY_IDS.length ? all.filter((p) => ONLY_IDS.includes(p.id)) : all;

console.log(`updating ${targets.length} of ${all.length} linked project(s)`);

const updated = [];
const cached = [];
const failed = [];

for (const p of targets) {
  try {
    const r = await warp.context.update(p.id);
    if (r.cached) {
      cached.push(p.name);
      console.log(`  = ${p.name} — nothing new, skipped`);
    } else {
      updated.push(p.name);
      console.log(`  ✓ ${p.name} — rewritten from ${r.rebuiltFrom} gong file(s)`);
    }
  } catch (err) {
    failed.push({ name: p.name, error: err.message });
    console.log(`  ! ${p.name} — ${err.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, PACE_MS));
}

if (updated.length || failed.length) {
  warp.notify.say(
    'Context update finished',
    `${updated.length} rewritten, ${cached.length} unchanged, ${failed.length} failed.`
  );
}

return { targeted: targets.length, updated: updated.length, cached: cached.length, failed };
