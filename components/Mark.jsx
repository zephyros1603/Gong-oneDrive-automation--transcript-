'use client';

/**
 * components/Mark.jsx — an application's square mark.
 *
 * Shared by the Applications grid and the Workbench sync cards, so a logo
 * cannot mean one thing in one place and something else in another.
 */

import { cn } from '@/lib/utils';

const MARK = {
  gong: { bg: 'bg-[#8039df]', text: 'G' },
  claude: { bg: 'bg-[#d97757]', text: 'C' },
  jira: { bg: 'bg-[#0052cc]', text: 'J' },
  m365: { bg: 'bg-[#0f6cbd]', text: 'M' },
  slack: { bg: 'bg-[#4a154b]', text: 'S' },
  zoom: { bg: 'bg-[#0b5cff]', text: 'Z' },
  cxportal: { bg: 'bg-[#1b4965]', text: 'CX' },
  projects: { bg: 'bg-slate-600', text: 'P' },
  library: { bg: 'bg-slate-500', text: 'L' },
  graph: { bg: 'bg-slate-600', text: 'G' },
  automation: { bg: 'bg-slate-500', text: 'A' },
};

export function Mark({ id, size = 44 }) {
  const m = MARK[id] || { bg: 'bg-muted-foreground', text: String(id || '?').slice(0, 1).toUpperCase() };
  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.34 }}
      className={cn('grid flex-none place-items-center rounded-[13px] font-semibold text-white shadow-sm', m.bg)}
    >
      {m.text}
    </span>
  );
}

export default Mark;
