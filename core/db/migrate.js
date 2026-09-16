/**
 * core/db/migrate.js — bring projects.json and settings.json into SQLite.
 *
 *   node core/db/migrate.js            # import, then rename the originals
 *   node core/db/migrate.js --dry-run  # say what would happen
 *   node core/db/migrate.js --keep     # import but leave the files in place
 *
 * Runs once and is safe to run again: every insert is keyed, so a second pass
 * updates rather than duplicating. The originals are renamed rather than
 * deleted — a migration that eats the only copy of a chat history is not a
 * migration anyone should trust.
 */

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PROJECT_ROOT } from '../paths.js';
import { db } from './client.js';
import {
  projects as projectsTable, projectTranscripts, messages as messagesTable,
  settings as settingsTable, usage as usageTable, automationHistory, toMicros,
} from './schema.js';

const read = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

export function migrate({ dryRun = false, keep = false } = {}) {
  const report = { projects: 0, transcripts: 0, messages: 0, usage: 0, history: 0, settings: false };

  const projectsPath = join(PROJECT_ROOT, 'projects.json');
  const settingsPath = join(PROJECT_ROOT, 'settings.json');

  // ---- projects, their transcripts and their chats ----
  const store = read(projectsPath);
  for (const p of store?.projects || []) {
    report.projects += 1;
    report.transcripts += (p.transcripts || []).length;
    report.messages += (p.messages || []).length;
    if (dryRun) continue;

    const existing = db.select().from(projectsTable)
      .where(eq(projectsTable.folder, p.folder || p.name)).get();
    const id = existing?.id || p.id || randomUUID();

    if (existing) {
      db.update(projectsTable).set({
        name: p.name, customer: p.customer || '', sessionId: p.sessionId ?? null,
        updatedAt: p.updatedAt || Date.now(),
      }).where(eq(projectsTable.id, id)).run();
    } else {
      db.insert(projectsTable).values({
        id,
        name: p.name,
        folder: p.folder || p.name,
        customer: p.customer || '',
        sessionId: p.sessionId ?? null,
        createdAt: p.createdAt || Date.now(),
        updatedAt: p.updatedAt || Date.now(),
      }).run();
    }

    for (const path of p.transcripts || []) {
      db.insert(projectTranscripts)
        .values({ projectId: id, path, addedAt: p.updatedAt || Date.now() })
        .onConflictDoNothing().run();
    }

    for (const m of p.messages || []) {
      const mid = m.id || randomUUID();
      if (db.select().from(messagesTable).where(eq(messagesTable.id, mid)).get()) continue;
      db.insert(messagesTable).values({
        id: mid,
        projectId: id,
        role: m.role || 'user',
        text: m.text || '',
        runId: m.runId || null,
        // A reply still marked pending belongs to a run that died with the
        // old process; it is never going to arrive.
        pending: false,
        cancelled: Boolean(m.cancelled),
        sessionReset: Boolean(m.sessionReset),
        cost: toMicros(m.cost),
        durationMs: m.durationMs ?? null,
        turns: m.turns ?? null,
        skill: m.skill ? JSON.stringify(m.skill) : null,
        files: m.files ? JSON.stringify(m.files) : null,
        documents: m.documents ? JSON.stringify(m.documents) : null,
        at: m.at || Date.now(),
      }).run();
    }
  }

  // ---- settings, usage log and automation history ----
  const s = read(settingsPath);
  if (s) {
    report.usage = (s.usage || []).length;
    report.history = (s.automation?.history || []).length;
    report.settings = true;

    if (!dryRun) {
      const { usage = [], ...rest } = s;
      rest.version = 2;
      db.insert(settingsTable)
        .values({ key: 'app', value: JSON.stringify(rest) })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(rest) } })
        .run();

      // Only import usage into an empty table, or a re-run doubles the total.
      const already = db.select().from(usageTable).limit(1).all().length;
      if (!already) {
        for (const u of usage) {
          db.insert(usageTable).values({
            at: u.at || Date.now(),
            actionId: u.actionId || '',
            label: u.label || '',
            costUsd: toMicros(u.costUsd || 0),
            durationMs: u.durationMs || 0,
            turns: u.turns || 0,
            files: u.files || 0,
            cancelled: Boolean(u.cancelled),
          }).run();
        }
      }

      const hadHistory = db.select().from(automationHistory).limit(1).all().length;
      if (!hadHistory) {
        for (const h of s.automation?.history || []) {
          db.insert(automationHistory).values({
            at: h.at || Date.now(),
            kind: h.kind || 'ok',
            trigger: h.trigger || null,
            pulled: h.pulled || 0,
            organized: h.organized || 0,
            projects: h.projects || 0,
            durationMs: h.durationMs ?? null,
            errors: JSON.stringify(h.errors || []),
          }).run();
        }
      }
    }
  }

  if (!dryRun && !keep) {
    for (const p of [projectsPath, settingsPath]) {
      if (existsSync(p)) renameSync(p, `${p}.migrated`);
    }
    report.renamed = true;
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const r = migrate({
    dryRun: argv.includes('--dry-run'),
    keep: argv.includes('--keep'),
  });
  console.log(
    `\n  projects ${r.projects} · transcripts ${r.transcripts} · messages ${r.messages}` +
    `\n  usage ${r.usage} · automation history ${r.history} · settings ${r.settings ? 'yes' : 'no'}` +
    (r.renamed ? '\n  originals renamed .migrated\n' : '\n')
  );
}
