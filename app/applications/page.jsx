'use client';

/**
 * Applications — every source and engine Warp talks to.
 *
 * The tile is deliberately small: a logo, the name under it, and one dot for
 * whether it works. An application is recognised by its mark long before its
 * metadata is read, so anything else on the card is noise you scan past. The
 * detail lives one click away, where there is room for it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { MagnifyingGlass, Plus, X, Check } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Mark } from '@/components/Mark.jsx';

/** Green when it works, red when it does not. Nothing else needs saying. */
function Dot({ ok }) {
  return (
    <span
      title={ok ? 'Connected' : 'Not connected'}
      className={cn('h-[7px] w-[7px] flex-none rounded-full', ok ? 'bg-ok' : 'bg-bad')}
    />
  );
}

function Tile({ c, i }) {
  const inner = (
    <>
      <Mark id={c.id} />
      <span className="mt-2.5 flex items-center gap-1.5">
        <Dot ok={c.connected} />
        <span className="truncate text-[12px] font-medium text-foreground">{c.name}</span>
      </span>
    </>
  );

  const shell = cn(
    'group flex flex-col items-center rounded-xl border border-border bg-card px-3 py-4',
    'transition-all duration-150 no-underline',
    'app-tile-in',
    c.planned
      ? 'opacity-55'
      : 'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md'
  );

  return c.planned ? (
    <div className={shell} style={{ animationDelay: `${i * 25}ms` }}>{inner}</div>
  ) : (
    <Link href={`/applications/${c.id}`} className={shell} style={{ animationDelay: `${i * 25}ms` }}>
      {inner}
    </Link>
  );
}

function Catalogue({ available, onClose }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div onClick={onClose} aria-hidden className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
      <div className="animate-in fade-in zoom-in-95 relative w-full max-w-[560px] rounded-2xl
                      border border-border bg-popover p-5 shadow-2xl duration-200">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Add application</h2>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Pick a source to connect. Configuration comes next.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-lg" aria-label="Close">
            <X size={15} />
          </Button>
        </div>

        <div className="grid gap-1.5">
          {available.map((c) => (
            <button
              key={c.id}
              disabled={c.planned}
              className={cn('flex items-center gap-3 rounded-xl border border-transparent px-2.5 py-2.5 text-left transition-colors',
                c.planned ? 'cursor-not-allowed opacity-55' : 'hover:border-border hover:bg-muted')}
              title={c.planned ? 'Not available yet' : undefined}
            >
              <Mark id={c.id} size={34} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{c.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {c.vendor} · {c.kind}
                </span>
              </span>
              {c.configured
                ? <span className="flex items-center gap-1 text-[11px] text-ok"><Check size={12} weight="bold" /> Added</span>
                : c.planned
                  ? <span className="text-[11px] text-muted-foreground">Coming soon</span>
                  : <Plus size={14} className="text-muted-foreground" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ApplicationsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch('/api/connectors').then((r) => r.json())
      .then((d) => setList(d.connectors || []))
      .catch(() => setList([]));
  }, []);

  // The `+` menu deep-links straight into the catalogue.
  useEffect(() => { if (params.get('add')) setAdding(true); }, [params]);

  const close = useCallback(() => {
    setAdding(false);
    router.replace('/applications');
  }, [router]);

  const shown = useMemo(() => {
    if (!list) return [];
    const needle = q.trim().toLowerCase();
    return needle
      ? list.filter((c) => `${c.name} ${c.vendor} ${c.kind}`.toLowerCase().includes(needle))
      : list;
  }, [list, q]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] p-5 sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight">Applications</h1>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Manage configurations, credentials &amp; schemas
            </p>
          </div>
          <Button size="sm" onClick={() => setAdding(true)} className="rounded-lg shadow-sm">
            <Plus size={14} weight="bold" /> Add application
          </Button>
        </div>

        <div className="relative mb-5 max-w-[340px]">
          <MagnifyingGlass size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Search applications"
                 className="h-8 rounded-lg pl-8 text-[12px]" />
        </div>

        {!list && (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5 lg:grid-cols-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-xl" />
            ))}
          </div>
        )}

        {list && shown.length === 0 && (
          <p className="py-14 text-center text-[12px] text-muted-foreground">
            Nothing matches “{q}”.
          </p>
        )}

        {list && shown.length > 0 && (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5 lg:grid-cols-8">
            {shown.map((c, i) => <Tile key={c.id} c={c} i={i} />)}
          </div>
        )}
      </div>

      {adding && list && <Catalogue available={list} onClose={close} />}
    </div>
  );
}

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-[200px] rounded-2xl" /></div>}>
      <ApplicationsInner />
    </Suspense>
  );
}
