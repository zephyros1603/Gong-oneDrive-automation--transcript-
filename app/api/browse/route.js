export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { json } from '@/core/http.js';

/**
 * List one directory, anywhere on disk — not confined to the library roots
 * every other file operation in Warp uses.
 *
 * That is a deliberate widening, made for exactly one purpose: picking where
 * an approved document should be copied to. It is read-only — this route
 * never opens a file's contents, only names and whether each entry is a
 * directory — and it is the only place in the app that works this way.
 * Everything downstream (the actual copy, on approval) still writes only to
 * the one path a person explicitly chose here, never anywhere this listing
 * merely showed them.
 */
export async function GET(req) {
  const url = new URL(req.url);
  const target = url.searchParams.get('path') || homedir();
  const abs = resolve(target);

  if (!existsSync(abs)) return json({ error: 'no such path' }, 404);

  let st;
  try { st = statSync(abs); } catch (err) { return json({ error: err.message }, 403); }
  if (!st.isDirectory()) return json({ error: 'not a directory' }, 400);

  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return json({ error: `cannot read this folder: ${err.message}` }, 403);
  }

  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;   // dotfiles clutter a destination picker without helping it
    const entryPath = join(abs, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && safeIsDir(entryPath));
    (isDir ? dirs : files).push({ name: e.name, path: entryPath, isDirectory: isDir });
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return json({
    path: abs,
    parent: abs === resolve('/') ? null : dirname(abs),
    home: homedir(),
    entries: [...dirs, ...files],
  });
}

function safeIsDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
