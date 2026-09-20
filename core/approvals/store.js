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
  return getApproval(id);
}

export function decideMany(ids, status, note = '') {
  check(status);
  if (!ids?.length) return 0;
  db.update(approvals)
    .set({ status, note: note || null, decidedAt: Date.now() })
    .where(inArray(approvals.id, ids)).run();
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
