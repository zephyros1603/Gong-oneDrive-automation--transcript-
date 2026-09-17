'use client';

/**
 * Dashboard — what is happening, in one screen.
 *
 * Every widget here is built from data the system already records. Two that
 * were asked for are deliberately absent until the schema supports them
 * honestly: "transcripts processed" needs per-run file tracking (runs record a
 * file *count*, not paths), and "tokens used" needs claude-runner to capture
 * the usage block the CLI already reports. A widget showing a plausible-looking
 * wrong number is worse than no widget.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  FileText, FileDoc, Key, Sparkle, ClockCounterClockwise, CurrencyDollar,
  Lightning, Warning, ArrowRight, CheckCircle, XCircle,
  DotsSixVertical, EyeSlash, Eye, PencilSimple, ArrowCounterClockwise, Check,
} from '@phosphor-icons/react';
import { useWidgetLayout } from '@/lib/useWidgetLayout.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { money, money4, ago, plural } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Everything on the dashboard, stat tiles included. One catalogue and one
 * grid: a tile and a panel differ only in how many columns they span, so
 * making them different kinds would mean two drag implementations and a rule
 * about which can be dragged where.
 */
const WIDGETS = [
  { id: 'transcripts', label: 'Transcripts', span: 'lg:col-span-1' },
  { id: 'documents', label: 'Documents produced', span: 'lg:col-span-1' },
  { id: 'session', label: 'Gong session', span: 'lg:col-span-1' },
  { id: 'skills', label: 'Skills', span: 'lg:col-span-1' },
  { id: 'automation', label: 'Automation', span: 'lg:col-span-1' },
  { id: 'spend30', label: 'Spend, 30 days', span: 'lg:col-span-1' },
  { id: 'runningnow', label: 'Running now', span: 'lg:col-span-1' },
  { id: 'incomplete', label: 'Runs not completed', span: 'lg:col-span-1' },
  { id: 'spend', label: 'Spend chart', span: 'lg:col-span-2' },
  { id: 'weekday', label: 'Automation by weekday', span: 'lg:col-span-2' },
  { id: 'attention', label: 'Needs attention', span: 'lg:col-span-2' },
  { id: 'recent', label: 'Recent automation', span: 'lg:col-span-2' },
];

/**
 * Wraps a widget so it can be dragged and hidden while the dashboard is in
 * edit mode, and is an ordinary div the rest of the time.
 */
function Widget({ id, label, editing, isDragging, isOver, onHide, drag, children, className }) {
  return (
    <div
      {...drag}
      className={cn(
        'relative transition-all',
        className,
        editing && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
        isOver && 'scale-[1.01] ring-2 ring-primary ring-offset-2 ring-offset-background rounded-2xl'
      )}
    >
      {editing && (
        <div className="absolute -top-2.5 left-3 z-10 flex items-center gap-1 rounded-lg border
                        border-border bg-popover px-1.5 py-0.5 shadow-sm">
          <DotsSixVertical size={13} weight="bold" className="text-muted-foreground" />
          <span className="text-[10.5px] font-medium text-muted-foreground">{label}</span>
          <button onClick={onHide} title="Hide this widget"
                  className="ml-1 text-muted-foreground hover:text-bad">
            <EyeSlash size={12} weight="duotone" />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub, tone = 'default', href }) {
  const tones = {
    default: 'text-primary',
    ok: 'text-ok',
    warn: 'text-warn',
    bad: 'text-bad',
  };
  const body = (
    <Card className="h-full gap-0 rounded-2xl py-0 transition-shadow hover:shadow-md">
      <CardContent className="flex items-start gap-2.5 p-3.5">
        <span className={cn('grid h-8 w-8 flex-none place-items-center rounded-[9px] bg-muted',
                            tones[tone])}>
          <Icon size={16} weight="duotone" />
        </span>
        <span className="min-w-0">
          <span className="block text-[17px] font-semibold leading-none tracking-tight">
            {value}
          </span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{label}</span>
          {sub && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">{sub}</span>}
        </span>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="no-underline">{body}</Link> : body;
}

export default function DashboardPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const layout = useWidgetLayout(WIDGETS);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dashboard').then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setD(r);
      setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (err) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="mb-2 text-[13px] text-bad">{err}</p>
          <Button variant="outline" onClick={load} className="rounded-xl">Retry</Button>
        </div>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto grid max-w-[1280px] grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const cookieTone = d.session.daysLeft == null ? 'bad'
    : d.session.daysLeft <= 2 ? 'bad'
    : d.session.daysLeft <= 5 ? 'warn' : 'ok';

  const busiest = d.automation.weekdays.indexOf(Math.max(...d.automation.weekdays));
  const anyAutomation = d.automation.weekdays.some((n) => n > 0);
  const peak = Math.max(...d.spend.byDay.map((x) => x.usd), 0.0001);

  // A bar per day of the window, not per day that happened to have a run —
  // otherwise five active days render as five wide slabs with no sense of when.
  const series = (() => {
    const found = new Map(d.spend.byDay.map((x) => [x.day, x]));
    const out = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400e3).toLocaleDateString('sv');
      out.push(found.get(day) || { day, usd: 0, runs: 0 });
    }
    return out;
  })();

  const PANELS = {
    transcripts: (
      <Stat icon={FileText} label="Transcripts" value={d.transcripts.total}
      sub={`${d.transcripts.last7d} in the last 7 days`} href="/preview" />
    ),
    documents: (
      <Stat icon={FileDoc} label="Documents produced" value={d.transcripts.documents}
      sub={d.transcripts.latestAt ? `latest ${ago(d.transcripts.latestAt)}` : 'none yet'}
      href="/preview" />
    ),
    session: (
      <Stat icon={Key} label="Gong session" tone={cookieTone}
      value={d.session.daysLeft != null ? `${d.session.daysLeft}d` : '—'}
      sub={d.session.daysLeft != null ? 'until the cookie expires' : 'not signed in'}
      href="/applications" />
    ),
    skills: (
      <Stat icon={Sparkle} label="Skills"
      tone={d.skills.missing ? 'warn' : 'ok'}
      value={d.skills.installed.length}
      sub={d.skills.missing ? `${d.skills.missing} action(s) missing a skill` : 'all actions wired'}
      href="/workbench" />
    ),
    automation: (
      <Stat icon={ClockCounterClockwise} label="Automation"
      tone={d.automation.enabled ? 'ok' : 'default'}
      value={d.automation.enabled ? d.automation.time : 'Off'}
      sub={d.automation.nextRunAt
      ? `next ${new Date(d.automation.nextRunAt).toLocaleString(undefined,
      { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : 'not scheduled'}
      href="/automation" />
    ),
    spend30: (
      <Stat icon={CurrencyDollar} label="Spend, 30 days"
      value={money(d.spend.total30d)}
      sub={`${money(d.spend.today)} today`} />
    ),
    runningnow: (
      <Stat icon={Lightning} label="Running now"
      tone={d.running.jobs.length ? 'warn' : 'default'}
      value={d.running.jobs.length}
      sub={d.running.jobs.length ? 'started by Warp' : 'nothing in flight'} />
    ),
    incomplete: (
      <Stat icon={Warning} label="Runs not completed"
      tone={d.outcomes.noCost > d.outcomes.total / 4 ? 'warn' : 'default'}
      value={`${Math.round((d.outcomes.noCost / Math.max(d.outcomes.total, 1)) * 100)}%`}
      sub={`${d.outcomes.noCost} of ${d.outcomes.total} runs`} />
    ),
    spend: (
            <Card className="rounded-2xl lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12.5px] font-semibold">Spend, last 30 days</CardTitle>
              </CardHeader>
              <CardContent>
                {d.spend.byDay.length === 0 ? (
                  <p className="py-8 text-center text-[12px] text-muted-foreground">No runs yet.</p>
                ) : (
                  <>
                  <div className="flex h-[140px] items-end gap-[3px]">
                    {series.map((day) => (
                      <div key={day.day} className="group relative min-w-0 flex-1"
                           title={day.usd
                             ? `${day.day} · ${money4(day.usd)} · ${plural(day.runs, 'run')}`
                             : `${day.day} · nothing ran`}>
                        <div
                          className={cn('w-full rounded-t-[3px] transition-colors',
                            day.usd ? 'bg-primary/70 group-hover:bg-primary' : 'bg-muted')}
                          style={{ height: `${day.usd ? Math.max((day.usd / peak) * 130, 4) : 3}px` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
                    <span>{series[0]?.day.slice(5)}</span>
                    <span>{series.at(-1)?.day.slice(5)}</span>
                  </div>
                  </>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {d.spend.byAction.map((a) => (
                    <Badge key={a.action} variant="secondary" className="rounded-lg font-mono text-[10.5px]">
                      {a.action} {money(a.usd)} · {a.runs}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
    ),
    weekday: (
            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12.5px] font-semibold">Automation by weekday</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {DAYS.map((name, i) => {
                    const n = d.automation.weekdays[i];
                    const max = Math.max(...d.automation.weekdays, 1);
                    const isBusiest = anyAutomation && i === busiest;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className={cn('w-8 flex-none font-mono text-[11px]',
                          isBusiest ? 'font-semibold text-primary' : 'text-muted-foreground')}>
                          {name}
                        </span>
                        <div className="h-4 flex-1 overflow-hidden rounded-md bg-muted">
                          <div
                            className={cn('h-full rounded-md transition-colors',
                              isBusiest ? 'bg-primary' : 'bg-primary/35')}
                            style={{ width: `${(n / max) * 100}%` }}
                          />
                        </div>
                        <span className="w-5 flex-none text-right font-mono text-[11px] text-muted-foreground">
                          {n || ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {!anyAutomation && (
                  <p className="mt-3 text-[11.5px] text-muted-foreground">
                    Nothing has run in the last four weeks.
                  </p>
                )}
              </CardContent>
            </Card>
    ),
    attention: (
            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
                  Needs attention
                  {d.attention.length > 0 && (
                    <Badge variant="secondary" className="rounded-md">{d.attention.length}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {d.attention.length === 0 ? (
                  <p className="py-4 text-[12px] text-muted-foreground">
                    Every customer with transcripts has had something generated since.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {d.attention.map((p) => (
                      <Link key={p.id} href="/projects"
                            className="flex items-center gap-2 rounded-xl px-2 py-2 no-underline
                                       transition-colors hover:bg-muted">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium">{p.name}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {plural(p.transcripts, 'transcript')} · newest {ago(p.lastTranscriptAt)}
                            {p.lastRunAt ? ` · last run ${ago(p.lastRunAt)}` : ' · never run'}
                          </span>
                        </span>
                        <ArrowRight size={14} className="flex-none text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
    ),
    recent: (
            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12.5px] font-semibold">Recent automation</CardTitle>
              </CardHeader>
              <CardContent>
                {d.automation.recent.length === 0 ? (
                  <p className="py-4 text-[12px] text-muted-foreground">Nothing has run yet.</p>
                ) : (
                  <div className="space-y-1">
                    {d.automation.recent.map((h, i) => (
                      <div key={i} className="flex items-center gap-2.5 px-2 py-2">
                        {h.kind === 'ok'
                          ? <CheckCircle size={15} weight="fill" className="flex-none text-ok" />
                          : <XCircle size={15} weight="fill" className="flex-none text-bad" />}
                        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                          {plural(h.pulled, 'call')} · {plural(h.organized, 'file')} organized
                          · {plural(h.projects, 'project')}
                        </span>
                        <span className="flex-none font-mono text-[10.5px] text-muted-foreground">
                          {ago(h.at)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
    ),
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] space-y-3.5 p-5 sm:p-7">

        {/* ---- header + layout controls ----------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight">Dashboard</h1>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {layout.editing
                ? 'Drag a panel to reorder it, or hide it with the eye.'
                : 'Everything Warp knows, as of a moment ago.'}
            </p>
          </div>

          <div className="flex flex-none items-center gap-2">
            {layout.editing && layout.hidden.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {layout.hidden.map((id) => (
                  <Button key={id} variant="outline" size="sm" onClick={() => layout.toggle(id)}
                          className="rounded-xl text-[11.5px]">
                    <Eye size={13} weight="duotone" /> {WIDGETS.find((w) => w.id === id)?.label}
                  </Button>
                ))}
              </div>
            )}
            {layout.editing && (
              <Button variant="ghost" size="sm" onClick={layout.reset} className="rounded-xl">
                <ArrowCounterClockwise size={14} weight="duotone" /> Reset
              </Button>
            )}
            <Button
              variant={layout.editing ? 'default' : 'outline'}
              size="sm"
              onClick={() => layout.setEditing(!layout.editing)}
              className="rounded-xl"
            >
              {layout.editing
                ? <><Check size={14} weight="bold" /> Done</>
                : <><PencilSimple size={14} weight="duotone" /> Edit layout</>}
            </Button>
          </div>
        </div>

        
        {/* ---- panels: order and visibility are the viewer's -------------- */}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {layout.visible.map((id) => {
            const meta = WIDGETS.find((w) => w.id === id);
            return (
              <Widget
                key={id}
                label={meta.label}
                className={meta.span}
                editing={layout.editing}
                isDragging={layout.dragging === id}
                isOver={layout.over === id}
                onHide={() => layout.toggle(id)}
                drag={layout.dragProps(id)}
              >
                {PANELS[id]}
              </Widget>
            );
          })}
        </div>
      </div>
    </div>
  );
}
