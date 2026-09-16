'use client';

/**
 * components/TopBar.jsx — the chrome every tab shares.
 *
 * It carries the global Stop, the usage total and the automation status, so a
 * run you started on one tab is never hidden because you walked away from it.
 *
 * Six tabs do not fit a narrow window, and in an `overflow: hidden` shell
 * "does not fit" means "is clipped and unreachable" rather than "scrolls" —
 * Provisioning disappeared entirely below about 700px. Below `lg` the nav
 * therefore becomes a menu, which always fits whatever the width.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { money } from '@/lib/format.js';
import { useBreakpoint, useDismissable } from '@/lib/useResponsive.js';

const TABS = [
  { href: '/projects', label: 'Projects' },
  { href: '/workbench', label: 'Workbench' },
  { href: '/preview', label: 'Preview' },
  { href: '/pull', label: 'Pull' },
  { href: '/automation', label: 'Automation' },
  { href: '/provisioning', label: 'Provisioning' },
];

const isCurrent = (pathname, href) => pathname === href || pathname.startsWith(`${href}/`);

export default function TopBar() {
  const pathname = usePathname();
  const { isCompact, isPhone } = useBreakpoint();
  const [jobs, setJobs] = useState([]);
  const [usage, setUsage] = useState(null);
  const [auto, setAuto] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  useDismissable(menu, () => setMenu(false));
  useEffect(() => { setMenu(false); }, [pathname]);

  useEffect(() => {
    if (!menu) return;
    const away = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    const t = setTimeout(() => document.addEventListener('mousedown', away), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', away); };
  }, [menu]);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [r, a] = await Promise.all([
          fetch('/api/running').then((x) => x.json()),
          fetch('/api/automation').then((x) => x.json()),
        ]);
        if (!live) return;
        setJobs(r.jobs || []);
        setUsage(r.usage || null);
        setAuto(a);
      } catch { /* the server is restarting; the next tick will catch up */ }
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

  const current = TABS.find((t) => isCurrent(pathname, t.href));

  return (
    <header className="flex h-[52px] w-full min-w-0 flex-none items-center gap-2
                       border-b border-[var(--line)] bg-[var(--surface)] px-3 sm:gap-3 sm:px-4">
      {/* The wordmark is the first thing worth dropping; the mark stays. */}
      <div className="flex min-w-0 flex-none items-center gap-2.5 text-[13.5px] font-semibold">
        <span className="grid h-5 w-5 flex-none place-items-center rounded-[5px]
                         bg-[var(--accent)] text-[11px] text-white">G</span>
        <span className="hidden truncate sm:inline">Gong Transcripts</span>
      </div>

      {isCompact ? (
        <div className="relative min-w-0 flex-1" ref={menuRef}>
          <button
            onClick={() => setMenu((m) => !m)}
            aria-expanded={menu}
            aria-haspopup="menu"
            className="flex w-full max-w-[220px] items-center justify-between gap-2 rounded-lg
                       border border-[var(--line)] bg-[var(--surface-2)] px-3 py-1.5
                       text-[12.5px] font-medium"
          >
            <span className="truncate">{current?.label || 'Menu'}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.4" strokeLinecap="round" className="flex-none opacity-60">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {menu && (
            <nav role="menu"
                 className="absolute left-0 top-11 z-50 w-[220px] rounded-xl border
                            border-[var(--line)] bg-[var(--surface)] p-1.5 shadow-2xl">
              {TABS.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  role="menuitem"
                  className={`block rounded-lg px-3 py-2 text-[12.5px] no-underline
                    ${isCurrent(pathname, t.href)
                      ? 'bg-[var(--accent)] text-white'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'}`}
                >
                  {t.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
      ) : (
        <nav className="flex min-w-0 flex-none gap-[3px] rounded-[9px] border
                        border-[var(--line)] bg-[var(--surface-2)] p-[3px]">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`whitespace-nowrap rounded-[7px] px-3 py-[7px] text-[12.5px]
                          font-medium no-underline transition-colors
                          ${isCurrent(pathname, t.href)
                            ? 'bg-[var(--accent)] text-white'
                            : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}

      <div className="ml-auto flex flex-none items-center gap-2">
        {jobs.length > 0 && (
          <button
            onClick={stopAll}
            disabled={stopping}
            title={`Stop ${jobs.length} running job(s)`}
            className="whitespace-nowrap rounded-lg border border-[var(--bad)]/50
                       bg-[var(--bad)]/12 px-2.5 py-1.5 text-[12px] font-medium
                       text-[var(--bad)] hover:bg-[var(--bad)]/20"
          >
            {stopping ? 'Stopping…' : isPhone ? `Stop ${jobs.length}` : `Stop ${jobs.length} run${jobs.length === 1 ? '' : 's'}`}
          </button>
        )}

        {/* Secondary chips go first when space runs out — they are glanceable,
            not actionable, and the Stop button must never be the thing that
            gets pushed off the edge. */}
        {auto?.enabled && (
          <span
            title={auto.nextRunAt ? `Next run ${new Date(auto.nextRunAt).toLocaleString()}` : ''}
            className="hidden whitespace-nowrap rounded-lg border border-[var(--line)]
                       bg-[var(--surface-2)] px-2.5 py-1.5 font-mono text-[11px]
                       text-[var(--muted)] xl:inline"
          >
            auto {auto.time}
          </span>
        )}

        {usage && (
          <span
            title={`${usage.runs} runs · ${money(usage.todayUsd)} today`}
            className="hidden whitespace-nowrap rounded-lg border border-[var(--line)]
                       bg-[var(--surface-2)] px-2.5 py-1.5 font-mono text-[11px]
                       text-[var(--muted)] sm:inline"
          >
            {money(usage.totalUsd)}
          </span>
        )}
      </div>
    </header>
  );
}
