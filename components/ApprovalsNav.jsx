'use client';

/**
 * components/ApprovalsNav.jsx — the two small pieces of chrome shared by
 * Approvals' Files page (`/approvals`) and its Notes page
 * (`/approvals/notes`), which used to be one page with a note carved out of
 * it client-side. `SectionSwitcher` is what makes the split still read as
 * one place (this file's own header comment for context); `StatusTabs` is
 * the same Pending/Approved/Rejected bar both pages need, so it exists once.
 */

import Link from 'next/link';
import { FileDoc, ChatCircleText } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { key: 'files', href: '/approvals', label: 'Files', icon: FileDoc },
  { key: 'notes', href: '/approvals/notes', label: 'Notes', icon: ChatCircleText },
];

export function SectionSwitcher({ active }) {
  return (
    <div className="flex flex-none gap-0.5 border-b border-border p-2">
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        const on = s.key === active;
        return (
          <Link key={s.key} href={s.href}
                className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5',
                  'text-[11.5px] font-medium no-underline transition-colors',
                  on ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
            <Icon size={13} weight="duotone" />
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}

const STATUS_TABS = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];

export function StatusTabs({ status, onChange, counts }) {
  return (
    <div className="flex flex-none gap-0.5 border-b border-border p-2">
      {STATUS_TABS.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)}
          className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium',
            status === v ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
          {l}
          {counts?.[v] > 0 && (
            <span className="rounded bg-muted px-1 font-mono text-[10px]">{counts[v]}</span>
          )}
        </button>
      ))}
    </div>
  );
}
