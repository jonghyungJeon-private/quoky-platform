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
} from './errors';
import { refreshGDriveAccessToken, type GDriveAccessToken } from './oauth';
import { decodeBoundedUtf8 } from './text';

/**
 * Every Drive API call goes to this origin (ADR-0118 D2/D3: egress to www.googleapis.com and oauth2.googleapis.com
 * only). Pinned: the client never builds a URL from configuration or response data.
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
const LIST_PARAMS: ReadonlySet<string> = new Set(['q', 'pageSize', 'orderBy', 'fields', 'spaces']);
const GET_PARAMS: ReadonlySet<string> = new Set(['fields']);
const EXPORT_PARAMS: ReadonlySet<string> = new Set(['mimeType']);

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
export const GDRIVE_LIST_FIELDS = 'files(id,name,mimeType,modifiedTime),nextPageToken';
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
 * - `files` (list) with `q`, `pageSize`, `orderBy`, `fields`, `spaces`;
 * - `files/{id}` (get) with `fields` only (never `alt`: no file is ever downloaded);
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
 * The Drive search string for a listing. The adapter owns the vendor query language and its escaping (the ADR-0100 D7
 * precedent): the owner's name text has every quote, backslash and control character removed, so it can only ever be a
 * `name contains` literal. Trashed files and folders are never listed.
 */
export function buildGDriveQuery(name?: string): string {
  const terms = ['trashed = false', `mimeType != '${GOOGLE_FOLDER}'`];
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
 * ids-only page of at most 100 for the count). Only Google Docs (as `text/plain`), Google Sheets (as `text/csv`) are ever
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

  async searchByName(name: string, limit?: number): Promise<DriveListResult> {
    return this.list(buildGDriveQuery(parseDriveNameQuery(name, 'gdrive')), resolveDriveListingLimit(limit, 'gdrive'));
  }

  async recentFiles(limit?: number): Promise<DriveListResult> {
    return this.list(buildGDriveQuery(), resolveDriveListingLimit(limit, 'gdrive'));
  }

  async exportText(id: string): Promise<DriveDocument> {
    if (!isValidDriveFileId(id)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gdrive: invalid file id');
    const meta = this.filesUrl(id);
    meta.searchParams.set('fields', GDRIVE_GET_FIELDS);
    const payload = await this.readJson(meta, GDRIVE_GET_MAX_BYTES);
    const summary = mapFile(payload, id);
    // The kind is re-checked here, from the vendor type: only a Google Doc or Sheet has a text export (D2).
    const exportType = GDRIVE_EXPORT_TYPES[String(payload.mimeType)];
    if (!isDriveTextExportable(summary.kind) || exportType === undefined) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gdrive: the file has no text export');
    }
    const url = this.filesUrl(id, '/export');
    url.searchParams.set('mimeType', exportType);
    const body = await this.readText(url);
    const owners = Array.isArray(payload.owners) ? payload.owners : [];
    const owner = isRecord(owners[0]) ? owners[0].displayName : undefined;
    return {
      ...summary,
      ownerName: boundDriveLine(owner, DRIVE_OWNER_NAME_MAX_LENGTH),
      text: body.text,
      textTruncated: body.truncated,
    };
  }

  /** One page of at most `limit` files, newest modified first; an ids-only page counts the rest when there is more. */
  private async list(q: string, limit: number): Promise<DriveListResult> {
    const url = this.filesUrl();
    url.searchParams.set('q', q);
    url.searchParams.set('pageSize', String(limit));
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', GDRIVE_LIST_FIELDS);
    const payload = await this.readJson(url, GDRIVE_LIST_MAX_BYTES);
    const listed = payload.files === undefined ? [] : payload.files;
    if (!Array.isArray(listed) || listed.length > limit) throw new GDriveResponseError('drive');
    const files = listed.map((entry) => mapFile(isRecord(entry) ? entry : {}, isRecord(entry) ? entry.id : undefined));
    if (new Set(files.map((file) => file.id)).size !== files.length) throw new GDriveResponseError('drive');
    const next = payload.nextPageToken;
    if (next !== undefined && typeof next !== 'string') throw new GDriveResponseError('drive');
    if (typeof next !== 'string' || next.length === 0) return { files, matched: files.length, matchedIsLowerBound: false };

    const count = this.filesUrl();
    count.searchParams.set('q', q);
    count.searchParams.set('pageSize', String(DRIVE_SEARCH_COUNT_MAX));
    count.searchParams.set('orderBy', 'modifiedTime desc');
    count.searchParams.set('spaces', 'drive');
    count.searchParams.set('fields', GDRIVE_COUNT_FIELDS);
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
    };
  }

  private filesUrl(id?: string, suffix: '' | '/export' = ''): URL {
    const path = id === undefined ? GDRIVE_FILES_PATH : `${GDRIVE_FILES_PATH}/${encodeURIComponent(id)}${suffix}`;
    return new URL(path, GDRIVE_API_ORIGIN);
  }

  /** One guarded JSON read, bounded at `maxBytes` (a larger response is refused). */
  private async readJson(url: URL, maxBytes: number): Promise<Record<string, unknown>> {
    const response = await this.authorized(url);
    // A partial response (`fields=…`) whose selected fields are all absent — an empty list — is sent by Google as
    // 204 No Content with no body: that is an empty object, not a malformed response.
    if (response.status === 204) {
      await discardBody(response);
      return {};
    }
    const bytes = await readBounded(response, maxBytes);
    if (bytes.overflow) throw new GDriveResponseTooLargeError('drive');
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(bytes.data).toString('utf8')) as unknown;
    } catch {
      throw new GDriveResponseError('drive');
    }
    if (!isRecord(payload)) throw new GDriveResponseError('drive');
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
  private async authorized(url: URL): Promise<Response> {
    let response = await this.get(url, await this.currentAccessToken());
    if (response.status === 401) {
      await discardBody(response);
      this.accessToken = undefined;
      response = await this.get(url, await this.currentAccessToken());
    }
    if (!response.ok) throw new GDriveHttpError(await driveErrorReason(response), 'drive', response.status);
    return response;
  }

  /** The ONLY function that sends a Drive API request. */
  private async get(url: URL, accessToken: string): Promise<Response> {
    const method = 'GET';
    assertGDriveReadRequest(url, method);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { Accept: 'application/json, text/plain, text/csv', Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GDriveRequestError('drive');
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

/** Read at most `maxBytes` of the body; the rest is cancelled and never read (`overflow` says there was more). */
async function readBounded(response: Response, maxBytes: number): Promise<{ readonly data: Uint8Array; readonly overflow: boolean }> {
  const body = response.body;
  if (body === null) throw new GDriveResponseError('drive');
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
    throw new GDriveRequestError('drive');
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
async function driveErrorReason(response: Response): Promise<ConnectorQueryErrorReason> {
  const status = response.status;
  if (status === 400) {
    await discardBody(response);
    return 'UNSUPPORTED_QUERY';
  }
  // Review P3-5: every body this function does not read is cancelled, so no socket is held until GC.
  if (status === 401 || status === 404 || status === 429) {
    await discardBody(response);
    return status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : 'RATE_LIMITED';
  }
  if (status !== 403) {
    await discardBody(response);
    return 'UNAVAILABLE';
  }
  const reasons = await readGoogleErrorReasons(response);
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
