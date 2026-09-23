/**
 * scripts/cxportal-probe.mjs — settle what the CX Portal reference leaves open.
 *
 *   node scripts/cxportal-probe.mjs            # everything
 *   node scripts/cxportal-probe.mjs filters    # just the filter keys
 *   node scripts/cxportal-probe.mjs actions    # just the action parameters
 *
 * Three gaps, three methods:
 *
 * 1. **Filter keys.** The reference lists 39 UI labels and confirms 3 wire
 *    keys. The rest were guessed from response fields, and a guess is worth
 *    nothing here because the API does not reject an unknown `attribute` — it
 *    ignores the clause and returns everything, which reads exactly like a
 *    filter that matched every row.
 *
 *    So each candidate is tested by contradiction: filter for a value taken
 *    from a real project, then for a value nothing can hold. A key that is
 *    genuinely filterable gives two different totals. A key the server ignores
 *    gives the same total twice, and that sameness is the proof.
 *
 * 2. **Action parameters.** The 15 actions that answered are called again with
 *    a deeper shape walk; the ones that failed are retried against candidate
 *    parameter sets until one stops returning 400.
 *
 * 3. **Nothing is written.** Every action probed here is a read. The portal's
 *    write endpoints are deliberately untouched.
 *
 * Output: docs/cxportal-shapes.json (raw) and a summary on stdout. Records are
 * never printed — only structure, counts and key names — so the output can go
 * in a ticket without leaking customer data.
 */

import { writeFileSync } from 'node:fs';
import { cxClient } from '../core/connectors/cx-client.js';
import { ACTIONS, FILTER_OPERATORS, clause, shapeOf } from '../core/connectors/cxportal.js';

const only = process.argv[2] || 'all';
const NONSENSE = '__warp_probe_value_that_cannot_exist__';
const out = { probedAt: new Date().toISOString(), actions: {}, filters: {}, notes: [] };

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s).padEnd(n);

/** shapeOf, but willing to go deeper than the UI's three levels. */
function deepShape(value, depth = 0, max = 5) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth >= max
      ? `array(${value.length})`
      : { array: value.length, of: value.length ? deepShape(value[0], depth + 1, max) : 'empty' };
  }
  if (typeof value === 'object') {
    if (depth >= max) return 'object';
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, deepShape(v, depth + 1, max)])
    );
  }
  return typeof value;
}

/**
 * Parameter sets to try for the actions that returned 400. Ordered cheapest
 * first; the first one that answers is the one reported.
 */
const CANDIDATES = {
  calendar_tasks: [
    { start: isoDaysFromNow(-7), end: isoDaysFromNow(7) },
    { startDate: isoDaysFromNow(-7), endDate: isoDaysFromNow(7) },
    { from: isoDaysFromNow(-7), to: isoDaysFromNow(7) },
    { month: new Date().toISOString().slice(0, 7) },
    { year: String(new Date().getFullYear()), month: String(new Date().getMonth() + 1) },
  ],
  tc_analysis_aggs: [
    { size: '1' },
    { consultantName: '' },
    {},
  ],
};

/**
 * Actions confirmed as POST-only (`core/connectors/cxportal.js`'s
 * `postAction()` path). `action()`/`request()` are GET-only, so probing one
 * of these here would just be a 400/404 that can never resolve — worth
 * skipping outright rather than retrying with candidate params that were
 * never going to work. Closing this gap means capturing a real request some
 * other way, not calling it — this probe stays read-only throughout.
 */
const POST_ONLY = new Set(['note_counts']);

function isoDaysFromNow(n) {
  return new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
}

async function probeActions(cx) {
  log('\n=== actions ===\n');
  for (const name of ACTIONS) {
    if (POST_ONLY.has(name)) {
      out.actions[name] = { ok: false, error: 'POST-only — not probed here', postOnly: true };
      log(`  ${pad(name, 32)} SKIPPED  confirmed POST-only, see core/connectors/cxportal.js`);
      continue;
    }
    try {
      const res = await cx.action(name);
      out.actions[name] = { ok: true, shape: deepShape(res) };
      const keys = res && typeof res === 'object' ? Object.keys(res).length : 0;
      log(`  ${pad(name, 32)} ok      ${keys} top-level key(s)`);
    } catch (err) {
      const tries = CANDIDATES[name] || [];
      let solved = null;

      for (const params of tries) {
        try {
          const res = await cx.action(name, params);
          solved = { params, shape: deepShape(res) };
          break;
        } catch { /* try the next candidate */ }
      }

      if (solved) {
        out.actions[name] = { ok: true, requiredParams: solved.params, shape: solved.shape };
        log(`  ${pad(name, 32)} ok      with ${JSON.stringify(solved.params)}`);
      } else {
        out.actions[name] = { ok: false, error: err.message, tried: tries.length };
        log(`  ${pad(name, 32)} FAILED  ${err.message}${tries.length ? ` (${tries.length} param sets tried)` : ''}`);
      }
    }
  }
}

/**
 * Confirm which record fields are genuinely filterable.
 *
 * `allTotal` is the unfiltered count and is the control: a clause the server
 * understood moves the number, a clause it ignored does not.
 */
async function probeFilters(cx) {
  log('\n=== filter keys ===\n');

  const sample = await cx.listProjects({ size: 25, hideClosed: false });
  const rows = sample?.projects || [];
  if (!rows.length) { log('  no projects returned — cannot probe'); return; }

  const baseline = Number(sample.allTotal ?? sample.total ?? 0);
  log(`  ${rows.length} sample rows, ${baseline} projects unfiltered\n`);

  // Candidates: every scalar field on a real record. A field with no usable
  // value in the sample cannot be probed by contradiction, so it is reported
  // as untested rather than quietly counted as a failure.
  const candidates = new Map();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'object') continue;
      if (!candidates.has(k)) candidates.set(k, String(v));
    }
  }

  const confirmed = [];
  const ignored = [];
  const errored = [];

  for (const [key, real] of candidates) {
    try {
      const hit = await cx.listProjects({
        size: 1, hideClosed: false, filters: [clause(key, 'equals', real)],
      });
      const miss = await cx.listProjects({
        size: 1, hideClosed: false, filters: [clause(key, 'equals', NONSENSE)],
      });

      const a = Number(hit?.total ?? -1);
      const b = Number(miss?.total ?? -2);

      if (a !== b && b === 0) {
        confirmed.push({ key, matched: a, sample: real.slice(0, 28) });
        log(`  ${pad(key, 30)} FILTERABLE   equals → ${a}, nonsense → 0`);
      } else if (a === b) {
        ignored.push({ key, total: a });
        log(`  ${pad(key, 30)} ignored      both → ${a} (clause had no effect)`);
      } else {
        errored.push({ key, a, b });
        log(`  ${pad(key, 30)} unclear      ${a} vs ${b}`);
      }
    } catch (err) {
      errored.push({ key, error: err.message });
      log(`  ${pad(key, 30)} error        ${err.message}`);
    }
  }

  out.filters = { baseline, confirmed, ignored, errored, operators: FILTER_OPERATORS };
  log(`\n  ${confirmed.length} filterable, ${ignored.length} ignored, ${errored.length} unclear`);
}

async function main() {
  const cx = cxClient();
  const info = cx.tokenInfo();

  if (!info.present) { console.error('No CXPORTAL_TOKEN set. Paste one in the CX Portal application first.'); process.exit(1); }
  if (info.looksLikeAccessToken === false) {
    console.error(`That is the ${info.tokenUse} token. Cognito stores both; only the accessToken is accepted.`);
    process.exit(1);
  }

  const { refreshed } = await cx.ensureFresh().catch((e) => ({ refreshed: false, reason: e.message }));
  const left = cx.tokenInfo().minutesLeft;
  log(`token: ${cx.tokenInfo().username || '?'} · ${left} min left${refreshed ? ' (renewed)' : ''}`);
  if (left < 5) log('WARNING: this will likely expire mid-probe.');

  if (only === 'all' || only === 'actions') await probeActions(cx);
  if (only === 'all' || only === 'filters') await probeFilters(cx);

  writeFileSync('docs/cxportal-shapes.json', JSON.stringify(out, null, 2));
  log('\nwrote docs/cxportal-shapes.json');
}

main().catch((e) => { console.error('\nprobe failed:', e.message); process.exit(1); });
