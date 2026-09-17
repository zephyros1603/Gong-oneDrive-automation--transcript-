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
import { db } from '../db/client.js';
import { runFiles } from '../db/schema.js';

const WINDOWS = { last2d: 2, last7d: 7, last14d: 14, last30d: 30, all: 0 };

/**
 * Which files a workflow may see.
 *
 * This is the scoping the Projects model already supports: a person has calls
 * with many customers, and a workflow for one customer must not see another's.
 * Scope by project, then narrow by age.
 */
export function resolveScope(scope = {}) {
  const days = WINDOWS[scope.window] ?? 7;
  const cutoff = days ? Date.now() - days * 86400e3 : 0;

  let paths;
  if (scope.projectId) {
    const p = projects.getProject(scope.projectId);
    paths = p ? p.transcripts : [];
  } else {
    paths = library.listFiles()
      .filter((f) => f.kind === 'input' && f.root === 'sorted')
      .map((f) => f.path);
  }

  if (!cutoff) return paths.filter((p) => library.isReadable(p));

  const mtime = new Map(library.listFiles().map((f) => [f.path, f.mtime]));
  return paths.filter((p) => library.isReadable(p) && (mtime.get(p) ?? 0) >= cutoff);
}

/** Record what a run actually consumed, so "transcripts processed" is real. */
function recordFiles(runId, paths) {
  for (const path of paths) {
    db.insert(runFiles).values({ runId, path }).run();
  }
}

/**
 * @returns {Promise<{runId: string}>} — follow it through runs.subscribe().
 */
export async function runWorkflow(workflow, { trigger = 'manual', dryRun = false } = {}) {
  const isPipeline = workflow.outputs?.kind === 'pipeline';

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
          daysBack: WINDOWS[workflow.scope?.window] ?? 2,
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
  const files = resolveScope(workflow.scope);
  if (!files.length) {
    throw new Error('nothing in scope — no transcripts matched this workflow');
  }
  if (dryRun) {
    return { dryRun: true, files, count: files.length };
  }

  const started = await startChatRun({
    projectId: workflow.scope?.projectId || null,
    actionId: null,
    message: workflow.instruction,
    skillName: workflow.skill || null,
    files,
    resetSession: true,
  });

  recordFiles(started.runId, files);
  runs.push(started.runId, {
    type: 'workflow', workflowId: workflow.id, name: workflow.name, trigger, files: files.length,
  });

  return started;
}
