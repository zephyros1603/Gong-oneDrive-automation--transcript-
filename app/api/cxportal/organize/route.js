export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { organizeCxPortal } from '@/core/connectors/cxportal-organize.js';
import { correlate } from '@/core/correlate.js';
import * as projects from '@/projects.js';

/**
 * What the correlation looks like right now, without fetching anything.
 *
 * Reads the CX Portal context already attached to each customer, so the page
 * can show the join before anyone spends a portal round trip on it.
 */
export async function GET() {
  const all = projects.listProjects();
  return json({
    customers: all.map((p) => ({
      id: p.id,
      name: p.name,
      transcripts: p.transcriptCount,
      context: (p.context || []).map((c) => ({ path: c.path, source: c.source, at: c.addedAt })),
    })),
    linked: all.filter((p) => (p.context || []).some((c) => c.source === 'cxportal')).length,
  });
}

/** Fetch my tracker, write it per customer, link it. `dryRun` previews. */
export async function POST(req) {
  const body = await readBody(req);
  try {
    return json({
      result: await organizeCxPortal({
        dryRun: body.dryRun === true,
        createMissing: body.createMissing === true,
        link: body.link !== false,
      }),
    });
  } catch (err) {
    return fail(err);
  }
}
