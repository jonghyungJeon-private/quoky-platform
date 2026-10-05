import {
  ConnectorQueryError,
  ConnectorQueryName,
  connectorQueryErrorReasonForStatus,
  parseSearchParams,
  resolveConnectorQueryTimeoutMs,
  toConnectorTimestamp,
  type ConnectorItem,
  type ConnectorProvider,
  type ConnectorQuery,
  type ConnectorResult,
  type Metadata,
} from '@quoky/core';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;
const MAX_RESPONSE_LENGTH = 1_000_000;
const TITLE_LIMIT = 200;
const SUMMARY_LIMIT = 500;
const RAW_JSON_LIMIT = 20_000;

export interface ConfluenceConnectorConfig {
  /**
   * Confluence host, with or without an https:// prefix (for example, example.atlassian.net). The site root and the
   * `/wiki` context path are both accepted (`https://example.atlassian.net/wiki`); requests always go to
   * `<origin>/wiki/...` exactly once.
   */
  host: string;
  /** Atlassian Cloud API token (with `email`) or a Data Center personal access token (without `email`). */
  token: string;
  /**
   * Atlassian account email. When present the connector uses HTTP Basic `email:token` (Atlassian Cloud user API
   * token); when absent it sends `Bearer <token>` (Data Center PAT). Never logged.
   */
  email?: string;
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Maximum number of values accepted from one REST response. */
  limit?: number;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export type ConfluenceListItemsInput = { kind: 'pages' | 'spaces' };

export interface ConfluenceGetItemInput {
  pageId: string;
}

export type ConfluenceConnectorHttpErrorKind =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR';

/** A sanitized Confluence HTTP failure. It never contains response content, credentials, or request headers. */
export class ConfluenceConnectorHttpError extends ConnectorQueryError {
  constructor(
    readonly kind: ConfluenceConnectorHttpErrorKind,
    readonly status: number,
  ) {
    super(connectorQueryErrorReasonForStatus(status), `confluence connector: query failed (${kind.toLowerCase()})`);
    this.name = 'ConfluenceConnectorHttpError';
  }
}

/** A sanitized transport failure. The underlying fetch error is deliberately not retained. */
export class ConfluenceConnectorRequestError extends ConnectorQueryError {
  constructor() {
    super('UNAVAILABLE', 'confluence connector: query request failed');
    this.name = 'ConfluenceConnectorRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class ConfluenceConnectorResponseError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'confluence connector: query returned an unexpected response');
    this.name = 'ConfluenceConnectorResponseError';
  }
}

export class ConfluenceConnectorProvider implements ConnectorProvider {
  readonly id = 'confluence';
  readonly source = this.id;
  readonly readOnly = true;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limit: number;
  private readonly timeoutMs: number;

  constructor(config: ConfluenceConnectorConfig) {
    this.baseUrl = normalizeHost(requireNonEmpty(config?.host, 'host'));
    this.token = requireNonEmpty(config?.token, 'token');
    this.authorization = authorizationHeader(this.token, config?.email);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.limit = boundedLimit(config?.limit);
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'confluence connector');
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async query(input: ConnectorQuery): Promise<ConnectorResult> {
    const name = input?.query;
    if (name === ConnectorQueryName.SEARCH) return this.search(input);
    if (name === ConnectorQueryName.PERSONAL_WORK) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'confluence connector: unsupported query');
    }
    const kind = input?.params?.kind;
    if (kind === undefined && typeof name === 'string' && name.trim().length > 0) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'confluence connector: unsupported query');
    }
    if (kind === undefined || kind === 'pages') return this.listItems({ kind: 'pages' });
    if (kind === 'spaces') return this.listItems({ kind: 'spaces' });
    if (kind === 'page') {
      const pageId = requireNonEmpty(input.params?.pageId ?? input.query, 'pageId');
      const item = await this.getItem({ pageId });
      return { source: this.source, items: [item] };
    }
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'confluence connector: unsupported query kind');
  }

  async listItems(input: ConfluenceListItemsInput = { kind: 'pages' }): Promise<ConnectorResult> {
    const kind = input?.kind;
    if (kind !== 'pages' && kind !== 'spaces') {
      throw new Error('confluence connector: unsupported item kind');
    }

    const url = new URL(`/wiki/api/v2/${kind}`, this.baseUrl);
    url.searchParams.set('limit', String(this.limit));
    const payload = await this.requestJson(url);
    if (!isRecord(payload) || !Array.isArray(payload.results)) throw new ConfluenceConnectorResponseError();

    const values = payload.results.slice(0, this.limit);
    const items = values
      .map((value) => kind === 'pages' ? this.mapPage(value) : this.mapSpace(value))
      .filter(isConnectorItem);
    return { source: this.source, items };
  }

  /** Named `search` query: the adapter renders and escapes the CQL; callers only supply bounded text. */
  private async search(input: ConnectorQuery): Promise<ConnectorResult> {
    const { text, limit } = parseSearchParams(input.params, 'confluence connector');
    const url = new URL('/wiki/rest/api/search', this.baseUrl);
    url.searchParams.set('cql', `type=page AND text ~ "${escapeCqlText(confluenceSearchTerms(text))}"`);
    url.searchParams.set('limit', String(limit));
    const payload = await this.requestJson(url);
    if (!isRecord(payload) || !Array.isArray(payload.results)) throw new ConfluenceConnectorResponseError();

    const base = searchBase(payload, this.baseUrl);
    const items = payload.results
      .slice(0, limit)
      .map((result) => this.mapSearchResult(result, base))
      .filter(isConnectorItem);
    return { source: this.source, items };
  }

  async getItem(input: ConfluenceGetItemInput): Promise<ConnectorItem> {
    const pageId = requireNonEmpty(input?.pageId, 'pageId');
    const url = new URL(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, this.baseUrl);
    url.searchParams.set('body-format', 'storage');
    const item = this.mapPage(await this.requestJson(url));
    if (!item) throw new ConfluenceConnectorResponseError();
    return item;
  }

  private async requestJson(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ConfluenceConnectorRequestError();
    }
    if (!response.ok) throw mapHttpError(response.status);

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_LENGTH) {
      throw new ConfluenceConnectorResponseError();
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ConfluenceConnectorResponseError();
    }
    if (text.length > MAX_RESPONSE_LENGTH) throw new ConfluenceConnectorResponseError();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ConfluenceConnectorResponseError();
    }
  }

  private mapPage(value: unknown): ConnectorItem | undefined {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) return undefined;
    const id = value.id.trim();
    const rawTitle = typeof value.title === 'string' && value.title.trim().length > 0 ? value.title.trim() : id;
    const item: ConnectorItem = {
      id,
      title: redactToken(rawTitle, this.token).slice(0, TITLE_LIMIT),
      url: itemUrl(value, this.baseUrl, `/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}`),
      raw: serializeRaw(value, this.token),
    };
    const summary = extractPageSummary(value, this.token);
    if (summary.length > 0) item.summary = summary.slice(0, SUMMARY_LIMIT);
    return item;
  }

  private mapSearchResult(value: unknown, base: string): ConnectorItem | undefined {
    if (!isRecord(value) || !isRecord(value.content)) return undefined;
    const content = value.content;
    if (typeof content.id !== 'string' || content.id.trim().length === 0) return undefined;
    const id = content.id.trim();
    const rawTitle = firstNonEmpty(content.title, value.title) ?? id;
    const links = isRecord(content._links) ? content._links : undefined;
    const webui = typeof links?.webui === 'string' ? links.webui : '';
    const url = webui.startsWith('/') && !webui.startsWith('//')
      ? `${base}${webui}`
      : new URL(`/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}`, this.baseUrl).toString();
    const item: ConnectorItem = {
      id,
      title: cleanSearchText(redactToken(rawTitle, this.token)).slice(0, TITLE_LIMIT),
      url,
      raw: serializeRaw(value, this.token),
    };
    if (item.title.length === 0) item.title = id;
    const excerpt = typeof value.excerpt === 'string' ? cleanSearchText(redactToken(value.excerpt, this.token)) : '';
    if (excerpt.length > 0) item.summary = excerpt.slice(0, SUMMARY_LIMIT);
    const updatedAt = toConnectorTimestamp(value.lastModified);
    if (updatedAt) item.updatedAt = updatedAt;
    const space = isRecord(value.resultGlobalContainer) ? value.resultGlobalContainer : undefined;
    const container = typeof space?.title === 'string' ? cleanSearchText(redactToken(space.title, this.token)) : '';
    if (container.length > 0) item.container = container.slice(0, TITLE_LIMIT);
    return item;
  }

  private mapSpace(value: unknown): ConnectorItem | undefined {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) return undefined;
    const id = value.id.trim();
    const rawTitle = typeof value.name === 'string' && value.name.trim().length > 0 ? value.name.trim() : id;
    const item: ConnectorItem = {
      id,
      title: redactToken(rawTitle, this.token).slice(0, TITLE_LIMIT),
      url: itemUrl(value, this.baseUrl, `/wiki/spaces/${encodeURIComponent(id)}`),
      raw: serializeRaw(value, this.token),
    };
    const description = isRecord(value.description) ? value.description : undefined;
    const plainDescription = isRecord(description?.plain) ? description.plain : undefined;
    const descriptionText = typeof plainDescription?.value === 'string' ? plainDescription.value : '';
    const summary = redactToken(descriptionText.replace(/\s+/g, ' ').trim(), this.token);
    if (summary.length > 0) item.summary = summary.slice(0, SUMMARY_LIMIT);
    return item;
  }
}

// Reserved characters of the full-text syntax that Confluence applies inside a `text ~ "..."` literal (Lucene-style):
// boolean/required/prohibited prefixes, grouping, ranges, boosting, fuzzy/proximity, wildcards, field qualifiers,
// phrase quotes (ASCII and typographic), escapes and regex slashes.
const CQL_TEXT_RESERVED = /[+\-&|!(){}[\]^"\u201c\u201d~*?:\\/]/gu;
const CQL_TEXT_BOOLEAN_WORD = /^(?:OR|AND|NOT|TO)$/u;

/**
 * Render bounded User search text as plain literal terms for the CQL `text ~` operator (ADR-0100 D7: the adapter owns
 * CQL rendering and escaping). Beyond the string-literal escaping (`escapeCqlText`), the full-text syntax inside the
 * literal is neutralized: reserved characters become separators and the uppercase boolean/range words are lowercased,
 * so the text can only match as ordinary words. Text with no remaining term is UNSUPPORTED_QUERY.
 */
function confluenceSearchTerms(text: string): string {
  const terms = text
    .replace(CQL_TEXT_RESERVED, ' ')
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map((term) => (CQL_TEXT_BOOLEAN_WORD.test(term) ? term.toLowerCase() : term));
  if (terms.length === 0) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'confluence connector: search text has no searchable terms');
  }
  return terms.join(' ');
}

/** CQL string-literal escaping: backslash first, then double quote. */
function escapeCqlText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Search `_links.base` is trusted only when it stays on the configured host; otherwise `/wiki` under the host. */
function searchBase(payload: Record<string, unknown>, baseUrl: string): string {
  const links = isRecord(payload._links) ? payload._links : undefined;
  if (typeof links?.base === 'string') {
    try {
      const candidate = new URL(links.base);
      if (candidate.origin === baseUrl && !candidate.search && !candidate.hash) return candidate.href.replace(/\/+$/, '');
    } catch {
      // fall through to the configured host
    }
  }
  return `${baseUrl}/wiki`;
}

/** Removes search highlight markers and HTML, decodes the common entities and collapses whitespace. */
function cleanSearchText(value: string): string {
  return value
    .replace(/@@@(?:end)?hl@@@/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function itemUrl(value: Record<string, unknown>, baseUrl: string, fallbackPath: string): string {
  const links = isRecord(value._links) ? value._links : undefined;
  const webui = typeof links?.webui === 'string' ? links.webui : '';
  if (webui.startsWith('/') && !webui.startsWith('//')) return new URL(webui, baseUrl).toString();
  return new URL(fallbackPath, baseUrl).toString();
}

function extractPageSummary(value: Record<string, unknown>, token: string): string {
  const body = isRecord(value.body) ? value.body : undefined;
  const storage = isRecord(body?.storage) ? body.storage : undefined;
  const raw = typeof storage?.value === 'string' ? storage.value : '';
  return redactToken(raw.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(), token);
}

function serializeRaw(value: unknown, token: string): Metadata {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '{}';
  } catch {
    json = '{}';
  }
  json = redactToken(json, token);
  if (json.length > RAW_JSON_LIMIT) json = `${json.slice(0, RAW_JSON_LIMIT)}[truncated]`;
  return { json };
}

/**
 * Atlassian Cloud user API tokens authenticate with Basic `email:token`; Bearer is only valid for Data Center
 * personal access tokens (and OAuth). An email therefore selects Basic. The header value is held in memory only.
 */
function authorizationHeader(token: string, email: unknown): string {
  if (email === undefined) return `Bearer ${token}`;
  const account = requireNonEmpty(email, 'email');
  return `Basic ${Buffer.from(`${account}:${token}`, 'utf8').toString('base64')}`;
}

/**
 * Normalize the configured host to an https origin. The site root and the Confluence `/wiki` context path are both
 * accepted (the request paths below already carry `/wiki`, so keeping it here would double it); any other path is
 * rejected.
 */
function normalizeHost(host: string): string {
  const candidate = host.startsWith('https://') ? host : `https://${host}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('confluence connector: host must be a valid Confluence Cloud host');
  }
  const pathAccepted = url.pathname === '/' || url.pathname === '/wiki' || url.pathname === '/wiki/';
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !pathAccepted || url.search || url.hash) {
    throw new Error(
      'confluence connector: host must be an https host (optionally ending in /wiki) without credentials, port, other path, query, or fragment',
    );
  }
  return url.origin;
}

function boundedLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) {
    throw new Error(`confluence connector: limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value as number;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`confluence connector: a non-empty ${label} is required`);
  }
  return value.trim();
}

function mapHttpError(status: number): ConfluenceConnectorHttpError {
  if (status === 401) return new ConfluenceConnectorHttpError('UNAUTHORIZED', status);
  if (status === 403) return new ConfluenceConnectorHttpError('FORBIDDEN', status);
  if (status === 404) return new ConfluenceConnectorHttpError('NOT_FOUND', status);
  if (status === 429) return new ConfluenceConnectorHttpError('RATE_LIMITED', status);
  if (status >= 500) return new ConfluenceConnectorHttpError('SERVER_ERROR', status);
  return new ConfluenceConnectorHttpError('HTTP_ERROR', status);
}

function redactToken(value: string, token: string): string {
  return value.split(token).join('[redacted]');
}

function isConnectorItem(value: ConnectorItem | undefined): value is ConnectorItem {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
