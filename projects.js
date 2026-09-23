/**
 * projects.js — one workspace per customer, with a persistent chat.
 *
 * A project is the durable thing: it owns the transcripts for a customer, the
 * conversation about them, and the Claude Code session id that conversation
 * runs in. Everything is in the database so a reload, a tab switch, or a
 * server restart leaves the chat exactly where it was.
 *
 * Transcripts are rows rather than a JSON array on the project, so the
 * organizer adding one file does not rewrite the project — which is what made
 * the old whole-file rewrite lose concurrent updates.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql, inArray, notInArray } from 'drizzle-orm';
import { listFiles } from './library.js';
import { db } from './core/db/client.js';
import {
  projects as projectsTable, projectTranscripts, messages as messagesTable,
  toMicros, fromMicros,
} from './core/db/schema.js';

/** Chats grow without bound otherwise; this is generous for a customer. */
const MAX_MESSAGES = 400;

const parse = (s, fallback = null) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

function transcriptsFor(id) {
  return db.select({ path: projectTranscripts.path }).from(projectTranscripts)
    .where(and(eq(projectTranscripts.projectId, id), eq(projectTranscripts.kind, 'transcript')))
    .orderBy(desc(projectTranscripts.addedAt)).all().map((r) => r.path);
}

/**
 * Context files attached to a customer — the CX Portal view today.
 *
 * Separate from transcripts because they are maintained separately: these are
 * rewritten whenever the tracker is re-read, while transcripts arrive once and
 * stay. Keeping them apart is also what stops syncFromLibrary, which rebuilds
 * transcripts from the sorted tree, from deleting every one of them.
 */
function filesByKind(id, kind) {
  return db.select({ path: projectTranscripts.path, source: projectTranscripts.source,
                     addedAt: projectTranscripts.addedAt })
    .from(projectTranscripts)
    .where(and(eq(projectTranscripts.projectId, id), eq(projectTranscripts.kind, kind)))
    .orderBy(desc(projectTranscripts.addedAt)).all();
}

export const contextFor = (id) => filesByKind(id, 'context');

/**
 * The per-customer digest — a compact, Claude-written summary standing in for
 * the raw transcripts and tracker rows it was built from. See
 * core/workflow/digest.js for how it is generated and kept current.
 */
export const digestFor = (id) => filesByKind(id, 'digest');

/**
 * Attach a rendered file to a customer, replacing any earlier one at the same
 * path. Shared by `context` (the CX Portal tracker view) and `digest` (the
 * summarized stand-in for everything) — both are "what a run about this
 * customer may see that isn't a call transcript," and differ only in kind.
 */
export function attachContext(projectId, path, source = null, kind = 'context') {
  db.insert(projectTranscripts)
    .values({ projectId, path, kind, source, addedAt: Date.now() })
    .onConflictDoUpdate({
      target: [projectTranscripts.projectId, projectTranscripts.path],
      set: { kind, source, addedAt: Date.now() },
    })
    .run();
  return filesByKind(projectId, kind);
}

function messagesFor(id) {
  return db.select().from(messagesTable)
    .where(eq(messagesTable.projectId, id))
    .orderBy(messagesTable.at).all()
    .map((m) => ({
      id: m.id,
      at: m.at,
      role: m.role,
      text: m.text || '',
      runId: m.runId || undefined,
      pending: Boolean(m.pending),
      cancelled: Boolean(m.cancelled),
      sessionReset: Boolean(m.sessionReset),
      cost: fromMicros(m.cost),
      durationMs: m.durationMs ?? null,
      turns: m.turns ?? null,
      skill: parse(m.skill, null),
      files: parse(m.files, []),
      documents: parse(m.documents, []),
    }));
}

function hydrate(row, { withBody = true } = {}) {
  if (!row) return null;
  const transcripts = transcriptsFor(row.id);
  const context = contextFor(row.id);
  const digest = digestFor(row.id);
  const messages = withBody ? messagesFor(row.id) : [];
  const messageCount = withBody
    ? messages.length
    : Number(db.select({ c: sql`COUNT(*)` }).from(messagesTable)
        .where(eq(messagesTable.projectId, row.id)).get()?.c ?? 0);

  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    customer: row.customer || '',
    sessionId: row.sessionId,
    transcripts,
    // What the connectors know about this customer, as files. Carried on the
    // project so a page can show delivery state beside the call history
    // without a second round trip.
    context,
    digest,
    messages,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount,
    transcriptCount: transcripts.length,
    contextCount: context.length,
    digestCount: digest.length,
  };
}

/** The list view never needs message bodies, only the count. */
export function listProjects() {
  return db.select().from(projectsTable).orderBy(projectsTable.createdAt).all()
    .map((r) => hydrate(r, { withBody: false }));
}

export function getProject(id) {
  return hydrate(db.select().from(projectsTable).where(eq(projectsTable.id, id)).get());
}

export function createProject({ name, folder = '', customer = '' }) {
  const label = String(name || customer || folder || '').trim();
  if (!label) throw new Error('a project needs a name');

  const now = Date.now();
  const id = randomUUID();
  db.insert(projectsTable).values({
    id, name: label, folder: folder || label, customer: customer || label,
    sessionId: null, createdAt: now, updatedAt: now,
  }).run();

  return getProject(id);
}

export function updateProject(id, patch) {
  const fields = {};
  for (const k of ['name', 'folder', 'customer', 'sessionId']) {
    if (patch[k] !== undefined) fields[k] = patch[k];
  }
  if (!Object.keys(fields).length) return getProject(id);

  fields.updatedAt = Date.now();
  db.update(projectsTable).set(fields).where(eq(projectsTable.id, id)).run();
  return getProject(id);
}

export function deleteProject(id) {
  db.delete(messagesTable).where(eq(messagesTable.projectId, id)).run();
  db.delete(projectTranscripts).where(eq(projectTranscripts.projectId, id)).run();
  const r = db.delete(projectsTable).where(eq(projectsTable.id, id)).run();
  return r.changes > 0;
}

export function appendMessage(id, message) {
  const row = {
    id: randomUUID(),
    projectId: id,
    role: message.role || 'user',
    text: message.text || '',
    runId: message.runId || null,
    pending: Boolean(message.pending),
    cancelled: Boolean(message.cancelled),
    sessionReset: Boolean(message.sessionReset),
    cost: toMicros(message.cost),
    durationMs: message.durationMs ?? null,
    turns: message.turns ?? null,
    skill: message.skill ? JSON.stringify(message.skill) : null,
    files: message.files ? JSON.stringify(message.files) : null,
    documents: message.documents ? JSON.stringify(message.documents) : null,
    at: Date.now(),
  };

  db.insert(messagesTable).values(row).run();
  db.update(projectsTable).set({ updatedAt: row.at }).where(eq(projectsTable.id, id)).run();
  trimMessages(id);

  return { ...message, id: row.id, at: row.at };
}

export function updateMessage(id, messageId, patch) {
  const fields = { };
  if (patch.text !== undefined) fields.text = patch.text;
  if (patch.pending !== undefined) fields.pending = Boolean(patch.pending);
  if (patch.cancelled !== undefined) fields.cancelled = Boolean(patch.cancelled);
  if (patch.cost !== undefined) fields.cost = toMicros(patch.cost);
  if (patch.durationMs !== undefined) fields.durationMs = patch.durationMs;
  if (patch.turns !== undefined) fields.turns = patch.turns;
  if (patch.documents !== undefined) fields.documents = JSON.stringify(patch.documents);

  if (Object.keys(fields).length) {
    db.update(messagesTable)
      .set(fields)
      .where(and(eq(messagesTable.id, messageId), eq(messagesTable.projectId, id)))
      .run();
    db.update(projectsTable).set({ updatedAt: Date.now() })
      .where(eq(projectsTable.id, id)).run();
  }
  return getProject(id);
}

function trimMessages(id) {
  const keep = db.select({ id: messagesTable.id }).from(messagesTable)
    .where(eq(messagesTable.projectId, id))
    .orderBy(desc(messagesTable.at)).limit(MAX_MESSAGES).all().map((r) => r.id);
  if (keep.length < MAX_MESSAGES) return;
  db.delete(messagesTable)
    .where(and(eq(messagesTable.projectId, id), notInArray(messagesTable.id, keep))).run();
}

/**
 * Drop the Claude session but keep the visible history. The next question
 * then starts with no context — which is the point: context is what costs.
 */
export function resetSession(id) {
  return updateProject(id, { sessionId: null });
}

/**
 * Create a project for every customer folder that does not have one yet, and
 * attach each folder's transcripts.
 *
 * Matching is on the folder name written by organize.js, so a customer whose
 * display name is later edited keeps its transcripts.
 */
export function syncFromLibrary({ createMissing = true } = {}) {
  const files = listFiles().filter((f) => f.kind === 'input' && f.root === 'sorted');

  const byFolder = new Map();
  for (const f of files) {
    if (!f.group) continue;
    if (!byFolder.has(f.group)) byFolder.set(f.group, []);
    byFolder.get(f.group).push(f.path);
  }

  const created = [];
  const updated = [];
  const now = Date.now();

  for (const [folder, paths] of byFolder) {
    let row = db.select().from(projectsTable).where(eq(projectsTable.folder, folder)).get();

    if (!row) {
      if (!createMissing) continue;
      const id = randomUUID();
      // The folder is a slug; a readable name reads better in the tab.
      const name = folder.replace(/-/g, ' ');
      db.insert(projectsTable).values({
        id, name, folder, customer: name, sessionId: null,
        createdAt: now, updatedAt: now,
      }).run();
      row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      created.push(name);
    }

    const before = new Set(transcriptsFor(row.id));
    const added = paths.filter((x) => !before.has(x));
    if (added.length) {
      for (const path of added) {
        db.insert(projectTranscripts)
          .values({ projectId: row.id, path, kind: 'transcript', source: 'gong', addedAt: now })
          .onConflictDoNothing()
          .run();
      }
      db.update(projectsTable).set({ updatedAt: now })
        .where(eq(projectsTable.id, row.id)).run();
      updated.push({ name: row.name, added: added.length });
    }
  }

  // Drop transcripts whose files have gone, so counts stay honest.
  //
  // Scoped to kind 'transcript'. This rebuilds from the sorted tree, and a
  // context file lives in warp-context and is therefore never in `live` — an
  // unscoped delete here wiped every CX Portal link on the next sync.
  const live = files.map((f) => f.path);
  const isTranscript = eq(projectTranscripts.kind, 'transcript');
  if (live.length) {
    db.delete(projectTranscripts)
      .where(and(isTranscript, notInArray(projectTranscripts.path, live))).run();
  } else {
    db.delete(projectTranscripts).where(isTranscript).run();
  }

  const total = Number(
    db.select({ c: sql`COUNT(*)` }).from(projectsTable).get()?.c ?? 0
  );
  return { created, updated, projects: total };
}

/** Which project a transcript path belongs to, if any. */
export function projectForPath(path) {
  const row = db.select({ projectId: projectTranscripts.projectId })
    .from(projectTranscripts).where(eq(projectTranscripts.path, path)).get();
  return row ? getProject(row.projectId) : null;
}
