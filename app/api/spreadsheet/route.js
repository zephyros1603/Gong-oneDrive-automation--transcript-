export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { json, fail, readBody } from '@/core/http.js';
import * as library from '@/library.js';
import { xlsxToSnapshot, snapshotToXlsx } from '@/core/engine/xlsx-bridge.js';

/** An .xlsx file, converted to a Univer workbook snapshot. */
export async function GET(req) {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || '';

  if (!path || !library.isReadable(path)) return json({ error: 'not a readable path' }, 403);
  if (!existsSync(path)) return json({ error: 'no such file' }, 404);

  try {
    const buffer = readFileSync(path);
    const snapshot = xlsxToSnapshot(buffer, { name: path.split('/').pop() });
    return json({ snapshot });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Save an edited snapshot as a **new** file, never overwriting the original.
 *
 * The original is what a run produced and what was reviewed; overwriting it
 * in place would make "what was approved" and "what is on disk" quietly
 * diverge the moment someone tweaks a cell.
 */
export async function POST(req) {
  const body = await readBody(req);
  const { path, snapshot } = body;

  if (!path || !library.isReadable(path)) return json({ error: 'not a readable path' }, 403);
  if (!snapshot) return json({ error: 'snapshot required' }, 400);

  try {
    const buffer = snapshotToXlsx(snapshot);
    const dot = path.lastIndexOf('.');
    const stem = dot === -1 ? path : path.slice(0, dot);
    const ext = dot === -1 ? '.xlsx' : path.slice(dot);

    let target = `${stem} (edited)${ext}`;
    let n = 2;
    while (existsSync(target)) {
      target = `${stem} (edited ${n})${ext}`;
      n += 1;
    }

    writeFileSync(target, buffer);
    library.refresh();
    return json({ path: target });
  } catch (err) {
    return fail(err);
  }
}
