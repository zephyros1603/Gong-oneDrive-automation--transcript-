'use client';

/**
 * Projects — one persistent chat per customer.
 *
 * The thing this page exists to do is survive: leaving it mid-run must not
 * cancel the run, and coming back must show everything that happened while
 * you were gone. Both fall out of runs being owned by the server —
 * `useRunStream` re-attaches and the server replays.
 *
 * The vanilla version rendered a message twice: once imperatively while it
 * streamed, and again from the stored copy on reload. Here `<Message>` renders
 * both, so a live reply and a reloaded one cannot drift apart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretRight, DotsThreeVertical, Trash, Copy } from '@phosphor-icons/react';
import { normalise } from '@/core/correlate.js';
import Composer, { RunStatus } from '@/components/Composer.jsx';
import {
  Markdown, EmailBox, DocCard, Empty, Pill, useEmailSplit,
} from '@/components/common.jsx';
import SidebarLayout, { SidebarToggle } from '@/components/SidebarLayout.jsx';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu.jsx';
import { useRunStream } from '@/lib/useRunStream.js';
import { runMeta, stripName, plural, ago } from '@/lib/format.js';
import { writeClipboard } from '@/lib/md.js';

const LAST_KEY = 'gong.lastProject';

function Message({ message }) {
  const { email, rest } = useEmailSplit(message.text);
  const mine = message.role === 'user';

  return (
    <div className={`flex gap-2.5 ${mine ? 'flex-row-reverse' : ''}`}>
      <div className={`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg
                       text-[10px] font-semibold
                       ${mine ? 'bg-[var(--surface-3)] text-[var(--text-muted)]'
                              : 'bg-[var(--brand)] text-white'}`}>
        {mine ? 'You' : 'AI'}
      </div>

      <div className={`min-w-0 max-w-[88%] sm:max-w-[76%] rounded-[12px] border border-[var(--line)]
                       bg-[var(--surface-2)] px-3.5 py-2.5`}>
        {message.skill && (
          <div className="mb-1.5">
            <Pill tone="accent">{message.skill.label}</Pill>
          </div>
        )}

        {rest?.trim() && <Markdown source={rest} />}
        {email && <EmailBox email={email} />}

        {message.cancelled && (
          <p className="text-[12px] text-[var(--warn)]">Cancelled.</p>
        )}
        {message.pending && !message.text && (
          <p className="text-[12px] text-[var(--faint)]">
            This reply belongs to a run that is no longer active.
          </p>
        )}

        {(message.files || []).length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {message.files.map((f) => (
              <Pill key={f.path}>{stripName(f.name)}</Pill>
            ))}
          </div>
        )}

        {(message.documents || []).map((d) => <DocCard key={d.path} file={d} />)}

        {(message.cost != null || message.turns) && (
          <div className="mt-1.5 font-mono text-[10px] text-[var(--faint)]">
            {runMeta(message)}
          </div>
        )}
      </div>
    </div>
  );
}

/** The streaming reply's body: the same split a stored message uses. */
function LiveText({ text }) {
  const { email, rest } = useEmailSplit(text);
  return (
    <>
      {rest?.trim() && <Markdown source={rest} />}
      {email && <EmailBox email={email} />}
    </>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState([]);
  const [active, setActive] = useState([]);
  const [project, setProject] = useState(null);
  const [skills, setSkills] = useState([]);
  const [skill, setSkill] = useState(null);
  const [runId, setRunId] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Which customer groups are collapsed in the sidebar. A customer with one
  // CX Portal project looks the same collapsed or not, so only multi-project
  // customers are worth the toggle — see the grouping below.
  const [collapsed, setCollapsed] = useState(new Set());
  const [showContext, setShowContext] = useState(false);
  const [contextText, setContextText] = useState(null);
  const thread = useRef(null);

  const run = useRunStream(runId, {
    onFinish: async () => {
      setRunId(null);
      if (project) await openProject(project.id, { keepRun: true });
      await loadList();
    },
  });

  const loadList = useCallback(async () => {
    try {
      const d = await fetch('/api/projects').then((r) => r.json());
      setProjects(d.projects || []);
      setActive(d.active || []);
      return d;
    } catch { return null; }
  }, []);

  const openProject = useCallback(async (id, { keepRun = false } = {}) => {
    const d = await fetch(`/api/projects/${id}`).then((r) => r.json());
    if (d.error) return;
    setProject(d.project);
    setDrawer(false);
    try { localStorage.setItem(LAST_KEY, id); } catch { /* private window */ }

    // Re-attach to whatever this project already has in flight. This is the
    // path that makes a tab switch invisible.
    if (!keepRun) setRunId(d.active?.[0]?.id || null);
  }, []);

  useEffect(() => {
    (async () => {
      const [d] = await Promise.all([
        loadList(),
        fetch('/api/skills').then((r) => r.json())
          .then((s) => setSkills((s.actions || []).map((a) => ({ ...a, id: a.id }))))
          .catch(() => {}),
      ]);
      let last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* ignore */ }
      const pick = (d?.projects || []).find((p) => p.id === last) || d?.projects?.[0];
      if (pick) openProject(pick.id);
    })();
  }, [loadList, openProject]);

  // Always the currently open project's id, for the polling effect below —
  // a ref rather than reading `project` from closure, since that effect only
  // re-runs on `runId` changes and would otherwise keep polling whichever
  // project was open when the interval was created, even after switching.
  const openProjectId = useRef(null);
  useEffect(() => { openProjectId.current = project?.id || null; }, [project?.id]);

  // Keep the live dots honest while nothing is streaming here. Also re-reads
  // the open project's context — a scheduled update run writes context.md
  // from outside this tab, and this is what makes that show up without a
  // manual reload. Only the summary fields are merged in (not messages), so
  // an in-progress scroll position or draft is never disturbed by the poll.
  useEffect(() => {
    if (runId) return;
    const t = setInterval(async () => {
      await loadList();
      const id = openProjectId.current;
      if (!id) return;
      try {
        const d = await fetch(`/api/projects/${id}`).then((r) => r.json());
        if (d.error) return;
        setProject((now) => now && now.id === id
          ? { ...now, context: d.project.context, transcriptCount: d.project.transcriptCount }
          : now);
      } catch { /* next tick will retry */ }
    }, 5000);
    return () => clearInterval(t);
  }, [runId, loadList]);

  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [project?.messages?.length, run.text, run.trace.length]);

  // Closed and cleared on every project switch, so opening it on the next
  // project can never flash the previous one's content first.
  useEffect(() => { setShowContext(false); setContextText(null); }, [project?.id]);

  useEffect(() => {
    if (!showContext || !project?.context?.path || contextText !== null) return;
    fetch(`/api/file?path=${encodeURIComponent(project.context.path)}`)
      .then((r) => r.json())
      .then((f) => setContextText(f.error ? `_${f.error}._` : (f.content || '_Empty._')))
      .catch((e) => setContextText(`_Could not read this file: ${e.message}_`));
  }, [showContext, project?.context?.path, contextText]);

  const send = async ({ text, skill: picked }) => {
    if (!project) return;
    const body = {
      projectId: project.id,
      actionId: picked?.id || null,
      message: text,
    };
    const started = await fetch('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    if (started.error) { alert(started.error); return; }
    setSkill(null);
    await openProject(project.id, { keepRun: true });
    setRunId(started.runId);
  };

  const newChat = async () => {
    if (!project) return;
    await fetch(`/api/projects/${project.id}/reset-session`, { method: 'POST' });
    await openProject(project.id);
  };

  const [copiedId, setCopiedId] = useState(false);

  /**
   * The id an Engine script needs (`PROJECT_ID` / `ONLY_IDS` in
   * scripts/update-context.js and scripts/propose-note.js) — there's
   * nowhere else in the UI it's visible, so this is the one place to get it
   * without writing a throwaway `warp.projects.list()` script first.
   */
  const copyProjectId = async () => {
    if (!project) return;
    const ok = await writeClipboard(project.id);
    if (ok) { setCopiedId(true); setTimeout(() => setCopiedId(false), 1500); }
  };

  /**
   * Deletes the Warp project row, its messages, and its context-file link —
   * `projects.js`'s `deleteProject()`. Does not touch anything on disk (the
   * context.md, any transcripts) or the CX Portal project it was linked to;
   * only the local record goes away. If it was created from CX Portal, the
   * next creation run (`warp.projects.syncFromCxp()`) recreates it — that's
   * a fresh stub, not a restore, so this is only reversible in that limited
   * sense, not undoable outright. Confirmed with a native dialog since
   * there's no undo.
   */
  const deleteProjectNow = async () => {
    if (!project) return;
    if (!window.confirm(`Delete "${project.name}"? This removes it and its chat history from Warp — it does not delete anything in CX Portal or on disk.`)) {
      return;
    }
    await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
    setProject(null);
    await loadList();
  };

  const sync = async () => {
    setSyncing(true);
    await fetch('/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sync: true }),
    });
    await loadList();
    if (project) await openProject(project.id);
    setSyncing(false);
  };

  // The placeholder reply is rendered by the live stream, not from the store.
  const messages = (project?.messages || []).filter((m) => !(m.pending && m.runId === runId));
  const activeIds = new Set(active.map((a) => a.projectId));

  // Grouped by customer, not flat — a customer can have several CX Portal
  // projects (e.g. "Paycor/Entra ID" and "Paycor/Active Directory" are
  // distinct projects, and different customers routinely share a project
  // *name* since it names the integration, not the account), so a flat list
  // reads as unlabelled duplicates. Sorted by customer name, then project
  // name within it, for a stable order the CX Portal fetch order doesn't
  // guarantee.
  const groups = useMemo(() => {
    // Keyed by normalise() (core/correlate.js — the same punctuation/case
    // fold used everywhere else two systems' customer names have to line
    // up), not the raw string: "Hospitality America Inc" and "Hospitality
    // America, Inc." are the same customer with the same problem this
    // grouping exists to solve — Gong and the CX Portal spell a name
    // differently, and a project created from each side should not read as
    // two different customers.
    const byKey = new Map();
    for (const p of projects) {
      const raw = p.customer || p.name;
      const key = normalise(raw) || raw;
      if (!byKey.has(key)) byKey.set(key, { label: raw, cxpLabel: null, projects: [] });
      const g = byKey.get(key);
      // CX Portal is the source of truth for a project's existence now, so
      // its spelling of the name wins over whatever Gong happened to extract.
      if (p.cxpProjectId && !g.cxpLabel) g.cxpLabel = raw;
      g.projects.push(p);
    }
    return [...byKey.values()]
      .map((g) => ({
        customer: g.cxpLabel || g.label,
        projects: g.projects.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.customer.localeCompare(b.customer));
  }, [projects]);

  const toggleGroup = (customer) => setCollapsed((c) => {
    const n = new Set(c);
    n.has(customer) ? n.delete(customer) : n.add(customer);
    return n;
  });

  const sidebar = (
    <>
        <div className="flex flex-none items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--faint)]">
            Projects
          </span>
          <button onClick={sync} disabled={syncing}
                  className="rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-2 py-1
                             text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">
            {syncing ? '…' : 'Sync'}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {projects.length === 0 && (
            <div className="p-4 text-[12px] leading-relaxed text-[var(--faint)]">
              No projects yet. A project is created from a CX Portal project assigned to
              you — run the creation script from the Engine page to bring them in.
            </div>
          )}
          {groups.map(({ customer, projects: list }) => {
            const isOpen = !collapsed.has(customer);
            const multi = list.length > 1;
            return (
              <div key={customer}>
                <button
                  onClick={() => multi && toggleGroup(customer)}
                  className={`flex w-full items-center gap-1.5 px-3 py-2 text-left
                    ${multi ? 'cursor-pointer hover:bg-[var(--surface-2)]' : 'cursor-default'}`}
                >
                  {multi && (
                    <CaretRight size={10} weight="bold"
                                className={`flex-none text-[var(--faint)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                  )}
                  <span className={`min-w-0 flex-1 truncate text-[11px] font-semibold uppercase
                    tracking-wide text-[var(--faint)] ${multi ? '' : 'pl-[14px]'}`}>
                    {customer}
                  </span>
                  {multi && (
                    <span className="flex-none font-mono text-[10px] text-[var(--faint)]">{list.length}</span>
                  )}
                </button>

                {isOpen && list.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => openProject(p.id)}
                    className={`flex w-full items-center gap-2 border-l-2 py-2.5 pr-3 text-left
                      transition-colors ${multi ? 'pl-6' : 'pl-3'} ${project?.id === p.id
                        ? 'border-l-[var(--brand)] bg-[var(--brand)]/10'
                        : 'border-l-transparent hover:bg-[var(--surface-2)]'}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{p.name}</span>
                      <span className="block font-mono text-[10.5px] text-[var(--faint)]">
                        {plural(p.transcriptCount, 'transcript')} · {plural(p.messageCount, 'message')}
                      </span>
                    </span>
                    {activeIds.has(p.id) && (
                      <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-[var(--brand)]"
                            title="A run is in flight" />
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
    </>
  );

  return (
    <SidebarLayout sidebar={sidebar} open={drawer} onOpenChange={setDrawer}
                   storageKey="gong.projects.sidebar">
        {!project && (
          <div className="flex h-full flex-col">
            <header className="flex flex-none items-center gap-2.5 border-b border-[var(--line)] px-4 py-3 lg:hidden">
              <SidebarToggle onClick={() => setDrawer(true)} label="Show projects" />
              <span className="text-[13px] font-medium">Projects</span>
            </header>
            <Empty>Pick a customer to open their conversation.</Empty>
          </div>
        )}

        {project && (
          <>
            <header className="flex flex-none items-center gap-2.5 border-b
                               border-[var(--line)] px-4 py-3 sm:px-5">
              <SidebarToggle onClick={() => setDrawer(true)} label="Show projects" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[14px] font-semibold">{project.name}</h1>
                <div className="font-mono text-[10.5px] text-[var(--faint)]">
                  {project.context ? `context updated ${ago(project.context.addedAt)}` : 'no context yet'}
                  {' · '}
                  {project.sessionId ? 'conversation in context' : 'fresh conversation'}
                </div>
              </div>
              {project.context && (
                <button onClick={() => setShowContext((v) => !v)}
                        title="View this project's context.md"
                        className={`ml-auto flex-none rounded-lg border px-3 py-1.5 text-[12px] ${
                          showContext
                            ? 'border-[var(--brand)]/40 bg-[var(--brand)]/10 text-[var(--brand)]'
                            : 'border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}>
                  Context
                </button>
              )}

              <button onClick={newChat}
                      className={`flex-none rounded-lg border border-[var(--line)]
                                 bg-[var(--surface-2)] px-3 py-1.5 text-[12px]
                                 text-[var(--text-muted)] hover:text-[var(--text)]
                                 ${project.context ? '' : 'ml-auto'}`}>
                New chat
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button title="Project settings"
                          className="flex-none rounded-lg border border-[var(--line)]
                                     bg-[var(--surface-2)] p-1.5 text-[var(--text-muted)]
                                     hover:text-[var(--text)]">
                    <DotsThreeVertical size={15} weight="bold" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={(e) => { e.preventDefault(); copyProjectId(); }}>
                    <Copy size={13} weight="bold" />
                    {copiedId ? 'Copied!' : 'Copy project ID'}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={deleteProjectNow}>
                    <Trash size={13} weight="bold" />
                    Delete project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </header>

            <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
            <div ref={thread} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
              {messages.length === 0 && !runId && (
                <div className="mx-auto max-w-[620px] rounded-xl border border-[var(--line)]
                                bg-[var(--surface-2)] p-4 text-[12.5px] leading-relaxed
                                text-[var(--text-muted)]">
                  Ask anything about this customer. {project.context
                    ? 'Their context file — Gong calls and CX Portal state — is already in scope, no need to attach files.'
                    : 'No context file yet — the creation/update run builds one from CX Portal and Gong.'}
                </div>
              )}

              {messages.map((m) => <Message key={m.id} message={m} />)}

              {runId && (
                <div className="flex gap-2.5">
                  <div className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg
                                  bg-[var(--brand)] text-[10px] font-semibold text-white">AI</div>
                  <div className="min-w-0 max-w-[88%] sm:max-w-[76%] rounded-[12px] border border-[var(--line)]
                                  bg-[var(--surface-2)] px-3.5 py-2.5">
                    {run.status === 'running' && (
                      <RunStatus phase={run.phase} tool={run.tool} trace={run.trace} />
                    )}
                    {run.text && (
                      <div className={run.status === 'running' ? 'mt-3' : ''}>
                        <LiveText text={run.text} />
                      </div>
                    )}
                    {run.documents.map((d) => <DocCard key={d.path} file={d} />)}
                    {run.status !== 'running' && (run.cost != null || run.turns) && (
                      <div className="mt-1.5 font-mono text-[10px] text-[var(--faint)]">
                        {runMeta(run)}
                      </div>
                    )}
                    {run.errors.map((e, i) => (
                      <p key={i} className="mt-2 text-[12px] text-[var(--bad)]">{e}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <Composer
              placeholder="Ask anything about this customer — no skill or file needed"
              skills={skills}
              skill={skill}
              onSkillChange={setSkill}
              running={Boolean(runId)}
              onSend={send}
              onStop={run.cancel}
            />
            </div>

            {showContext && (
              <aside className="w-[380px] flex-none overflow-y-auto border-l
                                border-[var(--line)] bg-[var(--surface)] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-[12.5px] font-semibold">context.md</h2>
                    <p className="font-mono text-[10px] text-[var(--faint)]">
                      {project.context ? `updated ${ago(project.context.addedAt)}` : ''}
                    </p>
                  </div>
                  <button onClick={() => setShowContext(false)}
                          className="text-[var(--faint)] hover:text-[var(--text)]">
                    ✕
                  </button>
                </div>
                {contextText === null ? (
                  <div className="space-y-2">
                    <div className="h-3.5 w-full animate-pulse rounded bg-[var(--surface-2)]" />
                    <div className="h-3.5 w-4/5 animate-pulse rounded bg-[var(--surface-2)]" />
                    <div className="h-3.5 w-3/5 animate-pulse rounded bg-[var(--surface-2)]" />
                  </div>
                ) : (
                  <Markdown source={contextText} />
                )}
              </aside>
            )}
            </div>
          </>
        )}
    </SidebarLayout>
  );
}
