// scripts/context-update-transcribed-only.js — the update run, restricted to
// customers who actually have a Gong transcript.
//
// scripts/update-context.js already updates every linked project, and
// warp.context.update() is hash-gated so a customer with nothing new (no
// fresh CX Portal change, no new Gong call) skips the Claude call on its
// own. What that gate does NOT skip is the round trip itself: every linked
// project still gets a fresh projectDetail() fetch every time this runs,
// even a project whose customer has never had a single call pulled. This
// version adds the one filter update-context.js doesn't: only touch a
// project if warp.projects.list()'s `transcriptCount` says at least one
// Gong transcript is actually attached to it. A brand-new CX Portal project
// with zero calls yet gets skipped entirely rather than paying for a
// projectDetail() fetch (and, once transcripts do start flowing, its first
// real update) every single run.
//
// Still one context.md per CUSTOMER, not per project — updateProjectContext()
// pulls in every sibling project under the same customer in one call, so a
// customer with two transcribed projects doesn't get rewritten twice; the
// second call is a cache hit (see core/workflow/projectContext.js's hash
// gate). Read-only against CX Portal, never touches the write path.

// ============================================================
// CONFIGURATION
// ============================================================

// Leave empty to update every linked, transcribed project. Fill in specific
// Warp project ids (from warp.projects.list()) to scope this to a subset.
const ONLY_IDS = [];

// Milliseconds to wait between projects — a small pause so a big sweep
// doesn't burst every non-cached update's Claude call at once.
const PACE_MS = 2000;

// Gong transcripts from this past Monday through now — see
// scripts/update-context.js for why this is a calendar week, not a rolling
// 7 days.
const WINDOW = { preset: 'week', anchor: 'this' };

// ============================================================
// RUN
// ============================================================

const linked = warp.projects.list().filter((p) => p.cxpProjectId);
const transcribed = linked.filter((p) => (p.transcriptCount ?? 0) > 0);
const targets = ONLY_IDS.length ? transcribed.filter((p) => ONLY_IDS.includes(p.id)) : transcribed;

console.log(
  `${linked.length} linked project(s), ${transcribed.length} with at least one Gong transcript, ` +
  `updating ${targets.length}`
);

const skipped = linked.length - transcribed.length;
if (skipped > 0) {
  console.log(`  (skipping ${skipped} linked project(s) with no Gong transcript yet)`);
}

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
    'Context update finished (transcribed customers only)',
    `${updated.length} rewritten, ${cached.length} unchanged, ${failed.length} failed, ${skipped} skipped (no transcript).`
  );
}

return {
  linked: linked.length,
  transcribed: transcribed.length,
  targeted: targets.length,
  updated: updated.length,
  cached: cached.length,
  failed,
};
