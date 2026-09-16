/**
 * automation.js — the daily pipeline: pull from Gong, organise, feed projects.
 *
 * Deliberately scheduled *inside this server* rather than with launchd:
 *
 *   - launchd's StartCalendarInterval fires a missed job on the next wake, and
 *     `pmset repeat wake` would wake the Mac to do it. Neither is wanted.
 *   - A timer in this process cannot wake anything, and while the Mac sleeps
 *     the process is suspended, so the slot simply passes. On wake we check
 *     how late we are: inside the grace window we run, past it we record the
 *     slot as missed and wait for tomorrow.
 *
 * The cost is that the server has to be running — which is the stated
 * expectation, and is visible in the UI.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ymd } from './gong.js';
import { pullTranscripts } from './core/gong/pull.js';
import { organize } from './organize.js';
import { syncFromLibrary } from './projects.js';
import { readSettings, writeSettings } from './settings.js';
import * as runs from './runs.js';
import { desc } from 'drizzle-orm';
import { db } from './core/db/client.js';
import { automationHistory } from './core/db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_AUTOMATION = {
  enabled: false,
  time: '09:00',
  days: [1, 2, 3, 4, 5],     // 0 = Sunday
  daysBack: 2,
  organize: true,
  organizeBy: 'customer',
  organizeMode: 'copy',
  // How late a slot may be honoured. Past this the Mac was almost certainly
  // asleep, and running a stale slot hours later is surprising.
  graceMinutes: 20,
  lastRunAt: null,
  lastSlot: null,            // YYYY-MM-DD of the slot most recently handled
  history: [],
};

export function readAutomation() {
  const s = readSettings();
  const { history: _ignored, ...schedule } = s.automation || {};
  return { ...DEFAULT_AUTOMATION, ...schedule, history: readHistory() };
}

export function writeAutomation(patch) {
  const { history: _ignored, ...rest } = { ...readAutomation(), ...patch };
  writeSettings({ automation: rest });
  return { ...rest, history: readHistory() };
}

/** The last 40 outcomes, including the days that were skipped. */
function readHistory() {
  return db.select().from(automationHistory)
    .orderBy(desc(automationHistory.at)).limit(40).all()
    .map((h) => ({
      at: h.at,
      kind: h.kind,
      trigger: h.trigger || undefined,
      pulled: h.pulled,
      organized: h.organized,
      projects: h.projects,
      durationMs: h.durationMs ?? undefined,
      errors: (() => { try { return JSON.parse(h.errors || '[]'); } catch { return []; } })(),
    }));
}

function recordHistory(entry) {
  db.insert(automationHistory).values({
    at: Date.now(),
    kind: entry.kind || 'ok',
    trigger: entry.trigger || null,
    pulled: entry.pulled || 0,
    organized: entry.organized || 0,
    projects: entry.projects || 0,
    durationMs: entry.durationMs ?? null,
    errors: JSON.stringify(entry.errors || []),
  }).run();
  return readAutomation();
}

/** The scheduled moment for a given day, as a Date. */
function slotFor(date, time) {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  const d = new Date(date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** What the scheduler would do right now, without doing it. */
export function schedulerState(now = new Date()) {
  const a = readAutomation();
  const today = ymd(now);
  const slot = slotFor(now, a.time);
  const lateMs = now - slot;
  const graceMs = (a.graceMinutes || 20) * 60000;

  const scheduledToday = (a.days || []).includes(now.getDay());
  const alreadyHandled = a.lastSlot === today;

  let next = slotFor(now, a.time);
  if (now >= next) next = slotFor(new Date(now.getTime() + 86400e3), a.time);
  // Walk forward to the next enabled weekday.
  for (let i = 0; i < 8 && !(a.days || []).includes(next.getDay()); i++) {
    next = slotFor(new Date(next.getTime() + 86400e3), a.time);
  }

  return {
    ...a,
    today,
    scheduledToday,
    alreadyHandled,
    dueNow: Boolean(
      a.enabled && scheduledToday && !alreadyHandled && lateMs >= 0 && lateMs <= graceMs
    ),
    missed: Boolean(
      a.enabled && scheduledToday && !alreadyHandled && lateMs > graceMs
    ),
    lateMinutes: Math.round(lateMs / 60000),
    nextRunAt: a.enabled ? next.getTime() : null,
  };
}

let ticking = false;

/**
 * Called on a short interval. Cheap and idempotent: it only acts inside the
 * grace window, and records the slot so it cannot run twice.
 */
export async function tick(startRun) {
  if (ticking) return null;

  const s = schedulerState();
  if (!s.enabled || !s.scheduledToday || s.alreadyHandled) return null;

  if (s.missed) {
    // The Mac was asleep (or the server was down) through the whole window.
    writeAutomation({ lastSlot: s.today });
    recordHistory({
      kind: 'skipped',
      reason: `slot missed by ${s.lateMinutes} min — the Mac was asleep or the server was not running`,
    });
    return null;
  }

  if (!s.dueNow) return null;

  ticking = true;
  try {
    writeAutomation({ lastSlot: s.today });
    return await startRun({ trigger: 'schedule' });
  } finally {
    ticking = false;
  }
}

/**
 * Pull, organise, then hand the new transcripts to their projects.
 *
 * Emits into a run so the Automation tab can watch it live and replay it
 * afterwards, exactly like a chat.
 */
export async function runPipeline({ trigger = 'manual', daysBack, onEvent = () => {} }) {
  const a = readAutomation();
  const days = Number(daysBack ?? a.daysBack) || 2;
  const started = Date.now();
  const result = { trigger, days, pulled: 0, organized: 0, projects: null, errors: [] };

  // ---- 1. pull ----
  onEvent({ type: 'step', step: 'pull', message: `Pulling your calls from the last ${days} day(s)` });

  const cfg = loadConfig();
  mkdirSync(cfg.outDir, { recursive: true });

  try {
    // Same pull the Pull tab runs. Its progress vocabulary is per-call and
    // this tab wants a per-step summary, so the events are translated rather
    // than the pull being written out a second time.
    let found = 0;
    let range = '';
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      onEvent({ type: 'detail', message: `${found} call(s) in ${range}` });
    };

    const tally = await pullTranscripts({ mode: 'me', days }, (e) => {
      if (e.type === 'identity') {
        onEvent({ type: 'detail', message: `Signed in as ${e.userId} · workspace ${e.workspaceId}` });
      } else if (e.type === 'stage' && e.stage === 'search') {
        range = `${e.from} .. ${e.to}`;
      } else if (e.type === 'found') {
        found = e.count;
      } else if (e.type === 'stage' && e.stage === 'download') {
        announce();
      } else if (e.type === 'done') {
        onEvent({
          type: 'file',
          kind: e.kind,
          name: e.call?.title || e.call?.id,
          path: e.call?.path,
        });
      } else if (e.type === 'complete') {
        announce();   // no calls found: the download stage never happened
      }
    });

    result.pulled = tally.ok;
    onEvent({ type: 'detail', message: `${tally.ok} saved · ${tally.skipped} skipped · ${tally.failed} failed` });
  } catch (err) {
    result.errors.push(`pull: ${err.message}`);
    onEvent({ type: 'error', message: `Pull failed — ${err.message}` });
  }

  // ---- 2. organise ----
  if (a.organize && !result.errors.length) {
    onEvent({ type: 'step', step: 'organize', message: `Grouping by ${a.organizeBy}` });
    try {
      const org = organize({ by: a.organizeBy, mode: a.organizeMode });
      result.organized = org.done;
      onEvent({
        type: 'detail',
        message: `${org.done} file(s) into ${org.groups.length} folder(s) · ${org.mode}`,
      });
    } catch (err) {
      result.errors.push(`organize: ${err.message}`);
      onEvent({ type: 'error', message: `Organize failed — ${err.message}` });
    }
  }

  // ---- 3. feed the projects ----
  onEvent({ type: 'step', step: 'projects', message: 'Assigning transcripts to projects' });
  try {
    const sync = syncFromLibrary();
    result.projects = sync;
    if (sync.created.length) {
      onEvent({ type: 'detail', message: `New project(s): ${sync.created.join(', ')}` });
    }
    for (const u of sync.updated) {
      onEvent({ type: 'detail', message: `${u.name} — ${u.added} new transcript(s)` });
    }
    if (!sync.created.length && !sync.updated.length) {
      onEvent({ type: 'detail', message: 'No new transcripts to assign' });
    }
  } catch (err) {
    result.errors.push(`projects: ${err.message}`);
    onEvent({ type: 'error', message: `Assign failed — ${err.message}` });
  }

  result.durationMs = Date.now() - started;
  recordHistory({
    kind: result.errors.length ? 'error' : 'ok',
    trigger,
    pulled: result.pulled,
    organized: result.organized,
    projects: result.projects?.updated?.length || 0,
    durationMs: result.durationMs,
    errors: result.errors,
  });
  writeAutomation({ lastRunAt: Date.now() });

  onEvent({ type: 'summary', result });
  return result;
}

/** Start the pipeline as a tracked run, so the UI can follow or replay it. */
export function startPipelineRun({ trigger = 'manual', daysBack } = {}) {
  const active = runs.list({ active: true }).find((r) => r.kind === 'automation');
  if (active) return runs.get(active.id);

  const run = runs.createRun({
    kind: 'automation',
    label: trigger === 'schedule' ? 'Scheduled run' : 'Manual run',
    meta: { trigger },
  });

  // Deliberately not awaited: the caller gets the run id immediately and
  // follows the stream, exactly like a chat run.
  runPipeline({
    trigger,
    daysBack,
    onEvent: (e) => runs.push(run.id, e),
  })
    .then((result) => runs.finish(run.id, { status: result.errors.length ? 'error' : 'done', ...result }))
    .catch((err) => runs.finish(run.id, { status: 'error', errors: [err.message] }));

  return run;
}

export { HERE };
