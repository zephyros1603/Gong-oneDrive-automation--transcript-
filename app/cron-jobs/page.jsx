'use client';

/**
 * Cron Jobs — every Claude Code process actually running right now.
 *
 * The top bar's Stop button is bulk-only: stop everything, no visibility
 * into what "everything" is. This page is the missing granularity — one row
 * per real OS process, refreshed on a short poll, each with its own Stop.
 *
 * Two sources, merged by pid: `/api/running` is this server's own tracked
 * jobs (rich — label, what it's doing, since when) and `/api/claude-processes`
 * is a raw `ps` scan of every `claude` process on the machine (pid, kind,
 * elapsed, command) — the only way to see a terminal or IDE session this
 * server never started. A job present in both is one row, not two.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Lightning, Terminal, Code, StopCircle, ArrowsClockwise,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ago } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const KIND = {
  app: { label: 'This app', icon: Lightning, hint: 'A document job this server started — Stop cancels it properly.' },
  terminal: { label: 'Terminal', icon: Terminal, hint: 'A session you started in a terminal, outside this app.' },
  ide: { label: 'IDE', icon: Code, hint: "The Claude Code session running in your editor — likely this very session." },
};

const elapsedLabel = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export default function CronJobsPage() {
  const [rows, setRows] = useState(null);
  const [stopping, setStopping] = useState(null);

  const load = useCallback(async () => {
    try {
      const [running, processes] = await Promise.all([
        fetch('/api/running').then((r) => r.json()),
        fetch('/api/claude-processes').then((r) => r.json()),
      ]);
      const jobs = running.jobs || [];
      const byPid = new Map(jobs.map((j) => [j.pid, j]));

      const merged = (processes || []).map((p) => {
        const job = byPid.get(p.pid);
        byPid.delete(p.pid);
        return {
          pid: p.pid, kind: p.kind, command: p.command,
          elapsedMs: job ? job.elapsedMs : null, elapsedText: job ? null : p.elapsed,
          label: job?.label || p.note, jobId: job?.id || null,
        };
      });
      // A tracked job whose process the scanner missed this tick (a narrow
      // race right at spawn) still gets a row, so it never just vanishes.
      for (const j of byPid.values()) {
        merged.push({ pid: j.pid, kind: 'app', command: j.action, elapsedMs: j.elapsedMs, label: j.label, jobId: j.id });
      }

      setRows(merged.sort((a, b) => a.pid - b.pid));
    } catch { /* next tick retries */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const stopOne = async (row) => {
    setStopping(row.pid);
    try {
      if (row.jobId) {
        await fetch('/api/cancel', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: row.jobId }),
        });
      } else {
        await fetch('/api/kill-claude', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pids: [row.pid] }),
        });
      }
      await load();
    } finally {
      setStopping(null);
    }
  };

  if (!rows) {
    return (
      <div className="mx-auto max-w-[900px] space-y-3 p-5 sm:p-7">
        <Skeleton className="h-8 w-[220px] rounded-lg" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[64px] rounded-2xl" />)}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px] space-y-3.5 p-5 sm:p-7">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">Cron Jobs</h1>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Every real Claude Code process on this machine, refreshed every 2s. Not scheduled
            automations — see Automation for those — this is what's actually spawned right now.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} className="flex-none rounded-lg">
          <ArrowsClockwise size={13} weight="bold" /> Refresh
        </Button>
      </div>

      {rows.length === 0 && (
        <Card className="rounded-2xl">
          <CardContent className="grid place-items-center p-10 text-center text-[12.5px] text-muted-foreground">
            Nothing running.
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const meta = KIND[row.kind] || KIND.terminal;
          const Icon = meta.icon;
          return (
            <Card key={row.pid} className="rounded-2xl">
              <CardContent className="flex items-center gap-3 p-3.5">
                <Icon size={16} weight="duotone" className="flex-none text-primary" title={meta.hint} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium">{row.label || 'claude'}</span>
                    <Badge variant="secondary" className="flex-none rounded-md text-[10px]">{meta.label}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground" title={row.command}>
                    pid {row.pid} · {row.elapsedMs != null ? elapsedLabel(row.elapsedMs) : row.elapsedText}
                    {row.command ? ` · ${row.command}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="outline" disabled={stopping === row.pid}
                        onClick={() => stopOne(row)}
                        className={cn('flex-none rounded-lg text-bad hover:text-bad')}
                        title={row.kind === 'app' ? 'Cancel this run properly' : 'Send SIGTERM, then SIGKILL if it ignores that'}>
                  <StopCircle size={13} weight="fill" /> {stopping === row.pid ? 'Stopping…' : 'Stop'}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
