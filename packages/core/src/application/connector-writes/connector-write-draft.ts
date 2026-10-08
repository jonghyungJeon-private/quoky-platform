import type { IsoTimestamp } from '../../domain';
import type { CalendarEventDraft } from '../../ports/connector-write.port';

/**
 * A parsed connector-write request (ADR-0112 D5, ADR-0110 amendment D3; CWR-2). Plain, deeply-serializable data only:
 * the work-chat grammar (Jira comment / transition, Slack post) and the calendar grammar (event create / update /
 * delete) produce it, a turn handler hands it to the runtime as the `write-draft` outcome (handlers create no
 * approval, ADR-0096 D4), and only the runtime's `connectorWriteFlow` turns it into an exact payload, a preview and a
 * CRITICAL approval. Nothing here is a payload yet: the flow normalizes the target, checks the allowlist and builds the
 * exact payload that is hashed, shown and sent.
 *
 * Owner text (`text`, `title`, `location`) is kept exactly as the owner wrote it (outer whitespace trimmed); it is
 * never rewritten, translated or drafted by a model.
 */

/** A time of day on the owner's clock (`QUOKY_TIMEZONE`). */
export interface ConnectorWriteClockTime {
  readonly hour: number;
  readonly minute: number;
}

/** A calendar date in the owner's zone. */
export interface ConnectorWriteLocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Which existing event an update or delete means: the local day it is on (a `[from, to)` read window), the start time
 * when the owner named one, and a title hint when the owner named something more specific than a generic meeting
 * noun. The flow lists that day's events on the PRIMARY calendar and never guesses: zero matches is "not found", more
 * than one is a numbered choice.
 */
export interface CalendarEventReference {
  readonly date: ConnectorWriteLocalDate;
  readonly window: { readonly from: IsoTimestamp; readonly to: IsoTimestamp };
  readonly startTime?: ConnectorWriteClockTime;
  /** Lower-cased words that must all appear in the event title (empty = any title). */
  readonly titleWords: readonly string[];
  /**
   * The owner named no day: `date` / `window` are today only because the grammar defaults to it (live QA D2). The flow
   * then resolves the reference against the session's most recent calendar context (the event just created or changed,
   * or the last list shown) and, with none, asks which event over today and tomorrow — never today's events alone.
   */
  readonly inferredDay?: true;
  /** The calendar list this session last showed (attached by the calendar handler only when `inferredDay`). */
  readonly recentListing?: CalendarRecentListing;
}

/**
 * A calendar list the calendar handler showed in this session (event ids in list order, the `[from, to)` it read),
 * kept for at most the ADR-0093 lifetime. Plain data: the flow re-reads the window and keeps only events still there.
 */
export interface CalendarRecentListing {
  readonly at: IsoTimestamp;
  readonly window: { readonly from: IsoTimestamp; readonly to: IsoTimestamp };
  readonly eventIds: readonly string[];
}

/** What a calendar update changes. A time move keeps the event's duration; `date` absent = the same day. */
export interface CalendarDraftChanges {
  readonly moveTo?: { readonly date?: ConnectorWriteLocalDate; readonly time: ConnectorWriteClockTime };
  readonly title?: string;
  readonly location?: string;
}

/** Why a write-shaped request could not be parsed into an exact request (the reply is a usage hint). */
export type ConnectorWriteUsageTopic =
  | 'issue-comment'
  | 'issue-transition'
  | 'channel-post'
  | 'calendar-create'
  | 'calendar-change'
  | 'calendar-span';

export type ConnectorWriteDraft =
  | { readonly kind: 'issue-comment'; readonly issueKey: string; readonly text: string }
  | { readonly kind: 'issue-transition'; readonly issueKey: string; readonly toStatus: string }
  | { readonly kind: 'channel-post'; readonly channel: string; readonly text: string }
  | { readonly kind: 'calendar-create'; readonly event: CalendarEventDraft }
  | { readonly kind: 'calendar-update'; readonly ref: CalendarEventReference; readonly changes: CalendarDraftChanges }
  | { readonly kind: 'calendar-delete'; readonly ref: CalendarEventReference }
  | { readonly kind: 'usage'; readonly topic: ConnectorWriteUsageTopic };

export type ConnectorWriteDraftKind = ConnectorWriteDraft['kind'];

/** Which writer family a draft needs (the flow checks that writer is bound; absent = writes are off for it). */
export type ConnectorWriteFamily = 'issue-comment' | 'issue-transition' | 'channel-post' | 'calendar';

export function connectorWriteFamilyOf(draft: ConnectorWriteDraft): ConnectorWriteFamily {
  switch (draft.kind) {
    case 'issue-comment':
      return 'issue-comment';
    case 'issue-transition':
      return 'issue-transition';
    case 'channel-post':
      return 'channel-post';
    case 'usage':
      return draft.topic === 'issue-comment' || draft.topic === 'issue-transition' || draft.topic === 'channel-post'
        ? draft.topic
        : 'calendar';
    default:
      return 'calendar';
  }
}

/** Jira issue key (`PROJ-12`), upper-cased. The project part matches the write allowlist's key shape. */
export const CONNECTOR_WRITE_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-[1-9]\d{0,8}$/;
