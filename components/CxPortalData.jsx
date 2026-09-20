'use client';

/**
 * components/CxPortalData.jsx — the CX Portal Data tab.
 *
 * Doubles as a discovery tool. Response schemas were never captured, so
 * **Shape** reports the structure of whatever an action returns — keys, types,
 * array lengths — without printing the records themselves. That is how the
 * field mapping gets filled in without customer data ending up in a log or a
 * shared document.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowsClockwise, WarningCircle, CheckCircle, BracketsCurly, Table,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const ACTIONS = [
  ['list_projects', 'Projects'],
  ['stats', 'Stats'],
  ['list_project_customers', 'Customers'],
  ['list_tasks', 'Tasks'],
  ['list_stations', 'Stations'],
  ['get_user_filters', 'Saved filters'],
  ['planned_hours', 'Planned hours'],
  ['list_audit_logs', 'Audit log'],
];

export default function CxPortalData() {
  const [action, setAction] = useState('list_projects');
  const [mode, setMode] = useState('shape');
  const [mine, setMine] = useState(false);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ action, size: '25' });
      if (mode === 'shape') q.set('shape', '1');
      if (mine) q.set('mine', '1');
      setRes(await fetch(`/api/cxportal?${q}`).then((r) => r.json()));
    } catch (e) {
      setRes({ error: e.message });
    } finally { setBusy(false); }
  }, [action, mode, mine]);

  useEffect(() => { load(); }, [load]);

  const t = res?.tokenInfo;

  return (
    <div className="space-y-3.5">
      {t && t.present && (
        <Card className={cn('rounded-2xl', t.expired && 'border-bad/40')}>
          <CardContent className="flex flex-wrap items-center gap-2.5 p-4">
            {t.expired
              ? <WarningCircle size={16} weight="fill" className="flex-none text-bad" />
              : <CheckCircle size={16} weight="fill" className="flex-none text-ok" />}
            <span className="min-w-0 flex-1 text-[12.5px]">
              {t.expired
                ? `Token expired ${Math.abs(t.minutesLeft)} minutes ago.`
                : `Token valid for another ${t.minutesLeft} minutes.`}
              <span className="ml-1 text-muted-foreground">
                {t.username ? `· ${t.username}` : ''}
              </span>
            </span>
            {/* The one-hour lifetime is the defining constraint of this
                connector, so it is stated where it will be read. */}
            <Badge variant="secondary" className="rounded-md text-[10.5px]">
              ~1 hour lifetime
            </Badge>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardContent className="p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select value={action} onChange={(e) => setAction(e.target.value)}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-[12.5px]">
              {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            <div className="flex rounded-lg border border-border p-0.5">
              {/* BracketsCurly, not Brackets — Phosphor only ships the
                  qualified variants, and importing a name it does not export
                  yields `undefined`, which React reports as a render crash
                  several frames away from the import. */}
              {[['shape', BracketsCurly, 'Shape'], ['data', Table, 'Data']].map(([m, Icon, label]) => (
                <button key={m} onClick={() => setMode(m)}
                        className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px]',
                          mode === m ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}>
                  <Icon size={12} weight="duotone" /> {label}
                </button>
              ))}
            </div>

            {action === 'list_projects' && (
              <label className="flex items-center gap-1.5 text-[11.5px]">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)}
                       className="accent-primary" />
                Mine only
              </label>
            )}

            <Button variant="outline" size="sm" onClick={load} disabled={busy}
                    className="ml-auto rounded-lg">
              <ArrowsClockwise size={13} weight="bold" className={cn(busy && 'animate-spin')} />
              {busy ? 'Loading…' : 'Fetch'}
            </Button>
          </div>

          {mode === 'shape' && (
            <p className="mb-2 text-[11px] text-muted-foreground">
              Structure only — no records. Use this to fill in the response mapping,
              which was never captured.
            </p>
          )}

          {busy && <Skeleton className="h-[200px] rounded-xl" />}

          {!busy && res?.error && (
            <p className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[12px] text-bad">
              {res.error}
            </p>
          )}

          {!busy && !res?.error && res && (
            <pre className="max-h-[420px] overflow-auto rounded-xl border border-border bg-muted
                            p-3 font-mono text-[10.5px] leading-[1.6]">
              {JSON.stringify(res.shape ?? res.data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
