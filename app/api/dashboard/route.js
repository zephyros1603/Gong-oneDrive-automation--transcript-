export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import { sql, gte, desc, eq } from 'drizzle-orm';
import { db } from '@/core/db/client.js';
import {
  usage as usageTable, runs as runsTable, automationHistory,
  projects as projectsTable, projectTranscripts, fromMicros,
} from '@/core/db/schema.js';
import * as library from '@/library.js';
import { loadConfig } from '@/gong.js';
import { inspectCookie } from '@/core/gong/diagnose.js';
import { listSkills, listJobs } from '@/claude-runner.js';
import { readSettings } from '@/settings.js';
import { schedulerState } from '@/automation.js';

const DAY = 86400e3;

/**
 * Everything the dashboard shows, in one request.
 *
 * One endpoint rather than nine: the widgets all refresh together anyway, and
 * nine parallel fetches on a page that polls is how the top bar ended up
 * hammering the server.
 */
export async function GET() {
  const settings = readSettings();
  const files = library.listFiles();
  const now = Date.now();

  // ---- transcripts -------------------------------------------------------
  const transcripts = files.filter((f) => f.kind === 'input');
  const documents = files.filter((f) => f.kind === 'output');
  const pulled7d = transcripts.filter((f) => now - f.mtime < 7 * DAY).length;

  // ---- session -----------------------------------------------------------
  const cfg = loadConfig();
  const cookie = inspectCookie(cfg.cookie);
  const expiresAt = cookie.cellExpires || cookie.loginExpires || null;

  // ---- skills ------------------------------------------------------------
  const installed = new Set(listSkills().map((s) => s.name));
  const actions = settings.actions.map((a) => ({
    id: a.id, label: a.label, skill: a.skill, installed: installed.has(a.skill),
  }));

  // ---- spend -------------------------------------------------------------
  const spendByDay = db.select({
    day: sql`strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime')`,
    total: sql`COALESCE(SUM(cost_usd), 0)`,
    runs: sql`COUNT(*)`,
  }).from(usageTable)
    .where(gte(usageTable.at, now - 30 * DAY))
    .groupBy(sql`1`).orderBy(sql`1`).all()
    .map((r) => ({ day: r.day, usd: fromMicros(Number(r.total)) || 0, runs: Number(r.runs) }));

  const byAction = db.select({
    action: usageTable.actionId,
    n: sql`COUNT(*)`,
    total: sql`COALESCE(SUM(cost_usd), 0)`,
  }).from(usageTable).groupBy(usageTable.actionId).all()
    .map((r) => ({ action: r.action || 'other', runs: Number(r.n), usd: fromMicros(Number(r.total)) || 0 }))
    .sort((a, b) => b.usd - a.usd);

  // ---- run outcomes ------------------------------------------------------
  // A run recorded with no cost was cancelled before the CLI reported one.
  // Worth surfacing: it is a third of all runs and invisible everywhere else.
  const outcome = db.select({
    cancelled: sql`COALESCE(SUM(cancelled), 0)`,
    zero: sql`COALESCE(SUM(CASE WHEN cost_usd IS NULL OR cost_usd = 0 THEN 1 ELSE 0 END), 0)`,
    n: sql`COUNT(*)`,
  }).from(usageTable).get();

  // ---- automation --------------------------------------------------------
  const schedule = schedulerState();
  const history = db.select().from(automationHistory)
    .where(gte(automationHistory.at, now - 28 * DAY))
    .orderBy(desc(automationHistory.at)).all();

  // Monday-first, because a working week is what this is read against.
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (const h of history) {
    const d = new Date(h.at).getDay();
    weekdays[(d + 6) % 7] += 1;
  }

  // ---- projects needing attention ---------------------------------------
  // Customers with transcripts but nothing generated recently: the first
  // concrete step toward the commitment-ledger idea in docs/product-notes.md.
  // Three queries, not 2N+1. The previous shape ran two per project and was
  // the single slowest thing on the most-polled endpoint in the app.
  const projectRows = db.select().from(projectsTable).all();

  const tAgg = new Map(db.select({
    projectId: projectTranscripts.projectId,
    last: sql`MAX(added_at)`,
    n: sql`COUNT(*)`,
  }).from(projectTranscripts).groupBy(projectTranscripts.projectId).all()
    .map((r) => [r.projectId, r]));

  const rAgg = new Map(db.select({
    projectId: runsTable.projectId,
    at: sql`MAX(ended_at)`,
  }).from(runsTable).groupBy(runsTable.projectId).all()
    .map((r) => [r.projectId, r]));

  const stale = projectRows.map((p) => {
    const t = tAgg.get(p.id);
    const r = rAgg.get(p.id);
    return {
      id: p.id,
      name: p.name,
      transcripts: Number(t?.n ?? 0),
      lastTranscriptAt: Number(t?.last ?? 0) || null,
      lastRunAt: Number(r?.at ?? 0) || null,
    };
  })
    .filter((p) => p.transcripts > 0 && (!p.lastRunAt || p.lastRunAt < p.lastTranscriptAt))
    .sort((a, b) => (b.lastTranscriptAt || 0) - (a.lastTranscriptAt || 0));

  return json({
    transcripts: {
      total: transcripts.length,
      last7d: pulled7d,
      documents: documents.length,
      // Not "processed" — that needs per-run file tracking, which is not
      // recorded yet. This is the honest number available today.
      latestAt: transcripts.reduce((m, f) => Math.max(m, f.mtime), 0) || null,
    },
    session: {
      host: cfg.host,
      email: cookie.email,
      expiresAt,
      daysLeft: expiresAt ? Math.floor((expiresAt - now) / DAY) : null,
      missing: cookie.missing,
    },
    skills: {
      installed: [...installed],
      actions,
      missing: actions.filter((a) => !a.installed).length,
    },
    spend: { byDay: spendByDay, byAction, ...summariseSpend(spendByDay) },
    outcomes: {
      total: Number(outcome?.n ?? 0),
      cancelled: Number(outcome?.cancelled ?? 0),
      noCost: Number(outcome?.zero ?? 0),
    },
    automation: {
      enabled: Boolean(schedule.enabled),
      time: schedule.time,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      missed: schedule.missed,
      weekdays,
      recent: history.slice(0, 6).map((h) => ({
        at: h.at, kind: h.kind, pulled: h.pulled, organized: h.organized, projects: h.projects,
      })),
    },
    // Deliberately no process scan here: it costs a blocking 42ms execSync and
    // this endpoint polls. The Workbench panel that genuinely needs the
    // machine-wide list asks /api/claude-processes for it.
    running: { jobs: listJobs() },
    attention: stale.slice(0, 6),
  });
}

function summariseSpend(byDay) {
  const today = new Date().toISOString().slice(0, 10);
  const total = byDay.reduce((n, d) => n + d.usd, 0);
  return {
    total30d: total,
    today: byDay.find((d) => d.day === today)?.usd || 0,
    peak: byDay.reduce((m, d) => Math.max(m, d.usd), 0),
  };
}
