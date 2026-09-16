export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json } from '@/core/http.js';
import * as library from '@/library.js';
import { readSettings } from '@/settings.js';

export async function GET() {
  const settings = readSettings();
  return json({
    roots: library.roots(),
    folders: library.listFolders(),
    files: library.listFiles(),
    outputDir: settings.outputDir,
    inputVersion: library.version('input'),
    outputVersion: library.version('output'),
  });
}
