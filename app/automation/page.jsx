'use client';

/**
 * Automation — pull from Gong, organize by customer, feed the projects.
 *
 * The schedule is a timer inside this server, not launchd and not pmset. That
 * is the point: it cannot wake the Mac, and while the Mac is asleep the slot
 * simply passes rather than queueing up to fire on wake.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRunStream } from '@/lib/useRunStream.js';
import { Spinner } from '@/components/ui.jsx';
import { ago, plural } from '@/lib/format.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STEPS = [
  { key: 'pull', label: 'Pull from Gong' },
  { key: 'organize', label: 'Organize' },
  { key: 'projects', label: 'Feed projects' },
];

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--faint)]">{hint}</span>}
    </label>
  );
}

const inputCls = `w-full rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
  px-3 py-2 text-[12.5px] outline-none focus:border-[var(--accent)]`;

function Toggle({ on, onChange, label, hint }) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={`mt-0.5 h-[22px] w-[38px] flex-none rounded-full p-[3px] transition-colors
          ${on ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)] border border-[var(--line)]'}`}
      >
        <span className={`block h-4 w-4 rounded-full bg-white transition-transform
          ${on ? 'translate-x-4' : ''}`} />
      </button>
      <span>
        <span className="block text-[12.5px] font-medium">{label}</span>
        {hint && <span className="block text-[11px] text-[var(--faint)]">{hint}</span>}
      </span>
    </div>
  );
}

export default function AutomationPage() {
  const [cfg, setCfg] = useState(null);
  const [runId, setRunId] = useState(null);
  const [saved, setSaved] = useState(false);
  const [steps, setSteps] = useState({});
  const [log, setLog] = useState([]);

  const run = useRunStream(runId, {
    onEvent: (e) => {
      if (e.type === 'step') {
        setSteps((s) => ({ ...s, [e.step]: 'on', ...doneBefore(e.step) }));
        setLog((l) => [...l, { kind: 'step', text: e.message }]);
      } else if (e.type === 'detail') {
        setLog((l) => [...l, { kind: 'detail', text: e.message }]);
      } else if (e.type === 'file') {
        setLog((l) => [...l, { kind: 'file', text: e.name }]);
      } else if (e.type === 'error') {
        setLog((l) => [...l, { kind: 'error', text: e.message }]);
      }
    },
    onFinish: () => { setRunId(null); setSteps({}); load(); },
  });

  const load = useCallback(async () => {
    try {
      const d = await fetch('/api/automation').then((r) => r.json());
      setCfg(d);
      if (!runId && d.active?.[0]) setRunId(d.active[0].id);
      return d;
    } catch { return null; }
  }, [runId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (runId) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [runId, load]);

  const patch = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

  const save = async () => {
    const d = await fetch('/api/automation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: cfg.enabled, time: cfg.time, days: cfg.days,
        daysBack: Number(cfg.daysBack) || 2,
        graceMinutes: Number(cfg.graceMinutes) || 20,
        organize: cfg.organize, organizeBy: cfg.organizeBy, organizeMode: cfg.organizeMode,
      }),
    }).then((r) => r.json());
    setCfg(d);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const runNow = async () => {
    setLog([]); setSteps({});
    const d = await fetch('/api/automation/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ daysBack: Number(cfg?.daysBack) || 2 }),
    }).then((r) => r.json());
    if (d.id) setRunId(d.id);
  };

  if (!cfg) return <div className="grid h-full place-items-center"><Spinner /></div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[880px] space-y-4 p-4 sm:p-6">

        <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
            Schedule
          </h2>
          <p className="mb-4 text-[12px] leading-relaxed text-[var(--muted)]">
            The timer runs <strong>inside this server</strong>, not in launchd. It therefore
            cannot wake your Mac, and while the Mac is asleep the slot simply passes —
            nothing is queued up to fire on wake. If you are away past the grace window,
            the day is recorded as missed and it waits for the next one.
          </p>

          <div className="mb-5 grid grid-cols-2 divide-[var(--line)] rounded-xl border
                          border-[var(--line)] sm:grid-cols-4 sm:divide-x
                          [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-[var(--line)]
                          sm:[&>*]:border-b-0 [&>*:nth-child(odd)]:border-r
                          [&>*:nth-child(odd)]:border-[var(--line)] sm:[&>*]:border-r-0">
            <Stat label="Schedule" value={cfg.enabled ? `${cfg.time}` : 'Off'} />
            <Stat label="Next run"
                  value={cfg.nextRunAt ? new Date(cfg.nextRunAt).toLocaleString(undefined,
                    { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—'} />
            <Stat label="Last run" value={cfg.lastRunAt ? ago(cfg.lastRunAt) : 'never'} />
            <Stat label="Today"
                  value={runId ? 'running' : cfg.alreadyHandled ? 'done' : cfg.missed ? 'missed' : 'idle'} />
          </div>

          <div className="space-y-5">
            <Toggle
              on={Boolean(cfg.enabled)}
              onChange={(v) => patch('enabled', v)}
              label="Run automatically"
              hint="Needs this server to be running. Nothing is scheduled with the operating system, so your Mac is never woken."
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Time">
                <input type="time" value={cfg.time || '09:00'}
                       onChange={(e) => patch('time', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Pull the last" hint="days of your calls">
                <input type="number" min="1" max="30" value={cfg.daysBack ?? 2}
                       onChange={(e) => patch('daysBack', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Grace window" hint="minutes late it may still run">
                <input type="number" min="0" max="240" value={cfg.graceMinutes ?? 20}
                       onChange={(e) => patch('graceMinutes', e.target.value)} className={inputCls} />
              </Field>
            </div>

            <div>
              <span className="mb-1.5 block text-[12px] font-medium">Days</span>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => {
                  const on = (cfg.days || []).includes(i);
                  return (
                    <button
                      key={d}
                      onClick={() => patch('days', on
                        ? cfg.days.filter((x) => x !== i)
                        : [...(cfg.days || []), i].sort())}
                      className={`rounded-lg border px-3 py-1.5 text-[11.5px] font-medium transition-colors
                        ${on ? 'border-transparent bg-[var(--accent)] text-white'
                             : 'border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)]'}`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Group by">
                <select value={cfg.organizeBy || 'customer'}
                        onChange={(e) => patch('organizeBy', e.target.value)} className={inputCls}>
                  <option value="customer">Customer</option>
                  <option value="call">Call title</option>
                </select>
              </Field>
              <Field label="How">
                <select value={cfg.organizeMode || 'copy'}
                        onChange={(e) => patch('organizeMode', e.target.value)} className={inputCls}>
                  <option value="copy">Copy</option>
                  <option value="link">Hardlink</option>
                  <option value="move">Move</option>
                </select>
              </Field>
              <Toggle on={Boolean(cfg.organize)} onChange={(v) => patch('organize', v)}
                      label="Organize" hint="Group before feeding projects" />
            </div>

            <div className="flex items-center gap-2.5">
              <button onClick={save}
                      className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[12.5px]
                                 font-medium text-white">
                Save schedule
              </button>
              <button onClick={runNow} disabled={Boolean(runId)}
                      className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                                 px-4 py-2 text-[12.5px] disabled:opacity-40">
                {runId ? 'Running…' : 'Run now'}
              </button>
              {saved && <span className="text-[12px] text-[var(--ok)]">Saved.</span>}
            </div>
          </div>
        </section>

        {(runId || log.length > 0) && (
          <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
            <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
              Pipeline
            </h2>

            <div className="mb-4 flex flex-wrap gap-2">
              {STEPS.map((s) => (
                <span key={s.key}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11.5px]
                        ${steps[s.key] === 'on'
                          ? 'border-[var(--accent)] text-[var(--text)]'
                          : steps[s.key] === 'done'
                            ? 'border-[var(--ok)]/40 text-[var(--ok)]'
                            : 'border-[var(--line)] text-[var(--faint)]'}`}>
                  {steps[s.key] === 'on' ? <Spinner size={11} /> : <span>{steps[s.key] === 'done' ? '✓' : '·'}</span>}
                  {s.label}
                </span>
              ))}
            </div>

            <div className="max-h-[260px] overflow-y-auto rounded-lg border border-[var(--line)]
                            bg-[var(--surface-2)] p-3 font-mono text-[11px] leading-[1.75]">
              {log.map((l, i) => (
                <div key={i} className={
                  l.kind === 'error' ? 'text-[var(--bad)]'
                  : l.kind === 'step' ? 'mt-1.5 font-semibold text-[var(--text)]'
                  : l.kind === 'file' ? 'text-[var(--faint)] pl-3'
                  : 'text-[var(--muted)] pl-3'}>
                  {l.kind === 'file' ? `· ${l.text}` : l.text}
                </div>
              ))}
              {log.length === 0 && <span className="text-[var(--faint)]">Waiting…</span>}
            </div>
          </section>
        )}

        <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
            History
          </h2>
          <p className="mb-4 text-[12px] text-[var(--muted)]">
            The last runs, including days that were skipped because the Mac was asleep.
          </p>

          {(cfg.history || []).length === 0 && (
            <p className="py-6 text-center text-[12px] text-[var(--faint)]">Nothing has run yet.</p>
          )}

          <div className="divide-y divide-[var(--line-soft)]">
            {(cfg.history || []).map((h, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[12px]">
                <span className={`h-1.5 w-1.5 flex-none rounded-full ${
                  h.kind === 'ok' ? 'bg-[var(--ok)]'
                  : h.kind === 'missed' ? 'bg-[var(--warn)]' : 'bg-[var(--bad)]'}`} />
                <span className="flex-none font-mono text-[11px] text-[var(--faint)]">
                  {new Date(h.at).toLocaleString(undefined,
                    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="min-w-0 flex-1 text-[var(--muted)]">
                  {h.kind === 'missed'
                    ? 'Skipped — the Mac was asleep past the grace window'
                    : `${plural(h.pulled, 'call')} · ${plural(h.organized, 'file')} organized · ${plural(h.projects, 'project')} updated`}
                </span>
                {h.trigger && (
                  <span className="font-mono text-[10px] text-[var(--faint)]">{h.trigger}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[13px] font-medium">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--faint)]">
        {label}
      </div>
    </div>
  );
}

/** Steps are sequential, so starting one means everything before it finished. */
function doneBefore(step) {
  const order = STEPS.map((s) => s.key);
  const i = order.indexOf(step);
  return Object.fromEntries(order.slice(0, Math.max(i, 0)).map((k) => [k, 'done']));
}
