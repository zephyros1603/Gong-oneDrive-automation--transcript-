'use client';

/**
 * components/AppShell.jsx — the product chrome.
 *
 * Top navigation rather than a sidebar, which is the SailPoint shape: a white
 * primary bar, a coloured contextual band under it, and the full window width
 * left for content. A sidebar costs ~230px on every page forever; a data-dense
 * product would rather spend that on the table.
 *
 * Anything that *creates* something lives behind the `+` button instead of the
 * nav, so the nav stays a list of places and never becomes a list of verbs.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  SquaresFour, Plugs, Wrench, Eye, ClockCounterClockwise, TreeStructure,
  SealCheck, Plus, List, X, Lightning, FolderOpen, FileArrowDown, Sparkle,
  Bell, CheckCircle, XCircle, ArrowClockwise, Code, Terminal,
} from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from '@/components/ui/dropdown-menu.jsx';
import ThemeToggle from '@/components/ThemeToggle.jsx';
import { useBreakpoint, useDismissable } from '@/lib/useResponsive.js';
import { useNotifications } from '@/lib/useNotifications.js';
import { money, ago } from '@/lib/format.js';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: SquaresFour },
  { href: '/applications', label: 'Applications', icon: Plugs },
  { href: '/workbench', label: 'Workbench', icon: Wrench },
  { href: '/automation', label: 'Automation', icon: ClockCounterClockwise },
  { href: '/approvals', label: 'Approvals', icon: SealCheck },
  { href: '/engine', label: 'Engine', icon: Code },
  { href: '/cron-jobs', label: 'Cron Jobs', icon: Terminal },
  { href: '/projects', label: 'Projects', icon: FolderOpen },
  { href: '/preview', label: 'Library', icon: Eye },
];

const CREATE = [
  { href: '/applications?add=1', label: 'Application', hint: 'Connect a new source', icon: Plugs },
  { href: '/applications/gong?tab=data', label: 'Transcript pull', hint: 'Fetch calls from Gong', icon: FileArrowDown },
  { href: '/workbench', label: 'Workflow', hint: 'Author a reusable recipe', icon: Sparkle },
  { href: '/automation', label: 'Schedule', hint: 'Run a workflow on a timer', icon: ClockCounterClockwise },
  { href: '/graph', label: 'Graph view', hint: 'Client, project, activity', icon: TreeStructure },
  { href: '/engine?new=1', label: 'Script', hint: 'Write your own automation in JS', icon: Code },
];

function NotifIcon({ kind }) {
  if (kind === 'schedule_done') return <CheckCircle size={15} weight="fill" className="mt-0.5 flex-none text-ok" />;
  if (kind === 'schedule_error') return <XCircle size={15} weight="fill" className="mt-0.5 flex-none text-bad" />;
  return <ArrowClockwise size={15} weight="bold" className="mt-0.5 flex-none text-primary" />;
}

const isCurrent = (pathname, href) => {
  const base = href.split('?')[0];
  return pathname === base || pathname.startsWith(`${base}/`);
};

export default function AppShell({ children }) {
  const pathname = usePathname();
  const { isCompact } = useBreakpoint();
  const [menu, setMenu] = useState(false);
  const [create, setCreate] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [usage, setUsage] = useState(null);
  const [stopping, setStopping] = useState(false);
  const createRef = useRef(null);
  const notif = useNotifications();

  useDismissable(menu || create, () => { setMenu(false); setCreate(false); });
  useEffect(() => { setMenu(false); setCreate(false); }, [pathname]);

  useEffect(() => {
    if (!create) return;
    const away = (e) => { if (!createRef.current?.contains(e.target)) setCreate(false); };
    const t = setTimeout(() => document.addEventListener('mousedown', away), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', away); };
  }, [create]);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/running').then((x) => x.json());
        if (!live) return;
        setJobs(r.jobs || []);
        setUsage(r.usage || null);
      } catch { /* restarting; the next tick catches up */ }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const stopAll = async () => {
    setStopping(true);
    try {
      await fetch('/api/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } catch { /* the poll reports the truth either way */ }
    setStopping(false);
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      {/* ---- primary bar --------------------------------------------------- */}
      <header className="flex h-[52px] w-full min-w-0 flex-none items-center gap-2.5
                         border-b border-border bg-card px-4">
        <Link href="/dashboard" className="flex flex-none items-center gap-2.5 no-underline">
          <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-primary
                           text-primary-foreground shadow-sm">
            <Lightning size={15} weight="fill" />
          </span>
          <span className="hidden text-[14.5px] font-semibold tracking-tight text-foreground sm:inline">
            Warp
          </span>
        </Link>

        {!isCompact && (
          <nav className="ml-3 flex min-w-0 flex-1 items-center gap-0.5">
            {NAV.map((item) => {
              const on = isCurrent(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium no-underline transition-colors',
                    on ? 'bg-primary/10 text-primary' : 'text-foreground/75 hover:bg-muted hover:text-foreground'
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}

        {isCompact && (
          <Button variant="ghost" size="icon" onClick={() => setMenu(true)}
                  className="ml-auto rounded-xl" aria-label="Open menu">
            <List size={18} />
          </Button>
        )}

        <div className={cn('flex flex-none items-center gap-2', isCompact && 'order-last')}>
          {/* Create lives here, not in the nav — the nav is places, not verbs. */}
          <div className="relative" ref={createRef}>
            <Button
              size="icon"
              onClick={() => setCreate((c) => !c)}
              aria-expanded={create}
              aria-haspopup="menu"
              title="Create"
              className="rounded-xl shadow-sm"
            >
              <Plus size={17} weight="bold" className={cn('transition-transform', create && 'rotate-45')} />
            </Button>

            {create && (
              <div role="menu"
                   className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-12 z-50
                              w-[286px] rounded-2xl border border-border bg-popover p-1.5 shadow-xl">
                {CREATE.map((c) => {
                  const Icon = c.icon;
                  return (
                    <Link key={c.label} href={c.href} role="menuitem"
                          className="flex items-start gap-3 rounded-xl px-3 py-2.5 no-underline
                                     transition-colors hover:bg-muted">
                      <Icon size={18} weight="duotone" className="mt-0.5 flex-none text-primary" />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-foreground">{c.label}</span>
                        <span className="block text-[11.5px] text-muted-foreground">{c.hint}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {jobs.length > 0 && (
            <Button variant="destructive" size="sm" onClick={stopAll} disabled={stopping}
                    className="rounded-xl">
              {stopping ? 'Stopping…' : `Stop ${jobs.length}`}
            </Button>
          )}

          {usage && !isCompact && (
            <Badge variant="secondary"
                   title={`${usage.runs} runs · ${money(usage.todayUsd)} today`}
                   className="rounded-lg font-mono text-[11px]">
              {money(usage.totalUsd)}
            </Badge>
          )}

          <DropdownMenu onOpenChange={(open) => open && notif.requestPermission()}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="relative rounded-xl" aria-label="Notifications">
                <Bell size={16} weight={notif.unread ? 'fill' : 'regular'} />
                {notif.unread > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center
                                    rounded-full bg-primary px-1 text-[9.5px] font-semibold
                                    text-primary-foreground">
                    {notif.unread > 9 ? '9+' : notif.unread}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[340px] rounded-2xl p-0">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-[12.5px] font-semibold">Notifications</span>
                {notif.unread > 0 && (
                  <button onClick={notif.markAllRead}
                          className="text-[11px] text-primary hover:underline">
                    Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-[360px] overflow-y-auto p-1.5">
                {notif.items.length === 0 && (
                  <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                    Nothing yet — a scheduled sync will show up here as it runs.
                  </p>
                )}
                {notif.items.map((n) => (
                  <button key={n.id} onClick={() => !n.read && notif.markRead(n.id)}
                          className={cn('flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left',
                                        n.read ? 'opacity-60' : 'bg-primary/5 hover:bg-primary/10')}>
                    <NotifIcon kind={n.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium">{n.title}</span>
                      {n.body && (
                        <span className="block truncate text-[11px] text-muted-foreground">{n.body}</span>
                      )}
                      <span className="block text-[10.5px] text-muted-foreground/70">{ago(n.at)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          <ThemeToggle />
        </div>
      </header>

      {/* ---- toasts: a schedule firing while the tab is open -------------- */}
      {notif.toasts.length > 0 && (
        <div className="pointer-events-none fixed right-4 top-[60px] z-[70] flex w-[320px] flex-col gap-2">
          {notif.toasts.map((n) => (
            <div key={n.id}
                 className="animate-in slide-in-from-right fade-in pointer-events-auto flex items-start
                            gap-2 rounded-xl border border-border bg-popover p-3 shadow-lg">
              <NotifIcon kind={n.kind} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium">{n.title}</span>
                {n.body && <span className="block text-[11.5px] text-muted-foreground">{n.body}</span>}
              </span>
              <button onClick={() => notif.dismissToast(n.id)} aria-label="Dismiss"
                      className="flex-none text-muted-foreground hover:text-foreground">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- compact drawer -------------------------------------------------- */}
      {isCompact && menu && (
        <>
          <div onClick={() => setMenu(false)} aria-hidden
               className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
          <nav className="animate-in slide-in-from-right fixed inset-y-0 right-0 z-50 w-[280px]
                          overflow-y-auto border-l border-border bg-card p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <span className="text-[14px] font-semibold">Menu</span>
              <Button variant="ghost" size="icon" onClick={() => setMenu(false)}
                      className="rounded-xl" aria-label="Close menu">
                <X size={16} />
              </Button>
            </div>
            {NAV.map((item) => {
              const Icon = item.icon;
              const on = isCurrent(pathname, item.href);
              return (
                <Link key={item.href} href={item.href}
                      className={cn(
                        'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13.5px] font-medium no-underline',
                        on ? 'bg-primary/10 text-primary' : 'text-foreground/80 hover:bg-muted'
                      )}>
                  <Icon size={18} weight={on ? 'fill' : 'duotone'} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </>
      )}

      <main key={pathname} className="animate-in fade-in min-h-0 flex-1 overflow-hidden duration-300">
        {children}
      </main>
    </div>
  );
}
