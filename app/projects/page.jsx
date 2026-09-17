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

import { useCallback, useEffect, useRef, useState } from 'react';
import Composer, { RunStatus } from '@/components/Composer.jsx';
import {
  Markdown, EmailBox, DocCard, Empty, Pill, useEmailSplit,
} from '@/components/common.jsx';
import SidebarLayout, { SidebarToggle } from '@/components/SidebarLayout.jsx';
import { useRunStream } from '@/lib/useRunStream.js';
import { runMeta, stripName, plural } from '@/lib/format.js';

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

  // Keep the live dots honest while nothing is streaming here.
  useEffect(() => {
    if (runId) return;
    const t = setInterval(loadList, 5000);
    return () => clearInterval(t);
  }, [runId, loadList]);

  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [project?.messages?.length, run.text, run.trace.length]);

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
              No projects yet. Organize transcripts by customer, then press Sync.
            </div>
          )}
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => openProject(p.id)}
              className={`flex w-full items-center gap-2 border-l-2 px-3 py-2.5 text-left
                transition-colors ${project?.id === p.id
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
                  {plural(project.transcriptCount, 'transcript')}
                  {' · '}
                  {project.sessionId ? 'conversation in context' : 'fresh conversation'}
                </div>
              </div>
              <button onClick={newChat}
                      className="ml-auto flex-none rounded-lg border border-[var(--line)]
                                 bg-[var(--surface-2)] px-3 py-1.5 text-[12px]
                                 text-[var(--text-muted)] hover:text-[var(--text)]">
                New chat
              </button>
            </header>

            <div ref={thread} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
              {messages.length === 0 && !runId && (
                <div className="mx-auto max-w-[620px] rounded-xl border border-[var(--line)]
                                bg-[var(--surface-2)] p-4 text-[12.5px] leading-relaxed
                                text-[var(--text-muted)]">
                  Ask anything about this customer. Their {plural(project.transcriptCount, 'transcript')}
                  {' '}are already in scope — no need to attach files.
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
          </>
        )}
    </SidebarLayout>
  );
}
