'use client';

/**
 * components/common.jsx — the small shared pieces.
 *
 * Each of these replaces something the vanilla build had two or three copies
 * of: the copy button, the splitter, the markdown block, the email box, the
 * document card. They are deliberately plain — no component library — so the
 * palette in globals.css stays the single source of truth for how this looks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { mdToHtml, writeClipboard, extractEmail, parseEmail } from '@/lib/md.js';
import { kb, stripName } from '@/lib/format.js';

/* ------------------------------------------------------------------ icons */

export const CopyIcon = (p) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const TickIcon = (p) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const Spinner = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--brand)"
       strokeWidth="2.5" className="animate-spin">
    <path d="M21 12a9 9 0 1 1-6.2-8.5" strokeLinecap="round" />
  </svg>
);

/* ------------------------------------------------------------- copy button */

export function CopyButton({ text, label = 'Copy', className = '', title }) {
  const [done, setDone] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    const value = typeof text === 'function' ? text() : text;
    const ok = await writeClipboard(value ?? '');
    setDone(ok);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1400);
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      title={title || label}
      className={`inline-flex items-center gap-1.5 rounded-md border border-[var(--line)]
        bg-[var(--surface-2)] px-2.5 py-1.5 text-[11.5px] font-medium
        text-[var(--text-muted)] transition-colors hover:text-[var(--text)]
        hover:border-[var(--brand)] ${className}`}
    >
      {done ? <TickIcon /> : <CopyIcon />}
      {done ? 'Copied' : label}
    </button>
  );
}

/* ---------------------------------------------------------------- markdown */

/**
 * mdToHtml escapes its input before applying any inline rule and only lets
 * http(s)/mailto through as links, so transcript text cannot inject markup.
 * That is what makes dangerouslySetInnerHTML defensible here.
 */
export function Markdown({ source, className = '' }) {
  if (!source) return null;
  return (
    <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: mdToHtml(source) }} />
  );
}

/* --------------------------------------------------------------- email box */

/**
 * A covering email comes back inside the reply between markers rather than as
 * a file on disk, so the two fields can be copied without opening anything.
 */
export function EmailBox({ email }) {
  if (!email) return null;
  const parsed = typeof email === 'string' ? parseEmail(email) : email;
  if (!parsed) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)]
                      bg-[var(--surface-3)] px-3 py-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--faint)]">
          Covering email
        </span>
        <CopyButton text={() => parsed.clipboard} label="Copy email" />
      </div>

      {parsed.subject && (
        <div className="flex items-baseline gap-2 border-b border-[var(--line-soft)] px-3 py-2">
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--faint)]">
            Subject
          </span>
          <span className="flex-1 text-[12.5px] font-medium">{parsed.subject}</span>
          <CopyButton text={parsed.subject} label="" title="Copy the subject line"
                      className="px-1.5 py-1" />
        </div>
      )}

      <div className="px-3 py-2.5">
        <Markdown source={parsed.body} />
      </div>
    </div>
  );
}

/** Split a reply into its prose and its email block. */
export function useEmailSplit(text) {
  const { email, rest } = extractEmail(text || '');
  return { email, rest };
}

/* ------------------------------------------------------------ document card */

export function DocCard({ file }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || body !== null || loading) return;

    setLoading(true);
    try {
      const d = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`).then((r) => r.json());
      setBody(d.binary
        ? '_This is a Word document — use Download to open it._'
        : (d.content || ''));
    } catch (err) {
      setBody(`_Could not read this file: ${err.message}_`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)]">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand)"
             strokeWidth="1.8" className="flex-none">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <button onClick={toggle} className="flex-1 truncate text-left text-[12.5px] font-medium">
          {stripName(file.name)}
        </button>
        <span className="font-mono text-[10.5px] text-[var(--faint)]">{kb(file.size)}</span>
        <a
          href={`/api/file?path=${encodeURIComponent(file.path)}&raw=1`}
          download
          className="rounded-md border border-[var(--line)] px-2 py-1 text-[11px]
                     text-[var(--text-muted)] no-underline hover:text-[var(--text)]"
        >
          Download
        </a>
      </div>

      {open && (
        <div className="max-h-[320px] overflow-y-auto border-t border-[var(--line)] px-3 py-2.5">
          {loading ? <Spinner /> : <Markdown source={body || ''} />}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- misc */

export function Empty({ children }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-[12.5px] text-[var(--faint)]">
      <div>{children}</div>
    </div>
  );
}

export function Pill({ tone = 'default', children, onRemove, title }) {
  const tones = {
    default: 'border-[var(--line)] bg-[var(--surface-3)] text-[var(--text-muted)]',
    accent: 'border-[var(--brand)]/40 bg-[var(--brand)]/12 text-[var(--brand)]',
    warn: 'border-[var(--warn)]/40 bg-[var(--warn)]/12 text-[var(--warn)]',
    bad: 'border-[var(--bad)]/40 bg-[var(--bad)]/12 text-[var(--bad)]',
    ok: 'border-[var(--ok)]/40 bg-[var(--ok)]/12 text-[var(--ok)]',
  };
  return (
    <span title={title}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-[7px] border
                      px-2 py-1 font-mono text-[10.5px] ${tones[tone] || tones.default}`}>
      <span className="truncate">{children}</span>
      {onRemove && (
        <button onClick={onRemove} className="flex-none opacity-60 hover:opacity-100" title="Remove">
          ×
        </button>
      )}
    </span>
  );
}
