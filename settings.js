/**
 * settings.js — Workbench state persisted as one JSON file.
 *
 * gong.env stays the place for credentials and folder locations; this holds
 * the UI's own state (which skill each button calls, the output directory,
 * the last selection) so it survives a restart.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadConfig } from './gong.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SETTINGS_PATH = join(HERE, 'settings.json');

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
    version: 1,
    outputDir: cfg.docsDir,
    model: '',                 // '' = whatever Claude Code defaults to
    actions: DEFAULT_ACTIONS,
    selection: [],             // last-checked file paths
    sessions: [],              // { id, label, actionId, startedAt }
    usage: [],                 // { at, actionId, costUsd, durationMs, turns }
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
  return isAbsolute(value) ? value : resolve(HERE, value);
}

export function readSettings() {
  const base = defaults();
  if (!existsSync(SETTINGS_PATH)) return base;

  let stored = {};
  try {
    stored = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    // A corrupt file should not brick the UI; fall back to defaults.
    return base;
  }

  // Merge rather than replace, so a settings file written by an older version
  // still gains any newly added defaults.
  const actions = Array.isArray(stored.actions) && stored.actions.length
    ? stored.actions
    : base.actions;

  return {
    ...base,
    ...stored,
    outputDir: expandPath(stored.outputDir, base.outputDir),
    actions,
  };
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  next.version = 1;
  if (patch.outputDir !== undefined) {
    next.outputDir = expandPath(patch.outputDir, defaults().outputDir);
  }

  // Write via a temp file so an interrupted write cannot leave invalid JSON.
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, SETTINGS_PATH);

  return next;
}

const USAGE_KEEP = 200;

/**
 * Append one run to the usage log.
 *
 * Cost is only known when the CLI reports its result, so a cancelled run is
 * recorded with whatever was reported (often nothing) and flagged, rather
 * than being dropped — a run that cost money must not vanish from the total.
 */
export function recordUsage({ actionId, label, costUsd, durationMs, turns, files, cancelled }) {
  const s = readSettings();
  const usage = [
    {
      at: Date.now(),
      actionId: actionId || '',
      label: label || '',
      costUsd: Number(costUsd) || 0,
      durationMs: Number(durationMs) || 0,
      turns: Number(turns) || 0,
      files: Number(files) || 0,
      cancelled: Boolean(cancelled),
    },
    ...(s.usage || []),
  ].slice(0, USAGE_KEEP);

  return writeSettings({ usage });
}

/** Totals for the usage panel. */
export function usageSummary() {
  const runs = readSettings().usage || [];
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const sum = (list) => list.reduce((n, r) => n + (r.costUsd || 0), 0);
  const today = runs.filter((r) => r.at >= startOfDay.getTime());

  return {
    totalUsd: sum(runs),
    todayUsd: sum(today),
    runs: runs.length,
    runsToday: today.length,
    cancelled: runs.filter((r) => r.cancelled).length,
    last: runs[0] || null,
    recent: runs.slice(0, 12),
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
