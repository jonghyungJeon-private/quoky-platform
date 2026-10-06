import {
  ConnectorQueryError,
  ConnectorQueryName,
  parseSearchParams,
  resolveConnectorQueryTimeoutMs,
  toConnectorTimestamp,
  type ConnectorItem,
  type ConnectorProvider,
  type ConnectorQuery,
  type ConnectorQueryErrorReason,
  type ConnectorResult,
} from '@quoky/core';

const SLACK_API_ORIGIN = 'https://slack.com';
const PAGE_SIZE = 100;
const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_MAX_PAGES = 3;
const MAX_ITEMS_LIMIT = 500;
const MAX_PAGES_LIMIT = 10;
const TITLE_LIMIT = 120;
const SUMMARY_LIMIT = 500;
const SEARCH_PERMALINK_PATTERN = /^https:\/\/[A-Za-z0-9.-]+\.slack\.com\//;

export interface SlackConnectorConfig {
  token: string;
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  maxItems?: number;
  maxPages?: number;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export type SlackListItemsInput =
  | { kind: 'channels' }
  | { kind: 'messages'; channelId: string }
  | { kind: 'thread'; channelId: string; threadTs: string };

export interface SlackGetItemInput {
  channelId: string;
  ts: string;
}

export type SlackConnectorHttpErrorKind =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INSUFFICIENT_SCOPE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR'
  | 'API_ERROR';

/** A sanitized Slack failure. It never contains response content, credentials, or request headers. */
export class SlackConnectorHttpError extends ConnectorQueryError {
  constructor(
    readonly kind: SlackConnectorHttpErrorKind,
    readonly status: number,
  ) {
    super(reasonForKind(kind), `slack connector: query failed (${kind.toLowerCase()})`);
    this.name = 'SlackConnectorHttpError';
  }
}

/** A sanitized transport failure. The underlying fetch error is deliberately not retained. */
export class SlackConnectorRequestError extends ConnectorQueryError {
  constructor() {
    super('UNAVAILABLE', 'slack connector: query request failed');
    this.name = 'SlackConnectorRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class SlackConnectorResponseError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'slack connector: query returned an unexpected response');
    this.name = 'SlackConnectorResponseError';
  }
}

export class SlackConnectorStateError extends ConnectorQueryError {
  constructor() {
    super('UNAVAILABLE', 'slack connector: connector is disconnected');
    this.name = 'SlackConnectorStateError';
  }
}

interface SlackPage {
  ok: true;
  values: unknown[];
  nextCursor: string;
}

export class SlackConnectorProvider implements ConnectorProvider {
  readonly id = 'slack';
  readonly source = this.id;
  readonly readOnly = true;

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxItems: number;
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private connected = true;

  constructor(config: SlackConnectorConfig) {
    this.token = requireNonEmpty(config?.token, 'token');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxItems = boundedInteger(config.maxItems, DEFAULT_MAX_ITEMS, 1, MAX_ITEMS_LIMIT, 'maxItems');
    this.maxPages = boundedInteger(config.maxPages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_LIMIT, 'maxPages');
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'slack connector');
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async isAvailable(): Promise<boolean> {
    return this.connected;
  }

  async query(input: ConnectorQuery): Promise<ConnectorResult> {
    const name = input?.query;
    if (name === ConnectorQueryName.SEARCH) return this.search(input);
    if (name === ConnectorQueryName.PERSONAL_WORK) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'slack connector: unsupported query');
    }
    const kind = input?.params?.kind;
    if (kind === undefined && typeof name === 'string' && name.trim().length > 0) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'slack connector: unsupported query');
    }
    if (kind === undefined || kind === 'channels') return this.listItems({ kind: 'channels' });
    if (kind === 'messages') {
      return this.listItems({ kind, channelId: requireNonEmpty(input.params?.channelId, 'channelId') });
    }
    if (kind === 'thread') {
      return this.listItems({
        kind,
        channelId: requireNonEmpty(input.params?.channelId, 'channelId'),
        threadTs: requireNonEmpty(input.params?.threadTs, 'threadTs'),
      });
    }
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'slack connector: unsupported query kind');
  }

  async listItems(input: SlackListItemsInput = { kind: 'channels' }): Promise<ConnectorResult> {
    this.assertConnected();
    if (input.kind === 'channels') {
      const values = await this.fetchPages('conversations.list', {});
      return { source: this.source, items: values.map((value) => mapChannel(value, this.token)).filter(isConnectorItem) };
    }

    const channelId = requireNonEmpty(input.channelId, 'channelId');
    if (input.kind === 'messages') {
      const values = await this.fetchPages('conversations.history', { channel: channelId });
      return {
        source: this.source,
        items: values.map((value) => mapMessage(value, channelId, this.token)).filter(isConnectorItem),
      };
    }

    const threadTs = requireNonEmpty(input.threadTs, 'threadTs');
    const values = await this.fetchPages('conversations.replies', { channel: channelId, ts: threadTs });
    return {
      source: this.source,
      items: values.map((value) => mapMessage(value, channelId, this.token)).filter(isConnectorItem),
    };
  }

  /** Named `search` query: GET search.messages. Needs a user token with search:read (a bot token gets INSUFFICIENT_SCOPE). */
  private async search(input: ConnectorQuery): Promise<ConnectorResult> {
    this.assertConnected();
    const { text, limit } = parseSearchParams(input.params, 'slack connector');
    const url = new URL('/api/search.messages', SLACK_API_ORIGIN);
    url.searchParams.set('query', slackSearchQuery(text));
    url.searchParams.set('count', String(limit));
    url.searchParams.set('sort', 'timestamp');

    const payload = await readSlackPayload(await this.request(url));
    const messages = isRecord(payload.messages) ? payload.messages : undefined;
    if (!messages || !Array.isArray(messages.matches)) throw new SlackConnectorResponseError();
    const items = messages.matches
      .slice(0, limit)
      .map((match) => mapSearchMatch(match, this.token))
      .filter(isConnectorItem);
    return { source: this.source, items };
  }

  async getItem(input: SlackGetItemInput): Promise<ConnectorItem | undefined> {
    const channelId = requireNonEmpty(input?.channelId, 'channelId');
    const ts = requireNonEmpty(input?.ts, 'ts');
    const result = await this.listItems({ kind: 'thread', channelId, threadTs: ts });
    return result.items.find((item) => item.raw?.ts === ts);
  }

  private assertConnected(): void {
    if (!this.connected) throw new SlackConnectorStateError();
  }

  private async fetchPages(method: string, params: Record<string, string>): Promise<unknown[]> {
    const values: unknown[] = [];
    let cursor = '';

    for (let page = 0; page < this.maxPages && values.length < this.maxItems; page += 1) {
      const url = new URL(`/api/${method}`, SLACK_API_ORIGIN);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      url.searchParams.set('limit', String(Math.min(PAGE_SIZE, this.maxItems - values.length)));
      if (cursor.length > 0) url.searchParams.set('cursor', cursor);

      const response = await this.request(url);
      const parsed = await parseSlackPage(response, method);
      values.push(...parsed.values.slice(0, this.maxItems - values.length));
      cursor = parsed.nextCursor;
      if (cursor.length === 0) break;
    }

    return values;
  }

  private async request(url: URL): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SlackConnectorRequestError();
    }
    if (!response.ok) throw mapHttpError(response.status);
    return response;
  }
}

async function readSlackPayload(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SlackConnectorResponseError();
  }
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') throw new SlackConnectorResponseError();
  if (!payload.ok) throw mapSlackApiError(typeof payload.error === 'string' ? payload.error : '');
  return payload;
}

async function parseSlackPage(response: Response, method: string): Promise<SlackPage> {
  const payload = await readSlackPayload(response);
  const field = method === 'conversations.list' ? 'channels' : 'messages';
  if (!Array.isArray(payload[field])) throw new SlackConnectorResponseError();
  const metadata = isRecord(payload.response_metadata) ? payload.response_metadata : undefined;
  const nextCursor = typeof metadata?.next_cursor === 'string' ? metadata.next_cursor.trim() : '';
  return { ok: true, values: payload[field], nextCursor };
}

function mapChannel(value: unknown, token: string): ConnectorItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) return undefined;
  const id = value.id.trim();
  const rawName = typeof value.name === 'string' && value.name.trim().length > 0 ? value.name.trim() : id;
  const name = redactToken(rawName, token);
  const purpose = isRecord(value.purpose) && typeof value.purpose.value === 'string' ? value.purpose.value.trim() : '';
  const topic = isRecord(value.topic) && typeof value.topic.value === 'string' ? value.topic.value.trim() : '';
  const summary = redactToken(purpose || topic, token);
  const item: ConnectorItem = {
    id,
    title: `#${name}`.slice(0, TITLE_LIMIT),
    raw: { kind: 'channel', channelId: id },
  };
  if (summary.length > 0) item.summary = summary.slice(0, SUMMARY_LIMIT);
  return item;
}

function mapMessage(value: unknown, channelId: string, token: string): ConnectorItem | undefined {
  if (!isRecord(value) || typeof value.ts !== 'string' || value.ts.trim().length === 0) return undefined;
  const ts = value.ts.trim();
  const text = typeof value.text === 'string' ? redactToken(value.text.replace(/\s+/g, ' ').trim(), token) : '';
  const item: ConnectorItem = {
    id: `${channelId}:${ts}`,
    title: (text || `Slack message ${ts}`).slice(0, TITLE_LIMIT),
    raw: { kind: 'message', channelId, ts },
  };
  if (text.length > 0) item.summary = text.slice(0, SUMMARY_LIMIT);
  return item;
}

function mapSearchMatch(value: unknown, token: string): ConnectorItem | undefined {
  if (!isRecord(value) || typeof value.ts !== 'string' || value.ts.trim().length === 0) return undefined;
  const channel = isRecord(value.channel) ? value.channel : undefined;
  if (typeof channel?.id !== 'string' || channel.id.trim().length === 0) return undefined;
  const channelId = channel.id.trim();
  const ts = value.ts.trim();
  const text = typeof value.text === 'string' ? redactToken(value.text.replace(/\s+/g, ' ').trim(), token) : '';
  const item: ConnectorItem = {
    id: `${channelId}:${ts}`,
    title: (text || `Slack message ${ts}`).slice(0, TITLE_LIMIT),
    raw: { kind: 'message', channelId, ts },
  };
  if (text.length > 0) item.summary = text.slice(0, SUMMARY_LIMIT);
  if (typeof value.permalink === 'string' && SEARCH_PERMALINK_PATTERN.test(value.permalink)) item.url = value.permalink;
  const channelName = typeof channel.name === 'string' ? redactToken(channel.name.trim(), token) : '';
  if (channelName.length > 0) item.container = `#${channelName}`;
  const updatedAt = toConnectorTimestamp(Number(ts) * 1000);
  if (updatedAt) item.updatedAt = updatedAt;
  return item;
}

// Slack search syntax: phrase quotes (ASCII and typographic), the `modifier:` colon (in:, from:, to:, has:, is:,
// before:, after:, on:, during:, with:, ...), the `*` wildcard and grouping/angle brackets.
const SLACK_SEARCH_SYNTAX = /["\u201c\u201d\u201e\u201f:*()<>]/gu;
// A leading `-` excludes a term; `+`, `~` and `!` are stripped as well so no prefix operator survives.
const SLACK_TERM_PREFIX = /^[-+~!]+/u;
const SLACK_BOOLEAN_WORD = /^(?:OR|AND|NOT)$/u;

/**
 * Render bounded User search text as Slack literal terms (ADR-0100 D7: the adapter owns Slack search rendering and
 * escaping). Slack's query language has no escape character, so syntax characters become separators, prefix
 * operators are dropped, boolean words are lowercased, and every remaining term is quoted so it can only ever match
 * literally (an implicit AND of terms). No modifier, exclusion, wildcard or operator can be injected. Text with no
 * remaining term is UNSUPPORTED_QUERY.
 */
function slackSearchQuery(text: string): string {
  const terms = text
    .replace(SLACK_SEARCH_SYNTAX, ' ')
    .split(/\s+/u)
    .map((term) => term.replace(SLACK_TERM_PREFIX, ''))
    .filter((term) => term.length > 0)
    .map((term) => (SLACK_BOOLEAN_WORD.test(term) ? term.toLowerCase() : term));
  if (terms.length === 0) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'slack connector: search text has no searchable terms');
  }
  return terms.map((term) => `"${term}"`).join(' ');
}

function reasonForKind(kind: SlackConnectorHttpErrorKind): ConnectorQueryErrorReason {
  switch (kind) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPE':
    case 'NOT_FOUND':
    case 'RATE_LIMITED':
      return kind;
    default:
      return 'UNAVAILABLE';
  }
}

function mapHttpError(status: number): SlackConnectorHttpError {
  if (status === 401) return new SlackConnectorHttpError('UNAUTHORIZED', status);
  if (status === 403) return new SlackConnectorHttpError('FORBIDDEN', status);
  if (status === 404) return new SlackConnectorHttpError('NOT_FOUND', status);
  if (status === 429) return new SlackConnectorHttpError('RATE_LIMITED', status);
  if (status >= 500) return new SlackConnectorHttpError('SERVER_ERROR', status);
  return new SlackConnectorHttpError('HTTP_ERROR', status);
}

function mapSlackApiError(code: string): SlackConnectorHttpError {
  if (['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'].includes(code)) {
    return new SlackConnectorHttpError('UNAUTHORIZED', 200);
  }
  if (['missing_scope', 'not_allowed_token_type'].includes(code)) {
    return new SlackConnectorHttpError('INSUFFICIENT_SCOPE', 200);
  }
  if (code === 'restricted_action') return new SlackConnectorHttpError('FORBIDDEN', 200);
  if (['channel_not_found', 'thread_not_found', 'message_not_found'].includes(code)) {
    return new SlackConnectorHttpError('NOT_FOUND', 200);
  }
  if (code === 'ratelimited') return new SlackConnectorHttpError('RATE_LIMITED', 200);
  return new SlackConnectorHttpError('API_ERROR', 200);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`slack connector: ${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`slack connector: a non-empty ${label} is required`);
  }
  return value.trim();
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

// ADR-0112 D2/D4 (CWR-1): the separate, allowlisted bot-token post adapter. The read-only provider above is unchanged.
export {
  SlackChannelWriter,
  escapeSlackText,
  type SlackChannelWriterConfig,
  type SlackWriteChannel,
} from './slack-channel-writer';
