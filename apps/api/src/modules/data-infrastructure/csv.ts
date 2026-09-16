/**
 * Pure CSV helpers (RFC 4180): serialisation for exports and parsing for the
 * import engine. No dependencies, no I/O.
 */

export type CsvCell = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvCell;
}

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialises rows to CSV text with a header line and CRLF line ends. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export interface ParsedCsv {
  headers: string[];
  /** One record per data line, keyed by header; `line` is the 1-based file line. */
  rows: Array<{ line: number; values: Record<string, string> }>;
}

/**
 * Parses CSV text: quoted fields, escaped quotes, embedded line breaks, CRLF or
 * LF, optional BOM. Headers are trimmed; blank lines are skipped; a record with
 * more cells than headers keeps the extras under `_extraN`.
 */
export function parseCsv(text: string, options: { maxRows?: number } = {}): ParsedCsv {
  const records: string[][] = [];
  const lineNumbers: number[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const push = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    push();
    if (record.length > 1 || record[0] !== '') {
      records.push(record);
      lineNumbers.push(recordLine);
    }
    record = [];
    recordLine = line;
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') push();
    else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      line += 1;
      endRecord();
    } else if (ch === '\n') {
      line += 1;
      endRecord();
    } else field += ch;
  }
  if (field !== '' || record.length > 0) {
    push();
    if (record.length > 1 || record[0] !== '') {
      records.push(record);
      lineNumbers.push(recordLine);
    }
  }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0]!.map((h) => h.trim());
  const rows = records
    .slice(1, options.maxRows ? options.maxRows + 1 : undefined)
    .map((cells, i) => {
      const values: Record<string, string> = {};
      cells.forEach((cell, j) => {
        const key = headers[j] ?? `_extra${j - headers.length + 1}`;
        values[key] = cell.trim();
      });
      return { line: lineNumbers[i + 1]!, values };
    });
  return { headers, rows };
}
