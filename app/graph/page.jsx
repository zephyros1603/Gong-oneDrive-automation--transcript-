'use client';

/**
 * Graph — saved views over client, project and activity.
 *
 * A graph is a *policy*, not a snapshot. The tree is computed on every read,
 * so a transcript pulled or a document generated a minute ago is already in
 * it; there is nothing to rebuild and nothing that can go stale.
 *
 * Policy is defaults plus per-client rules, which is what "policy at different
 * levels" means in practice: set the shape once, then narrow one customer.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CaretRight, FolderOpen, FileText, FileDoc, Lightning, TreeStructure,
  ArrowsOut, ArrowsIn, Plus, Trash, FloppyDisk, Funnel,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ago, plural } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const SOURCES = ['transcript', 'document', 'run'];
const WINDOWS = [['all', 'Everything'], ['last7d', 'Last 7 days'],
                 ['last30d', 'Last 30 days'], ['last90d', 'Last 90 days']];

const ICON = { root: TreeStructure, project: FolderOpen, group: FolderOpen,
               transcript: FileText, document: FileDoc, run: Lightning };

function Node({ node, depth, open, toggle }) {
  const isOpen = open.has(node.id);
  const kids = node.children || [];
  const Icon = ICON[node.kind] || FileText;
  const href = node.kind === 'transcript' || node.kind === 'document'
    ? `/preview?path=${encodeURIComponent(node.id)}` : null;

  const row = (
    <span className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5',
            (kids.length || href) && 'hover:bg-muted')}
          style={{ paddingLeft: depth * 18 + 8 }}>
      {kids.length > 0
        ? <CaretRight size={12} weight="bold"
            className={cn('flex-none text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
        : <span className="w-3 flex-none" />}
      <Icon size={14} weight="duotone"
            className={cn('flex-none', node.kind === 'project' ? 'text-primary' : 'text-muted-foreground')} />
      <span className={cn('truncate text-[12px]', node.kind === 'project' && 'font-medium')}>
        {node.name}
      </span>
      {node.counts && (
        <span className="ml-1 flex-none font-mono text-[10px] text-muted-foreground">
          {node.counts.transcripts}t · {node.counts.documents}d · {node.counts.runs}r
        </span>
      )}
      {node.rule && (
        <Badge variant="secondary" className="ml-1 flex-none rounded text-[9.5px]">
          <Funnel size={9} weight="fill" /> policy
        </Badge>
      )}
      {node.at && (
        <span className="ml-auto flex-none font-mono text-[10px] text-muted-foreground">
          {ago(node.at)}
        </span>
      )}
    </span>
  );

  return (
    <div>
      {href
        ? <Link href={href} className="block no-underline">{row}</Link>
        : <button onClick={() => toggle(node.id)} className="block w-full text-left">{row}</button>}
      {isOpen && kids.map((k) => (
        <Node key={k.id} node={k} depth={depth + 1} open={open} toggle={toggle} />
      ))}
    </div>
  );
}

export default function GraphPage() {
  const [graphs, setGraphs] = useState(null);
  const [id, setId] = useState(null);
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(new Set(['root']));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/graphs').then((r) => r.json()).then((g) => {
      setGraphs(g.graphs || []);
      setId((cur) => cur || g.graphs?.[0]?.id || null);
    }).catch(() => setGraphs([]));
  }, []);

  const load = useCallback(async (gid) => {
    if (!gid) return;
    const r = await fetch(`/api/graphs/${gid}`).then((x) => x.json());
    setD(r);
    setDraft(r.graph);
    setOpen(new Set(['root', ...(r.tree?.children || []).slice(0, 4).map((c) => c.id)]));
  }, []);

  useEffect(() => { load(id); }, [id, load]);

  const toggle = useCallback((nid) => setOpen((cur) => {
    const n = new Set(cur);
    n.has(nid) ? n.delete(nid) : n.add(nid);
    return n;
  }), []);

  const collect = (n, acc = []) => {
    if (n.children?.length) { acc.push(n.id); n.children.forEach((c) => collect(c, acc)); }
    return acc;
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`/api/graphs/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const list = await fetch('/api/graphs').then((r) => r.json());
      setGraphs(list.graphs || []);
      await load(id);
      setEditing(false);
    } finally { setSaving(false); }
  };

  const create = async () => {
    const g = await fetch('/api/graphs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New graph', policy: d?.graph?.policy }),
    }).then((r) => r.json());
    const list = await fetch('/api/graphs').then((r) => r.json());
    setGraphs(list.graphs || []);
    setId(g.graph.id);
    setEditing(true);
  };

  const remove = async () => {
    const r = await fetch(`/api/graphs/${id}`, { method: 'DELETE' }).then((x) => x.json());
    if (r.error) { alert(r.error); return; }
    const list = await fetch('/api/graphs').then((x) => x.json());
    setGraphs(list.graphs || []);
    setId(list.graphs?.[0]?.id || null);
  };

  const setDefaults = (patch) =>
    setDraft((g) => ({ ...g, policy: { ...g.policy, defaults: { ...g.policy.defaults, ...patch } } }));

  const setRule = (projectId, patch) => setDraft((g) => {
    const rules = [...(g.policy.rules || [])];
    const i = rules.findIndex((r) => r.projectId === projectId);
    if (patch === null) { if (i !== -1) rules.splice(i, 1); }
    else if (i === -1) rules.push({ projectId, ...g.policy.defaults, ...patch });
    else rules[i] = { ...rules[i], ...patch };
    return { ...g, policy: { ...g.policy, rules } };
  });

  if (!graphs || !d) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-3 p-5 sm:p-7">
        <Skeleton className="h-8 w-[200px] rounded-lg" />
        <Skeleton className="h-[440px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] p-5 sm:p-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <select
              value={id || ''}
              onChange={(e) => { setId(e.target.value); setEditing(false); }}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-[13px]
                         font-medium outline-none focus-visible:border-ring"
            >
              {graphs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <span className="truncate text-[11.5px] text-muted-foreground">
              {plural(d.totals.projects, 'customer')} · {plural(d.totals.transcripts, 'transcript')}
              {' · '}{plural(d.totals.documents, 'document')} · {plural(d.totals.runs, 'run')}
            </span>
          </div>

          <div className="flex flex-none gap-1.5">
            <Button variant="outline" size="sm" className="rounded-lg" onClick={create}>
              <Plus size={13} weight="bold" /> New
            </Button>
            <Button variant={editing ? 'default' : 'outline'} size="sm" className="rounded-lg"
                    onClick={() => setEditing((e) => !e)}>
              <Funnel size={13} weight="duotone" /> Policy
            </Button>
            <Button variant="outline" size="sm" className="rounded-lg"
                    onClick={() => setOpen(new Set(collect(d.tree)))}>
              <ArrowsOut size={13} weight="duotone" />
            </Button>
            <Button variant="outline" size="sm" className="rounded-lg"
                    onClick={() => setOpen(new Set(['root']))}>
              <ArrowsIn size={13} weight="duotone" />
            </Button>
          </div>
        </div>

        {/* ---- policy editor --------------------------------------------- */}
        {editing && draft && (
          <Card className="animate-in fade-in slide-in-from-top-1 mb-3.5 rounded-2xl duration-200">
            <CardContent className="p-5">
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block text-[12px] font-medium">Name</Label>
                  <Input value={draft.name} className="rounded-xl"
                         onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </div>
                <div>
                  <Label className="mb-1.5 block text-[12px] font-medium">Description</Label>
                  <Input value={draft.description} className="rounded-xl"
                         onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </div>
              </div>

              <h3 className="mb-2 text-[12.5px] font-semibold">Applies to every customer</h3>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {SOURCES.map((src) => {
                  const on = draft.policy.defaults.sources.includes(src);
                  return (
                    <button key={src}
                      onClick={() => setDefaults({
                        sources: on
                          ? draft.policy.defaults.sources.filter((x) => x !== src)
                          : [...draft.policy.defaults.sources, src],
                      })}
                      className={cn('rounded-lg border px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors',
                        on ? 'border-transparent bg-primary text-primary-foreground'
                           : 'border-border text-muted-foreground')}>
                      {src}s
                    </button>
                  );
                })}
                <select value={draft.policy.defaults.window}
                        onChange={(e) => setDefaults({ window: e.target.value })}
                        className="ml-1 h-7 rounded-lg border border-input bg-transparent px-2 text-[11.5px]">
                  {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>

              <h3 className="mb-2 text-[12.5px] font-semibold">Per customer</h3>
              <p className="mb-2 text-[11px] text-muted-foreground">
                A rule narrows one customer. Anything without a rule uses the defaults above.
              </p>
              <div className="mb-4 max-h-[240px] space-y-1.5 overflow-y-auto">
                {(d.projects || []).map((p) => {
                  const rule = (draft.policy.rules || []).find((r) => r.projectId === p.id);
                  const excluded = (draft.policy.exclude || []).includes(p.id);
                  return (
                    <div key={p.id}
                         className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-2">
                      <span className={cn('min-w-0 flex-1 truncate text-[12px]', excluded && 'line-through opacity-50')}>
                        {p.name}
                      </span>

                      {!excluded && SOURCES.map((src) => {
                        const on = (rule?.sources || draft.policy.defaults.sources).includes(src);
                        return (
                          <button key={src} title={src}
                            onClick={() => {
                              const cur = rule?.sources || draft.policy.defaults.sources;
                              setRule(p.id, { sources: on ? cur.filter((x) => x !== src) : [...cur, src] });
                            }}
                            className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
                              on ? 'border-transparent bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
                            {src[0]}
                          </button>
                        );
                      })}

                      {!excluded && (
                        <select value={rule?.window || draft.policy.defaults.window}
                                onChange={(e) => setRule(p.id, { window: e.target.value })}
                                className="h-6 rounded border border-input bg-transparent px-1 text-[10.5px]">
                          {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      )}

                      <button
                        onClick={() => setDraft((g) => ({
                          ...g,
                          policy: {
                            ...g.policy,
                            exclude: excluded
                              ? g.policy.exclude.filter((x) => x !== p.id)
                              : [...(g.policy.exclude || []), p.id],
                          },
                        }))}
                        className="text-[10.5px] text-muted-foreground hover:text-bad">
                        {excluded ? 'include' : 'exclude'}
                      </button>

                      {rule && (
                        <button onClick={() => setRule(p.id, null)}
                                className="text-[10.5px] text-muted-foreground hover:text-foreground">
                          reset
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" onClick={save} disabled={saving} className="rounded-lg">
                  <FloppyDisk size={13} weight="duotone" /> {saving ? 'Saving…' : 'Save policy'}
                </Button>
                {!draft.builtin && (
                  <Button variant="ghost" size="sm" onClick={remove}
                          className="rounded-lg text-bad hover:text-bad">
                    <Trash size={13} weight="duotone" /> Delete
                  </Button>
                )}
                {draft.builtin && (
                  <span className="text-[11px] text-muted-foreground">
                    The default graph cannot be deleted.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="rounded-2xl">
          <CardContent className="p-2">
            <Node node={d.tree} depth={0} open={open} toggle={toggle} />
          </CardContent>
        </Card>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Computed on read — a transcript pulled or a document generated a moment ago is
          already here. Issues and tickets join once a project-management application is
          connected.
        </p>
      </div>
    </div>
  );
}
