/**
 * core/workflow/run.js — the one place a workflow executes.
 *
 * Workbench calls this as a test run; the scheduler calls it on a timer. Same
 * function, so what was tested is what runs — which is the whole reason the
 * two tabs were separate concepts before and are one now.
 *
 * Two kinds of workflow exist:
 *   - `pipeline` — pull, organize, feed projects. No model involved.
 *   - everything else — a Claude run over the scoped transcripts.
 */

import * as runs from '../../runs.js';
import * as projects from '../../projects.js';
import * as library from '../../library.js';
import { runPipeline } from '../../automation.js';
import { startChatRun } from '../chat.js';
import { contextFilesFor } from './context.js';
import { resolveWindow, within, pullDays } from './window.js';
import { organizeCxPortal } from '../connectors/cxportal-organize.js';
import { refreshDigest } from './digest.js';


/**
 * Which files a workflow may see.
 *
 * This is the scoping the Projects model already supports: a person has calls
 * with many customers, and a workflow for one customer must not see another's.
 * Scope by project, then narrow by age.
 */
export function resolveScope(scope = {}) {
  // Sources are a choice, not a label. This used to return transcripts
  // whatever was ticked, so "CX Portal only" quietly ran with every call
  // transcript in scope as well — the opposite of what the setting said.
  const sources = scope.sources || ['transcript'];
  if (!sources.includes('transcript')) return [];

  // Both bounds, not just a cutoff. A window of "last week" has to exclude
  // this week's calls as well as everything older, or every report about a
  // finished week silently includes the days after it.
  const w = resolveWindow(scope.window);

  let paths;
  if (scope.projectId) {
    const p = projects.getProject(scope.projectId);
    paths = p ? p.transcripts : [];
  } else {
    paths = library.listFiles()
      .filter((f) => f.kind === 'input' && f.root === 'sorted')
      .map((f) => f.path);
  }

  if (!w.from) return paths.filter((p) => library.isReadable(p));

  const mtime = new Map(library.listFiles().map((f) => [f.path, f.mtime]));
  return paths.filter((p) => library.isReadable(p) && within(w, mtime.get(p)));
}

/** Which of the three situations a run is actually in. */
export function modeFor(transcripts, context) {
  if (transcripts && context) return 'combined';
  if (context) return 'cxportal';
  return 'transcript';
}

/**
 * The prompt the agent receives: the base instruction plus the steer for the
 * material it was given.
 *
 * `combined` replaces the two single-source steers rather than being appended
 * to them. Stacking all three produced a prompt that asked for a call summary,
 * then a delivery summary, then a reconciliation of the two — and got three
 * disconnected sections instead of one document.
 */
export function composeInstruction(workflow, { transcripts = 0, context = 0 } = {}) {
  const base = String(workflow.instruction || '').trim();
  const extra = workflow.sourceInstructions || {};
  const mode = modeFor(transcripts, context);

  const steer = String(extra[mode] || '').trim();
  return [base, steer].filter(Boolean).join('\n\n');
}

/**
 * @returns {Promise<{runId: string}>} — follow it through runs.subscribe().
 */
export async function runWorkflow(workflow, { trigger = 'manual', dryRun = false } = {}) {
  const isPipeline = workflow.outputs?.kind === 'pipeline';

  // ---- an import workflow ----------------------------------------------
  // Not every sync ends at the model. This one writes to Warp's own customer
  // list, so it never touches the engine and costs nothing to run.
  if (workflow.source === 'cxportal' && workflow.destination === 'projects') {
    const opts = workflow.pull || {};
    if (dryRun) return { dryRun: true, ...(await organizeCxPortal({ dryRun: true, window: workflow.scope?.window })) };

    const run = runs.createRun({
      kind: 'automation',
      label: workflow.name,
      meta: { trigger, workflowId: workflow.id, kind: 'import' },
    });

    (async () => {
      try {
        const result = await organizeCxPortal({
          // Off by default. A tracker customer with no calls is real, but
          // creating one silently is what filled the Projects list with 135
          // names nobody recognised.
          createMissing: opts.createMissing === true,
          link: opts.link !== false,
          window: workflow.scope?.window,
          onEvent: (e) => runs.push(run.id, e),
        });
        runs.finish(run.id, { status: 'done', ...result });
      } catch (err) {
        runs.push(run.id, { type: 'error', message: err.message });
        runs.finish(run.id, { status: 'error' });
      }
    })();

    return { runId: run.id };
  }

  if (isPipeline) {
    const run = runs.createRun({
      kind: 'automation',
      label: workflow.name,
      meta: { trigger, workflowId: workflow.id },
    });

    // Fire and forget: the caller follows the run, it does not await the work.
    (async () => {
      try {
        const result = await runPipeline({
          trigger,
          daysBack: pullDays(resolveWindow(workflow.scope?.window)) || 2,
          onEvent: (e) => runs.push(run.id, e),
        });
        runs.push(run.id, { type: 'summary', result });
        runs.finish(run.id, { status: result.errors?.length ? 'error' : 'done', ...result });
      } catch (err) {
        runs.push(run.id, { type: 'error', message: err.message });
        runs.finish(run.id, { status: 'error' });
      }
    })();

    return { runId: run.id };
  }

  // ---- a generation workflow ------------------------------------------
  const win = resolveWindow(workflow.scope?.window);
  const wantsGong = (workflow.scope?.sources || ['transcript']).includes('transcript');

  // Fetch before scoping. "Pull before running" was a checkbox that did
  // nothing: this branch only ever read transcripts that happened to already
  // be on disk, so a scheduled report covered whatever the last manual pull
  // left behind rather than the window it was configured with.
  //
  // Skipped on a dry run — a preview should not spend a Gong round trip, and
  // the point of the preview is to show what is already in scope.
  let pulled = null;
  if (!dryRun && wantsGong && workflow.pull?.enabled !== false) {
    try {
      pulled = await runPipeline({
        trigger: `workflow:${trigger}`,
        daysBack: pullDays(win) || 2,
      });
    } catch (err) {
      // A pull failure must not lose the run: there may be perfectly good
      // transcripts already on disk, and refusing to report on them because
      // Gong was briefly unreachable is the wrong trade.
      pulled = { error: err.message };
    }
  }

  const sources = workflow.scope?.sources || ['transcript'];

  const scopedProjects = workflow.scope?.projectId
    ? [projects.getProject(workflow.scope.projectId)].filter(Boolean)
    : projects.listProjects();
  const customers = scopedProjects.map((p) => p.name);

  let files;
  let ctxNotes = [];
  let digestInfo = null;
  let transcriptCount = 0;
  let contextCount = 0;

  if (sources.includes('digest')) {
    // Stands in for both raw transcripts and the CX Portal render, which is
    // the entire point — a run here pays for one small file per customer
    // instead of every transcript and the tracker markdown again. Not force-
    // rebuilt: refreshDigest() itself decides whether the inputs actually
    // changed, so an unattended schedule rebuilds only when there is
    // something to rebuild for.
    const built = [];
    for (const p of scopedProjects) {
      try {
        const r = await refreshDigest(p.id);
        if (r.path) built.push(r.path);
        else if (r.skipped) ctxNotes.push(`${p.name}: ${r.skipped}`);
      } catch (err) {
        ctxNotes.push(`${p.name}: digest failed — ${err.message}`);
      }
    }
    files = built;
    digestInfo = { customers: scopedProjects.length, files: built.length };
    contextCount = built.length;   // reported as "context": a digest stands in for both
  } else {
    const transcripts = resolveScope(workflow.scope);

    // Everything that is not already a file — the CX Portal tracker today —
    // rendered per customer and added to the same list, so Claude receives
    // call transcripts and project state together, grouped by who they
    // belong to.
    const ctx = await contextFilesFor({
      customerNames: customers,
      sources,
      window: workflow.scope?.window,
      cxMode: workflow.scope?.cxMode || 'snapshot',
    });
    files = [...transcripts, ...ctx.files];
    ctxNotes = ctx.notes;
    transcriptCount = transcripts.length;
    contextCount = ctx.files.length;
  }

  if (!files.length) {
    throw new Error(sources.includes('digest')
      ? 'nothing in scope — no digest exists yet for these customers (build one from the Context application)'
      : 'nothing in scope — no transcripts or context matched this workflow');
  }

  // What was asked of the agent depends on what it actually received, not on
  // what was ticked: a workflow set to both sources that finds no tracker rows
  // this week is a calls-only run, and telling it to reconcile against a
  // tracker it cannot see is how a report ends up citing nothing.
  //
  // Digest mode skips the per-source steer machinery entirely: there is only
  // one kind of file in play, and the digest itself already states what came
  // from where, so a source-specific steer has nothing left to add.
  const mode = digestInfo ? 'digest' : modeFor(transcriptCount, contextCount);
  const instruction = digestInfo
    ? workflow.instruction || ''
    : composeInstruction(workflow, { transcripts: transcriptCount, context: contextCount });

  const counted = { transcripts: transcriptCount, context: contextCount };

  if (dryRun) {
    return {
      dryRun: true, files, count: files.length,
      ...counted, notes: ctxNotes,
      mode, instruction,
      window: { label: win.label, from: win.fromDay, to: win.toDay, days: win.days },
      wouldPull: !wantsGong || workflow.pull?.enabled === false ? 0 : pullDays(win),
    };
  }

  const started = await startChatRun({
    projectId: workflow.scope?.projectId || null,
    actionId: null,
    message: instruction,
    skillName: workflow.skill || null,
    label: workflow.name,
    files,
    resetSession: true,
    meta: { workflowId: workflow.id, trigger },
  });

  // startChatRun already recorded these against the same run id; doing it
  // again here would count every transcript twice.
  runs.push(started.runId, {
    type: 'workflow', workflowId: workflow.id, name: workflow.name, trigger,
    files: files.length, ...counted,
    window: { label: win.label, from: win.fromDay, to: win.toDay },
  });
  if (pulled) {
    runs.push(started.runId, {
      type: 'detail',
      message: pulled.error
        ? `Gong pull failed (${pulled.error}) — running on what is already on disk`
        : `pulled ${pulled.pulled ?? 0} call(s) covering ${win.label.toLowerCase()}`,
    });
  }
  for (const note of ctxNotes) {
    runs.push(started.runId, { type: 'detail', message: `context: ${note}` });
  }

  return started;
}
