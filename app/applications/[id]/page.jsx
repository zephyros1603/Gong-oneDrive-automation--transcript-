'use client';

/**
 * One application: configure it, hold its credentials, use it.
 *
 * Tabs rather than one long form, because the four concerns have different
 * audiences and different risk. Credentials is the only one that can lock you
 * out, and Data is where the application is actually *used* — for Gong that is
 * the transcript pull, which used to be a top-level page.
 */

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';
import {
  ArrowLeft, CheckCircle, XCircle, WarningCircle, FloppyDisk, Plugs,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import GongPull from '@/components/GongPull.jsx';
import SkillManager from '@/components/SkillManager.jsx';
import BuiltinData from '@/components/BuiltinData.jsx';
import CxPortalData from '@/components/CxPortalData.jsx';
import { Empty } from '@/components/common.jsx';
import { cn } from '@/lib/utils';

function Field({ field, value, onChange }) {
  const common = 'rounded-xl';
  return (
    <div className="mb-4">
      <Label className="mb-1.5 block text-[12.5px] font-medium">{field.label}</Label>
      {field.type === 'select' ? (
        <select
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="h-9 w-full rounded-xl border border-input bg-transparent px-3 text-[13px]
                     outline-none focus-visible:border-ring"
        >
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.multiline ? (
        <textarea
          rows={3}
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="w-full resize-y rounded-xl border border-input bg-transparent px-3 py-2
                     font-mono text-[11px] outline-none focus-visible:border-ring"
        />
      ) : (
        <Input
          type={field.type === 'number' ? 'number' : 'text'}
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={common}
        />
      )}
      {field.hint && (
        <p className="mt-1 text-[11.5px] text-muted-foreground">{field.hint}</p>
      )}
    </div>
  );
}

function AppDetail({ id }) {
  const params = useSearchParams();
  const router = useRouter();
  const [d, setD] = useState(null);
  const [values, setValues] = useState({});
  const [tab, setTab] = useState('Configuration');
  const [section, setSection] = useState(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/connectors/${id}`).then((x) => x.json());
    if (r.error) { setD({ error: r.error }); return; }
    setD(r);
    setValues(r.values || {});
    setSection(r.connector.configSchema[0]?.section || null);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = params.get('tab');
    if (!t || !d) return;
    const tabs = d.connector.tabs || ['Configuration'];
    setTab(tabs.find((x) => x.toLowerCase() === t.toLowerCase()) || tabs[0]);
  }, [params, d]);

  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  const save = async () => {
    const r = await fetch(`/api/connectors/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', values }),
    }).then((x) => x.json());
    if (!r.error) { setSaved(true); setTimeout(() => setSaved(false), 2500); load(); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await fetch(`/api/connectors/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'test', values }),
      }).then((x) => x.json());
      setResult(r);
    } finally { setTesting(false); }
  };

  if (!d) {
    return (
      <div className="mx-auto max-w-[1200px] space-y-4 p-6">
        <Skeleton className="h-12 w-[280px] rounded-xl" />
        <Skeleton className="h-9 w-full max-w-[420px] rounded-xl" />
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
    );
  }
  if (d.error) return <Empty>{d.error}</Empty>;

  const c = d.connector;
  const tabs = c.tabs || ['Configuration'];
  const sections = [...new Set(c.configSchema.map((f) => f.section))];
  const fields = c.configSchema.filter((f) => f.section === section);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1200px] p-4 sm:p-6">

        {/* ---- header ----------------------------------------------------- */}
        <div className="mb-5 flex items-center gap-3">
          <Link href="/applications" className="no-underline">
            <Button variant="outline" size="icon" className="rounded-xl" aria-label="Back">
              <ArrowLeft size={16} />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold tracking-tight">{c.name}</h1>
            <p className="truncate text-[12px] text-muted-foreground">{c.vendor} · {c.kind}</p>
          </div>
          <div className="ml-auto flex flex-none items-center gap-2">
            {saved && <span className="text-[12px] text-ok">Saved.</span>}
            {d.status.connected
              ? <Badge className="gap-1 rounded-lg border-transparent bg-ok/12 text-ok">
                  <CheckCircle size={12} weight="fill" /> Connected</Badge>
              : <Badge className="gap-1 rounded-lg border-transparent bg-warn/12 text-warn">
                  <WarningCircle size={12} weight="fill" /> Needs attention</Badge>}
            <Button onClick={save} className="rounded-xl shadow-sm">
              <FloppyDisk size={15} weight="duotone" /> Save changes
            </Button>
          </div>
        </div>

        {/* ---- tabs ------------------------------------------------------- */}
        <div className="mb-5 flex gap-1 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); router.replace(`/applications/${id}?tab=${t.toLowerCase()}`); }}
              className={cn(
                '-mb-px border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors',
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div key={tab} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
          {/* ---- configuration -------------------------------------------- */}
          {tab === 'Configuration' && (
            <div className="grid gap-4 lg:grid-cols-[180px_1fr]">
              <nav className="flex gap-1 lg:flex-col">
                {sections.map((s) => (
                  <button key={s} onClick={() => setSection(s)}
                          className={cn('rounded-xl px-3 py-2 text-left text-[12.5px] font-medium transition-colors',
                            section === s ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
                    {s}
                  </button>
                ))}
              </nav>

              <Card className="rounded-2xl">
                <CardContent className="p-5">
                  <h2 className="mb-4 text-[14px] font-semibold">{section}</h2>
                  {fields.length === 0
                    ? <p className="text-[12.5px] text-muted-foreground">Nothing to configure here.</p>
                    : fields.map((f) => (
                        <Field key={f.key} field={f} value={values[f.key]} onChange={set} />
                      ))}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ---- credentials ---------------------------------------------- */}
          {tab === 'Credentials' && (
            <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
              <Card className="rounded-2xl">
                <CardContent className="p-5">
                  <h2 className="mb-4 text-[14px] font-semibold">Authentication</h2>
                  {c.credentialSchema.length === 0 ? (
                    <p className="text-[12.5px] text-muted-foreground">
                      This application authenticates through the local CLI. There is nothing
                      to store here.
                    </p>
                  ) : c.credentialSchema.map((f) => (
                    <Field key={f.key} field={f} value={values[f.key]} onChange={set} />
                  ))}

                  <div className="mt-4 flex items-center gap-2">
                    <Button variant="outline" onClick={test} disabled={testing} className="rounded-xl">
                      {testing ? 'Testing…' : 'Test connection'}
                    </Button>
                    {/* A test never writes — that is why the cookie intake can
                        verify before it replaces a working credential. */}
                    <span className="text-[11.5px] text-muted-foreground">
                      Testing does not save.
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl">
                <CardContent className="p-5">
                  <h3 className="mb-3 text-[13px] font-semibold">Result</h3>
                  {!result && (
                    <p className="text-[12px] text-muted-foreground">Nothing tested yet.</p>
                  )}
                  {result?.checks?.map((ck) => (
                    <div key={ck.step} className="mb-2 flex items-start gap-2 text-[12px]">
                      {ck.ok
                        ? <CheckCircle size={14} weight="fill" className="mt-0.5 flex-none text-ok" />
                        : <XCircle size={14} weight="fill" className="mt-0.5 flex-none text-bad" />}
                      <span className="min-w-0">
                        <span className="block font-mono text-[10.5px] text-muted-foreground">{ck.step}</span>
                        <span className="block text-muted-foreground">{ck.detail}</span>
                      </span>
                    </div>
                  ))}
                  {result?.cookie?.cellExpires && (
                    <p className="mt-3 border-t border-border pt-3 font-mono text-[10.5px] text-muted-foreground">
                      expires {new Date(result.cookie.cellExpires).toLocaleString()}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ---- data ------------------------------------------------------ */}
          {tab === 'Data' && (
            c.dataTab?.kind === 'pull'
              ? <GongPull />
              : c.dataTab?.kind === 'cxportal'
              ? <CxPortalData />
              : ['projects', 'library', 'graph', 'automation'].includes(c.dataTab?.kind)
              ? <BuiltinData kind={c.dataTab.kind} />
              : (
                <Card className="rounded-2xl">
                  <CardContent className="grid place-items-center p-12 text-center">
                    <div>
                      <Plugs size={24} weight="duotone" className="mx-auto mb-3 text-muted-foreground" />
                      <p className="text-[13px] text-muted-foreground">
                        This application does not expose data of its own.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )
          )}

          {/* ---- skills ----------------------------------------------------- */}
          {tab === 'Skills' && <SkillManager />}

          {/* ---- schema ----------------------------------------------------- */}
          {tab === 'Schema' && (
            <Card className="rounded-2xl">
              <CardContent className="p-5">
                <h2 className="mb-3 text-[14px] font-semibold">Capabilities</h2>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {c.capabilities.map((cap) => (
                    <Badge key={cap} variant="secondary" className="rounded-lg font-mono text-[11px]">
                      {cap}
                    </Badge>
                  ))}
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  Capabilities are what the rest of Warp reads to decide what a workflow may use
                  as a source — disconnect this application and it stops being offered. Field-level
                  mapping arrives with the workflow engine.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ApplicationPage({ params }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-[420px] rounded-2xl" /></div>}>
      <AppDetail id={id} />
    </Suspense>
  );
}
