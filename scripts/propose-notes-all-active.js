// scripts/propose-notes-all-active.js — draft and propose a CX Portal note
// for every active project, one approval per project. Never posts.
//
// STRICT SAFETY NOTE: same guarantee as propose-note.js — this only ever
// calls warp.cxp.proposeNote(), which creates a `pending` approval. The
// real write happens only if a human clicks Approve in the Approvals
// page's "CX Portal notes" section. Nothing here, or anywhere warp.cxp
// exposes, can post on its own.
//
// The header line is pulled straight out of context.md's fixed format (see
// core/workflow/projectContext.js: "gong data :" / "last updated Date :")
// mechanically — no Claude involved for that part, so the date and customer
// name in the note can never drift from what's actually in the file. Only
// the body is Claude's: it reads the same context file and condenses it to
// 3–4 bullet points, assembled into the fixed shape:
//
//   customer call [date] - [customer name]
//   - point 1
//   - point 2
//   - point 3 (and, optionally, a 4th)
//
// [date] is the Gong call date the context was built from — the end of the
// "gong from ... - ..." window in context.md (falling back to the file's
// "last updated Date" when that window is blank, e.g. before any Gong
// transcript has been pulled for this project yet).
//
// What "active project" means here: every Warp project that is already
// linked to a CX Portal project (cxpProjectId set) and already has a
// curated context.md that's actually been updated at least once (the
// pre-update stub, "not yet updated" / "last updated Date : never", is
// skipped — there's nothing real to put on a customer's timeline yet).
// Which customer a note is about is never guessed at — it's exactly the
// link that project already carries, the same cxpProjectId propose-note.js
// uses to skip the fuzzy name search entirely.
//
// A project that already has a pending "cxp_note" approval is skipped, so
// re-running this after an earlier run (before anyone has approved or
// rejected those drafts) doesn't pile up duplicate proposals for it.

// ============================================================
// CONFIGURATION
// ============================================================

// Sharing posts to the customer's own Slack channel too — customer-visible,
// off by default. Leave this false unless you specifically want that for
// every note this run proposes.
const SHARE_TO_SLACK = false;

// Paced, not parallel — one Claude run and one proposal at a time.
const DELAY_BETWEEN_PROJECTS_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// ============================================================
// FIND EVERY ACTIVE, ELIGIBLE PROJECT
// ============================================================

const candidates = warp.projects.list().filter((p) => p.cxpProjectId && p.hasContext);

console.log(`${candidates.length} active project(s) linked to CX Portal with a context file.`);

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
      instruction: 'Read the attached project context file. Summarize the current state of this ' +
        'customer engagement in exactly 3 to 4 bullet points — the most important, most recent ' +
        'facts worth the customer seeing on their timeline. Each bullet is one line, starts with ' +
        '"- ", and is plain factual prose — no greeting, no sign-off, no heading, no markdown ' +
        'other than the leading "- ". Write only the bullet points, nothing else, nothing before ' +
        'or after them.',
      files: [project.context.path],
      label: `${project.name} — draft note`,
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
const summaryLine = `${count('proposed')} proposed, ${count('skipped')} skipped, ${count('failed')} failed`;
console.log(`Done: ${summaryLine}`);

warp.notify.say('CX Portal note proposals', summaryLine);

return { results };
