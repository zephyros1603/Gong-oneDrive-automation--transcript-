export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as library from '@/library.js';

export async function GET() {
  const roots = library.roots();
  return json({
    files: library.listFiles(),
    roots: roots.map((r) => ({ ...r, exists: true })),
  });
}
