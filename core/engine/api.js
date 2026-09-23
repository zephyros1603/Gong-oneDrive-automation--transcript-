/**
 * core/engine/api.js — the whole world a script is allowed to touch.
 *
 * A script never sees `require`, `fs`, `process`, or the real `globalThis` —
 * only this object, built fresh per run. Every function here is something we
 * already trust a route handler to call; nothing is added just for scripts.
 * The rule for adding to this file: could a route handler already do this
 * safely on its own? If not, it does not belong here.
 *
 * Every call is logged (path + a short arg summary, never full payloads —
 * a CX Portal or Gong response can carry customer data) so a script's
 * run log reads like a trace, not a black box.
 */

import { cxClient } from '../connectors/cx-client.js';
import { correlate, compare, normalise } from '../correlate.js';
import { syncProjectsFromCxp, updateProjectContext, contextStatus, contextPathFor } from '../workflow/projectContext.js';
import { resolveWindow } from '../workflow/window.js';
import { propose, listApprovals } from '../approvals/store.js';
import { proposeNote } from '../connectors/cxportal-note.js';
import { startChatRun } from '../chat.js';
import { notify } from '../notify.js';
import { pullTranscripts } from '../gong/pull.js';
import * as projectsStore from '../../projects.js';
import * as library from '../../library.js';
import * as runsStore from '../../runs.js';
import { loadConfig, slug } from '../../gong.js';
import ExcelJS from 'exceljs';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

const MAX_LOG_ARG = 120;
const brief = (v) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > MAX_LOG_ARG ? `${s.slice(0, MAX_LOG_ARG)}…` : s;
  } catch { return String(v); }
};

/**
 * Build one API object for one script run.
 * @param onEvent  receives {type:'call', path, args} for every host call —
 *   the run log a script's page shows.
 */
export function buildApi({ onEvent = () => {} } = {}) {
  const trace = (path) => (...args) => onEvent({ type: 'call', path, args: args.map(brief) });

  const cx = cxClient();

  return {
    // ---- Gong / the transcript library --------------------------------
    gong: {
      /** Every transcript file Warp currently holds, newest first. */
      transcripts() {
        trace('gong.transcripts')();
        return library.listFiles().filter((f) => f.kind === 'input')
          .sort((a, b) => b.mtime - a.mtime)
          .map((f) => ({ path: f.path, name: f.name, mtime: f.mtime, group: f.group }));
      },
      /** Read one transcript's text. Confined to the library, like everything else. */
      read(path) {
        trace('gong.read')(path);
        if (!library.isReadable(path)) throw new Error('not a readable path');
        return readFileSync(path, 'utf8');
      },
      /**
       * Pull real transcripts from Gong — the same primitive `POST /api/run`
       * and the scheduler use. `mode: 'me'` (default) is your own calls;
       * `'account'`/`'call'` and their extra params (`accountName`,
       * `callIds`) work the same way. Progress streams into the script's own
       * run log as `log` lines rather than a separate call-trace shape.
       */
      async pull({ mode = 'me', days, from, to, format, accountName, callIds, dryRun = false } = {}) {
        trace('gong.pull')({ mode, days, from, to, format });
        return pullTranscripts(
          { mode, days, from, to, format, accountName, callIds, dryRun },
          (e) => onEvent({ type: 'log', message: `[gong] ${e.type}${e.message ? ` — ${e.message}` : ''}` })
        );
      },
    },

    // ---- CX Portal ------------------------------------------------------
    cxp: {
      async projects(opts = {}) {
        trace('cxp.projects')(opts);
        return cx.listProjects(opts);
      },
      async myProjects(opts = {}) {
        trace('cxp.myProjects')(opts);
        return cx.listProjects({ ...opts, myProjectsOnly: true });
      },
      /**
       * One call, everything the detail page shows: hours, timeline (project
       * and station-level), tasks, docs, folders, notes, connector images,
       * and — with `opts.displayId`/`opts.stationId` — linked Jira issues and
       * one station's comments too. Combined server-side so a script never
       * has to make the nine separate calls this replaces.
       */
      async projectDetail(projectId, opts = {}) {
        trace('cxp.projectDetail')(projectId);
        return cx.projectDetail(projectId, opts);
      },
      /** The customer directory (`/ops/customersps`) — outside `action()`'s dispatcher, so it gets its own entry. */
      async customers(opts = {}) {
        trace('cxp.customers')(opts);
        return cx.customers(opts);
      },
      async action(name, params = {}) {
        trace('cxp.action')(name, params);
        return cx.action(name, params);
      },
      /**
       * Propose a note for a person to approve — never posts. Lands as a
       * `pending`, `kind:'cxp_note'` approval in the Approvals page's
       * always-visible CX Portal notes section; only a human's approve
       * click there calls the real live API. There is no `cxp.addNote()` or
       * any other function on this object that writes — this is the one
       * write-adjacent capability a script gets, and it never writes itself.
       *
       * Pass `cxpProjectId` whenever you already have it (e.g.
       * `warp.projects.get(id).cxpProjectId`) — it skips the fuzzy
       * customer-name search entirely, so there's nothing to mismatch.
       * `customerName` alone falls back to that fuzzy search, same as
       * before; refused if there's no confident match.
       */
      async proposeNote({ customerName, cxpProjectId, projectName, text, shareToSlack = false }) {
        trace('cxp.proposeNote')(cxpProjectId || customerName);
        return proposeNote({ customerName, cxpProjectId, projectName, text, shareToSlack, client: cx });
      },
    },

    // ---- Correlation between the two ------------------------------------
    correlate: {
      customers(gongNames, cxNames, opts) {
        trace('correlate.customers')();
        return correlate(
          gongNames.map((n) => ({ name: n })),
          cxNames.map((n) => ({ name: n })),
          opts
        );
      },
      compare, normalise,
    },

    // ---- the one context file each project has ---------------------------
    context: {
      /** The current context.md text, or null before the first update run. */
      read(projectId) {
        trace('context.read')(projectId);
        const project = projectsStore.getProject(projectId);
        if (!project?.context?.path || !existsSync(project.context.path)) return null;
        return readFileSync(project.context.path, 'utf8');
      },
      /**
       * Overwrite context.md directly — a script's own call, bypassing the
       * Claude-curated update. Still confined to the one fixed path a
       * project's context always lives at; a script chooses the text, never
       * the destination.
       */
      write(projectId, text) {
        trace('context.write')(projectId);
        const project = projectsStore.getProject(projectId);
        if (!project) throw new Error('no such project');
        const path = project.context?.path || contextPathFor(project.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(text), 'utf8');
        library.refresh();
        projectsStore.attachContext(projectId, path, 'engine', 'context');
        return { path };
      },
      /** Fetch fresh CX Portal + Gong data and have Claude rewrite context.md. */
      async update(projectId, opts = {}) {
        trace('context.update')(projectId);
        return updateProjectContext(projectId, opts);
      },
      /** Every project's context freshness — the Context application's Data tab. */
      status() {
        trace('context.status')();
        return contextStatus();
      },
    },

    // ---- Warp's own project list, one per linked CX Portal project --------
    projects: {
      list() {
        trace('projects.list')();
        return projectsStore.listProjects().map((p) => ({
          id: p.id, name: p.name, customer: p.customer,
          cxpProjectId: p.cxpProjectId, cxpDisplayId: p.cxpDisplayId,
          transcriptCount: p.transcriptCount, hasContext: Boolean(p.context),
        }));
      },
      get(id) {
        trace('projects.get')(id);
        return projectsStore.getProject(id);
      },
      /**
       * Walk every CX Portal project assigned to me and create a Warp
       * project for any that doesn't have one yet — the creation run. Cheap:
       * no Claude call, just a stub context.md. `context.update()` is the
       * one that does the real (costed) work, per project.
       */
      async syncFromCxp(opts = {}) {
        trace('projects.syncFromCxp')(opts);
        return syncProjectsFromCxp(opts);
      },
    },

    // ---- ask Claude to do something, scoped to specific files -----------
    claude: {
      /**
       * Run an instruction over a set of files and get the reply text back.
       * `silent: true` always — a script's own call is not a chat turn for
       * any project, and its output is the script's to do with as it pleases.
       */
      async run({ instruction, files = [], skill = null, label = 'Script run' }) {
        trace('claude.run')(instruction, `${files.length} file(s)`);
        const started = await startChatRun({
          message: instruction, files, skillName: skill, label,
          silent: true, resetSession: true,
        });
        return new Promise((resolve, reject) => {
          const off = runsStore.subscribe(started.runId, (e) => {
            if (e.type !== 'finished' && e.type !== 'closed-buffer') return;
            off?.();
            const run = runsStore.get(started.runId);
            if (run?.status === 'done') resolve(run.text || '');
            else reject(new Error(`claude.run ended as ${run?.status}`));
          });
        });
      },
    },

    // ---- build a real .xlsx from scratch -----------------------------
    excel: {
      /**
       * `new warp.excel.Workbook()` — exceljs's own class, unwrapped. Every
       * other member of `warp` wraps a host call with `trace()`; this one
       * can't be wrapped the same way without reimplementing exceljs's whole
       * API surface, so it's handed over directly and its use only shows up
       * in the script's own `console.log`, not the run log's call trace.
       *
       * That also means it is **not fully sandboxed** — `workbook.xlsx
       * .writeFile(path)` is exceljs's own real method, with its own real
       * `fs` access, and calling it writes wherever `path` says, the same
       * way `require('fs')` would if it were exposed directly. Use
       * `excel.save()` below instead; it never lets a path reach the script.
       */
      Workbook: ExcelJS.Workbook,

      /**
       * The sanctioned way to get a workbook onto disk: builds the bytes in
       * memory (`workbook.xlsx.writeBuffer()`, exceljs's own no-disk-access
       * method) and writes them with this module's own `writeFileSync` into
       * the documents library — the same root `warp.approvals.propose()`
       * expects a `path` to already live under. A script never chooses the
       * destination path itself, only a name.
       */
      async save(workbook, name, { folder = '' } = {}) {
        trace('excel.save')(name);
        const cfg = loadConfig();
        const safeName = `${slug(name || 'workbook')}.xlsx`;
        const safeFolder = folder ? slug(folder) : '';
        const dir = safeFolder ? join(cfg.docsDir, safeFolder) : cfg.docsDir;
        const path = join(dir, safeName);

        // slug() already strips separators, but assert containment anyway —
        // the same belt-and-suspenders check library.js's saveDocument() uses.
        if (!resolve(path).startsWith(resolve(cfg.docsDir) + sep) && resolve(path) !== resolve(cfg.docsDir)) {
          throw new Error('refusing to write outside the documents folder');
        }

        const buffer = await workbook.xlsx.writeBuffer();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, buffer);
        library.refresh();
        return { path, name: safeName, folder: safeFolder };
      },
    },

    // ---- propose something for a person to approve -----------------------
    approvals: {
      /** A script never delivers directly — same rule as every workflow. */
      propose({ title, path, body, kind = path ? 'document' : 'email', projectId = null }) {
        trace('approvals.propose')(title);
        return propose({ title, path, body, kind, projectId });
      },
      pending() {
        trace('approvals.pending')();
        return listApprovals({ status: 'pending' });
      },
    },

    // ---- surface something in the bell, without waiting for a schedule --
    notify: {
      say(title, body = '') {
        trace('notify.say')(title);
        return notify({ kind: 'schedule_started', title, body });
      },
    },

    window: { resolve: resolveWindow },
  };
}
