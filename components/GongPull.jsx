'use client';

/**
 * components/GongPull.jsx — fetch transcripts out of Gong.
 *
 * Lives inside the Gong application's Data tab rather than as a top-level
 * page: pulling is something you do *to* a configured source, so it belongs
 * beside that source's credentials, not in the primary navigation.
 *
 * Three stages that replace each other: the form, the live run, the summary.
 * The vanilla version faded between them with a hard-coded 280ms setTimeout
 * that had to match a CSS animation; here it is ordinary conditional
 * rendering with a CSS transition, so nothing has to be kept in step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import PullScene from '@/components/PullScene.jsx';
import { Spinner, Pill } from '@/components/common.jsx';
import { readEvents } from '@/lib/useRunStream.js';
import { plural } from '@/lib/format.js';

const MODES = [
  { id: 'me', label: 'My calls' },
  { id: 'account', label: 'By account' },
  { id: 'call', label: 'By call id' },
];

const STEPS = [
  { key: 'auth', label: 'Authenticate' },
  { key: 'search', label: 'Search' },
  { key: 'download', label: 'Download' },
  { key: 'done', label: 'Done' },
];

const inputCls = `w-full rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
  px-3 py-2 text-[12.5px] outline-none focus:border-[var(--brand)]`;

function Field({ label, hint, children, wide = false }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1.5 block text-[12px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--faint)]">{hint}</span>}
    </label>
  );
}

export default function GongPull() {
  const [cfg, setCfg] = useState(null);
  const [mode, setMode] = useState('me');
  const [stage, setStage] = useState('form');      // form | running | done
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saveBack, setSaveBack] = useState(false);
  const [dryRun, setDryRun] = useState(false);

  const [steps, setSteps] = useState({});
  const [found, setFound] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [caption, setCaption] = useState('WAITING');
  const [identity, setIdentity] = useState(null);
  const [rows, setRows] = useState([]);            // {id,title,day,path,kind,note}
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  // Organizer, shown on the form and again on the summary.
  const [org, setOrg] = useState({ by: 'customer', mode: 'copy' });
  const [orgResult, setOrgResult] = useState(null);
  const [organizing, setOrganizing] = useState(false);

  const pulseRef = useRef(0);

  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then((d) => {
      setCfg(d);
      setOrg((o) => ({ ...o, src: d.GONG_OUT_DIR, out: d.GONG_SORTED_DIR }));
    }).catch(() => {});
  }, []);

  const runTest = useCallback(async (silent = false) => {
    if (!silent) setTesting(true);
    try {
      const d = await fetch('/api/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          GONG_COOKIE: cfg?.GONG_COOKIE, GONG_HOST: cfg?.GONG_HOST,
          GONG_WORKSPACE_ID: cfg?.GONG_WORKSPACE_ID,
        }),
      }).then((r) => r.json());
      setTest(d);
    } catch (err) {
      setTest({ ok: false, checks: [{ step: 'auth', ok: false, detail: err.message }] });
    } finally {
      setTesting(false);
    }
  }, [cfg]);

  // The Chrome extension writes a new cookie straight into gong.env; noticing
  // that is what saves a round trip through DevTools.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const p = await fetch('/api/pulse').then((r) => r.json());
        if (pulseRef.current && p.cookieVersion !== pulseRef.current) {
          const d = await fetch('/api/config').then((r) => r.json());
          setCfg(d);
          runTest(true);
        }
        pulseRef.current = p.cookieVersion;
      } catch { /* the server is restarting */ }
    }, 3000);
    return () => clearInterval(t);
  }, [runTest]);

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

  const start = async () => {
    setStage('running');
    setSteps({}); setFound(0); setTotal(0); setDone(0);
    setRows([]); setSummary(null); setError(null); setCaption('WAITING');

    if (saveBack) {
      await fetch('/api/save-env', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...cfg, GONG_SORTED_DIR: org.out || cfg.GONG_SORTED_DIR }),
      }).catch(() => {});
    }

    const body = { ...cfg, mode, dryRun };
    if (mode === 'me') { body.from = cfg.GONG_DAY_FROM; body.to = cfg.GONG_DAY_TO; }

    try {
      const res = await fetch('/api/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.body) throw new Error(`server returned HTTP ${res.status}`);

      for await (const ev of readEvents(res.body)) handle(ev);
    } catch (err) {
      setError(err.message);
      setStage('form');
    }
  };

  const handle = (ev) => {
    switch (ev.type) {
      case 'stage':
        setSteps((s) => ({ ...s, [ev.stage]: 'on', ...doneBefore(ev.stage) }));
        if (ev.stage === 'download') { setTotal(ev.total || 0); setCaption(`OF ${ev.total}`); }
        break;
      case 'identity': setIdentity(ev); break;
      case 'found':
        setFound(ev.count);
        setCaption('FOUND');
        break;
      case 'planned':
        setRows((r) => [...r, { id: ev.call?.id, title: ev.call?.title, day: ev.call?.day,
                                path: ev.call?.path, kind: 'pending' }]);
        break;
      case 'done':
        setDone((d) => d + 1);
        setRows((r) => {
          const i = r.findIndex((x) => x.id === ev.call?.id && x.kind === 'pending');
          const row = { id: ev.call?.id, title: ev.call?.title, day: ev.call?.day,
                        path: ev.call?.path, kind: ev.kind, note: ev.note || ev.message };
          if (i === -1) return [...r, row];
          const next = [...r]; next[i] = row; return next;
        });
        break;
      case 'complete':
        setSteps((s) => ({ ...s, download: 'done', done: 'done', auth: 'done', search: 'done' }));
        setSummary(ev);
        setTimeout(() => setStage('done'), 700);
        break;
      case 'error':
        setError(ev.message);
        setStage('form');
        break;
      default: break;
    }
  };

  const organize = async (preview) => {
    setOrganizing(true);
    try {
      const d = await fetch('/api/organize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...org, dryRun: preview }),
      }).then((r) => r.json());
      setOrgResult({ ...d, preview });
    } catch (err) {
      setOrgResult({ error: err.message });
    } finally {
      setOrganizing(false);
    }
  };

  if (!cfg) return <div className="grid h-full place-items-center"><Spinner /></div>;

  const byDay = groupByDay(rows);

  return (
    <div>
      <div className="space-y-4">

        {/* ---------------------------------------------------------- form */}
        {stage === 'form' && (
          <div className="stage-in">
            <section className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="font-mono text-[11px] uppercase tracking-wider text-[var(--brand)]">
                  Session
                </h2>
                <button onClick={() => runTest(false)} disabled={testing}
                        className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                                   px-3 py-1.5 text-[12px]">
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
              </div>

              {test && (
                <div className="mb-4 space-y-1.5 rounded-lg border border-[var(--line)]
                                bg-[var(--surface-2)] p-3">
                  {test.checks.map((c) => (
                    <div key={c.step} className="flex items-start gap-2 text-[12px]">
                      <span className={c.ok ? 'text-[var(--ok)]' : 'text-[var(--bad)]'}>
                        {c.ok ? '✓' : '✕'}
                      </span>
                      <span className="w-[80px] flex-none font-mono text-[11px] text-[var(--faint)]">
                        {c.step}
                      </span>
                      <span className="flex-1 text-[var(--text-muted)]">{c.detail}</span>
                    </div>
                  ))}
                  {test.cookie?.cellExpires && (
                    <div className="pt-1 font-mono text-[10.5px] text-[var(--faint)]">
                      session expires {new Date(test.cookie.cellExpires).toLocaleString()}
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Host">
                  <input value={cfg.GONG_HOST || ''} onChange={(e) => set('GONG_HOST', e.target.value)}
                         className={inputCls} />
                </Field>
                <Field label="Workspace ID" hint="blank auto-detects">
                  <input value={cfg.GONG_WORKSPACE_ID || ''}
                         onChange={(e) => set('GONG_WORKSPACE_ID', e.target.value)}
                         className={inputCls} />
                </Field>
                <Field label="Cookie" wide
                       hint="Sign in to Gong in Chrome and click the extension — no copy-paste needed.">
                  <textarea rows={2} value={cfg.GONG_COOKIE || ''}
                            onChange={(e) => set('GONG_COOKIE', e.target.value)}
                            className={`${inputCls} resize-y font-mono text-[10.5px]`} />
                </Field>
              </div>
            </section>

            <section className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <h2 className="mb-4 font-mono text-[11px] uppercase tracking-wider text-[var(--brand)]">
                What to pull
              </h2>

              <div className="mb-4 flex flex-wrap gap-[3px] rounded-[9px] border
                              border-[var(--line)] bg-[var(--surface-2)] p-[3px]">
                {MODES.map((m) => (
                  <button key={m.id} onClick={() => setMode(m.id)}
                          className={`min-w-[96px] flex-1 rounded-[7px] px-3 py-2 text-[12.5px] font-medium
                            ${mode === m.id ? 'bg-[var(--brand)] text-white' : 'text-[var(--text-muted)]'}`}>
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {mode === 'me' && (
                  <>
                    <Field label="From"><input type="date" value={cfg.GONG_DAY_FROM || ''}
                      onChange={(e) => set('GONG_DAY_FROM', e.target.value)} className={inputCls} /></Field>
                    <Field label="To"><input type="date" value={cfg.GONG_DAY_TO || ''}
                      onChange={(e) => set('GONG_DAY_TO', e.target.value)} className={inputCls} /></Field>
                  </>
                )}
                {mode === 'account' && (
                  <>
                    <Field label="Account ID"><input value={cfg.GONG_ACCOUNT_ID || ''}
                      onChange={(e) => set('GONG_ACCOUNT_ID', e.target.value)} className={inputCls} /></Field>
                    <Field label="…or account name" hint="resolved against Gong's search">
                      <input value={cfg.accountName || ''}
                             onChange={(e) => set('accountName', e.target.value)} className={inputCls} />
                    </Field>
                  </>
                )}
                {mode === 'call' && (
                  <Field label="Call IDs" wide hint="space- or comma-separated">
                    <input value={cfg.callIds || ''} onChange={(e) => set('callIds', e.target.value)}
                           className={`${inputCls} font-mono`} />
                  </Field>
                )}

                <Field label="Format">
                  <select value={cfg.GONG_FORMAT || 'md'} onChange={(e) => set('GONG_FORMAT', e.target.value)}
                          className={inputCls}>
                    <option value="md">Markdown</option><option value="text">Text</option>
                    <option value="srt">SRT</option><option value="vtt">VTT</option>
                  </select>
                </Field>
                <Field label="Concurrency">
                  <input type="number" min="1" max="12" value={cfg.GONG_CONCURRENCY || 4}
                         onChange={(e) => set('GONG_CONCURRENCY', e.target.value)} className={inputCls} />
                </Field>
                <Field label="Output folder" wide>
                  <input value={cfg.GONG_OUT_DIR || ''} onChange={(e) => set('GONG_OUT_DIR', e.target.value)}
                         className={`${inputCls} font-mono text-[11px]`} />
                </Field>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-[12px]">
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)}
                         className="accent-[var(--brand)]" />
                  Dry run — show paths, download nothing
                </label>
                <label className="flex items-center gap-2 text-[12px]">
                  <input type="checkbox" checked={saveBack} onChange={(e) => setSaveBack(e.target.checked)}
                         className="accent-[var(--brand)]" />
                  Save these values back to gong.env
                </label>
              </div>

              {error && (
                <p className="mt-3 rounded-lg border border-[var(--bad)]/40 bg-[var(--bad)]/10 p-3
                              text-[12px] text-[var(--bad)]">{error}</p>
              )}

              <button onClick={start}
                      className="mt-4 rounded-lg bg-[var(--brand)] px-5 py-2.5 text-[13px]
                                 font-medium text-white">
                Pull transcripts
              </button>
            </section>

            <Organizer org={org} setOrg={setOrg} run={organize} busy={organizing} result={orgResult} />
          </div>
        )}

        {/* ------------------------------------------------------- running */}
        {stage === 'running' && (
          <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
            <PullScene running done={done} total={total || found}
                       caption={total ? `OF ${total}` : caption} />

            <div className="mb-4 mt-2 flex flex-wrap justify-center gap-2">
              {STEPS.map((s) => (
                <span key={s.key}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11.5px]
                        ${steps[s.key] === 'on' ? 'border-[var(--brand)] text-[var(--text)]'
                          : steps[s.key] === 'done' ? 'border-[var(--ok)]/40 text-[var(--ok)]'
                          : 'border-[var(--line)] text-[var(--faint)]'}`}>
                  {steps[s.key] === 'done' ? '✓' : steps[s.key] === 'on' ? <Spinner size={11} /> : '·'}
                  {s.label}
                </span>
              ))}
            </div>

            {identity && (
              <p className="mb-4 break-anywhere text-center font-mono text-[10.5px] text-[var(--faint)]">
                {identity.host} · user {identity.userId} · workspace {identity.workspaceId}
              </p>
            )}

            <DayList byDay={byDay} />
          </section>
        )}

        {/* ---------------------------------------------------------- done */}
        {stage === 'done' && summary && (
          <>
            <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <h2 className="mb-4 font-mono text-[11px] uppercase tracking-wider text-[var(--brand)]">
                {summary.dryRun ? 'Dry run' : 'Complete'}
              </h2>

              <div className="mb-4 grid grid-cols-3 divide-x divide-[var(--line)] rounded-xl
                              border border-[var(--line)]">
                <Stat label="saved" value={summary.ok} tone="ok" />
                <Stat label="skipped" value={summary.skipped} tone="warn" />
                <Stat label="failed" value={summary.failed} tone={summary.failed ? 'bad' : 'muted'} />
              </div>

              <p className="mb-4 font-mono text-[10.5px] break-anywhere text-[var(--faint)]">
                {summary.outDir}
              </p>

              <DayList byDay={byDay} />

              <button onClick={() => { setStage('form'); setOrgResult(null); }}
                      className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                                 px-4 py-2 text-[12.5px]">
                Pull something else
              </button>
            </section>

            <Organizer org={org} setOrg={setOrg} run={organize} busy={organizing} result={orgResult} />
          </>
        )}
      </div>

    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function Stat({ label, value, tone = 'muted' }) {
  const colour = { ok: 'text-[var(--ok)]', warn: 'text-[var(--warn)]',
                   bad: 'text-[var(--bad)]', muted: 'text-[var(--text-muted)]' }[tone];
  return (
    <div className="px-4 py-3 text-center">
      <div className={`text-[18px] font-semibold ${colour}`}>{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--faint)]">{label}</div>
    </div>
  );
}

function DayList({ byDay }) {
  if (byDay.length === 0) return null;
  return (
    <div className="space-y-3">
      {byDay.map(([day, items]) => (
        <div key={day}>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold">{day}</span>
            <span className="font-mono text-[10px] text-[var(--faint)]">
              {plural(items.length, 'call')}
            </span>
          </div>
          <div className="divide-y divide-[var(--line-soft)] rounded-lg border border-[var(--line)]
                          bg-[var(--surface-2)]">
            {items.map((r, i) => (
              <div key={`${r.id}-${i}`} className="flex items-center gap-2.5 px-3 py-2">
                <span className="flex-none">
                  {r.kind === 'pending' ? <Spinner size={11} />
                    : r.kind === 'ok' ? <span className="text-[var(--ok)]">✓</span>
                    : r.kind === 'skip' ? <span className="text-[var(--warn)]">−</span>
                    : <span className="text-[var(--bad)]">✕</span>}
                </span>
                <a href={r.path ? `/preview?path=${encodeURIComponent(r.path)}` : undefined}
                   className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)] no-underline
                              hover:text-[var(--brand)]" title={r.path}>
                  {r.title}
                </a>
                {r.note && (
                  <span className="flex-none font-mono text-[10px] text-[var(--faint)]">{r.note}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Organizer({ org, setOrg, run, busy, result }) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
      <h2 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-[var(--brand)]">
        Organize
      </h2>
      <p className="mb-4 text-[12px] text-[var(--text-muted)]">
        Downloads are filed by day. This builds a second tree grouped by customer — which is
        what the Projects tab reads.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Group by">
          <select value={org.by} onChange={(e) => setOrg({ ...org, by: e.target.value })}
                  className={inputCls}>
            <option value="customer">Customer</option>
            <option value="call">Call title</option>
          </select>
        </Field>
        <Field label="How">
          <select value={org.mode} onChange={(e) => setOrg({ ...org, mode: e.target.value })}
                  className={inputCls}>
            <option value="copy">Copy — cannot lose anything</option>
            <option value="link">Hardlink — one set of bytes, two paths</option>
            <option value="move">Move — and tidy up empty day folders</option>
          </select>
        </Field>
        <Field label="Source" wide>
          <input value={org.src || ''} onChange={(e) => setOrg({ ...org, src: e.target.value })}
                 className={`${inputCls} font-mono text-[11px]`} />
        </Field>
        <Field label="Destination" wide>
          <input value={org.out || ''} onChange={(e) => setOrg({ ...org, out: e.target.value })}
                 className={`${inputCls} font-mono text-[11px]`} />
        </Field>
      </div>

      <div className="mt-4 flex gap-2.5">
        <button onClick={() => run(true)} disabled={busy}
                className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                           px-4 py-2 text-[12.5px]">Preview</button>
        <button onClick={() => run(false)} disabled={busy}
                className="rounded-lg bg-[var(--brand)] px-4 py-2 text-[12.5px]
                           font-medium text-white">
          {busy ? 'Working…' : 'Organize'}
        </button>
      </div>

      {result && (
        <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3">
          {result.error ? (
            <p className="text-[12px] text-[var(--bad)]">{result.error}</p>
          ) : (
            <>
              <p className="mb-2 text-[12px]">
                {result.preview ? 'Would file ' : 'Filed '}
                <strong>{plural(result.done ?? result.planned?.length ?? 0, 'file')}</strong>
                {' into '}
                <strong>{plural(result.groups?.length || 0, 'folder')}</strong>
                {' · '}{result.mode}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(result.groups || []).slice(0, 24).map((g) => (
                  <Pill key={g.name || g}>{g.name || g}</Pill>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ utils */

function groupByDay(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.day || 'unknown';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()];
}

/** Stages are sequential, so starting one means everything before it finished. */
function doneBefore(stage) {
  const order = STEPS.map((s) => s.key);
  const i = order.indexOf(stage);
  return Object.fromEntries(order.slice(0, Math.max(i, 0)).map((k) => [k, 'done']));
}
