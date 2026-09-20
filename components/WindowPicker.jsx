'use client';

/**
 * components/WindowPicker.jsx — how far back a sync reaches.
 *
 * Three buttons rather than a list of "last N days", because the reports these
 * windows feed are calendar things: a weekly status report covers a week, not
 * the last 168 hours. Picking Week on a Wednesday and getting half of last week
 * restated is the failure this avoids.
 *
 * The resolved dates are always on screen. A preset that silently means
 * something different depending on which day you open it is exactly the kind of
 * setting people stop trusting, so it shows its work.
 */

import { CalendarBlank } from '@phosphor-icons/react';
import { Label } from '@/components/ui/label';
import { PRESETS, ANCHORS, resolveWindow } from '@/core/workflow/window.js';
import { cn } from '@/lib/utils';

const pretty = (day) =>
  day ? new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—';

export function WindowPicker({ value, onChange, label = 'Date window', hint, className }) {
  // A workflow saved before the presets existed carries a string; normalising
  // here means the buttons light up correctly instead of all reading as off.
  const w = resolveWindow(value);
  const spec = typeof value === 'object' && value ? value : {};
  const preset = w.preset;
  const anchor = w.anchor;

  // Read the day count off the *resolved* window, not the raw value. A legacy
  // string window carries no `days` field, so reading the raw spec showed a
  // hardcoded 14 next to a label that said 7 — the control disagreeing with
  // itself on screen.
  const days = spec.days ?? w.days;

  const set = (patch) => onChange({ preset, anchor, days, ...patch });

  return (
    <div className={className}>
      <Label className="mb-1.5 block text-[12px] font-medium">{label}</Label>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => set({ preset: p.id })}
                  title={p.hint}
                  className={cn('h-8 rounded-lg border px-3 text-[12px] font-medium transition-colors',
                    preset === p.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input text-muted-foreground hover:bg-muted')}>
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => set({ preset: 'custom', days: days || 14 })}
                className={cn('h-8 rounded-lg border px-3 text-[12px] font-medium transition-colors',
                  preset === 'custom'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:bg-muted')}>
          Custom
        </button>

        {preset !== 'custom' && (
          <div className="ml-1 flex overflow-hidden rounded-lg border border-input">
            {ANCHORS.map((a) => (
              <button key={a.id} type="button" onClick={() => set({ anchor: a.id })}
                      className={cn('h-8 px-2.5 text-[11.5px] transition-colors',
                        anchor === a.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {preset === 'custom' && (
        <div className="mt-2 flex items-center gap-2">
          <input type="number" min="0" max="365" value={days ?? 14}
                 onChange={(e) => set({ preset: 'custom', days: Number(e.target.value) })}
                 className="h-8 w-20 rounded-lg border border-input bg-transparent px-2 text-[12.5px]
                            outline-none focus-visible:border-ring" />
          <span className="text-[11.5px] text-muted-foreground">
            days back, ending today. 0 means everything.
          </span>
        </div>
      )}

      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <CalendarBlank size={12} weight="duotone" className="flex-none" />
        <span>
          <span className="font-medium text-foreground">{w.label}</span>
          {w.from ? ` · ${pretty(w.fromDay)} → ${pretty(w.toDay)} · ${w.days} day${w.days === 1 ? '' : 's'}` : ' · no date limit'}
        </span>
      </p>

      {/* The one trap worth naming: the first morning of a period is nearly empty. */}
      {anchor === 'this' && preset !== 'custom' && w.days <= 1 && preset !== 'day' && (
        <p className="mt-1 text-[11px] text-warn">
          This {preset} has barely started — a run now would see almost nothing. Switch to Previous.
        </p>
      )}

      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default WindowPicker;
