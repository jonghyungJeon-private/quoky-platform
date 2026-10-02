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

/** `ConnectorQuery.params` for the `personal-work` named query. */
export interface PersonalWorkQueryParams {
  actorExternalId: string;
  /** Defaults to `all`. */
  filter?: PersonalWorkFilter;
  /** Defaults to CONNECTOR_QUERY_DEFAULT_LIMIT; values above CONNECTOR_QUERY_MAX_LIMIT are clamped. */
  limit?: number;
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
  return { actorExternalId, filter: filter as PersonalWorkFilter, limit: resolveConnectorQueryLimit(params?.limit, source) };
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
