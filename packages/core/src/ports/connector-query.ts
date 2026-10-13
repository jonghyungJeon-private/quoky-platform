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
}

/** `ConnectorQuery.params` for the `search` named query. */
export interface SearchQueryParams {
  /** 1..CONNECTOR_SEARCH_TEXT_MAX_LENGTH characters after whitespace normalization. */
  text: string;
  limit?: number;
}

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
] as const;
export type ConnectorQueryErrorReason = (typeof CONNECTOR_QUERY_ERROR_REASONS)[number];

/**
 * A value-free connector failure. The message names the reason (and optionally the source) only: it never carries
 * request parameters, response content, credentials or headers. Adapter-specific errors extend this class.
 */
export class ConnectorQueryError extends Error {
  constructor(
    readonly reason: ConnectorQueryErrorReason,
    message?: string,
  ) {
    super(message ?? `connector query failed (${reason.toLowerCase()})`);
    this.name = 'ConnectorQueryError';
  }
}

export function isConnectorQueryError(value: unknown): value is ConnectorQueryError {
  return value instanceof ConnectorQueryError;
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
  const window = params?.window === undefined ? undefined : parsePersonalWorkWindow(params.window, source);
  return {
    actorExternalId,
    filter: filter as PersonalWorkFilter,
    limit: resolveConnectorQueryLimit(params?.limit, source),
    ...(window !== undefined ? { window } : {}),
    role: role as PersonalWorkRole,
    status: status as PersonalWorkStatus,
    ...(sort !== undefined ? { sort: sort as PersonalWorkSort } : {}),
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
