#!/usr/bin/env node
/**
 * gong.js — one script for pulling Gong call transcripts.
 *
 * Replaces the earlier bash pipeline (gong-lib.sh, gong-my-calls.sh,
 * gong-calls.sh, fetch.sh, pagedata.py).
 *
 *   node gong.js me                          # your calls, range from gong.env
 *   node gong.js me 2026-09-01 2026-09-04
 *   node gong.js me --days 7
 *   node gong.js me --days 7 --dry-run
 *   node gong.js account --name "Creative Networking Consulting Limited"
 *   node gong.js account 8432685238695217670 2026-01-01 2026-09-04
 *   node gong.js call 2800017128684783250
 *   node gong.js workspaces
 *
 * Output lands as <GONG_OUT_DIR>/<Mon-D>/<call-title>-transcript.<ext>.
 *
 * Talks to Gong's *internal* app API with your browser session cookie:
 * undocumented, tied to UI releases, and the cookie expires within hours.
 * See README.md before scheduling this.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { convert } from './gongTranscript.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// big integers
// ---------------------------------------------------------------------------

/**
 * Gong IDs are 19-digit integers, past Number.MAX_SAFE_INTEGER. JSON.parse
 * rounds them silently — 2800017128684783250 becomes 2800017128684783000 with
 * no error. jq happened to preserve them, so the bash version never had to
 * think about this; every response parsed here does.
 *
 * Quoting on the key/value boundary (rather than anywhere in the text) keeps
 * digits inside string values untouched.
 */
const BIG_INT_FIELD = /"([A-Za-z_$][\w$]*)"\s*:\s*(-?\d{16,})(?=\s*[,}\]])/g;

export function parseBig(text) {
  return JSON.parse(text.replace(BIG_INT_FIELD, '"$1":"$2"'));
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Minimal .env reader: KEY=value, optional quotes, # comments, export prefix. */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = /^(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;

    const [, key, rest] = m;

    // A quoted value may be followed by an inline comment, so match the
    // closing quote rather than trusting the end of the line. Getting this
    // wrong turned GONG_USER_ID='' into the literal 2-char string "''",
    // which the Participants filter accepts and answers with zero results.
    const quoted = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(rest);
    out[key] = quoted ? quoted[2] : rest.split(' #')[0].trim();
  }
  return out;
}

/**
 * Resolve a configured directory. Accepts an absolute path, a ~ path, or a
 * path relative to this script — so GONG_OUT_DIR can point anywhere on disk,
 * not just inside the project.
 */
function resolveDir(value, fallback) {
  const raw = (value || fallback).trim();
  if (raw.startsWith('~')) return join(homedir(), raw.slice(1).replace(/^\/+/, ''));
  return isAbsolute(raw) ? raw : resolve(HERE, raw);
}

export function loadConfig(overrides = {}) {
  const file = parseEnvFile(join(HERE, 'gong.env'));

  // Precedence: CLI flag > real environment > gong.env. A one-off override
  // like GONG_FORMAT=srt should not be silently clobbered by the file.
  const pick = (key) =>
    overrides[key] ?? (process.env[key] || undefined) ?? file[key] ?? undefined;

  const host = pick('GONG_HOST');
  const cookie = pick('GONG_COOKIE');

  if (!host) throw new Error('set GONG_HOST in gong.env');
  if (!cookie) throw new Error('set GONG_COOKIE in gong.env');

  return {
    host,
    cookie,
    base: `https://${host}`,
    workspaceId: pick('GONG_WORKSPACE_ID') || '',
    userId: pick('GONG_USER_ID') || '',
    accountId: pick('GONG_ACCOUNT_ID') || '',
    dayFrom: pick('GONG_DAY_FROM') || '',
    dayTo: pick('GONG_DAY_TO') || '',
    format: pick('GONG_FORMAT') || 'md',
    outDir: resolveDir(pick('GONG_OUT_DIR'), 'transcripts'),
    rawDir: resolveDir(pick('GONG_RAW_DIR'), 'raw'),
    // Defaults beside the transcripts rather than inside the project, so
    // pointing GONG_OUT_DIR at an external folder keeps the sorted tree with
    // it. Set GONG_SORTED_DIR to put it anywhere.
    sortedDir: resolveDir(
      pick('GONG_SORTED_DIR'),
      join(resolveDir(pick('GONG_OUT_DIR'), 'transcripts'), '..', 'sorted')
    ),
    // Where generated documents (MOMs and the like) are written. Defaults
    // beside the transcripts so an external GONG_OUT_DIR keeps them together.
    docsDir: resolveDir(
      pick('GONG_DOCS_DIR'),
      join(resolveDir(pick('GONG_OUT_DIR'), 'transcripts'), '..', 'documents')
    ),
    // Extra folders the preview sidebar should index, colon-separated.
    previewDirs: pick('GONG_PREVIEW_DIRS') || '',
    pageSize: Number(pick('GONG_PAGE_SIZE') || 100),
    concurrency: Math.max(1, Number(pick('GONG_CONCURRENCY') || 4)),
  };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export class Gong {
  constructor(cfg) {
    this.cfg = cfg;
    this.csrf = null;
    this.userId = cfg.userId || null;
    this.workspaceId = cfg.workspaceId || null;
  }

  async init() {
    // /ajax/common/rtkn hands back a short-lived CSRF token whose JWT payload
    // also carries our own user id — so "my calls" needs nothing hardcoded.
    const rtkn = await this.#raw('/ajax/common/rtkn');
    if (!rtkn.ok) throw new Error(`cannot reach ${this.cfg.host} (HTTP ${rtkn.status})`);

    const token = parseBig(await rtkn.text())?.token;
    if (!token) throw new Error('no CSRF token — cookie in gong.env is expired');
    this.csrf = token;

    this.userId ||= jwtField(token, 'userId');
    if (!this.userId) throw new Error('could not determine your user id');

    this.workspaceId ||= (await this.workspaces())[0]?.id;
    if (!this.workspaceId) throw new Error('set GONG_WORKSPACE_ID in gong.env');

    return this;
  }

  #raw(path, init = {}) {
    return fetch(`${this.cfg.base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        cookie: this.cfg.cookie,
        accept: 'application/json, text/plain, */*',
        ...init.headers,
      },
    });
  }

  async get(path, { referer = '/home' } = {}) {
    const res = await this.#raw(path, {
      headers: { referer: `${this.cfg.base}${referer}` },
    });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return parseBig(await res.text());
  }

  /**
   * Gong rejects these POSTs unless the CSRF header, a matching referer AND a
   * matching origin are all present, and the body is JSON — form-encoded is
   * refused. Any one missing returns a bare {"error":true} 400, which reads
   * like a malformed filter and sends you looking in the wrong place.
   */
  async post(path, body) {
    const res = await this.#raw(path, {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': this.csrf,
        'content-type': 'application/json',
        referer: `${this.cfg.base}/conversations?workspace-id=${this.workspaceId}`,
        origin: this.cfg.base,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status} ${text.slice(0, 120)}`);
    return parseBig(text);
  }

  /** Workspaces come from window.pageData on the conversations page. */
  async workspaces() {
    const res = await this.#raw('/conversations', {
      headers: { accept: 'text/html' },
    });
    const pd = pageData(await res.text());
    return (pd.workspaces || []).map((w) => ({ id: String(w.id), name: w.name }));
  }

  /**
   * POST /conversations/ajax/results with a serialized filter tree:
   *   {"search":{"type":"And","filters":[...]},"sort":null}
   * An empty filters array is invalid — "search":null means no filter.
   */
  async *search(filters) {
    const search = filters.length
      ? { search: { type: 'And', filters }, sort: null }
      : { search: null, sort: null };

    const path = `/conversations/ajax/results?workspace-id=${this.workspaceId}`;
    let offset = 0;
    let total = null;

    while (true) {
      const page = await this.post(path, {
        callsSearchJson: JSON.stringify(search),
        pageSize: this.cfg.pageSize,
        callsOffset: offset,
      });

      const items = page.items || [];
      total ??= page.numOfTotalItemsThatPassedFilter ?? items.length;

      for (const c of items) {
        yield {
          id: String(c.id),
          title: c.title || 'Untitled call',
          status: c.callStatus,
          started: c.effectiveStartDateTime,
          duration: c.duration,
          owner: c.ownerName,
          access: c.userCanAccess,
        };
      }

      offset += items.length;
      if (!items.length || offset >= total) return;
    }
  }

  /** Account-scoped activity. `id` here is the Gong CRM account id. */
  async dayActivities(accountId, from, to) {
    const qs = new URLSearchParams({
      id: accountId,
      'day-from': from,
      'day-to': to,
      type: 'ACCOUNT',
      'workspace-id': this.workspaceId,
    });
    const byDay = await this.get(`/ajax/account/day-activities?${qs}`);

    return Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([day, list]) =>
        (list || []).map((a) => ({
          day,
          type: a.type,
          status: a.status,
          // On a CALL/MEETING the activity's own id IS the Gong call id.
          id: String(a.id),
          title: a.extendedData?.title || a.title || '',
        }))
      );
  }

  async accountIdByName(name) {
    const qs = new URLSearchParams({
      'workspace-id': this.workspaceId,
      q: name,
      t: 'false',
    });
    const hits = await this.get(`/search-box/ajax/fetch-suggestions?${qs}`);
    return hits.CRM_ACCOUNT?.[0]?.id ? String(hits.CRM_ACCOUNT[0].id) : null;
  }

  /** Raw transcript JSON as *text* — never pre-parsed, see parseBig above. */
  async transcriptText(callId) {
    const res = await this.#raw(`/call/detailed-transcript?call-id=${callId}`, {
      headers: { referer: `${this.cfg.base}/call?id=${callId}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    // A signed-out request comes back as login HTML at status 200.
    if (!text.trimStart().startsWith('{')) throw new Error('not JSON (session expired?)');
    return text;
  }
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

export const filterDates = (from, to) => ({ type: 'AbsoluteCallDateRange', from, to });

/**
 * Participants takes `userIds` (not `ids`), and without the role flags it
 * returns zero results instead of erroring — a silent wrong answer.
 */
export const filterMe = (userId) => ({
  type: 'Participants',
  userIds: [userId],
  host: true,
  attendee: true,
  invitee: true,
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function jwtField(token, field) {
  const part = token.split('.')[1];
  if (!part) return null;
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const value = parseBig(json)?.[field];
  return value == null ? null : String(value);
}

/** Brace-match window.pageData out of a Gong page, quote-aware. */
export function pageData(html) {
  const at = html.indexOf('pageData = {');
  if (at === -1) throw new Error('no pageData on this page (signed out?)');

  const start = html.indexOf('{', at);
  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return parseBig(html.slice(start, i + 1));
  }
  throw new Error('unterminated pageData');
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026/09/03 10:30:00" -> "Sep-3" */
export function dayFolder(started) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(started || '');
  if (!m) return 'unknown-date';
  return `${MONTHS[Number(m[2]) - 1]}-${Number(m[3])}`;
}

/** "Aquera / Pennrose: implementation calls" -> "Aquera-Pennrose-implementation-calls" */
export const slug = (title) =>
  String(title)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'untitled';

export const extFor = (format) => ({ md: 'md', srt: 'srt', vtt: 'vtt' }[format] || 'txt');

export const ymd = (d) => d.toISOString().slice(0, 10);
export const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400_000));

/** Bounded-concurrency map that preserves input order in its results. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * Pull a day folder and title out of a transcript payload. `when` is
 * M/D/YY in the payload, unlike the search API's YYYY/MM/DD.
 */
function renameFromPayload(text, call, taken, outDir, ext) {
  let data;
  try {
    data = JSON.parse(text.replace(BIG_INT_FIELD, '"$1":"$2"'));
  } catch {
    return {};
  }

  const title = data.callTitle || call.title;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(data.when || '').trim());
  const day = m ? `${MONTHS[Number(m[1]) - 1]}-${Number(m[2])}` : call.day;

  let path = join(outDir, day, `${slug(title)}-transcript.${ext}`);
  if (taken.has(path) && path !== call.path) {
    path = join(outDir, day, `${slug(title)}-${call.id.slice(-6)}-transcript.${ext}`);
  }
  taken.add(path);
  return { title, day, path };
}

export async function download(gong, calls, { dryRun, format, outDir, rawDir, concurrency, onEvent }) {
  const emit = onEvent || (() => {});
  const ext = extFor(format);

  // A recurring meeting can produce two identical titles on one day. Only
  // then disambiguate with a slice of the call id — keyed on what this run has
  // claimed, so re-running overwrites in place instead of piling up copies.
  const taken = new Set();
  const planned = calls.map((call) => {
    const day = dayFolder(call.started);
    const base = slug(call.title);
    let path = join(outDir, day, `${base}-transcript.${ext}`);
    if (taken.has(path)) {
      path = join(outDir, day, `${base}-${call.id.slice(-6)}-transcript.${ext}`);
    }
    taken.add(path);
    return { ...call, day, path };
  });

  emit({ type: 'planned', total: planned.length, calls: planned });

  if (dryRun) {
    for (const c of planned) {
      console.log(`${c.day.padEnd(7)} ${String(c.status).padEnd(10)} ${c.path}`);
    }
    return { ok: 0, skipped: 0, failed: 0, planned };
  }

  const tally = { ok: 0, skipped: 0, failed: 0 };

  const outcomes = await pool(planned, concurrency, async (c) => {
    if (c.status !== 'COMPLETED') {
      const note = `${c.status}, no transcript`;
      emit({ type: 'done', kind: 'skipped', call: c, note });
      return { c, note, kind: 'skipped' };
    }
    if (c.access !== true) {
      emit({ type: 'done', kind: 'skipped', call: c, note: 'no access' });
      return { c, note: 'no access', kind: 'skipped' };
    }

    try {
      const text = await gong.transcriptText(c.id);

      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, `${c.id}.json`), text, 'utf8');

      // `gong.js call <id>` has no search metadata to name the file from, so
      // recover the title and date from the payload itself rather than
      // dumping it in unknown-date/.
      if (!c.started) Object.assign(c, renameFromPayload(text, c, taken, outDir, ext));

      // convert() takes raw text on purpose — handing it a parsed object
      // would already have destroyed the 19-digit ids.
      const rendered = convert(text, { format, fullNames: true });

      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, rendered, 'utf8');

      emit({ type: 'done', kind: 'ok', call: c });
      return { c, kind: 'ok' };
    } catch (err) {
      emit({ type: 'done', kind: 'failed', call: c, note: err.message });
      return { c, note: err.message, kind: 'failed' };
    }
  });

  for (const { c, note, kind } of outcomes) {
    tally[kind]++;
    if (kind === 'ok') console.log(`${c.day.padEnd(7)} ✓ ${c.path}`);
    else if (kind === 'skipped') console.error(`${c.day.padEnd(7)} ~ ${c.title} — ${note}`);
    else console.error(`${c.day.padEnd(7)} ✗ ${c.title} (${c.id}) — ${note}`);
  }
  return { ...tally, planned };
}

async function cmdMe(gong, cfg, args) {
  const [from, to] = dateRange(cfg, args);

  console.error(
    `your calls · ${from} .. ${to} · workspace ${gong.workspaceId} · user ${gong.userId}`
  );

  const calls = [];
  for await (const c of gong.search([filterMe(gong.userId), filterDates(from, to)])) {
    calls.push(c);
  }

  if (!calls.length) {
    console.error('no calls found in that range');
    return 0;
  }
  console.error(`found ${calls.length} call(s)\n`);

  const t = await download(gong, calls, { ...cfg, dryRun: args.dryRun });
  console.error(`\n${t.ok} saved · ${t.skipped} skipped · ${t.failed} failed`);
  console.error(`output: ${cfg.outDir}`);
  return t.failed ? 1 : 0;
}

async function cmdAccount(gong, cfg, args) {
  let accountId = args.positional[0] || cfg.accountId;

  if (args.name) {
    accountId = await gong.accountIdByName(args.name);
    if (!accountId) throw new Error(`no account matched: ${args.name}`);
    console.error(`resolved "${args.name}" -> ${accountId}`);
  }
  if (!accountId) {
    throw new Error('no account id: pass one, set GONG_ACCOUNT_ID, or use --name');
  }

  const [from, to] = dateRange(cfg, args, 1);
  console.error(`account ${accountId} · ${from} .. ${to} · workspace ${gong.workspaceId}`);

  const acts = await gong.dayActivities(accountId, from, to);
  const calls = acts.filter((a) => a.type === 'CALL' || a.type === 'MEETING');

  if (args.idsOnly) {
    // A MEETING can carry a composite Outlook id like "3295...596.0400...",
    // which is a calendar entry with no Gong recording behind it. Only bare
    // numeric ids are fetchable call ids.
    const fetchable = calls.filter((c) => c.status === 'COMPLETED' && /^\d+$/.test(c.id));
    for (const c of fetchable) console.log(c.id);

    const dropped = calls.length - fetchable.length;
    if (dropped) console.error(`(${dropped} non-call activity skipped)`);
    return 0;
  }

  const rows = [['DATE', 'TYPE', 'STATUS', 'CALL_ID', 'TITLE'],
                ...calls.map((c) => [c.day, c.type, c.status, c.id, c.title])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) {
    console.log(r.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd());
  }

  const emails = acts.filter((a) => a.type === 'EMAIL').length;
  console.error(`\n${acts.length} activities · ${emails} email · ${calls.length} call/meeting`);
  return 0;
}

async function cmdCall(gong, cfg, args) {
  const ids = args.positional;
  if (!ids.length) throw new Error('usage: node gong.js call <call-id> [<call-id>...]');

  const calls = ids.map((id) => ({
    id,
    title: id,
    status: 'COMPLETED',
    access: true,
    started: '',
  }));

  const t = await download(gong, calls, { ...cfg, dryRun: args.dryRun });
  console.error(`\n${t.ok} saved · ${t.failed} failed`);
  return t.failed ? 1 : 0;
}

async function cmdWorkspaces(gong) {
  for (const w of await gong.workspaces()) console.log(`${w.id}\t${w.name}`);
  return 0;
}

function dateRange(cfg, args, defaultDays = 7) {
  if (args.days != null) return [daysAgo(args.days), ymd(new Date())];
  return [
    args.positional[args.fromIndex] || cfg.dayFrom || daysAgo(defaultDays),
    args.positional[args.fromIndex + 1] || cfg.dayTo || ymd(new Date()),
  ];
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

const USAGE = `Usage: node gong.js <command> [options]

Commands:
  me [from] [to]          transcripts of your own calls, foldered by day
  account [id] [from] [to] activity for a Gong account (--name to look it up)
  call <id>...            transcript for specific call ids
  workspaces              list the workspaces you can see

Options:
  --days N                trailing N days instead of a from/to range
  --dry-run, -n           show what would be written, download nothing
  --name NAME             resolve an account by name (account)
  --ids-only              print bare call ids (account)
  --out DIR               output root, overrides GONG_OUT_DIR
  --raw DIR               raw JSON dir, overrides GONG_RAW_DIR
  --format F              text | md | srt | vtt
  --workspace ID          override GONG_WORKSPACE_ID

Dates are YYYY-MM-DD. Output goes to <out>/<Mon-D>/<title>-transcript.<ext>.`;

function parseArgs(argv) {
  const args = { positional: [], dryRun: false, days: null, name: null, idsOnly: false };
  const overrides = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': case '-n': args.dryRun = true; break;
      case '--days':      args.days = Number(argv[++i]); break;
      case '--name':      args.name = argv[++i]; break;
      case '--ids-only':  args.idsOnly = true; break;
      case '--out':       overrides.GONG_OUT_DIR = argv[++i]; break;
      case '--raw':       overrides.GONG_RAW_DIR = argv[++i]; break;
      case '--format':case '-f': overrides.GONG_FORMAT = argv[++i]; break;
      case '--workspace': overrides.GONG_WORKSPACE_ID = argv[++i]; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0);
      default:
        if (a.startsWith('-')) { console.error(`unknown option: ${a}\n\n${USAGE}`); process.exit(64); }
        args.positional.push(a);
    }
  }
  return { args, overrides };
}

async function main() {
  const [command = '', ...rest] = process.argv.slice(2);
  // Accept `--help`/`-h` in the command slot too, not just after a command.
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(USAGE);
    return 0;
  }

  const { args, overrides } = parseArgs(rest);
  // `account` takes an id before the dates; `me` does not.
  args.fromIndex = command === 'account' && !args.name ? 1 : 0;

  const cfg = loadConfig(overrides);
  const gong = await new Gong(cfg).init();

  switch (command) {
    case 'me':         return cmdMe(gong, cfg, args);
    case 'account':    return cmdAccount(gong, cfg, args);
    case 'call':       return cmdCall(gong, cfg, args);
    case 'workspaces': return cmdWorkspaces(gong);
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 64;
  }
}

// Guard the CLI so `import ... from './gong.js'` has no side effects.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code || 0),
    (err) => { console.error(err.message || err); process.exit(1); }
  );
}
