'use client';

/**
 * app/engine/page.jsx — write your own automation, in real JavaScript.
 *
 * A workflow is a form: skill, instruction, scope, schedule — declarative
 * enough to render, and that is exactly its limit. Some automations need an
 * actual `if`, an actual loop over customers, a call to one connector that
 * feeds a decision about another. That is what a script is for.
 *
 * A script runs inside core/engine/sandbox.js — Node's `vm` module, not the
 * real runtime. It sees one global, `warp` (core/engine/api.js), which is
 * every capability we already trust a route handler to use. It never sees
 * `require`, `fs`, or `process`. That is a real but not absolute boundary —
 * good enough for your own scripts on your own server, not a defence against
 * someone else's code.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Play, FloppyDisk, Trash, Code, CheckCircle, XCircle, Clock,
  CaretRight, BookOpen,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { readEvents } from '@/lib/useRunStream.js';
import { ago } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const STARTER = `// warp.projects, warp.gong, warp.cxp, warp.correlate, warp.context,
// warp.claude, warp.approvals, warp.notify, warp.window are all you get —
// no require(), no fs, no process. console.log() shows up in the run log.

const projects = warp.projects.list();
console.log(projects.length, 'customers');

return projects.map((p) => p.name);
`;

const API_REFERENCE = [
  ['warp.projects.list() / .get(id)', 'Every Warp customer, or one by id'],
  ['warp.gong.transcripts() / .read(path)', 'Files in the library; read one'],
  ['warp.cxp.projects(opts) / .myProjects(opts) / .projectDetail(id) / .action(name, params)', 'The CX Portal, raw'],
  ['warp.correlate.customers(gongNames, cxNames)', 'Match two name lists — exact/strong/weak'],
  ['warp.context.digest(projectId) / .status()', 'Build or read a customer digest'],
  ['await warp.claude.run({ instruction, files, skill })', 'One Claude call, returns its reply text'],
  ['warp.approvals.propose({ title, path|body }) / .pending()', 'Queue something for review — never delivers directly'],
  ['warp.notify.say(title, body)', 'Put something in the bell, right now'],
  ['warp.window.resolve(winSpec)', 'Day/Week/Month → real dates'],
];

export default function EnginePage() {
  const [scripts, setScripts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [showRef, setShowRef] = useState(false);
  const ctrlRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/scripts').then((x) => x.json());
      setScripts(r.scripts || []);
    } catch { setScripts([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('new') === '1') {
      setDraft({ name: 'New script', description: '', code: STARTER });
      setSelected(null);
      setDirty(true);
    }
  }, []);

  const open = (s) => { setSelected(s); setDraft(s); setDirty(false); setLog([]); };

  const create = () => {
    setDraft({ name: 'New script', description: '', code: STARTER });
    setSelected(null);
    setDirty(true);
    setLog([]);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/scripts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selected?.id, ...draft }),
      }).then((x) => x.json());
      setSelected(r.script);
      setDraft(r.script);
      setDirty(false);
      await load();
    } finally { setBusy(false); }
  };

  const remove = async (s) => {
    await fetch(`/api/scripts/${s.id}`, { method: 'DELETE' });
    if (selected?.id === s.id) { setSelected(null); setDraft(null); }
    await load();
  };

  const run = async () => {
    if (!selected) return;
    setRunning(true);
    setLog([]);
    try {
      const r = await fetch(`/api/scripts/${selected.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      }).then((x) => x.json());
      if (r.error) { setLog([{ type: 'error', message: r.error }]); setRunning(false); return; }

      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const res = await fetch(`/api/runs/${r.runId}/stream`, { signal: ctrl.signal });
      for await (const e of readEvents(res.body, ctrl.signal)) {
        setLog((l) => [...l, e]);
        if (e.type === 'closed-buffer') break;
      }
    } catch (err) {
      setLog((l) => [...l, { type: 'error', message: err.message }]);
    } finally {
      setRunning(false);
      load();
    }
  };

  if (!scripts) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-3 p-5 sm:p-7">
        <Skeleton className="h-8 w-[220px] rounded-lg" />
        <Skeleton className="h-[420px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0">
      <aside className="w-[260px] flex-none overflow-y-auto border-r border-border bg-card p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-[13px] font-semibold">Scripts</h1>
          <Button size="sm" variant="outline" onClick={create} className="rounded-lg" title="New script">
            <Plus size={13} weight="bold" />
          </Button>
        </div>
        {scripts.length === 0 && (
          <p className="px-1 py-6 text-[11.5px] leading-relaxed text-muted-foreground">
            Nothing here yet. A script is real JavaScript with a curated API —
            useful when a workflow's form cannot say what you need.
          </p>
        )}
        <div className="space-y-1">
          {scripts.map((s) => (
            <button key={s.id} onClick={() => open(s)}
                    className={cn('flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors',
                                  selected?.id === s.id ? 'bg-primary/10' : 'hover:bg-muted')}>
              {s.lastStatus === 'ok'
                ? <CheckCircle size={13} weight="fill" className="mt-0.5 flex-none text-ok" />
                : s.lastStatus === 'error'
                ? <XCircle size={13} weight="fill" className="mt-0.5 flex-none text-bad" />
                : <Clock size={13} weight="duotone" className="mt-0.5 flex-none text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{s.name}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground">
                  {s.lastRunAt ? `ran ${ago(s.lastRunAt)}` : 'never run'}
                </span>
              </span>
            </button>
          ))}
        </div>

        <button onClick={() => setShowRef((v) => !v)}
                className="mt-4 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px]
                           text-muted-foreground hover:bg-muted">
          <BookOpen size={12} weight="duotone" />
          API reference
          <CaretRight size={10} className={cn('ml-auto transition-transform', showRef && 'rotate-90')} />
        </button>
        {showRef && (
          <div className="mt-1 space-y-2 px-2 pb-2">
            {API_REFERENCE.map(([sig, hint]) => (
              <div key={sig}>
                <code className="block break-all font-mono text-[10px] text-primary">{sig}</code>
                <span className="block text-[10px] text-muted-foreground">{hint}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        {!draft ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div>
              <Code size={28} weight="duotone" className="mx-auto mb-3 text-muted-foreground" />
              <p className="text-[12.5px] text-muted-foreground">
                Pick a script, or create one.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3.5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Input value={draft.name}
                     onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setDirty(true); }}
                     className="h-8 max-w-[280px] rounded-lg text-[13px] font-medium" />
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" onClick={run} disabled={!selected || running || dirty} className="rounded-lg"
                        title={dirty ? 'Save before running' : ''}>
                  <Play size={13} weight="fill" /> {running ? 'Running…' : 'Run'}
                </Button>
                <Button size="sm" variant="outline" onClick={save} disabled={busy || !dirty} className="rounded-lg">
                  <FloppyDisk size={13} weight="bold" /> Save
                </Button>
                {selected && (
                  <Button size="sm" variant="outline" onClick={() => remove(selected)}
                          className="rounded-lg text-bad hover:text-bad">
                    <Trash size={13} weight="bold" />
                  </Button>
                )}
              </div>
            </div>

            <Input value={draft.description}
                   onChange={(e) => { setDraft({ ...draft, description: e.target.value }); setDirty(true); }}
                   placeholder="What this script does, in one line"
                   className="h-8 rounded-lg text-[12px]" />

            <div>
              <Label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
                Code — an async function body. `warp` is your only import.
              </Label>
              <textarea
                value={draft.code}
                onChange={(e) => { setDraft({ ...draft, code: e.target.value }); setDirty(true); }}
                spellCheck={false}
                rows={16}
                className="w-full resize-y rounded-xl border border-input bg-card px-3 py-2.5 font-mono text-[12px]
                           leading-relaxed outline-none focus-visible:border-ring"
              />
            </div>

            <Card className="rounded-2xl">
              <CardContent className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-[12px] font-semibold">Run log</h2>
                  {log.length > 0 && <Badge variant="secondary" className="rounded-md text-[10px]">{log.length}</Badge>}
                </div>
                {log.length === 0 ? (
                  <p className="py-6 text-center text-[11.5px] text-muted-foreground">
                    {running ? 'Starting…' : 'Nothing yet — Run to see it here, live.'}
                  </p>
                ) : (
                  <div className="max-h-[320px] space-y-1 overflow-y-auto font-mono text-[11px]">
                    {log.map((e, i) => <LogLine key={i} e={e} />)}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </section>
    </div>
  );
}

function LogLine({ e }) {
  if (e.type === 'call') {
    return <div className="text-muted-foreground">→ <span className="text-primary">{e.path}</span>({(e.args || []).join(', ')})</div>;
  }
  if (e.type === 'log') return <div>{e.message}</div>;
  if (e.type === 'error') return <div className="text-bad">! {e.message}</div>;
  if (e.type === 'result') {
    return (
      <div className="text-ok">
        ✓ result: <span className="break-all text-foreground">{JSON.stringify(e.value)}</span>
      </div>
    );
  }
  if (e.type === 'finished') {
    return <div className="text-muted-foreground">— finished ({e.status})</div>;
  }
  return null;
}
