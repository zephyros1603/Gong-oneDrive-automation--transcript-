'use client';

/**
 * Preview — the transcript browser.
 *
 * A filterable list on the left, the rendered file on the right, with a Copy
 * that takes the original markdown rather than the rendered text.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CopyButton, Markdown, Empty, Spinner } from '@/components/common.jsx';
import SidebarLayout, { SidebarToggle } from '@/components/SidebarLayout.jsx';
import { kb, stripName, ago } from '@/lib/format.js';

function PreviewInner() {
  const params = useSearchParams();
  const [files, setFiles] = useState([]);
  const [roots, setRoots] = useState([]);
  const [filter, setFilter] = useState('');
  const [current, setCurrent] = useState(null);
  const [body, setBody] = useState(null);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    fetch('/api/files').then((r) => r.json()).then((d) => {
      setFiles(d.files || []);
      setRoots(d.roots || []);
    }).catch(() => {});
  }, []);

  const open = useCallback(async (path) => {
    setCurrent(path);
    setDrawer(false);
    setLoading(true);
    setBody(null);
    try {
      const d = await fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => r.json());
      setBody(d);
    } catch (err) {
      setBody({ error: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  // Deep link: /preview?path=… opens that file straight away.
  useEffect(() => {
    const p = params.get('path');
    if (p) open(p);
  }, [params, open]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = q
      ? files.filter((f) => f.name.toLowerCase().includes(q) || (f.group || '').toLowerCase().includes(q))
      : files;

    const by = new Map();
    for (const f of shown) {
      const key = f.group || f.root || 'other';
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(f);
    }
    return [...by.entries()];
  }, [files, filter]);

  const sidebar = (
    <>
        <div className="flex-none border-b border-[var(--line)] p-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                       px-2.5 py-2 text-[12.5px] outline-none placeholder:text-[var(--faint)]
                       focus:border-[var(--brand)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {files.length === 0 && (
            <div className="p-3 text-[11.5px] leading-relaxed text-[var(--bad)]">
              No previewable files. Searched:
              {roots.map((r) => (
                <div key={r.path} className="mt-1 font-mono text-[10.5px] break-all">{r.path}</div>
              ))}
            </div>
          )}

          {groups.map(([group, items]) => (
            <div key={group} className="mb-3">
              <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider
                              text-[var(--faint)]">
                {group} <span className="opacity-60">{items.length}</span>
              </div>
              {items.map((f) => (
                <button
                  key={f.path}
                  onClick={() => open(f.path)}
                  className={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors
                    ${current === f.path ? 'bg-[var(--brand)]/15' : 'hover:bg-[var(--surface-2)]'}`}
                >
                  <span className="block truncate text-[12px]">{stripName(f.name)}</span>
                  <span className="block font-mono text-[10px] text-[var(--faint)]">
                    {kb(f.size)} · {ago(f.mtime)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
    </>
  );

  return (
    <SidebarLayout sidebar={sidebar} open={drawer} onOpenChange={setDrawer}
                   storageKey="gong.preview.sidebar">
      <div className="flex flex-none items-center gap-2.5 border-b border-[var(--line)]
                      px-4 py-2.5 lg:hidden">
        <SidebarToggle onClick={() => setDrawer(true)} label="Show files" />
        <span className="truncate text-[12.5px] font-medium">
          {current ? stripName(current.split('/').pop()) : 'Files'}
        </span>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!current && <Empty>Pick a file to read it.</Empty>}

        {current && (
          <div className="mx-auto max-w-[820px] p-4 sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold">
                  {stripName(body?.name || current.split('/').pop())}
                </h1>
                <div className="mt-0.5 font-mono text-[10.5px] break-all text-[var(--faint)]">
                  {current}
                </div>
              </div>
              {body?.content && <CopyButton text={body.content} label="Copy markdown" />}
            </div>

            {loading && <Spinner />}
            {body?.error && <p className="text-[12.5px] text-[var(--bad)]">{body.error}</p>}

            {body?.binary && (
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-5
                              text-center text-[12.5px] text-[var(--text-muted)]">
                This is a Word document and cannot be rendered here.
                <a href={`/api/file?path=${encodeURIComponent(current)}&raw=1`} download
                   className="ml-2 text-[var(--brand)] no-underline">Download it</a>
              </div>
            )}

            {body?.content && !body.binary && (
              /\.(srt|vtt)$/i.test(current)
                // Subtitles through a markdown parser come out mangled.
                ? <pre className="overflow-x-auto rounded-xl border border-[var(--line)]
                                  bg-[var(--surface-2)] p-4 font-mono text-[11.5px]
                                  leading-[1.7] whitespace-pre-wrap">{body.content}</pre>
                : <Markdown source={body.content} />
            )}
          </div>
        )}
      </div>
    </SidebarLayout>
  );
}

export default function PreviewPage() {
  return (
    <Suspense fallback={<Empty>Loading…</Empty>}>
      <PreviewInner />
    </Suspense>
  );
}
