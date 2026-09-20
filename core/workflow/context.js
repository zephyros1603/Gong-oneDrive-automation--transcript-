/**
 * core/workflow/context.js — non-transcript material, per customer.
 *
 * A workflow's scope is a set of file paths, because that is what the agent
 * can read cheaply through `--add-dir`. Anything that is not already a file —
 * the CX Portal project tracker, and later Jira or mail — gets rendered to one
 * and dropped into a `context` folder beside the transcripts.
 *
 * Files rather than prompt text, deliberately: an unread context file costs
 * nothing, while an inlined one is paid for on every turn of every run.
 */

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig, slug } from '../../gong.js';
import { customerContextMarkdown, clause } from '../connectors/cxportal.js';
import { cxClient } from '../connectors/cx-client.js';
import * as library from '../../library.js';
import { resolveWindow, within } from './window.js';

/** How stale a context file may be before it is refetched. */
const MAX_AGE_MS = 6 * 3600e3;

/** `context/` sits beside the sorted tree, so an external out-dir keeps it. */
export function contextDir(cfg = loadConfig()) {
  // `warp-context`, not `context`: a plain `context/` already existed at the
  // project root holding hand-written research notes, and adopting it as a
  // library root would have fed those notes into every workflow.
  return join(dirname(cfg.sortedDir), 'warp-context');
}

export function contextPathFor(customer, source, cfg = loadConfig()) {
  return join(contextDir(cfg), slug(customer), `${source}.md`);
}

/**
 * Apply a date window to tracker rows.
 *
 * `updatedAt` rather than a date range on the request: the API's filter
 * operators are equals/contains/isAnyOf and friends — there is no date
 * comparison among them — so this is the only place a window can be applied.
 *
 * Two modes, because a tracker row is a *snapshot* rather than an event:
 *
 *   `snapshot` (default) — every project the customer has, whenever it last
 *      moved. This is what a status report needs: a project that saw no
 *      activity this week still has a go-live date, and dropping it reads as
 *      "this customer has no projects" rather than "nothing changed".
 *
 *   `changes` — only rows the tracker recorded a change to inside the window.
 *      This is what "what moved this week" needs, and it can legitimately
 *      return nothing.
 *
 * The mode is returned either way. An earlier version silently fell back from
 * `changes` to `snapshot` whenever the filter emptied the list, which made the
 * date setting look like it worked and do nothing.
 */
export function withinWindow(rows, w, mode = 'snapshot') {
  if (mode !== 'changes' || !w?.from) {
    return { rows, filtered: false, mode: 'snapshot' };
  }

  const recent = rows.filter((p) => {
    const at = Date.parse(p.updatedAt || p.startDate || '');
    return Number.isFinite(at) && within(w, at);
  });
  return { rows: recent, filtered: true, mode: 'changes', dropped: rows.length - recent.length };
}

/**
 * Fetch the CX Portal view of one customer and write it to disk.
 *
 * Matching is on customer name, which is the only join the two systems share —
 * Gong groups by `callCustomers`, the tracker by `customerName`. Normalised on
 * both sides so "RW Supply and Design LLC" meets "RW Supply + Design".
 */
export async function refreshCxPortalContext(customer, { force = false, window: win, cxMode = 'snapshot' } = {}) {
  const cfg = loadConfig();
  const path = contextPathFor(customer, 'cxportal', cfg);
  const w = resolveWindow(win);

  // Age alone is not enough to reuse a file: one written for "this week" says
  // something different from one written for "this month", and serving the
  // week's file to a monthly report is a wrong answer that looks like a fast
  // one. The window it was built for is stamped into it and has to match.
  const stamp = `<!-- warp:window ${w.fromDay || 'all'}..${w.toDay} ${cxMode} -->`;
  if (!force && existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) {
    let head = '';
    try { head = readFileSync(path, 'utf8').slice(0, 200); } catch { /* unreadable: refetch */ }
    if (head.includes(stamp)) return { path, cached: true };
  }
  if (!cfg.cxToken && !cfg.cxRefreshToken) return { path: null, skipped: 'no CX Portal token' };

  const client = cxClient();
  // A scheduled run reaches here hours after anyone last pasted a token, so
  // renewing is the normal path rather than the exception.
  try { await client.ensureFresh(); } catch (err) { return { path: null, skipped: err.message }; }
  if (client.tokenInfo().expired) return { path: null, skipped: 'CX Portal token expired and could not be renewed' };

  // Filter server-side on `customerName`. Fetching a page and matching in
  // memory looked fine and was silently wrong: there are 1100+ projects, a
  // page returns 200, and most customers were simply never in the window.
  //
  // `contains` rather than `equals` because the two systems punctuate
  // differently — Gong says "Tech Systems Inc", the tracker "Tech Systems,
  // Inc." — so the shortest distinctive word is the safest probe.
  const probe = String(customer)
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(inc|llc|ltd|limited|the|and|group|company|co)$/i.test(w))
    .sort((a, b) => b.length - a.length)[0] || customer;

  const res = await client.listProjects({
    filters: [clause('customerName', 'contains', probe)],
    hideClosed: cfg.cxHideClosed,
    size: 200,
  });

  // The server match is loose, so confirm each hit against the full name.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(customer);
  const mine = (res?.projects || []).filter((p) => {
    const n = norm(p.customerName);
    return n && (n === want || n.includes(want) || want.includes(n));
  });

  if (!mine.length) return { path: null, skipped: `no tracker projects matched "${customer}"` };

  const { rows: scoped, filtered, dropped } = withinWindow(mine, w, cxMode);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stamp}\n${customerContextMarkdown(customer, scoped)}`, 'utf8');
  library.refresh();

  if (!scoped.length) {
    return { path: null, skipped: `${customer}: no tracker changes in ${w.label.toLowerCase()}` };
  }
  return { path, projects: scoped.length, of: mine.length, windowed: filtered, dropped, cached: false };
}

/**
 * Context files for a scope, fetching what is missing.
 *
 * Returns paths only — the caller adds them to the run's file list, so
 * context and transcripts travel the same way.
 */
export async function contextFilesFor({ customerNames = [], sources = [], window: win, cxMode = 'snapshot' }, opts = {}) {
  if (!sources.includes('cxportal')) return { files: [], notes: [] };

  const files = [];
  const notes = [];

  for (const name of customerNames) {
    try {
      const r = await refreshCxPortalContext(name, { ...opts, window: win, cxMode });
      if (r.path) files.push(r.path);
      else if (r.skipped) notes.push(`${name}: ${r.skipped}`);
    } catch (err) {
      notes.push(`${name}: ${err.message}`);
    }
  }
  return { files, notes };
}
