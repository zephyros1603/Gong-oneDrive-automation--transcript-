'use client';

/**
 * components/BuiltinData.jsx — the Data tab for Warp's own applications.
 *
 * Each one answers "what does this application currently hold", with an
 * explicit refresh. The file tree is memoised for a second — right for the
 * pollers, wrong for "I just moved a folder in Finder" — so the button exists
 * rather than the cache being made shorter for everybody.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowsClockwise, FolderOpen, FileText, CheckCircle, XCircle, Clock,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { kb, ago, plural, stripName } from '@/lib/format.js';
import { cn } from '@/lib/utils';

function Header({ title, hint, onRefresh, busy, children }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex items-center gap-2">
        {children}
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}
                className="rounded-lg" title="Re-read the disk">
          <ArrowsClockwise size={13} weight="bold" className={cn(busy && 'animate-spin')} />
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
    </div>
  );
}

export default function BuiltinData({ kind }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const url = {
      projects: '/api/projects',
      library: '/api/tree',
      graph: '/api/graph',
      automation: '/api/schedules',
    }[kind];
    if (!url) return;
    try { setData(await fetch(url).then((r) => r.json())); } catch { setData({}); }
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await fetch(`/api/refresh?scope=${kind === 'projects' ? 'projects' : 'all'}`, { method: 'POST' });
      await load();
    } finally { setBusy(false); }
  };

  if (!data) return <Skeleton className="h-[280px] rounded-2xl" />;

  /* ------------------------------------------------------------ projects */
  if (kind === 'projects') {
    const list = data.projects || [];
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <Header title="Customer workspaces" busy={busy} onRefresh={refresh}
                  hint="Created from the grouped transcript folders. Refresh re-reads them." >
            <Badge variant="secondary" className="rounded-md">{list.length}</Badge>
          </Header>
          <div className="grid gap-2 sm:grid-cols-2">
            {list.map((p) => (
              <Link key={p.id} href="/projects"
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3 no-underline
                               transition-colors hover:border-primary/40">
                <FolderOpen size={15} weight="duotone" className="flex-none text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{p.name}</span>
                  <span className="block font-mono text-[10.5px] text-muted-foreground">
                    {plural(p.transcriptCount, 'transcript')} · {plural(p.messageCount, 'message')}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  /* ------------------------------------------------------------- library */
  if (kind === 'library') {
    const roots = data.roots || [];
    const files = data.files || [];
    return (
      <div className="space-y-3.5">
        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <Header title="Folders" busy={busy} onRefresh={refresh}
                    hint="Everything Warp may read from or write to." />
            <div className="grid gap-2">
              {roots.map((r) => (
                <div key={r.path}
                     className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3">
                  <FolderOpen size={15} weight="duotone" className="flex-none text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium">{r.label}</span>
                    <span className="block break-anywhere font-mono text-[10.5px] text-muted-foreground">
                      {r.path}
                    </span>
                  </span>
                  <Badge variant="secondary" className="rounded-md text-[10.5px]">{r.kind}</Badge>
                  <Badge variant="outline" className="rounded-md font-mono text-[10.5px]">
                    {files.filter((f) => f.root === r.label || f.path.startsWith(`${r.path}/`)).length}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <h2 className="mb-3 text-[13.5px] font-semibold">Most recent files</h2>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {files.slice(0, 16).map((f) => (
                <Link key={f.path} href={`/preview?path=${encodeURIComponent(f.path)}`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 no-underline hover:bg-muted">
                  <FileText size={13} weight="duotone" className="flex-none text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{stripName(f.name)}</span>
                  <span className="flex-none font-mono text-[10px] text-muted-foreground">
                    {kb(f.size)} · {ago(f.mtime)}
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* --------------------------------------------------------------- graph */
  if (kind === 'graph') {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <Header title="Graphs" busy={busy} onRefresh={refresh}
                  hint="A graph is a policy. The tree is computed on read, so it never goes stale." />
          <div className="mb-4 grid grid-cols-4 gap-2">
            {Object.entries(data.totals || {}).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border bg-card p-3 text-center">
                <div className="text-[16px] font-semibold leading-none">{v}</div>
                <div className="mt-1 text-[10.5px] capitalize text-muted-foreground">{k}</div>
              </div>
            ))}
          </div>
          <Link href="/graph" className="text-[12px] text-primary no-underline hover:underline">
            Open the graph and edit its policy →
          </Link>
        </CardContent>
      </Card>
    );
  }

  /* ---------------------------------------------------------- automation */
  if (kind === 'automation') {
    const list = data.schedules || [];
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <Header title="Schedules" busy={busy} onRefresh={refresh}
                  hint="Each one points at a workflow. Logs are on the Automation page." >
            <Badge variant="secondary" className="rounded-md">{list.length}</Badge>
          </Header>
          {list.length === 0 && (
            <p className="py-6 text-center text-[12px] text-muted-foreground">
              Nothing scheduled yet.
            </p>
          )}
          <div className="grid gap-2">
            {list.map((s) => (
              <div key={s.id}
                   className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3">
                {s.enabled
                  ? <CheckCircle size={15} weight="fill" className="flex-none text-ok" />
                  : <Clock size={15} weight="duotone" className="flex-none text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">
                    {s.name || s.workflow?.name || 'Schedule'}
                  </span>
                  <span className="block font-mono text-[10.5px] text-muted-foreground">
                    {s.time} · {s.workflow?.name || 'no workflow'}
                  </span>
                </span>
                {s.nextRunAt && (
                  <span className="flex-none font-mono text-[10px] text-muted-foreground">
                    next {new Date(s.nextRunAt).toLocaleDateString(undefined, { weekday: 'short' })}
                  </span>
                )}
              </div>
            ))}
          </div>
          <Link href="/automation" className="mt-3 inline-block text-[12px] text-primary no-underline hover:underline">
            Open Automation →
          </Link>
        </CardContent>
      </Card>
    );
  }

  return null;
}
