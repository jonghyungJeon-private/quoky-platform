import {
  ConnectorQueryError,
  MAIL_BODY_MAX_BYTES,
  MAIL_SEARCH_COUNT_MAX,
  MAIL_SENDER_ADDRESS_MAX_LENGTH,
  MAIL_SENDER_NAME_MAX_LENGTH,
  MAIL_SNIPPET_MAX_LENGTH,
  MAIL_SUBJECT_MAX_LENGTH,
  boundMailLine,
  isValidMailMessageId,
  parseMailSearchQuery,
  resolveConnectorQueryTimeoutMs,
  type ConnectorQueryErrorReason,
  type MailMessage,
  type MailMessageSummary,
  type MailReader,
  type MailSearchQuery,
  type MailSearchResult,
  type ParsedMailSearchQuery,
} from '@quoky/core';
import {
  GmailEndpointNotAllowedError,
  GmailHttpError,
  GmailRequestError,
  GmailResponseError,
  GmailResponseTooLargeError,
} from './errors';
import {
  MAX_HEADER_CHARS,
  decodeHtmlEntities,
  decodeMimeHeader,
  extractBodyText,
  headerValue,
  parseSender,
  truncateUtf8,
} from './mime';
import { refreshGmailAccessToken, type GmailAccessToken } from './oauth';

/**
 * Every Gmail API call goes to this origin (ADR-0118 D2/D3: egress to gmail.googleapis.com and oauth2.googleapis.com
 * only). Pinned: the client never builds a URL from configuration or response data.
 */
export const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
/** The source's display name for Core's neutral mail copy (review P3-6). */
export const GMAIL_SOURCE_LABEL = 'Gmail';
/** The only API path family the client may call: `messages.list` and `messages.get`. */
export const GMAIL_MESSAGES_PATH = '/gmail/v1/users/me/messages';
const READ_PATH = /^\/gmail\/v1\/users\/me\/messages(?:\/[A-Za-z0-9_-]{1,128})?$/;
/** The only query parameters a read request may carry. */
const READ_PARAMS: ReadonlySet<string> = new Set(['q', 'maxResults', 'fields', 'format', 'metadataHeaders']);

/** Minimised partial responses: ids only for a search; headers + snippet for a listing; the payload only on a get. */
export const GMAIL_LIST_FIELDS = 'messages(id),nextPageToken';
export const GMAIL_METADATA_FIELDS = 'id,labelIds,snippet,internalDate,payload/headers';
export const GMAIL_FULL_FIELDS = 'id,labelIds,snippet,internalDate,payload';
/** Response size bounds per call (bytes). A larger response is refused and its body is not kept. */
export const GMAIL_LIST_MAX_BYTES = 64 * 1024;
export const GMAIL_METADATA_MAX_BYTES = 64 * 1024;
export const GMAIL_FULL_MAX_BYTES = 4 * 1024 * 1024;
/** An access token is refreshed this long before Google says it expires. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface GmailMailReaderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000), applied to every token and Gmail call. */
  readonly timeoutMs?: number;
  /** Injectable clock for the access-token expiry. */
  readonly nowMs?: () => number;
}

/**
 * Refuses any request outside the read-only allowlist BEFORE it is sent: the method must be GET, the origin the pinned
 * Gmail API origin, the path `messages` or `messages/{id}`, and only the read parameters may appear. There is no code
 * path that sends anything else; this is the runtime half of the read-only guarantee (the source scan is the other).
 */
export function assertGmailReadRequest(url: URL, method: string): void {
  if (method !== 'GET') throw new GmailEndpointNotAllowedError();
  if (url.origin !== GMAIL_API_ORIGIN || !READ_PATH.test(url.pathname) || url.username || url.password || url.hash) {
    throw new GmailEndpointNotAllowedError();
  }
  for (const key of url.searchParams.keys()) {
    if (!READ_PARAMS.has(key)) throw new GmailEndpointNotAllowedError();
  }
}

/**
 * The Gmail search string for a validated query. The adapter owns the vendor query language and its escaping (the
 * ADR-0100 D7 precedent): the owner's sender text is reduced to a quoted phrase with no quote, backslash, bracket or
 * operator character left, so it can only ever be a sender phrase.
 */
export function buildGmailSearchQuery(query: ParsedMailSearchQuery): string {
  const terms: string[] = [];
  if (query.unreadOnly || query.receivedAfterMs !== undefined || query.from === undefined) terms.push('in:inbox');
  if (query.unreadOnly) terms.push('is:unread');
  if (query.receivedAfterMs !== undefined) terms.push(`after:${Math.floor(query.receivedAfterMs / 1000)}`);
  if (query.from !== undefined) {
    const phrase = query.from.replace(/["\\(){}[\]<>:]/g, ' ').replace(/\s+/g, ' ').trim();
    if (phrase.length === 0) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gmail: the sender has no searchable text');
    terms.push(`from:"${phrase}"`);
  }
  return terms.join(' ');
}

/**
 * Read-only Gmail adapter for the `MailReader` port (ADR-0118 D2/D3, GML-1). GET requests to the pinned
 * `messages.list` / `messages.get` endpoints only, through one guarded request function; the grant must be exactly
 * `gmail.readonly`; a timeout on every call, redirects refused, every response size-bounded, result counts bounded
 * (one page of at most 100 ids, metadata for at most 10). No send, draft, label, modify, trash or delete call exists.
 * The access token lives in memory only; the refresh token, client secret and access token are never logged and never
 * appear in an error.
 */
export class GmailMailReader implements MailReader {
  readonly source = 'mail';
  readonly readOnly = true as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;
  private accessToken: GmailAccessToken | undefined;
  private pendingRefresh: Promise<GmailAccessToken> | undefined;

  constructor(config: GmailMailReaderConfig) {
    this.clientId = requireNonEmpty(config?.clientId, 'client id');
    this.clientSecret = requireNonEmpty(config?.clientSecret, 'client secret');
    this.refreshToken = requireNonEmpty(config?.refreshToken, 'refresh token');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'gmail');
    this.nowMs = config.nowMs ?? Date.now;
  }

  async search(query: MailSearchQuery): Promise<MailSearchResult> {
    const parsed = parseMailSearchQuery(query, 'gmail');
    const url = this.messagesUrl();
    url.searchParams.set('q', buildGmailSearchQuery(parsed));
    url.searchParams.set('maxResults', String(MAIL_SEARCH_COUNT_MAX));
    url.searchParams.set('fields', GMAIL_LIST_FIELDS);
    const payload = await this.getJson(url, GMAIL_LIST_MAX_BYTES);

    const listed = payload.messages === undefined ? [] : payload.messages;
    if (!Array.isArray(listed) || listed.length > MAIL_SEARCH_COUNT_MAX) throw new GmailResponseError('gmail');
    const ids = listed.map((entry) => (isRecord(entry) ? entry.id : undefined));
    if (!ids.every(isValidMailMessageId) || new Set(ids).size !== ids.length) throw new GmailResponseError('gmail');
    const next = payload.nextPageToken;
    if (next !== undefined && typeof next !== 'string') throw new GmailResponseError('gmail');

    const wanted = ids.slice(0, parsed.limit);
    const summaries = await Promise.all(wanted.map((id) => this.readSummary(id)));
    const messages = summaries.filter((entry): entry is MailMessageSummary => entry !== undefined);
    const gone = summaries.length - messages.length;
    return {
      messages,
      matched: Math.max(messages.length, ids.length - gone),
      matchedIsLowerBound: typeof next === 'string' && next.length > 0,
    };
  }

  async getMessage(id: string): Promise<MailMessage> {
    if (!isValidMailMessageId(id)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'gmail: invalid message id');
    const url = this.messagesUrl(id);
    url.searchParams.set('format', 'full');
    url.searchParams.set('fields', GMAIL_FULL_FIELDS);
    const payload = await this.getJson(url, GMAIL_FULL_MAX_BYTES);
    const summary = mapSummary(payload, id);
    const extracted = extractBodyText(payload.payload);
    const body = truncateUtf8(extracted.text, MAIL_BODY_MAX_BYTES);
    return { ...summary, bodyText: body.text, bodyTruncated: body.truncated || extracted.truncated };
  }

  /** Metadata for one listed id; a message deleted since the search (404) is skipped. */
  private async readSummary(id: string): Promise<MailMessageSummary | undefined> {
    const url = this.messagesUrl(id);
    url.searchParams.set('format', 'metadata');
    url.searchParams.append('metadataHeaders', 'From');
    url.searchParams.append('metadataHeaders', 'Subject');
    url.searchParams.set('fields', GMAIL_METADATA_FIELDS);
    try {
      return mapSummary(await this.getJson(url, GMAIL_METADATA_MAX_BYTES), id);
    } catch (error) {
      if (error instanceof GmailHttpError && error.reason === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  private messagesUrl(id?: string): URL {
    return new URL(id === undefined ? GMAIL_MESSAGES_PATH : `${GMAIL_MESSAGES_PATH}/${encodeURIComponent(id)}`, GMAIL_API_ORIGIN);
  }

  /** One guarded GET with the cached access token; a 401 refreshes once and retries once. */
  private async getJson(url: URL, maxBytes: number): Promise<Record<string, unknown>> {
    let response = await this.get(url, await this.currentAccessToken());
    if (response.status === 401) {
      await discardBody(response);
      this.accessToken = undefined;
      response = await this.get(url, await this.currentAccessToken());
    }
    if (!response.ok) {
      throw new GmailHttpError(await gmailErrorReason(response), 'gmail', response.status);
    }
    const payload = await readBoundedJson(response, maxBytes);
    if (!isRecord(payload)) throw new GmailResponseError('gmail');
    return payload;
  }

  /** The ONLY function that sends a Gmail API request. */
  private async get(url: URL, accessToken: string): Promise<Response> {
    const method = 'GET';
    assertGmailReadRequest(url, method);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GmailRequestError('gmail');
    }
  }

  private async currentAccessToken(): Promise<string> {
    const cached = this.accessToken;
    if (cached !== undefined && cached.expiresAtMs - ACCESS_TOKEN_EXPIRY_SKEW_MS > this.nowMs()) return cached.token;
    // Concurrent calls share one refresh.
    if (this.pendingRefresh === undefined) {
      this.pendingRefresh = refreshGmailAccessToken(
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

/** A listing entry from a `messages.get` payload (metadata or full). */
function mapSummary(payload: Record<string, unknown>, expectedId: string): MailMessageSummary {
  if (payload.id !== expectedId) throw new GmailResponseError('gmail');
  const internalDate = typeof payload.internalDate === 'string' ? Number(payload.internalDate) : Number.NaN;
  if (!Number.isFinite(internalDate) || internalDate < 0) throw new GmailResponseError('gmail');
  const labels = Array.isArray(payload.labelIds) ? payload.labelIds.filter((label) => typeof label === 'string') : [];
  const headers = isRecord(payload.payload) ? payload.payload.headers : undefined;
  const sender = parseSender(headerValue(headers, 'From') ?? '');
  return {
    id: expectedId,
    sender: {
      name: boundMailLine(sender.name, MAIL_SENDER_NAME_MAX_LENGTH),
      address: boundMailLine(sender.address, MAIL_SENDER_ADDRESS_MAX_LENGTH),
    },
    subject: boundMailLine(decodeMimeHeader(headerValue(headers, 'Subject') ?? ''), MAIL_SUBJECT_MAX_LENGTH),
    receivedAt: new Date(internalDate).toISOString(),
    snippet: boundMailLine(
      decodeHtmlEntities(typeof payload.snippet === 'string' ? payload.snippet.slice(0, MAX_HEADER_CHARS) : ''),
      MAIL_SNIPPET_MAX_LENGTH,
    ),
    unread: labels.includes('UNREAD'),
  };
}

/** Read at most `maxBytes` of the body as JSON; a longer body is cancelled and refused. */
async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new GmailResponseTooLargeError('gmail');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const body = response.body;
  if (body === null) throw new GmailResponseError('gmail');
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GmailResponseTooLargeError('gmail');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GmailResponseTooLargeError) throw error;
    throw new GmailRequestError('gmail');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new GmailResponseError('gmail');
  }
}

/**
 * Gmail API errors: 400 → `UNSUPPORTED_QUERY`, 401 → `UNAUTHORIZED` (auth expired), 404 → `NOT_FOUND`, 429 →
 * `RATE_LIMITED`, 5xx → `UNAVAILABLE`. A 403 is read for its fixed `reason` token only: rate and quota reasons →
 * `RATE_LIMITED`, insufficient permissions or scope → `INSUFFICIENT_SCOPE` (consent needed), anything else (an
 * administrator policy, a disabled API) → `FORBIDDEN`.
 */
async function gmailErrorReason(response: Response): Promise<ConnectorQueryErrorReason> {
  const status = response.status;
  if (status === 400) {
    await discardBody(response);
    return 'UNSUPPORTED_QUERY';
  }
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status !== 403) {
    await discardBody(response);
    return 'UNAVAILABLE';
  }
  const reasons = await readGoogleErrorReasons(response);
  if (reasons.some((reason) => /^(?:rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RATE_LIMIT_EXCEEDED)$/.test(reason))) {
    return 'RATE_LIMITED';
  }
  if (reasons.some((reason) => /^(?:insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT)$/.test(reason))) {
    return 'INSUFFICIENT_SCOPE';
  }
  return 'FORBIDDEN';
}

/** The `reason` tokens of a Google error body (`error.errors[].reason`, `error.details[].reason`); nothing else. */
async function readGoogleErrorReasons(response: Response): Promise<string[]> {
  try {
    const body = await readBoundedJson(response, 16 * 1024);
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
    throw new Error(`gmail: a non-empty ${label} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
