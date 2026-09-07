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
import { readFileSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Gong, loadConfig, download, filterMe, filterDates, ymd, daysAgo,
} from './gong.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, 'gong.env');

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
};

// ---------------------------------------------------------------------------
// gong.env round-tripping
// ---------------------------------------------------------------------------

/** Raw values straight out of gong.env, for prefilling the form. */
function envDefaults() {
  const cfg = loadConfig();
  return {
    GONG_HOST: cfg.host,
    GONG_COOKIE: cfg.cookie,
    GONG_WORKSPACE_ID: cfg.workspaceId,
    GONG_USER_ID: cfg.userId,
    GONG_ACCOUNT_ID: cfg.accountId,
    GONG_DAY_FROM: cfg.dayFrom || daysAgo(7),
    GONG_DAY_TO: cfg.dayTo || ymd(new Date()),
    GONG_FORMAT: cfg.format,
    GONG_OUT_DIR: cfg.outDir,
    GONG_RAW_DIR: cfg.rawDir,
    GONG_CONCURRENCY: String(cfg.concurrency),
  };
}

/**
 * Rewrite values in gong.env in place, preserving comments, ordering and any
 * key the UI does not manage (NODE_BIN). A .bak copy is kept because this
 * overwrites the file holding a credential.
 */
function saveEnv(updates) {
  const original = readFileSync(ENV_PATH, 'utf8');
  copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);

  const lines = original.split('\n');
  const seen = new Set();

  const rewritten = lines.map((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_]\w*)(\s*=\s*)(.*)$/.exec(line);
    if (!m) return line;

    const [, lead, key, eq, rest] = m;
    if (!(key in updates)) return line;
    seen.add(key);

    // Keep any inline comment that followed the old value.
    const quoted = /^(['"])((?:\\.|(?!\1).)*)\1(.*)$/.exec(rest);
    const trailing = quoted ? quoted[3] : '';
    return `${lead}${key}${eq}'${String(updates[key]).replace(/'/g, "'\\''")}'${trailing}`;
  });

  const missing = Object.keys(updates).filter((k) => !seen.has(k));
  if (missing.length) {
    rewritten.push('', '# --- added by the web UI ---');
    for (const k of missing) rewritten.push(`${k}='${updates[k]}'`);
  }

  writeFileSync(ENV_PATH, rewritten.join('\n'), { mode: 0o600 });
  return { saved: Object.keys(updates).length, backup: `${ENV_PATH}.bak` };
}

// ---------------------------------------------------------------------------
// run
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

async function runJob(params, stream) {
  const overrides = {};
  for (const key of [
    'GONG_HOST', 'GONG_COOKIE', 'GONG_WORKSPACE_ID', 'GONG_USER_ID',
    'GONG_ACCOUNT_ID', 'GONG_FORMAT', 'GONG_OUT_DIR', 'GONG_RAW_DIR',
    'GONG_CONCURRENCY',
  ]) {
    if (params[key]) overrides[key] = params[key];
  }

  const cfg = loadConfig(overrides);
  const mode = params.mode || 'me';

  stream.send({ type: 'stage', stage: 'auth', message: 'Authenticating with Gong' });
  const gong = await new Gong(cfg).init();
  stream.send({
    type: 'identity',
    host: cfg.host,
    userId: gong.userId,
    workspaceId: gong.workspaceId,
    outDir: cfg.outDir,
  });

  const from = params.days ? daysAgo(Number(params.days)) : params.from;
  const to = params.days ? ymd(new Date()) : params.to;

  let calls = [];

  if (mode === 'call') {
    const ids = String(params.callIds || '')
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!ids.length) throw new Error('enter at least one call id');

    stream.send({ type: 'stage', stage: 'search', message: `${ids.length} call id(s)` });
    // No search metadata here: download() recovers title and date from each
    // transcript payload instead of dumping them in unknown-date/.
    calls = ids.map((id) => ({ id, title: id, status: 'COMPLETED', access: true, started: '' }));
    for (const c of calls) stream.send({ type: 'found', count: calls.length, title: c.id });
  } else if (mode === 'account') {
    let accountId = params.GONG_ACCOUNT_ID || cfg.accountId;

    if (params.accountName) {
      stream.send({ type: 'stage', stage: 'search', message: `Resolving "${params.accountName}"` });
      accountId = await gong.accountIdByName(params.accountName);
      if (!accountId) throw new Error(`no account matched: ${params.accountName}`);
      stream.send({ type: 'resolved', accountId, name: params.accountName });
    }
    if (!accountId) throw new Error('enter an account id or an account name');

    stream.send({ type: 'stage', stage: 'search', message: `Account activity · ${from} .. ${to}` });
    const acts = await gong.dayActivities(accountId, from, to);

    // A MEETING can carry a composite Outlook id with no Gong recording
    // behind it; only bare numeric ids are fetchable.
    calls = acts
      .filter((a) => (a.type === 'CALL' || a.type === 'MEETING') && /^\d+$/.test(a.id))
      .map((a) => ({
        id: a.id,
        title: a.title || a.id,
        status: a.status,
        access: true,
        started: a.day ? `${a.day.replace(/-/g, '/')} 00:00:00` : '',
      }));

    const dropped = acts.filter(
      (a) => (a.type === 'CALL' || a.type === 'MEETING') && !/^\d+$/.test(a.id)
    ).length;
    if (dropped) stream.send({ type: 'note', message: `${dropped} non-call activity skipped` });

    for (const c of calls) stream.send({ type: 'found', count: calls.length, title: c.title });
  } else {
    stream.send({ type: 'stage', stage: 'search', message: `Your calls · ${from} .. ${to}` });
    for await (const c of gong.search([filterMe(gong.userId), filterDates(from, to)])) {
      calls.push(c);
      stream.send({ type: 'found', count: calls.length, title: c.title });
    }
  }

  if (!calls.length) {
    stream.send({ type: 'complete', ok: 0, skipped: 0, failed: 0, outDir: cfg.outDir, calls: [] });
    return;
  }

  stream.send({
    type: 'stage',
    stage: 'download',
    message: 'Fetching transcripts',
    total: calls.length,
  });

  const tally = await download(gong, calls, {
    ...cfg,
    dryRun: Boolean(params.dryRun),
    onEvent: (e) => stream.send(e),
  });

  stream.send({
    type: 'complete',
    ok: tally.ok,
    skipped: tally.skipped,
    failed: tally.failed,
    dryRun: Boolean(params.dryRun),
    outDir: cfg.outDir,
    calls: (tally.planned || []).map((c) => ({
      id: c.id, title: c.title, day: c.day, path: c.path, status: c.status,
    })),
  });
}

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
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

    if (url.pathname === '/api/save-env' && req.method === 'POST') {
      return json(res, 200, saveEnv(await readBody(req)));
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      const params = await readBody(req);
      const stream = sse(res);
      try {
        await runJob(params, stream);
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
