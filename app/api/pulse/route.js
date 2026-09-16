export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as library from '@/library.js';
import { cookieVersion } from '@/core/gong/cookie.js';

export async function GET() {
  return json({
    cookieVersion: cookieVersion(),
    inputVersion: library.version('input'),
    outputVersion: library.version('output'),
  });
}
