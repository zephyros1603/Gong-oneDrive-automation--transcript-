/**
 * core/workflow/projectContext.js — one CX Portal project, one context file.
 *
 * Replaces two things at once: `syncFromLibrary()`'s Gong-folder-driven
 * project creation (a CX Portal project assigned to me is now the only thing
 * that creates a Warp project), and `digest.js`'s separate token-saving file
 * (this *is* that file now — one curated context.md per project, not two
 * overlapping "compact summary" concepts).
 *
 * Two runs, deliberately separate costs:
 *
 *   **Creation** (`syncProjectsFromCxp`) — walk every CX Portal project
 *   assigned to me, create a Warp project for any that doesn't have one yet,
 *   write a cheap stub context.md. No Claude call.
 *
 *   **Update** (`updateProjectContext`) — the expensive one: fetch fresh CX
 *   Portal data, read whatever Gong transcripts are already pulled and
 *   organized for this customer within the window, and ask Claude to
 *   *rewrite* context.md — keep facts, drop what's gone stale. This does not
 *   pull Gong itself; it reads what the normal scheduled sync (or a script's
 *   own `warp.gong.pull()` call beforehand) already put on disk.
 *
 * The context file's format is fixed, everywhere:
 *
 *   gong data :
 *   gong from "<date>" - "<date>",
 *   existing CXP Data :
 *   <curated snapshot>
 *   other connector data : (omitted when nothing beyond gong+cxp exists)
 *   last updated Date : <date>
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, slug } from '../../gong.js';
import { contextDir } from './context.js';
import { resolveWindow, within } from './window.js';
import { fetchMine } from '../connectors/cxportal-organize.js';
import { compare } from '../correlate.js';
import { cxClient } from '../connectors/cx-client.js';
import { startChatRun } from '../chat.js';
import * as runs from '../../runs.js';
import * as projects from '../../projects.js';
import * as library from '../../library.js';

export function contextPathFor(customer, cfg = loadConfig()) {
  return join(contextDir(cfg), slug(customer), 'context.md');
}

const stampOf = (hash) => `<!-- warp:context ${hash} -->`;
function currentStamp(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8').split('\n', 1)[0]; } catch { return null; }
}

/** A cheap stub — cxp is confirmed but the update run hasn't run yet. */
function stubContent(project) {
  return [
    'gong data :',
    'gong from "" - "",',
    'existing CXP Data :',
    `${project.name} — created from CX Portal, not yet updated.`,
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

    const project = projects.createProject({
      name: row.name || row.displayId || cxpProjectId,
      customer: row.customerName || row.name || '',
      cxpProjectId,
      cxpDisplayId: row.displayId || null,
    });

    const path = contextPathFor(project.name, cfg);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stubContent(project), 'utf8');
    projects.attachContext(project.id, path, 'engine', 'context');

    onEvent({ type: 'file', message: `created ${project.name}` });
    created.push({ id: project.id, name: project.name, cxpProjectId });
  }

  if (!dryRun) library.refresh();

  return { fetched: rows.length, created, existing, dryRun };
}

// ---------------------------------------------------------------------------
// update run
// ---------------------------------------------------------------------------

const INSTRUCTION = `Rewrite this project's context file. Keep only important facts — decisions,
open items, current delivery status, key dates, risks — not prose, not a
transcript summary. Follow this exact structure, nothing added around it:

gong data :
gong from "<start date>" - "<end date>",
existing CXP Data :
<curated CX Portal snapshot — status, phase, IC, target go-live, recent
changes worth remembering>
other connector data : <only if you were given data from a connector besides
Gong and CX Portal — omit this line entirely otherwise>
last updated Date : <today's date>

You are given the current context.md (if one already exists), fresh CX
Portal data, and — if any — Gong call transcripts for the window stated
above. Merge what's new, drop what's now stale, keep it dense. If nothing in
a section changed, say so briefly rather than restating everything.`;

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
 * Fetch fresh CX Portal + Gong material for one project and have Claude
 * rewrite its context.md. Hash-gated like `digest.js` was: a schedule that
 * fires with nothing new skips the Claude call entirely.
 *
 * @param opts.window  how far back to look for Gong transcripts — default
 *   the last 7 days, since this is meant to run on a recurring schedule
 * @returns {{path, cached, rebuiltFrom}}
 */
export async function updateProjectContext(projectId, { force = false, window: win, onEvent = () => {}, client } = {}) {
  const project = projects.getProject(projectId);
  if (!project) throw new Error('no such project');
  if (!project.cxpProjectId) throw new Error(`${project.name} has no linked CX Portal project`);

  const cfg = loadConfig();
  const w = resolveWindow(win || { preset: 'custom', days: 7 });

  onEvent({ type: 'step', message: `fetching CX Portal data for ${project.name}` });
  const cx = client || cxClient();
  if (!client) await cx.ensureFresh();
  const detail = await cx.projectDetail(project.cxpProjectId, { displayId: project.cxpDisplayId });

  const gongPaths = gongInputsFor(project.customer, w);
  onEvent({ type: 'detail', message: `${gongPaths.length} gong file(s) in window, cxp data fetched` });

  const path = contextPathFor(project.name, cfg);
  const inputFiles = gongPaths.map((p) => {
    const meta = library.listFiles().find((f) => f.path === p);
    return { path: p, mtime: meta?.mtime || 0 };
  });

  // Hash covers the gong inputs plus a stringified cxp snapshot, so a run
  // with nothing new on either side skips the Claude call.
  const h = createHash('sha1');
  for (const f of [...inputFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}:${Math.floor(f.mtime)}\n`);
  }
  h.update(JSON.stringify({
    taskAggs: detail.taskAggs, tasks: detail.tasks, audit: detail.audit?.logs?.length,
  }));
  const hash = h.digest('hex').slice(0, 16);

  if (!force && currentStamp(path) === stampOf(hash)) {
    return { path, cached: true };
  }

  // Fresh CX Portal snapshot, written to disk so it can be handed to Claude
  // as a file rather than inlined — same reasoning as every other context
  // render in this app.
  const cxSnapshotPath = join(dirname(path), 'cxp-snapshot.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(cxSnapshotPath, JSON.stringify(detail, null, 2), 'utf8');

  const currentText = existsSync(path) ? readFileSync(path, 'utf8') : '(no existing context file)';

  const started = await startChatRun({
    projectId,
    message: `${INSTRUCTION}\n\nWindow: ${w.fromDay || 'all time'} - ${w.toDay}\n\nCurrent context.md:\n\n${currentText}`,
    files: [cxSnapshotPath, ...gongPaths],
    resetSession: true,
    silent: true,
    label: `${project.name} — context update`,
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

  writeFileSync(path, `${stampOf(hash)}\n${text.trim()}\n`, 'utf8');
  library.refresh();
  projects.attachContext(projectId, path, 'engine', 'context');

  return { path, cached: false, rebuiltFrom: inputFiles.length };
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
