/**
 * core/engine/docx-bridge.js — real .docx files, in and out of Univer's Doc model.
 *
 * Univer's document model is one flat string (`dataStream`) plus metadata
 * arrays pointing at control characters inside it: `\r` ends a paragraph,
 * `\n` ends a section, and a matched pair of unprintable sentinels
 * (`DataStreamTreeTokenType`) brackets a table, a row, or a cell. There is no
 * higher-level "add a paragraph" API for building a snapshot from outside the
 * editor — the sentinels are the format.
 *
 * `mammoth` gets us from .docx bytes to structured HTML (paragraphs, bold/
 * italic runs, tables); this file walks that HTML and emits Univer's sentinel
 * stream directly. Every shape it produces is checked with Univer's own
 * `validateDocBodyStructure()` before being handed back — this project
 * verified the sentinel convention against that validator in Node, with no
 * browser involved, specifically so mistakes here surface as a thrown error
 * with a list of what is wrong, not as a blank editor and a guess.
 *
 * What survives: paragraph breaks, bold, italic, tables (rows and cells, with
 * per-cell text). What does not: headers/footers, images, lists as real
 * numbered/bulleted structures (they come through as literal "•" text, which
 * is what the source WSR/MOM skills already emit), fonts, and colours. This
 * is a content editor, not a fidelity-preserving round trip — the same
 * honesty the xlsx bridge already applies to cell formatting.
 */

import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';

let UniverCore = null;
/** Lazy — this module is imported from an API route; keep server startup light. */
async function core() {
  if (!UniverCore) UniverCore = await import('@univerjs/core');
  return UniverCore;
}

const TOK = {
  PARAGRAPH: '\r', SECTION_BREAK: '\n',
  TABLE_START: '\u001a', TABLE_END: '\u000f',
  TABLE_ROW_START: '\u001b', TABLE_ROW_END: '\u000e',
  TABLE_CELL_START: '\u001c', TABLE_CELL_END: '\u001d',
};

/**
 * Builds a document body by appending text/paragraph/table pieces and
 * tracking sentinel positions as it goes — the offsets only ever move
 * forward, which is what keeps the bookkeeping tractable.
 */
class BodyBuilder {
  constructor() {
    this.stream = '';
    this.textRuns = [];
    this.paragraphs = [];
    this.tables = [];       // ICustomTable[] — sentinel ranges only
    this.tableSource = {};  // tableId -> ITable — the structural metadata
  }

  get pos() { return this.stream.length; }

  /** Plain text, no sentinel — the caller ends the paragraph separately. */
  text(str, style) {
    if (!str) return;
    const st = this.pos;
    this.stream += str;
    if (style) this.textRuns.push({ st, ed: this.pos, ts: style });
  }

  paragraph() {
    const startIndex = this.pos;
    this.stream += TOK.PARAGRAPH;
    this.paragraphs.push({ startIndex, paragraphId: `p${this.paragraphs.length}_${randomUUID().slice(0, 8)}`, paragraphStyle: {} });
  }

  /**
   * @param rows  string[][] — plain text per cell; every row must be the
   *              same width, padded by the caller if the source was ragged
   */
  table(rows) {
    if (!rows.length) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const tableId = `tbl_${randomUUID().slice(0, 8)}`;
    const startIndex = this.pos;
    this.stream += TOK.TABLE_START;

    const tableRows = rows.map((cells) => {
      this.stream += TOK.TABLE_ROW_START;
      const tableCells = [];
      for (let c = 0; c < cols; c += 1) {
        this.stream += TOK.TABLE_CELL_START;
        this.text(cells[c] || '');
        // A cell is validated the same way the document body itself is: it
        // needs its own paragraph sentinel *and* its own section-break
        // sentinel, not just the paragraph mark. Missing the second one
        // produced 66 "must contain a paragraph and section break child"
        // errors on the very first real document this was tried against.
        this.paragraph();
        this.stream += TOK.SECTION_BREAK;
        this.stream += TOK.TABLE_CELL_END;
        tableCells.push({ size: { width: { v: Math.floor(600 / cols) } } });
      }
      this.stream += TOK.TABLE_ROW_END;
      return { tableCells, trHeight: { val: { v: 24 }, hRule: 1 } };
    });

    this.stream += TOK.TABLE_END;
    const endIndex = this.pos;

    this.tables.push({ startIndex, endIndex, tableId });
    this.tableSource[tableId] = {
      tableId, tableRows,
      tableColumns: Array.from({ length: cols }, () => ({ size: { width: { v: Math.floor(600 / cols) } } })),
      align: 0, indent: { v: 0 }, textWrap: 0,
      position: { positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 0, posOffset: 0 } },
      dist: { distB: 0, distT: 0, distL: 0, distR: 0 },
      size: { type: 0, width: { v: 600 } },
    };
  }

  finish() {
    this.stream += TOK.SECTION_BREAK;
    const sectionBreaks = [{ sectionId: `sec_${randomUUID().slice(0, 8)}`, startIndex: this.pos - 1 }];
    const body = {
      dataStream: this.stream,
      textRuns: this.textRuns,
      paragraphs: this.paragraphs,
      sectionBreaks,
      tables: this.tables,
      customBlocks: [], columnGroups: [], blockRanges: [], customRanges: [], customDecorations: [],
    };
    return [body, this.tableSource];
  }
}

const BOLD = { bl: 1 };
const ITALIC = { it: 1 };
const BOLD_ITALIC = { bl: 1, it: 1 };

/** Walk one <p> or <td>/<th>'s inline content, tracking bold/italic runs. */
function inlineText(builder, $el, $) {
  const walk = (el, bold, italic) => {
    if (el.type === 'text') {
      const style = bold && italic ? BOLD_ITALIC : bold ? BOLD : italic ? ITALIC : null;
      builder.text(el.data, style);
      return;
    }
    const tag = el.tagName;
    const nextBold = bold || tag === 'strong' || tag === 'b';
    const nextItalic = italic || tag === 'em' || tag === 'i';
    for (const child of el.children || []) walk(child, nextBold, nextItalic);
  };
  for (const child of $el.get(0)?.children || []) walk(child, false, false);
}

/** mammoth's own raw-text extraction, for cell content (no nested runs needed). */
const cellPlainText = ($el) => $el.text().replace(/\s+/g, ' ').trim();

/**
 * @returns {Promise<{snapshot, issues}>} `issues` is Univer's own validator
 *   output — empty on success. A caller that gets a non-empty array should
 *   treat the snapshot as unsafe to mount, the same way this bridge does
 *   during its own tests.
 */
export async function docxToSnapshot(buffer, { name = 'Document' } = {}) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const $ = cheerio.load(html, null, false);
  const b = new BodyBuilder();

  for (const el of $.root().children().toArray()) {
    const $el = $(el);
    if (el.tagName === 'p') {
      inlineText(b, $el, $);
      b.paragraph();
    } else if (el.tagName === 'table') {
      const rows = $el.find('tr').toArray().map((tr) =>
        $(tr).find('th,td').toArray().map((cell) => cellPlainText($(cell))));
      b.table(rows);
      b.paragraph();   // a blank paragraph after a table, or the next block has nowhere to attach
    } else if (el.tagName === 'ul' || el.tagName === 'ol') {
      for (const li of $el.find('li').toArray()) {
        b.text(`•  ${cellPlainText($(li))}`);
        b.paragraph();
      }
    } else {
      const text = cellPlainText($el);
      if (text) { b.text(text); b.paragraph(); }
    }
  }

  const [body, tableSource] = b.finish();
  const { getDocsEmptySnapshot, validateDocBodyStructure } = await core();
  const issues = validateDocBodyStructure(body);

  const empty = getDocsEmptySnapshot();
  const snapshot = { ...empty, id: randomUUID(), title: name, body, tableSource };
  return { snapshot, issues };
}

/**
 * The reverse direction: an edited Univer document snapshot → a new .docx.
 *
 * Paragraphs and inline bold/italic survive; tables round-trip as plain text
 * tables (structure and cell text, not borders/shading/column widths — those
 * were never captured on the way in, so there is nothing to write back).
 */
export async function snapshotToDocx(snapshot) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell } = await import('docx');
  const body = snapshot.body || {};
  const stream = body.dataStream || '';
  const runs = [...(body.textRuns || [])].sort((a, b) => a.st - b.st);
  const tableRanges = [...(body.tables || [])].sort((a, b) => a.startIndex - b.startIndex);

  const children = [];
  let cursor = 0;
  let tableIdx = 0;

  const runsIn = (from, to) => runs.filter((r) => r.st >= from && r.ed <= to);

  const paragraphFrom = (text, styleRuns, base) => new Paragraph({
    children: sliceRuns(text, styleRuns, base).map((s) => new TextRun({ text: s.text, bold: !!s.ts?.bl, italics: !!s.ts?.it })),
  });

  function sliceRuns(text, styleRuns, base) {
    if (!styleRuns.length) return [{ text, ts: null }];
    const pieces = [];
    let p = 0;
    for (const r of styleRuns) {
      const relStart = r.st - base;
      const relEnd = r.ed - base;
      if (relStart > p) pieces.push({ text: text.slice(p, relStart), ts: null });
      pieces.push({ text: text.slice(relStart, relEnd), ts: r.ts });
      p = relEnd;
    }
    if (p < text.length) pieces.push({ text: text.slice(p), ts: null });
    return pieces;
  }

  while (cursor < stream.length) {
    // A table sentinel range that starts here takes priority over scanning
    // for the next paragraph mark, since a table's own cells contain `\r`
    // characters that are not top-level paragraph breaks.
    const table = tableRanges[tableIdx];
    if (table && table.startIndex === cursor) {
      const meta = (snapshot.tableSource || {})[
        (body.tables || []).find((t) => t.startIndex === cursor)?.tableId
      ];
      if (meta) {
        children.push(new Table({
          rows: meta.tableRows.map((row) => new TableRow({
            children: row.tableCells.map((cell, i) => new TableCell({
              children: [new Paragraph({ text: cellTextAt(stream, body, table, meta, row, i) })],
            })),
          })),
        }));
      }
      cursor = table.endIndex;
      tableIdx += 1;
      continue;
    }

    const brk = stream.indexOf(TOK.PARAGRAPH, cursor);
    const end = brk === -1 ? stream.length : brk;
    const text = stream.slice(cursor, end);
    if (text.trim()) children.push(paragraphFrom(text, runsIn(cursor, end), cursor));
    cursor = end + 1;
  }

  const doc = new Document({ sections: [{ children: children.length ? children : [new Paragraph('')] }] });
  return Packer.toBuffer(doc);
}

/** Pull one cell's plain text back out of the raw stream between its sentinels. */
function cellTextAt(stream, body, tableRange, meta, row, cellIndex) {
  // Cells do not carry their own stream offsets (see ITableCell) — walking the
  // sentinel-delimited slice for this table and taking the Nth cell body is
  // the documented way to recover it.
  const slice = stream.slice(tableRange.startIndex, tableRange.endIndex);
  const cells = [];
  let i = 0;
  while (i < slice.length) {
    const cs = slice.indexOf(TOK.TABLE_CELL_START, i);
    if (cs === -1) break;
    const ce = slice.indexOf(TOK.TABLE_CELL_END, cs);
    cells.push(slice.slice(cs + 1, ce).replace(new RegExp(TOK.PARAGRAPH, 'g'), '').trim());
    i = ce + 1;
  }
  const rowIdx = meta.tableRows.indexOf(row);
  return cells[rowIdx * (meta.tableColumns?.length || 1) + cellIndex] ?? '';
}
