export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readFileSync, existsSync, statSync, realpathSync, createReadStream } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { json } from '@/core/http.js';
import * as library from '@/library.js';
import { Readable } from 'node:stream';

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

  // ?raw=1 serves the bytes — either as a download (the "Download the
  // original" link) or, with &inline=1 added, as something a viewer embedded
  // in the page can read.
  //
  // The distinction is not cosmetic. `content-disposition: attachment` does
  // not just rename the save dialog — for a PDF or a .docx requested by an
  // embedded viewer (RPProvider's own internal `fetch`, or an <iframe>-style
  // load), Chrome treats "attachment" as an instruction to download the
  // response rather than hand its bytes to the page, and the request that
  // triggered it comes back `net::ERR_ABORTED` with nothing rendered — a
  // failure with no error surfaced to the viewer's own error boundary, since
  // from its side nothing "failed", the browser just intercepted the
  // response before it arrived. `inline` is what lets the same bytes go
  // either way depending on what asked for them.
  if (url.searchParams.get('raw')) {
    const inline = url.searchParams.get('inline');
    const disposition = `${inline ? 'inline' : 'attachment'}; filename="${basename(abs).replace(/"/g, '')}"`;
    const contentType = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';

    // pdf.js — underneath @pdf-viewer/react — probes with a Range request
    // before it trusts a server to serve a PDF in chunks. Ignoring that
    // header and returning the full file as a plain 200 does not just waste
    // the chunking: the browser aborts the request outright
    // (`net::ERR_ABORTED`), with nothing surfaced to the viewer's own error
    // boundary — from its side nothing "failed", the response just never
    // arrived in the shape it was told to expect. `Accept-Ranges` alone is
    // not enough; an actual `Range:` header has to get an actual 206.
    const range = req.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : st.size - 1;
        if (start < st.size && end < st.size && start <= end) {
          const stream = Readable.toWeb(createReadStream(abs, { start, end }));
          return new Response(stream, {
            status: 206,
            headers: {
              'content-type': contentType,
              'content-disposition': disposition,
              'content-range': `bytes ${start}-${end}/${st.size}`,
              'content-length': String(end - start + 1),
              'accept-ranges': 'bytes',
              'cache-control': 'no-store',
            },
          });
        }
        // An out-of-bounds range is a real error, not a fallback case — a
        // full 200 here would look like a range response was honoured when
        // it was not.
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${st.size}` },
        });
      }
    }

    return new Response(readFileSync(abs), {
      headers: {
        'content-type': contentType,
        'content-disposition': disposition,
        'content-length': String(st.size),
        'accept-ranges': 'bytes',
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
