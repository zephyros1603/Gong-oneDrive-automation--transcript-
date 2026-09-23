/**
 * core/connectors/cxportal-note.js — post an approved note to the customer's
 * CX Portal timeline.
 *
 * The one write this connector makes (see `addNote()` in cxportal.js for why
 * it is kept separate from the read path). This file is the piece that
 * decides *which* tracker project a note goes to — Warp only knows a
 * customer by name, the tracker only knows a project by its internal
 * `proj_…` id, and posting to the wrong one puts a note in front of the
 * wrong customer's Slack channel if sharing is on. A weak name match is
 * refused here, not guessed at — see core/correlate.js for why a wrong
 * match is worse for a write than for a read.
 */

import { cxClient } from './cx-client.js';
import { bestMatch } from '../correlate.js';
import { propose } from '../approvals/store.js';

const RANK = { exact: 3, strong: 2, weak: 1 };

/**
 * Find the one CX Portal project a customer name resolves to, confidently.
 *
 * @returns {Promise<{projectId, projectName, customerName, confidence}>}
 * @throws  if nothing matches, or the best match is not exact/strong
 */
export async function resolveProject(customerName, { client } = {}) {
  const cx = client || cxClient();
  if (!client) await cx.ensureFresh();

  const probe = String(customerName).replace(/,/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !/^(inc|llc|ltd|limited|the|and|group|company|co)$/i.test(w))
    .sort((a, b) => b.length - a.length)[0] || customerName;

  const res = await cx.listProjects({
    filters: [{ attribute: 'customerName', operator: 'contains', value: probe, value2: '' }],
    hideClosed: false,
    size: 50,
  });

  const rows = res?.projects || [];
  if (!rows.length) throw new Error(`no CX Portal project found for "${customerName}"`);

  // One candidate per distinct customer name on the tracker side, so a
  // customer with many projects does not get scored once per project.
  const byCustomer = new Map();
  for (const r of rows) {
    if (!r.customerName) continue;
    if (!byCustomer.has(r.customerName)) byCustomer.set(r.customerName, r);
  }

  const match = bestMatch(customerName, [...byCustomer.values()].map((r) => ({ name: r.customerName, row: r })));
  if (!match || RANK[match.confidence] < RANK.strong) {
    throw new Error(
      match
        ? `closest CX Portal match for "${customerName}" is "${match.candidate.name}", only a ${match.confidence} match — refusing to post to it`
        : `no confident CX Portal match for "${customerName}"`
    );
  }

  // The customer may have several projects; the most recently updated one is
  // the most likely to be what an operator means by "post a note" absent any
  // other signal, and is what the tracker's own default sort already uses.
  const projects = rows.filter((r) => r.customerName === match.candidate.name);
  const target = projects[0];

  return {
    projectId: target.projectId || target.displayId,
    projectName: target.name || target.displayId,
    customerName: match.candidate.name,
    confidence: match.confidence,
    projectCount: projects.length,
  };
}

/**
 * Post a note. The only function in this whole app that writes to the live
 * CX Portal — called from exactly one place, `core/approvals/store.js`'s
 * `decide()`, on a human's approve click for a `kind:'cxp_note'` approval.
 * Never called directly by a script or a route.
 *
 * @param projectId  when given, posts directly to this CX Portal project —
 *   no name search, nothing to get wrong. This is what a proposal made
 *   against an already-linked Warp project carries through, so the id
 *   validated at propose time is the exact one used at approve time rather
 *   than re-derived from a name a moment later.
 * @param customerName  used for the fuzzy `resolveProject()` fallback when
 *   `projectId` isn't given (free-text proposals, or anything predating
 *   this), and always kept for display regardless of which path resolved it.
 */
export async function postNoteForCustomer({ customerName, projectId, text, shareToSlack = false, client } = {}) {
  const cx = client || cxClient();
  const target = projectId
    ? { projectId, projectName: customerName || projectId, customerName: customerName || '', confidence: 'linked' }
    : await resolveProject(customerName, { client: cx });
  const result = await cx.addNote({ projectId: target.projectId, text, shareToSlack });
  return { ...target, result };
}

/**
 * Propose a note for approval — never posts. Two ways to say which project:
 *
 *   - `cxpProjectId` — already know exactly which CX Portal project this is,
 *     e.g. from an already-linked Warp project's `warp.projects.get(id)
 *     .cxpProjectId`. Skips the fuzzy search entirely; there's nothing to
 *     guess, so there's nothing to refuse. This is the path to prefer
 *     whenever the caller already has it.
 *   - `customerName` alone — resolves it the fuzzy way (read-only, the same
 *     check `postNoteForCustomer` used to make on its own before this
 *     split) so a name with no confident match is refused immediately
 *     rather than accepted into the queue and failing silently at approve
 *     time. This is the fallback for a customer not yet a Warp project, or
 *     a name typed by hand that doesn't exactly match how CX Portal spells
 *     it — refusing here beats guessing, same reasoning as always.
 *
 * This is what `warp.cxp.proposeNote()` and `POST /api/cxportal/note` both
 * call.
 */
export async function proposeNote({ customerName, cxpProjectId, projectName, text, shareToSlack = false, client } = {}) {
  if (!String(text || '').trim()) throw new Error('proposeNote: text is required');
  const cx = client || cxClient();

  const target = cxpProjectId
    ? { projectId: cxpProjectId, projectName: projectName || customerName || cxpProjectId, customerName: customerName || projectName || '' }
    : await resolveProject(customerName, { client: cx });

  return propose({
    kind: 'cxp_note',
    title: `Note for ${target.projectName}`,
    body: JSON.stringify({ projectId: target.projectId, customerName: target.customerName, text, shareToSlack }),
  });
}
