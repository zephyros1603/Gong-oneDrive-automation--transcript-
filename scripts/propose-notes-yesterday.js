// scripts/propose-notes-yesterday.js — propose a CX Portal note, but only
// for a project whose customer actually had a Gong call yesterday. A
// combination of two existing scripts: yesterday-daily-context-sync.js's
// "yesterday" window (so this agrees with whatever that script last
// refreshed context.md for) and propose-notes-all-active.js's draft-and-
// propose shape — narrowed from "every active project" down to "only the
// ones with an actual call yesterday."
//
// Meant to run right after yesterday-daily-context-sync.js, not standalone:
// this script never fetches anything itself, from Gong or CX Portal — it
// only reads what's already on disk (the organized transcript tree,
// context.md) and asks Claude to draft from that. If context.md hasn't
// been refreshed for yesterday yet, run that script first.
//
// STRICT SAFETY NOTE, two layers:
//   1. Same as every note-proposing script here — this only ever calls
//      warp.cxp.proposeNote(), which creates a `pending` approval. The real
//      write happens only if a human clicks Approve/Post in Approvals'
//      Notes page. Nothing here can post on its own.
//   2. No CX Portal API call of any kind, anywhere in this script — not
//      even a read. Every project this script touches already carries its
//      cxpProjectId (see "matching", below), and warp.cxp.proposeNote()
//      skips CX Portal entirely whenever cxpProjectId is given (see
//      core/connectors/cxportal-note.js's proposeNote() — the fuzzy
//      customerName search, the only path that would call CX Portal, only
//      runs when cxpProjectId is absent). "Yesterday" and "which calls"
//      both come from Gong's own organized file tree on disk, matched to a
//      Warp project by name — never from a CX Portal call.
//
// The header line and format are unchanged from propose-notes-all-active.js:
//
//   customer call [date] - [customer name]
//   - point 1
//   - point 2
//   - point 3 (and, optionally, a 4th)

// ============================================================
// CONFIGURATION
// ============================================================

const SHARE_TO_SLACK = false;
const DELAY_BETWEEN_PROJECTS_MS = 500;

// On a Monday, "yesterday" is Sunday, which usually has no calls. With this
// on, a Monday run covers Friday 00:00 → Monday 00:00 instead. Kept in sync
// with yesterday-daily-context-sync.js's own flag — set them the same way,
// or "yesterday" means two different windows to the two scripts.
const MONDAY_COVERS_WEEKEND = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// RESOLVE "YESTERDAY" — identical to yesterday-daily-context-sync.js
// ============================================================

const yesterday = warp.window.resolve({ preset: 'day', anchor: 'previous' });
const DAY_MS = 86400e3;
const isMonday = new Date().getDay() === 1;

// Built directly, not re-resolved through warp.window.resolve({from, to}) a
// second time: that path treats `to` as a calendar day and adds one more
// day to make it exclusive, which is correct for a raw date but not for
// yesterday.to — that's already an exact, already-exclusive boundary
// (today's midnight). Re-resolving it would silently push the window one
// extra day forward, quietly pulling in today's still-in-progress calls on
// a Monday run.
const resolved = MONDAY_COVERS_WEEKEND && isMonday
  ? { from: yesterday.from - 2 * DAY_MS, to: yesterday.to }
  : yesterday;

const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
console.log(`Window: ${fmt(resolved.from)} → ${fmt(resolved.to)} (to exclusive)`);

// ============================================================
// WHICH CUSTOMERS ACTUALLY HAD A CALL IN THAT WINDOW — from Gong's own
// organized tree on disk, never a live Gong or CX Portal call
// ============================================================

const groupsWithYesterdayCalls = new Set(
  warp.gong.transcripts()
    .filter((f) => f.root === 'sorted' && f.group && f.mtime >= resolved.from && f.mtime < resolved.to)
    .map((f) => f.group)
);

console.log(`${groupsWithYesterdayCalls.size} customer folder(s) with a call in the window: ` +
  `${[...groupsWithYesterdayCalls].join(', ') || '(none)'}`);

// ============================================================
// MATCH THOSE GROUPS TO WARP PROJECTS — same name-compare rule
// core/workflow/projectContext.js's gongInputsFor() uses internally
// ============================================================

const candidates = warp.projects.list().filter((p) => p.cxpProjectId && p.hasContext).filter((p) => {
  const name = p.customer || p.name;
  return [...groupsWithYesterdayCalls].some((g) => {
    const cmp = warp.correlate.compare(name, g.replace(/-/g, ' '));
    return cmp && cmp.confidence !== 'weak';
  });
});

console.log(`${candidates.length} linked project(s) matched to a customer with a call yesterday.`);

// ============================================================
// PULL THE HEADER FIELDS OUT OF context.md's FIXED FORMAT
// ============================================================

function parseContext(raw) {
  const text = raw.replace(/^<!--.*-->\n?/, ''); // drop the hash-stamp comment line

  const gongMatch = text.match(/gong from\s*"([^"]*)"\s*-\s*"([^"]*)"/i);
  const lastUpdatedMatch = text.match(/last updated Date\s*:\s*(.+?)\s*$/im);

  const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1].trim() : null;
  const callDate = (gongMatch && gongMatch[2].trim()) || lastUpdated || null;

  return { callDate, lastUpdated };
}

// Don't re-propose for a project that already has a note waiting on someone.
const pendingCxpProjectIds = new Set(
  (warp.approvals.pending() || [])
    .filter((a) => a.kind === 'cxp_note')
    .map((a) => {
      try {
        return JSON.parse(a.body)?.projectId;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
);

// ============================================================
// PROPOSE, ONE PROJECT AT A TIME
// ============================================================

const results = [];

for (const summary of candidates) {
  const project = warp.projects.get(summary.id);

  if (pendingCxpProjectIds.has(project.cxpProjectId)) {
    console.log(`${project.name} — already has a pending note, skipping`);
    results.push({ project: project.name, status: 'skipped', reason: 'already pending' });
    continue;
  }

  const raw = warp.context.read(project.id);
  if (!raw) {
    console.log(`${project.name} — no context file, skipping`);
    results.push({ project: project.name, status: 'skipped', reason: 'no context file' });
    continue;
  }

  const { callDate, lastUpdated } = parseContext(raw);
  if (!lastUpdated || lastUpdated.toLowerCase() === 'never') {
    console.log(`${project.name} — context not yet updated, skipping`);
    results.push({ project: project.name, status: 'skipped', reason: 'context not yet updated' });
    continue;
  }

  const customerName = project.customer || project.name;

  try {
    const bullets = await warp.claude.run({
      instruction: 'Read the attached project context file. Summarize yesterday\'s call and the ' +
        'current state of this customer engagement in exactly 3 to 4 bullet points — the most ' +
        'important, most recent facts worth the customer seeing on their timeline. Each bullet is ' +
        'one line, starts with "- ", and is plain factual prose — no greeting, no sign-off, no ' +
        'heading, no markdown other than the leading "- ". Write only the bullet points, nothing ' +
        'else, nothing before or after them.',
      files: [project.context.path],
      label: `${project.name} — draft note (yesterday's call)`,
    });

    const text = `customer call ${callDate} - ${customerName}\n${bullets.trim()}`;
    console.log(`${project.name} — draft:\n${text}`);

    const approval = await warp.cxp.proposeNote({
      cxpProjectId: project.cxpProjectId,
      projectName: project.name,
      customerName: project.customer,
      text,
      shareToSlack: SHARE_TO_SLACK,
    });

    console.log(`${project.name} — proposed, approval id ${approval.id}, waiting in Approvals`);
    results.push({ project: project.name, status: 'proposed', approvalId: approval.id, text });
  } catch (error) {
    console.error(`${project.name} — failed: ${error.message}`);
    results.push({ project: project.name, status: 'failed', error: error.message });
  }

  await sleep(DELAY_BETWEEN_PROJECTS_MS);
}

// ============================================================
// SUMMARY
// ============================================================

const count = (status) => results.filter((r) => r.status === status).length;
const summaryLine =
  `[${fmt(resolved.from).slice(0, 10)}] ${count('proposed')} proposed, ${count('skipped')} skipped, ${count('failed')} failed`;
console.log(`Done: ${summaryLine}`);

warp.notify.say('CX Portal note proposals (yesterday\'s calls)', summaryLine);

return { window: { from: resolved.from, to: resolved.to }, matched: candidates.length, results };
