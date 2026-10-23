import type { Metadata } from '../domain';

/**
 * Connector query port contracts for chat-usable read-only work lookups (ADR-0100 D7).
 *
 * `ConnectorQuery.query` is a provider-neutral NAME, never a vendor query string. Adapters own the rendering and
 * escaping of vendor query languages (JQL, GitHub qualifiers, Slack search, CQL); an unknown or unsupported name is
 * rejected with `ConnectorQueryError('UNSUPPORTED_QUERY')`. The port stays read-only: no write vocabulary exists here.
 */

/** Named read-only queries every adapter may implement. */
export const ConnectorQueryName = {
  PERSONAL_WORK: 'personal-work',
  SEARCH: 'search',
  /**
   * ADR-0120 amendment A8: the containers (Jira projects) the configured account can see, as `{ id: key, title: name }`
   * items, at most {@link CONNECTOR_CATALOG_MAX_ITEMS}. No params; owner text is never sent.
   */
  CONTAINERS: 'containers',
  /** ADR-0120 amendment A8: the releases (Jira fix versions) of one container ({@link ReleasesQueryParams}). */
  RELEASES: 'releases',
  /** ADR-0120 amendment A8: the items in one release, any assignee unless `assignee` is set ({@link ReleaseItemsQueryParams}). */
  RELEASE_ITEMS: 'release-items',
  /**
   * ADR-0120 amendment A6 R2 (ADR-0100 D7 amendment C2): ONE listed item read by its opaque item reference
   * ({@link ItemQueryParams}), GET only. The reference is the `ConnectorItem.itemRef` a listing returned (Core never builds
   * one from owner text or content); the adapter re-validates its shape. Returns at most one item carrying `detail`.
   */
  ITEM: 'item',
  /**
   * ADR-0121 S2 P3 ("same-source detail reads" implementation note; owner answer 8 of the A1 ratification record): the
   * details of up to {@link CONNECTOR_ITEMS_BY_KEY_MAX} items of one source in ONE bulk request, by their closed-format
   * keys ({@link ItemsByKeyQueryParams}). Core passes only keys a deterministic projector took from an earlier read of
   * the same source and origin (ADR-0121 D2), never owner text or content; the adapter re-validates every key's shape.
   * A source that cannot bulk-fetch refuses it (`UNSUPPORTED_QUERY`), and the run's per-call bound applies instead.
   */
  ITEMS_BY_KEY: 'items-by-key',
} as const;
export type ConnectorQueryName = (typeof ConnectorQueryName)[keyof typeof ConnectorQueryName];

export const PERSONAL_WORK_FILTERS = ['all', 'due-this-week', 'review-requested'] as const;
export type PersonalWorkFilter = (typeof PERSONAL_WORK_FILTERS)[number];

/**
 * ADR-0120 D13 (an additive ADR-0100 D7 amendment): the optional window, role and status of `personal-work`. Without
 * them the query is exactly the ADR-0100 one (assignee, unresolved, not done). The window dates are local calendar
 * dates Core resolved with its clock and `QUOKY_TIMEZONE`; the adapter renders and escapes the vendor query.
 */
export const PERSONAL_WORK_WINDOW_FIELDS = ['created', 'updated', 'due'] as const;
export type PersonalWorkWindowField = (typeof PERSONAL_WORK_WINDOW_FIELDS)[number];
export const PERSONAL_WORK_ROLES = ['assignee', 'reporter', 'either'] as const;
export type PersonalWorkRole = (typeof PERSONAL_WORK_ROLES)[number];
export const PERSONAL_WORK_STATUSES = ['open', 'all', 'in-progress'] as const;
export type PersonalWorkStatus = (typeof PERSONAL_WORK_STATUSES)[number];
/**
 * The closed sort orders of `personal-work` (an additive ADR-0100 D7 / ADR-0120 D13 amendment, live UAT R8): a name the
 * adapter maps to a constant ORDER BY clause; owner text is never part of it. Absent: the adapter's own order.
 */
export const PERSONAL_WORK_SORTS = ['oldest', 'newest', 'recently-updated'] as const;
export type PersonalWorkSort = (typeof PERSONAL_WORK_SORTS)[number];
/**
 * The closed item types of a GitHub `personal-work` query (owner review of 2026-10-21, an additive ADR-0100 D7 amendment):
 * pull requests only or issues only. Absent: both (the ADR-0100 query). A source without item types refuses it.
 */
export const PERSONAL_WORK_ITEM_TYPES = ['pr', 'issue'] as const;
export type PersonalWorkItemType = (typeof PERSONAL_WORK_ITEM_TYPES)[number];

/**
 * `field` between the local dates `from` (inclusive) and `to` (exclusive), both `YYYY-MM-DD` in the owner's zone, at
 * most 31 days. `fromInstant` / `toInstant` (optional, both or neither) are the same boundaries as ISO instants, so an
 * adapter whose service reads dates in another zone (a Jira profile time zone) can place timestamp fields exactly.
 */
export interface PersonalWorkWindow {
  field: PersonalWorkWindowField;
  from: string;
  to: string;
  fromInstant?: string;
  toInstant?: string;
}

/** The longest window a `personal-work` query accepts (ADR-0120 D4 step 3). */
export const PERSONAL_WORK_WINDOW_MAX_DAYS = 31;

/** `ConnectorQuery.params` for the `personal-work` named query. */
export interface PersonalWorkQueryParams {
  actorExternalId: string;
  /** Defaults to `all`. */
  filter?: PersonalWorkFilter;
  /** Defaults to CONNECTOR_QUERY_DEFAULT_LIMIT; values above CONNECTOR_QUERY_MAX_LIMIT are clamped. */
  limit?: number;
  /** ADR-0120 D13. Absent: no date condition. */
  window?: PersonalWorkWindow;
  /** ADR-0120 D13. Defaults to `assignee`. */
  role?: PersonalWorkRole;
  /** ADR-0120 D13. Defaults to `open`. */
  status?: PersonalWorkStatus;
  /** Live UAT R8. Absent: the adapter's default order. */
  sort?: PersonalWorkSort;
  /** Owner review 2026-10-21 (GitHub only). Absent: issues and pull requests. */
  itemType?: PersonalWorkItemType;
}

/** `ConnectorQuery.params` for the `search` named query. */
export interface SearchQueryParams {
  /** 1..CONNECTOR_SEARCH_TEXT_MAX_LENGTH characters after whitespace normalization. */
  text: string;
  limit?: number;
}

/**
 * ADR-0120 amendment A8: `ConnectorQuery.params` for `releases`. `container` is a container key (a Jira project key,
 * `^[A-Z][A-Z0-9_]+$`, at most 20 characters) that Core resolved against the `containers` listing or read from a link on
 * the configured site; the adapter re-validates it and never interpolates anything else.
 */
export interface ReleasesQueryParams {
  container: string;
  /** At most this many releases (1..CONNECTOR_CATALOG_MAX_ITEMS, default the maximum); the adapter stops paging there. */
  limit?: number;
}

/**
 * ADR-0120 amendment A8: `ConnectorQuery.params` for `release-items`. Exactly one of `releaseId` (digits only) and
 * `releaseName` (1..100 characters, no control characters; the adapter quotes and escapes it). `container` bounds the
 * release to one container. `assignee` (an actor external id) limits the items to that assignee; absent = any assignee.
 */
export interface ReleaseItemsQueryParams {
  container?: string;
  releaseId?: string;
  releaseName?: string;
  assignee?: string;
  limit?: number;
}

/** A6 R2: what an `item` read covers: the item alone, or (Slack) its whole thread page. */
export const CONNECTOR_ITEM_SCOPES = ['item', 'thread'] as const;
export type ConnectorItemScope = (typeof CONNECTOR_ITEM_SCOPES)[number];

/** A6 R2: `ConnectorQuery.params` for `item`: the opaque item reference and the scope (default `item`). No other key. */
export interface ItemQueryParams {
  id: string;
  scope?: ConnectorItemScope;
}

/** A6 R2 (proposal §2.2): an `item` response is counted while streaming and aborted above this many bytes. */
export const CONNECTOR_ITEM_RESPONSE_MAX_BYTES = 1_048_576;
/** A6 R2: the longest item reference an adapter accepts. */
export const CONNECTOR_ITEM_REF_MAX_LENGTH = 200;

/** The most `containers` / `releases` items an adapter returns (names only, for Core's deterministic matching). */
export const CONNECTOR_CATALOG_MAX_ITEMS = 200;
export const CONNECTOR_RELEASE_NAME_MAX_LENGTH = 100;
/** A container key: a Jira project key (an upper-case letter, then upper-case letters, digits or `_`). */
export const CONNECTOR_CONTAINER_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
/** ADR-0121 D2: at most this many keys per `items-by-key` request (the per-reference detail cap). */
export const CONNECTOR_ITEMS_BY_KEY_MAX = 10;
/** An item key of the closed shape `<container key>-<positive number>` (a Jira issue key). */
export const CONNECTOR_ITEM_KEY = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/;
/** A release id: a positive decimal integer (a Jira version id). */
export const CONNECTOR_RELEASE_ID = /^[1-9][0-9]{0,17}$/;

export const CONNECTOR_QUERY_DEFAULT_LIMIT = 20;
export const CONNECTOR_QUERY_MAX_LIMIT = 20;
export const CONNECTOR_SEARCH_TEXT_MAX_LENGTH = 100;
/** Every adapter request is aborted after this many milliseconds unless configured otherwise. */
export const CONNECTOR_QUERY_DEFAULT_TIMEOUT_MS = 10_000;
export const CONNECTOR_QUERY_MAX_TIMEOUT_MS = 120_000;
const ACTOR_EXTERNAL_ID_MAX_LENGTH = 200;

/** Neutral failure taxonomy shared by every connector adapter. */
export const CONNECTOR_QUERY_ERROR_REASONS = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UNSUPPORTED_QUERY',
  'UNAVAILABLE',
  'INVALID_RESPONSE',
  /**
   * ADR-0120 A6 R2 (ADR-0100 D7 amendment C11): the item answered with a redirect (a moved Jira issue). The redirect is
   * never followed; the outcome is neutral and names no destination.
   */
  'MOVED',
  /**
   * A6 R2 (CA P3): an `item` response over CONNECTOR_ITEM_RESPONSE_MAX_BYTES, aborted while streaming. Kept apart from
   * `INVALID_RESPONSE` (a malformed answer) so each has its own log reason and reply.
   */
  'TOO_LARGE',
] as const;
export type ConnectorQueryErrorReason = (typeof CONNECTOR_QUERY_ERROR_REASONS)[number];

/**
 * A value-free connector failure. The message names the reason (and optionally the source) only: it never carries
 * request parameters, response content, credentials or headers. Adapter-specific errors extend this class.
 */
/**
 * The brand every `ConnectorQueryError` carries, from the process-wide symbol registry. A6 R2 (CA P3): an adapter package
 * built and loaded with its own copy of this module (the app's offline tests load the adapters from their `dist` while
 * Core runs from source; a bundled deployment can do the same) throws a `ConnectorQueryError` of another class identity,
 * which `instanceof` misses and would misreport as `UNAVAILABLE`. `Symbol.for` is shared across module copies, so the
 * brand recognises exactly the errors this class constructed, never an arbitrary error with a `reason` field.
 */
export const CONNECTOR_QUERY_ERROR_BRAND: unique symbol = Symbol.for('quoky.ConnectorQueryError') as never;

export class ConnectorQueryError extends Error {
  readonly [CONNECTOR_QUERY_ERROR_BRAND] = true;

  constructor(
    readonly reason: ConnectorQueryErrorReason,
    message?: string,
  ) {
    super(message ?? `connector query failed (${reason.toLowerCase()})`);
    this.name = 'ConnectorQueryError';
  }
}

export function isConnectorQueryError(value: unknown): value is ConnectorQueryError {
  if (value instanceof ConnectorQueryError) return true;
  if (!(value instanceof Error) || (value as unknown as Record<symbol, unknown>)[CONNECTOR_QUERY_ERROR_BRAND] !== true) return false;
  const reason: unknown = (value as unknown as { readonly reason?: unknown }).reason;
  return typeof reason === 'string' && (CONNECTOR_QUERY_ERROR_REASONS as readonly string[]).includes(reason);
}

/** Maps an HTTP status to a neutral reason. 2xx is not an error and must not be passed here. */
export function connectorQueryErrorReasonForStatus(status: number): ConnectorQueryErrorReason {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

/** Default when undefined, clamped to the maximum; a non-integer or non-positive limit is an unsupported query. */
export function resolveConnectorQueryLimit(limit: unknown, source = 'connector'): number {
  if (limit === undefined) return CONNECTOR_QUERY_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: limit must be a positive integer`);
  }
  return Math.min(limit, CONNECTOR_QUERY_MAX_LIMIT);
}

/** Adapter timeout configuration: default 10s; an invalid value is a configuration error (not a query error). */
export function resolveConnectorQueryTimeoutMs(timeoutMs: unknown, source = 'connector'): number {
  if (timeoutMs === undefined) return CONNECTOR_QUERY_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > CONNECTOR_QUERY_MAX_TIMEOUT_MS
  ) {
    throw new Error(`${source}: timeoutMs must be an integer from 1 to ${CONNECTOR_QUERY_MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

export interface ParsedPersonalWorkParams {
  actorExternalId: string;
  filter: PersonalWorkFilter;
  limit: number;
  /** Present only when the caller set it (ADR-0120 D13). */
  window?: PersonalWorkWindow;
  role: PersonalWorkRole;
  status: PersonalWorkStatus;
  /** Present only when the caller set it (live UAT R8). */
  sort?: PersonalWorkSort;
  /** Present only when the caller set it (owner review 2026-10-21). */
  itemType?: PersonalWorkItemType;
}

/** Validates `personal-work` params. Failures are `ConnectorQueryError('UNSUPPORTED_QUERY')` with value-free messages. */
export function parsePersonalWorkParams(params: Metadata | undefined, source = 'connector'): ParsedPersonalWorkParams {
  const actor = params?.actorExternalId;
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: actor identity is required`);
  }
  const actorExternalId = actor.trim();
  if (actorExternalId.length > ACTOR_EXTERNAL_ID_MAX_LENGTH || hasControlCharacters(actorExternalId)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: actor identity is invalid`);
  }
  const filter = params?.filter ?? 'all';
  if (typeof filter !== 'string' || !(PERSONAL_WORK_FILTERS as readonly string[]).includes(filter)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work filter`);
  }
  const role = params?.role ?? 'assignee';
  if (typeof role !== 'string' || !(PERSONAL_WORK_ROLES as readonly string[]).includes(role)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work role`);
  }
  const status = params?.status ?? 'open';
  if (typeof status !== 'string' || !(PERSONAL_WORK_STATUSES as readonly string[]).includes(status)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work status`);
  }
  const sort = params?.sort;
  if (sort !== undefined && (typeof sort !== 'string' || !(PERSONAL_WORK_SORTS as readonly string[]).includes(sort))) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work sort`);
  }
  const itemType = params?.itemType;
  if (itemType !== undefined && (typeof itemType !== 'string' || !(PERSONAL_WORK_ITEM_TYPES as readonly string[]).includes(itemType))) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work item type`);
  }
  const window = params?.window === undefined ? undefined : parsePersonalWorkWindow(params.window, source);
  return {
    actorExternalId,
    filter: filter as PersonalWorkFilter,
    limit: resolveConnectorQueryLimit(params?.limit, source),
    ...(window !== undefined ? { window } : {}),
    role: role as PersonalWorkRole,
    status: status as PersonalWorkStatus,
    ...(sort !== undefined ? { sort: sort as PersonalWorkSort } : {}),
    ...(itemType !== undefined ? { itemType: itemType as PersonalWorkItemType } : {}),
  };
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDateMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = LOCAL_DATE.exec(value);
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Rejects dates that roll over ("2026-02-30").
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : undefined;
}

/** A closed field and two real local dates, `from < to`, at most 31 days apart. */
function parsePersonalWorkWindow(value: unknown, source: string): PersonalWorkWindow {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const field = record.field;
  const from = localDateMs(record.from);
  const to = localDateMs(record.to);
  if (
    typeof field !== 'string' ||
    !(PERSONAL_WORK_WINDOW_FIELDS as readonly string[]).includes(field) ||
    from === undefined ||
    to === undefined ||
    to <= from ||
    to - from > PERSONAL_WORK_WINDOW_MAX_DAYS * 86_400_000
  ) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work window`);
  }
  const fromInstant = record.fromInstant;
  const toInstant = record.toInstant;
  if (fromInstant === undefined && toInstant === undefined) {
    return { field: field as PersonalWorkWindowField, from: record.from as string, to: record.to as string };
  }
  const fromMs = instantMs(fromInstant);
  const toMs = instantMs(toInstant);
  // The instants must bound (almost) the same span as the dates: a DST day is 23 or 25 hours, a zone offset ±14 h.
  if (fromMs === undefined || toMs === undefined || toMs <= fromMs || toMs - fromMs > (PERSONAL_WORK_WINDOW_MAX_DAYS * 24 + 2) * 3_600_000) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported personal-work window`);
  }
  return {
    field: field as PersonalWorkWindowField,
    from: record.from as string,
    to: record.to as string,
    fromInstant: new Date(fromMs).toISOString(),
    toInstant: new Date(toMs).toISOString(),
  };
}

function instantMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export interface ParsedSearchParams {
  text: string;
  limit: number;
}

/** Validates `search` params; control characters and whitespace runs collapse to one space. */
export function parseSearchParams(params: Metadata | undefined, source = 'connector'): ParsedSearchParams {
  const raw = params?.text;
  if (typeof raw !== 'string') {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: search text is required`);
  }
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > CONNECTOR_SEARCH_TEXT_MAX_LENGTH) {
    throw new ConnectorQueryError(
      'UNSUPPORTED_QUERY',
      `${source}: search text must be 1 to ${CONNECTOR_SEARCH_TEXT_MAX_LENGTH} characters`,
    );
  }
  return { text, limit: resolveConnectorQueryLimit(params?.limit, source) };
}

export interface ParsedItemParams {
  id: string;
  scope: ConnectorItemScope;
}

/**
 * Validates `item` params (A6 R2): exactly the keys `id` and optionally `scope`; the id 1..200 characters with no
 * whitespace or control characters (the adapter checks its own closed shape on top); `scope` `item` (default) or `thread`.
 */
export function parseItemParams(params: Metadata | undefined, source = 'connector'): ParsedItemParams {
  const record = params ?? {};
  if (Object.keys(record).some((key) => key !== 'id' && key !== 'scope')) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported item params`);
  }
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > CONNECTOR_ITEM_REF_MAX_LENGTH || /[\s\u0000-\u001f\u007f]/.test(id)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: a valid item reference is required`);
  }
  const scope = record.scope ?? 'item';
  if (typeof scope !== 'string' || !(CONNECTOR_ITEM_SCOPES as readonly string[]).includes(scope)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported item scope`);
  }
  return { id, scope: scope as ConnectorItemScope };
}

/** `ConnectorQuery.params` for the `items-by-key` named query (ADR-0121 S2 P3). */
export interface ItemsByKeyQueryParams {
  keys: readonly string[];
}

export interface ParsedItemsByKeyParams {
  readonly keys: readonly string[];
}

/**
 * Validates `items-by-key` params (ADR-0121 S2 P3): exactly the key `keys`, 1..{@link CONNECTOR_ITEMS_BY_KEY_MAX} distinct
 * keys of the closed {@link CONNECTOR_ITEM_KEY} shape. Failures are value-free `UNSUPPORTED_QUERY` errors.
 */
export function parseItemsByKeyParams(params: Metadata | undefined, source = 'connector'): ParsedItemsByKeyParams {
  const record = params ?? {};
  if (Object.keys(record).some((key) => key !== 'keys')) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: unsupported items-by-key params`);
  }
  const keys = record.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > CONNECTOR_ITEMS_BY_KEY_MAX) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: 1 to ${CONNECTOR_ITEMS_BY_KEY_MAX} item keys are required`);
  }
  if (!keys.every((key): key is string => typeof key === 'string' && CONNECTOR_ITEM_KEY.test(key)) || new Set(keys).size !== keys.length) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: invalid item keys`);
  }
  return { keys: [...keys] };
}

export interface ParsedReleasesParams {
  container: string;
  limit: number;
}

/** Validates `releases` params (ADR-0120 A8). Failures are value-free `UNSUPPORTED_QUERY` errors. */
export function parseReleasesParams(params: Metadata | undefined, source = 'connector'): ParsedReleasesParams {
  const container = params?.container;
  if (typeof container !== 'string' || !CONNECTOR_CONTAINER_KEY.test(container)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: a valid container key is required`);
  }
  const limit = params?.limit ?? CONNECTOR_CATALOG_MAX_ITEMS;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > CONNECTOR_CATALOG_MAX_ITEMS) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: invalid release limit`);
  }
  return { container, limit };
}

export interface ParsedReleaseItemsParams {
  container?: string;
  release: { readonly id: string } | { readonly name: string };
  assignee?: string;
  limit: number;
}

/**
 * Validates `release-items` params (ADR-0120 A8): a container key of the closed shape, exactly one of a numeric release
 * id and a release name (1..100 characters, no control characters), an optional assignee identity, the usual limit.
 */
export function parseReleaseItemsParams(params: Metadata | undefined, source = 'connector'): ParsedReleaseItemsParams {
  const container = params?.container;
  if (container !== undefined && (typeof container !== 'string' || !CONNECTOR_CONTAINER_KEY.test(container))) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: invalid container key`);
  }
  const id = params?.releaseId;
  const name = params?.releaseName;
  if ((id === undefined) === (name === undefined)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: exactly one release id or name is required`);
  }
  let release: ParsedReleaseItemsParams['release'];
  if (id !== undefined) {
    if (typeof id !== 'string' || !CONNECTOR_RELEASE_ID.test(id)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: invalid release id`);
    release = { id };
  } else {
    const trimmed = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (trimmed.length === 0 || Array.from(trimmed).length > CONNECTOR_RELEASE_NAME_MAX_LENGTH || hasControlCharacters(String(name))) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: invalid release name`);
    }
    release = { name: trimmed };
  }
  const assignee = params?.assignee;
  if (assignee !== undefined && (typeof assignee !== 'string' || assignee.trim().length === 0 || assignee.trim().length > ACTOR_EXTERNAL_ID_MAX_LENGTH || hasControlCharacters(assignee))) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: invalid assignee identity`);
  }
  return {
    ...(container !== undefined ? { container } : {}),
    release,
    ...(assignee !== undefined ? { assignee: assignee.trim() } : {}),
    limit: resolveConnectorQueryLimit(params?.limit, source),
  };
}

/** Normalizes a provider timestamp to an ISO-8601 string; returns undefined when it cannot be parsed. */
export function toConnectorTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const millis = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A date-only value (YYYY-MM-DD) or undefined. */
export function toConnectorDueDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value;
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}
