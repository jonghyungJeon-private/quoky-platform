import {
  DRIVE_SHEETS_MAX,
  DRIVE_SHEET_TITLE_MAX_LENGTH,
  DRIVE_TEXT_MAX_BYTES,
  boundDriveLine,
  type DriveDocumentSection,
} from '@quoky/core';
import { GDriveEndpointNotAllowedError, GDriveResponseError } from './errors';
import { decodeBoundedUtf8 } from './text';

/**
 * DRV-2b (ADR-0118 amendment 2026-10-12 (c)): every grid sheet of a Google Sheets spreadsheet, read through the Google
 * Sheets API v4 under the existing `drive.readonly` grant (`spreadsheets.get` and `spreadsheets.values.batchGet` both
 * accept it; no new scope, no new consent). This module holds the pinned host, the request guard, the URL builders and
 * the bounded parsing; the guarded GET itself is the Drive reader's single request site (`gdrive-reader.ts`).
 *
 * - **Pinned host, GET only, two paths:** `GET /v4/spreadsheets/{id}` with a fixed `fields` mask (sheet titles, indexes
 *   and types: no grid data, no formulas, no links, no protected ranges), then
 *   `GET /v4/spreadsheets/{id}/values:batchGet` with one bounded A1 range per sheet, values only
 *   (`valueRenderOption=FORMATTED_VALUE`: what the cell shows, never its formula), by rows. No write method exists.
 * - **Bounds:** at most {@link DRIVE_SHEETS_MAX} grid sheets (chart and data-source sheets are skipped), at most
 *   {@link GSHEETS_MAX_COLUMNS} columns and a row bound that keeps the whole read under {@link GSHEETS_MAX_CELLS} cells,
 *   each cell cut at {@link GSHEETS_CELL_MAX_CHARS}, and the whole text (titles included) cut at
 *   {@link DRIVE_TEXT_MAX_BYTES} across sheets. Every JSON answer is size-bounded by the caller.
 * - **Untrusted:** a sheet title and every cell are written by whoever edits the spreadsheet. A title is sent back to
 *   Google only inside a quoted A1 range (apostrophes doubled), and returned to Core as bounded one-line data.
 */

/** The only Sheets API origin the reader may call. Pinned: never built from configuration or response data. */
export const GSHEETS_API_ORIGIN = 'https://sheets.googleapis.com';
/** The source's per-sheet read, named for the owner's note when it is not enabled (the GML-1 review P3-6 rule). */
export const GSHEETS_SERVICE_LABEL = 'Google Sheets API';
const SPREADSHEET_PATH = /^\/v4\/spreadsheets\/[A-Za-z0-9_-]{1,128}$/;
const VALUES_PATH = /^\/v4\/spreadsheets\/[A-Za-z0-9_-]{1,128}\/values:batchGet$/;
/** The spreadsheet metadata mask: sheet titles, indexes and types only. */
export const GSHEETS_META_FIELDS = 'sheets.properties(title,index,sheetType)';
/** The values mask: the values of each range only (no range echo, no spreadsheet id). */
export const GSHEETS_VALUES_FIELDS = 'valueRanges.values';
/** Values only, by rows: never `FORMULA`, never `UNFORMATTED_VALUE`. */
export const GSHEETS_VALUE_RENDER_OPTION = 'FORMATTED_VALUE';
export const GSHEETS_MAJOR_DIMENSION = 'ROWS';
/** Columns A..Z of each sheet. */
export const GSHEETS_MAX_COLUMNS = 26;
const LAST_COLUMN = 'Z';
/** No sheet is read past this row. */
export const GSHEETS_MAX_ROWS_PER_SHEET = 1000;
/** All ranges of one read together cover at most this many cells. */
export const GSHEETS_MAX_CELLS = 40_000;
/** One cell's text is cut to this many UTF-16 units (a cell can hold 50,000 characters). */
export const GSHEETS_CELL_MAX_CHARS = 1_000;
/** A raw sheet title longer than this is not addressed (the sheet is skipped and the read marked truncated). */
export const GSHEETS_RAW_TITLE_MAX_UNITS = 256;
/** Response bounds (bytes). A larger answer is refused unread. */
export const GSHEETS_META_MAX_BYTES = 64 * 1024;
export const GSHEETS_VALUES_MAX_BYTES = 4 * 1024 * 1024;
/** A metadata answer listing more sheets than this is malformed (the product limit is far lower). */
const GSHEETS_META_MAX_ENTRIES = 1_000;

const RANGE = /^'((?:[^']|''){1,512})'!A1:Z([1-9][0-9]{0,3})$/;

/**
 * Refuses any Sheets request outside the read-only allowlist BEFORE it is sent: GET, the pinned origin, and exactly one
 * of `spreadsheets/{id}` with the fixed metadata mask, or `spreadsheets/{id}/values:batchGet` with 1..20 bounded A1
 * ranges, the fixed values mask, `FORMATTED_VALUE` and `ROWS`. No other parameter (`includeGridData`, `ranges` on the
 * metadata read, `valueRenderOption=FORMULA`, …) can pass.
 */
export function assertGSheetsReadRequest(url: URL, method: string): void {
  if (method !== 'GET') throw new GDriveEndpointNotAllowedError();
  if (url.origin !== GSHEETS_API_ORIGIN || url.username || url.password || url.hash) throw new GDriveEndpointNotAllowedError();
  const keys = [...url.searchParams.keys()];
  if (SPREADSHEET_PATH.test(url.pathname)) {
    if (keys.length !== 1 || url.searchParams.get('fields') !== GSHEETS_META_FIELDS) throw new GDriveEndpointNotAllowedError();
    return;
  }
  if (VALUES_PATH.test(url.pathname)) {
    const allowed = new Set(['ranges', 'fields', 'valueRenderOption', 'majorDimension']);
    if (keys.some((key) => !allowed.has(key))) throw new GDriveEndpointNotAllowedError();
    for (const single of ['fields', 'valueRenderOption', 'majorDimension']) {
      if (url.searchParams.getAll(single).length !== 1) throw new GDriveEndpointNotAllowedError();
    }
    if (
      url.searchParams.get('fields') !== GSHEETS_VALUES_FIELDS ||
      url.searchParams.get('valueRenderOption') !== GSHEETS_VALUE_RENDER_OPTION ||
      url.searchParams.get('majorDimension') !== GSHEETS_MAJOR_DIMENSION
    ) {
      throw new GDriveEndpointNotAllowedError();
    }
    const ranges = url.searchParams.getAll('ranges');
    if (ranges.length < 1 || ranges.length > DRIVE_SHEETS_MAX || new Set(ranges).size !== ranges.length) throw new GDriveEndpointNotAllowedError();
    let cells = 0;
    for (const range of ranges) {
      const match = RANGE.exec(range);
      const rows = match === null ? Number.NaN : Number(match[2]);
      if (!Number.isInteger(rows) || rows > GSHEETS_MAX_ROWS_PER_SHEET) throw new GDriveEndpointNotAllowedError();
      cells += rows * GSHEETS_MAX_COLUMNS;
    }
    if (cells > GSHEETS_MAX_CELLS) throw new GDriveEndpointNotAllowedError();
    return;
  }
  throw new GDriveEndpointNotAllowedError();
}

/** The metadata read of one spreadsheet (the id is validated by the caller). */
export function gsheetsMetaUrl(id: string): URL {
  const url = new URL(`/v4/spreadsheets/${encodeURIComponent(id)}`, GSHEETS_API_ORIGIN);
  url.searchParams.set('fields', GSHEETS_META_FIELDS);
  return url;
}

/** One grid sheet to read: its exact title (to address it) and its position. */
export interface GSheetTarget {
  readonly rawTitle: string;
  readonly index: number;
}

export interface GSheetTargets {
  readonly sheets: readonly GSheetTarget[];
  /** Grid sheets left out: beyond {@link DRIVE_SHEETS_MAX}, or with a title too long to address. */
  readonly dropped: boolean;
}

/** The grid sheets of a metadata answer, in sheet order, bounded; chart and data-source sheets are skipped. */
export function parseGSheetTargets(payload: Record<string, unknown>): GSheetTargets {
  const listed = payload.sheets === undefined ? [] : payload.sheets;
  if (!Array.isArray(listed) || listed.length > GSHEETS_META_MAX_ENTRIES) throw new GDriveResponseError('sheets');
  const grid: GSheetTarget[] = [];
  let dropped = false;
  for (const entry of listed) {
    const properties = isRecord(entry) && isRecord(entry.properties) ? entry.properties : undefined;
    if (properties === undefined) throw new GDriveResponseError('sheets');
    // An omitted type is the default (a grid); anything else (a chart, a data source) has no cell values to read.
    if (properties.sheetType !== undefined && properties.sheetType !== 'GRID') continue;
    const title = properties.title;
    const index = properties.index === undefined ? 0 : properties.index;
    if (typeof title !== 'string' || title.length === 0 || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new GDriveResponseError('sheets');
    }
    if (title.length > GSHEETS_RAW_TITLE_MAX_UNITS) {
      dropped = true;
      continue;
    }
    grid.push({ rawTitle: title, index });
  }
  grid.sort((a, b) => a.index - b.index);
  if (new Set(grid.map((sheet) => sheet.rawTitle)).size !== grid.length) throw new GDriveResponseError('sheets');
  return { sheets: grid.slice(0, DRIVE_SHEETS_MAX), dropped: dropped || grid.length > DRIVE_SHEETS_MAX };
}

/** Rows read per sheet so that all ranges together stay within {@link GSHEETS_MAX_CELLS}. */
export function gsheetsRowsPerSheet(sheetCount: number): number {
  const count = Math.max(1, Math.min(sheetCount, DRIVE_SHEETS_MAX));
  return Math.max(1, Math.min(GSHEETS_MAX_ROWS_PER_SHEET, Math.floor(GSHEETS_MAX_CELLS / (count * GSHEETS_MAX_COLUMNS))));
}

/** A bounded A1 range for an untrusted title: always quoted, every apostrophe doubled (the Sheets A1 rule). */
export function gsheetsRange(rawTitle: string, rows: number): string {
  return `'${rawTitle.replace(/'/g, "''")}'!A1:${LAST_COLUMN}${rows}`;
}

/** The values read of the given sheets (values only, by rows, each range bounded). */
export function gsheetsValuesUrl(id: string, sheets: readonly GSheetTarget[], rows: number): URL {
  const url = new URL(`/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet`, GSHEETS_API_ORIGIN);
  for (const sheet of sheets) url.searchParams.append('ranges', gsheetsRange(sheet.rawTitle, rows));
  url.searchParams.set('fields', GSHEETS_VALUES_FIELDS);
  url.searchParams.set('valueRenderOption', GSHEETS_VALUE_RENDER_OPTION);
  url.searchParams.set('majorDimension', GSHEETS_MAJOR_DIMENSION);
  return url;
}

export interface GSheetsText {
  readonly sections: readonly DriveDocumentSection[];
  /** The sections joined (`[title]` then the rows), at most {@link DRIVE_TEXT_MAX_BYTES} of UTF-8. */
  readonly text: string;
  /** A sheet, a row, a column, a cell or the end of the text was left out. */
  readonly truncated: boolean;
}

/**
 * The text of a values answer: one CSV-style line per row (a cell's line breaks and tabs become spaces, a cell holding a
 * comma or a quote is quoted), each cell cut at {@link GSHEETS_CELL_MAX_CHARS}, the whole cut at
 * {@link DRIVE_TEXT_MAX_BYTES} (titles and separators counted) at a row boundary, or inside the row that crosses it on a
 * code-point boundary. Linear in the (already size-bounded) answer.
 */
export function renderGSheetsValues(payload: Record<string, unknown>, targets: GSheetTargets, rows: number): GSheetsText {
  const ranges = payload.valueRanges === undefined ? [] : payload.valueRanges;
  if (!Array.isArray(ranges) || ranges.length !== targets.sheets.length) throw new GDriveResponseError('sheets');
  const sections: DriveDocumentSection[] = [];
  const joined: string[] = [];
  let truncated = targets.dropped;
  let budget = DRIVE_TEXT_MAX_BYTES;
  for (const [position, target] of targets.sheets.entries()) {
    const range = ranges[position];
    if (!isRecord(range)) throw new GDriveResponseError('sheets');
    const values = range.values === undefined ? [] : range.values;
    if (!Array.isArray(values) || values.length > rows) throw new GDriveResponseError('sheets');
    if (values.length === rows) truncated = true; // there may be more rows below the bound
    const title = boundDriveLine(target.rawTitle, DRIVE_SHEET_TITLE_MAX_LENGTH);
    const header = `${position > 0 ? '\n\n' : ''}[${title}]\n`;
    const headerBytes = Buffer.byteLength(header, 'utf8');
    if (headerBytes > budget) {
      truncated = true;
      break;
    }
    budget -= headerBytes;
    const lines: string[] = [];
    let cut = false;
    for (const row of values) {
      if (!Array.isArray(row) || row.length > GSHEETS_MAX_COLUMNS) throw new GDriveResponseError('sheets');
      if (row.length === GSHEETS_MAX_COLUMNS) truncated = true; // there may be more columns to the right
      const rendered = row.map((cell) => renderCell(cell, () => (truncated = true)));
      // Trailing empty cells are dropped from the array (no regex over a hostile, comma-heavy line).
      while (rendered.length > 0 && rendered[rendered.length - 1] === '') rendered.pop();
      const line = `${lines.length > 0 ? '\n' : ''}${rendered.join(',')}`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > budget) {
        const partial = decodeBoundedUtf8(Buffer.from(line, 'utf8'), budget).text;
        if (partial.length > 0) lines.push(partial);
        budget = 0;
        cut = true;
        break;
      }
      budget -= bytes;
      lines.push(line);
    }
    const text = lines.join('');
    sections.push({ title, text });
    joined.push(header, text);
    if (cut) {
      truncated = true;
      break;
    }
  }
  if (sections.length < targets.sheets.length) truncated = true;
  return { sections, text: joined.join(''), truncated };
}

/** One cell as text: a string, number or boolean value only (anything else is empty), one line, bounded, CSV-quoted. */
function renderCell(cell: unknown, onCut: () => void): string {
  let raw = typeof cell === 'string' ? cell : typeof cell === 'number' || typeof cell === 'boolean' ? String(cell) : '';
  if (raw.length > GSHEETS_CELL_MAX_CHARS) {
    onCut();
    let end = GSHEETS_CELL_MAX_CHARS;
    // Never split a surrogate pair.
    const last = raw.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    raw = raw.slice(0, end);
  }
  const line = raw.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
  return /[",]/.test(line) ? `"${line.replace(/"/g, '""')}"` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
