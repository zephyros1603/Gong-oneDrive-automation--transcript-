'use client';

/**
 * components/SkillManager.jsx — installed skills, and adding one.
 *
 * This was a config sheet bolted onto the Workbench before the restructure.
 * It belongs here: a skill is how the Claude application is configured, in the
 * same way a cookie is how Gong is configured.
 */

import { useCallback, useEffect, useState } from 'react';
import { Sparkle, Plus, CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export default function SkillManager() {
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', instruction: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      setD(await fetch('/api/skills').then((r) => r.json()));
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/skills', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setAdding(false);
      setForm({ name: '', description: '', instruction: '', body: '' });
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!d) return <Skeleton className="h-[280px] rounded-2xl" />;

  return (
    <div className="space-y-3.5">
      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[13.5px] font-semibold">Installed skills</h2>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Read from <code className="font-mono">~/.claude/skills</code>. A skill is what
                turns a transcript into a document in your house style.
              </p>
            </div>
            <Button size="sm" onClick={() => setAdding((a) => !a)} className="rounded-lg">
              {adding ? <><X size={13} /> Cancel</> : <><Plus size={13} weight="bold" /> Add skill</>}
            </Button>
          </div>

          {(d.skills || []).length === 0 && (
            <p className="py-6 text-center text-[12px] text-muted-foreground">
              No skills installed.
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {(d.skills || []).map((s) => (
              <div key={s.name}
                   className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-3">
                <Sparkle size={15} weight="duotone" className="mt-0.5 flex-none text-primary" />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11.5px] font-medium">{s.name}</span>
                  {s.description && (
                    <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                      {s.description}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {adding && (
        <Card className="animate-in fade-in slide-in-from-top-1 rounded-2xl duration-200">
          <CardContent className="p-5">
            <h3 className="mb-3 text-[13px] font-semibold">New skill</h3>
            {[
              ['name', 'Name', 'aquera-runbook — lowercase, dashes'],
              ['description', 'Description', 'When Claude should reach for it'],
              ['instruction', 'Default instruction', 'What the button asks it to do'],
            ].map(([k, label, hint]) => (
              <div key={k} className="mb-3">
                <Label className="mb-1.5 block text-[12px] font-medium">{label}</Label>
                <Input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                       placeholder={hint} className="rounded-xl" />
              </div>
            ))}
            <div className="mb-3">
              <Label className="mb-1.5 block text-[12px] font-medium">Skill body</Label>
              <textarea
                rows={8}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="The markdown that becomes SKILL.md"
                className="w-full resize-y rounded-xl border border-input bg-transparent px-3 py-2
                           font-mono text-[11px] outline-none focus-visible:border-ring"
              />
            </div>
            {err && <p className="mb-3 text-[12px] text-bad">{err}</p>}
            <Button onClick={add} disabled={busy || !form.name} className="rounded-lg">
              {busy ? 'Creating…' : 'Create skill'}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <h2 className="mb-3 text-[13.5px] font-semibold">Actions</h2>
          <p className="mb-3 text-[11.5px] text-muted-foreground">
            The buttons the Workbench offers. An action whose skill is missing still shows,
            but says so rather than failing at run time.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(d.actions || []).map((a) => (
              <div key={a.id}
                   className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3">
                {a.installed
                  ? <CheckCircle size={15} weight="fill" className="flex-none text-ok" />
                  : <WarningCircle size={15} weight="fill" className="flex-none text-warn" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{a.label}</span>
                  <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                    {a.skill}
                  </span>
                </span>
                {!a.installed && (
                  <Badge variant="secondary" className="rounded-md text-[10px]">blueprint</Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
