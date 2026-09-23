'use client';

/**
 * Automation — scheduled workflows on the left, their runs on the right.
 *
 * The schedule is a timer inside this server, not launchd and not pmset. That
 * is the point: it cannot wake the Mac, and while the Mac sleeps a slot simply
 * passes rather than queueing up to fire on wake.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Plus, CheckCircle, XCircle, Clock, Play, Trash, FloppyDisk, CaretRight, Code,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useRunStream } from '@/lib/useRunStream.js';
import { useResizablePanel, useBreakpoint } from '@/lib/useResponsive.js';
import { ago, plural, money4 } from '@/lib/format.js';
import { WindowPicker } from '@/components/WindowPicker.jsx';
import { resolveWindow } from '@/core/workflow/window.js';
import { cn } from '@/lib/utils';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function AutomationPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [schedules, setSchedules] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [log, setLog] = useState([]);

  const { isCompact } = useBreakpoint();
  const panel = useResizablePanel({
    initial: 320, min: 240, max: 460, keepForMain: 380,
    storageKey: 'warp.automation.split', enabled: !isCompact,
  });

  const run = useRunStream(activeRun, {
    onEvent: (e) => {
      // 'step'/'detail'/'file'/'summary' are workflow-run events
      // (core/workflow/run.js); 'call'/'log'/'result' are a script's
      // (core/engine/sandbox.js) — a schedule can fire either kind now.
      if (['step', 'detail', 'file', 'error', 'summary', 'call', 'log', 'result'].includes(e.type)) {
        setLog((l) => [...l, e]);
      }
    },
    onFinish: () => { setActiveRun(null); load(); },
  });

  const load = useCallback(async () => {
    try {
      const [s, w, sc, r] = await Promise.all([
        fetch('/api/schedules').then((x) => x.json()),
        fetch('/api/workflows').then((x) => x.json()),
        fetch('/api/scripts').then((x) => x.json()),
        fetch('/api/runs').then((x) => x.json()),
      ]);
      setSchedules(s.schedules || []);
      setWorkflows(w.workflows || []);
      setScripts(sc.scripts || []);
      setRuns((r.runs || []).filter((x) => x.kind === 'automation' || x.kind === 'script'));
      setSelected((cur) => cur || s.schedules?.[0]?.id || null);
      return s.schedules || [];
    } catch { setSchedules([]); return []; }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Arriving from the Engine page's "Schedule this script" button
   * (`/automation?script=<id>`) — reuse an existing schedule for that script
   * if one exists, otherwise create one so there's something to configure
   * immediately rather than a blank "pick a schedule" state.
   */
  useEffect(() => {
    const scriptId = searchParams.get('script');
    if (!scriptId || !schedules) return;

    (async () => {
      const existing = schedules.find((s) => s.scriptId === scriptId);
      if (existing) {
        setSelected(existing.id);
      } else {
        const script = scripts.find((x) => x.id === scriptId);
        const r = await fetch('/api/schedules', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scriptId, name: script?.name || 'Scheduled script',
            enabled: false, time: '09:00', days: [1, 2, 3, 4, 5], graceMinutes: 20,
          }),
        }).then((x) => x.json());
        const fresh = await load();
        setSelected(r.schedule?.id || fresh?.[0]?.id || null);
      }
      router.replace('/automation');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, schedules !== null]);
  useEffect(() => {
    if (activeRun) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [activeRun, load]);

  useEffect(() => {
    const s = (schedules || []).find((x) => x.id === selected);
    setDraft(s ? { ...s } : null);
  }, [selected, schedules]);

  const save = async () => {
    await fetch('/api/schedules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    await load();
  };

  /**
   * The window lives on the workflow, so editing it here writes there.
   * The local copy is updated first — otherwise the buttons do not move until
   * the reload lands and the control feels broken.
   */
  const saveWindow = async (wf, next) => {
    setWorkflows((all) => all.map((x) =>
      x.id === wf.id ? { ...x, scope: { ...x.scope, window: next } } : x));

    await fetch(`/api/workflows/${wf.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { ...wf.scope, window: next } }),
    });
    await load();
  };

  const create = async () => {
    if (!workflows.length) return;
    const r = await fetch('/api/schedules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: workflows[0].id, name: 'New schedule',
        enabled: false, time: '09:00', days: [1, 2, 3, 4, 5], graceMinutes: 20,
      }),
    }).then((x) => x.json());
    await load();
    setSelected(r.schedule?.id || null);
  };

  const remove = async () => {
    await fetch('/api/schedules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: selected }),
    });
    setSelected(null);
    await load();
  };

  const runNow = async () => {
    setLog([]);
    let r;
    if (draft?.scriptId) {
      r = await fetch(`/api/scripts/${draft.scriptId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      }).then((x) => x.json());
    } else if (draft?.workflowId) {
      r = await fetch(`/api/workflows/${draft.workflowId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      }).then((x) => x.json());
    } else {
      return;
    }
    if (r.runId) setActiveRun(r.runId);
    else if (r.error) setLog([{ type: 'error', message: r.error }]);
  };

  /** Switching the target type clears whichever id belonged to the other one. */
  const setTargetKind = (kind) => {
    if (kind === 'script') {
      setDraft({ ...draft, workflowId: '', scriptId: draft.scriptId || scripts[0]?.id || '' });
    } else {
      setDraft({ ...draft, scriptId: null, workflowId: draft.workflowId || workflows[0]?.id || '' });
    }
  };

  if (!schedules) {
    return (
      <div className="flex h-full">
        <div className="w-[320px] flex-none border-r border-border p-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="mb-2 h-[58px] rounded-xl" />
          ))}
        </div>
        <div className="flex-1 p-5"><Skeleton className="h-[320px] rounded-2xl" /></div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      {/* ---- left: schedules ------------------------------------------- */}
      <aside
        style={isCompact ? undefined : { width: panel.width }}
        className={cn('flex flex-col border-r border-border bg-card',
          isCompact ? 'w-[46%] min-w-[200px] flex-none' : 'flex-none')}
      >
        <div className="flex flex-none items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[12.5px] font-semibold">Schedules</span>
          <Button size="sm" variant="outline" onClick={create} className="h-7 rounded-lg px-2">
            <Plus size={12} weight="bold" /> New
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {schedules.length === 0 && (
            <p className="p-3 text-[11.5px] text-muted-foreground">
              Nothing scheduled. Create one, then point it at a workflow or a script.
            </p>
          )}
          {schedules.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)}
              className={cn('mb-1 flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors',
                selected === s.id ? 'border-primary/40 bg-primary/8' : 'border-transparent hover:bg-muted')}>
              {s.enabled
                ? <CheckCircle size={14} weight="fill" className="flex-none text-ok" />
                : <Clock size={14} weight="duotone" className="flex-none text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate text-[12px] font-medium">
                  {s.scriptId && <Code size={11} weight="duotone" className="flex-none text-muted-foreground" />}
                  {s.name || s.workflow?.name || s.script?.name || 'Schedule'}
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {s.time} · {(s.days || []).map((d) => DAYS[d]).join(' ') || 'no days'}
                </span>
              </span>
              <CaretRight size={11} className="flex-none text-muted-foreground" />
            </button>
          ))}
        </div>
      </aside>

      {!isCompact && (
        <div {...panel.handleProps}
             className={cn('w-1 flex-none cursor-col-resize transition-colors hover:bg-primary/40',
               panel.dragging && 'bg-primary/60')} />
      )}

      {/* ---- right: settings + logs ------------------------------------ */}
      <section className="min-w-0 flex-1 overflow-y-auto">
        {!draft ? (
          <div className="grid h-full place-items-center p-8 text-center text-[12.5px] text-muted-foreground">
            Pick a schedule, or create one.
          </div>
        ) : (
          <div className="space-y-3.5 p-5">
            <Card className="rounded-2xl">
              <CardContent className="p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-[13.5px] font-semibold">Schedule</h2>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" onClick={runNow}
                            disabled={Boolean(activeRun)} className="rounded-lg">
                      <Play size={12} weight="fill" /> {activeRun ? 'Running…' : 'Run now'}
                    </Button>
                    <Button size="sm" onClick={save} className="rounded-lg">
                      <FloppyDisk size={12} weight="duotone" /> Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={remove}
                            className="rounded-lg text-bad hover:text-bad">
                      <Trash size={12} weight="duotone" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1.5 block text-[12px] font-medium">Name</Label>
                    <Input value={draft.name || ''} className="rounded-xl"
                           onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[12px] font-medium">Runs</Label>
                    <div className="flex gap-1.5">
                      <div className="flex flex-none rounded-xl border border-input p-0.5">
                        <button type="button" onClick={() => setTargetKind('workflow')}
                                className={cn('rounded-[10px] px-2.5 text-[12px] font-medium transition-colors',
                                  !draft.scriptId ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                          Workflow
                        </button>
                        <button type="button" onClick={() => setTargetKind('script')}
                                className={cn('rounded-[10px] px-2.5 text-[12px] font-medium transition-colors',
                                  draft.scriptId ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                          Script
                        </button>
                      </div>
                      {draft.scriptId ? (
                        <select value={draft.scriptId}
                                onChange={(e) => setDraft({ ...draft, scriptId: e.target.value })}
                                className="h-9 min-w-0 flex-1 rounded-xl border border-input bg-transparent px-3 text-[13px]">
                          {scripts.length === 0 && <option value="">No scripts yet</option>}
                          {scripts.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                        </select>
                      ) : (
                        <select value={draft.workflowId}
                                onChange={(e) => setDraft({ ...draft, workflowId: e.target.value })}
                                className="h-9 min-w-0 flex-1 rounded-xl border border-input bg-transparent px-3 text-[13px]">
                          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[12px] font-medium">Time</Label>
                    <Input type="time" value={draft.time} className="rounded-xl"
                           onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[12px] font-medium">Grace window</Label>
                    <Input type="number" value={draft.graceMinutes} className="rounded-xl"
                           onChange={(e) => setDraft({ ...draft, graceMinutes: Number(e.target.value) })} />
                  </div>
                </div>

                <div className="mt-3">
                  <Label className="mb-1.5 block text-[12px] font-medium">Days</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((d, i) => {
                      const on = (draft.days || []).includes(i);
                      return (
                        <button key={d} onClick={() => setDraft({
                          ...draft,
                          days: on ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort(),
                        })}
                        className={cn('rounded-lg border px-2.5 py-1 text-[11.5px] font-medium',
                          on ? 'border-transparent bg-primary text-primary-foreground'
                             : 'border-border text-muted-foreground')}>
                          {d}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* The window belongs to the workflow, but this is where people
                    ask "what will tonight's run actually cover" — so it is
                    editable here rather than one page away. */}
                {(() => {
                  const wf = workflows.find((x) => x.id === draft.workflowId);
                  if (!wf) return null;
                  const win = resolveWindow(wf.scope?.window);
                  return (
                    <div className="mt-3 rounded-xl border border-border p-3">
                      <WindowPicker
                        label="Data window"
                        value={wf.scope?.window}
                        onChange={(next) => saveWindow(wf, next)}
                      />
                      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                        Each run pulls <span className="font-medium text-foreground">{win.label.toLowerCase()}</span> of
                        material from every source <span className="font-medium text-foreground">{wf.name}</span> uses,
                        and feeds that to Claude. Shared with the workflow — changing it here changes it there.
                      </p>
                    </div>
                  );
                })()}

                <label className="mt-3 flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" checked={Boolean(draft.enabled)}
                         onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                         className="accent-primary" />
                  Run automatically
                  <span className="text-[11px] text-muted-foreground">
                    · needs this server running; your Mac is never woken
                  </span>
                </label>

                {draft.nextRunAt && (
                  <p className="mt-2 font-mono text-[10.5px] text-muted-foreground">
                    next {new Date(draft.nextRunAt).toLocaleString()}
                    {draft.missed ? ' · last slot was missed' : ''}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* ---- live log --------------------------------------------- */}
            {(activeRun || log.length > 0) && (
              <Card className="rounded-2xl">
                <CardContent className="p-5">
                  <h2 className="mb-2 text-[13px] font-semibold">
                    {activeRun ? 'Running' : 'Last run'}
                  </h2>
                  <div className="max-h-[220px] overflow-y-auto rounded-xl border border-border
                                  bg-muted p-3 font-mono text-[11px] leading-[1.75]">
                    {log.map((l, i) => (
                      <div key={i} className={cn(
                        l.type === 'error' ? 'text-bad'
                        : l.type === 'step' ? 'mt-1.5 font-semibold text-foreground'
                        : l.type === 'file' ? 'pl-3 text-muted-foreground'
                        : l.type === 'call' ? 'text-muted-foreground'
                        : l.type === 'result' ? 'text-ok'
                        : 'pl-3 text-muted-foreground')}>
                        {l.type === 'summary'
                          ? JSON.stringify(l.result)
                          : l.type === 'file' ? `· ${l.name}`
                          : l.type === 'call' ? `→ ${l.path}(${(l.args || []).join(', ')})`
                          : l.type === 'result' ? `✓ ${JSON.stringify(l.value)}`
                          : (l.message || '')}
                      </div>
                    ))}
                    {log.length === 0 && <span className="text-muted-foreground">Waiting…</span>}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- history ---------------------------------------------- */}
            <Card className="rounded-2xl">
              <CardContent className="p-5">
                <h2 className="mb-3 text-[13px] font-semibold">Recent automation runs</h2>
                {runs.length === 0 && (
                  <p className="py-4 text-[12px] text-muted-foreground">Nothing has run yet.</p>
                )}
                <div className="divide-y divide-border">
                  {runs.slice(0, 12).map((r) => (
                    <div key={r.id} className="flex items-center gap-2.5 py-2 text-[12px]">
                      {r.status === 'done'
                        ? <CheckCircle size={14} weight="fill" className="flex-none text-ok" />
                        : r.status === 'running'
                          ? <Clock size={14} weight="duotone" className="flex-none text-primary" />
                          : <XCircle size={14} weight="fill" className="flex-none text-bad" />}
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {r.label || 'Run'}
                        {r.summary?.pulled != null &&
                          ` · ${plural(r.summary.pulled, 'call')} · ${plural(r.summary.organized || 0, 'file')}`}
                      </span>
                      {r.summary?.costUsd != null && (
                        <span className="flex-none font-mono text-[10px] text-muted-foreground">
                          {money4(r.summary.costUsd)}
                        </span>
                      )}
                      <span className="flex-none font-mono text-[10px] text-muted-foreground">
                        {ago(r.endedAt || r.startedAt)}
                      </span>
                    </div>
                  ))}
                </div>
                <Link href="/applications/automation?tab=configuration"
                      className="mt-3 inline-block text-[12px] text-primary no-underline hover:underline">
                  Automation settings →
                </Link>
              </CardContent>
            </Card>
          </div>
        )}
      </section>
    </div>
  );
}
