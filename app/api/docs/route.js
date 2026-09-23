export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, fail } from '@/core/http.js';

/**
 * Serves committed reference docs into a UI panel, e.g. the Engine page's
 * "Full reference" view. A fixed whitelist, not a raw path — `docs/` isn't
 * secret, but a route that reads whatever filename it's given is a bad habit
 * to have anywhere in this app.
 */
const DOCS = {
  'engine-api': 'engine-api.md',
  'cxportal-api': 'cxportal-api.md',
};

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get('name') || 'engine-api';
  const file = DOCS[name];
  if (!file) return json({ error: `unknown doc: ${name}`, known: Object.keys(DOCS) }, 400);

  try {
    const text = readFileSync(join(process.cwd(), 'docs', file), 'utf8');
    return json({ name, text });
  } catch (err) {
    return fail(err);
  }
}
