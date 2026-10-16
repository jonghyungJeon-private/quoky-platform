import {
  ConnectorQueryError,
  ConnectorQueryName,
  CONNECTOR_ITEM_RESPONSE_MAX_BYTES,
  parseItemParams,
  parseSearchParams,
  resolveConnectorQueryTimeoutMs,
  toConnectorTimestamp,
  type ConnectorItem,
  type ConnectorItemDetail,
  type ConnectorItemSection,
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
/** The title of a message with no text (live QA D15: never a raw `ts`). */
const EMPTY_MESSAGE_TITLE = '(내용 없음)';
/** The container label when a channel's name cannot be read (never a raw channel or user id). */
const FALLBACK_CONTAINER = 'Slack';
/** A Slack conversation / user id where a name should be ("U07H…", "C0…"): never shown as a channel name. */
const SLACK_ID_SHAPE = /^[CDGUW][A-Z0-9]{6,}$/;
/** At most this many channel lookups are cached (the oldest is dropped first). */
const CHANNEL_CACHE_MAX = 500;
/** A6 R2: the item reference `channelId:ts[:threadTs]` and the Slack timestamp shape. */
const SLACK_ITEM_REF = /^([CG][A-Z0-9]{6,}):(\d{10}\.\d{6})(?::(\d{10}\.\d{6}))?$/;
const SLACK_TS = /^\d{10}\.\d{6}$/;
/** A thread read holds the parent and at most this many messages in all (one page, the cursor is never followed). */
const THREAD_PAGE_LIMIT = 50;

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

/** A6 R2: a response over CONNECTOR_ITEM_RESPONSE_MAX_BYTES, aborted while streaming. Distinguishable by `tooLarge`. */
export class SlackConnectorItemTooLargeError extends ConnectorQueryError {
  readonly tooLarge = true;
  constructor(readonly bytes: number = CONNECTOR_ITEM_RESPONSE_MAX_BYTES) {
    // CA P3: its own neutral reason, apart from a malformed answer (INVALID_RESPONSE).
    super('TOO_LARGE', 'slack connector: item response too large');
    this.name = 'SlackConnectorItemTooLargeError';
  }
}

export class SlackConnectorStateError extends ConnectorQueryError {
  constructor() {
    super('UNAVAILABLE', 'slack connector: connector is disconnected');
    this.name = 'SlackConnectorStateError';
  }
}

/**
 * What is known about a conversation's type: a public or private `channel`, a `direct` message / group DM, or
 * `unknown` (no flag and no id prefix settles it). Only a `channel` is ever shown (fail closed).
 */
type SlackConversationKind = 'channel' | 'direct' | 'unknown';

/** What a `conversations.info` lookup established (cached only when the lookup succeeded). */
interface SlackChannelFacts {
  readonly kind: SlackConversationKind;
  readonly name?: string;
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
  /** Channel id → facts from `conversations.info` (needs `channels:read` / `groups:read`; failures cached too). */
  private readonly channelFacts = new Map<string, SlackChannelFacts>();

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
    if (name === ConnectorQueryName.ITEM) return this.item(input);
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

  /**
   * Named `search` query: GET search.messages. Needs a user token with search:read (a bot token gets INSUFFICIENT_SCOPE).
   *
   * Live QA D3: the user token also sees the owner's direct messages, and a lookup answer is posted into a (possibly
   * shared) Discord channel. Only results from a conversation established as a public or private channel are shown:
   * direct messages and group DMs are dropped, and so is any conversation whose type neither the match nor a
   * `conversations.info` lookup settles (fail closed). Each result is labelled `#name`: the name from the match, or
   * from the cached lookup, else the neutral "Slack".
   */
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
    const matches = messages.matches.slice(0, limit).filter((match) => conversationKindOf(channelOf(match)) !== 'direct');
    // An id-only or otherwise unsettled conversation is looked up; whatever stays unknown is omitted (Codex P2).
    const lookups = new Set<string>();
    for (const match of matches) {
      const channel = channelOf(match);
      const hasTs = isRecord(match) && typeof match.ts === 'string' && match.ts.trim().length > 0;
      if (!channel || !hasTs) continue;
      if (conversationKindOf(channel) === 'unknown' || channelNameOf(channel, this.token) === undefined) lookups.add(channel.id);
    }
    const looked = new Map<string, SlackChannelFacts | undefined>();
    await Promise.all([...lookups].map(async (channelId) => looked.set(channelId, await this.lookupChannel(channelId))));
    const items = matches
      .map((match) => {
        const channel = channelOf(match);
        if (!channel) return undefined;
        const facts = looked.get(channel.id);
        const own = conversationKindOf(channel);
        const kind = own !== 'unknown' ? own : (facts?.kind ?? 'unknown');
        if (kind !== 'channel' || facts?.kind === 'direct') return undefined;
        const name = channelNameOf(channel, this.token) ?? facts?.name;
        return mapSearchMatch(match, this.token, name !== undefined ? `#${name}` : FALLBACK_CONTAINER);
      })
      .filter(isConnectorItem);
    return { source: this.source, items };
  }

  /**
   * A6 R2 `item`: ONE `conversations.replies` request (GET, never paginated) for a listed message or its thread. No
   * `conversations.info`, `users.info` or `chat.getPermalink` call is made.
   */
  private async item(input: ConnectorQuery): Promise<ConnectorResult> {
    this.assertConnected();
    const { id, scope } = parseItemParams(input.params, 'slack connector');
    const ref = SLACK_ITEM_REF.exec(id);
    if (!ref) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'slack connector: unsupported item reference');
    const channel = ref[1]!;
    const ts = ref[2]!;
    const refThreadTs = ref[3] !== undefined && ref[3] !== ts ? ref[3] : undefined;
    const url = new URL('/api/conversations.replies', SLACK_API_ORIGIN);
    url.searchParams.set('channel', channel);
    let replyIsolated = false;
    if (scope === 'thread') {
      url.searchParams.set('ts', refThreadTs ?? ts);
      url.searchParams.set('limit', String(THREAD_PAGE_LIMIT));
    } else if (refThreadTs !== undefined) {
      replyIsolated = true;
      url.searchParams.set('ts', refThreadTs);
      url.searchParams.set('oldest', ts);
      url.searchParams.set('latest', ts);
      url.searchParams.set('inclusive', 'true');
      url.searchParams.set('limit', '2');
    } else {
      url.searchParams.set('ts', ts);
      url.searchParams.set('limit', '1');
      url.searchParams.set('inclusive', 'true');
    }

    const { payload, bytes } = await this.getItemPayload(url);
    const messages = payload.messages;
    if (!Array.isArray(messages)) throw new SlackConnectorResponseError();
    const notFound = (): ConnectorQueryError => new ConnectorQueryError('NOT_FOUND', 'slack connector: item not found');
    const tsOf = (message: unknown): string | undefined => (isRecord(message) && typeof message.ts === 'string' ? message.ts : undefined);
    const isTombstone = (message: unknown): boolean => isRecord(message) && message.subtype === 'tombstone';

    let kept: unknown[];
    let replyCount: number | undefined;
    let hasMore: boolean | undefined;
    if (scope === 'thread') {
      const threadTs = refThreadTs ?? ts;
      if (tsOf(messages[0]) !== threadTs || isTombstone(messages[0])) throw notFound();
      kept = messages.slice(0, THREAD_PAGE_LIMIT).filter((message, index) => index === 0 || (isRecord(message) && !isTombstone(message)));
      hasMore = payload.has_more === true;
    } else if (replyIsolated) {
      // Slack may prepend the parent: take exactly the message whose ts is the listed ts, never the parent or a neighbour.
      let selected: unknown;
      if (tsOf(messages[0]) === ts) selected = messages[0];
      else if (tsOf(messages[0]) === refThreadTs && tsOf(messages[1]) === ts) selected = messages[1];
      if (selected === undefined || isTombstone(selected)) throw notFound();
      kept = [selected];
    } else {
      if (tsOf(messages[0]) !== ts || isTombstone(messages[0])) throw notFound();
      kept = [messages[0]];
      const count = (messages[0] as Record<string, unknown>).reply_count;
      replyCount = typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
    }

    const sections: ConnectorItemSection[] = [];
    const people = new Set<string>();
    for (const message of kept) {
      const record = message as Record<string, unknown>;
      const flat = flattenSlackMrkdwn(typeof record.text === 'string' ? record.text : '');
      const authorRaw = typeof record.user === 'string' && record.user.trim().length > 0 ? record.user.trim() : typeof record.bot_id === 'string' && record.bot_id.trim().length > 0 ? record.bot_id.trim() : 'unknown';
      const author = redactToken(authorRaw, this.token);
      const section: ConnectorItemSection = { kind: 'message', author, text: redactToken(flat.text, this.token) };
      const at = typeof record.ts === 'string' ? toConnectorTimestamp(Number(record.ts) * 1000) : undefined;
      if (at !== undefined) section.at = at;
      if (author !== 'unknown') people.add(author);
      for (const user of flat.users) people.add(redactToken(user, this.token));
      sections.push(section);
    }

    const firstLine = (sections[0]?.text ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0);
    const detail: ConnectorItemDetail = {
      sections,
      partial: hasMore === true,
      people: [...people],
      requests: 1,
      bytes,
    };
    if (replyCount !== undefined) detail.replyCount = replyCount;
    if (hasMore !== undefined) detail.hasMore = hasMore;
    // Codex P2: freshness is the latest create OR edit time of what was read (`edited.ts`), so an edit after the listing
    // is reported ("목록 이후 수정됨").
    const stamps = kept.flatMap((message) => {
      const record = isRecord(message) ? message : {};
      const edited = isRecord(record.edited) && typeof record.edited.ts === 'string' ? record.edited.ts : undefined;
      return [tsOf(message), edited].filter((value): value is string => typeof value === 'string' && /^\d{10}\.\d{6}$/.test(value)).map(Number);
    });
    const latest = stamps.length > 0 ? Math.max(...stamps) : undefined;
    const updatedAt = latest !== undefined ? toConnectorTimestamp(latest * 1000) : undefined;
    const item: ConnectorItem = {
      id: `${channel}:${ts}`,
      title: (firstLine ?? EMPTY_MESSAGE_TITLE).slice(0, TITLE_LIMIT),
      itemRef: id,
      detail,
    };
    if (updatedAt) item.updatedAt = updatedAt;
    return { source: this.source, items: [item] };
  }

  /**
   * One item GET. The egress guard of this runtime does not enforce `redirect: 'error'`, so the adapter sets
   * `redirect: 'manual'` itself and maps any 3xx (or an opaque redirect) to `MOVED`: nothing is ever followed. The body
   * is streamed and counted; above CONNECTOR_ITEM_RESPONSE_MAX_BYTES the reader is cancelled.
   */
  private async getItemPayload(url: URL): Promise<{ payload: Record<string, unknown>; bytes: number }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
    } catch {
      throw new SlackConnectorRequestError();
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) {
      void response.body?.cancel().catch(() => undefined);
      throw new ConnectorQueryError('MOVED', 'slack connector: item moved');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw mapHttpError(response.status);
    }
    const { text, bytes } = await readCappedText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SlackConnectorResponseError();
    }
    if (!isRecord(payload) || typeof payload.ok !== 'boolean') throw new SlackConnectorResponseError();
    if (!payload.ok) throw mapSlackApiError(typeof payload.error === 'string' ? payload.error : '');
    return { payload, bytes };
  }

  /**
   * `conversations.info` for one channel id (needs `channels:read` / `groups:read`). A successful answer is cached; a
   * failure (no scope, Slack unavailable) returns undefined and is retried on a later search — never thrown, never
   * guessed: the caller then omits a conversation whose type it cannot establish.
   */
  private async lookupChannel(channelId: string): Promise<SlackChannelFacts | undefined> {
    const cached = this.channelFacts.get(channelId);
    if (cached) return cached;
    let facts: SlackChannelFacts;
    try {
      const url = new URL('/api/conversations.info', SLACK_API_ORIGIN);
      url.searchParams.set('channel', channelId);
      const payload = await readSlackPayload(await this.request(url));
      const channel = isRecord(payload.channel) ? payload.channel : undefined;
      if (!channel) return undefined;
      const kind = conversationKindOf({ ...channel, id: channelId });
      const name = kind === 'channel' ? channelNameOf(channel, this.token) : undefined;
      facts = { kind, ...(name !== undefined ? { name } : {}) };
    } catch {
      return undefined;
    }
    if (facts.kind === 'unknown') return facts;
    this.channelFacts.set(channelId, facts);
    while (this.channelFacts.size > CHANNEL_CACHE_MAX) {
      const oldest = this.channelFacts.keys().next().value;
      if (oldest === undefined) break;
      this.channelFacts.delete(oldest);
    }
    return facts;
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
    title: (text || EMPTY_MESSAGE_TITLE).slice(0, TITLE_LIMIT),
    raw: { kind: 'message', channelId, ts },
  };
  if (text.length > 0) item.summary = text.slice(0, SUMMARY_LIMIT);
  return item;
}

/** A search match's `channel` object with a usable id, or undefined. */
function channelOf(match: unknown): (Record<string, unknown> & { id: string }) | undefined {
  if (!isRecord(match) || !isRecord(match.channel)) return undefined;
  const id = match.channel.id;
  if (typeof id !== 'string' || id.trim().length === 0) return undefined;
  return { ...match.channel, id: id.trim() };
}

/**
 * The conversation type a Slack channel object settles: `direct` for a DM or group DM (`D…` id, `is_im`, `is_mpim`,
 * an `mpdm-` name); `channel` for a `C…` id (public or private channels only) or explicit `is_im: false` and
 * `is_mpim: false`; otherwise `unknown` (e.g. an id-only `G…`, which may be a legacy private channel or a group DM).
 */
function conversationKindOf(channel: (Record<string, unknown> & { id: string }) | undefined): SlackConversationKind {
  if (!channel) return 'unknown';
  if (channel.id.startsWith('D') || channel.is_im === true || channel.is_mpim === true) return 'direct';
  if (typeof channel.name === 'string' && channel.name.startsWith('mpdm-')) return 'direct';
  if (channel.id.startsWith('C')) return 'channel';
  if (channel.is_im === false && channel.is_mpim === false) return 'channel';
  return 'unknown';
}

/** The channel's own readable name from the match (undefined when absent or only an id, e.g. a DM's user id). */
function channelNameOf(channel: Record<string, unknown>, token: string): string | undefined {
  const name = typeof channel.name === 'string' ? redactToken(channel.name.trim(), token) : '';
  return name.length > 0 && !SLACK_ID_SHAPE.test(name) ? name : undefined;
}

function mapSearchMatch(value: unknown, token: string, container: string): ConnectorItem | undefined {
  if (!isRecord(value) || typeof value.ts !== 'string' || value.ts.trim().length === 0) return undefined;
  const channel = channelOf(value);
  if (!channel) return undefined;
  const channelId = channel.id;
  const ts = value.ts.trim();
  const text = typeof value.text === 'string' ? redactToken(value.text.replace(/\s+/g, ' ').trim(), token) : '';
  const item: ConnectorItem = {
    id: `${channelId}:${ts}`,
    title: (text || EMPTY_MESSAGE_TITLE).slice(0, TITLE_LIMIT),
    raw: { kind: 'message', channelId, ts },
  };
  if (text.length > 0) item.summary = text.slice(0, SUMMARY_LIMIT);
  if (typeof value.permalink === 'string' && SEARCH_PERMALINK_PATTERN.test(value.permalink)) item.url = value.permalink;
  item.container = container;
  const updatedAt = toConnectorTimestamp(Number(ts) * 1000);
  if (updatedAt) item.updatedAt = updatedAt;
  if (SLACK_TS.test(ts)) {
    const threadTs = permalinkThreadTs(value.permalink);
    item.itemRef = threadTs !== undefined && threadTs !== ts ? `${channelId}:${ts}:${threadTs}` : `${channelId}:${ts}`;
  }
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

/** Reads a response body as a stream, counting bytes; above the item cap the reader is cancelled. */
async function readCappedText(response: Response): Promise<{ text: string; bytes: number }> {
  const max = CONNECTOR_ITEM_RESPONSE_MAX_BYTES;
  const reader = response.body?.getReader();
  if (reader === undefined) {
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch {
      throw new SlackConnectorRequestError();
    }
    if (buffer.byteLength > max) throw new SlackConnectorItemTooLargeError(buffer.byteLength);
    return { text: decodeUtf8(new Uint8Array(buffer)), bytes: buffer.byteLength };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await reader.read();
    } catch {
      throw new SlackConnectorRequestError();
    }
    if (result.done) break;
    const value = result.value ?? new Uint8Array(0);
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      throw new SlackConnectorItemTooLargeError(bytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decodeUtf8(all), bytes };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SlackConnectorResponseError();
  }
}

/**
 * A6 R2: Slack mrkdwn to plain text. `<!channel>` and friends become `@channel`; `<@U1>` / `<@U1|name>` become `@U1`
 * (the id is returned in `users`); `<#C1|name>` becomes `#name`; `<url|label>` becomes `label (url)`; then `&lt;`,
 * `&gt;` and `&amp;` are decoded.
 */
export function flattenSlackMrkdwn(input: string): { text: string; users: string[] } {
  const users: string[] = [];
  const replaced = input.replace(/<([^<>]*)>/g, (_whole, body: string) => {
    const bar = body.indexOf('|');
    const target = bar === -1 ? body : body.slice(0, bar);
    const label = bar === -1 ? undefined : body.slice(bar + 1);
    if (target.startsWith('!')) {
      const command = target.slice(1);
      if (command === 'channel' || command === 'here' || command === 'everyone') return `@${command}`;
      if (command.startsWith('subteam')) return label !== undefined && label.length > 0 ? (label.startsWith('@') ? label : `@${label}`) : '@usergroup';
      return label ?? '';
    }
    if (target.startsWith('@')) {
      const user = target.slice(1);
      if (user.length === 0) return '';
      if (!users.includes(user)) users.push(user);
      return `@${user}`;
    }
    if (target.startsWith('#')) return label !== undefined && label.length > 0 ? `#${label}` : '#channel';
    return label !== undefined && label.length > 0 ? `${label} (${target})` : target;
  });
  const text = replaced.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
  return { text, users };
}

/** The `thread_ts` of a search permalink when it is a Slack timestamp, else undefined. */
function permalinkThreadTs(permalink: unknown): string | undefined {
  if (typeof permalink !== 'string') return undefined;
  try {
    const value = new URL(permalink).searchParams.get('thread_ts');
    return value !== null && SLACK_TS.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function mapSlackApiError(code: string): SlackConnectorHttpError {
  if (['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'].includes(code)) {
    return new SlackConnectorHttpError('UNAUTHORIZED', 200);
  }
  if (['missing_scope', 'not_allowed_token_type'].includes(code)) {
    return new SlackConnectorHttpError('INSUFFICIENT_SCOPE', 200);
  }
  if (['restricted_action', 'not_in_channel', 'access_denied'].includes(code)) return new SlackConnectorHttpError('FORBIDDEN', 200);
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
