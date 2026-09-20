/**
 * core/connectors/cxportal-organize.js — my tracker, on disk and in Warp.
 *
 * Three things happen here, in order, because each needs the one before it:
 *
 *   1. **Fetch what is mine.** Not the whole tracker. The portal has 1100+
 *      projects and a consultant is on a couple of dozen; importing all of them
 *      produced a customer list nobody recognised. `myProjectsOnly` is the
 *      checkbox the UI itself sends, with the IC-or-secondary-IC query as a
 *      fallback for when the server ignores it.
 *
 *   2. **Write it out, per customer.** One markdown file each, in the same
 *      `warp-context` root the Library already shows, so tracker state is
 *      previewable next to the transcripts rather than hidden inside a
 *      connector.
 *
 *   3. **Attach it to the customer.** The file is linked to the Warp project
 *      as `kind: 'context'`, which is what makes a project page show its
 *      delivery state and what lets a workflow scope to "this customer" and
 *      get both halves.
 *
 * Correlation is what joins 2 to 3: the tracker's customer names are not Gong's
 * and never will be. See core/correlate.js for why matching them is its own
 * problem.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig, slug } from '../../gong.js';
import { customerContextMarkdown, clause } from './cxportal.js';
import { cxClient } from './cx-client.js';
import { contextDir, withinWindow } from '../workflow/context.js';
import { resolveWindow } from '../workflow/window.js';
import { correlate, normalise } from '../correlate.js';
import * as projects from '../../projects.js';
import * as library from '../../library.js';

/**
 * Every tracker project that is mine.
 *
 * Two strategies, because the first cannot be verified from here. The portal's
 * own UI sends `myProjectsOnly`, which the server resolves against the bearer
 * token; if it honours that, one request is enough. If it silently ignores it —
 * which is this API's habit with parameters it does not know — the result comes
 * back the same size as the unfiltered tracker, and that is the tell. In that
 * case fall back to the documented IC-or-secondary-IC query, which needs a
 * display name and `filterLogic=OR` (with AND it returns nothing, since nobody
 * holds both slots on one project).
 */
export async function fetchMine({ consultant = '', hideClosed = true, onEvent = () => {}, client } = {}) {
  // `client` is an injection point for tests; the portal token lives an hour,
  // so none of this would otherwise be exercised outside that window.
  const cx = client || cxClient();
  if (!client) await cx.ensureFresh();

  const control = await cx.listProjects({ size: 1, hideClosed });
  const everything = Number(control?.allTotal ?? control?.total ?? 0);

  onEvent({ type: 'detail', message: `${everything} projects in the tracker` });

  // 1. the checkbox the portal's own UI uses
  const viaFlag = await cx.listProjects({ size: 200, hideClosed, myProjectsOnly: true });
  const flagged = viaFlag?.projects || [];
  const flagTotal = Number(viaFlag?.total ?? flagged.length);

  if (flagged.length && flagTotal < everything) {
    onEvent({ type: 'detail', message: `myProjectsOnly honoured — ${flagTotal} mine` });
    return { projects: await drain(cx, { hideClosed, myProjectsOnly: true }), via: 'myProjectsOnly', everything };
  }

  // 2. the documented fallback
  if (!consultant) {
    onEvent({
      type: 'detail',
      message: 'myProjectsOnly had no effect and no consultant name is set — set one in the CX Portal config',
    });
    return { projects: [], via: 'none', everything, unfiltered: true };
  }

  onEvent({ type: 'detail', message: `myProjectsOnly ignored — falling back to IC/secondary IC for "${consultant}"` });
  const viaName = await cx.projectsForConsultant(consultant, { size: 200 });
  return { projects: viaName?.projects || [], via: 'consultantName', everything };
}

/** Walk every page rather than taking the first 200 of 1100. */
async function drain(cx, opts, { maxPages = 12 } = {}) {
  const rows = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await cx.listProjects({ ...opts, size: 200, cursor });
    const batch = page?.projects || [];
    rows.push(...batch);
    cursor = page?.nextCursor || null;
    if (!cursor || !batch.length) break;
  }
  return rows;
}

/** Tracker rows grouped into the customers they belong to. */
export function groupByCustomer(rows) {
  const out = new Map();
  for (const row of rows) {
    const name = String(row.customerName || '').trim();
    if (!name) continue;
    const k = normalise(name);
    if (!k) continue;
    if (!out.has(k)) out.set(k, { name, key: k, projects: [] });
    out.get(k).projects.push(row);
  }
  return [...out.values()];
}

/**
 * Fetch my tracker, write it per customer, correlate it with the customers
 * Gong already produced, and attach each file to the project it belongs to.
 *
 * @param link          false to write files without touching Projects
 * @param createMissing create a Warp customer for a tracker customer that has
 *                      no calls yet. Off by default: a customer with no Gong
 *                      history is real, but it is not something anyone asked
 *                      Warp to track, and creating it silently fills the
 *                      Projects list with names nobody recognises.
 */
export async function organizeCxPortal({
  link = true, createMissing = false, dryRun = false, onEvent = () => {}, client, window: win, cxMode = 'snapshot',
} = {}) {
  const cfg = loadConfig();
  const w = resolveWindow(win);

  onEvent({ type: 'step', message: 'fetching my CX Portal projects' });
  const { projects: rows, via, everything, unfiltered } = await fetchMine({
    consultant: cfg.cxConsultant,
    hideClosed: cfg.cxHideClosed,
    onEvent,
    client,
  });

  if (unfiltered) {
    throw new Error(
      'could not tell which tracker projects are yours — set "Your name in the tracker" in the CX Portal application'
    );
  }

  // The window narrows which projects are written out, not which are fetched:
  // ownership is the expensive question and the answer does not change with
  // the date range.
  const { rows: scoped, filtered } = withinWindow(rows, w, cxMode);
  const customers = groupByCustomer(scoped);
  onEvent({
    type: 'detail',
    message: `${scoped.length} project(s) across ${customers.length} customer(s), via ${via}`
      + (filtered ? ` · ${w.label} (${w.fromDay} → ${w.toDay})` : ''),
  });

  // ---- correlate against the customers Gong produced ---------------------
  const warp = projects.listProjects();
  const match = correlate(
    warp.map((p) => ({ id: p.id, name: p.name })),
    customers.map((c) => ({ name: c.name, key: c.key, projects: c.projects }))
  );

  onEvent({
    type: 'detail',
    message: `correlated: ${match.summary.matched} matched, ${match.summary.needsReview} to review, `
      + `${match.summary.gongOnly} calls-only, ${match.summary.cxOnly} tracker-only`,
  });

  if (dryRun) {
    return {
      dryRun: true, via, everything,
      projects: scoped.length, customers: customers.length,
      window: { label: w.label, from: w.fromDay, to: w.toDay, applied: filtered },
      correlation: match.summary,
      matched: match.matched.map((m) => ({ gong: m.gong.name, cxportal: m.cxportal.name, confidence: m.confidence })),
      review: match.review.map((m) => ({ gong: m.gong.name, cxportal: m.cxportal.name, confidence: m.confidence })),
      cxOnly: match.cxOnly.map((c) => c.name),
      gongOnly: match.gongOnly.map((g) => g.name),
    };
  }

  // ---- write, then attach ------------------------------------------------
  const dir = contextDir(cfg);
  const written = [];
  const linked = [];

  const emit = (customerName, trackerProjects, projectId) => {
    const path = join(dir, slug(customerName), 'cxportal.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, customerContextMarkdown(customerName, trackerProjects), 'utf8');
    written.push(path);
    onEvent({ type: 'file', message: `${customerName} → ${trackerProjects.length} project(s)` });

    if (link && projectId) {
      projects.attachContext(projectId, path, 'cxportal');
      linked.push({ projectId, path });
    }
    return path;
  };

  // A matched customer: the file is written under the *Warp* name so it sits
  // beside that customer's transcripts, not in a second folder spelled the
  // tracker's way.
  for (const m of match.matched) {
    emit(m.gong.name, m.cxportal.projects, m.gong.id);
  }

  // Tracker customers with no calls. Written either way — the delivery state
  // is real and worth reading — but only given a Warp customer on request.
  for (const c of match.cxOnly) {
    let id = null;
    if (createMissing) {
      id = projects.createProject({ name: c.name, customer: c.name }).id;
      onEvent({ type: 'file', message: `created customer ${c.name}` });
    }
    emit(c.name, c.projects, id);
  }

  library.refresh();

  return {
    via,
    everything,
    projects: scoped.length,
    customers: customers.length,
    window: { label: w.label, from: w.fromDay, to: w.toDay, applied: filtered },
    written: written.length,
    linked: linked.length,
    correlation: match.summary,
    needsReview: match.review.map((m) => ({
      gong: m.gong.name, cxportal: m.cxportal.name, confidence: m.confidence, score: m.score,
    })),
  };
}
