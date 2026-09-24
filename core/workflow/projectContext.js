/**
 * core/workflow/projectContext.js — one CX Portal customer, one context file.
 *
 * Replaces two things at once: `syncFromLibrary()`'s Gong-folder-driven
 * project creation (a CX Portal project assigned to me is now the only thing
 * that creates a Warp project), and `digest.js`'s separate token-saving file
 * (this *is* that file now — one curated context.md, not two overlapping
 * "compact summary" concepts).
 *
 * A Warp project stays 1:1 with a CX Portal project — that link is what
 * makes a note-post or a `projectDetail()` call unambiguous. The *context
 * file* is not 1:1 with that, though: Gong doesn't know about individual CX
 * Portal projects, only customers, so two projects under one customer
 * ("Paycor/Entra ID" and "Paycor/Active Directory" for the same account)
 * were pulling the *same* Gong transcripts into two separate files and
 * asking Claude to re-read them twice. One file per customer, shared by
 * every project under it, is both the more sensible model and the cheaper
 * one — see `updateProjectContext()`.
 *
 * Two runs, deliberately separate costs:
 *
 *   **Creation** (`syncProjectsFromCxp`) — walk every CX Portal project
 *   assigned to me, create a Warp project for any that doesn't have one yet.
 *   If its customer already has a context file (a sibling project got there
 *   first), link to that one; otherwise write a cheap stub. No Claude call
 *   either way.
 *
 *   **Update** (`updateProjectContext`) — the expensive one: fetch fresh CX
 *   Portal data for *every* project under the customer, read whatever Gong
 *   transcripts are already pulled and organized for that customer within
 *   the window, and ask Claude to *rewrite* the shared context.md — keep
 *   facts, drop what's gone stale. This does not pull Gong itself; it reads
 *   what the normal scheduled sync (or a script's own `warp.gong.pull()`
 *   call beforehand) already put on disk. Gated *before* any of that ever
 *   reaches Claude — see the "when this skips" note on the function itself.
 *
 * The context file's format is fixed, everywhere:
 *
 *   gong data :
 *   gong from "<date>" - "<date>",
 *   existing CXP Data :
 *   <curated snapshot, one section per project when the customer has more than one>
 *   other connector data : (omitted when nothing beyond gong+cxp exists)
 *   last updated Date : <date>
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, slug } from '../../gong.js';
import { contextDir } from './context.js';
import { resolveWindow, within } from './window.js';
import { fetchMine } from '../connectors/cxportal-organize.js';
import { compare, normalise } from '../correlate.js';
import { cxClient } from '../connectors/cx-client.js';
import { startChatRun } from '../chat.js';
import * as runs from '../../runs.js';
import * as projects from '../../projects.js';
import * as library from '../../library.js';

export function contextPathFor(customer, cfg = loadConfig()) {
  return join(contextDir(cfg), slug(customer), 'context.md');
}

/** Every Warp project already linked under the same customer (normalise()-keyed). */
function siblingsOf(project) {
  const key = normalise(project.customer || project.name);
  return projects.listProjects().filter((p) => p.cxpProjectId && normalise(p.customer || p.name) === key);
}

const stampOf = (hash) => `<!-- warp:context ${hash} -->`;
function currentStamp(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8').split('\n', 1)[0]; } catch { return null; }
}

function isSameCalendarDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/**
 * A real context.md always contains this line — the fixed format requires
 * it. A CLI response that doesn't (a rate-limit notice, a truncated error,
 * anything that isn't actually the rewrite that was asked for) gets refused
 * here rather than written over a perfectly good existing file. This is
 * what would have caught a real incident: an update run once wrote "You've
 * hit your session limit · resets 4:30am" as if it were a customer's entire
 * context, because that response was non-empty and the run's own status
 * still reported `done` — emptiness was the only thing being checked.
 */
function looksLikeRealContext(text) {
  return /existing cxp data\s*:/i.test(text) && !/session limit|rate limit|usage limit/i.test(text);
}

/**
 * The instruction says "verbatim, nothing added around it" and usually gets
 * followed — but not always: one real reply came back as a markdown heading,
 * the actual content inside a code fence, then a paragraph of commentary
 * after the fence. Rather than reject content that's otherwise perfectly
 * good over formatting the model added despite being told not to, pull out
 * the first fenced block if there is one and drop a leading heading line —
 * cheap, and it only ever removes wrapper text, never touches what's inside.
 */
function stripWrapper(text) {
  let t = text.trim();
  const fenced = /```[^\n]*\n([\s\S]*?)\n```/.exec(t);
  if (fenced) t = fenced[1].trim();
  return t.replace(/^#{1,6}[^\n]*\n+/, '').trim();
}

/** A cheap stub — cxp is confirmed but the update run hasn't run yet. */
function stubContent(customerName, projectNames) {
  return [
    'gong data :',
    'gong from "" - "",',
    'existing CXP Data :',
    `${customerName} — created from CX Portal, not yet updated. Project(s): ${projectNames.join(', ')}.`,
    'last updated Date : never',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// creation run
// ---------------------------------------------------------------------------

/**
 * Every CX Portal project assigned to me becomes a Warp project. Unlike the
 * old `createMissing` flag on `organizeCxPortal()`, this is unconditional —
 * there's no "customer with no calls yet" distinction any more, because a
 * project's existence is driven by CX Portal membership, not by Gong.
 *
 * @returns {{fetched, created, existing, projects:[{id,name,cxpProjectId}]}}
 */
export async function syncProjectsFromCxp({ onEvent = () => {}, client, dryRun = false } = {}) {
  const cfg = loadConfig();
  const cx = client || cxClient();
  if (!client) await cx.ensureFresh();

  onEvent({ type: 'step', message: 'fetching CX Portal projects assigned to me' });
  const { projects: rows, via, everything, unfiltered } = await fetchMine({
    consultant: cfg.cxConsultant, hideClosed: cfg.cxHideClosed, onEvent, client: cx,
  });
  if (unfiltered) {
    throw new Error(
      'could not tell which CX Portal projects are yours — set "Your name in the tracker" in the CX Portal application'
    );
  }
  onEvent({ type: 'detail', message: `${rows.length} project(s) mine, via ${via}, of ${everything} total` });

  const created = [];
  const existing = [];

  for (const row of rows) {
    const cxpProjectId = row.projectId || row.displayId;
    if (!cxpProjectId) continue;

    const already = projects.getProjectByCxpId(cxpProjectId);
    if (already) { existing.push({ id: already.id, name: already.name, cxpProjectId }); continue; }

    if (dryRun) {
      created.push({ id: null, name: row.name || row.displayId, cxpProjectId });
      continue;
    }

    const customerName = row.customerName || row.name || '';
    const project = projects.createProject({
      name: row.name || row.displayId || cxpProjectId,
      customer: customerName,
      cxpProjectId,
      cxpDisplayId: row.displayId || null,
    });

    // A sibling under the same customer may already have a real, up-to-date
    // context file — link straight to it rather than writing a second stub
    // that the next update run would just have to consolidate away.
    const siblingWithContext = siblingsOf(project).find((p) => p.id !== project.id && p.context?.path);
    const path = siblingWithContext ? siblingWithContext.context.path : contextPathFor(customerName, cfg);

    if (!siblingWithContext) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stubContent(customerName, [project.name]), 'utf8');
    }
    projects.setContext(project.id, path, 'engine');

    onEvent({ type: 'file', message: siblingWithContext
      ? `created ${project.name} — linked to ${customerName}'s existing context`
      : `created ${project.name}` });
    created.push({ id: project.id, name: project.name, cxpProjectId });
  }

  if (!dryRun) library.refresh();

  return { fetched: rows.length, created, existing, dryRun };
}

// ---------------------------------------------------------------------------
// update run
// ---------------------------------------------------------------------------

const INSTRUCTION = `Rewrite this customer's context file. Keep only important facts — decisions,
open items, current delivery status, key dates, risks — not prose, not a
transcript summary. Follow this exact structure, nothing added around it:

gong data :
gong from "<start date>" - "<end date>",
existing CXP Data :
<curated CX Portal snapshot per project — status, phase, IC, target go-live,
recent changes worth remembering. If the customer has more than one CX
Portal project, give each its own short heading (the project name) under
this one "existing CXP Data :" section — do not repeat the gong data or
last-updated lines per project, there is exactly one of each for the whole
file.>
other connector data : <only if you were given data from a connector besides
Gong and CX Portal — omit this line entirely otherwise>
last updated Date : <today's date>

You are given the current context.md (if one already exists), fresh CX
Portal data for every project belonging to this customer, and — if any —
Gong call transcripts for the window stated above (Gong doesn't distinguish
between this customer's projects, so those calls may be relevant to any or
all of them). Merge what's new, drop what's now stale, keep it dense. If
nothing in a section changed, say so briefly rather than restating
everything.

Your entire reply is written to disk as this file, verbatim. Output ONLY
the five lines/sections above, starting with the literal text "gong data :"
— no title, no heading, no markdown code fence around it, and no commentary
before or after (not "here is the updated file", not a note afterward about
what you changed). Anything outside that structure corrupts the file.`;

/** Gong transcripts already organized for this customer, inside the window. */
function gongInputsFor(customer, w) {
  const files = library.listFiles()
    .filter((f) => f.kind === 'input' && f.root === 'sorted' && f.group);
  const mtime = new Map(files.map((f) => [f.path, f.mtime]));

  const groups = [...new Set(files.map((f) => f.group))];
  const matched = groups.find((g) => {
    const cmp = compare(customer, g.replace(/-/g, ' '));
    return cmp && cmp.confidence !== 'weak';
  });
  if (!matched) return [];

  return files
    .filter((f) => f.group === matched)
    .filter((f) => !w.from || within(w, mtime.get(f.path)))
    .map((f) => f.path);
}

/**
 * Fetch fresh CX Portal + Gong material for a customer (every project under
 * them, not just the one passed in) and have Claude rewrite their shared
 * context.md.
 *
 * When this skips, in order — checked before any of it reaches Claude:
 *
 *   1. `hash` unchanged since the last real update — nothing on either side
 *      (any project's CX Portal snapshot, any Gong transcript in the
 *      window) has moved at all. This is the main token-saving gate and
 *      applies regardless of date; unchanged data stays unchanged forever
 *      until it isn't.
 *   2. Already updated *today* (by the file's own mtime, a calendar-day
 *      comparison — not the hash) — a second, independent cap: even if
 *      something did tick since this morning's run, don't spend a second
 *      Claude call on it until tomorrow. This is what stops a schedule
 *      firing more than once a day from re-billing itself on every minor
 *      CX Portal fluctuation; a genuinely urgent change is still visible in
 *      the raw CX Portal / Gong data, just not re-summarised same-day.
 *
 * `force: true` skips both.
 *
 * @param projectId    any one Warp project belonging to the customer — every
 *   sibling project (same customer, also linked) is included automatically
 * @param opts.window  how far back to look for Gong transcripts — default
 *   the last 7 days, since this is meant to run on a recurring schedule
 * @returns {{path, cached, reason?, rebuiltFrom?, customer, projectsCovered}}
 */
export async function updateProjectContext(projectId, { force = false, window: win, onEvent = () => {}, client } = {}) {
  const project = projects.getProject(projectId);
  if (!project) throw new Error('no such project');
  if (!project.cxpProjectId) throw new Error(`${project.name} has no linked CX Portal project`);

  const siblings = siblingsOf(project);
  const customerName = project.customer || project.name;
  const cfg = loadConfig();
  const w = resolveWindow(win || { preset: 'custom', days: 7 });
  const path = contextPathFor(customerName, cfg);

  onEvent({ type: 'step', message: `fetching CX Portal data for ${customerName} (${siblings.length} project(s))` });
  const cx = client || cxClient();
  if (!client) await cx.ensureFresh();

  const details = await Promise.all(siblings.map(async (p) => {
    try {
      const detail = await cx.projectDetail(p.cxpProjectId, { displayId: p.cxpDisplayId });
      return { project: p, detail };
    } catch (err) {
      return { project: p, error: err.message };
    }
  }));

  const gongPaths = gongInputsFor(customerName, w);
  onEvent({ type: 'detail', message: `${gongPaths.length} gong file(s) in window, cxp data fetched for ${details.length} project(s)` });

  const inputFiles = gongPaths.map((p) => {
    const meta = library.listFiles().find((f) => f.path === p);
    return { path: p, mtime: meta?.mtime || 0 };
  });

  // Gate 1 — nothing changed, ever, regardless of date. The hash covers the
  // gong inputs plus, per project, the audit log's own ids (the Timeline
  // captures virtually every meaningful CX Portal change — a status move, a
  // field edit, a note — so a change anywhere shows up here) alongside a
  // few high-signal counts. Broader than counting three fields, which is
  // what let a real change through undetected before.
  const h = createHash('sha1');
  for (const f of [...inputFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}:${Math.floor(f.mtime)}\n`);
  }
  for (const { project: p, detail } of [...details].sort((a, b) => a.project.id.localeCompare(b.project.id))) {
    h.update(JSON.stringify({
      id: p.cxpProjectId,
      auditIds: detail?.audit?.logs?.map((l) => l.logId),
      stationAuditIds: detail?.stationAudit?.logs?.map((l) => l.logId),
      taskAggs: detail?.taskAggs,
      tasksCount: detail?.tasks?.tasks?.length,
      docsCount: detail?.docs?.documents?.length,
      notesCount: detail?.notes?.notes?.length,
      jiraCount: detail?.jira?.tasks?.length,
    }));
  }
  const hash = h.digest('hex').slice(0, 16);

  if (!force && currentStamp(path) === stampOf(hash)) {
    return { path, cached: true, reason: 'no change since the last update', customer: customerName, projectsCovered: siblings.length };
  }

  // Gate 2 — a same-day cap independent of the hash: something may well have
  // ticked since this morning, but this file has already had its one Claude
  // call for today.
  if (!force && existsSync(path) && isSameCalendarDay(statSync(path).mtimeMs, Date.now())) {
    return { path, cached: true, reason: 'already updated today', customer: customerName, projectsCovered: siblings.length };
  }

  // Fresh CX Portal snapshot, written to disk so it can be handed to Claude
  // as a file rather than inlined — same reasoning as every other context
  // render in this app.
  const cxSnapshotPath = join(dirname(path), 'cxp-snapshot.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(cxSnapshotPath, JSON.stringify(
    Object.fromEntries(details.map(({ project: p, detail, error }) => [p.name, error ? { error } : detail])),
    null, 2
  ), 'utf8');

  const currentText = existsSync(path) ? readFileSync(path, 'utf8') : '(no existing context file)';
  const projectNames = siblings.map((p) => p.name).join(', ');

  const started = await startChatRun({
    projectId,
    message: `${INSTRUCTION}\n\nCustomer: ${customerName}\nProject(s): ${projectNames}\nWindow: ${w.fromDay || 'all time'} - ${w.toDay}\n\nCurrent context.md:\n\n${currentText}`,
    files: [cxSnapshotPath, ...gongPaths],
    resetSession: true,
    silent: true,
    label: `${customerName} — context update`,
    meta: { contextUpdate: true },
  });

  const text = await new Promise((resolve, reject) => {
    const off = runs.subscribe(started.runId, (e) => {
      if (e.type !== 'closed-buffer' && e.type !== 'finished') return;
      off?.();
      const run = runs.get(started.runId);
      if (run?.status === 'done') resolve(run.text || '');
      else reject(new Error(`context update run ended as ${run?.status || 'unknown'}`));
    });
  });
  if (!text.trim()) throw new Error('the context update run produced no text');
  const cleaned = stripWrapper(text);
  if (!looksLikeRealContext(cleaned)) {
    throw new Error(`the context update run's reply doesn't look like a real context file — refusing to overwrite the existing one. Reply started: "${text.trim().slice(0, 120)}"`);
  }

  writeFileSync(path, `${stampOf(hash)}\n${cleaned}\n`, 'utf8');
  library.refresh();
  for (const p of siblings) projects.setContext(p.id, path, 'engine');

  return { path, cached: false, rebuiltFrom: inputFiles.length, customer: customerName, projectsCovered: siblings.length };
}

/** Rough order of magnitude, not a billing figure — ~4 chars per token. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/** Every project's context freshness — the Context application's Data tab. */
export function contextStatus() {
  return projects.listProjects().map((p) => {
    const exists = Boolean(p.context?.path && existsSync(p.context.path));
    let bytes = 0, tokens = 0;
    if (exists) {
      try {
        const text = readFileSync(p.context.path, 'utf8');
        bytes = Buffer.byteLength(text);
        tokens = estimateTokens(text);
      } catch { /* file gone since the row was read */ }
    }
    return {
      id: p.id, name: p.name, linked: Boolean(p.cxpProjectId),
      exists, bytes, tokensEstimate: tokens,
      path: exists ? p.context.path : null,
      updatedAt: p.context?.addedAt || null,
    };
  });
}
