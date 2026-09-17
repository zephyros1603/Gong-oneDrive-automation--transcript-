'use client';

/**
 * components/SidebarLayout.jsx — the sidebar-and-content shell, once.
 *
 * Projects, Workbench and Preview are all the same shape: a list on the left,
 * a working area on the right, a drag handle between them. Each one used to
 * carry its own copy, which is how they ended up with the same bug — a fixed
 * pixel width that stayed fixed no matter how little room was left.
 *
 * Below `lg` the sidebar stops being a column and becomes an overlay, so the
 * content always gets the full width rather than a clipped remainder.
 */

import { useEffect } from 'react';
import { useBreakpoint, useResizablePanel, useDismissable } from '@/lib/useResponsive.js';

export function SidebarToggle({ onClick, label = 'Show list' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 flex-none place-items-center rounded-lg border
                 border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-muted)]
                 hover:text-[var(--text)] lg:hidden"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round">
        <path d="M3 6h18M3 12h18M3 18h18" />
      </svg>
    </button>
  );
}

export default function SidebarLayout({
  sidebar,
  children,
  open,
  onOpenChange,
  storageKey,
  min = 200,
  max = 480,
  initial = 280,
}) {
  const { isCompact } = useBreakpoint();
  const panel = useResizablePanel({ initial, min, max, storageKey, enabled: !isCompact });

  useDismissable(open && isCompact, () => onOpenChange?.(false));

  // Coming back to a wide window should not leave an overlay stuck open.
  useEffect(() => {
    if (!isCompact && open) onOpenChange?.(false);
  }, [isCompact, open, onOpenChange]);

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      {/* The scrim only exists while the sidebar is an overlay. */}
      {isCompact && open && (
        <div
          onClick={() => onOpenChange?.(false)}
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-[1px]"
          aria-hidden
        />
      )}

      <aside
        // Width is inline only when it is a real column. As an overlay it uses
        // a viewport-relative width, so it can never be wider than the screen.
        style={isCompact ? undefined : { width: panel.width }}
        className={
          isCompact
            ? `fixed inset-y-0 left-0 z-40 flex w-[min(86vw,320px)] flex-col
               border-r border-[var(--line)] bg-[var(--surface)] shadow-2xl
               transition-transform duration-200
               ${open ? 'translate-x-0' : '-translate-x-full'}`
            : 'flex flex-none flex-col border-r border-[var(--line)] bg-[var(--surface)]'
        }
      >
        {sidebar}
      </aside>

      {!isCompact && (
        <div
          {...panel.handleProps}
          className={`w-1 flex-none cursor-col-resize transition-colors
                      hover:bg-[var(--brand)]/40 ${panel.dragging ? 'bg-[var(--brand)]/60' : ''}`}
        />
      )}

      {/* min-w-0 is what lets this shrink instead of pushing the page wider. */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</section>
    </div>
  );
}
