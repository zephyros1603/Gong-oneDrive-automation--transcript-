/**
 * core/chat.js — one chat turn, as a server-owned run.
 *
 * Both messages are written to the project before and after, so the chat is
 * whole on disk even if the page never comes back. The caller gets a run id
 * and follows it through runs.subscribe(), which can be attached to as many
 * times as you like — that is what survives a tab switch.
 */

import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import * as library from '../library.js';
import * as runs from '../runs.js';
import * as projects from '../projects.js';
import { getEngine } from './claude/engine.js';
import {
  readSettings, rememberSession, expandPath, recordUsage, usageSummary,
} from '../settings.js';
import { PROJECT_ROOT } from './paths.js';
import { proposeFromRun } from './approvals/store.js';
import { recordRunFiles } from './run-files.js';
import { extractEmail, parseEmail } from '../lib/md.js';

/**
 * A document belongs to this run if it was written after the run began. The
 * previous rule — "modified in the last ten minutes" — quietly dropped the
 * early documents of any run that took longer than that, and a WSR run
 * regularly takes six or seven.
 */
const CLOCK_SKEW_MS = 60000;

/**
 * Decide where the agent may write.
 *
 * outputDir arrives in a request body and is handed to `claude --add-dir`, so
 * an unchecked value grants the agent read/write anywhere on the disk. It is
 * confined to the configured roots, plus whatever the settings already name —
 * that keeps the directory configurable in the Config sheet while stopping a
 * request body from choosing one for itself.
 */
function resolveOutputDir(requested, settings) {
  const fallback = expandPath(settings.outputDir, settings.outputDir);
  if (!requested) return fallback;

  const want = expandPath(requested, settings.outputDir);
  const allowed = [fallback, ...library.roots().map((r) => r.path)].map((p) => resolve(p));
  const abs = resolve(want);

  if (allowed.some((root) => abs === root || abs.startsWith(root + sep))) return abs;
  throw new Error(`output directory is outside the library: ${want}`);
}

export async function startChatRun(body) {
  const settings = readSettings();
  const project = body.projectId ? projects.getProject(body.projectId) : null;
  if (body.projectId && !project) throw new Error('no such project');

  const action = body.actionId
    ? settings.actions.find((a) => a.id === body.actionId)
    : null;
  if (body.actionId && !action) throw new Error(`unknown action: ${body.actionId}`);

  const message = String(body.message || '').trim();

  // A workflow names a skill directly rather than going through a Workbench
  // action button, so both routes into a run end up in the same place.
  const skillName = action ? action.skill : (body.skillName || '');
  if (!action && !skillName && !message) throw new Error('type something or pick a skill');

  const attached = (body.files || []).filter((f) => library.isReadable(f));

  // Attaching transcripts to a conversation that already has context would
  // resend all of it, so a fresh set of files starts a fresh session.
  let sessionId = body.sessionId ?? project?.sessionId ?? null;
  let sessionReset = false;
  if (body.resetSession || (attached.length && body.filesChanged && sessionId)) {
    sessionId = null;
    sessionReset = true;
    if (project) projects.resetSession(project.id);
  }

  // A project chat has its customer's transcripts in scope without anyone
  // attaching them — that is what makes it a project rather than a chat. They
  // go in as paths, not contents, so an unused transcript costs nothing; the
  // agent reads only what it needs through --add-dir.
  //
  // Only when starting fresh: a follow-up already has them in context, and
  // re-sending would pay for the same transcripts twice.
  let files = attached;
  if (project && !attached.length && !sessionId) {
    files = (project.transcripts || []).filter((f) => library.isReadable(f));
  }

  const outputDir = resolveOutputDir(body.outputDir, settings);
  mkdirSync(outputDir, { recursive: true });

  const label = action ? action.label : (body.label || (skillName ? skillName : 'Chat'));
  const instruction = action
    ? [action.instruction, message].filter(Boolean).join('. ')
    : message;

  // Fail before anything is written: an orphaned "pending" reply would sit in
  // the chat forever if the engine were unavailable.
  const engine = getEngine();
  if (!(await engine.available())) {
    throw new Error('the Claude Code CLI was not found — set CLAUDE_BIN');
  }

  // 1. the user's turn, persisted immediately
  let userMessage = null;
  if (project) {
    userMessage = projects.appendMessage(project.id, {
      role: 'user',
      text: message,
      skill: action ? { id: action.id, label: action.label } : null,
      files: files.map((f) => ({ path: f, name: f.split('/').pop() })),
      sessionReset,
    });
  }

  const run = runs.createRun({
    kind: 'chat',
    projectId: project?.id || null,
    label,
    meta: {
      actionId: action?.id || null,
      files: files.length,
      message,
      sessionReset,
      // Whatever started this run, recorded so a page that comes back later
      // can find it again. Without it, navigating away mid-run left the work
      // running invisibly with its output arriving nowhere.
      ...(body.meta || {}),
    },
  });

  // 2. a placeholder reply the stream fills in
  let replyId = null;
  if (project) {
    replyId = projects.appendMessage(project.id, {
      role: 'claude', text: '', runId: run.id, pending: true,
    }).id;
  }

  // What this run was handed, by path. A chat in a project is given that
  // customer's transcripts without anyone attaching them, and those count as
  // processed just as much as a scheduled workflow's do.
  recordRunFiles(run.id, files);

  const before = library.version('output');
  const startedAt = Date.now();
  let reported = null;

  runs.push(run.id, {
    type: 'start', at: startedAt, label, files, outputDir, sessionReset,
    userMessageId: userMessage?.id || null, replyId,
  });

  const started = await engine.run({
    skill: skillName,
    instruction,
    outputDir,
    files,
    sessionId,
    model: settings.model || '',
    maxTurns: Number(settings.maxTurns) || 0,
    label,
    cwd: PROJECT_ROOT,
    addDirs: library.roots().map((r) => r.path),
    onEvent: (e) => {
      runs.push(run.id, e);

      if (e.type === 'done') {
        reported = e;
        if (project && e.session) projects.updateProject(project.id, { sessionId: e.session });
        rememberSession({
          id: e.session,
          label: `${label} · ${new Date().toLocaleString()}`,
          actionId: action?.id || '',
        });
      }

      if (e.type === 'closed') {
        recordUsage({
          actionId: action?.id || 'chat',
          label,
          costUsd: reported?.costUsd,
          durationMs: reported?.durationMs,
          turns: reported?.turns,
          files: files.length,
          cancelled: Boolean(e.cancelled) || !reported,
          inputTokens: reported?.inputTokens,
          outputTokens: reported?.outputTokens,
          cacheReadTokens: reported?.cacheReadTokens,
          cacheWriteTokens: reported?.cacheWriteTokens,
        });

        const fresh = library.listFiles().filter((f) => f.kind === 'output');
        const changed = library.version('output') !== before;
        runs.push(run.id, { type: 'output', changed, files: fresh });
        runs.push(run.id, { type: 'usage', usage: usageSummary() });

        // 3. finalise the stored reply, so a reload shows the same thing
        if (project && replyId) {
          projects.updateMessage(project.id, replyId, {
            text: runs.get(run.id)?.text || '',
            pending: false,
            cancelled: Boolean(e.cancelled),
            cost: reported?.costUsd ?? null,
            durationMs: reported?.durationMs ?? null,
            turns: reported?.turns ?? null,
            documents: changed
              ? fresh.filter((f) => f.mtime >= startedAt - CLOCK_SKEW_MS)
                  .map((f) => ({ path: f.path, name: f.name, size: f.size }))
              : [],
          });
        }

        // What the run produced goes to the review queue, not straight out.
        if (!e.cancelled && reported) {
          try {
            const text = runs.get(run.id)?.text || '';
            const { email } = extractEmail(text);
            proposeFromRun({
              runId: run.id,
              workflowId: body.meta?.workflowId || null,
              projectId: project?.id || null,
              label,
              documents: changed
                ? fresh.filter((f) => f.mtime >= startedAt - CLOCK_SKEW_MS)
                : [],
              email: email ? parseEmail(email) : null,
            });
          } catch { /* a failed proposal must not fail the run */ }
        }

        runs.finish(run.id, {
          status: e.cancelled ? 'cancelled' : 'done',
          costUsd: reported?.costUsd ?? null,
          turns: reported?.turns ?? null,
        });
      }
    },
  });

  // Wiring cancel through the run means the Stop button, the Processes
  // popover and a per-chat stop all go through one path.
  runs.setCancel(run.id, () => started.cancel());
  runs.push(run.id, { type: 'session', session: started.session, jobId: started.jobId });

  return { runId: run.id, replyId, userMessageId: userMessage?.id || null, sessionReset };
}
