export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as library from '@/library.js';
import { syncFromLibrary } from '@/projects.js';
import { invalidate } from '@/core/cache.js';

/**
 * Re-read the disk.
 *
 * The file tree is memoised for a second, which is right for polling and wrong
 * for "I just added a folder in Finder". This is the button that says so
 * explicitly, rather than shortening the TTL for everybody.
 */
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const scope = searchParams.get('scope') || 'all';

  invalidate('library');
  library.refresh();

  const out = { refreshed: scope, files: library.listFiles().length };
  if (scope === 'projects' || scope === 'all') {
    out.projects = syncFromLibrary();
  }
  return json(out);
}
