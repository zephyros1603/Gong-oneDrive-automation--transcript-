export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { json, fail, readBody } from '@/core/http.js';
import * as library from '@/library.js';
import { docxToSnapshot, snapshotToDocx } from '@/core/engine/docx-bridge.js';

/** A .docx file, converted to a Univer document snapshot. */
export async function GET(req) {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || '';

  if (!path || !library.isReadable(path)) return json({ error: 'not a readable path' }, 403);
  if (!existsSync(path)) return json({ error: 'no such file' }, 404);

  try {
    const buffer = readFileSync(path);
    const { snapshot, issues } = await docxToSnapshot(buffer, { name: path.split('/').pop() });
    // Non-fatal by design: still return the snapshot, but flag it, so a shape
    // this bridge did not anticipate shows up as a visible warning rather
    // than a silently wrong document.
    return json({ snapshot, issues });
  } catch (err) {
    return fail(err);
  }
}

/** Save an edited snapshot as a **new** file — the original stays what was reviewed. */
export async function POST(req) {
  const body = await readBody(req);
  const { path, snapshot } = body;

  if (!path || !library.isReadable(path)) return json({ error: 'not a readable path' }, 403);
  if (!snapshot) return json({ error: 'snapshot required' }, 400);

  try {
    const buffer = await snapshotToDocx(snapshot);
    const dot = path.lastIndexOf('.');
    const stem = dot === -1 ? path : path.slice(0, dot);
    const ext = dot === -1 ? '.docx' : path.slice(dot);

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
