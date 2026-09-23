'use client';

/**
 * components/UniverViewer.jsx — one editor for both spreadsheets and documents.
 *
 * Built on `@univerjs/presets` — `createUniver({ presets: [...] })` — rather
 * than registering each plugin by hand. An earlier version of this component
 * did the manual `univer.registerPlugin(...)` sequence directly against the
 * core packages, and it mounted (the ribbon rendered, no console errors) but
 * the actual grid/page canvas stayed at zero height with a genuinely empty
 * render-target div underneath — nothing in this rc's public API surface
 * explained why. The presets package is Univer's own documented entry point
 * and known-good combination of plugins and locale wiring for exactly this
 * scenario, and switching to it is what actually made the canvas paint.
 *
 * Univer owns its mount container directly, not through React's render tree —
 * this component's job is creating that container, handing Univer the
 * snapshot once, and reading the edited snapshot back out through its Facade
 * API on save.
 *
 * Neither bridge (`core/engine/xlsx-bridge.js`, `core/engine/docx-bridge.js`)
 * is a fidelity-preserving round trip. The sheet side keeps values and simple
 * formulas, not cell formatting. The doc side keeps paragraphs, bold/italic,
 * and tables (structure and text), not headers/footers, images, real
 * numbered lists, or table borders/shading.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FloppyDisk } from '@phosphor-icons/react';

// Static, top-level — Next.js/webpack only extracts CSS from imports it can
// see at build time, not from a `.then()` inside a dynamic `import()`. This
// was the actual gap in every earlier version of this component: `.univer-*`
// classes were present in the DOM and real rules for them exist, in a plain
// `lib/index.css` each preset package ships, but nothing had ever imported
// that file. Every element with a class like `univer-flex` computed as
// `display: block` — the class was real, the rule existed on disk, and nothing
// had loaded it — which is a CSS-loading bug, not a mounting or sizing one, and
// is why the container-height workarounds elsewhere in this file never helped.
import '@univerjs/preset-docs-core/lib/index.css';
import '@univerjs/preset-sheets-core/lib/index.css';

export function UniverViewer({ kind, snapshot, onSave, readOnly = false }) {
  const wrapperRef = useRef(null);
  const containerRef = useRef(null);
  const univerRef = useRef(null);
  const apiRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [mountHeight, setMountHeight] = useState(520);

  /**
   * Give Univer's mount point an explicit pixel height, kept in sync with a
   * ResizeObserver, instead of a Tailwind `flex-1` (`flex-basis: 0%`, sized
   * by the flex algorithm).
   *
   * The flex-basis route measured correctly at *this* level — 477px, stable
   * from the first frame, confirmed directly — but Univer's own nested
   * `height: 100%` divs one level in still only resolved to 117px against
   * that same, already-definite 477px parent, and the actual canvas three
   * levels deeper got zero. Neither a `resize` event nor waiting for a
   * stable measurement here changed that number, which means the percentage
   * chain was breaking somewhere inside Univer's own markup, not from a
   * timing race at the boundary this component controls. Univer's mount
   * point mounting with a real, explicit pixel `height` — not a value that
   * itself came from `flex: 1 1 0%` — is what a bare, few-levels-deep test
   * page had by construction and what Approvals' more deeply nested
   * `Card > CardContent > …` layout did not reliably produce; giving Univer
   * an explicit pixel number here removes that ambiguity regardless of how
   * many non-flex ancestors sit above it.
   */
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // The status bar above the mount point is a real, laid-out row, not a
    // fixed guess — its height is subtracted from the wrapper's own so the
    // mount point gets exactly what is actually left, not an approximation.
    const measure = () => {
      const bar = wrapper.querySelector('[data-univer-bar]');
      const total = wrapper.getBoundingClientRect().height;
      const barH = bar ? bar.getBoundingClientRect().height : 0;
      const next = Math.max(200, Math.floor(total - barH));
      setMountHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [readOnly]);

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        if (disposed || !containerRef.current) return;

        const isSheet = kind === 'sheet';
        const [
          { createUniver, LocaleType, UniverInstanceType },
          { defaultTheme },
        ] = await Promise.all([
          import('@univerjs/presets'),
          import('@univerjs/design'),
        ]);

        let preset;
        let locale;
        if (isSheet) {
          const [{ UniverSheetsCorePreset }, sheetsLocale] = await Promise.all([
            import('@univerjs/preset-sheets-core'),
            import('@univerjs/preset-sheets-core/locales/en-US').then((m) => m.default),
          ]);
          preset = UniverSheetsCorePreset({ container: containerRef.current });
          locale = sheetsLocale;
        } else {
          const [{ UniverDocsCorePreset }, docsLocale] = await Promise.all([
            import('@univerjs/preset-docs-core'),
            import('@univerjs/preset-docs-core/locales/en-US').then((m) => m.default),
          ]);
          preset = UniverDocsCorePreset({ container: containerRef.current });
          locale = docsLocale;
        }

        if (disposed || !containerRef.current) return;

        const { univer, univerAPI } = createUniver({
          theme: defaultTheme,
          locale: LocaleType.EN_US,
          locales: { [LocaleType.EN_US]: locale },
          presets: [preset],
        });
        univerRef.current = univer;
        apiRef.current = univerAPI;

        univer.createUnit(isSheet ? UniverInstanceType.UNIVER_SHEET : UniverInstanceType.UNIVER_DOC, snapshot);

        if (readOnly && isSheet) univerAPI.getActiveWorkbook()?.setEditable(false);

        if (!disposed) setReady(true);
      } catch (err) {
        console.error(err);
        if (!disposed) setError(err.message);
      }
    })();

    return () => {
      disposed = true;
      try { univerRef.current?.dispose(); } catch { /* already gone */ }
      univerRef.current = null;
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, snapshot]);

  const save = async () => {
    if (!apiRef.current) return;
    setSaving(true);
    try {
      const unit = kind === 'sheet' ? apiRef.current.getActiveWorkbook() : apiRef.current.getActiveDocument();
      const current = unit?.save();
      if (current) await onSave?.(current);
    } finally {
      setSaving(false);
    }
  };

  const hint = kind === 'sheet'
    ? 'Editable — values and simple formulas round-trip; cell formatting does not.'
    : 'Editable — paragraphs, bold/italic and tables round-trip; headers, images and precise formatting do not.';

  return (
    <div ref={wrapperRef} className="flex h-full min-h-[520px] flex-col overflow-hidden rounded-xl border border-border">
      {!readOnly && (
        <div data-univer-bar
             className="flex flex-none items-center justify-between border-b border-border bg-card px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">{ready ? hint : 'Loading…'}</span>
          <Button size="sm" onClick={save} disabled={!ready || saving} className="h-7 rounded-md text-[11px]">
            <FloppyDisk size={12} weight="bold" /> {saving ? 'Saving…' : 'Save as new version'}
          </Button>
        </div>
      )}
      {error && (
        <div data-univer-bar className="flex-none bg-bad/10 px-3 py-2 text-[11.5px] text-bad">
          Could not load the editor: {error}
        </div>
      )}
      {/* An explicit pixel height, not `flex-1` — see the note above the
          effect that measures it. Univer's own internal `height: 100%` divs
          need a genuinely definite pixel number at this boundary; a
          flex-basis-derived one measured correctly at this element but did
          not propagate to Univer's markup a few levels further in. */}
      <div ref={containerRef} className="bg-white" style={{ height: mountHeight }} />
    </div>
  );
}

export default UniverViewer;
