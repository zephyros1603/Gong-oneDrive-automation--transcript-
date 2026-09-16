#!/usr/bin/env node
/**
 * serve.js — local web UI for gong.js.
 *
 *   node serve.js            # http://127.0.0.1:7878
 *   node serve.js --port 9000
 *
 * Why a local server rather than a plain HTML file: the page needs to read
 * gong.env to prefill itself, write transcripts to disk, and reach Gong's
 * internal API with your session cookie. A browser can do none of those from
 * a file:// page or a hosted origin — CORS blocks the API calls and there is
 * no filesystem. So the browser only renders; this process does the work.
 *
 * Binds to loopback only. The cookie never leaves your machine.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, Gong } from './gong.js';
import { organize } from './organize.js';
import * as library from './library.js';
import {
  listSkills, addSkill, claudeBin,
  listJobs, cancelJob, cancelAll, killAllNow,
  scanClaudeProcesses, killClaudePids,
} from './claude-runner.js';
import { readSettings, writeSettings, usageSummary } from './settings.js';
import * as runs from './runs.js';
import * as projects from './projects.js';
import {
  writeAutomation, schedulerState, tick, startPipelineRun,
} from './automation.js';

// The work itself lives in core/ — this file is only the HTTP layer.
import { envDefaults, saveEnv } from './core/env.js';
import { pullTranscripts } from './core/gong/pull.js';
import { testConnection } from './core/gong/diagnose.js';
import { receiveCookie, cookieVersion } from './core/gong/cookie.js';
import { startChatRun } from './core/chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const PORT = Number(flag('--port', 7878));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
};

// ---------------------------------------------------------------------------
// http streaming
// ---------------------------------------------------------------------------

/** Server-sent events: one JSON object per message, streamed as it happens. */
function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let open = true;
  res.on('close', () => { open = false; });
  return {
    send(event) {
      if (open) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      if (open) res.end();
    },
    get open() { return open; },
  };
}

// ---------------------------------------------------------------------------
// transcript browser
// ---------------------------------------------------------------------------

// The index lives in library.js so the Workbench, the preview sidebar and the
// organizer all see the same files, roots and path guard.
const PREVIEWABLE = library.PREVIEWABLE;
const previewRoots = () => library.roots();
const insideRoot = (target) => library.isReadable(target);
const listTranscripts = () => library.listFiles();

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });

/**
 * The extension calls in from a chrome-extension:// origin, which needs CORS.
 * Only extension origins are allowed — a random web page must not be able to
 * push cookies into this server, even on loopback.
 */
function allowExtension(req, res) {
  const origin = req.headers.origin || '';
  if (!/^chrome-extension:\/\//.test(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('vary', 'origin');
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/cookie') {
      allowExtension(req, res);

      if (req.method === 'OPTIONS') {           // preflight
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET') {               // extension's reachability probe
        return json(res, 200, { up: true, host: loadConfig().host });
      }
      if (req.method === 'POST') {
        try {
          return json(res, 200, await receiveCookie(await readBody(req)));
        } catch (err) {
          return json(res, 200, { ok: false, saved: false, fatal: err.message || String(err) });
        }
      }
    }

    if (url.pathname === '/api/pulse' && req.method === 'GET') {
      return json(res, 200, {
        cookieVersion: cookieVersion(),
        inputVersion: library.version('input'),
        outputVersion: library.version('output'),
      });
    }

    // --- workbench ---------------------------------------------------------
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, readSettings());
      if (req.method === 'POST') return json(res, 200, writeSettings(await readBody(req)));
    }

    if (url.pathname === '/api/skills') {
      if (req.method === 'GET') {
        const skills = listSkills();
        const names = new Set(skills.map((s) => s.name));
        return json(res, 200, {
          cli: claudeBin(),
          skills,
          // An action whose skill is not installed is a blueprint: the button
          // still shows, but says so rather than failing at run time.
          actions: readSettings().actions.map((a) => ({
            ...a,
            installed: names.has(a.skill),
          })),
        });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const made = addSkill(body);

          // Adding a skill almost always means wanting a button for it.
          if (body.addButton !== false) {
            const current = readSettings();
            const id = made.dir;
            writeSettings({
              actions: [
                ...current.actions.filter((a) => a.id !== id),
                {
                  id,
                  label: String(body.label || body.name || id).slice(0, 18),
                  title: String(body.description || '').slice(0, 120),
                  skill: made.name,
                  instruction: body.instruction
                    || `generate the ${body.label || body.name} from the transcript file`,
                  builtin: false,
                },
              ],
            });
          }
          return json(res, 200, { ok: true, ...made });
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message });
        }
      }
    }

    if (url.pathname === '/api/tree' && req.method === 'GET') {
      return json(res, 200, {
        outputDir: readSettings().outputDir,
        roots: library.roots().map((r) => ({
          label: r.label, path: r.path, kind: r.kind, exists: existsSync(r.path),
        })),
        folders: library.listFolders(),
        files: library.listFiles(),
        inputVersion: library.version('input'),
        outputVersion: library.version('output'),
      });
    }

    // ================= projects =================
    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') {
        return json(res, 200, {
          projects: projects.listProjects(),
          active: runs.list({ active: true }),
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.sync) return json(res, 200, projects.syncFromLibrary());
        return json(res, 200, projects.createProject(body));
      }
    }

    if (url.pathname.startsWith('/api/projects/')) {
      const [, , , id, action] = url.pathname.split('/');
      const project = projects.getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });

      if (action === 'reset-session' && req.method === 'POST') {
        // Deliberate: attaching new transcripts to an existing conversation
        // resends everything already in context.
        return json(res, 200, projects.resetSession(id));
      }

      if (!action && req.method === 'GET') {
        return json(res, 200, {
          project,
          active: runs.list({ projectId: id, active: true }),
        });
      }
      if (!action && req.method === 'POST') {
        return json(res, 200, projects.updateProject(id, await readBody(req)));
      }
      if (!action && req.method === 'DELETE') {
        return json(res, 200, { deleted: projects.deleteProject(id) });
      }
    }

    // ================= runs =================
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      return json(res, 200, {
        runs: runs.list(projectId ? { projectId } : {}),
      });
    }

    if (url.pathname === '/api/runs' && req.method === 'POST') {
      try {
        return json(res, 200, await startChatRun(await readBody(req)));
      } catch (err) {
        return json(res, 400, { error: err.message || String(err) });
      }
    }

    if (url.pathname.startsWith('/api/runs/')) {
      const [, , , id, action] = url.pathname.split('/');

      if (action === 'cancel' && req.method === 'POST') {
        return json(res, 200, { cancelled: runs.cancel(id) });
      }

      // The point of the whole design: a page can attach at any time, replay
      // everything it missed, then follow along live.
      if (action === 'stream' && req.method === 'GET') {
        const run = runs.get(id);
        if (!run) return json(res, 404, { error: 'no such run' });

        const stream = sse(res);
        const off = runs.subscribe(id, (e) => stream.send(e));

        if (run.status !== 'running') { off?.(); return stream.end(); }
        // Detaching must NOT cancel: switching tabs is not a reason to throw
        // away work. The Stop button and Processes popover remain the way to
        // end a run.
        res.on('close', () => off?.());
        return;
      }

      if (!action && req.method === 'GET') {
        const run = runs.get(id);
        if (!run) return json(res, 404, { error: 'no such run' });
        return json(res, 200, { ...runs.summarise(run), text: run.text, events: run.events });
      }
    }

    // ================= automation =================
    if (url.pathname === '/api/automation') {
      if (req.method === 'GET') {
        return json(res, 200, {
          ...schedulerState(),
          active: runs.list({ active: true }).filter((r) => r.kind === 'automation'),
          recent: runs.list({}).filter((r) => r.kind === 'automation').slice(0, 10),
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        writeAutomation({
          enabled: Boolean(body.enabled),
          time: body.time || '09:00',
          days: Array.isArray(body.days) ? body.days : [1, 2, 3, 4, 5],
          daysBack: Number(body.daysBack) || 2,
          organize: body.organize !== false,
          organizeBy: body.organizeBy === 'call' ? 'call' : 'customer',
          organizeMode: ['copy', 'link', 'move'].includes(body.organizeMode) ? body.organizeMode : 'copy',
          graceMinutes: Number(body.graceMinutes) || 20,
        });
        return json(res, 200, schedulerState());
      }
    }

    if (url.pathname === '/api/automation/run' && req.method === 'POST') {
      const body = await readBody(req);
      const run = startPipelineRun({ trigger: 'manual', daysBack: body.daysBack });
      return json(res, 200, runs.summarise(run));
    }

    if (url.pathname === '/api/running' && req.method === 'GET') {
      return json(res, 200, { jobs: listJobs(), usage: usageSummary() });
    }

    if (url.pathname === '/api/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.id) return json(res, 200, { cancelled: cancelJob(body.id) ? 1 : 0 });
      return json(res, 200, { cancelled: cancelAll() });
    }

    if (url.pathname === '/api/usage' && req.method === 'GET') {
      return json(res, 200, usageSummary());
    }

    // Every Claude CLI process on the machine, classified. Read-only: the UI
    // shows this before offering to kill anything.
    if (url.pathname === '/api/claude-processes' && req.method === 'GET') {
      const found = scanClaudeProcesses();
      return json(res, 200, {
        processes: found,
        counts: {
          app: found.filter((p) => p.kind === 'app').length,
          terminal: found.filter((p) => p.kind === 'terminal').length,
          ide: found.filter((p) => p.kind === 'ide').length,
        },
      });
    }

    if (url.pathname === '/api/kill-claude' && req.method === 'POST') {
      const body = await readBody(req);
      const found = scanClaudeProcesses();

      // Only the kinds explicitly asked for. `ide` is never included by
      // default — that is the Claude Code session in the editor, and killing
      // it ends whatever work is open there.
      const kinds = Array.isArray(body.kinds) && body.kinds.length
        ? body.kinds
        : ['app'];

      const targets = found.filter((p) => kinds.includes(p.kind));

      // Jobs this server owns go through the registry so their runs are
      // recorded and their streams told, rather than being killed behind
      // the app's back.
      const appCancelled = kinds.includes('app') ? cancelAll() : 0;

      const killed = killClaudePids(
        targets.filter((p) => p.kind !== 'app').map((p) => p.pid)
      );

      return json(res, 200, {
        requested: kinds,
        appCancelled,
        killed: killed.map((p) => ({ pid: p.pid, kind: p.kind, command: p.command })),
        remaining: scanClaudeProcesses().length,
      });
    }

    // --- api ---------------------------------------------------------------
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, envDefaults());
    }

    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = loadConfig(body.GONG_COOKIE ? { GONG_COOKIE: body.GONG_COOKIE } : {});
      const gong = new Gong(cfg);
      const rtkn = await fetch(`${cfg.base}/ajax/common/rtkn`, {
        headers: { cookie: cfg.cookie, accept: 'application/json' },
      });
      if (!rtkn.ok) return json(res, 502, { error: `HTTP ${rtkn.status}` });
      gong.csrf = JSON.parse(await rtkn.text()).token;
      return json(res, 200, { workspaces: await gong.workspaces() });
    }

    if (url.pathname === '/api/test' && req.method === 'POST') {
      try {
        return json(res, 200, await testConnection(await readBody(req)));
      } catch (err) {
        return json(res, 200, { ok: false, fatal: err.message || String(err), checks: [] });
      }
    }

    if (url.pathname === '/api/files' && req.method === 'GET') {
      const files = listTranscripts();
      // Report each root's existence and count, so an empty sidebar can say
      // which folders it actually searched instead of just looking broken.
      return json(res, 200, {
        roots: previewRoots().map((r) => ({
          label: r.label,
          path: r.path,
          exists: existsSync(r.path),
          count: files.filter((f) => f.path.startsWith(r.path + sep)).length,
        })),
        files,
      });
    }

    if (url.pathname === '/api/file' && req.method === 'GET') {
      const target = url.searchParams.get('path') || '';

      if (!target || !insideRoot(target) || !PREVIEWABLE.test(target)) {
        return json(res, 403, { error: 'that path is not previewable' });
      }
      const abs = resolve(target);
      if (!existsSync(abs)) return json(res, 404, { error: 'no such file' });

      const st = statSync(abs);
      if (st.size > 4e6) return json(res, 413, { error: 'file too large to preview' });

      // ?raw=1 serves the bytes, which is how a generated .docx gets
      // downloaded — those cannot be rendered in the browser.
      if (url.searchParams.get('raw')) {
        res.writeHead(200, {
          'content-type': MIME[extname(abs)] || 'application/octet-stream',
          'content-disposition': `attachment; filename="${basename(abs).replace(/"/g, '')}"`,
          'content-length': st.size,
        });
        return res.end(readFileSync(abs));
      }

      const meta = library.readFile(abs);
      return json(res, 200, {
        path: meta.path,
        name: meta.name,
        size: meta.size,
        mtime: meta.mtime,
        binary: meta.binary,
        content: meta.content,
      });
    }

    if (url.pathname === '/api/organize' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, organize({
          by: body.by,
          src: body.src,
          out: body.out,
          mode: body.mode,
          dryRun: Boolean(body.dryRun),
        }));
      } catch (err) {
        return json(res, 200, { ok: false, fatal: err.message || String(err), groups: [] });
      }
    }

    if (url.pathname === '/api/save-env' && req.method === 'POST') {
      return json(res, 200, saveEnv(await readBody(req)));
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      const params = await readBody(req);
      const stream = sse(res);
      try {
        await pullTranscripts(params, (e) => stream.send(e));
      } catch (err) {
        stream.send({ type: 'error', message: err.message || String(err) });
      }
      return stream.end();
    }

    // --- static ------------------------------------------------------------
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(HERE, 'ui', file);

    // Serve only out of ui/, never anywhere else on disk.
    if (!path.startsWith(join(HERE, 'ui')) || !existsSync(path)) {
      return json(res, 404, { error: 'not found' });
    }

    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    return res.end(readFileSync(path));
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { error: err.message || String(err) });
    res.end();
  }
});

// Loopback only — this endpoint runs downloads with your live Gong session.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Gong transcript UI  →  http://127.0.0.1:${PORT}\n`);
  console.log('  Ctrl-C to stop.\n');
});

/**
 * Nothing spawned by this server may outlive it.
 *
 * A child `claude` does not die with its parent on macOS, so without these
 * handlers stopping the server would orphan a running agent that carried on
 * billing with no way left to see or cancel it.
 */
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  const killed = killAllNow();
  if (killed) {
    console.log(`\n  stopped ${killed} running Claude job(s) before exit`);
  }

  server.close(() => process.exit(0));
  // Do not wait forever on lingering keep-alive sockets.
  setTimeout(() => process.exit(0), 1500).unref();
}

/**
 * The scheduler lives here rather than in launchd, so it can never wake the
 * Mac and a slot that passes while asleep is simply missed.
 */
setInterval(() => {
  tick(({ trigger }) => startPipelineRun({ trigger })).catch((err) => {
    console.error('  automation tick:', err?.message || err);
  });
}, 30000);

setInterval(() => runs.prune(), 15 * 60000);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// A crash must not leak children either.
process.on('exit', () => { killAllNow(); });
process.on('uncaughtException', (err) => {
  console.error('  uncaught:', err?.message || err);
  shutdown();
});
