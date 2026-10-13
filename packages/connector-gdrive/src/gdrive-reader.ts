import {
  ConnectorQueryError,
  DRIVE_FILE_NAME_MAX_LENGTH,
  DRIVE_OWNER_NAME_MAX_LENGTH,
  DRIVE_SEARCH_COUNT_MAX,
  DRIVE_TEXT_MAX_BYTES,
  boundDriveLine,
  isDriveTextExportable,
  isValidDriveFileId,
  parseDriveNameQuery,
  resolveConnectorQueryTimeoutMs,
  resolveDriveListingLimit,
  type ConnectorQueryErrorReason,
  type DriveDocument,
  type DriveFileKind,
  type DriveFirstSheetOnlyReason,
  type DriveListingKind,
  type DriveFileSummary,
  type DriveListResult,
  type DriveReader,
} from '@quoky/core';
import {
  GDriveEndpointNotAllowedError,
  GDriveHttpError,
  GDriveRequestError,
  GDriveResponseError,
  GDriveResponseTooLargeError,
  GDriveScopeError,
  type GDriveEndpoint,
} from './errors';
import { refreshGDriveAccessToken, type GDriveAccessToken } from './oauth';
import {
  GSHEETS_API_ORIGIN,
  GSHEETS_META_MAX_BYTES,
  GSHEETS_VALUES_MAX_BYTES,
  assertGSheetsReadRequest,
  gsheetsMetaUrl,
  gsheetsRowsPerSheet,
  gsheetsValuesUrl,
  parseGSheetTargets,
  renderGSheetsValues,
  type GSheetsText,
} from './sheets-reader';
import { decodeBoundedUtf8 } from './text';

/**
 * Every Drive API call goes to this origin (ADR-0118 D2/D3: egress to www.googleapis.com and oauth2.googleapis.com,
 * plus sheets.googleapis.com for the DRV-2b per-sheet read, `sheets-reader.ts`). Pinned: the client never builds a URL
 * from configuration or response data.
 */
export const GDRIVE_API_ORIGIN = 'https://www.googleapis.com';
/** The source's display name for Core's neutral Drive copy (the GML-1 review P3-6 rule). */
export const GDRIVE_SOURCE_LABEL = 'Google Drive';
/** The only API path family the client may call: `files.list`, `files.get` and `files.export`. */
export const GDRIVE_FILES_PATH = '/drive/v3/files';
const LIST_PATH = /^\/drive\/v3\/files$/;
const GET_PATH = /^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,128}$/;
const EXPORT_PATH = /^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,128}\/export$/;
/** The only query parameters each read may carry. */
const LIST_PARAMS: ReadonlySet<string> = new Set([
  'q', 'pageSize', 'orderBy', 'fields', 'spaces', 'corpora', 'includeItemsFromAllDrives', 'supportsAllDrives',
]);
const GET_PARAMS: ReadonlySet<string> = new Set(['fields', 'supportsAllDrives']);
const EXPORT_PARAMS: ReadonlySet<string> = new Set(['mimeType']);
/**
 * DRV-2 (ADR-0118 amendment 2026-10-12 (b)): the shared-drive parameters, each with its ONE allowed value. A listing
 * searches My Drive, files shared with the owner and the owner's shared drives; a metadata read supports a shared-drive
 * file. `files.export` documents `mimeType` as its only parameter and exports a shared-drive file by id, so it carries
 * none of these (see the implementation note).
 */
export const GDRIVE_ALL_DRIVES_PARAMS: Readonly<Record<string, string>> = Object.freeze({
  corpora: 'allDrives',
  includeItemsFromAllDrives: 'true',
  supportsAllDrives: 'true',
});

/** The vendor types this adapter maps; Core only ever sees a {@link DriveFileKind}. */
const GOOGLE_DOCUMENT = 'application/vnd.google-apps.document';
const GOOGLE_SPREADSHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_PRESENTATION = 'application/vnd.google-apps.presentation';
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
/** Uploaded plain text files: LISTED as kind `text`, never downloaded (ADR-0118 D2: only a Google Doc or Sheet text export). */
const PLAIN_TEXT_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/csv']);
/** The text export of each exportable Google type; nothing else is ever exported. */
export const GDRIVE_EXPORT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  [GOOGLE_DOCUMENT]: 'text/plain',
  [GOOGLE_SPREADSHEET]: 'text/csv',
});

/** Minimised partial responses: listing fields only; ids only for the count; no owner, sharing, link or size. */
export const GDRIVE_LIST_FIELDS = 'files(id,name,mimeType,modifiedTime),nextPageToken,incompleteSearch';
export const GDRIVE_COUNT_FIELDS = 'files(id),nextPageToken';
export const GDRIVE_GET_FIELDS = 'id,name,mimeType,modifiedTime,owners(displayName)';
/** Response size bounds per call (bytes). A larger JSON response is refused and its body is not kept. */
export const GDRIVE_LIST_MAX_BYTES = 512 * 1024;
export const GDRIVE_COUNT_MAX_BYTES = 64 * 1024;
export const GDRIVE_GET_MAX_BYTES = 64 * 1024;
/** An access token is refreshed this long before Google says it expires. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface GoogleDriveReaderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000), applied to every token and Drive call. */
  readonly timeoutMs?: number;
  /** Injectable clock for the access-token expiry. */
  readonly nowMs?: () => number;
}

/**
 * Refuses any request outside the read-only allowlist BEFORE it is sent: the method must be GET and the origin the
 * pinned Drive API origin; then exactly one of
 *
 * - `files` (list) with `q`, `pageSize`, `orderBy`, `fields`, `spaces`, and the DRV-2 shared-drive parameters
 *   `corpora=allDrives`, `includeItemsFromAllDrives=true`, `supportsAllDrives=true` (each only with that value; never
 *   `driveId` or `pageToken`);
 * - `files/{id}` (get) with `fields` and `supportsAllDrives=true` only (never `alt`: no file is ever downloaded);
 * - `files/{id}/export` with `mimeType` exactly `text/plain` or `text/csv`.
 *
 * There is no code path that sends anything else; this is the runtime half of the read-only guarantee (the source scan
 * is the other).
 */
export function assertGDriveReadRequest(url: URL, method: string): void {
  if (method !== 'GET') throw new GDriveEndpointNotAllowedError();
  if (url.origin !== GDRIVE_API_ORIGIN || url.username || url.password || url.hash) throw new GDriveEndpointNotAllowedError();
  const keys = [...url.searchParams.keys()];
  const only = (allowed: ReadonlySet<string>) => {
    if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) throw new GDriveEndpointNotAllowedError();
    // A shared-drive parameter carries its one fixed value, never another (`corpora=domain`, `supportsAllDrives=false`).
    for (const [key, value] of Object.entries(GDRIVE_ALL_DRIVES_PARAMS)) {
      if (url.searchParams.has(key) && url.searchParams.get(key) !== value) throw new GDriveEndpointNotAllowedError();
    }
  };
  if (LIST_PATH.test(url.pathname)) {
    only(LIST_PARAMS);
    return;
  }
  if (GET_PATH.test(url.pathname)) {
    only(GET_PARAMS);
    return;
  }
  if (EXPORT_PATH.test(url.pathname)) {
    only(EXPORT_PARAMS);
    const type = url.searchParams.get('mimeType');
    if (type === null || !Object.values(GDRIVE_EXPORT_TYPES).includes(type)) throw new GDriveEndpointNotAllowedError();
    return;
  }
  throw new GDriveEndpointNotAllowedError();
}

/**
 * The request guard of the reader's single request site: a Sheets API request (DRV-2b) is checked by
 * `assertGSheetsReadRequest`, every other request by {@link assertGDriveReadRequest}. Nothing reaches another origin.
 */
export function assertGoogleReadRequest(url: URL, method: string): void {
  if (url.origin === GSHEETS_API_ORIGIN) {
    assertGSheetsReadRequest(url, method);
    return;
  }
  assertGDriveReadRequest(url, method);
}

const GDRIVE_LISTING_MIME: Readonly<Record<DriveListingKind, string>> = Object.freeze({
  spreadsheet: GOOGLE_SPREADSHEET,
  document: GOOGLE_DOCUMENT,
  presentation: GOOGLE_PRESENTATION,
  pdf: 'application/pdf',
  folder: GOOGLE_FOLDER,
});

/**
 * The Drive search string for a listing. The adapter owns the vendor query language and its escaping (the ADR-0100 D7
 * precedent): the owner's name text has every quote, backslash and control character removed, so it can only ever be a
 * `name contains` literal. Trashed files and folders are never listed.
 */
export function buildGDriveQuery(name?: string, kind?: DriveListingKind): string {
  // `kind` is a closed neutral value mapped to a fixed vendor type here; no owner text reaches the type clause.
  const wanted = kind === undefined || !Object.hasOwn(GDRIVE_LISTING_MIME, kind) ? undefined : GDRIVE_LISTING_MIME[kind];
  if (kind !== undefined && wanted === undefined) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gdrive: unsupported file kind');
  const terms = ['trashed = false', wanted === undefined ? `mimeType != '${GOOGLE_FOLDER}'` : `mimeType = '${wanted}'`];
  if (name !== undefined) {
    // eslint-disable-next-line no-control-regex
    const literal = name.replace(/['"\\\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (literal.length === 0) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gdrive: the name has no searchable text');
    terms.push(`name contains '${literal}'`);
  }
  return terms.join(' and ');
}

/** The neutral kind of a vendor type. */
export function driveKindOf(mimeType: unknown): DriveFileKind {
  if (mimeType === GOOGLE_DOCUMENT) return 'document';
  if (mimeType === GOOGLE_SPREADSHEET) return 'spreadsheet';
  if (mimeType === GOOGLE_PRESENTATION) return 'presentation';
  if (mimeType === GOOGLE_FOLDER) return 'folder';
  if (mimeType === 'application/pdf') return 'pdf';
  if (typeof mimeType === 'string' && PLAIN_TEXT_TYPES.has(mimeType)) return 'text';
  return 'other';
}

/**
 * Read-only Google Drive adapter for the `DriveReader` port (ADR-0118 D2/D3, DRV-1). GET requests to the pinned
 * `files.list` / `files.get` / `files.export` endpoints only, through one guarded request function; the grant must be
 * exactly `drive.readonly`; a timeout on every call, redirects refused, every JSON response size-bounded, the exported
 * text cut at {@link DRIVE_TEXT_MAX_BYTES} while it streams, result counts bounded (one page of at most 10 files, one
 * ids-only page of at most 100 for the count). Listings cover the owner's shared drives (DRV-2). A spreadsheet is read
 * sheet by sheet through the pinned Sheets API values read (DRV-2b), falling back to its first sheet as `text/csv` with
 * a closed note when that read is not possible. Only Google Docs (as `text/plain`), Google Sheets (as values) are ever
 * read (an uploaded text file is listed, never downloaded); no other file content, no binary download. No upload, create, edit, copy, move,
 * rename, trash, delete, share or permission call exists. The access token lives in memory only; the refresh token,
 * client secret and access token are never logged and never appear in an error.
 */
export class GoogleDriveReader implements DriveReader {
  readonly source = 'drive';
  readonly readOnly = true as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;
  private accessToken: GDriveAccessToken | undefined;
  private pendingRefresh: Promise<GDriveAccessToken> | undefined;

  constructor(config: GoogleDriveReaderConfig) {
    this.clientId = requireNonEmpty(config?.clientId, 'client id');
    this.clientSecret = requireNonEmpty(config?.clientSecret, 'client secret');
    this.refreshToken = requireNonEmpty(config?.refreshToken, 'refresh token');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'gdrive');
    this.nowMs = config.nowMs ?? Date.now;
  }

  async searchByName(name: string, limit?: number, kind?: DriveListingKind): Promise<DriveListResult> {
    return this.list(buildGDriveQuery(parseDriveNameQuery(name, 'gdrive'), kind), resolveDriveListingLimit(limit, 'gdrive'));
  }

  async recentFiles(limit?: number, kind?: DriveListingKind): Promise<DriveListResult> {
    return this.list(buildGDriveQuery(undefined, kind), resolveDriveListingLimit(limit, 'gdrive'));
  }

  async exportText(id: string): Promise<DriveDocument> {
    if (!isValidDriveFileId(id)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gdrive: invalid file id');
    const meta = this.filesUrl(id);
    meta.searchParams.set('fields', GDRIVE_GET_FIELDS);
    meta.searchParams.set('supportsAllDrives', GDRIVE_ALL_DRIVES_PARAMS.supportsAllDrives as string);
    const payload = await this.readJson(meta, GDRIVE_GET_MAX_BYTES);
    const summary = mapFile(payload, id);
    // The kind is re-checked here, from the vendor type: only a Google Doc or Sheet has a text export (D2).
    const exportType = GDRIVE_EXPORT_TYPES[String(payload.mimeType)];
    if (!isDriveTextExportable(summary.kind) || exportType === undefined) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gdrive: the file has no text export');
    }
    const owners = Array.isArray(payload.owners) ? payload.owners : [];
    const owner = isRecord(owners[0]) ? owners[0].displayName : undefined;
    const base = { ...summary, ownerName: boundDriveLine(owner, DRIVE_OWNER_NAME_MAX_LENGTH) };
    // DRV-2b: a spreadsheet is read sheet by sheet; if that read is not possible, its first sheet as CSV, with a note.
    let firstSheetOnly: DriveFirstSheetOnlyReason | undefined;
    let hiddenSheetsSkipped = 0;
    if (summary.kind === 'spreadsheet') {
      const sheets = await this.readAllSheets(id);
      if (sheets.ok) {
        const { value } = sheets;
        return {
          ...base,
          text: value.text,
          textTruncated: value.truncated,
          sections: value.sections,
          ...(value.hidden > 0 ? { hiddenSheetsSkipped: value.hidden } : {}),
          ...(value.credentialShaped ? { credentialShaped: true } : {}),
        };
      }
      // CA re-review: the CSV fallback exports the first grid sheet; when that sheet is hidden it is never exported (a
      // hidden sheet is never read), and the summary answers honestly that the spreadsheet could not be read now.
      if (sheets.known?.firstGridHidden === true) {
        throw new ConnectorQueryError('UNAVAILABLE', 'gdrive: the spreadsheet could not be read sheet by sheet');
      }
      // CA review suggestion: when the sheet list was read and shows exactly one visible sheet and no hidden one, the
      // first sheet IS the whole spreadsheet, so no "first sheet only" note is shown.
      if (!(sheets.known !== undefined && sheets.known.visible === 1 && sheets.known.hidden === 0)) firstSheetOnly = sheets.reason;
      hiddenSheetsSkipped = sheets.known?.hidden ?? 0;
    }
    const url = this.filesUrl(id, '/export');
    url.searchParams.set('mimeType', exportType);
    const body = await this.readText(url);
    return {
      ...base,
      text: body.text,
      textTruncated: body.truncated,
      ...(firstSheetOnly !== undefined ? { firstSheetOnly } : {}),
      ...(hiddenSheetsSkipped > 0 ? { hiddenSheetsSkipped } : {}),
    };
  }

  /**
   * DRV-2b: every visible grid sheet through the Sheets API (two guarded GETs: the sheet list, then one bounded values
   * read). A token problem (a refresh failure, a grant other than `drive.readonly`, an access token rejected after one
   * refresh) is thrown as it is (the existing consent or reconnect reply). Anything else is a closed fallback reason and
   * the caller reads the first sheet as CSV instead — never a crash:
   *
   * - `service-disabled`: 403 `SERVICE_DISABLED` / `accessNotConfigured`;
   * - `not-permitted`: a Sheets `INSUFFICIENT_SCOPE` after `files.get` succeeded with the same token. Reconnecting
   *   cannot fix it — ADR-0118 D3 forbids the spreadsheets scope — so it is not the consent reply (orchestrator decision
   *   under the amendment, CA review 2026-10-13);
   * - `too-large`: an answer over its size bound;
   * - `unavailable`: anything else (another 403, a 404, 429 or 5xx, a refusal, a timeout, a transport or shape failure).
   *
   * `known` carries the sheet counts when the sheet list was read before the failure.
   */
  private async readAllSheets(
    id: string,
  ): Promise<
    | { readonly ok: true; readonly value: GSheetsText & { readonly hidden: number } }
    | {
        readonly ok: false;
        readonly reason: DriveFirstSheetOnlyReason;
        readonly known?: { readonly visible: number; readonly hidden: number; readonly firstGridHidden: boolean };
      }
  > {
    let known: { readonly visible: number; readonly hidden: number; readonly firstGridHidden: boolean } | undefined;
    try {
      const targets = parseGSheetTargets(await this.readJson(gsheetsMetaUrl(id), GSHEETS_META_MAX_BYTES, 'sheets'));
      known = { visible: targets.sheets.length + (targets.dropped ? 1 : 0), hidden: targets.hidden, firstGridHidden: targets.firstGridHidden };
      if (targets.sheets.length === 0) {
        return { ok: true, value: { sections: [], text: '', truncated: targets.dropped, credentialShaped: false, hidden: targets.hidden } };
      }
      const rows = gsheetsRowsPerSheet(targets.sheets.length);
      const values = await this.readJson(gsheetsValuesUrl(id, targets.sheets, rows), GSHEETS_VALUES_MAX_BYTES, 'sheets');
      return { ok: true, value: { ...renderGSheetsValues(values, targets, rows), hidden: targets.hidden } };
    } catch (error) {
      const fallback = (reason: DriveFirstSheetOnlyReason) => ({ ok: false as const, reason, ...(known !== undefined ? { known } : {}) });
      if (error instanceof GDriveScopeError) throw error;
      if (error instanceof GDriveHttpError) {
        if (error.endpoint === 'token' || error.reason === 'UNAUTHORIZED') throw error;
        if (error.serviceDisabled) return fallback('service-disabled');
        if (error.reason === 'INSUFFICIENT_SCOPE') return fallback('not-permitted');
      }
      if (error instanceof GDriveResponseTooLargeError) return fallback('too-large');
      return fallback('unavailable');
    }
  }

  /** One page of at most `limit` files, newest modified first; an ids-only page counts the rest when there is more. */
  private async list(q: string, limit: number): Promise<DriveListResult> {
    const url = this.filesUrl();
    url.searchParams.set('q', q);
    url.searchParams.set('pageSize', String(limit));
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', GDRIVE_LIST_FIELDS);
    setAllDrives(url);
    const payload = await this.readJson(url, GDRIVE_LIST_MAX_BYTES);
    // DRV-2 (CA review suggestion): with `corpora=allDrives` Google may answer from only part of the corpus.
    if (payload.incompleteSearch !== undefined && typeof payload.incompleteSearch !== 'boolean') throw new GDriveResponseError('drive');
    const incomplete = payload.incompleteSearch === true ? { incomplete: true } : {};
    const listed = payload.files === undefined ? [] : payload.files;
    if (!Array.isArray(listed) || listed.length > limit) throw new GDriveResponseError('drive');
    const files = listed.map((entry) => mapFile(isRecord(entry) ? entry : {}, isRecord(entry) ? entry.id : undefined));
    if (new Set(files.map((file) => file.id)).size !== files.length) throw new GDriveResponseError('drive');
    const next = payload.nextPageToken;
    if (next !== undefined && typeof next !== 'string') throw new GDriveResponseError('drive');
    if (typeof next !== 'string' || next.length === 0) return { files, matched: files.length, matchedIsLowerBound: false, ...incomplete };

    const count = this.filesUrl();
    count.searchParams.set('q', q);
    count.searchParams.set('pageSize', String(DRIVE_SEARCH_COUNT_MAX));
    count.searchParams.set('orderBy', 'modifiedTime desc');
    count.searchParams.set('spaces', 'drive');
    count.searchParams.set('fields', GDRIVE_COUNT_FIELDS);
    setAllDrives(count);
    const counted = await this.readJson(count, GDRIVE_COUNT_MAX_BYTES);
    const ids = counted.files === undefined ? [] : counted.files;
    if (!Array.isArray(ids) || ids.length > DRIVE_SEARCH_COUNT_MAX) throw new GDriveResponseError('drive');
    if (!ids.every((entry) => isRecord(entry) && isValidDriveFileId(entry.id))) throw new GDriveResponseError('drive');
    const more = counted.nextPageToken;
    if (more !== undefined && typeof more !== 'string') throw new GDriveResponseError('drive');
    return {
      files,
      matched: Math.max(files.length, ids.length),
      matchedIsLowerBound: typeof more === 'string' && more.length > 0,
      ...incomplete,
    };
  }

  private filesUrl(id?: string, suffix: '' | '/export' = ''): URL {
    const path = id === undefined ? GDRIVE_FILES_PATH : `${GDRIVE_FILES_PATH}/${encodeURIComponent(id)}${suffix}`;
    return new URL(path, GDRIVE_API_ORIGIN);
  }

  /** One guarded JSON read, bounded at `maxBytes` (a larger response is refused). */
  private async readJson(url: URL, maxBytes: number, endpoint: GDriveEndpoint = 'drive'): Promise<Record<string, unknown>> {
    const response = await this.authorized(url, endpoint);
    // A partial response (`fields=…`) whose selected fields are all absent — an empty list — is sent by Google as
    // 204 No Content with no body: that is an empty object, not a malformed response.
    if (response.status === 204) {
      await discardBody(response);
      return {};
    }
    const bytes = await readBounded(response, maxBytes, endpoint);
    if (bytes.overflow) throw new GDriveResponseTooLargeError(endpoint);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(bytes.data).toString('utf8')) as unknown;
    } catch {
      throw new GDriveResponseError(endpoint);
    }
    if (!isRecord(payload)) throw new GDriveResponseError(endpoint);
    return payload;
  }

  /**
   * One guarded text read. The body must be `text/*`; it is cut at {@link DRIVE_TEXT_MAX_BYTES} while it streams (the
   * rest is cancelled, never read) and decoded once, so the text is bounded BEFORE any processing.
   */
  private async readText(url: URL): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const response = await this.authorized(url);
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('text/')) {
      await discardBody(response);
      throw new GDriveResponseError('drive');
    }
    // A few bytes past the bound, so a code point the bound splits is detected and dropped whole.
    const bytes = await readBounded(response, DRIVE_TEXT_MAX_BYTES + 4);
    const decoded = decodeBoundedUtf8(bytes.data, DRIVE_TEXT_MAX_BYTES);
    return { text: decoded.text, truncated: decoded.truncated || bytes.overflow };
  }

  /** A guarded GET with the cached access token; a 401 refreshes once and retries once; a failure is typed. */
  private async authorized(url: URL, endpoint: GDriveEndpoint = 'drive'): Promise<Response> {
    let response = await this.get(url, await this.currentAccessToken(), endpoint);
    if (response.status === 401) {
      await discardBody(response);
      this.accessToken = undefined;
      response = await this.get(url, await this.currentAccessToken(), endpoint);
    }
    if (!response.ok) {
      const failure = await driveErrorReason(response);
      throw new GDriveHttpError(failure.reason, endpoint, response.status, failure.serviceDisabled);
    }
    return response;
  }

  /** The ONLY function that sends a Drive or Sheets API request. */
  private async get(url: URL, accessToken: string, endpoint: GDriveEndpoint = 'drive'): Promise<Response> {
    const method = 'GET';
    assertGoogleReadRequest(url, method);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { Accept: 'application/json, text/plain, text/csv', Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GDriveRequestError(endpoint);
    }
  }

  private async currentAccessToken(): Promise<string> {
    const cached = this.accessToken;
    if (cached !== undefined && cached.expiresAtMs - ACCESS_TOKEN_EXPIRY_SKEW_MS > this.nowMs()) return cached.token;
    // Concurrent calls share one refresh.
    if (this.pendingRefresh === undefined) {
      this.pendingRefresh = refreshGDriveAccessToken(
        { clientId: this.clientId, clientSecret: this.clientSecret },
        this.refreshToken,
        { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, nowMs: this.nowMs() },
      ).finally(() => {
        this.pendingRefresh = undefined;
      });
    }
    const fresh = await this.pendingRefresh;
    this.accessToken = fresh;
    return fresh.token;
  }
}

/** A listing entry from a `files` resource (list or get). */
function mapFile(payload: Record<string, unknown>, expectedId: unknown): DriveFileSummary {
  if (!isValidDriveFileId(expectedId) || payload.id !== expectedId) throw new GDriveResponseError('drive');
  const modified = typeof payload.modifiedTime === 'string' && payload.modifiedTime.length <= 64 ? Date.parse(payload.modifiedTime) : Number.NaN;
  if (!Number.isFinite(modified)) throw new GDriveResponseError('drive');
  return {
    id: expectedId,
    name: boundDriveLine(payload.name, DRIVE_FILE_NAME_MAX_LENGTH),
    kind: driveKindOf(payload.mimeType),
    modifiedAt: new Date(modified).toISOString(),
  };
}

/** DRV-2: a listing covers the owner's shared drives too (each parameter's one allowed value). */
function setAllDrives(url: URL): void {
  for (const [key, value] of Object.entries(GDRIVE_ALL_DRIVES_PARAMS)) url.searchParams.set(key, value);
}

/** Read at most `maxBytes` of the body; the rest is cancelled and never read (`overflow` says there was more). */
async function readBounded(
  response: Response,
  maxBytes: number,
  endpoint: GDriveEndpoint = 'drive',
): Promise<{ readonly data: Uint8Array; readonly overflow: boolean }> {
  const body = response.body;
  if (body === null) throw new GDriveResponseError(endpoint);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        overflow = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    throw new GDriveRequestError(endpoint);
  }
  return { data: Buffer.concat(chunks, total), overflow };
}

/**
 * Drive API errors: 400 → `UNSUPPORTED_QUERY`, 401 → `UNAUTHORIZED` (auth expired), 404 → `NOT_FOUND`, 429 →
 * `RATE_LIMITED`, 5xx → `UNAVAILABLE`. A 403 is read for its fixed `reason` token only: rate and quota reasons →
 * `RATE_LIMITED`, `insufficientFilePermissions` → `NOT_FOUND`, a file that cannot be downloaded or exported → `UNSUPPORTED_QUERY`,
 * insufficient permissions or scope → `INSUFFICIENT_SCOPE` (consent needed), an export over Google's
 * own size limit → `INVALID_RESPONSE`, anything else (an administrator policy, a disabled API) → `FORBIDDEN`.
 */
async function driveErrorReason(response: Response): Promise<{ readonly reason: ConnectorQueryErrorReason; readonly serviceDisabled: boolean }> {
  const status = response.status;
  if (status !== 403) {
    // Review P3-5: every body this function does not read is cancelled, so no socket is held until GC.
    await discardBody(response);
    const reason: ConnectorQueryErrorReason =
      status === 400 ? 'UNSUPPORTED_QUERY' : status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
    return { reason, serviceDisabled: false };
  }
  const reasons = await readGoogleErrorReasons(response);
  // DRV-2b: the API is not enabled for the Google Cloud project (new and legacy error formats).
  const serviceDisabled = reasons.some((reason) => reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured');
  return { reason: forbiddenReason(reasons), serviceDisabled };
}

/** The reason of a 403 from its fixed `reason` tokens. */
function forbiddenReason(reasons: readonly string[]): ConnectorQueryErrorReason {
  if (reasons.some((reason) => /^(?:rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RATE_LIMIT_EXCEEDED)$/.test(reason))) {
    return 'RATE_LIMITED';
  }
  // CA review P3-3: no access to ONE file is "not found" (the grant itself is fine), and a file Drive will not
  // download or export is "cannot be read as text", not a consent problem.
  if (reasons.includes('insufficientFilePermissions')) return 'NOT_FOUND';
  if (reasons.some((reason) => /^(?:cannotDownloadFile|cannotExportFile|cannotDownloadAbusiveFile|fileNotDownloadable)$/.test(reason))) {
    return 'UNSUPPORTED_QUERY';
  }
  if (reasons.some((reason) => /^(?:insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT)$/.test(reason))) {
    return 'INSUFFICIENT_SCOPE';
  }
  if (reasons.includes('exportSizeLimitExceeded')) return 'INVALID_RESPONSE';
  return 'FORBIDDEN';
}

/** The `reason` tokens of a Google error body (`error.errors[].reason`, `error.details[].reason`); nothing else. */
async function readGoogleErrorReasons(response: Response): Promise<string[]> {
  try {
    const bytes = await readBounded(response, 16 * 1024);
    if (bytes.overflow) return [];
    const body: unknown = JSON.parse(Buffer.from(bytes.data).toString('utf8'));
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    if (error === undefined) return [];
    const entries = [
      ...(Array.isArray(error.errors) ? error.errors : []),
      ...(Array.isArray(error.details) ? error.details : []),
    ];
    return entries
      .map((entry) => (isRecord(entry) ? entry.reason : undefined))
      .filter((reason): reason is string => typeof reason === 'string' && /^[A-Za-z_]{1,64}$/.test(reason));
  } catch {
    return [];
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore: the body is never read
  }
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`gdrive: a non-empty ${label} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
