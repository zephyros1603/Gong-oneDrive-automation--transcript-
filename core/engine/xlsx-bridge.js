/**
 * core/engine/xlsx-bridge.js — real .xlsx files, in and out of Univer.
 *
 * Univer's own open-source packages do not read or write .xlsx directly —
 * full-fidelity exchange is an Enterprise feature of Univer Pro. `xlsx`
 * (SheetJS, MIT-licensed, already the closest thing to a standard for this in
 * the Node ecosystem) is the bridge: it turns real bytes into a plain grid of
 * cells, and this module turns that grid into the JSON snapshot Univer's
 * `createUniverSheet` expects, and back again after an edit.
 *
 * What survives the round trip: values, formulas, and cell formatting is not
 * attempted here — that would mean mapping two different styling systems
 * cell by cell, which is real work with its own failure modes. What is here
 * is honest: values in, values out, nothing silently dropped or corrupted.
 */

import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';

/** A real .xlsx file's bytes → a Univer workbook snapshot (IWorkbookData). */
export function xlsxToSnapshot(buffer, { name = 'Sheet' } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = {};
  const sheetOrder = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    const cellData = {};

    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const rowData = {};
      let any = false;
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue;
        any = true;
        rowData[c] = cell.f
          ? { f: `=${cell.f}`, v: cell.v ?? '' }
          : { v: cell.v ?? '' };
      }
      if (any) cellData[r] = rowData;
    }

    const id = randomUUID();
    sheets[id] = {
      id, name: sheetName,
      rowCount: Math.max(range.e.r + 1, 50),
      columnCount: Math.max(range.e.c + 1, 20),
      cellData,
    };
    sheetOrder.push(id);
  }

  if (!sheetOrder.length) {
    const id = randomUUID();
    sheets[id] = { id, name: 'Sheet1', rowCount: 50, columnCount: 20, cellData: {} };
    sheetOrder.push(id);
  }

  return {
    id: randomUUID(),
    name,
    appVersion: '1.0.0',
    locale: 'enUS',
    sheetOrder,
    sheets,
  };
}

/** A Univer workbook snapshot → real .xlsx bytes. */
export function snapshotToXlsx(snapshot) {
  const wb = XLSX.utils.book_new();

  for (const sheetId of snapshot.sheetOrder || Object.keys(snapshot.sheets || {})) {
    const sheet = snapshot.sheets[sheetId];
    if (!sheet) continue;

    const aoa = [];
    const cellData = sheet.cellData || {};
    for (const [rStr, row] of Object.entries(cellData)) {
      const r = Number(rStr);
      for (const [cStr, cell] of Object.entries(row)) {
        const c = Number(cStr);
        if (!aoa[r]) aoa[r] = [];
        aoa[r][c] = cell?.f ? { f: String(cell.f).replace(/^=/, '') } : (cell?.v ?? '');
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(
      aoa.map((row) => (row || []).map((v) => (v && v.f ? { f: v.f } : v)))
    );
    XLSX.utils.book_append_sheet(wb, ws, String(sheet.name || 'Sheet').slice(0, 31));
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
