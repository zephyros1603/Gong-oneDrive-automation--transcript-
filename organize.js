#!/usr/bin/env node
/**
 * organize.js — regroup downloaded transcripts by customer or by call.
 *
 * The download side files everything by day, which is right for "what
 * happened this week" and wrong for "everything we ever discussed with
 * Pennrose". This builds a second tree from the same files.
 *
 *   node organize.js                       # by customer
 *   node organize.js --by call             # by call title
 *   node organize.js --dry-run             # show the plan, touch nothing
 *   node organize.js --move                # relocate instead of copying
 *   node organize.js --link                # hardlink (no extra disk use)
 *   node organize.js --src DIR --out DIR
 *
 *   transcripts/Sep-3/Aquera-Pennrose-implementation-calls-transcript.md
 *   →  sorted/Pennrose-LLC/Sep-3-Aquera-Pennrose-implementation-calls-transcript.md
 */

import {
  readdirSync, readFileSync, statSync, mkdirSync, copyFileSync,
  renameSync, linkSync, existsSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, slug, MONTHS } from './gong.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT = /-transcript\.(md|txt|srt|vtt)$/i;

/**
 * Dropped at the root of every tree this script writes.
 *
 * Skipping only the current `--out` is not enough: a sorted tree left inside
 * the source (say transcripts/sorted/) would be picked up as *source* on the
 * next run and sorted again, multiplying copies. Any directory carrying this
 * marker is treated as output and never walked.
 */
const MARKER = '.gong-sorted';

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

/**
 * Recover the call title and customer from a transcript file's own header.
 *
 * md:   "# <title>" then "**<date>** · <n> min · <customer> · <provider>"
 * text: "<title>" then an "Account:" line
 * srt/vtt carry no header at all, which is why the raw JSON index exists.
 */
function fromHeader(path) {
  let head;
  try {
    head = readFileSync(path, 'utf8').slice(0, 1200);
  } catch {
    return {};
  }
  const lines = head.split('\n');

  if (/\.md$/i.test(path)) {
    const title = (lines.find((l) => l.startsWith('# ')) || '').slice(2).trim();
    const meta = lines.find((l) => l.startsWith('**') && l.includes('·'));
    // date · duration · customer · provider — customer is the third field.
    const customer = meta ? (meta.split('·')[2] || '').trim() : '';
    return { title, customer };
  }

  if (/\.txt$/i.test(path)) {
    const title = (lines[0] || '').trim();
    const acct = lines.find((l) => l.startsWith('Account:'));
    return { title, customer: acct ? acct.replace('Account:', '').trim() : '' };
  }

  return {};
}

/**
 * Index the raw API payloads by the output path they would have produced, so
 * subtitle files (and anything with a mangled header) can still be grouped.
 * The raw JSON is the authoritative source for callCustomers.
 */
function rawIndex(rawDir) {
  const index = new Map();
  if (!existsSync(rawDir)) return index;

  for (const name of readdirSync(rawDir)) {
    if (!name.endsWith('.json')) continue;
    let d;
    try {
      d = JSON.parse(readFileSync(join(rawDir, name), 'utf8'));
    } catch {
      continue;
    }

    // `when` is M/D/YY here, unlike the search API's YYYY/MM/DD.
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(d.when || '').trim());
    const day = m ? `${MONTHS[Number(m[1]) - 1]}-${Number(m[2])}` : null;
    const title = d.callTitle || '';
    if (!day || !title) continue;

    index.set(`${day}/${slug(title)}`, {
      title,
      customer: d.callCustomers || '',
      id: String(d.callId ?? ''),
    });
  }
  return index;
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

function walk(dir, skip, out = []) {
  if (!existsSync(dir)) return out;
  if (existsSync(join(dir, MARKER))) return out;   // an output tree

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip.some((s) => path === s || path.startsWith(s + sep))) continue;

    let st;
    try { st = statSync(path); } catch { continue; }

    if (st.isDirectory()) walk(path, skip, out);
    else if (TRANSCRIPT.test(name)) out.push(path);
  }
  return out;
}

const UNKNOWN = 'Unsorted';

export function plan({ src, out, by = 'customer', rawDir }) {
  // Skip the destination when it lives inside the source, otherwise a second
  // run would sort the already-sorted copies.
  const files = walk(src, [out]);
  const index = rawIndex(rawDir);

  const groups = new Map();

  for (const path of files) {
    const rel = relative(src, path);
    const parts = rel.split(sep);
    const day = parts.length > 1 ? parts[parts.length - 2] : '';
    const base = basename(path);

    const fromIndex = index.get(`${day}/${base.replace(TRANSCRIPT, '')}`) || {};
    const header = fromHeader(path);

    // Prefer the raw payload, fall back to the file's own header.
    const customer = (fromIndex.customer || header.customer || '').trim();
    const title = (fromIndex.title || header.title || '').trim();

    const key = by === 'call' ? title : customer;
    const name = key ? slug(key) : UNKNOWN;

    const dest = join(out, name, day ? `${day}-${base}` : base);

    if (!groups.has(name)) {
      groups.set(name, { name, label: key || UNKNOWN, files: [] });
    }
    groups.get(name).files.push({ from: path, to: dest });
  }

  return [...groups.values()].sort((a, b) =>
    b.files.length - a.files.length || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

export function organize(opts = {}) {
  const cfg = loadConfig();
  const src = resolvePath(opts.src, cfg.outDir);
  const out = resolvePath(opts.out, join(cfg.outDir, '..', 'sorted'));
  const rawDir = resolvePath(opts.rawDir, cfg.rawDir);
  const by = opts.by === 'call' ? 'call' : 'customer';
  const mode = ['move', 'link'].includes(opts.mode) ? opts.mode : 'copy';
  const dryRun = Boolean(opts.dryRun);

  const groups = plan({ src, out, by, rawDir });
  let done = 0;
  let failed = 0;
  const touchedDirs = new Set();

  if (!dryRun) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, MARKER),
      JSON.stringify({ by, mode, src, written: new Date().toISOString() }, null, 2)
    );

    for (const g of groups) {
      for (const f of g.files) {
        try {
          mkdirSync(dirname(f.to), { recursive: true });

          if (mode === 'move') {
            renameSync(f.from, f.to);
            touchedDirs.add(dirname(f.from));
          } else if (mode === 'link') {
            // A hardlink is the same bytes in two places: no extra disk, and
            // editing one edits both. Falls back to a copy across volumes.
            if (existsSync(f.to)) unlinkSync(f.to);
            try { linkSync(f.from, f.to); } catch { copyFileSync(f.from, f.to); }
          } else {
            copyFileSync(f.from, f.to);
          }
          done++;
        } catch (err) {
          f.error = err.message;
          failed++;
        }
      }
    }

    // Moving empties the day folders; leave the tree tidy.
    for (const dir of touchedDirs) {
      try {
        if (!readdirSync(dir).length) rmdirSync(dir);
      } catch { /* not empty, or gone already */ }
    }
  }

  return {
    ok: failed === 0,
    by, mode, dryRun, src, out,
    total: groups.reduce((n, g) => n + g.files.length, 0),
    done, failed,
    groups: groups.map((g) => ({
      name: g.name,
      label: g.label,
      count: g.files.length,
      files: g.files.map((f) => ({
        from: relative(src, f.from),
        to: relative(out, f.to),
        abs: f.to,
        error: f.error,
      })),
    })),
  };
}

function resolvePath(value, fallback) {
  const raw = (value || '').trim();
  if (!raw) return resolve(fallback);
  if (raw.startsWith('~')) {
    return join(process.env.HOME || '', raw.slice(1).replace(/^\/+/, ''));
  }
  return resolve(HERE, raw);
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

const USAGE = `Usage: node organize.js [options]

Regroups transcripts downloaded by day into folders per customer or per call.

Options:
  --by customer|call   grouping key (default: customer)
  --src DIR            source tree (default: GONG_OUT_DIR)
  --out DIR            destination  (default: sorted/ beside it)
  --raw DIR            raw JSON dir (default: GONG_RAW_DIR)
  --copy               copy files (default)
  --move               relocate them, then remove empty day folders
  --link               hardlink — no extra disk, edits affect both
  --dry-run, -n        print the plan, change nothing`;

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  const val = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };

  const result = organize({
    by: val('--by'),
    src: val('--src'),
    out: val('--out'),
    rawDir: val('--raw'),
    mode: argv.includes('--move') ? 'move' : argv.includes('--link') ? 'link' : 'copy',
    dryRun: argv.includes('--dry-run') || argv.includes('-n'),
  });

  console.error(
    `${result.dryRun ? 'would organize' : 'organized'} ${result.total} file(s) ` +
    `by ${result.by} into ${result.groups.length} folder(s) · ${result.mode}`
  );
  console.error(`${result.src}\n  → ${result.out}\n`);

  for (const g of result.groups) {
    console.log(`${g.label}  (${g.count})`);
    for (const f of g.files) {
      console.log(`  ${f.error ? '✗' : '·'} ${f.to}${f.error ? `  — ${f.error}` : ''}`);
    }
  }

  if (result.failed) {
    console.error(`\n${result.failed} file(s) failed`);
    process.exit(1);
  }
}
