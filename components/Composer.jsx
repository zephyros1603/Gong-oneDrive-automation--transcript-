'use client';

/**
 * components/Composer.jsx — the chat input, once.
 *
 * The vanilla build had this twice, ~120 lines each, in workbench.html and
 * projects.html: the same `+` picker, the same context pill row, the same
 * autosizing textarea, the same Enter-to-send and the same send/stop swap.
 * They had already drifted apart in small ways by the time they were merged.
 */

import { useEffect, useRef, useState } from 'react';
import { Pill, Spinner } from './common.jsx';
import { stripName } from '@/lib/format.js';
import { useViewportWidth } from '@/lib/useResponsive.js';

export default function Composer({
  placeholder = 'Ask anything…',
  skills = [],
  skill = null,
  onSkillChange,
  files = [],
  onRemoveFile,
  running = false,
  onSend,
  onStop,
  disabled = false,
  note = null,
}) {
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const area = useRef(null);
  const picker = useRef(null);
  const viewport = useViewportWidth();

  // Grow with the content, but stop before the composer eats the thread.
  //
  // Re-measured on viewport change as well as on typing: the same text needs
  // more lines in a narrower composer, and a height measured at one width and
  // left alone leaves a tall empty box at another.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text, viewport]);

  useEffect(() => {
    if (!picking) return;
    const close = (e) => {
      if (!picker.current?.contains(e.target)) setPicking(false);
    };
    // Deferred, or the click that opened the picker closes it again.
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close); };
  }, [picking]);

  const canSend = !disabled && !running && (text.trim().length > 0 || Boolean(skill));

  const send = () => {
    if (!canSend) return;
    onSend?.({ text: text.trim(), skill, files });
    setText('');
  };

  const context = [
    ...(skill ? [{ key: `skill:${skill.id}`, tone: 'accent', label: skill.label,
                   onRemove: () => onSkillChange?.(null) }] : []),
    ...files.map((f) => ({
      key: `file:${f.path || f}`,
      tone: 'default',
      label: stripName(f.name || String(f).split('/').pop()),
      onRemove: onRemoveFile ? () => onRemoveFile(f) : undefined,
    })),
    ...(note ? [{ key: 'note', tone: 'warn', label: note }] : []),
  ];

  return (
    <div className="px-4 pb-4">
      {/* No `overflow-hidden` here, deliberately. It clipped the skill picker,
          which opens upward and out of these bounds — the popover appeared
          sliced in half on every page with a composer. The rounded corners are
          kept by rounding the first and last rows instead. */}
      <div className="mx-auto max-w-[860px] rounded-[14px] border
                      border-[var(--line)] bg-[var(--surface-2)]">
        {context.length > 0 && (
          <div className="flex flex-wrap gap-1.5 rounded-t-[13px] border-b border-[var(--line-soft)] px-3 py-2">
            {context.map((c) => (
              <Pill key={c.key} tone={c.tone} onRemove={c.onRemove} title={c.label}>
                {c.label}
              </Pill>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-b-[13px] p-2.5">
          <div className="relative flex-none" ref={picker}>
            <button
              type="button"
              onClick={() => setPicking((p) => !p)}
              title="Add a skill"
              className="grid h-8 w-8 place-items-center rounded-[9px] border border-[var(--line)]
                         bg-[var(--surface-3)] text-[16px] leading-none text-[var(--text-muted)]
                         hover:text-[var(--text)]"
            >
              +
            </button>

            {picking && (
              <div className="absolute bottom-11 left-0 z-50 max-h-[min(340px,50vh)]
                              w-[min(300px,80vw)] overflow-y-auto rounded-xl border
                              border-border bg-popover p-1.5 shadow-2xl">
                {skills.length === 0 && (
                  <div className="p-3 text-[12px] text-[var(--faint)]">No skills installed.</div>
                )}
                {skills.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { onSkillChange?.(s); setPicking(false); }}
                    className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-2)]"
                  >
                    <span className="flex items-center gap-2 text-[12.5px] font-medium">
                      {s.label}
                      {s.installed === false && (
                        <span className="rounded border border-[var(--warn)]/40 px-1
                                         font-mono text-[9.5px] text-[var(--warn)]">
                          blueprint
                        </span>
                      )}
                    </span>
                    {s.title && (
                      <span className="mt-0.5 block text-[11px] text-[var(--faint)]">{s.title}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <textarea
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            className="max-h-[180px] min-h-[32px] flex-1 resize-none bg-transparent py-1.5
                       text-[13px] leading-[1.5] text-[var(--text)] outline-none
                       placeholder:text-[var(--faint)]"
          />

          {running ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop this run"
              className="grid h-8 w-8 flex-none place-items-center rounded-[9px]
                         border border-[var(--bad)]/50 bg-[var(--bad)]/12 text-[var(--bad)]"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              title="Send"
              className="grid h-8 w-8 flex-none place-items-center rounded-[9px]
                         bg-[var(--brand)] text-white disabled:opacity-35"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The live "working…" strip a run shows while it streams. */
export function RunStatus({ phase, tool, trace = [] }) {
  const box = useRef(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [trace.length]);

  return (
    <div>
      <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
        <Spinner />
        <span className="font-medium text-[var(--text)]">{phase || 'Working'}</span>
        <span className="truncate text-[var(--faint)]">{tool}</span>
      </div>
      {trace.length > 0 && (
        <div ref={box}
             className="mt-2 max-h-[80px] overflow-y-auto font-mono text-[10.5px]
                        leading-[1.7] text-[var(--faint)]">
          {trace.map((line, i) => <div key={i} className="truncate">{line}</div>)}
        </div>
      )}
    </div>
  );
}
