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
import { refreshDigest, digestStatus } from '../workflow/digest.js';
import { resolveWindow } from '../workflow/window.js';
import { propose, listApprovals } from '../approvals/store.js';
import { startChatRun } from '../chat.js';
import { notify } from '../notify.js';
import * as projectsStore from '../../projects.js';
import * as library from '../../library.js';
import * as runsStore from '../../runs.js';
import { readFileSync } from 'node:fs';

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
      async projectDetail(projectId, opts = {}) {
        trace('cxp.projectDetail')(projectId);
        return cx.projectDetail(projectId, opts);
      },
      async action(name, params = {}) {
        trace('cxp.action')(name, params);
        return cx.action(name, params);
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

    // ---- per-customer digest --------------------------------------------
    context: {
      async digest(projectId, opts = {}) {
        trace('context.digest')(projectId);
        return refreshDigest(projectId, opts);
      },
      status() {
        trace('context.status')();
        return digestStatus();
      },
    },

    // ---- Warp's own customer list ----------------------------------------
    projects: {
      list() {
        trace('projects.list')();
        return projectsStore.listProjects().map((p) => ({
          id: p.id, name: p.name, customer: p.customer,
          transcriptCount: p.transcriptCount, contextCount: p.contextCount,
          digestCount: p.digestCount,
        }));
      },
      get(id) {
        trace('projects.get')(id);
        return projectsStore.getProject(id);
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
