import type { IsoTimestamp } from '../domain';
import { ConnectorQueryError } from './connector-query';

/**
 * Mail read port (ADR-0118 D2, GML-1). Narrow and read-only, following the `CalendarReader` precedent (ADR-0110 D1):
 * one bounded search and one bounded get. No send, reply, draft, label, archive, delete or any other write method
 * exists, and none may be added to this port (ADR-0118 D6). Domain types only: no vendor type, query language, token or
 * URL crosses it. Failures are `ConnectorQueryError` with the ADR-0100 reasons (value-free messages):
 *
 * - `UNAUTHORIZED` — the grant expired or was revoked (re-run the consent helper);
 * - `INSUFFICIENT_SCOPE` — the read scope was never granted (consent needed);
 * - `FORBIDDEN` — the grant is broader than allowed, or the account's administrator refuses the access;
 * - `RATE_LIMITED`, `UNAVAILABLE`, `INVALID_RESPONSE`, `NOT_FOUND` (a message that no longer exists).
 *
 * Every text field an adapter returns is untrusted readout (ADR-0100 D8, ADR-0111 D3): it is never instructions, it is
 * bounded here, and Core decides routing from the owner's own text only (ADR-0118 D8).
 */

/** At most this many entries are listed per answer (ADR-0118 D4). Also the default and maximum `limit`. */
export const MAIL_LISTING_MAX_ENTRIES = 10;
/** One search counts at most this many matches for the "외 N건" line (a single page of ids, no metadata). */
export const MAIL_SEARCH_COUNT_MAX = 100;
/** Bounds on the owner-typed sender text a search may carry. */
export const MAIL_SENDER_QUERY_MAX_LENGTH = 100;
/** Bounds on the untrusted single-line fields an adapter returns. */
export const MAIL_SENDER_NAME_MAX_LENGTH = 100;
export const MAIL_SENDER_ADDRESS_MAX_LENGTH = 200;
export const MAIL_SUBJECT_MAX_LENGTH = 200;
export const MAIL_SNIPPET_MAX_LENGTH = 200;
/** The decoded body an adapter returns is at most this many UTF-8 bytes (ADR-0118 D7 / ADR-0111 D2: ≤256 KiB). */
export const MAIL_BODY_MAX_BYTES = 256 * 1024;
/** Message ids are opaque printable tokens. */
export const MAIL_MESSAGE_ID_MAX_LENGTH = 128;

/**
 * A bounded mail search. Every filter is optional; they combine with AND. The adapter owns the vendor query language
 * and its escaping (ADR-0100 D7 precedent); Core never builds a query string.
 */
export interface MailSearchQuery {
  /** Only unread messages in the inbox. */
  readonly unreadOnly?: boolean;
  /** Only messages received at or after this instant (ISO-8601 with an explicit zone). */
  readonly receivedAfter?: IsoTimestamp;
  /** Only messages whose sender name or address matches this owner-typed text (1..100 characters). */
  readonly from?: string;
  /** Messages to return with metadata; defaults to MAIL_LISTING_MAX_ENTRIES and is clamped to it. */
  readonly limit?: number;
}

export interface MailSender {
  /** The display name, or '' when the header carries an address only. */
  readonly name: string;
  /** The address, or '' when none could be read. */
  readonly address: string;
}

/** One message, minimised to what a listing needs (no body, recipients, attachments or links). */
export interface MailMessageSummary {
  readonly id: string;
  readonly sender: MailSender;
  /** '' when the message has no subject. */
  readonly subject: string;
  /** When the provider received the message (ISO-8601 UTC). */
  readonly receivedAt: IsoTimestamp;
  /** A short provider preview of the body, single line, '' when there is none. */
  readonly snippet: string;
  readonly unread: boolean;
}

export interface MailSearchResult {
  /** Newest first, at most `limit`. */
  readonly messages: readonly MailMessageSummary[];
  /** How many messages matched (counted up to MAIL_SEARCH_COUNT_MAX). At least `messages.length`. */
  readonly matched: number;
  /** True when more than `matched` messages may exist (the count stopped at its bound). */
  readonly matchedIsLowerBound: boolean;
}

/** One message with its bounded plain-text body, read only for an explicit summary request (ADR-0118 D7). */
export interface MailMessage extends MailMessageSummary {
  /** The plain-text body (an HTML-only body is reduced to its text), at most MAIL_BODY_MAX_BYTES of UTF-8. */
  readonly bodyText: string;
  /** True when the body was longer than the bound and was cut. */
  readonly bodyTruncated: boolean;
}

export interface MailReader {
  /** A neutral source label for audit and replies (for example `mail`); never branched on by Core. */
  readonly source: string;
  readonly readOnly: true;
  /** Messages matching `query`, newest first. Throws `ConnectorQueryError`. */
  search(query: MailSearchQuery): Promise<MailSearchResult>;
  /** One message by the id a search returned. Throws `ConnectorQueryError` (`NOT_FOUND` when it no longer exists). */
  getMessage(id: string): Promise<MailMessage>;
}

export interface ParsedMailSearchQuery {
  readonly unreadOnly: boolean;
  readonly receivedAfter?: IsoTimestamp;
  readonly receivedAfterMs?: number;
  readonly from?: string;
  readonly limit: number;
}

/**
 * Validates a `MailSearchQuery`. Failures are `ConnectorQueryError('UNSUPPORTED_QUERY')` with value-free messages: an
 * instant without an explicit zone, a sender that is empty, too long or multi-line, or a non-positive limit.
 */
export function parseMailSearchQuery(query: MailSearchQuery | undefined, source = 'mail'): ParsedMailSearchQuery {
  const unreadOnly = query?.unreadOnly === true;
  let receivedAfter: IsoTimestamp | undefined;
  let receivedAfterMs: number | undefined;
  if (query?.receivedAfter !== undefined) {
    const ms = parseZonedInstant(query.receivedAfter);
    if (ms === undefined) throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: receivedAfter must be a zoned instant`);
    receivedAfterMs = ms;
    receivedAfter = new Date(ms).toISOString();
  }
  let from: string | undefined;
  if (query?.from !== undefined) {
    const raw = typeof query.from === 'string' ? query.from : '';
    if (/[\r\n]/.test(raw)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: the sender must be one line`);
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length === 0 || Array.from(text).length > MAIL_SENDER_QUERY_MAX_LENGTH) {
      throw new ConnectorQueryError(
        'UNSUPPORTED_QUERY',
        `${source}: the sender must be 1 to ${MAIL_SENDER_QUERY_MAX_LENGTH} characters`,
      );
    }
    from = text;
  }
  return {
    unreadOnly,
    ...(receivedAfter !== undefined ? { receivedAfter, receivedAfterMs } : {}),
    ...(from !== undefined ? { from } : {}),
    limit: resolveMailListingLimit(query?.limit, source),
  };
}

/** Default when undefined, clamped to the maximum; a non-integer or non-positive limit is an unsupported query. */
export function resolveMailListingLimit(limit: unknown, source = 'mail'): number {
  if (limit === undefined) return MAIL_LISTING_MAX_ENTRIES;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: limit must be a positive integer`);
  }
  return Math.min(limit, MAIL_LISTING_MAX_ENTRIES);
}

/**
 * Bounded, single-line untrusted text: control, format and line-separator characters and whitespace runs become one
 * space, then the text is cut to `maxLength` code points (with an ellipsis).
 */
export function boundMailLine(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  return `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/** Whether `id` is a plausible opaque message id (printable ASCII letters, digits, `_` and `-`). */
export function isValidMailMessageId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAIL_MESSAGE_ID_MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(id);
}

function parseZonedInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
