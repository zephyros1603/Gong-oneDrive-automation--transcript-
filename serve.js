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
import {
  readFileSync, existsSync, writeFileSync, copyFileSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, extname, resolve, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Gong, loadConfig, download, filterMe, filterDates, ymd, daysAgo,
} from './gong.js';
import { organize } from './organize.js';

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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
    GONG_SORTED_DIR: join(cfg.outDir, '..', 'sorted'),
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
// connection test
// ---------------------------------------------------------------------------

/** "a=1; b=2" -> Map. Values may themselves contain "=" (JWTs, base64). */
function cookieMap(raw) {
  const m = new Map();
  for (const part of String(raw).split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    m.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return m;
}

function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
  } catch {
    return null;
  }
}

/**
 * The cookie is self-describing if you read it: `cell` and `last-login` are
 * JWTs carrying the account email (`gu`) and an expiry (`exp`), and
 * cf_clearance embeds its issue time as the second dash-separated field. So
 * a fair amount can be reported before making a single request.
 */
function inspectCookie(raw) {
  const jar = cookieMap(raw);

  // Determined by dropping cookies one at a time against the live API:
  // `last-login` alone authenticates AND searches successfully. `g-session`,
  // `cf_clearance`, `cell`, `__cf_bm` and `AWSALB` are all individually
  // droppable, and cf_clearance is frequently absent entirely because
  // Cloudflare only issues it after a challenge. So `last-login` is the only
  // cookie worth blocking on; everything else is sent because a browser
  // would send it, not because it is known to be needed.
  const critical = ['last-login'];
  const helpful = ['g-session', 'cell', 'cf_clearance', '__cf_bm', 'AWSALB', 'ajs_user_id'];

  const cell = jwtPayload(jar.get('cell'));
  const lastLogin = jwtPayload(jar.get('last-login'));

  let cfIssued = null;
  const cf = jar.get('cf_clearance');
  if (cf) {
    const ts = Number(String(cf).split('-')[1]);
    if (Number.isFinite(ts) && ts > 1e9) cfIssued = ts * 1000;
  }

  return {
    count: jar.size,
    bytes: String(raw).length,
    missing: critical.filter((k) => !jar.has(k)),
    absentHelpful: helpful.filter((k) => !jar.has(k)),
    email: cell?.gu || lastLogin?.gu || null,
    cellExpires: cell?.exp ? cell.exp * 1000 : null,
    loginExpires: lastLogin?.exp ? lastLogin.exp * 1000 : null,
    identityProvider: lastLogin?.gp || null,
    cfIssued,
    cellRegion: cell?.cell || null,
  };
}

/**
 * Probe the session in the order things actually fail: cookie shape, then
 * auth, then workspace listing, then an actual filtered search. A cookie can
 * authenticate and still be unable to search, so the last step is the one
 * that proves the app will work.
 */
async function testConnection(body) {
  const overrides = {};
  if (body.GONG_COOKIE) overrides.GONG_COOKIE = body.GONG_COOKIE;
  if (body.GONG_HOST) overrides.GONG_HOST = body.GONG_HOST;
  if (body.GONG_WORKSPACE_ID) overrides.GONG_WORKSPACE_ID = body.GONG_WORKSPACE_ID;

  const cfg = loadConfig(overrides);
  const cookie = inspectCookie(cfg.cookie);
  const checks = [];
  const result = { host: cfg.host, cookie, checks, ok: false };

  if (cookie.missing.length) {
    checks.push({
      step: 'cookie', ok: false,
      detail: `missing ${cookie.missing.join(', ')} — the session cookie is not present, sign in to Gong first`,
    });
    return result;
  }
  checks.push({ step: 'cookie', ok: true, detail: `${cookie.count} cookies, all critical ones present` });

  const gong = new Gong(cfg);

  // 1. auth
  const started = Date.now();
  let rtkn;
  try {
    rtkn = await fetch(`${cfg.base}/ajax/common/rtkn`, {
      headers: { cookie: cfg.cookie, accept: 'application/json' },
    });
  } catch (err) {
    checks.push({ step: 'auth', ok: false, detail: `cannot reach ${cfg.host}: ${err.message}` });
    return result;
  }
  if (!rtkn.ok) {
    // A wrong tenant host answers 401 too, so name both causes rather than
    // sending someone off to re-copy a cookie that was fine.
    const why = rtkn.status === 401 || rtkn.status === 403
      ? `the cookie has expired, or ${cfg.host} is not your tenant`
      : 'unexpected response';
    checks.push({ step: 'auth', ok: false, detail: `HTTP ${rtkn.status} — ${why}` });
    return result;
  }

  const token = jsonOrNull(await rtkn.text())?.token;
  if (!token) {
    checks.push({ step: 'auth', ok: false, detail: 'no CSRF token returned' });
    return result;
  }
  gong.csrf = token;
  const jwt = jwtPayload(token);
  gong.userId = cfg.userId || (jwt?.userId != null ? String(jwt.userId) : null);
  result.userId = gong.userId;
  result.csrfExpires = jwt?.exp ? jwt.exp * 1000 : null;
  checks.push({
    step: 'auth', ok: true,
    detail: `authenticated as ${cookie.email || gong.userId} in ${Date.now() - started} ms`,
  });

  // 2. workspaces
  try {
    result.workspaces = await gong.workspaces();
    gong.workspaceId = cfg.workspaceId || result.workspaces[0]?.id;
    checks.push({
      step: 'workspaces', ok: true,
      detail: result.workspaces.map((w) => w.name).join(', ') || 'none visible',
    });
  } catch (err) {
    checks.push({ step: 'workspaces', ok: false, detail: err.message });
    return result;
  }

  // 3. the search that the app actually depends on
  try {
    const page = await gong.post(
      `/conversations/ajax/results?workspace-id=${gong.workspaceId}`,
      {
        callsSearchJson: JSON.stringify({
          search: { type: 'And', filters: [filterMe(gong.userId)] },
          sort: null,
        }),
        pageSize: 1,
        callsOffset: 0,
      }
    );
    result.myCalls = page.numOfTotalItemsThatPassedFilter ?? 0;
    checks.push({
      step: 'search', ok: true,
      detail: `${result.myCalls} call${result.myCalls === 1 ? '' : 's'} visible to you`,
    });
  } catch (err) {
    checks.push({
      step: 'search', ok: false,
      detail: `${err.message} — auth works but search does not; try another workspace`,
    });
    return result;
  }

  result.ok = true;
  return result;
}

const jsonOrNull = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ---------------------------------------------------------------------------
// cookie intake (Chrome extension)
// ---------------------------------------------------------------------------

// Bumped whenever the cookie changes on disk, so an open UI can notice that
// the extension delivered a fresh one and refill itself.
let cookieVersion = Date.now();

/**
 * Accept a cookie pushed by the browser extension. Verified before it is
 * written, so a bad paste can never replace a working cookie in gong.env.
 */
async function receiveCookie(body) {
  const cookie = String(body.cookie || '').trim();
  if (!cookie) return { ok: false, fatal: 'no cookie in the request' };

  const host = String(body.host || '').trim() || loadConfig().host;
  const test = await testConnection({ GONG_COOKIE: cookie, GONG_HOST: host });

  if (!test.ok) return { ...test, saved: false };

  saveEnv({ GONG_COOKIE: cookie, GONG_HOST: host });
  cookieVersion = Date.now();

  console.log(
    `  ✓ cookie received from ${body.source || 'extension'} — ` +
    `${test.cookie.email || test.userId}, ${test.myCalls} calls, ` +
    `expires ${new Date(test.cookie.cellExpires).toLocaleString()}`
  );
  return { ...test, saved: true };
}

// ---------------------------------------------------------------------------
// transcript browser
// ---------------------------------------------------------------------------

const PREVIEWABLE = /\.(md|txt|srt|vtt)$/i;

/**
 * The only directories the preview endpoints will read from. Everything is
 * resolved and prefix-checked against these, so a crafted `path` cannot walk
 * out into the rest of the filesystem.
 */
function previewRoots() {
  const cfg = loadConfig();
  return [
    { label: 'by day', path: resolve(cfg.outDir) },
    { label: 'sorted', path: resolve(join(cfg.outDir, '..', 'sorted')) },
  ].filter((r, i, all) => all.findIndex((o) => o.path === r.path) === i);
}

function insideRoot(target) {
  const abs = resolve(target);
  return previewRoots().some(
    (r) => abs === r.path || abs.startsWith(r.path + sep)
  );
}

function listTranscripts() {
  const out = [];

  const walk = (dir, root) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }

    // organize.js marks every tree it writes. A sorted tree left inside the
    // day tree would otherwise be listed as "by day" with `sorted/...` group
    // names, so re-root the subtree instead of inheriting the wrong label.
    const here = entries.includes('.gong-sorted')
      ? { label: 'sorted', path: dir }
      : root;

    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }

      if (st.isDirectory()) walk(path, here);
      else if (PREVIEWABLE.test(name)) {
        const rel = relative(here.path, path);
        const parts = rel.split(sep);
        out.push({
          path,
          rel,
          name,
          group: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
          root: here.label,
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  };

  for (const root of previewRoots()) walk(root.path, root);

  // Day tree first (that is what a run just wrote), newest first within each.
  const rank = (r) => (r === 'by day' ? 0 : 1);
  out.sort((a, b) => rank(a.root) - rank(b.root) || b.mtime - a.mtime);
  return out;
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
      return json(res, 200, { cookieVersion });
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
      return json(res, 200, {
        roots: previewRoots().map((r) => ({ label: r.label, path: r.path })),
        files: listTranscripts(),
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

      return json(res, 200, {
        path: abs,
        name: basename(abs),
        size: st.size,
        mtime: st.mtimeMs,
        content: readFileSync(abs, 'utf8'),
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
