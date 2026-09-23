'use client';

/**
 * One sync: everything it needs to run, in one place.
 *
 * Pull settings → scope → prompt and skill → output → schedule. This is the
 * definition Automation executes, so what is tested here with **Run now** is
 * literally what fires at 09:00; there is one `runWorkflow()` behind both.
 *
 * The run is server-owned. Leaving this page aborts the stream but not the
 * work, and coming back re-attaches to the still-running job and replays
 * everything missed — which is why `useEffect` below looks for an active run
 * on mount rather than assuming there is none.
 */

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, ArrowRight, Play, FloppyDisk, Trash, Copy, CheckCircle,
  Clock, CalendarBlank, Sparkle, Check,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Markdown, EmailBox, DocCard, useEmailSplit } from '@/components/common.jsx';
import { RunStatus } from '@/components/Composer.jsx';
import { Mark } from '@/components/Mark.jsx';
import { WindowPicker } from '@/components/WindowPicker.jsx';
import { resolveWindow, pullDays } from '@/core/workflow/window.js';
import { useRunStream } from '@/lib/useRunStream.js';
import { runMeta, plural } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * What a run is allowed to see. Transcripts are files already; everything else
 * is rendered to one per customer first — see core/workflow/context.js.
 */
const SOURCES = [
  { id: 'transcript', label: 'Gong transcripts', hint: 'Call recordings for the scoped customers' },
  { id: 'cxportal', label: 'CX Portal projects', hint: 'Status, go-live dates, owners and hours from the tracker' },
  {
    id: 'digest', label: 'Project context (cheaper)',
    hint: 'Each project\'s one curated context.md — Gong calls and CX Portal state already merged by the update run. Selecting this skips raw transcripts and tracker rows for that customer; it does not rebuild the file, only reads whatever it currently says.',
  },
  { id: 'document', label: 'Previous documents', hint: 'What this workflow produced before, so reports build on each other' },
];

const inputCls = 'rounded-xl';

function Section({ title, hint, children }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 mb-3 text-[11.5px] text-muted-foreground">{hint}</p>}
        <div className={hint ? '' : 'mt-3'}>{children}</div>
      </CardContent>
    </Card>
  );
}

function SyncDetail({ id }) {
  const [d, setD] = useState(null);
  const [w, setW] = useState(null);
  const [skills, setSkills] = useState([]);
  const [schedule, setSchedule] = useState(null);
  const [runId, setRunId] = useState(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [lastRun, setLastRun] = useState(null);

  const run = useRunStream(runId, {
    onFinish: (state) => {
      // Capture before clearing: the hook resets when runId goes null, and the
      // result would otherwise vanish the instant the run succeeded.
      setLastRun({
        text: state.text, cost: state.cost, turns: state.turns,
        durationMs: state.durationMs, documents: state.documents,
        errors: state.errors, status: state.status,
      });
      setRunId(null);
      load();
    },
  });

  const shown = runId ? run : (lastRun || run);
  const { email, rest } = useEmailSplit(shown.text || '');

  const load = useCallback(async () => {
    try {
      const [wf, sk, sc, rs] = await Promise.all([
        fetch(`/api/workflows/${id}`).then((r) => r.json()),
        fetch('/api/skills').then((r) => r.json()).catch(() => ({})),
        fetch('/api/schedules').then((r) => r.json()).catch(() => ({})),
        fetch('/api/runs').then((r) => r.json()).catch(() => ({})),
      ]);
      if (wf.error) { setErr(wf.error); return; }
      setD(wf);
      setW(wf.workflow);
      setSkills(sk.skills || []);
      setSchedule((sc.schedules || []).find((s) => s.workflowId === id) || null);

      // Re-attach to work already in flight. Without this, navigating away
      // mid-run and coming back showed an idle page while the run carried on
      // invisibly — output and cost arriving nowhere.
      const live = (rs.runs || []).find(
        (r) => r.status === 'running' && r.meta?.workflowId === id
      );
      if (live) setRunId(live.id);
    } catch (e) { setErr(e.message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    await fetch(`/api/workflows/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(w),
    });
    if (schedule) {
      await fetch('/api/schedules', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...schedule, workflowId: id }),
      });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    load();
  };

  const runNow = async () => {
    setErr(null);
    const r = await fetch(`/api/workflows/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'run' }),
    }).then((x) => x.json());
    if (r.runId) setRunId(r.runId);
    else setErr(r.error || 'could not start');
  };

  const addSchedule = async () => {
    const r = await fetch('/api/schedules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: id, name: w.name, enabled: false,
        time: '09:00', days: [1, 2, 3, 4, 5], graceMinutes: 20,
      }),
    }).then((x) => x.json());
    setSchedule(r.schedule || null);
  };

  if (err && !d) return <div className="grid h-full place-items-center text-[12.5px] text-bad">{err}</div>;
  if (!d || !w) {
    return (
      <div className="mx-auto max-w-[900px] space-y-3.5 p-5 sm:p-7">
        <Skeleton className="h-11 w-[300px] rounded-xl" />
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[150px] rounded-2xl" />)}
      </div>
    );
  }

  // An import sync writes into Warp's own customer list rather than running
  // the model, so the Gong, scope and prompt steps have nothing to configure.
  const isImport = w.source === 'cxportal' && w.destination === 'projects';

  // Which sources this automation is actually set to use. The per-source
  // steers below are shown for exactly these, because an instruction for a
  // source that is switched off is a prompt nobody will ever read.
  const on = w.scope?.sources || [];
  const useGong = on.includes('transcript');
  const useCx = on.includes('cxportal');
  const both = useGong && useCx;

  const set = (patch) => setW((cur) => ({ ...cur, ...patch }));
  const setSteer = (key, value) =>
    setW((cur) => ({ ...cur, sourceInstructions: { ...(cur.sourceInstructions || {}), [key]: value } }));
  const setScope = (patch) => setW((cur) => ({ ...cur, scope: { ...cur.scope, ...patch } }));
  const setPull = (patch) => setW((cur) => ({ ...cur, pull: { ...cur.pull, ...patch } }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[900px] space-y-3.5 p-5 sm:p-7">

        {/* ---- header ---------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/workbench" className="no-underline">
            <Button variant="outline" size="icon" className="rounded-xl" aria-label="Back">
              <ArrowLeft size={15} />
            </Button>
          </Link>
          <div className="flex items-center gap-1.5">
            <Mark id={w.source} size={26} />
            <ArrowRight size={11} weight="bold" className="text-muted-foreground" />
            <Mark id={w.destination} size={26} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[16px] font-semibold tracking-tight">{w.name}</h1>
            <button
              onClick={() => { navigator.clipboard?.writeText(w.id); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              title="Copy this automation's id"
              className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground">
              {copied ? <CheckCircle size={10} weight="fill" className="text-ok" /> : <Copy size={10} />}
              {w.id}
            </button>
          </div>
          <div className="flex flex-none items-center gap-2">
            {saved && <span className="text-[12px] text-ok">Saved.</span>}
            <Button variant="outline" size="sm" onClick={runNow} disabled={Boolean(runId)}
                    className="rounded-lg">
              <Play size={12} weight="fill" /> {runId ? 'Running…' : 'Run now'}
            </Button>
            <Button size="sm" onClick={save} className="rounded-lg">
              <FloppyDisk size={12} weight="duotone" /> Save
            </Button>
          </div>
        </div>

        {err && (
          <p className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[12px] text-bad">{err}</p>
        )}

        {/* ---- live run --------------------------------------------------- */}
        {(runId || shown.text || lastRun) && (
          <Card className="rounded-2xl">
            <CardContent className="p-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold">{runId ? 'Running' : 'Last run'}</h2>
                {runId && (
                  <Button variant="ghost" size="sm" onClick={run.cancel}
                          className="rounded-lg text-bad hover:text-bad">Stop</Button>
                )}
              </div>
              {run.status === 'running' && (
                <RunStatus phase={run.phase} tool={run.tool} trace={run.trace} />
              )}
              {rest?.trim() && <div className="mt-3"><Markdown source={rest} /></div>}
              {email && <EmailBox email={email} />}
              {(shown.documents || []).map((doc) => <DocCard key={doc.path} file={doc} />)}
              {(shown.cost != null || shown.turns) && (
                <div className="mt-2 font-mono text-[10px] text-muted-foreground">{runMeta(shown)}</div>
              )}
              {(shown.errors || []).map((e, i) => (
                <p key={i} className="mt-2 text-[12px] text-bad">{e}</p>
              ))}
            </CardContent>
          </Card>
        )}

        {isImport && (
          <Section title="1 · What this imports"
                   hint="Nothing to configure — the tracker is the authority on who the customers are.">
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Every customer in the CX Portal project tracker becomes a Warp customer, named
              the way the tracker names them. Existing customers whose name already matches
              are left alone, and nothing is ever deleted — a customer dropping out of the
              tracker window must not take a conversation and its documents with it.
            </p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
              This runs against the portal only. It calls no model and costs nothing.
            </p>

            <WindowPicker
              className="mt-4 border-t border-border pt-4"
              label="Date window"
              value={w.scope?.window}
              onChange={(win) => setScope({ window: win })}
              hint="Narrows which projects are written out, by when the tracker last recorded a change. Ownership is worked out first and does not change with the dates."
            />
          </Section>
        )}

        {/* ---- 1. pull ---------------------------------------------------- */}
        {!isImport && useGong && (
        <Section title="1 · Pull from Gong"
                 hint="What this sync fetches before it generates anything.">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label className="mb-1.5 block text-[12px] font-medium">Days of calls</Label>
              {/* Derived, not typed. Two numbers that could disagree is how a
                  sync ends up pulling a fortnight and reporting on a week. */}
              <div className="flex h-9 items-center rounded-xl border border-dashed border-input px-3
                              text-[13px] text-muted-foreground">
                {pullDays(resolveWindow(w.scope?.window)) || 'all'}
                <span className="ml-1.5 text-[11px]">from the date window</span>
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block text-[12px] font-medium">Group by</Label>
              <select value={w.pull?.organizeBy || 'customer'}
                      onChange={(e) => setPull({ organizeBy: e.target.value })}
                      className="h-9 w-full rounded-xl border border-input bg-transparent px-3 text-[13px]">
                <option value="customer">Customer</option>
                <option value="call">Call title</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={w.pull?.enabled !== false} className="accent-primary"
                       onChange={(e) => setPull({ enabled: e.target.checked })} />
                Pull before running
              </label>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Credentials and folders live in{' '}
            <Link href="/applications/gong" className="text-primary no-underline hover:underline">
              the Gong application
            </Link>.
          </p>
        </Section>
        )}

        {/* ---- 2. scope --------------------------------------------------- */}
        {!isImport && (
        <Section title="2 · Scope"
                 hint="Which material this sync may see. A person has calls with many clients; this is what keeps them apart.">
          <div className="max-w-[420px]">
            <div>
              <Label className="mb-1.5 block text-[12px] font-medium">Customer</Label>
              <select value={w.scope?.projectId || ''}
                      onChange={(e) => setScope({ projectId: e.target.value || null })}
                      className="h-9 w-full rounded-xl border border-input bg-transparent px-3 text-[13px]">
                <option value="">All customers</option>
                {(d.projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          <WindowPicker
            className="mt-4"
            label="Date window"
            value={w.scope?.window}
            onChange={(win) => setScope({ window: win })}
            hint="Applies to the Gong pull and to which transcripts are in scope."
          />

          {useCx && (
            <div className="mt-3 rounded-xl border border-border p-3">
              <Label className="mb-1.5 block text-[12px] font-medium">
                How the window applies to the CX Portal
              </Label>
              <div className="flex gap-1.5">
                {[
                  ['snapshot', 'Current state', 'Every project the customer has, whatever the dates'],
                  ['changes', 'Changed in window', 'Only projects the tracker recorded a change to'],
                ].map(([id, label, hint]) => (
                  <button key={id} type="button" title={hint}
                          onClick={() => setScope({ cxMode: id })}
                          className={cn('h-8 rounded-lg border px-3 text-[12px] font-medium transition-colors',
                            (w.scope?.cxMode || 'snapshot') === id
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-input text-muted-foreground hover:bg-muted')}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                A tracker row is a snapshot, not an event. A project with no activity this week
                still has a go-live date, so <span className="font-medium">Current state</span> is
                what a status report wants. <span className="font-medium">Changed in window</span>{' '}
                answers "what moved" instead, and can legitimately come back empty.
              </p>
            </div>
          )}
          <div className="mt-4">
            <Label className="mb-1.5 block text-[12px] font-medium">Sources</Label>
            <div className="space-y-1.5">
              {SOURCES.map((src) => {
                const on = (w.scope?.sources || []).includes(src.id);
                return (
                  <button
                    key={src.id}
                    onClick={() => setScope({
                      sources: on
                        ? (w.scope.sources || []).filter((x) => x !== src.id)
                        : [...(w.scope.sources || []), src.id],
                    })}
                    className={cn('flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition-colors',
                      on ? 'border-primary/40 bg-primary/8' : 'border-border hover:bg-muted')}
                  >
                    <span className={cn('mt-0.5 grid h-4 w-4 flex-none place-items-center rounded border',
                      on ? 'border-transparent bg-primary text-primary-foreground' : 'border-input')}>
                      {on && <Check size={10} weight="bold" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">{src.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{src.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="mt-3 text-[11.5px] text-muted-foreground">
            <strong>{plural(d.inScope ?? 0, 'transcript')}</strong> currently in scope
            {(w.scope?.sources || []).includes('cxportal') &&
              ', plus the tracker view of each customer, fetched at run time'}.
          </p>
        </Section>
        )}

        {/* ---- 3. prompt -------------------------------------------------- */}
        {!isImport && (
        <Section title="3 · What Claude does"
                 hint="The skill supplies the house style; the instruction is the steer on top of it.">
          <div className="mb-3">
            <Label className="mb-1.5 block text-[12px] font-medium">Skill</Label>
            <select value={w.skill || ''} onChange={(e) => set({ skill: e.target.value || null })}
                    className="h-9 w-full rounded-xl border border-input bg-transparent px-3 text-[13px]">
              <option value="">No skill — a plain prompt</option>
              {skills.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="mb-1.5 block text-[12px] font-medium">Instruction</Label>
            <textarea rows={4} value={w.instruction || ''}
                      onChange={(e) => set({ instruction: e.target.value })}
                      placeholder="generate the Weekly Project Status Report from the transcript files"
                      className="w-full resize-y rounded-xl border border-input bg-transparent px-3 py-2
                                 text-[12.5px] outline-none focus-visible:border-ring" />
          </div>
          {(useGong || useCx) && (
            <div className="mt-4 rounded-xl border border-border p-3">
              <p className="mb-0.5 text-[12px] font-medium">Per-source steer</p>
              <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
                Added to the instruction above, but only for the material a run actually
                receives. A run set to both sources that finds no tracker rows this week is a
                calls-only run, and is steered as one.
              </p>

              {useGong && (
                <div className="mb-2.5">
                  <Label className="mb-1.5 block text-[11.5px] font-medium">
                    Gong transcripts only
                  </Label>
                  <textarea rows={2} value={w.sourceInstructions?.transcript || ''}
                            onChange={(e) => setSteer('transcript', e.target.value)}
                            placeholder="Work from what was said on the calls. Do not assert delivery dates you cannot see."
                            className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5
                                       text-[12px] outline-none focus-visible:border-ring" />
                </div>
              )}

              {useCx && (
                <div className="mb-2.5">
                  <Label className="mb-1.5 block text-[11.5px] font-medium">
                    CX Portal only
                  </Label>
                  <textarea rows={2} value={w.sourceInstructions?.cxportal || ''}
                            onChange={(e) => setSteer('cxportal', e.target.value)}
                            placeholder="Work from the tracker. Report phase, go-live date, slip reason and hours against budget."
                            className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5
                                       text-[12px] outline-none focus-visible:border-ring" />
                </div>
              )}

              {both && (
                <div>
                  <Label className="mb-1.5 block text-[11.5px] font-medium">
                    Both — replaces the two above
                  </Label>
                  <textarea rows={3} value={w.sourceInstructions?.combined || ''}
                            onChange={(e) => setSteer('combined', e.target.value)}
                            placeholder="Reconcile what was said on the calls against what the tracker records. Call out every disagreement, and say which source each claim came from."
                            className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5
                                       text-[12px] outline-none focus-visible:border-ring" />
                  <p className="mt-1 text-[10.5px] text-muted-foreground">
                    Replaces rather than stacks: all three at once produced a call summary, then a
                    delivery summary, then a reconciliation — three disconnected sections.
                  </p>
                </div>
              )}
            </div>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground">
            Skills are managed in{' '}
            <Link href="/applications/claude?tab=skills" className="text-primary no-underline hover:underline">
              the Claude application
            </Link>. Generated documents are passed back on the next run, so reports build on
            what came before.
          </p>
        </Section>
        )}

        {/* ---- 4. schedule ------------------------------------------------ */}
        <Section title={isImport ? '2 · Schedule' : '4 · Schedule'}
                 hint="A timer inside this server — it cannot wake your Mac, and a slot passes while the Mac sleeps.">
          {!schedule ? (
            <Button variant="outline" size="sm" onClick={addSchedule} className="rounded-lg">
              <CalendarBlank size={13} weight="duotone" /> Add a schedule
            </Button>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label className="mb-1.5 block text-[12px] font-medium">Time</Label>
                  <Input type="time" value={schedule.time} className={inputCls}
                         onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
                </div>
                <div>
                  <Label className="mb-1.5 block text-[12px] font-medium">Grace window</Label>
                  <Input type="number" value={schedule.graceMinutes} className={inputCls}
                         onChange={(e) => setSchedule({ ...schedule, graceMinutes: Number(e.target.value) })} />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" checked={Boolean(schedule.enabled)} className="accent-primary"
                           onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })} />
                    Run automatically
                  </label>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {DAYS.map((day, i) => {
                  const on = (schedule.days || []).includes(i);
                  return (
                    <button key={day}
                      onClick={() => setSchedule({
                        ...schedule,
                        days: on ? schedule.days.filter((x) => x !== i) : [...schedule.days, i].sort(),
                      })}
                      className={cn('rounded-lg border px-2.5 py-1 text-[11.5px] font-medium',
                        on ? 'border-transparent bg-primary text-primary-foreground'
                           : 'border-border text-muted-foreground')}>
                      {day}
                    </button>
                  );
                })}
              </div>
              {schedule.nextRunAt && (
                <p className="mt-2 font-mono text-[10.5px] text-muted-foreground">
                  next {new Date(schedule.nextRunAt).toLocaleString()}
                </p>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  );
}

export default function SyncPage({ params }) {
  const { id } = use(params);
  return <SyncDetail id={id} />;
}
