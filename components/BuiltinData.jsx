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
  Coins, SealCheck, WarningCircle,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { kb, ago, plural, stripName } from '@/lib/format.js';
import { normalise } from '@/core/correlate.js';
import { cn } from '@/lib/utils';

/**
 * Grouped by customer (normalise()-keyed, same fold `app/projects/page.jsx`
 * uses) rather than flat — a customer routinely has several CX Portal
 * projects, and different customers routinely share a project *name* since
 * it names the integration ("Paycor/Entra ID"), not the account. A flat grid
 * of those reads as unlabelled duplicates.
 */
function groupByCustomer(list) {
  const byKey = new Map();
  for (const p of list) {
    const raw = p.customer || p.name;
    const key = normalise(raw) || raw;
    if (!byKey.has(key)) byKey.set(key, { label: raw, cxpLabel: null, projects: [] });
    const g = byKey.get(key);
    if (p.cxpProjectId && !g.cxpLabel) g.cxpLabel = raw;
    g.projects.push(p);
  }
  return [...byKey.values()]
    .map((g) => ({ customer: g.cxpLabel || g.label, projects: g.projects.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.customer.localeCompare(b.customer));
}

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
      context: '/api/context',
    }[kind];
    if (!url) return;
    try { setData(await fetch(url).then((r) => r.json())); } catch { setData({}); }
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      if (kind === 'context') {
        await fetch('/api/context', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
      } else {
        await fetch(`/api/refresh?scope=${kind === 'projects' ? 'projects' : 'all'}`, { method: 'POST' });
      }
      await load();
    } finally { setBusy(false); }
  };

  const refreshOne = async (projectId) => {
    setBusy(true);
    try {
      await fetch('/api/context', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, force: true }),
      });
      await load();
    } finally { setBusy(false); }
  };

  if (!data) return <Skeleton className="h-[280px] rounded-2xl" />;

  /* ------------------------------------------------------------ projects */
  if (kind === 'projects') {
    const list = data.projects || [];
    const groups = groupByCustomer(list);
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <Header title="Customer workspaces" busy={busy} onRefresh={refresh}
                  hint="One Warp project per CX Portal project assigned to you, grouped by customer.">
            <Badge variant="secondary" className="rounded-md">{list.length}</Badge>
          </Header>
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.customer}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.customer}
                  </span>
                  {g.projects.length > 1 && (
                    <span className="font-mono text-[10px] text-muted-foreground">{g.projects.length}</span>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {g.projects.map((p) => (
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
              </div>
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

  /* --------------------------------------------------------------- context */
  if (kind === 'context') {
    const list = data.customers || [];
    const built = list.filter((c) => c.exists).length;
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <Header title="Per-project context" busy={busy} onRefresh={refresh}
                  hint="One curated file per CX Portal project — Gong calls and tracker state, kept current by the update run.">
            <Badge variant="secondary" className="rounded-md">{built} of {list.length} built</Badge>
          </Header>
          {list.length === 0 && (
            <p className="py-6 text-center text-[12px] text-muted-foreground">No projects yet.</p>
          )}
          <div className="grid gap-2">
            {list.map((c) => (
              <div key={c.id}
                   className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3">
                {!c.linked
                  ? <WarningCircle size={15} weight="duotone" className="flex-none text-muted-foreground" />
                  : c.exists
                  ? <SealCheck size={15} weight="fill" className="flex-none text-ok" />
                  : <Clock size={15} weight="duotone" className="flex-none text-warn" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{c.name}</span>
                  <span className="block font-mono text-[10.5px] text-muted-foreground">
                    {c.exists
                      ? `~${c.tokensEstimate.toLocaleString()} tokens${c.updatedAt ? ` · updated ${new Date(c.updatedAt).toLocaleDateString()}` : ''}`
                      : c.linked ? 'not built yet' : 'no CX Portal link'}
                  </span>
                </span>
                {c.linked && (
                  <Button variant="outline" size="sm" onClick={() => refreshOne(c.id)} disabled={busy}
                          className="flex-none rounded-lg text-[11px]">
                    {c.exists ? 'Rebuild' : 'Build'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}
