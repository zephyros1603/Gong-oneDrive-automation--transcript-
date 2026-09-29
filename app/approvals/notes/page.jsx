'use client';

/**
 * Approvals / Notes — the CX Portal note review queue, on its own page.
 *
 * Used to be an always-visible sidebar widget bolted onto the Files page
 * (`/approvals`), three-line-clamped with no way to read a note in full
 * before deciding on it. Different shape from a file review entirely — one
 * payload field, no destination folder, no docx/xlsx preview — so it gets
 * its own page instead of sharing the Files list and its Pending/Approved/
 * Rejected tabs the same way a file does.
 *
 * STRICT SAFETY NOTE: same guarantee as everywhere else this note type
 * shows up — the only thing that can ever call the real, customer-visible
 * CX Portal write is a human's Post (Approve) click below, which goes
 * through the exact same `/api/approvals` decide route `core/approvals/
 * store.js`'s `decide()` gates on `kind === 'cxp_note'`. Composing here
 * calls the exact same propose-only route a script does
 * (`POST /api/cxportal/note`) — it cannot post either.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle, XCircle, Check, X, SlackLogo, Plus, PencilSimple, FloppyDisk,
} from '@phosphor-icons/react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/common.jsx';
import { useResizablePanel, useBreakpoint } from '@/lib/useResponsive.js';
import { ago } from '@/lib/format.js';
import { cn } from '@/lib/utils';
import { SectionSwitcher, StatusTabs } from '@/components/ApprovalsNav.jsx';

const parsePayload = (a) => {
  try { return JSON.parse(a.body); } catch { return null; }
};

export default function ApprovalNotesPage() {
  const [status, setStatus] = useState('pending');
  const [d, setD] = useState(null);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [projectNames, setProjectNames] = useState([]);

  // Composing is authoring, reviewing is deciding — kept as its own
  // collapsible panel rather than inline in the list for that reason, even
  // though both only ever end at the same propose-only route.
  const [showCompose, setShowCompose] = useState(false);
  const [composeProjectId, setComposeProjectId] = useState('');
  const [composeCustomer, setComposeCustomer] = useState('');
  const [composeText, setComposeText] = useState('');
  const [composeShareToSlack, setComposeShareToSlack] = useState(false);
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeResult, setComposeResult] = useState(null);

  // A note is fixed up before it's decided, not after — editing is only
  // ever offered while `sel.status === 'pending'`, and never touches CX
  // Portal itself (POST /api/approvals/[id] only rewrites the stored text).
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState(null);

  const { isCompact } = useBreakpoint();
  const panel = useResizablePanel({
    initial: 340, min: 260, max: 480, keepForMain: 360,
    storageKey: 'warp.approvals.notes.split', enabled: !isCompact,
  });

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/approvals?status=${status}&kind=cxp_note`).then((x) => x.json());
      setD(r);
      setSel((cur) => r.approvals.find((a) => a.id === cur?.id) || r.approvals[0] || null);
    } catch { setD({ approvals: [], counts: {} }); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  // Only projects already linked to a CX Portal project — picking one of
  // these carries its cxpProjectId straight through, which skips the fuzzy
  // customer-name search entirely. A project's own `customer` field can
  // differ from CX Portal's spelling of the same name (a Gong-only project
  // predating the CX Portal link, punctuation, a shortened name — the "One
  // Community Health Sacramento" vs "One Community Health" kind of gap) —
  // picking from this list is the only way to rule that class of error out.
  useEffect(() => {
    fetch('/api/projects').then((r) => r.json())
      .then((data) => setProjectNames((data.projects || []).filter((p) => p.cxpProjectId)
        .map((p) => ({ id: p.id, name: p.name, customer: p.customer, cxpProjectId: p.cxpProjectId }))
        .sort((a, b) => a.customer.localeCompare(b.customer))))
      .catch(() => {});
  }, []);

  const selectedComposeProject = projectNames.find((p) => p.id === composeProjectId) || null;

  const submitCompose = async () => {
    const usingKnownProject = Boolean(selectedComposeProject);
    if ((!usingKnownProject && !composeCustomer.trim()) || !composeText.trim()) return;
    setComposeBusy(true);
    setComposeResult(null);
    try {
      const body = usingKnownProject
        ? {
            cxpProjectId: selectedComposeProject.cxpProjectId,
            projectName: selectedComposeProject.name,
            customerName: selectedComposeProject.customer,
            text: composeText.trim(), shareToSlack: composeShareToSlack,
          }
        : { customerName: composeCustomer.trim(), text: composeText.trim(), shareToSlack: composeShareToSlack };

      const r = await fetch('/api/cxportal/note', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) {
        setComposeResult({ ok: false, message: r.error });
      } else {
        setComposeResult({ ok: true, message: `Proposed for ${r.approval?.project || composeCustomer} — waiting below.` });
        setComposeText('');
        setComposeShareToSlack(false);
        if (status === 'pending') await load();
      }
    } catch (err) {
      setComposeResult({ ok: false, message: err.message });
    } finally {
      setComposeBusy(false);
    }
  };

  /**
   * The one real write this whole app makes. Rejecting never posts — see
   * this file's header comment for the full chain.
   */
  const act = async (id, next) => {
    setBusy(true);
    try {
      await fetch('/api/approvals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, status: next }),
      });
      await load();
    } finally { setBusy(false); }
  };

  // Switching to a different note, or that note getting decided out from
  // under an open edit, leaves editing mode rather than silently keeping a
  // stale draft open against the wrong (or no longer pending) row.
  useEffect(() => { setEditing(false); setEditError(null); }, [sel?.id]);

  const startEdit = () => {
    setEditText(selPayload?.text || '');
    setEditError(null);
    setEditing(true);
  };

  /**
   * Rewrites only the stored `text` — never decides anything, never touches
   * CX Portal (`core/approvals/store.js`'s `updateNoteText()` only runs a
   * plain DB update, and only while the row is still `pending`).
   */
  const saveEdit = async () => {
    const trimmed = editText.trim();
    if (!trimmed) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const r = await fetch(`/api/approvals/${sel.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      }).then((x) => x.json());
      if (r.error) { setEditError(r.error); return; }
      setEditing(false);
      await load();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditBusy(false);
    }
  };

  if (!d) {
    return (
      <div className="flex h-full">
        <div className="w-[340px] flex-none border-r border-border p-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="mb-2 h-[62px] rounded-xl" />
          ))}
        </div>
        <div className="flex-1 p-5"><Skeleton className="h-[320px] rounded-2xl" /></div>
      </div>
    );
  }

  const list = d.approvals || [];
  const selPayload = sel ? parsePayload(sel) : null;

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <aside
        style={isCompact ? undefined : { width: panel.width }}
        className={cn('flex flex-col border-r border-border bg-card',
          isCompact ? 'w-[46%] min-w-[210px] flex-none' : 'flex-none')}
      >
        <SectionSwitcher active="notes" />

        <div className="flex flex-none items-center border-b border-border">
          <StatusTabs status={status} onChange={setStatus} counts={d.counts} />
          <button onClick={() => { setShowCompose((v) => !v); setComposeResult(null); }}
                  title="Compose a note for approval"
                  className={cn('mx-1.5 flex-none rounded-md p-1.5 hover:bg-muted',
                    showCompose ? 'text-primary' : 'text-muted-foreground')}>
            <Plus size={14} weight="bold" />
          </button>
        </div>

        {showCompose && (
          <div className="space-y-2 border-b border-border bg-muted/30 p-2.5">
            <select value={composeProjectId}
                    onChange={(e) => setComposeProjectId(e.target.value)}
                    disabled={composeBusy}
                    className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-primary/50">
              <option value="">Other — type a customer name…</option>
              {projectNames.map((p) => (
                <option key={p.id} value={p.id}>{p.customer} — {p.name}</option>
              ))}
            </select>

            {!composeProjectId && (
              <input value={composeCustomer}
                     onChange={(e) => setComposeCustomer(e.target.value)}
                     disabled={composeBusy} placeholder="Customer name, exactly as CX Portal spells it…"
                     className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-primary/50" />
            )}

            <textarea value={composeText} onChange={(e) => setComposeText(e.target.value)}
                      disabled={composeBusy} placeholder="Note text…" rows={4}
                      className="w-full resize-none rounded-lg border border-border bg-background p-2 text-[11.5px] outline-none focus:border-primary/50" />

            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={composeShareToSlack}
                     onChange={(e) => setComposeShareToSlack(e.target.checked)}
                     disabled={composeBusy} className="h-3.5 w-3.5" />
              <SlackLogo size={12} weight="duotone" />
              Also share to Slack (customer-visible)
            </label>

            {composeResult && (
              <div className={cn('rounded-lg px-2 py-1.5 text-[10.5px]',
                composeResult.ok ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad')}>
                {composeResult.message}
              </div>
            )}

            <Button size="sm" onClick={submitCompose}
                    disabled={composeBusy || (!composeProjectId && !composeCustomer.trim()) || !composeText.trim()}
                    className="h-7 w-full rounded-md text-[11px]">
              {composeBusy ? 'Proposing…' : 'Propose for approval'}
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              This only proposes — nothing is sent to CX Portal until you post it below.
            </p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <p className="p-4 text-[11.5px] leading-relaxed text-muted-foreground">
              {status === 'pending'
                ? <>Nothing pending. A script proposes a note with{' '}
                    <code className="font-mono">warp.cxp.proposeNote()</code>, or compose one by hand above —
                    nothing posts until you approve it here.</>
                : `No ${status} notes.`}
            </p>
          )}

          {list.map((a) => {
            const payload = parsePayload(a);
            return (
              <div key={a.id}
                   className={cn('mb-1.5 rounded-xl border bg-background p-2.5 transition-colors',
                     sel?.id === a.id ? 'border-primary/40 bg-primary/8' : 'border-border')}>
                {/* Click to read the full note on the right — the preview
                    below is deliberately short, the detail pane isn't. */}
                <div role="button" tabIndex={0} onClick={() => setSel(a)}
                     onKeyDown={(e) => e.key === 'Enter' && setSel(a)}
                     className="cursor-pointer">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                      {payload?.customerName || a.title}
                    </span>
                    {payload?.shareToSlack && (
                      <SlackLogo size={12} weight="duotone" className="flex-none text-muted-foreground"
                                 title="Also shares to the customer's Slack" />
                    )}
                  </div>
                  <p className="mb-2 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    {payload?.text || '(could not read this note\'s text)'}
                  </p>
                  <p className="mb-2 font-mono text-[10px] text-muted-foreground">{ago(a.createdAt)}</p>
                </div>
                {status === 'pending' && (
                  <div className="flex gap-1.5">
                    <Button size="sm" disabled={busy} onClick={() => act(a.id, 'approved')}
                            className="h-6 flex-1 rounded-md text-[11px]">
                      <Check size={11} weight="bold" /> Post
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => act(a.id, 'rejected')}
                            className="h-6 flex-none rounded-md px-2 text-[11px] text-bad hover:text-bad">
                      <X size={11} weight="bold" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {!isCompact && (
        <div {...panel.handleProps}
             className={cn('w-1 flex-none cursor-col-resize transition-colors hover:bg-primary/40',
               panel.dragging && 'bg-primary/60')} />
      )}

      <section className="min-w-0 flex-1 overflow-y-auto">
        {!sel ? (
          <div className="grid h-full place-items-center p-8 text-center text-[12.5px] text-muted-foreground">
            Nothing selected.
          </div>
        ) : (
          <div className="space-y-3.5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold tracking-tight">
                  {selPayload?.customerName || sel.title}
                </h1>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  CX Portal note · {ago(sel.createdAt)}
                </p>
              </div>

              <div className="flex flex-none items-center gap-1.5">
                {sel.status === 'pending' ? (
                  editing ? (
                    <>
                      <Button size="sm" disabled={editBusy || !editText.trim()} onClick={saveEdit}
                              className="rounded-lg">
                        <FloppyDisk size={13} weight="bold" /> {editBusy ? 'Saving…' : 'Save'}
                      </Button>
                      <Button size="sm" variant="outline" disabled={editBusy}
                              onClick={() => setEditing(false)} className="rounded-lg">
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={startEdit} className="rounded-lg">
                        <PencilSimple size={13} weight="duotone" /> Edit
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => act(sel.id, 'approved')}
                              className="rounded-lg">
                        <CheckCircle size={13} weight="fill" /> Post
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy}
                              onClick={() => act(sel.id, 'rejected')}
                              className="rounded-lg text-bad hover:text-bad">
                        <XCircle size={13} weight="fill" /> Reject
                      </Button>
                    </>
                  )
                ) : (
                  <Badge className={cn('rounded-lg border-transparent',
                    sel.status === 'approved' ? 'bg-ok/12 text-ok' : 'bg-bad/12 text-bad')}>
                    {sel.status}
                  </Badge>
                )}
              </div>
            </div>

            <Card className="rounded-2xl">
              <CardContent className="p-5">
                {editing ? (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                        Editing
                      </span>
                      {selPayload?.shareToSlack && (
                        <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <SlackLogo size={11} weight="duotone" /> Also to Slack
                        </span>
                      )}
                    </div>
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)}
                              disabled={editBusy} rows={14}
                              className="w-full resize-y rounded-lg border border-border bg-background p-3 text-[13px] leading-relaxed outline-none focus:border-primary/50" />
                    {editError && <p className="mt-2 text-[11.5px] text-bad">{editError}</p>}
                    <p className="mt-2 text-[10.5px] text-muted-foreground">
                      Only the note text changes — the customer and Slack setting stay as proposed. Save
                      before Post to make sure the edit is what actually goes out.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                        {sel.status === 'pending' ? 'Ready to post' : sel.status}
                      </span>
                      <div className="flex items-center gap-2">
                        {selPayload?.shareToSlack && (
                          <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            <SlackLogo size={11} weight="duotone" /> Also to Slack
                          </span>
                        )}
                        <CopyButton text={selPayload?.text || ''} label="Copy note" />
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
                      {selPayload?.text || '_could not read this note\'s text_'}
                    </p>
                    {sel.note && (
                      <p className="mt-3 rounded-lg bg-bad/10 p-2.5 text-[11.5px] text-bad">{sel.note}</p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </section>
    </div>
  );
}
