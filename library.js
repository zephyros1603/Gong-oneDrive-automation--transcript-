/**
 * library.js — one view of the transcript library on disk.
 *
 * Shared by serve.js (the web UI) and any other reader, so nothing can drift
 * about where files live or which paths are allowed to be read.
 */

import {
  readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { join, resolve, relative, basename, sep, dirname } from 'node:path';
import { loadConfig, slug } from './gong.js';

export const PREVIEWABLE = /\.(md|txt|srt|vtt|docx|pdf)$/i;
export const READABLE_TEXT = /\.(md|txt|srt|vtt)$/i;
const SORTED_MARKER = '.gong-sorted';

/**
 * Every directory the readers may touch, all derived from config so an
 * external GONG_OUT_DIR is followed everywhere.
 */
export function roots(cfg = loadConfig()) {
  const extra = (cfg.previewDirs || '')
    .split(':')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => ({ label: basename(d) || d, path: resolve(d), kind: 'input' }));

  return [
    { label: 'by day', path: resolve(cfg.outDir), kind: 'input' },
    { label: 'sorted', path: resolve(cfg.sortedDir), kind: 'input' },
    { label: 'documents', path: resolve(cfg.docsDir), kind: 'output' },
    ...extra,
  ].filter((r, i, all) => all.findIndex((o) => o.path === r.path) === i);
}

/** True only for paths inside a configured root. */
export function isReadable(target, cfg = loadConfig()) {
  const abs = resolve(target);
  return roots(cfg).some((r) => abs === r.path || abs.startsWith(r.path + sep));
}

/** Every previewable file under the configured roots, newest first. */
export function listFiles(cfg = loadConfig()) {
  const out = [];

  const walk = (dir, root) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }

    // organize.js marks the trees it writes; re-root so a sorted tree nested
    // inside the day tree is labelled 'sorted' rather than 'by day'.
    const here = entries.includes(SORTED_MARKER)
      ? { ...root, label: 'sorted' }
      : root;

    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }

      if (st.isDirectory()) walk(path, here);
      else if (PREVIEWABLE.test(name)) {
        const rel = relative(here.path, path);
        const parts = rel.split(sep);
        out.push({
          path, rel, name,
          group: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
          root: here.label,
          kind: here.kind,
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  };

  for (const root of roots(cfg)) walk(root.path, root);

  const rank = (r) => (r === 'by day' ? 0 : r === 'sorted' ? 1 : 2);
  out.sort((a, b) => rank(a.root) - rank(b.root) || b.mtime - a.mtime);
  return out;
}

/** Folders with a file count, for choosing what to work on. */
export function listFolders(cfg = loadConfig()) {
  const groups = new Map();
  for (const f of listFiles(cfg)) {
    const key = `${f.kind}\u001f${f.root}\u001f${f.group}`;
    if (!groups.has(key)) {
      groups.set(key, {
        kind: f.kind, root: f.root, folder: f.group, files: 0, newest: 0,
      });
    }
    const g = groups.get(key);
    g.files++;
    g.newest = Math.max(g.newest, f.mtime);
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest);
}

const MAX_READ = 4e6;

/** Read one text file, refusing anything outside the configured roots. */
export function readFile(target, cfg = loadConfig()) {
  if (!target) throw new Error('no path given');
  if (!isReadable(target, cfg)) throw new Error('that path is outside the transcript folders');
  if (!PREVIEWABLE.test(target)) throw new Error('not a readable file type');

  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`no such file: ${abs}`);

  const st = statSync(abs);
  if (st.size > MAX_READ) throw new Error(`file too large (${st.size} bytes)`);

  // Binary deliverables are listed and downloadable but not rendered.
  if (!READABLE_TEXT.test(abs)) {
    return {
      path: abs, name: basename(abs), size: st.size, mtime: st.mtimeMs,
      binary: true, content: '',
    };
  }

  return {
    path: abs,
    name: basename(abs),
    size: st.size,
    mtime: st.mtimeMs,
    binary: false,
    content: readFileSync(abs, 'utf8'),
  };
}

/**
 * Resolve a loose folder name to files — accepts an exact folder, a customer
 * slug, or any substring, so "Pennrose" finds the right transcripts without
 * the caller knowing the layout.
 */
export function findFiles({ folder, query, limit = 200 }, cfg = loadConfig()) {
  const all = listFiles(cfg);
  const needle = String(folder || query || '').trim().toLowerCase();
  if (!needle) return all.slice(0, limit);

  const exact = all.filter((f) => f.group.toLowerCase() === needle);
  if (exact.length) return exact.slice(0, limit);

  return all
    .filter((f) => `${f.group}/${f.name}`.toLowerCase().includes(needle))
    .slice(0, limit);
}

/** Cheap signature of a tree, so the UI can notice new files appearing. */
export function version(kind, cfg = loadConfig()) {
  let count = 0;
  let newest = 0;
  for (const f of listFiles(cfg)) {
    if (kind && f.kind !== kind) continue;
    count++;
    newest = Math.max(newest, f.mtime);
  }
  return `${count}:${Math.round(newest)}`;
}

/** Write a generated document, only ever inside the docs folder. */
export function saveDocument({ name, content, folder = '' }, cfg = loadConfig()) {
  if (!content || !String(content).trim()) throw new Error('no content to save');

  const safeName = `${slug(name || 'document')}.md`;
  const safeFolder = folder ? slug(folder) : '';
  const dir = safeFolder ? join(cfg.docsDir, safeFolder) : cfg.docsDir;
  const path = join(dir, safeName);

  // slug() strips separators, but assert containment anyway.
  if (!resolve(path).startsWith(resolve(cfg.docsDir) + sep)) {
    throw new Error('refusing to write outside the documents folder');
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(content), 'utf8');

  return { path, name: safeName, folder: safeFolder, bytes: Buffer.byteLength(content) };
}
