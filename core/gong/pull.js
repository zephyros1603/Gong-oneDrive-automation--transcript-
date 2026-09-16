/**
 * core/gong/pull.js — the transcript pull, as one function.
 *
 * Three modes behind one entry point: your own calls in a date range, every
 * activity on a CRM account, or an explicit list of call ids. Progress is
 * reported through `onEvent` rather than written to a response, so the same
 * pull drives the web UI, the scheduler and (eventually) anything else.
 */

import {
  Gong, loadConfig, download, filterMe, filterDates, ymd, daysAgo,
} from '../../gong.js';

/** gong.env keys a caller may override for a single run. */
const OVERRIDABLE = [
  'GONG_HOST', 'GONG_COOKIE', 'GONG_WORKSPACE_ID', 'GONG_USER_ID',
  'GONG_ACCOUNT_ID', 'GONG_FORMAT', 'GONG_OUT_DIR', 'GONG_RAW_DIR',
  'GONG_CONCURRENCY',
];

/**
 * @param params  mode, date range or call ids, plus any GONG_* override
 * @param onEvent called with {type, …} for every step worth showing
 */
export async function pullTranscripts(params, onEvent = () => {}) {
  const overrides = {};
  for (const key of OVERRIDABLE) {
    if (params[key]) overrides[key] = params[key];
  }

  const cfg = loadConfig(overrides);
  const mode = params.mode || 'me';

  onEvent({ type: 'stage', stage: 'auth', message: 'Authenticating with Gong' });
  const gong = await new Gong(cfg).init();
  onEvent({
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

    onEvent({ type: 'stage', stage: 'search', message: `${ids.length} call id(s)` });
    // No search metadata here: download() recovers title and date from each
    // transcript payload instead of dumping them in unknown-date/.
    calls = ids.map((id) => ({ id, title: id, status: 'COMPLETED', access: true, started: '' }));
    for (const c of calls) onEvent({ type: 'found', count: calls.length, title: c.id });
  } else if (mode === 'account') {
    let accountId = params.GONG_ACCOUNT_ID || cfg.accountId;

    if (params.accountName) {
      onEvent({ type: 'stage', stage: 'search', message: `Resolving "${params.accountName}"` });
      accountId = await gong.accountIdByName(params.accountName);
      if (!accountId) throw new Error(`no account matched: ${params.accountName}`);
      onEvent({ type: 'resolved', accountId, name: params.accountName });
    }
    if (!accountId) throw new Error('enter an account id or an account name');

    onEvent({ type: 'stage', stage: 'search', message: `Account activity · ${from} .. ${to}` });
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
    if (dropped) onEvent({ type: 'note', message: `${dropped} non-call activity skipped` });

    for (const c of calls) onEvent({ type: 'found', count: calls.length, title: c.title });
  } else {
    onEvent({
      type: 'stage', stage: 'search', from, to,
      message: `Your calls · ${from} .. ${to}`,
    });
    for await (const c of gong.search([filterMe(gong.userId), filterDates(from, to)])) {
      calls.push(c);
      onEvent({ type: 'found', count: calls.length, title: c.title });
    }
  }

  if (!calls.length) {
    onEvent({ type: 'complete', ok: 0, skipped: 0, failed: 0, outDir: cfg.outDir, calls: [] });
    return { ok: 0, skipped: 0, failed: 0, outDir: cfg.outDir, calls: [] };
  }

  onEvent({
    type: 'stage',
    stage: 'download',
    message: 'Fetching transcripts',
    total: calls.length,
  });

  const tally = await download(gong, calls, {
    ...cfg,
    dryRun: Boolean(params.dryRun),
    onEvent,
  });

  const summary = {
    ok: tally.ok,
    skipped: tally.skipped,
    failed: tally.failed,
    dryRun: Boolean(params.dryRun),
    outDir: cfg.outDir,
    calls: (tally.planned || []).map((c) => ({
      id: c.id, title: c.title, day: c.day, path: c.path, status: c.status,
    })),
  };

  onEvent({ type: 'complete', ...summary });
  return summary;
}
