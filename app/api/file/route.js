export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { json } from '@/core/http.js';
import * as library from '@/library.js';

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function GET(req) {
  const url = new URL(req.url);
  const target = url.searchParams.get('path') || '';

  if (!target || !library.PREVIEWABLE.test(target)) {
    return json({ error: 'that path is not previewable' }, 403);
  }

  // Resolve symlinks before the root check. Without this a link planted
  // inside a watched folder reads whatever it points at.
  let abs;
  try {
    abs = realpathSync(resolve(target));
  } catch {
    return json({ error: 'no such file' }, 404);
  }
  if (!library.isReadable(abs)) {
    return json({ error: 'that path is not previewable' }, 403);
  }
  if (!existsSync(abs)) return json({ error: 'no such file' }, 404);

  const st = statSync(abs);
  if (st.size > 4e6) return json({ error: 'file too large to preview' }, 413);

  // ?raw=1 serves the bytes, which is how a generated .docx gets downloaded —
  // those cannot be rendered in the browser.
  if (url.searchParams.get('raw')) {
    return new Response(readFileSync(abs), {
      headers: {
        'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
        'content-disposition': `attachment; filename="${basename(abs).replace(/"/g, '')}"`,
        'content-length': String(st.size),
        'cache-control': 'no-store',
      },
    });
  }

  const meta = library.readFile(abs);
  return json({
    path: meta.path,
    name: meta.name,
    size: meta.size,
    mtime: meta.mtime,
    binary: meta.binary,
    content: meta.content,
  });
}
