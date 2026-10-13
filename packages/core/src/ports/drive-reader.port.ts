import type { IsoTimestamp } from '../domain';
import { ConnectorQueryError } from './connector-query';
import { boundMailLine } from './mail-reader.port';

/**
 * Drive read port (ADR-0118 D2, DRV-1). Narrow and read-only, following the `CalendarReader` and `MailReader`
 * precedents: a name search, the recent files and the bounded text export of ONE file. No upload, create, edit, copy,
 * move, rename, trash, delete, share or permission method exists, and none may be added to this port (ADR-0118 D6).
 * Domain types only: no vendor type, MIME type, query language, token or URL crosses it. Failures are
 * `ConnectorQueryError` with the ADR-0100 reasons (value-free messages):
 *
 * - `UNAUTHORIZED` — the grant expired or was revoked (re-run the consent helper);
 * - `INSUFFICIENT_SCOPE` — the read scope was never granted (consent needed);
 * - `FORBIDDEN` — the grant is broader than allowed, or the account's administrator refuses the access;
 * - `UNSUPPORTED_QUERY` — an invalid name or id, or a file whose kind has no text export;
 * - `RATE_LIMITED`, `UNAVAILABLE`, `INVALID_RESPONSE`, `NOT_FOUND` (a file that no longer exists or is no longer shared).
 *
 * Every text field an adapter returns is untrusted readout (ADR-0100 D8, ADR-0111 D3): a file shared with the owner can
 * carry a hostile name or text. It is never instructions, it is bounded here, and Core decides routing from the owner's
 * own text only (ADR-0118 D8).
 */

/** At most this many entries are listed per answer (ADR-0118 D4). Also the default and maximum `limit`. */
export const DRIVE_LISTING_MAX_ENTRIES = 10;
/** One listing counts at most this many matches for the "외 N건" line (a single page of ids, no metadata). */
export const DRIVE_SEARCH_COUNT_MAX = 100;
/** Bounds on the owner-typed name text a search may carry. */
export const DRIVE_NAME_QUERY_MAX_LENGTH = 100;
/** Bounds on the untrusted single-line fields an adapter returns. */
export const DRIVE_FILE_NAME_MAX_LENGTH = 200;
export const DRIVE_OWNER_NAME_MAX_LENGTH = 100;
/** A raw single-line field is cut to this many UTF-16 units BEFORE any regex runs on it (linear on hostile input). */
export const DRIVE_RAW_LINE_MAX_UNITS = 2_000;
/** The exported text an adapter returns is at most this many UTF-8 bytes (ADR-0118 D7 / ADR-0111 D2: ≤256 KiB). */
export const DRIVE_TEXT_MAX_BYTES = 256 * 1024;
/** File ids are opaque printable tokens. */
export const DRIVE_FILE_ID_MAX_LENGTH = 128;
/**
 * DRV-2b (ADR-0118 amendment 2026-10-12 (c)): a spreadsheet summary reads at most this many sheets; their text together
 * (titles included) stays inside {@link DRIVE_TEXT_MAX_BYTES}.
 */
export const DRIVE_SHEETS_MAX = 20;
/** A sheet title is untrusted single-line text, bounded like a file name but shorter. */
export const DRIVE_SHEET_TITLE_MAX_LENGTH = 100;

/**
 * What a file is, mapped by the adapter from its vendor type (Core never sees the vendor type). Only the
 * {@link DRIVE_TEXT_EXPORTABLE_KINDS} have a text export; every other kind is listed but never read.
 */
export const DRIVE_FILE_KINDS = ['document', 'spreadsheet', 'presentation', 'text', 'pdf', 'folder', 'other'] as const;
export type DriveFileKind = (typeof DRIVE_FILE_KINDS)[number];
/** The kinds a listing can be narrowed to (ADR-0120 follow-up): a closed, vendor-free set; the adapter maps each to its own type. */
export const DRIVE_LISTING_KINDS = ['spreadsheet', 'document', 'presentation', 'pdf', 'folder'] as const;
export type DriveListingKind = (typeof DRIVE_LISTING_KINDS)[number];

/** The kinds whose text an adapter may export for a summary: a Google Doc and a Google Sheet only (ADR-0118 D2; an uploaded text file is listed as `text` but never read). */
export const DRIVE_TEXT_EXPORTABLE_KINDS: readonly DriveFileKind[] = Object.freeze(['document', 'spreadsheet']);

export function isDriveTextExportable(kind: unknown): boolean {
  return typeof kind === 'string' && (DRIVE_TEXT_EXPORTABLE_KINDS as readonly string[]).includes(kind);
}

/** One file, minimised to what a listing needs (no owner, sharing, link, size or content). */
export interface DriveFileSummary {
  readonly id: string;
  /** The file name, one line, '' when it has none. */
  readonly name: string;
  readonly kind: DriveFileKind;
  /** When the file was last modified (ISO-8601 UTC). */
  readonly modifiedAt: IsoTimestamp;
}

export interface DriveListResult {
  /** Newest modified first, at most `limit`. */
  readonly files: readonly DriveFileSummary[];
  /** How many files matched (counted up to DRIVE_SEARCH_COUNT_MAX). At least `files.length`. */
  readonly matched: number;
  /** True when more than `matched` files may exist (the count stopped at its bound). */
  readonly matchedIsLowerBound: boolean;
}

/**
 * One sheet of a spreadsheet read sheet by sheet (DRV-2b). Both fields are untrusted readout: a sheet title is chosen by
 * whoever edits the spreadsheet, so it is data, never a heading Core trusts.
 */
export interface DriveDocumentSection {
  /** The sheet title, one line, at most DRIVE_SHEET_TITLE_MAX_LENGTH code points, '' when it has none. */
  readonly title: string;
  /** The sheet's values as text (one line per row). */
  readonly text: string;
}

/**
 * DRV-2b fallback (closed, vendor-free): a spreadsheet whose sheets could not be read one by one was read as its first
 * sheet only. `service-disabled`: the adapter's per-sheet read is not enabled for the account; `unavailable`: that read
 * failed or was refused; `too-large`: its answer was over the adapter's size bound.
 */
export const DRIVE_FIRST_SHEET_ONLY_REASONS = ['service-disabled', 'unavailable', 'too-large'] as const;
export type DriveFirstSheetOnlyReason = (typeof DRIVE_FIRST_SHEET_ONLY_REASONS)[number];

/** One file with its bounded exported text, read only for an explicit summary request (ADR-0118 D7). */
export interface DriveDocument extends DriveFileSummary {
  /** The owner's display name, one line, '' when unknown. */
  readonly ownerName: string;
  /** The plain-text export, at most DRIVE_TEXT_MAX_BYTES of UTF-8. With `sections`, their joined text. */
  readonly text: string;
  /** True when the text was longer than the bound and was cut (with `sections`: a sheet, a row, a column or a cell was left out). */
  readonly textTruncated: boolean;
  /**
   * DRV-2b, additive: a spreadsheet read sheet by sheet — at most DRIVE_SHEETS_MAX sections, in sheet order, whose text
   * together stays inside DRIVE_TEXT_MAX_BYTES. Absent for a document, and for a spreadsheet read as its first sheet.
   */
  readonly sections?: readonly DriveDocumentSection[];
  /** DRV-2b, additive: set only when a spreadsheet was read as its first sheet only because the per-sheet read failed. */
  readonly firstSheetOnly?: DriveFirstSheetOnlyReason;
}

export interface DriveReader {
  /** A neutral source label for audit and replies (for example `drive`); never branched on by Core. */
  readonly source: string;
  readonly readOnly: true;
  /** Files (not folders, not trashed) whose name contains `name` (1..100 characters), newest modified first. */
  searchByName(name: string, limit?: number, kind?: DriveListingKind): Promise<DriveListResult>;
  /** The most recently modified files (not folders, not trashed), newest first. With `kind`: only that kind (`folder` lists folders). */
  recentFiles(limit?: number, kind?: DriveListingKind): Promise<DriveListResult>;
  /**
   * The bounded text export of one file a listing returned. `UNSUPPORTED_QUERY` when its kind has no text export. A
   * spreadsheet may come back sheet by sheet (`sections`, DRV-2b).
   */
  exportText(id: string): Promise<DriveDocument>;
}

/**
 * Validates the owner-typed name of a search: one line, 1..100 characters after whitespace is folded. Failures are
 * `ConnectorQueryError('UNSUPPORTED_QUERY')` with value-free messages.
 */
export function parseDriveNameQuery(name: unknown, source = 'drive'): string {
  const raw = typeof name === 'string' ? name : '';
  if (/[\r\n]/.test(raw)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: the name must be one line`);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || Array.from(text).length > DRIVE_NAME_QUERY_MAX_LENGTH) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: the name must be 1 to ${DRIVE_NAME_QUERY_MAX_LENGTH} characters`);
  }
  return text;
}

/** Default when undefined, clamped to the maximum; a non-integer or non-positive limit is an unsupported query. */
export function resolveDriveListingLimit(limit: unknown, source = 'drive'): number {
  if (limit === undefined) return DRIVE_LISTING_MAX_ENTRIES;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: limit must be a positive integer`);
  }
  return Math.min(limit, DRIVE_LISTING_MAX_ENTRIES);
}

/**
 * Bounded, single-line untrusted text: the raw value is cut to {@link DRIVE_RAW_LINE_MAX_UNITS} first (so no regex ever
 * runs on an unbounded hostile name), then control, format and line-separator characters and whitespace runs become one
 * space and the text is cut to `maxLength` code points (the shared `boundMailLine` rules).
 */
export function boundDriveLine(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? boundMailLine(value.slice(0, DRIVE_RAW_LINE_MAX_UNITS), maxLength) : '';
}

/** Whether `id` is a plausible opaque file id (ASCII letters, digits, `_` and `-`). */
export function isValidDriveFileId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= DRIVE_FILE_ID_MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(id);
}
