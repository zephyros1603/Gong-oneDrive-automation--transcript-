/**
 * settings.js — Workbench state, in the database.
 *
 * gong.env stays the place for credentials and folder locations; this holds
 * the UI's own state (which skill each button calls, the output directory,
 * the last selection) so it survives a restart.
 *
 * The document lives in one settings row because nothing queries inside it.
 * Usage is the exception: it is an append-only log that is only ever summed,
 * so it gets a real table and the totals become a query rather than a number
 * recomputed from a 200-entry JSON array on every page poll.
 */

import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { eq, desc, gte, sql } from 'drizzle-orm';
import { loadConfig } from './gong.js';
import { db } from './core/db/client.js';
import { settings as settingsTable, usage as usageTable, toMicros, fromMicros } from './core/db/schema.js';
import { PROJECT_ROOT } from './core/paths.js';

const KEY = 'app';

/**
 * The four reporting artefacts, wired to the skills that produce them.
 *
 * MOM, WSR and MSR all come from aquera-status-reporting — it covers per-call
 * notes plus the weekly and monthly reports — so they differ only in the
 * instruction. RunBook points at a skill that does not exist yet and shows as
 * a blueprint until it does.
 */
export const DEFAULT_ACTIONS = [
  {
    id: 'mom',
    label: 'MOM',
    title: 'Minutes of meeting + covering email',
    skill: 'aquera-status-reporting',
    instruction: 'generate MOM and mail for the same from the transcript file',
    builtin: true,
  },
  {
    id: 'wsr',
    label: 'WSR',
    title: 'Weekly project status report',
    skill: 'aquera-status-reporting',
    instruction: 'generate the Weekly Project Status Report from the transcript files',
    builtin: true,
  },
  {
    id: 'msr',
    label: 'MSR',
    title: 'Monthly project status report',
    skill: 'aquera-status-reporting',
    instruction: 'generate the Monthly Project Status Report from the transcript files',
    builtin: true,
  },
  {
    id: 'runbook',
    label: 'RunBook',
    title: 'Project runbook',
    skill: 'aquera-project-runbook',
    instruction: 'generate the project runbook from the transcript files',
    builtin: true,
  },
];

function defaults() {
  const cfg = loadConfig();
  return {
    version: 2,
    outputDir: cfg.docsDir,
    model: '',                 // '' = whatever Claude Code defaults to
    actions: DEFAULT_ACTIONS,
    selection: [],             // last-checked file paths
    sessions: [],              // { id, label, actionId, startedAt }
    // Hard ceiling on agent turns per run, so a confused run cannot bill
    // without bound. A MOM takes ~12 turns.
    maxTurns: 40,
  };
}

export function expandPath(raw, fallback) {
  const value = String(raw ?? '').trim();
  if (!value) return resolve(fallback);
  if (value.startsWith('~')) {
    return join(homedir(), value.slice(1).replace(/^\/+/, ''));
  }
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

export function readSettings() {
  const base = defaults();
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, KEY)).get();

  let stored = {};
  try {
    stored = row ? JSON.parse(row.value) : {};
  } catch {
    // A corrupt value should not brick the UI; fall back to defaults.
    return { ...base, usage: [] };
  }

  // Merge rather than replace, so state written by an older version still
  // gains any newly added defaults.
  const actions = Array.isArray(stored.actions) && stored.actions.length
    ? stored.actions
    : base.actions;

  return {
    ...base,
    ...stored,
    outputDir: expandPath(stored.outputDir, base.outputDir),
    actions,
    // Kept on the settings object for callers that still read it as a list.
    usage: recentUsage(200),
  };
}

export function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current, ...patch };

  if (patch.outputDir !== undefined) {
    next.outputDir = expandPath(patch.outputDir, defaults().outputDir);
  }
  next.version = 2;

  // Usage is a table, not a field — never let it round-trip through here.
  const { usage, ...persisted } = next;

  db.insert(settingsTable)
    .values({ key: KEY, value: JSON.stringify(persisted) })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(persisted) } })
    .run();

  return next;
}

/**
 * Append one run to the usage log.
 *
 * Cost is only known when the CLI reports its result, so a cancelled run is
 * recorded with whatever was reported (often nothing) and flagged, rather
 * than being dropped — a run that cost money must not vanish from the total.
 */
export function recordUsage({ actionId, label, costUsd, durationMs, turns, files, cancelled }) {
  db.insert(usageTable).values({
    at: Date.now(),
    actionId: actionId || '',
    label: label || '',
    costUsd: toMicros(Number(costUsd) || 0),
    durationMs: Number(durationMs) || 0,
    turns: Number(turns) || 0,
    files: Number(files) || 0,
    cancelled: Boolean(cancelled),
  }).run();

  return readSettings();
}

function row2usage(r) {
  return {
    at: r.at,
    actionId: r.actionId || '',
    label: r.label || '',
    costUsd: fromMicros(r.costUsd) || 0,
    durationMs: r.durationMs || 0,
    turns: r.turns || 0,
    files: r.files || 0,
    cancelled: Boolean(r.cancelled),
  };
}

function recentUsage(n) {
  return db.select().from(usageTable)
    .orderBy(desc(usageTable.at)).limit(n).all().map(row2usage);
}

/** Totals for the usage panel. */
export function usageSummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const all = db.select({
    total: sql`COALESCE(SUM(cost_usd), 0)`,
    n: sql`COUNT(*)`,
    cancelled: sql`COALESCE(SUM(cancelled), 0)`,
  }).from(usageTable).get();

  const today = db.select({
    total: sql`COALESCE(SUM(cost_usd), 0)`,
    n: sql`COUNT(*)`,
  }).from(usageTable).where(gte(usageTable.at, startOfDay.getTime())).get();

  const recent = recentUsage(12);

  return {
    totalUsd: fromMicros(Number(all?.total ?? 0)) || 0,
    todayUsd: fromMicros(Number(today?.total ?? 0)) || 0,
    runs: Number(all?.n ?? 0),
    runsToday: Number(today?.n ?? 0),
    cancelled: Number(all?.cancelled ?? 0),
    last: recent[0] || null,
    recent,
  };
}

/** Record a conversation so the Workbench can offer follow-ups on it. */
export function rememberSession({ id, label, actionId }) {
  if (!id) return readSettings();

  const s = readSettings();
  const sessions = [
    { id, label: label || 'Untitled', actionId: actionId || '', startedAt: Date.now() },
    ...(s.sessions || []).filter((x) => x.id !== id),
  ].slice(0, 20);

  return writeSettings({ sessions });
}
