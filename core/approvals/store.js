/**
 * core/approvals/store.js — the review queue.
 *
 * A run does not write to a system of record; it proposes. Everything it
 * produces lands here first, and nothing leaves until a person says so.
 *
 * Why this exists rather than trusting the model: at a hundred calls a day,
 * 90% accuracy is ten wrong updates a day flowing into the board people plan
 * from. Bad data there is worse than no data, because it is believed. The goal
 * is not less human involvement — it is *cheaper* human involvement, which
 * means approving a diff rather than authoring a document.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { approvals } from '../db/schema.js';
import { getProject } from '../../projects.js';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { readSettings, expandPath } from '../../settings.js';

const hydrate = (r) => r && ({
  ...r,
  project: r.projectId ? getProject(r.projectId)?.name || null : null,
});

export function listApprovals({ status = 'pending', limit = 100 } = {}) {
  const rows = status === 'all'
    ? db.select().from(approvals).orderBy(desc(approvals.createdAt)).limit(limit).all()
    : db.select().from(approvals).where(eq(approvals.status, status))
        .orderBy(desc(approvals.createdAt)).limit(limit).all();
  return rows.map(hydrate);
}

export const getApproval = (id) =>
  hydrate(db.select().from(approvals).where(eq(approvals.id, id)).get());

export function counts() {
  const rows = db.select({ status: approvals.status, n: sql`COUNT(*)` })
    .from(approvals).groupBy(approvals.status).all();
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export function propose(item) {
  const id = randomUUID();
  db.insert(approvals).values({
    id,
    runId: item.runId || null,
    workflowId: item.workflowId || null,
    projectId: item.projectId || null,
    kind: item.kind || 'document',
    title: String(item.title || '').slice(0, 200),
    path: item.path || null,
    body: item.body || null,
    status: 'pending',
    createdAt: Date.now(),
  }).run();
  return getApproval(id);
}

/**
 * The only two decisions there are. Checked in one place because the bulk path
 * originally skipped it, and a status nothing queries for is worse than a
 * rejection: the row vanishes from every tab and looks like it was never there.
 */
const DECISIONS = ['approved', 'rejected'];

const check = (status) => {
  if (!DECISIONS.includes(status)) throw new Error('unknown decision');
  return status;
};

export function decide(id, status, note = '') {
  check(status);
  db.update(approvals)
    .set({ status, note: note || null, decidedAt: Date.now() })
    .where(eq(approvals.id, id)).run();

  const row = getApproval(id);
  if (status === 'approved') deliverToDestination(row);
  return row;
}

/**
 * Copy an approved document to the configured destination, once.
 *
 * "Approve" already meant something before this existed — the queue entry
 * moves out of pending. This adds a second, optional effect on top of that:
 * if a destination is configured, the file itself lands there too, so
 * approving is the one action that both signs off on a document and puts it
 * where it needs to be.
 *
 * A name collision appends a counter rather than overwriting — the last thing
 * an approval flow should do silently is destroy an earlier approved file
 * because two runs happened to produce the same filename.
 */
function deliverToDestination(row) {
  if (!row || row.kind !== 'document' || !row.path) return;

  const settings = readSettings();
  const destSetting = String(settings.approvalDestDir || '').trim();
  if (!destSetting) return;

  if (!existsSync(row.path)) {
    console.error(`  ! approval ${row.id}: source file is gone, nothing to deliver: ${row.path}`);
    return;
  }

  try {
    const dest = expandPath(destSetting, destSetting);
    mkdirSync(dest, { recursive: true });

    const base = basename(row.path);
    const ext = extname(base);
    const stem = base.slice(0, base.length - ext.length);

    let target = join(dest, base);
    let n = 1;
    while (existsSync(target)) {
      target = join(dest, `${stem} (${n})${ext}`);
      n += 1;
    }

    copyFileSync(row.path, target);
  } catch (err) {
    // A delivery failure must not undo the approval decision — the document
    // was reviewed and signed off on; where the copy ends up is secondary.
    console.error(`  ! approval ${row.id}: could not deliver to destination:`, err.message);
  }
}

export function decideMany(ids, status, note = '') {
  check(status);
  if (!ids?.length) return 0;
  db.update(approvals)
    .set({ status, note: note || null, decidedAt: Date.now() })
    .where(inArray(approvals.id, ids)).run();

  if (status === 'approved') {
    for (const id of ids) deliverToDestination(getApproval(id));
  }
  return ids.length;
}

/**
 * Turn a finished run into pending approvals.
 *
 * Documents are proposed by path; the covering email is proposed as text,
 * because it never becomes a file — it is meant to be pasted into a mail
 * client, which is exactly the moment a person should have read it.
 */
export function proposeFromRun({ runId, workflowId, projectId, documents = [], email = null, label = '' }) {
  const made = [];

  for (const doc of documents) {
    made.push(propose({
      runId, workflowId, projectId,
      kind: 'document',
      title: doc.name || doc.path?.split('/').pop() || 'Document',
      path: doc.path,
    }));
  }

  if (email) {
    made.push(propose({
      runId, workflowId, projectId,
      kind: 'email',
      title: email.subject || `${label} — covering email`,
      body: email.clipboard || email.body || '',
    }));
  }
  return made;
}
