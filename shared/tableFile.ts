/**
 * Turning a loosely formatted spreadsheet (a CSV someone exported, or an
 * Excel sheet) into a clean table for "Import with Claude".
 *
 * Used on both sides: the browser parses the file the reviewer picked
 * (CSV text here; Excel via read-excel-file) into plain string rows, and
 * the server runs `prepareTable` again on whatever it receives, because
 * anything the browser sends is untrusted.
 *
 * Deliberately forgiving: no fixed columns, no required header names, and
 * nothing dropped. This layer only decides structure (which row is the
 * header, which rows/columns are empty). Identity/demographic columns are
 * KEPT (Andrew's call, 2026-11-18) and listed in `identityColumns`, so the
 * preview can say Claude will record what they state — labeled as from
 * this file and row, and confirmed by a reviewer on approve.
 */

/** Longest single cell kept, in characters. Longer cells are shortened and counted in `shortenedCells`. */
export const MAX_CELL_CHARS = 2_000;

/** How far down the file to look for the header row (title/notes rows often sit above it). */
const HEADER_SEARCH_ROWS = 20;

/**
 * Header words that mark an identity/demographic column (reported, not removed). Matched against
 * whole words of the normalized header ("Latino-led?" → "latino led"), so
 * "Traction" or "Grace period" never match "race".
 */
const IDENTITY_WORDS = [
  'identity', 'demographic', 'demographics', 'ethnicity', 'ethnic', 'race', 'racial', 'gender', 'sex',
  'latino', 'latina', 'latinx', 'latine', 'hispanic', 'bipoc', 'poc', 'minority', 'diverse', 'diversity',
  'lgbt', 'lgbtq', 'lgbtqia', 'queer', 'veteran', 'disability', 'disabled', 'religion', 'nationality',
];
/** Multi-word identity phrases (after normalization), e.g. "female led", "women owned". */
const IDENTITY_PHRASES = [/\b(female|women|woman|black|immigrant)\s*(led|owned|founded|founder|founders)\b/, /\bfemaleled\b/, /\blatinoled\b/];

function normalizeHeader(h: string): string {
  return h
    .replace(/([a-z])([A-Z])/g, '$1 $2') // latinoLed → latino Led
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when a column header names founder identity/demographic data. */
export function isIdentityColumn(header: string): boolean {
  const norm = normalizeHeader(header);
  if (!norm) return false;
  const words = new Set(norm.split(' '));
  if (IDENTITY_WORDS.some((w) => words.has(w))) return true;
  return IDENTITY_PHRASES.some((re) => re.test(norm));
}

/**
 * Parse delimited text into raw rows. Sniffs the delimiter (comma,
 * semicolon — common in European Excel exports — or tab) from the first
 * non-blank line, honours double-quote escaping, and allows line breaks
 * inside quoted cells. Strips a leading byte-order mark.
 */
export function parseDelimitedRows(text: string): string[][] {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const delimiter = sniffDelimiter(normalized);
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  const pushCell = () => { row.push(cur); cur = ''; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"' && normalized[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') { cur = ''; inQuotes = true; }
    else if (ch === delimiter) pushCell();
    else if (ch === '\n') pushRow();
    else cur += ch;
  }
  if (cur.length > 0 || row.length > 0) pushRow();
  return rows;
}

function sniffDelimiter(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/** Render any spreadsheet cell value (string, number, boolean, Date, null) as plain text. */
export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  return String(value);
}

export interface PreparedRow {
  /** 1-based row number as the reviewer sees it in their spreadsheet program. */
  rowNumber: number;
  cells: string[];
}

export interface PreparedTable {
  header: string[];
  rows: PreparedRow[];
  /** Kept columns whose headers name founder identity/demographic data. */
  identityColumns: string[];
  /** Non-empty rows above the detected header (titles, notes) that were ignored. */
  skippedLeadingRows: number;
  /** Cells longer than MAX_CELL_CHARS that were shortened. */
  shortenedCells: number;
}

/**
 * Clean raw rows into a table: trim cells, find the header row, drop blank
 * rows and columns, name unnamed columns, and note identity columns.
 */
export function prepareTable(raw: readonly (readonly unknown[])[]): PreparedTable {
  let shortenedCells = 0;
  const rows = raw.map((r) => (Array.isArray(r) ? r : []).map((c) => {
    const text = cellToText(c).replace(/\s+/g, (ws) => (ws.includes('\n') ? '\n' : ' ')).trim();
    if (text.length > MAX_CELL_CHARS) {
      shortenedCells += 1;
      return `${text.slice(0, MAX_CELL_CHARS)}…`;
    }
    return text;
  }));

  const filled = (r: string[]) => r.filter((c) => c.length > 0).length;
  const searchEnd = Math.min(rows.length, HEADER_SEARCH_ROWS);
  const maxFilled = Math.max(0, ...rows.slice(0, searchEnd).map(filled));
  // The header is the first row that is "about as wide" as the table:
  // a title like "Q3 deal flow — DO NOT SHARE" fills one cell, the real
  // header fills most of them.
  const threshold = Math.max(2, Math.ceil(maxFilled * 0.5));
  let headerIndex = rows.findIndex((r, i) => i < searchEnd && filled(r) >= threshold);
  if (headerIndex === -1) headerIndex = rows.findIndex((r) => filled(r) > 0);
  if (headerIndex === -1) {
    return { header: [], rows: [], identityColumns: [], skippedLeadingRows: 0, shortenedCells };
  }
  const skippedLeadingRows = rows.slice(0, headerIndex).filter((r) => filled(r) > 0).length;

  const width = Math.max(...rows.slice(headerIndex).map((r) => r.length));
  const headerRow = rows[headerIndex];
  const dataRows = rows
    .map((cells, i) => ({ rowNumber: i + 1, cells }))
    .slice(headerIndex + 1)
    .filter((r) => filled(r.cells) > 0);

  // Keep a column when it has a header or any data at all.
  const keep: number[] = [];
  const identityColumns: string[] = [];
  const header: string[] = [];
  const seen = new Map<string, number>();
  for (let col = 0; col < width; col++) {
    const name = headerRow[col] ?? '';
    const hasData = dataRows.some((r) => (r.cells[col] ?? '').length > 0);
    if (!name && !hasData) continue;
    let label = name || `Column ${col + 1}`;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    if (n > 1) label = `${label} (${n})`;
    if (name && isIdentityColumn(name)) identityColumns.push(label);
    keep.push(col);
    header.push(label);
  }

  return {
    header,
    rows: dataRows
      .map((r) => ({ rowNumber: r.rowNumber, cells: keep.map((col) => r.cells[col] ?? '') }))
      .filter((r) => r.cells.some((c) => c.length > 0)),
    identityColumns,
    skippedLeadingRows,
    shortenedCells,
  };
}

/**
 * One row as the text Claude reads: only its non-empty cells, each as
 * "Header: value". Sparse spreadsheets cost far fewer tokens this way
 * than as raw CSV, and Claude never has to count commas to know which
 * column a value belongs to.
 */
export function rowAsText(header: readonly string[], row: PreparedRow): string {
  const lines = [`Row ${row.rowNumber}`];
  row.cells.forEach((value, i) => {
    if (value) lines.push(`- ${header[i]}: ${value.replace(/\n/g, ' / ')}`);
  });
  return lines.join('\n');
}
