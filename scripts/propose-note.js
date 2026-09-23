// scripts/propose-note.js — draft a CX Portal note and send it for approval.
//
// STRICT SAFETY NOTE: this script never posts anything to CX Portal. The
// only thing it does is call warp.cxp.proposeNote(), which creates a
// `pending` approval — nothing more. The real write only happens if a human
// clicks Approve in the Approvals page's "CX Portal notes" section. There is
// no code path here, or anywhere warp.cxp exposes, that can post on its own.
//
// What it does:
//   1. Reads the project's context.md (already kept current by
//      scripts/update-context.js).
//   2. Asks Claude to draft a short, factual note suitable for the
//      customer's Activity Timeline — one to three sentences, no filler.
//   3. Proposes it. You'll find it waiting in Approvals; edit or reject it
//      there if the draft isn't right — proposing is not committing to it.

// ============================================================
// CONFIGURATION
// ============================================================

// A Warp project id, from warp.projects.list() or the Projects page's URL.
// Its cxpProjectId (set when the project was created from CX Portal) is
// what gets used below — the exact project, no name-matching involved,
// so there's nothing for a spelling difference between Gong's and CX
// Portal's version of the customer's name to break.
const PROJECT_ID = 'REPLACE_WITH_A_WARP_PROJECT_ID';

// What the note should focus on — kept short on purpose; the draft below is
// meant to be a timeline entry, not a status report.
const FOCUS = 'the most recent, most important update worth the customer seeing on their timeline';

// Sharing posts to the customer's own Slack channel too — customer-visible,
// off by default. Leave this false unless you specifically want that.
const SHARE_TO_SLACK = false;

// ============================================================
// DRAFT THE NOTE
// ============================================================

const project = warp.projects.get(PROJECT_ID);
if (!project) throw new Error(`no such Warp project: ${PROJECT_ID}`);
if (!project.cxpProjectId) {
  throw new Error(`${project.name} isn't linked to a CX Portal project — nothing to post a note against`);
}
if (!project.context?.path) {
  throw new Error(`${project.name} has no context file yet — run scripts/update-context.js for it first`);
}

const draft = await warp.claude.run({
  instruction: `Read the attached project context file. Draft ${FOCUS}. ` +
    'One to three sentences, plain factual prose — no greeting, no sign-off, ' +
    'no markdown formatting, nothing that needs the reader to already know ' +
    'what this file is. Write only the note text itself, nothing else.',
  files: [project.context.path],
  label: `${project.name} — draft note`,
});

console.log('draft:', draft.trim());

// ============================================================
// PROPOSE (never posts)
// ============================================================

const approval = await warp.cxp.proposeNote({
  cxpProjectId: project.cxpProjectId,
  projectName: project.name,
  customerName: project.customer,
  text: draft.trim(),
  shareToSlack: SHARE_TO_SLACK,
});

console.log(`proposed — approval id ${approval.id}, waiting in Approvals`);

return { approvalId: approval.id, project: project.name, draft: draft.trim() };
