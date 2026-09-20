'use client';

/**
 * Workbench — the syncs you can configure.
 *
 * Not a chat. Chat lives in Projects, where it has a customer and a history to
 * belong to. Workbench is where a sync is *defined*: where it pulls from, what
 * it is scoped to, what prompt and skill it runs, and what it produces. The
 * same definition is then what Automation schedules, so what you configure
 * here is exactly what runs at 09:00.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight, Plus, CheckCircle, Clock, CaretRight, Lightning, Sparkle,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Mark } from '@/components/Mark.jsx';
import { plural } from '@/lib/format.js';
import { cn } from '@/lib/utils';

export default function WorkbenchPage() {
  const [d, setD] = useState(null);
  const [creating, setCreating] = useState(null);

  const load = useCallback(async () => {
    try { setD(await fetch('/api/syncs').then((r) => r.json())); } catch { setD({ syncs: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async (type, projectId) => {
    setCreating(null);
    const project = (d.projects || []).find((p) => p.id === projectId);
    const r = await fetch('/api/syncs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        typeId: type.id,
        name: type.destination === 'projects'
          ? 'Customer list from the tracker'
          : (project ? `${project.name} — documents` : 'All customers — documents'),
        scope: {
          projectId: projectId || null,
          // A combined sync starts with both sides on — that is the reason to
          // pick it. Either can be switched off per automation afterwards.
          sources: type.source === 'gong+cxportal'
            ? ['transcript', 'cxportal']
            : (type.source === 'cxportal' ? ['cxportal'] : ['transcript']),
          window: { preset: 'week', anchor: 'this' },
        },
      }),
    }).then((x) => x.json());
    if (r.workflow) window.location.href = `/workbench/${r.workflow.id}`;
  };

  if (!d) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-4 p-5 sm:p-7">
        <Skeleton className="h-8 w-[200px] rounded-lg" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[190px] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] p-5 sm:p-7">
        <div className="mb-5">
          <h1 className="text-[17px] font-semibold tracking-tight">Workbench</h1>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Define a sync once here. Automation runs the same definition on a schedule.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {d.syncs.map((s) => (
            <Card key={s.id}
                  className={cn('app-tile-in rounded-2xl transition-all',
                    s.available ? 'hover:border-primary/40 hover:shadow-md' : 'opacity-60')}>
              <CardContent className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  {String(s.source).split('+').map((id) => <Mark key={id} id={id} size={32} />)}
                  <ArrowRight size={13} weight="bold" className="text-muted-foreground" />
                  <Mark id={s.destination} size={32} />
                  {!s.available && (
                    <Badge variant="secondary" className="ml-auto rounded-md text-[10px]">Planned</Badge>
                  )}
                </div>

                <h2 className="text-[13.5px] font-semibold">{s.name}</h2>
                <p className="mt-0.5 mb-3 line-clamp-2 text-[11.5px] text-muted-foreground">
                  {s.summary}
                </p>

                {s.available && (
                  <>
                    <div className="mb-3 flex gap-1.5">
                      <Badge variant="secondary" className="rounded-md text-[10.5px]">
                        {plural(s.counts.configured, 'automation')}
                      </Badge>
                      {s.counts.scheduled > 0 && (
                        <Badge className="rounded-md border-transparent bg-ok/12 text-[10.5px] text-ok">
                          {s.counts.scheduled} scheduled
                        </Badge>
                      )}
                    </div>

                    <div className="space-y-1">
                      {s.workflows.slice(0, 4).map((w) => (
                        <Link key={w.id} href={`/workbench/${w.id}`}
                              className="flex items-center gap-2 rounded-lg px-2 py-1.5 no-underline
                                         transition-colors hover:bg-muted">
                          {w.skill
                            ? <Sparkle size={12} weight="duotone" className="flex-none text-primary" />
                            : <Lightning size={12} weight="duotone" className="flex-none text-muted-foreground" />}
                          <span className="min-w-0 flex-1 truncate text-[11.5px]">{w.name}</span>
                          <CaretRight size={11} className="flex-none text-muted-foreground" />
                        </Link>
                      ))}
                    </div>

                    {s.destination === 'projects' ? (
                      // An import has no customer to pick — it is where the
                      // customers come from.
                      <Button variant="outline" size="sm" onClick={() => create(s, null)}
                              className="mt-2 w-full rounded-lg">
                        <Plus size={12} weight="bold" /> New import
                      </Button>
                    ) : creating === s.id ? (
                      <div className="mt-2 rounded-xl border border-border p-2">
                        <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">
                          Which customer?
                        </p>
                        <div className="max-h-[160px] overflow-y-auto">
                          <button onClick={() => create(s, null)}
                                  className="block w-full rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-muted">
                            All customers
                          </button>
                          {(d.projects || []).map((p) => (
                            <button key={p.id} onClick={() => create(s, p.id)}
                                    className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-muted">
                              {p.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setCreating(s.id)}
                              className="mt-2 w-full rounded-lg">
                        <Plus size={12} weight="bold" /> New automation
                      </Button>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
