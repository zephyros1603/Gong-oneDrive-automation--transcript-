'use client';

/**
 * components/SpreadsheetViewer.jsx — an .xlsx, mounted with Univer.
 *
 * Univer's open packages don't read or write real .xlsx bytes — the server
 * side (core/engine/xlsx-bridge.js) converts to and from its own workbook
 * snapshot with `xlsx` (SheetJS). What survives that round trip is values and
 * simple formulas; cell formatting is not attempted and would be a second,
 * separate piece of work.
 *
 * Univer instantiates itself into a DOM container it owns directly — not
 * through React's own render — so this component's whole job is creating
 * that container, handing Univer the snapshot once, and getting the edited
 * snapshot back out through its Facade API when asked. It is torn down and
 * rebuilt from scratch on unmount, since Univer keeps no illusions about
 * being a well-behaved React citizen.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FloppyDisk, ArrowClockwise } from '@phosphor-icons/react';

export function SpreadsheetViewer({ snapshot, onSave, readOnly = false }) {
  const containerRef = useRef(null);
  const univerRef = useRef(null);
  const apiRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        const [
          { Univer, LocaleType, UniverInstanceType },
          { defaultTheme },
          { UniverRenderEnginePlugin },
          { UniverFormulaEnginePlugin },
          { UniverUIPlugin },
          { UniverDocsPlugin },
          { UniverDocsUIPlugin },
          { UniverSheetsPlugin },
          { UniverSheetsUIPlugin },
          { UniverSheetsFormulaPlugin },
          { UniverSheetsFormulaUIPlugin },
          { UniverSheetsNumfmtPlugin },
          { UniverSheetsNumfmtUIPlugin },
          { FUniver },
          // Every plugin above ships its own UI strings; the LocaleService
          // throws ("Locale not initialized") unless they are all merged into
          // the constructor up front. There is no default — an empty
          // `locales` object is exactly as broken as no plugins at all.
          designLocale, docsUiLocale, formulaEngineLocale, sheetsLocale,
          sheetsUiLocale, sheetsFormulaLocale, sheetsFormulaUiLocale,
          sheetsNumfmtUiLocale, uiLocale,
        ] = await Promise.all([
          import('@univerjs/core'),
          import('@univerjs/design'),
          import('@univerjs/engine-render'),
          import('@univerjs/engine-formula'),
          import('@univerjs/ui'),
          import('@univerjs/docs'),
          import('@univerjs/docs-ui'),
          import('@univerjs/sheets'),
          import('@univerjs/sheets-ui'),
          import('@univerjs/sheets-formula'),
          import('@univerjs/sheets-formula-ui'),
          import('@univerjs/sheets-numfmt'),
          import('@univerjs/sheets-numfmt-ui'),
          import('@univerjs/core/facade'),
          // Side-effect only: these register `FWorkbook.save()` and friends
          // onto the Facade API. Without them `getActiveWorkbook()` exists
          // but the object it returns has none of the sheet-specific methods.
          import('@univerjs/sheets/facade'),
          import('@univerjs/sheets-ui/facade'),
          import('@univerjs/design/locale/en-US').then((m) => m.default),
          import('@univerjs/docs-ui/locale/en-US').then((m) => m.default),
          import('@univerjs/engine-formula/locale/en-US').then((m) => m.default),
          import('@univerjs/sheets/locale/en-US').then((m) => m.default),
          import('@univerjs/sheets-ui/locale/en-US').then((m) => m.default),
          import('@univerjs/sheets-formula/locale/en-US').then((m) => m.default),
          import('@univerjs/sheets-formula-ui/locale/en-US').then((m) => m.default),
          import('@univerjs/sheets-numfmt-ui/locale/en-US').then((m) => m.default),
          import('@univerjs/ui/locale/en-US').then((m) => m.default),
        ]);

        if (disposed || !containerRef.current) return;

        const enUS = Object.assign(
          {}, designLocale, docsUiLocale, formulaEngineLocale, sheetsLocale,
          sheetsUiLocale, sheetsFormulaLocale, sheetsFormulaUiLocale,
          sheetsNumfmtUiLocale, uiLocale
        );

        const univer = new Univer({
          theme: defaultTheme,
          locale: LocaleType.EN_US,
          locales: { [LocaleType.EN_US]: enUS },
        });
        univerRef.current = univer;

        univer.registerPlugin(UniverRenderEnginePlugin);
        univer.registerPlugin(UniverFormulaEnginePlugin);
        univer.registerPlugin(UniverUIPlugin, { container: containerRef.current });
        univer.registerPlugin(UniverDocsPlugin);
        univer.registerPlugin(UniverDocsUIPlugin);
        univer.registerPlugin(UniverSheetsPlugin);
        univer.registerPlugin(UniverSheetsUIPlugin);
        univer.registerPlugin(UniverSheetsFormulaPlugin);
        univer.registerPlugin(UniverSheetsFormulaUIPlugin);
        univer.registerPlugin(UniverSheetsNumfmtPlugin);
        univer.registerPlugin(UniverSheetsNumfmtUIPlugin);

        univer.createUnit(UniverInstanceType.UNIVER_SHEET, snapshot);
        apiRef.current = FUniver.newAPI(univer);

        // `readOnly` on this component only hid the Save button until this
        // line — the grid itself stayed editable regardless, since hiding a
        // button and disabling the workbook are two different things.
        if (readOnly) apiRef.current.getActiveWorkbook()?.setEditable(false);

        // Univer measures its container's size once, synchronously, at
        // mount. Coming from a dynamic import chain inside a flex-grow child
        // (`flex-1`, no explicit height of its own — the number comes from
        // the parent's layout), that measurement can land before the browser
        // has actually resolved this render's flex layout, and Univer reads
        // a real height of 0 permanently: nothing later re-triggers it. A
        // resize event on the next frame is what its internal ResizeObserver
        // is already listening for, and forcing one is cheap insurance
        // against a race that ordinary re-renders do not reliably win.
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

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
    // Mounted once per `snapshot` identity — a new file means a fresh Univer
    // instance, not a diff applied to the live one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const save = async () => {
    if (!apiRef.current) return;
    setSaving(true);
    try {
      const wb = apiRef.current.getActiveWorkbook();
      const current = wb.save();   // the live IWorkbookData, edits included
      await onSave?.(current);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-[520px] flex-col overflow-hidden rounded-xl border border-border">
      {!readOnly && (
        <div className="flex flex-none items-center justify-between border-b border-border bg-card px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {ready ? 'Editable — values and simple formulas round-trip; cell formatting does not.' : 'Loading…'}
          </span>
          <Button size="sm" onClick={save} disabled={!ready || saving} className="h-7 rounded-md text-[11px]">
            <FloppyDisk size={12} weight="bold" /> {saving ? 'Saving…' : 'Save as new version'}
          </Button>
        </div>
      )}
      {error && (
        <div className="flex-none bg-bad/10 px-3 py-2 text-[11.5px] text-bad">
          Could not load the spreadsheet editor: {error}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 bg-white" style={{ height: 520 }} />
    </div>
  );
}

export default SpreadsheetViewer;
