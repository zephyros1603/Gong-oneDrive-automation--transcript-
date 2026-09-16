'use client';

/**
 * Workbench — transcripts in, documents out.
 *
 * The file tree is the reason this page wanted React most. The vanilla version
 * rebuilt the entire tree as an HTML string on every checkbox tick and then
 * re-ran five querySelectorAll passes to reattach the listeners; the selection
 * also lived in the DOM, alongside two other pieces of state stashed in
 * `dataset` attributes. All of that is ordinary state here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Composer, { RunStatus } from '@/components/Composer.jsx';
import {
  Markdown, EmailBox, DocCard, Empty, Pill, Spinner, useEmailSplit,
} from '@/components/ui.jsx';
import SidebarLayout, { SidebarToggle } from '@/components/SidebarLayout.jsx';
import { useRunStream } from '@/lib/useRunStream.js';
import { kb, stripName, runMeta, money } from '@/lib/format.js';

function Reply({ text }) {
  const { email, rest } = useEmailSplit(text);
  return (
    <>
      {rest?.trim() && <Markdown source={rest} />}
      {email && <EmailBox email={email} />}
    </>
  );
}

export default function WorkbenchPage() {
  const [tree, setTree] = useState({ files: [], folders: [], roots: [] });
  const [settings, setSettings] = useState(null);
  const [skills, setSkills] = useState([]);
  const [skill, setSkill] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [collapsed, setCollapsed] = useState(new Set());
  const [side, setSide] = useState('input');
  const [session, setSession] = useState(null);
  const [sessionResetPending, setResetPending] = useState(false);
  const [turns, setTurns] = useState([]);       // the visible conversation
  const [runId, setRunId] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [processes, setProcesses] = useState([]);
  const [cli, setCli] = useState(null);
  const thread = useRef(null);

  const run = useRunStream(runId, {
    onEvent: (e) => { if (e.type === 'session' && e.session) setSession(e.session); },
    onFinish: (state) => {
      setSession((s) => state.session || s);
      setTurns((t) => [...t, {
        id: `r${Date.now()}`, role: 'claude',
        text: state.text, cost: state.cost, turns: state.turns,
        durationMs: state.durationMs, documents: state.documents,
        cancelled: state.status === 'cancelled', errors: state.errors,
      }]);
      setRunId(null);
      if (state.outputChanged) refreshTree();
    },
  });

  const refreshTree = useCallback(async () => {
    try {
      const d = await fetch('/api/tree').then((r) => r.json());
      setTree(d);
      return d;
    } catch { return null; }
  }, []);

  useEffect(() => {
    (async () => {
      const [, s, sk] = await Promise.all([
        refreshTree(),
        fetch('/api/settings').then((r) => r.json()).catch(() => null),
        fetch('/api/skills').then((r) => r.json()).catch(() => null),
      ]);
      if (s) {
        setSettings(s);
        setSelected(new Set(s.selection || []));
      }
      if (sk) { setSkills(sk.actions || []); setCli(sk.cli); }
    })();
  }, [refreshTree]);

  // Files change on disk when a pull or an organize runs elsewhere.
  useEffect(() => {
    if (runId) return;
    let last = `${tree.inputVersion}|${tree.outputVersion}`;
    const t = setInterval(async () => {
      try {
        const p = await fetch('/api/pulse').then((r) => r.json());
        const now = `${p.inputVersion}|${p.outputVersion}`;
        if (now !== last) { last = now; refreshTree(); }
      } catch { /* the server is restarting */ }
    }, 4000);
    return () => clearInterval(t);
  }, [runId, refreshTree, tree.inputVersion, tree.outputVersion]);

  useEffect(() => {
    const t = setInterval(() => {
      fetch('/api/claude-processes').then((r) => r.json())
        .then((d) => setProcesses(Array.isArray(d) ? d : []))
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [turns.length, run.text, run.trace.length]);

  const files = useMemo(
    () => tree.files.filter((f) => (side === 'input' ? f.kind === 'input' : f.kind === 'output')),
    [tree.files, side]
  );

  const groups = useMemo(() => {
    const by = new Map();
    for (const f of files) {
      const key = f.group || f.root || 'other';
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(f);
    }
    return [...by.entries()];
  }, [files]);

  /** Persist the selection so a reload comes back to the same files. */
  const persist = useCallback((next) => {
    fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: [...next] }),
    }).catch(() => {});
  }, []);

  const toggleFile = (path) => {
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(path) ? next.delete(path) : next.add(path);
      // Attaching transcripts to a conversation that already has context would
      // resend all of it, so a changed selection starts a fresh session.
      if (session && next.size) { setSession(null); setResetPending(true); }
      persist(next);
      return next;
    });
  };

  const toggleGroup = (items) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const all = items.every((f) => next.has(f.path));
      for (const f of items) all ? next.delete(f.path) : next.add(f.path);
      if (session && next.size) { setSession(null); setResetPending(true); }
      persist(next);
      return next;
    });
  };

  const send = async ({ text, skill: picked }) => {
    const chosen = [...selected];
    setTurns((t) => [...t, {
      id: `u${Date.now()}`, role: 'user', text,
      skill: picked ? { id: picked.id, label: picked.label } : null,
      files: chosen.map((p) => ({ path: p, name: p.split('/').pop() })),
    }]);
    setResetPending(false);

    const started = await fetch('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionId: picked?.id || null,
        message: text,
        files: chosen,
        outputDir: settings?.outputDir,
        sessionId: session,
      }),
    }).then((r) => r.json());

    if (started.error) {
      setTurns((t) => [...t, { id: `e${Date.now()}`, role: 'claude', text: '', errors: [started.error] }]);
      return;
    }
    setSkill(null);
    setRunId(started.runId);
  };

  const newChat = () => {
    setSession(null);
    setSkill(null);
    setResetPending(false);
    setTurns((t) => [...t, { id: `n${Date.now()}`, role: 'system' }]);
  };

  const killProcesses = async (kinds) => {
    await fetch('/api/kill-claude', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds }),
    });
    const d = await fetch('/api/claude-processes').then((r) => r.json());
    setProcesses(Array.isArray(d) ? d : []);
  };

  const selectedMeta = tree.files.filter((f) => selected.has(f.path));

  const sidebar = (
    <>
        <div className="flex flex-none gap-[3px] border-b border-[var(--line)] p-2.5">
          {['input', 'output'].map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2
                text-[12px] font-medium capitalize transition-colors
                ${side === s ? 'bg-[var(--accent)] text-white'
                             : 'bg-[var(--surface-2)] text-[var(--muted)]'}`}
            >
              {s}
              <span className="rounded bg-black/20 px-1.5 font-mono text-[10px]">
                {tree.files.filter((f) => f.kind === s).length}
              </span>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.length === 0 && (
            <div className="p-3 text-[11.5px] text-[var(--faint)]">
              Nothing here yet.
            </div>
          )}
          {groups.map(([group, items]) => {
            const open = !collapsed.has(group);
            const all = items.every((f) => selected.has(f.path));
            const some = !all && items.some((f) => selected.has(f.path));
            return (
              <div key={group} className="mb-0.5">
                <div className="flex items-center gap-1.5 rounded-lg px-1.5 py-1
                                hover:bg-[var(--surface-2)]">
                  <button
                    onClick={() => setCollapsed((c) => {
                      const n = new Set(c);
                      n.has(group) ? n.delete(group) : n.add(group);
                      return n;
                    })}
                    className={`w-3 flex-none text-[10px] text-[var(--faint)] transition-transform
                                ${open ? 'rotate-90' : ''}`}
                  >
                    ▶
                  </button>
                  {side === 'input' && (
                    <input
                      type="checkbox"
                      checked={all}
                      ref={(el) => { if (el) el.indeterminate = some; }}
                      onChange={() => toggleGroup(items)}
                      className="flex-none accent-[var(--accent)]"
                    />
                  )}
                  <span className="flex-1 truncate text-[12px] font-medium">{group}</span>
                  <span className="font-mono text-[10px] text-[var(--faint)]">{items.length}</span>
                </div>

                {open && items.map((f) => (
                  <div key={f.path}
                       className="flex items-center gap-1.5 rounded-lg py-1 pl-6 pr-1.5
                                  hover:bg-[var(--surface-2)]">
                    {side === 'input' && (
                      <input
                        type="checkbox"
                        checked={selected.has(f.path)}
                        onChange={() => toggleFile(f.path)}
                        className="flex-none accent-[var(--accent)]"
                      />
                    )}
                    <a
                      href={`/preview?path=${encodeURIComponent(f.path)}`}
                      className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text)] no-underline
                                 hover:text-[var(--accent)]"
                      title={f.path}
                    >
                      {stripName(f.name)}
                    </a>
                    <span className="flex-none font-mono text-[10px] text-[var(--faint)]">
                      {kb(f.size)}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
    </>
  );

  return (
    <SidebarLayout sidebar={sidebar} open={drawer} onOpenChange={setDrawer}
                   initial={300} min={220} max={480} storageKey="gong.workbench.sidebar">
        <header className="flex flex-none flex-wrap items-center gap-2.5 border-b
                           border-[var(--line)] px-4 py-2.5 sm:px-5">
          <SidebarToggle onClick={() => setDrawer(true)} label="Show transcripts" />
          <span className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-mono
                            text-[11px] ${cli
                              ? 'border-[var(--ok)]/40 text-[var(--ok)]'
                              : 'border-[var(--bad)]/40 text-[var(--bad)]'}`}>
            {cli ? 'Claude CLI ready' : 'Claude CLI not found'}
          </span>

          {processes.length > 0 && (
            <button
              onClick={() => killProcesses(['app', 'terminal', 'ide'])}
              title={processes.map((p) => `${p.kind}: ${p.note}`).join('\n')}
              className="hidden rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                         px-2.5 py-1.5 text-[11.5px] text-[var(--muted)] hover:text-[var(--bad)] md:block"
            >
              Stop all Claude processes ({processes.length})
            </button>
          )}

          <div className="ml-auto flex items-center gap-2.5">
            {settings && (
              <span className="hidden font-mono text-[10.5px] text-[var(--faint)] lg:inline"
                    title={`Documents are written to ${settings.outputDir}`}>
                max {settings.maxTurns || '∞'} turns
              </span>
            )}
            <button onClick={newChat}
                    className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)]
                               px-3 py-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--text)]">
              New chat
            </button>
          </div>
        </header>

        <div ref={thread} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
          {turns.length === 0 && !runId && (
            <div className="mx-auto max-w-[620px] rounded-xl border border-[var(--line)]
                            bg-[var(--surface-2)] p-4 text-[12.5px] leading-relaxed
                            text-[var(--muted)]">
              <p className="mb-2">
                Select transcripts on the left, then either pick a skill with <strong>+</strong> —
                MOM, WSR, MSR — or just ask a question about them.
              </p>
              <p>
                Documents are written to your output folder. A covering email comes back here
                as a copyable box rather than a file.
              </p>
            </div>
          )}

          {turns.map((t) => t.role === 'system' ? (
            <div key={t.id} className="mx-auto max-w-[620px] rounded-xl border border-[var(--line)]
                                       bg-[var(--surface-2)] p-3 text-[12px] text-[var(--muted)]">
              New session. Earlier messages stay on screen for reference, but Claude no longer
              has them in context — so the next question starts cheap.
            </div>
          ) : (
            <div key={t.id} className={`flex gap-2.5 ${t.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg
                               text-[10px] font-semibold
                               ${t.role === 'user' ? 'bg-[var(--surface-3)] text-[var(--muted)]'
                                                   : 'bg-[var(--accent)] text-white'}`}>
                {t.role === 'user' ? 'You' : 'AI'}
              </div>
              <div className="min-w-0 max-w-[88%] sm:max-w-[76%] rounded-[12px] border border-[var(--line)]
                              bg-[var(--surface-2)] px-3.5 py-2.5">
                {t.skill && <div className="mb-1.5"><Pill tone="accent">{t.skill.label}</Pill></div>}
                {t.role === 'user'
                  ? <Markdown source={t.text || `_${t.skill?.label || ''}_`} />
                  : <Reply text={t.text} />}
                {(t.errors || []).map((e, i) => (
                  <p key={i} className="text-[12px] text-[var(--bad)]">{e}</p>
                ))}
                {t.cancelled && <p className="text-[12px] text-[var(--warn)]">Cancelled.</p>}
                {(t.files || []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {t.files.map((f) => <Pill key={f.path}>{stripName(f.name)}</Pill>)}
                  </div>
                )}
                {(t.documents || []).map((d) => <DocCard key={d.path} file={d} />)}
                {(t.cost != null || t.turns) && (
                  <div className="mt-1.5 font-mono text-[10px] text-[var(--faint)]">{runMeta(t)}</div>
                )}
              </div>
            </div>
          ))}

          {runId && (
            <div className="flex gap-2.5">
              <div className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg
                              bg-[var(--accent)] text-[10px] font-semibold text-white">AI</div>
              <div className="min-w-0 max-w-[88%] sm:max-w-[76%] rounded-[12px] border border-[var(--line)]
                              bg-[var(--surface-2)] px-3.5 py-2.5">
                {run.status === 'running' && (
                  <RunStatus phase={run.phase} tool={run.tool} trace={run.trace} />
                )}
                {run.text && <div className="mt-3"><Reply text={run.text} /></div>}
                {run.errors.map((e, i) => (
                  <p key={i} className="mt-2 text-[12px] text-[var(--bad)]">{e}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        <Composer
          placeholder={selected.size
            ? 'Ask Claude about the selected transcripts, or pick a skill with +'
            : 'Ask anything — a skill and files are optional'}
          skills={skills}
          skill={skill}
          onSkillChange={setSkill}
          files={selectedMeta}
          onRemoveFile={(f) => toggleFile(f.path)}
          running={Boolean(runId)}
          onSend={send}
          onStop={run.cancel}
          note={sessionResetPending ? 'new session — earlier context dropped' : null}
        />
    </SidebarLayout>
  );
}
