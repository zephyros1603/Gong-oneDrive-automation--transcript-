'use client';

/**
 * Approvals — what a run produced, before it goes anywhere.
 *
 * The point is cheap review, not thorough review: the document is here, the
 * email is here, and a decision is one click. If approving takes as long as
 * writing, the queue becomes the bottleneck and people route around it.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle, XCircle, FileDoc, EnvelopeSimple, Check, X,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Markdown, CopyButton } from '@/components/common.jsx';
import { useResizablePanel, useBreakpoint } from '@/lib/useResponsive.js';
import { ago } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const TABS = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];

export default function ApprovalsPage() {
  const [status, setStatus] = useState('pending');
  const [d, setD] = useState(null);
  const [sel, setSel] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState(null);

  const { isCompact } = useBreakpoint();
  const panel = useResizablePanel({
    initial: 340, min: 260, max: 480, keepForMain: 360,
    storageKey: 'warp.approvals.split', enabled: !isCompact,
  });

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/approvals?status=${status}`).then((x) => x.json());
      setD(r);
      setSel((cur) => r.approvals.find((a) => a.id === cur?.id) || r.approvals[0] || null);
      setPicked(new Set());
    } catch { setD({ approvals: [], counts: {} }); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  // Documents are files; read them lazily so the list stays fast.
  useEffect(() => {
    setBody(null);
    if (sel?.kind !== 'document' || !sel.path) return;
    fetch(`/api/file?path=${encodeURIComponent(sel.path)}`)
      .then((r) => r.json())
      .then((f) => {
        // A missing or unreadable file answers 200-shaped JSON with an error
        // field, not a rejection. Falling through to `f.content || ''` there
        // rendered a blank card, which reads as "this document is empty"
        // rather than "this document is gone".
        if (f.error) return setBody(`_${f.error}._`);
        if (f.binary) return setBody('_This is a Word document — use Download to read it in full._');
        return setBody(f.content || '_This file is empty._');
      })
      .catch((e) => setBody(`_Could not read this file: ${e.message}_`));
  }, [sel]);

  const act = async (ids, next) => {
    setBusy(true);
    try {
      await fetch('/api/approvals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Array.isArray(ids) ? { ids, status: next } : { id: ids, status: next }),
      });
      await load();
    } finally { setBusy(false); }
  };

  if (!d) {
    return (
      <div className="flex h-full">
        <div className="w-[340px] flex-none border-r border-border p-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="mb-2 h-[62px] rounded-xl" />
          ))}
        </div>
        <div className="flex-1 p-5"><Skeleton className="h-[320px] rounded-2xl" /></div>
      </div>
    );
  }

  const list = d.approvals || [];

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <aside
        style={isCompact ? undefined : { width: panel.width }}
        className={cn('flex flex-col border-r border-border bg-card',
          isCompact ? 'w-[46%] min-w-[210px] flex-none' : 'flex-none')}
      >
        <div className="flex flex-none gap-0.5 border-b border-border p-2">
          {TABS.map(([v, l]) => (
            <button key={v} onClick={() => setStatus(v)}
              className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium',
                status === v ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
              {l}
              {d.counts?.[v] > 0 && (
                <span className="rounded bg-muted px-1 font-mono text-[10px]">{d.counts[v]}</span>
              )}
            </button>
          ))}
        </div>

        {status === 'pending' && picked.size > 0 && (
          <div className="flex flex-none items-center gap-1.5 border-b border-border bg-muted/50 px-2 py-1.5">
            <span className="text-[11px] text-muted-foreground">{picked.size} selected</span>
            <Button size="sm" disabled={busy} onClick={() => act([...picked], 'approved')}
                    className="ml-auto h-6 rounded-md px-2 text-[11px]">
              <Check size={11} weight="bold" /> Approve
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act([...picked], 'rejected')}
                    className="h-6 rounded-md px-2 text-[11px] text-bad hover:text-bad">
              <X size={11} weight="bold" />
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <p className="p-4 text-[11.5px] leading-relaxed text-muted-foreground">
              {status === 'pending'
                ? 'Nothing waiting. Documents and covering emails land here when a run finishes.'
                : `No ${status} items.`}
            </p>
          )}

          {list.map((a) => (
            <div key={a.id}
                 className={cn('mb-1 flex items-start gap-2 rounded-xl border px-2 py-2 transition-colors',
                   sel?.id === a.id ? 'border-primary/40 bg-primary/8' : 'border-transparent hover:bg-muted')}>
              {status === 'pending' && (
                <input type="checkbox" checked={picked.has(a.id)}
                       onChange={() => setPicked((c) => {
                         const n = new Set(c);
                         n.has(a.id) ? n.delete(a.id) : n.add(a.id);
                         return n;
                       })}
                       className="mt-1 flex-none accent-primary" />
              )}
              <button onClick={() => setSel(a)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                {a.kind === 'email'
                  ? <EnvelopeSimple size={14} weight="duotone" className="mt-0.5 flex-none text-primary" />
                  : <FileDoc size={14} weight="duotone" className="mt-0.5 flex-none text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{a.title}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {a.project || 'no customer'} · {ago(a.createdAt)}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      </aside>

      {!isCompact && (
        <div {...panel.handleProps}
             className={cn('w-1 flex-none cursor-col-resize transition-colors hover:bg-primary/40',
               panel.dragging && 'bg-primary/60')} />
      )}

      <section className="min-w-0 flex-1 overflow-y-auto">
        {!sel ? (
          <div className="grid h-full place-items-center p-8 text-center text-[12.5px] text-muted-foreground">
            Nothing selected.
          </div>
        ) : (
          <div className="space-y-3.5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold tracking-tight">{sel.title}</h1>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {sel.kind === 'email' ? 'Covering email' : 'Document'}
                  {sel.project ? ` · ${sel.project}` : ''} · {ago(sel.createdAt)}
                </p>
              </div>

              {sel.status === 'pending' ? (
                <div className="flex flex-none gap-1.5">
                  <Button size="sm" disabled={busy} onClick={() => act(sel.id, 'approved')}
                          className="rounded-lg">
                    <CheckCircle size={13} weight="fill" /> Approve
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy}
                          onClick={() => act(sel.id, 'rejected')}
                          className="rounded-lg text-bad hover:text-bad">
                    <XCircle size={13} weight="fill" /> Reject
                  </Button>
                </div>
              ) : (
                <Badge className={cn('rounded-lg border-transparent',
                  sel.status === 'approved' ? 'bg-ok/12 text-ok' : 'bg-bad/12 text-bad')}>
                  {sel.status}
                </Badge>
              )}
            </div>

            <Card className="rounded-2xl">
              <CardContent className="p-5">
                {sel.kind === 'email' ? (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                        Ready to paste
                      </span>
                      <CopyButton text={sel.body || ''} label="Copy email" />
                    </div>
                    <Markdown source={sel.body || ''} />
                  </>
                ) : (
                  <>
                    {sel.path && (
                      <p className="mb-3 break-anywhere font-mono text-[10.5px] text-muted-foreground">
                        {sel.path}
                      </p>
                    )}
                    {body === null
                      ? <Skeleton className="h-[220px] rounded-xl" />
                      : <Markdown source={body} />}
                    {sel.path && (
                      <a href={`/api/file?path=${encodeURIComponent(sel.path)}&raw=1`} download
                         className="mt-3 inline-block text-[12px] text-primary no-underline hover:underline">
                        Download the original →
                      </a>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </section>
    </div>
  );
}
