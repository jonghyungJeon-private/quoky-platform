/**
 * Narrow connector WRITE ports (ADR-0112 D2, ADR-0110 amendment). Each port does exactly one kind of irreversible
 * write and returns a typed outcome instead of throwing. `ConnectorProvider` and `CalendarReader` stay read-only;
 * writers are separate adapter classes, registered only when their flags and allowlists allow it.
 *
 * Outcome contract (ADR-0101 D4 classification, "when in doubt, UNCERTAIN"):
 * - `SENT` — the provider confirmed the write; `externalRef` names what was created or changed.
 * - `NOT_SENT` — the write certainly did not happen (refused before any network call, or definitively rejected by
 *   the provider). Never retried automatically; a new request is needed.
 * - `UNCERTAIN` — the request may have reached the provider (timeout, transport failure, 5xx, unreadable success).
 *   Never retried automatically; the owner is told it may have been written.
 *
 * Domain types only: no vendor type, token, header or URL template crosses these ports, and no outcome carries the
 * payload text or a credential.
 */

export const ConnectorWriteStatus = {
  SENT: 'SENT',
  NOT_SENT: 'NOT_SENT',
  UNCERTAIN: 'UNCERTAIN',
} as const;
export type ConnectorWriteStatus = (typeof ConnectorWriteStatus)[keyof typeof ConnectorWriteStatus];

/** Why a write certainly did not happen. Value-free. */
export const CONNECTOR_WRITE_NOT_SENT_REASONS = [
  /** The target is not on the configured allowlist (checked before any network call). */
  'TARGET_NOT_ALLOWED',
  /** The payload or target failed validation (checked before any network call). */
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'RATE_LIMITED',
  /** The provider definitively rejected the request (a 4xx or a definite API error). */
  'REJECTED',
  /** No available transition leads to the named status, or the name is ambiguous. */
  'TRANSITION_UNAVAILABLE',
  /** The event is a recurring series; only single events and single instances are written (ADR-0110 amendment D3). */
  'RECURRING_SERIES_REFUSED',
  /** An event with the idempotency-derived id already exists (a calendar create was already performed). */
  'ALREADY_EXISTS',
  /**
   * The approved target drifted between preview and execution (ADR-0112: the executed payload must equal the approved
   * one): the bound Jira transition is gone or now leads to another status, the issue key now names a moved issue, or
   * the bound calendar event changed. Checked before the write request; the write was never sent.
   */
  'TARGET_CHANGED',
  /** A step before the write request failed (token refresh, a pre-check read); the write was never sent. */
  'UNAVAILABLE',
] as const;
export type ConnectorWriteNotSentReason = (typeof CONNECTOR_WRITE_NOT_SENT_REASONS)[number];

/** Why a write may or may not have happened. Value-free. */
export const CONNECTOR_WRITE_UNCERTAIN_REASONS = [
  /** The write request timed out or the transport failed after it may have been sent. */
  'TRANSPORT',
  /** The provider answered with a server error. */
  'SERVER_ERROR',
  /** The provider answered success-like but the response could not be read or verified. */
  'INVALID_RESPONSE',
  /** Anything else after the request may have left (an unexpected error or an unknown API error code). */
  'UNKNOWN',
] as const;
export type ConnectorWriteUncertainReason = (typeof CONNECTOR_WRITE_UNCERTAIN_REASONS)[number];

export type ConnectorWriteOutcome =
  | {
      readonly status: 'SENT';
      /** A provider-side identifier of what was written (comment id, message ts, event id, issue key + status). */
      readonly externalRef: string;
      /** A link to the written item when the provider gives one (`https:` only). */
      readonly url?: string;
    }
  | { readonly status: 'NOT_SENT'; readonly reason: ConnectorWriteNotSentReason; readonly retryable: false }
  | { readonly status: 'UNCERTAIN'; readonly reason: ConnectorWriteUncertainReason };

export function connectorWriteSent(externalRef: string, url?: string): ConnectorWriteOutcome {
  return url === undefined ? { status: 'SENT', externalRef } : { status: 'SENT', externalRef, url };
}

export function connectorWriteNotSent(reason: ConnectorWriteNotSentReason): ConnectorWriteOutcome {
  return { status: 'NOT_SENT', reason, retryable: false };
}

export function connectorWriteUncertain(reason: ConnectorWriteUncertainReason): ConnectorWriteOutcome {
  return { status: 'UNCERTAIN', reason };
}

/** Neutral operation names recorded on write receipts (ADR-0112 D3). Core never branches on a connector id. */
export const ConnectorWriteOperation = {
  ISSUE_COMMENT: 'ISSUE_COMMENT',
  ISSUE_TRANSITION: 'ISSUE_TRANSITION',
  CHANNEL_POST: 'CHANNEL_POST',
  CALENDAR_EVENT_CREATE: 'CALENDAR_EVENT_CREATE',
  CALENDAR_EVENT_UPDATE: 'CALENDAR_EVENT_UPDATE',
  CALENDAR_EVENT_DELETE: 'CALENDAR_EVENT_DELETE',
} as const;
export type ConnectorWriteOperation = (typeof ConnectorWriteOperation)[keyof typeof ConnectorWriteOperation];
export const CONNECTOR_WRITE_OPERATIONS: readonly ConnectorWriteOperation[] = Object.values(ConnectorWriteOperation);

/** Bound on owner-authored comment and message text (characters). The text is posted verbatim, never truncated. */
export const CONNECTOR_WRITE_TEXT_MAX_LENGTH = 4000;
/** Bound on a named target status for an issue transition. */
export const ISSUE_TRANSITION_STATUS_MAX_LENGTH = 100;

// ── Issue writes (Jira comment, Jira transition) ─────────────────────────────────────────────────────────────────

export interface IssueCommentRequest {
  /** An issue key such as `PROJ-12`; its project must be allowlisted. */
  readonly issueKey: string;
  /** The owner's exact text, posted verbatim (1..CONNECTOR_WRITE_TEXT_MAX_LENGTH characters, not blank). */
  readonly text: string;
}

export interface IssueCommentWriter {
  /** A neutral source label for audit and receipts (for example `jira`); never branched on by Core. */
  readonly source: string;
  /** True when the issue key is well formed and its project is allowlisted. Pure; makes no network call. */
  allowsIssue(issueKey: string): boolean;
  addComment(request: IssueCommentRequest): Promise<ConnectorWriteOutcome>;
}

/** One transition available on an issue (for the CWR-2 preview check). Names are untrusted readout. */
export interface IssueTransitionOption {
  /** The transition id (digits). */
  readonly id: string;
  readonly name: string;
  /** The destination status name. */
  readonly toStatus: string;
  /** The destination status id (digits), or empty when the provider did not give one (such a transition is never bound). */
  readonly toStatusId: string;
}

/**
 * An APPROVED transition, bound by immutable identifiers (ADR-0112). The preview resolved the owner's status name to
 * exactly one transition; execution performs that transition id only while it still leads to the same destination
 * status id. Names are never matched at execution.
 */
export interface IssueTransitionRequest {
  readonly issueKey: string;
  /** The transition id the preview resolved (digits). */
  readonly transitionId: string;
  /** The destination status id the preview showed (digits). */
  readonly toStatusId: string;
}

export interface IssueTransitionWriter {
  readonly source: string;
  allowsIssue(issueKey: string): boolean;
  /** Read-only: the transitions currently available on an allowlisted issue. Throws `ConnectorQueryError`. */
  listTransitions(issueKey: string): Promise<readonly IssueTransitionOption[]>;
  /**
   * Re-reads the available transitions and performs `transitionId` only when a transition with that id still exists
   * AND leads to `toStatusId`; otherwise `NOT_SENT('TARGET_CHANGED')` and nothing is sent. Never falls back to a name.
   */
  transition(request: IssueTransitionRequest): Promise<ConnectorWriteOutcome>;
}

// ── Channel message (Slack post) ─────────────────────────────────────────────────────────────────────────────────

export interface ChannelMessageRequest {
  /** An allowlisted channel, by its configured name (with or without `#`) or its id. */
  readonly channel: string;
  /** The owner's exact text, posted verbatim (no mention or link expansion). */
  readonly text: string;
}

export interface ChannelMessageWriter {
  readonly source: string;
  /** The allowlisted channel id `channel` resolves to, or undefined when it is not allowlisted. Pure. */
  resolveChannel(channel: string): string | undefined;
  post(request: ChannelMessageRequest): Promise<ConnectorWriteOutcome>;
}

// ── Calendar event writes (owner's primary calendar only; ADR-0110 amendment) ────────────────────────────────────

export const CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH = 4000;

/**
 * An event time. A timed event gives ISO-8601 instants WITH an explicit offset (`Z` or `±hh:mm`) and the IANA zone
 * the owner sees it in; an all-day event gives `YYYY-MM-DD` dates with an EXCLUSIVE end date.
 */
export type CalendarEventTime =
  | { readonly allDay: false; readonly start: string; readonly end: string; readonly timeZone: string }
  | { readonly allDay: true; readonly startDate: string; readonly endDate: string };

/** A new event. Attendees, reminders, conferencing and visibility are never set (ADR-0110 amendment D5). */
export interface CalendarEventDraft {
  readonly title: string;
  readonly time: CalendarEventTime;
  readonly location?: string;
  readonly description?: string;
}

/** The fields an update may change (ADR-0110 amendment D3: time, title, location, description). At least one. */
export interface CalendarEventChanges {
  readonly title?: string;
  readonly time?: CalendarEventTime;
  readonly location?: string;
  readonly description?: string;
}

export interface CalendarEventCreateRequest {
  readonly draft: CalendarEventDraft;
  /**
   * The receipt idempotency key. The adapter derives the provider event id from it, so a second create with the
   * same key can never produce a second event (`NOT_SENT('ALREADY_EXISTS')`).
   */
  readonly idempotencyKey: string;
}

/**
 * The state of an existing event the owner approved a change to (ADR-0112: bound in the approved payload). The writer
 * re-reads the event and refuses (`NOT_SENT('TARGET_CHANGED')`) when it no longer matches: a different provider
 * version (any edit since the preview), start, end or all-day shape. The version is REQUIRED: the write is always
 * conditional on it, and a missing or malformed version is `NOT_SENT('TARGET_CHANGED')` before any network call.
 */
export interface CalendarEventExpectation {
  readonly allDay: boolean;
  /** As `CalendarEvent.start`: a UTC instant for a timed event, a `YYYY-MM-DD` date for an all-day one. */
  readonly start: string;
  readonly end: string;
  /** The provider's opaque event version at preview time (for example an HTTP entity tag). */
  readonly version: string;
}

export interface CalendarEventUpdateRequest {
  readonly eventId: string;
  readonly expected: CalendarEventExpectation;
  readonly changes: CalendarEventChanges;
}

export interface CalendarEventDeleteRequest {
  readonly eventId: string;
  readonly expected: CalendarEventExpectation;
}

/**
 * Writes on the owner's PRIMARY calendar only (ADR-0110 amendment D2). Every request passes "no notifications"
 * (`sendUpdates=none`) and never sets attendees. Update and delete refuse a recurring series
 * (`NOT_SENT('RECURRING_SERIES_REFUSED')`); a single instance of a series is allowed.
 */
export interface CalendarEventWriter {
  readonly source: string;
  /** Always the primary calendar. */
  readonly target: 'primary';
  createEvent(request: CalendarEventCreateRequest): Promise<ConnectorWriteOutcome>;
  updateEvent(request: CalendarEventUpdateRequest): Promise<ConnectorWriteOutcome>;
  deleteEvent(request: CalendarEventDeleteRequest): Promise<ConnectorWriteOutcome>;
}

// ── Shared pure validation ───────────────────────────────────────────────────────────────────────────────────────

/** Owner text for a comment or message: a string, not blank, at most CONNECTOR_WRITE_TEXT_MAX_LENGTH characters. */
export function isValidConnectorWriteText(value: unknown, maxLength = CONNECTOR_WRITE_TEXT_MAX_LENGTH): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(value)) return false;
  return Array.from(value).length <= maxLength;
}
