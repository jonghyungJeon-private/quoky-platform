import { ApprovalStatus, Capability, IntentType, RiskLevel, SessionStatus, TaskStatus } from '../../domain';
import type { Actor, ApprovalRequest, ConversationContext, ExecutionPlanRef, Id, IsoTimestamp, Session, Task } from '../../domain';
import type { CalendarEvent, CalendarEventPresence, CalendarReader } from '../../ports/calendar-reader.port';
import { CALENDAR_EVENTS_MAX_LIMIT, CALENDAR_EVENT_LOCATION_MAX_LENGTH, CALENDAR_EVENT_TITLE_MAX_LENGTH, boundCalendarText } from '../../ports/calendar-reader.port';
import {
  CONNECTOR_WRITE_OPERATIONS,
  ISSUE_TRANSITION_STATUS_MAX_LENGTH,
  connectorWriteNotSent,
  connectorWriteUncertain,
  isValidConnectorWriteText,
  type CalendarEventChanges,
  type CalendarEventDraft,
  type CalendarEventExpectation,
  type CalendarEventRestoreExpectation,
  type CalendarEventTime,
  type CalendarEventWriter,
  type ChannelMessageWriter,
  type ConnectorWriteOperation,
  type ConnectorWriteOutcome,
  type IssueCommentState,
  type IssueCommentWriter,
  type IssueStatusReadout,
  type IssueTransitionOption,
  type IssueTransitionWriter,
} from '../../ports/connector-write.port';
import type { ConnectorWriteReceipt, ConnectorWriteReceiptRepository } from '../../ports/connector-write-receipt.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { PENDING_APPROVAL_TTL_MS } from '../conversation-commands';
import { containsCredentialMaterial } from '../credential-guard';
import {
  documentedExecutionPhrase,
  executionCommandRejection,
  isAcceptedExecutionPhrase,
  normalizeExecutionPhrase,
  type ExecutionGate,
} from '../execution-command-guard';
import { calendarWindowForDays } from '../../ports/calendar-window';
import { localDateOf, toZonedDateTime, zonedToUtc, type LocalDate } from '../reminders/zoned-time';
import {
  CONNECTOR_WRITE_ISSUE_KEY,
  connectorWriteFamilyOf,
  type CalendarDraftChanges,
  type CalendarEventReference,
  type ConnectorWriteDraft,
  type ConnectorWriteFamily,
  type ConnectorWriteUsageTopic,
} from './connector-write-draft';
import { ConnectorWriteExecutor, ConnectorWriteRequestError } from './connector-write-executor';
import { ExternalUndoResolver, type ExternalUndoResolution } from './external-undo-resolver';
import { LAST_ACTION_EXTERNAL_ENTRY, type ExternalUndoFamily } from '../nl-routing/last-action';
import { connectorWritePayloadSha256 } from './connector-write-payload';
import { SESSION_WRITE_LOCK, type SessionLockHold, type SessionWriteLock } from '../session-write-lock';

/**
 * The chat approval flow for connector writes (ADR-0112 D5/D6, ADR-0110 amendment D3–D5; plan CWR-2).
 *
 * preview → one-time CRITICAL approval bound to the payload hash → "승인" → the exact execution phrase → exactly one
 * send of exactly the approved payload through the CWR-1 writer and the at-most-once executor (v15 receipt).
 *
 * - **State** lives only on an inert, plan-less anchor Task (`metadata.connectorWriteAnchor`), pointed to by
 *   `Session.activeTaskId` (the ADR-0040 technique). The payload text lives there and nowhere else (the receipt has
 *   no payload column). The pointer the anchor displaced is restored when the write ends, so an open code-change
 *   chain resumes afterwards.
 * - **Binding.** The approval's `reason` carries operation, normalized target and the payload SHA-256 (never the
 *   text). Execution re-reads the approval, re-derives the reason from the anchored payload and refuses any mismatch,
 *   a different actor or session, and a grant older than the ADR-0093 lifetime.
 * - **One send.** The anchor is saved `EXECUTING` (the grant consumed) before the executor writes the `PREPARED`
 *   receipt and calls the writer once; the idempotency key is derived from the approval id, so a replay can never send
 *   twice. `UNCERTAIN` is never retried; a repeated phrase after any outcome only reports it.
 * - **Never guess.** An update or delete lists the referenced day on the PRIMARY calendar; zero matches is "not found",
 *   several is a numbered choice (next turn only).
 * - **Immutable targets.** The approved payload (and so its hash) binds identifiers, not names that can drift: a Jira
 *   transition binds the resolved transition id and destination status id (plus the names the preview showed), a Slack
 *   post the resolved channel id, a calendar update / delete the event id and the event's previewed start, end and
 *   provider version. The writer re-checks them before the write and answers `NOT_SENT('TARGET_CHANGED')` on drift.
 * - **Lazy expiry.** An approved grant that is never executed, and a numbered choice that is never answered, lapse after
 *   the ADR-0093 lifetime (`PENDING_APPROVAL_TTL_MS`, from the approval / from the listing): `releaseExpired` closes the
 *   anchor `expired` at the start of the next turn and hands back the pointer it displaced, so a displaced code-change
 *   chain is hidden for at most that long.
 * - Core never branches on a connector id: the writer family comes from the draft kind, the receipt label from the
 *   writer's own `source`.
 */

export const CONNECTOR_WRITE_ANCHOR_KIND = 'connector-write' as const;
const ANCHOR_KEY = 'connectorWriteAnchor';
/**
 * Owner text is bounded below the port's 4000 so the preview stays readable. The preview, the pending reminder and the
 * choice list are never clamped (a long reply is delivered in lossless, fence-aware chunks by the adapter), so the
 * approval always shows the whole payload and the full approve / deny instructions.
 */
export const CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH = 1400;
/** A calendar event description, likewise bounded. */
export const CONNECTOR_WRITE_PREVIEW_DESCRIPTION_MAX_LENGTH = 500;
/** At most this many candidate events are listed for a choice; more means the owner must be more specific. */
export const CONNECTOR_WRITE_MAX_CHOICES = 10;
/** At most this many available Jira statuses are listed when a transition is unavailable. */
const MAX_LISTED_STATUSES = 10;

export type ConnectorWriteAnchorStatus =
  | 'AWAITING_CHOICE'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'EXECUTING'
  | 'SENT'
  | 'NOT_SENT'
  | 'UNCERTAIN'
  | 'CLOSED';

export type ConnectorWriteCloseReason =
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'abandoned'
  | 'inconsistent'
  /** The owner's `에이전트 중지` (ADR-0120 A6-D3 amendment, 2026-11-03) closed a write the switch governs. */
  | 'stopped';

/** A calendar event as the preview and the choice list show it (untrusted readout, already bounded by the reader). */
export interface ConnectorWriteEventSummary {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly location?: string;
  /** The provider's opaque event version at listing time (bound by an update / delete; never shown). */
  readonly version?: string;
  /** The time zone the provider records for a timed event's start (never shown); an update undo restores a time only in it. */
  readonly timeZone?: string;
  /** Which shown text values are byte-identical to the provider's raw values (never shown); absent = unknown = lossy. */
  readonly lossless?: { readonly title: boolean; readonly location: boolean };
}

/** EXACTLY what is sent (and hashed). Targets are bound by immutable identifiers (ADR-0112). */
export type ConnectorWritePayload =
  | { readonly operation: 'ISSUE_COMMENT'; readonly issueKey: string; readonly text: string }
  | {
      readonly operation: 'ISSUE_TRANSITION';
      readonly issueKey: string;
      /** The transition the preview resolved, by id (executed only while it still leads to `toStatusId`). */
      readonly transitionId: string;
      readonly transitionName: string;
      /** The destination status, by id (and the name the preview showed). */
      readonly toStatusId: string;
      readonly toStatus: string;
      /**
       * ADR-0112 amendment 3 (O5): the status the issue was in at preview time (id and name), recorded when the writer can read
       * it. The writer sends the transition only while the issue is still in it (compare-and-set), so a SENT transition proves
       * the move `fromStatusId -> toStatusId`. A transition without it (legacy, or a writer without the read) has no undo.
       */
      readonly fromStatusId?: string;
      readonly fromStatus?: string;
    }
  /**
   * ADR-0112 amendment 3 (O4): delete the comment Quoky added (only ever an undo). The issue and comment come from this actor's
   * own SENT comment receipt; `expected.version` is the comment's version Quoky's own add returned.
   */
  | {
      readonly operation: 'ISSUE_COMMENT_DELETE';
      readonly issueKey: string;
      readonly commentId: string;
      readonly expected: { readonly version: string };
      readonly undoes: Id;
    }
  /**
   * ADR-0112 amendment 3 (O5): move the issue back to the status it had before Quoky's own transition (only ever an undo), through
   * one transition the provider lists now. `fromStatusId` is the status Quoky moved it to (compare-and-set at the writer);
   * `toStatusId` the status it had before.
   */
  | {
      readonly operation: 'ISSUE_TRANSITION_REVERT';
      readonly issueKey: string;
      readonly transitionId: string;
      readonly transitionName: string;
      readonly toStatusId: string;
      readonly toStatus: string;
      readonly fromStatusId: string;
      readonly undoes: Id;
    }
  | { readonly operation: 'CHANNEL_POST'; readonly channel: string; readonly text: string }
  | { readonly operation: 'CALENDAR_EVENT_CREATE'; readonly draft: CalendarEventDraft }
  | {
      readonly operation: 'CALENDAR_EVENT_UPDATE';
      readonly eventId: string;
      readonly expected: CalendarEventExpectation;
      readonly changes: CalendarEventChanges;
      /** An undo only: the id of the source receipt it undoes (see {@link ConnectorWriteUndoBinding}). */
      readonly undoes?: Id;
    }
  | { readonly operation: 'CALENDAR_EVENT_DELETE'; readonly eventId: string; readonly expected: CalendarEventExpectation; readonly undoes?: Id }
  /** ADR-0112 amendment 3 (O3): restore the same event an approved delete removed (only ever an undo; never owner-worded). */
  | { readonly operation: 'CALENDAR_EVENT_RESTORE'; readonly eventId: string; readonly expected: CalendarEventRestoreExpectation; readonly undoes: Id };

/**
 * ADR-0112 amendment 3 (restore-duplicate fix, 2026-11-16): every undo payload carries `undoes`, the id of the ONE source
 * receipt it is the inverse of. It is part of the hashed payload (never sent to a writer), so the at-most-once identity of an
 * undo (`findLatestSent` over connector, operation, target and payload hash) is per source write: a NEW delete of the same event
 * yields a NEW restore, while a replay of the same undo (same source receipt) still matches its own SENT receipt and is refused.
 * Execution requires `undoes` to equal the anchor's `undoOf.receiptId`.
 */
export type ConnectorWriteUndoBinding = { readonly undoes: Id };

/** What the deterministic preview shows (the payload plus display-only facts). */
export type ConnectorWritePreview =
  | { readonly operation: 'ISSUE_COMMENT'; readonly issueKey: string; readonly text: string }
  | {
      readonly operation: 'ISSUE_TRANSITION';
      readonly issueKey: string;
      readonly toStatus: string;
      readonly toStatusId: string;
      readonly transitionName: string;
      readonly transitionId: string;
      /**
       * Review round 1 (P3): the status the issue is in now, read at preview (the compare-and-set baseline the transition is
       * sent against). Absent when the writer cannot read it. The name is untrusted readout.
       */
      readonly fromStatus?: string;
      readonly fromStatusId?: string;
    }
  /** ADR-0112 amendment 3 (O4): always the undo of this actor's own SENT comment; the text is the owner's own comment as approved. */
  | {
      readonly operation: 'ISSUE_COMMENT_DELETE';
      readonly issueKey: string;
      readonly commentId: string;
      readonly text: string;
      readonly receiptSourced: true;
      readonly ownerSentence?: string;
    }
  /** ADR-0112 amendment 3 (O5): always the undo of this actor's own SENT transition. Names are untrusted readout. */
  | {
      readonly operation: 'ISSUE_TRANSITION_REVERT';
      readonly issueKey: string;
      /** The status Quoky moved the issue to (where it is now). */
      readonly currentStatus: string;
      readonly currentStatusId: string;
      /** The status it had before (where the revert takes it back). */
      readonly toStatus: string;
      readonly toStatusId: string;
      readonly transitionName: string;
      readonly transitionId: string;
      readonly receiptSourced: true;
      readonly ownerSentence?: string;
    }
  | { readonly operation: 'CHANNEL_POST'; readonly channelLabel: string; readonly channelId: string; readonly text: string }
  | { readonly operation: 'CALENDAR_EVENT_CREATE'; readonly event: CalendarEventDraft; readonly timeZone: string }
  | {
      readonly operation: 'CALENDAR_EVENT_UPDATE';
      readonly before: ConnectorWriteEventSummary;
      readonly after: { readonly title: string; readonly time: CalendarEventTime; readonly location?: string };
      readonly timeZone: string;
      /** ADR-0112 amendment 3 (O2): the target came from Quoky's own SENT update receipt (an undo): the card shows the banner. */
      readonly receiptSourced?: true;
      /** The owner's own undo sentence, bounded, shown as quoted text and never read as an instruction. */
      readonly ownerSentence?: string;
    }
  | {
      readonly operation: 'CALENDAR_EVENT_DELETE';
      readonly before: ConnectorWriteEventSummary;
      readonly timeZone: string;
      /** The target came from Quoky's own SENT receipt (an undo), not from the owner's words: the card shows the banner. */
      readonly receiptSourced?: true;
      /** ADR-0112 amendment 1 S4: the owner's own undo sentence, bounded, shown on the card as quoted text and never read as an instruction. */
      readonly ownerSentence?: string;
    }
  | {
      /** ADR-0112 amendment 3 (O3): always the undo of this actor's own SENT delete; the event as that delete's preview showed it. */
      readonly operation: 'CALENDAR_EVENT_RESTORE';
      readonly before: ConnectorWriteEventSummary;
      readonly timeZone: string;
      readonly receiptSourced: true;
      readonly ownerSentence?: string;
    };

/** Where an undated reference's candidates came from ({@link ConnectorWriteStep} `choice.basis`). */
export type ConnectorWriteChoiceBasis = 'listed' | 'written' | 'nearby';

/** How many days the no-context choice of an undated reference covers (today and tomorrow). */
export const CONNECTOR_WRITE_NEARBY_DAYS = 2;

/** The pending numbered choice of an update or delete (next turn only). */
export interface ConnectorWriteEventChoice {
  readonly mode: 'update' | 'delete';
  readonly changes?: CalendarDraftChanges;
  readonly reference: CalendarEventReference;
  readonly candidates: readonly ConnectorWriteEventSummary[];
}

/**
 * ADR-0112 amendment 3 (O5): several transitions lead back to the status before Quoky's own transition; the owner picks one by
 * number (next turn only). The list is exactly what Core read from the provider at listing time; a pick only indexes it, and
 * the picked id must still be listed, leading to the same status, when the preview is built.
 */
export interface ConnectorWriteRevertChoice {
  readonly mode: 'transition-revert';
  readonly issueKey: string;
  readonly transitions: readonly IssueTransitionOption[];
  readonly ownerSentence?: string;
}

export type ConnectorWriteChoice = ConnectorWriteEventChoice | ConnectorWriteRevertChoice;

export interface ConnectorWriteAnchor {
  readonly kind: typeof CONNECTOR_WRITE_ANCHOR_KIND;
  readonly status: ConnectorWriteAnchorStatus;
  readonly actorId: Id;
  readonly sessionId: Id;
  readonly family: ConnectorWriteFamily;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** The `Session.activeTaskId` this anchor displaced (restored when the write ends). */
  readonly previousActiveTaskId?: Id;
  readonly choice?: ConnectorWriteChoice;
  readonly operation?: ConnectorWriteOperation;
  /** The writer's neutral source label (receipt `connector`). */
  readonly connector?: string;
  /** Normalized target: issue key, channel id, `primary` or `primary/<eventId>`. */
  readonly target?: string;
  readonly payload?: ConnectorWritePayload;
  readonly payloadSha256?: string;
  readonly preview?: ConnectorWritePreview;
  readonly approvalId?: Id;
  readonly approvedAt?: IsoTimestamp;
  readonly approvedBy?: Id;
  readonly consumedAt?: IsoTimestamp;
  readonly outcome?: {
    readonly status: 'SENT' | 'NOT_SENT' | 'UNCERTAIN';
    readonly externalRef?: string;
    readonly url?: string;
    readonly reason?: string;
  };
  readonly closedReason?: ConnectorWriteCloseReason;
  /**
   * ADR-0112 amendment 3: set when this write is the undo of an earlier SENT write of this actor (its entry and receipt id).
   * The runtime then records the outcome as a non-undoable `action.undo`, so an undo is never undone again.
   */
  readonly undoOf?: {
    /** The undone record's entry: `calendar.create`, or `external.write` for a calendar update / delete and the Jira writes. */
    readonly entryId: 'calendar.create' | typeof LAST_ACTION_EXTERNAL_ENTRY;
    readonly receiptId: Id;
    /** The undone write's family (absent on anchors written before the update / delete families existed: `calendar-create`). */
    readonly family?: ExternalUndoFamily;
    /**
     * Review round 2: the anchor Task of the undone write (set for a calendar-update undo and both Jira undos). At execution
     * the inverse is re-derived from that anchor and must equal the payload exactly; an undo card without it never runs.
     */
    readonly sourceTaskId?: Id;
  };
}

/**
 * ADR-0120 A6-D3 amendment (2026-11-03): the connector writes the kill switch governs. ADR-0112 amendment 1 ties the undo to
 * the switch (`action.undo` is withdrawn while stopped), so an anchor with `undoOf` (the receipt-sourced undo of an own
 * write) is governed. A write the owner asked for with an anchored Class A command carries no switch (A6-D3: "Anchored
 * Class A commands carry no condition"), so it is not.
 */
export function isActionSwitchGoverned(anchor: Pick<ConnectorWriteAnchor, 'undoOf'>): boolean {
  return anchor.undoOf !== undefined;
}

/** What `releaseExpired` released: the lapsed anchor's state and the session pointer after the release. */
export interface ConnectorWriteRelease {
  readonly status: 'APPROVED' | 'AWAITING_CHOICE';
  readonly family: ConnectorWriteFamily;
  readonly operation?: ConnectorWriteOperation;
  /** `Session.activeTaskId` after the release (the pointer the anchor displaced, or none). */
  readonly activeTaskId: Id | undefined;
}

/**
 * Whether an APPROVED grant or an AWAITING_CHOICE choice has outlived the ADR-0093 lifetime at `now`. A grant counts
 * from its approval, a choice from its listing; a missing or unreadable timestamp counts as lapsed.
 */
export function isConnectorWriteAnchorLapsed(anchor: ConnectorWriteAnchor, now: IsoTimestamp): boolean {
  const since = anchor.status === 'APPROVED' ? anchor.approvedAt : anchor.status === 'AWAITING_CHOICE' ? anchor.createdAt : null;
  if (since === null) return false;
  const start = since === undefined ? Number.NaN : Date.parse(since);
  return !Number.isFinite(start) || Date.parse(now) - start >= PENDING_APPROVAL_TTL_MS;
}

/** The session's connector-write anchor as the runtime sees it. */
/**
 * A SENT anchor whose send is older than the ADR-0093 lifetime (`PENDING_APPROVAL_TTL_MS`, from the terminal save): a
 * repeated phrase no longer reports it as just executed (live QA: an old link is not "what just happened").
 */
export function isConnectorWriteSendStale(anchor: ConnectorWriteAnchor, now: IsoTimestamp): boolean {
  if (anchor.status !== 'SENT') return false;
  const sent = Date.parse(anchor.updatedAt);
  return !Number.isFinite(sent) || Date.parse(now) - sent >= PENDING_APPROVAL_TTL_MS;
}

export interface ConnectorWriteAnchorView {
  readonly taskId: Id;
  readonly anchor: ConnectorWriteAnchor;
  /** The approval behind `APPROVAL_PENDING` (re-read; PENDING), else null. */
  readonly approval: ApprovalRequest | null;
}

export type ConnectorWriteRefusal =
  | 'target-not-allowed'
  | 'invalid-target'
  | 'invalid-text'
  | 'text-too-long'
  | 'credential'
  | 'transition-unavailable'
  | 'transition-lookup-failed'
  /** Review round 1 (P3): the issue answers under another key (it was moved) when a transition is previewed. */
  | 'target-changed'
  | 'event-not-found'
  /** An undated reference with no recent calendar context and nothing on the calendar today or tomorrow. */
  | 'no-nearby-events'
  | 'event-unversioned'
  | 'too-many-events'
  | 'calendar-read-failed'
  | 'all-day-move'
  | 'invalid-time'
  | 'no-change'
  | 'invalid-choice'
  | 'binding-mismatch'
  | 'grant-expired'
  /** The grant was withdrawn (거절/취소 after approval) before it could run (Codex P1 on 55c5a2f). */
  | 'grant-revoked'
  | 'choice-expired'
  /** ADR-0112 amendment 3: the undo has nothing to act on (no receipt of this session's own last write, or it is stale). */
  | 'undo-nothing'
  /** The write is real but cannot be undone automatically (no version recorded, or its anchor is gone). */
  | 'undo-unavailable'
  /** The event the receipt named is already gone. */
  | 'undo-event-gone'
  /** A restore: the event the delete removed is on the calendar again (restored or re-created meanwhile); nothing to restore. */
  | 'undo-event-present'
  /** The event changed after it was created (version, time or title differ from what Quoky wrote). */
  | 'undo-event-changed'
  /** ADR-0112 amendment 3 (O4/O5): the provider could not be read to prove the undo is safe (nothing proposed). */
  | 'undo-read-failed'
  /** O4: the comment Quoky added is no longer there. */
  | 'undo-target-gone'
  /** O4: the comment was edited (or its issue moved); O5: the issue is no longer in the status Quoky moved it to. */
  | 'undo-target-changed'
  /** O4: these credentials may not delete the comment (checked read-only; no permission is requested). */
  | 'undo-not-permitted'
  /** O5: no transition available now leads back to the status the issue had before Quoky's transition. */
  | 'undo-no-path';

/** What one flow step produced; the runtime renders it through `ResponseComposer` (reply text lives there). */
export type ConnectorWriteStep =
  /** No writer is bound for this draft (writes are off): the handler's fixed `fallbackText` is the reply. */
  | { readonly kind: 'writes-off' }
  | { readonly kind: 'usage'; readonly topic: ConnectorWriteUsageTopic }
  | {
      readonly kind: 'refused';
      readonly reason: ConnectorWriteRefusal;
      readonly family: ConnectorWriteFamily;
      /** ADR-0112 amendment 3: set on an undo's refusal, so its fixed copy names the write being undone. */
      readonly undo?: ExternalUndoFamily;
      /** `transition-unavailable`: the statuses the issue can move to now (untrusted readout). */
      readonly availableStatuses?: readonly string[];
    }
  | {
      readonly kind: 'preview';
      readonly preview: ConnectorWritePreview;
      readonly approval: ApprovalRequest;
      readonly remainingMs: number;
      readonly executionPhrase: string;
      /**
       * UNC-1: an earlier write with the same connector, operation, target and payload hash by this actor is unresolved
       * (receipt `UNCERTAIN`, or `PREPARED` = `EXECUTING`): it may already have happened, so the preview leads with a
       * duplicate warning. Approval still works (not blocked).
       */
      readonly unconfirmedEarlier?: ConnectorWriteUnconfirmedEarlier;
    }
  | {
      readonly kind: 'choice';
      readonly mode: 'update' | 'delete';
      readonly candidates: readonly ConnectorWriteEventSummary[];
      readonly timeZone: string;
      /**
       * Why these candidates, when the owner named no day (live QA D2): `listed` = from the list this session last
       * showed, `written` = the event this session just created or changed, `nearby` = no such context, so today's and
       * tomorrow's events. Absent = the events of the day the owner named.
       */
      readonly basis?: ConnectorWriteChoiceBasis;
    }
  /**
   * ADR-0112 amendment 3 (O5): several transitions lead back; the owner picks one by number. Names are untrusted readout; the
   * list is exactly the Core-listed transitions that lead back to `toStatus`.
   */
  | {
      readonly kind: 'revert-choice';
      readonly issueKey: string;
      readonly currentStatus: string;
      readonly toStatus: string;
      readonly transitions: readonly IssueTransitionOption[];
      readonly ownerSentence?: string;
    }
  | {
      readonly kind: 'already-sent';
      readonly operation: ConnectorWriteOperation;
      readonly externalRef?: string;
      readonly url?: string;
    }
  | { readonly kind: 'approved'; readonly operation: ConnectorWriteOperation; readonly executionPhrase: string }
  | {
      readonly kind: 'outcome';
      readonly operation: ConnectorWriteOperation;
      readonly outcome: ConnectorWriteOutcome;
      readonly preview: ConnectorWritePreview;
      /** The write's receipt id when one was prepared (ADR-0112 amendment 1 S3: `lastAction.itemId`). */
      readonly receiptId?: Id;
    }
  /** A repeated execution phrase after the write already ran (or while it may be in flight): nothing is sent again. */
  | {
      readonly kind: 'repeat';
      readonly operation: ConnectorWriteOperation;
      readonly status: 'SENT' | 'NOT_SENT' | 'UNCERTAIN' | 'EXECUTING';
      readonly externalRef?: string;
      readonly url?: string;
    }
  | { readonly kind: 'closed'; readonly reason: ConnectorWriteCloseReason; readonly family: ConnectorWriteFamily };

/**
 * Narrow storage (satisfied by the live `StorageProvider`; resolved at call time, ADR-0062). `sessions.list` and
 * `tasks.listByContext` serve only the stray-phrase lookups ({@link ConnectorWriteFlow.approvedElsewhere},
 * {@link ConnectorWriteFlow.recentSentInSession}, {@link ConnectorWriteFlow.recentUnconfirmedInSession},
 * {@link ConnectorWriteFlow.latestRequestInSession}); nothing is ever executed from them.
 */
export interface ConnectorWriteFlowStore {
  readonly sessions: {
    get(id: Id): Promise<Session | null>;
    save(session: Session): Promise<Session>;
    list(): Promise<Session[]>;
  };
  readonly tasks: {
    get(id: Id): Promise<Task | null>;
    save(task: Task): Promise<Task>;
    listByContext(channelId: string, threadId?: string): Promise<Task[]>;
  };
}

export interface ConnectorWriteWriters {
  readonly issueComments?: IssueCommentWriter;
  readonly issueTransitions?: IssueTransitionWriter;
  readonly channelMessages?: ChannelMessageWriter;
  readonly calendarEvents?: CalendarEventWriter;
}

export interface ConnectorWriteFlowDeps {
  readonly writers: ConnectorWriteWriters;
  /** Read-only PRIMARY-calendar reader for update/delete references (required for those; absent → read failure). */
  readonly calendarReader?: CalendarReader;
  readonly receipts: ConnectorWriteReceiptRepository;
  readonly approvals: {
    requestForRisk(input: {
      executionPlanRef: ExecutionPlanRef;
      riskLevel: RiskLevel;
      reason: string;
      requestedBy: string;
    }): Promise<ApprovalRequest>;
    get(approvalId: Id): Promise<ApprovalRequest | null>;
    decide(
      approvalId: Id,
      decision: { approvalId: Id; approved: boolean; decidedBy: string; decidedAt: IsoTimestamp; comment?: string },
    ): Promise<ApprovalRequest>;
  };
  readonly store: ConnectorWriteFlowStore;
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  readonly newId: () => Id;
  readonly logger?: Logger;
  /** Bound on the calendar read for a reference (ms). */
  readonly readTimeoutMs?: number;
  /** The session write lock (ADR-0113 D7). Omitted → the process-wide {@link SESSION_WRITE_LOCK}. */
  readonly sessionLock?: SessionWriteLock;
}

/** The runtime-facing surface (`ConversationRuntimeDeps.connectorWriteFlow`, ADR-0112 D5: baseline 34 → 35). */
export interface ConnectorWriteFlow {
  /** Help lines for the writes this flow can actually perform (ADR-0096 D6 contributed lines). */
  readonly helpLines: readonly string[];
  /** Whether a writer is bound for the draft's family (false → writes are off for it). */
  supports(draft: ConnectorWriteDraft): boolean;
  find(session: Session, held?: SessionLockHold): Promise<ConnectorWriteAnchorView | null>;
  /**
   * Strictly read-only `find` (ADR-0113 D4): the open anchor and, behind `APPROVAL_PENDING`, its approval while it is
   * still PENDING (else null). Unlike `find` it never closes an anchor whose approval was decided elsewhere — that
   * state is legitimate mid-transition (approved, `recordApproval` not yet run). For the operations UI.
   */
  peek?(session: Session): Promise<ConnectorWriteAnchorView | null>;
  /**
   * An execution phrase in a conversation with no approved write of `operation`: this actor's APPROVED, unexecuted,
   * unlapsed write of that kind waiting in ANOTHER active conversation (the newest), or null. Read-only and only a
   * hint — execution stays bound to the conversation the approval was asked in.
   */
  approvedElsewhere(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<ConnectorWriteApprovedElsewhere | null>;
  /**
   * The link/reference of a write of `operation` whose approval was anchored in THIS conversation and whose receipt is
   * SENT within the ADR-0093 lifetime (`PENDING_APPROVAL_TTL_MS`, from the receipt) — the newest; null otherwise
   * (W5-L02: a repeated execution phrase right after a send; never another conversation's or an old receipt).
   */
  recentSentInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<ConnectorWriteRecentSend | null>;
  /**
   * Codex P2 on 039d5ff / a2b8aed: this conversation's most recent write of `operation` that may have been sent — its
   * receipt is UNCERTAIN, or still PREPARED (in flight / interrupted) — unless a LATER write of that kind in this
   * conversation is SENT; null otherwise. It never expires (an unresolved outcome stays unresolved; bounded only by the
   * session and receipt retention), and a later NOT_SENT does not hide it. No reply may then say nothing was sent.
   */
  recentUnconfirmedInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<ConnectorWriteRecentUnconfirmed | null>;
  /**
   * Codex P2/P3 on 55c5a2f: the single most recent write REQUEST of `operation` in THIS conversation by `actorId`, in any
   * state (newest by creation), with what became of it — open, closed unsent (and why), SENT, NOT_SENT, or dispatched
   * but unconfirmed. Bounded only by the conversation. Read-only; replies describe exactly this request.
   */
  latestRequestInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
  ): Promise<ConnectorWriteLatestRequest | null>;
  /**
   * Lazy expiry of an APPROVED grant or an AWAITING_CHOICE choice past the ADR-0093 lifetime: closes it `expired`
   * (restoring the pointer it displaced) and says what was released; null when nothing lapsed.
   */
  releaseExpired(session: Session, now: IsoTimestamp): Promise<ConnectorWriteRelease | null>;
  /**
   * ADR-0120 A6-D3 amendment (2026-11-03): every not yet closed anchor of `actorId` across the actor's active conversations,
   * each with its session and (behind `APPROVAL_PENDING`) its pending approval. Strictly read-only (like `peek`), so the
   * kill switch can list and close the approvals it governs. Optional: a flow without it has nothing to list.
   */
  openAnchorsOf?(actorId: Id): Promise<Array<{ readonly session: Session; readonly view: ConnectorWriteAnchorView }>>;
  /**
   * Strictly read-only: the connector-write anchor of ONE task read directly (not through the session's `activeTaskId`, which a
   * finished write hands back to its previous task), or null when the task is missing or not a connector-write anchor. A closed
   * anchor is returned as it is. For the kill switch's truthful report of a write that finished meanwhile.
   */
  anchorOfTask?(session: Session, taskId: Id): Promise<ConnectorWriteAnchorView | null>;
  prepare(input: FlowInput & { readonly draft: ConnectorWriteDraft }): Promise<ConnectorWriteStep>;
  choose(input: FlowInput & { readonly view: ConnectorWriteAnchorView; readonly index: number }): Promise<ConnectorWriteStep>;
  recordApproval(input: FlowInput & { readonly view: ConnectorWriteAnchorView }): Promise<ConnectorWriteStep>;
  execute(input: ConnectorWriteExecuteInput): Promise<ConnectorWriteStep>;
  close(
    session: Session,
    view: ConnectorWriteAnchorView,
    reason: ConnectorWriteCloseReason,
    now: IsoTimestamp,
    held?: SessionLockHold,
  ): Promise<void>;
}

/** What a cross-conversation hint may name: the target only (never payload text, event text or a transition). */
export type ConnectorWriteTargetSummary =
  | { readonly kind: 'issue'; readonly issueKey: string }
  | { readonly kind: 'channel'; readonly channelLabel: string; readonly channelId: string }
  | { readonly kind: 'calendar' };

/** An approved write waiting in another conversation ({@link ConnectorWriteFlow.approvedElsewhere}). */
export interface ConnectorWriteApprovedElsewhere {
  readonly operation: ConnectorWriteOperation;
  readonly target: ConnectorWriteTargetSummary;
  /** The conversation that holds the approval (where the phrase must be sent). */
  readonly context: ConversationContext;
  readonly executionPhrase: string;
  /** What is left of the grant's ADR-0093 lifetime (from the approval). */
  readonly remainingMs: number;
}

/** A recent send approved in this conversation ({@link ConnectorWriteFlow.recentSentInSession}). */
export interface ConnectorWriteRecentSend {
  readonly externalRef?: string;
  readonly url?: string;
  /** When the receipt became SENT. */
  readonly sentAt: IsoTimestamp;
  readonly target: ConnectorWriteTargetSummary;
  /** The flow's display time zone (`QUOKY_TIMEZONE`). */
  readonly timeZone: string;
}

/** What became of a conversation's latest write request ({@link ConnectorWriteFlow.latestRequestInSession}). */
export type ConnectorWriteRequestState =
  | { readonly kind: 'open' }
  | { readonly kind: 'closed'; readonly reason: ConnectorWriteCloseReason }
  | { readonly kind: 'sent' }
  | { readonly kind: 'not-sent' }
  | { readonly kind: 'unconfirmed'; readonly status: 'UNCERTAIN' | 'EXECUTING' };

/** A conversation's latest write request of one kind ({@link ConnectorWriteFlow.latestRequestInSession}). */
export interface ConnectorWriteLatestRequest {
  readonly taskId: Id;
  readonly operation: ConnectorWriteOperation;
  readonly target: ConnectorWriteTargetSummary;
  readonly createdAt: IsoTimestamp;
  readonly state: ConnectorWriteRequestState;
}

/** An earlier, unresolved write of the very same payload to the same target by this actor (UNC-1 preview warning). */
export interface ConnectorWriteUnconfirmedEarlier {
  readonly status: 'UNCERTAIN' | 'EXECUTING';
  /** When that receipt last changed. */
  readonly at: IsoTimestamp;
  /** The flow's display time zone (`QUOKY_TIMEZONE`). */
  readonly timeZone: string;
}

/** A dispatched, unconfirmed write approved in this conversation ({@link ConnectorWriteFlow.recentUnconfirmedInSession}). */
export interface ConnectorWriteRecentUnconfirmed {
  readonly operation: ConnectorWriteOperation;
  /** `UNCERTAIN`: the outcome could not be verified; `EXECUTING`: the receipt is still PREPARED (in flight). */
  readonly status: 'UNCERTAIN' | 'EXECUTING';
  /** When the receipt last changed. */
  readonly at: IsoTimestamp;
}

/** The target part of a preview, for a hint shown outside the conversation that previewed it. */
export function connectorWriteTargetOf(preview: ConnectorWritePreview): ConnectorWriteTargetSummary {
  switch (preview.operation) {
    case 'ISSUE_COMMENT':
    case 'ISSUE_TRANSITION':
    case 'ISSUE_COMMENT_DELETE':
    case 'ISSUE_TRANSITION_REVERT':
      return { kind: 'issue', issueKey: preview.issueKey };
    case 'CHANNEL_POST':
      return { kind: 'channel', channelLabel: preview.channelLabel, channelId: preview.channelId };
    case 'CALENDAR_EVENT_CREATE':
    case 'CALENDAR_EVENT_UPDATE':
    case 'CALENDAR_EVENT_DELETE':
    case 'CALENDAR_EVENT_RESTORE':
      return { kind: 'calendar' };
  }
}

export interface FlowInput {
  readonly session: Session;
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** A caller already holding the session write lock passes its hold (ADR-0113 D7); absent → the flow takes it. */
  readonly held?: SessionLockHold;
  /**
   * ADR-0112 amendment 1 S3: the platform id of the message this turn replied to. Only an undo reads it (echo-reply window);
   * the resolver verifies it against the record's own `echoReplyIds`.
   */
  readonly replyToMessageId?: string;
  /** The owner's own message text of this turn (an undo card quotes it, bounded; it never selects a target). */
  readonly ownerText?: string;
}

/**
 * `execute`'s input. `claim` runs the validation + consume section; the runtime passes the shared approval → session
 * locks a revocation also takes (Codex P1 on 55c5a2f). Without it the flow takes the session write lock.
 */
export interface ConnectorWriteExecuteInput extends FlowInput {
  readonly view: ConnectorWriteAnchorView;
  readonly claim?: <T>(work: (held: SessionLockHold) => Promise<T>) => Promise<T>;
  /**
   * ADR-0122 D2.5: run as the last step before the writer is called (after the claim and the reconcile); a throw means
   * nothing is sent (recorded NOT_SENT, never retried).
   */
  readonly beforeSend?: () => Promise<unknown>;
}

/** The execution gate (EXECUTION_PHRASES) of each operation. */
export function connectorWriteExecutionGate(operation: ConnectorWriteOperation): ExecutionGate {
  switch (operation) {
    case 'ISSUE_COMMENT':
      return 'issueComment';
    case 'ISSUE_TRANSITION':
      return 'issueTransition';
    case 'CHANNEL_POST':
      return 'channelPost';
    case 'CALENDAR_EVENT_CREATE':
      return 'calendarCreate';
    case 'CALENDAR_EVENT_UPDATE':
      return 'calendarUpdate';
    case 'CALENDAR_EVENT_DELETE':
      return 'calendarDelete';
    case 'CALENDAR_EVENT_RESTORE':
      return 'calendarRestore';
    case 'ISSUE_COMMENT_DELETE':
      return 'issueCommentDelete';
    case 'ISSUE_TRANSITION_REVERT':
      return 'issueTransitionRevert';
  }
}

/** True when the whole message is the accepted execution phrase of ANY connector-write gate. */
export function isAnyConnectorWriteExecutionPhrase(text: string): boolean {
  return CONNECTOR_WRITE_OPERATIONS.some((operation) =>
    isAcceptedExecutionPhrase(connectorWriteExecutionGate(operation), text),
  );
}

/** The operations whose exact execution phrase `text` is (usually one). */
export function connectorWriteOperationsOfPhrase(text: string): ConnectorWriteOperation[] {
  return CONNECTOR_WRITE_OPERATIONS.filter((operation) => isAcceptedExecutionPhrase(connectorWriteExecutionGate(operation), text));
}

const EXECUTION_STEP_MENTIONS: Readonly<Record<ConnectorWriteOperation, RegExp>> = {
  ISSUE_COMMENT: /댓글실행|execute(?:approved)?comment/u,
  ISSUE_TRANSITION: /상태변경실행|execute(?:approved)?transition/u,
  CHANNEL_POST: /게시실행|execute(?:slack)?post/u,
  CALENDAR_EVENT_CREATE: /일정추가실행|executeeventcreate/u,
  CALENDAR_EVENT_UPDATE: /일정변경실행|executeeventupdate/u,
  CALENDAR_EVENT_DELETE: /일정삭제실행|executeeventdelete/u,
  CALENDAR_EVENT_RESTORE: /일정복원실행|executeeventrestore/u,
  ISSUE_COMMENT_DELETE: /댓글삭제실행|executejiracommentdelete/u,
  ISSUE_TRANSITION_REVERT: /상태되돌리기실행|executejiratransitionrevert/u,
};

/** Explanation / how-to requests about a step are ordinary chat, not a question about the pending write. */
const EXPLANATION_REQUEST = /설명|방법|어떻게|알려|explain|how/u;

/**
 * True when a message talks about the execution step OF `operation` ("댓글 실행해도 돼?" while a comment is approved)
 * without being the exact phrase. Mentions of another operation's step and explanation requests are not matched.
 * Used only to pick a non-mutating reminder — never to execute (W5-L01).
 */
export function mentionsConnectorWriteExecutionStep(text: string, operation: ConnectorWriteOperation): boolean {
  const lowered = text.toLowerCase();
  if (EXPLANATION_REQUEST.test(lowered)) return false;
  return EXECUTION_STEP_MENTIONS[operation].test(lowered.replace(/\s+/gu, ''));
}

/** A concept question about a step ("댓글 실행이 뭐야?", "what is execute post?") is ordinary chat, never a stray phrase. */
const CONCEPT_QUESTION = /뭐야|뭔가요|뭐예요|뭐에요|무엇|무슨|뜻|의미|\bwhat(?:'s|\s+is|\s+are|\s+does)\b|\bmean(?:s|ing)?\b/u;

/**
 * The operations whose execution step a short QUESTION or NEGATION names ("댓글 실행해도 돼?", "Slack 게시 실행하지 마",
 * "일정 삭제 실행할까?", "execute post now?") — the shape {@link isAcceptedExecutionPhrase} vetoes, so it never executes.
 * Explanation / concept requests ("댓글 실행 방법 알려줘", "게시 실행이 뭐야?") and statements are not matched (chat).
 * Used only to pick a non-mutating reply when nothing of that kind is approved here (routing exec gaps) — never to
 * execute, and never consulted by an execution gate.
 */
export function connectorWriteOperationsAskedAbout(text: string): ConnectorWriteOperation[] {
  if (typeof text !== 'string') return [];
  const rejection = executionCommandRejection(text);
  if (rejection !== 'question' && rejection !== 'negation') return [];
  if (CONCEPT_QUESTION.test(text.toLowerCase())) return [];
  return CONNECTOR_WRITE_OPERATIONS.filter((operation) => mentionsConnectorWriteExecutionStep(text, operation));
}

/** The step words of each write as a user names it (whole-message grammar below; the allow-list stays the executor). */
const STEP_WORDS: Readonly<Record<ConnectorWriteOperation, string>> = {
  ISSUE_COMMENT: String.raw`(?:(?:jira|지라)\s*)?(?:댓글|코멘트)`,
  ISSUE_TRANSITION: String.raw`(?:(?:jira|지라)\s*)?상태\s*변경`,
  CHANNEL_POST: String.raw`(?:(?:slack|슬랙)\s*)?게시`,
  CALENDAR_EVENT_CREATE: String.raw`(?:캘린더\s*)?일정\s*추가`,
  CALENDAR_EVENT_UPDATE: String.raw`(?:캘린더\s*)?일정\s*변경`,
  CALENDAR_EVENT_DELETE: String.raw`(?:캘린더\s*)?일정\s*삭제`,
  CALENDAR_EVENT_RESTORE: String.raw`(?:캘린더\s*)?일정\s*복원`,
  ISSUE_COMMENT_DELETE: String.raw`(?:jira|지라)\s*(?:댓글|코멘트)\s*삭제`,
  ISSUE_TRANSITION_REVERT: String.raw`(?:jira|지라)\s*상태\s*되돌리기`,
};

/** Imperative endings of "<step> 실행…" that the allow-list does not accept ("댓글 실행해", "게시 실행하자"). */
const LOOSE_EXECUTION_TAIL = String.raw`실행\s*(?:해|해요|해라|하자|시켜|시켜\s*줘|시켜\s*주세요|해\s*줄래|해\s*줄래요|해\s*봐|좀\s*해\s*줘|부탁해|부탁해요)`;

/**
 * "Did it happen?" questions per write (live sweep, DET-2): the user asks whether a comment, post, transition or
 * calendar change went out. Each needs a question ending or a `?` ({@link connectorWriteOperationsNamedLoosely}).
 */
const DONE_QUESTIONS: Readonly<Record<ConnectorWriteOperation, RegExp>> = {
  ISSUE_COMMENT:
    /^(?:(?:jira|지라)\s*)?(?:댓글|코멘트)\s*(?:은|는|이|가|을|를|도)?\s*(?:잘\s*)?(?:달았|달렸|남겼|보냈|올렸|올라갔|등록됐|등록했|작성했|작성됐|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  ISSUE_TRANSITION:
    /^(?:(?:jira|지라)\s*)?상태\s*(?:은|는|가|를)?\s*(?:잘\s*)?(?:변경했|변경됐|변경되었|바꿨|바뀌었|전환됐|전환했)(?:어|어요|나|나요|니|냐|지|죠)$|^(?:(?:jira|지라)\s*)?상태\s*변경\s*(?:은|는|이|가)?\s*(?:잘\s*)?(?:했|됐|되었|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  CHANNEL_POST:
    /^(?:slack|슬랙)\s*(?:에|에다|에서)?\s*(?:게시|글|메시지)?\s*(?:은|는|이|가|을|를|도)?\s*(?:잘\s*)?(?:게시했|게시됐|게시되었|올렸|올라갔|보냈|보내졌|전송됐|전송했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$|^게시(?:물|글)?\s*(?:은|는|이|가|을|를|도)?\s*(?:잘\s*)?(?:했|됐|되었|올렸|올라갔|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  CALENDAR_EVENT_CREATE:
    /^(?:캘린더\s*(?:에)?\s*)?일정\s*(?:은|는|이|가)?\s*(?:잘\s*)?(?:추가됐|추가했|추가되었|잡혔|잡았|등록됐|등록했|생겼|만들었|만들어졌|들어갔)(?:어|어요|나|나요|니|냐|지|죠)$|^(?:캘린더\s*)?일정\s*추가\s*(?:는|가)?\s*(?:잘\s*)?(?:됐|했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  CALENDAR_EVENT_UPDATE:
    /^(?:캘린더\s*)?일정\s*(?:은|는|이|가)?\s*(?:잘\s*)?(?:변경됐|변경했|변경되었|바뀌었|바꿨|옮겨졌|옮겼|수정됐|수정했)(?:어|어요|나|나요|니|냐|지|죠)$|^(?:캘린더\s*)?일정\s*변경\s*(?:은|이)?\s*(?:잘\s*)?(?:됐|했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  CALENDAR_EVENT_DELETE:
    /^(?:캘린더\s*)?일정\s*(?:은|는|이|가)?\s*(?:잘\s*)?(?:삭제됐|삭제했|삭제되었|지워졌|지웠|취소됐|취소했|빠졌)(?:어|어요|나|나요|니|냐|지|죠)$|^(?:캘린더\s*)?일정\s*삭제\s*(?:는|가)?\s*(?:잘\s*)?(?:됐|했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  // A restore is only ever an undo: only the structural "<step words> 됐어?" form, no verb list (owner rule: no phrase lists).
  CALENDAR_EVENT_RESTORE: /^(?:캘린더\s*)?일정\s*복원\s*(?:은|이)?\s*(?:잘\s*)?(?:됐|했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  // The Jira undos likewise: only the structural "<step words> 됐어?" form of their own step words.
  ISSUE_COMMENT_DELETE: /^(?:jira|지라)\s*(?:댓글|코멘트)\s*삭제\s*(?:는|가)?\s*(?:잘\s*)?(?:됐|했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
  ISSUE_TRANSITION_REVERT: /^(?:jira|지라)\s*상태\s*되돌리기\s*(?:는|가)?\s*(?:잘\s*)?(?:됐|했|실행했|실행됐)(?:어|어요|나|나요|니|냐|지|죠)$/u,
};
/** A "did it happen?" ending that is a question by itself (no `?` needed). */
const SELF_QUESTION_ENDING = /(?:나|나요|니|냐|지|죠)$/u;

/**
 * The writes a short whole message names WITHOUT being an execution command or a question the allow-list vetoes
 * (DET-2 sweep): a loose imperative of the step ("댓글 실행해", "일정 추가 실행하자") or a "did it happen?" question
 * ("댓글 달았어?", "Slack 게시했어?", "일정 추가됐어?"). The runtime answers both with the same non-mutating reply as
 * {@link connectorWriteOperationsAskedAbout} (this conversation's recent send, or "nothing approved"; the approved
 * write's own reminder while one waits). Never consulted by an execution gate, and never accepted by one (pinned by
 * test): the exact phrase stays the only executor. Statements ("댓글 달았어") and explanations are not matched.
 */
export function connectorWriteOperationsNamedLoosely(text: string): ConnectorWriteOperation[] {
  if (typeof text !== 'string') return [];
  const trimmed = text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (trimmed.length === 0 || trimmed.length > 40) return [];
  const questioned = /[?？]\s*$/u.test(trimmed);
  const bare = trimmed.toLowerCase().replace(/[\s?？.!~。！]+$/u, '');
  const loose = CONNECTOR_WRITE_OPERATIONS.filter((operation) =>
    new RegExp(String.raw`^(?:(?:지금|이제|바로)\s*)?(?:승인된\s*)?${STEP_WORDS[operation]}\s*${LOOSE_EXECUTION_TAIL}$`, 'u').test(bare),
  );
  if (loose.length > 0 && !questioned) return loose;
  if (!questioned && !SELF_QUESTION_ENDING.test(bare)) return [];
  return CONNECTOR_WRITE_OPERATIONS.filter((operation) => DONE_QUESTIONS[operation].test(bare));
}

/**
 * The step verb of a write, taken from its OWN documented execution phrase (`<object…> <verb> 실행`): "일정 삭제 실행" ->
 * "삭제", "상태 변경 실행" -> "변경", "Slack 게시 실행" -> "게시". A phrase whose only word before "실행" is the object
 * ("댓글 실행") has no separable verb -> null (that family's behaviour is unchanged). Derived from the phrase data, never
 * from a separate list.
 */
export function connectorWriteStepVerb(operation: ConnectorWriteOperation): string | null {
  const words = normalizeExecutionPhrase(documentedExecutionPhrase(connectorWriteExecutionGate(operation))).split(' ');
  if (words.length < 3 || words[words.length - 1] !== '실행') return null;
  return words[words.length - 2] ?? null;
}

const STEP_VERB_TAIL = String.raw`실행(?:\s*(?:해|해요|해줘|해라|하자|시켜|시켜\s*줘|시켜\s*주세요|해\s*줄래|해\s*줄래요|해\s*봐|좀\s*해\s*줘|부탁해|부탁해요))?`;

/**
 * True when the whole message is the approved write's own step verb without its object noun ("삭제 실행" while "일정 삭제
 * 실행" waits). The verb comes from that write's own phrase ({@link connectorWriteStepVerb}); another operation's verb is
 * not a match. Used ONLY to choose the exact-phrase reply (same as a bare "실행") — it never executes and no execution
 * gate consults it: the exact phrase stays the only executor.
 */
export function namesApprovedWriteStepVerb(text: string, operation: ConnectorWriteOperation): boolean {
  if (typeof text !== 'string') return false;
  const verb = connectorWriteStepVerb(operation);
  if (verb === null) return false;
  const trimmed = text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (executionCommandRejection(trimmed) !== null) return false;
  const bare = trimmed.toLowerCase().replace(/[\s.!~。！]+$/u, '');
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(String.raw`^(?:(?:지금|이제|바로)\s*)?(?:승인된\s*)?${escaped}\s*${STEP_VERB_TAIL}$`, 'u').test(bare);
}

/**
 * Bare execution commands that name no step ("실행", "실행해", "실행해줘", "go", "run it"), after
 * {@link normalizeExecutionPhrase} and one optional leading "지금/이제/바로/now" or trailing "now/please".
 */
const BARE_EXECUTION_REQUESTS: ReadonlySet<string> = new Set(
  [
    '실행', '실행해', '실행해줘', '실행하자', '실행시켜', '실행시켜줘', 'go', 'go go', 'run', 'run it', 'execute', 'execute it', 'do it',
  ].map(normalizeExecutionPhrase),
);
const BARE_EXECUTION_PREFIX = /^(?:지금|이제|바로|now)\s+/u;
const BARE_EXECUTION_SUFFIX = /\s+(?:now|please)$/u;

/**
 * True when the whole message is a bare execution command that names no step ("실행", "실행해줘", "go", "run it").
 * While a connector write waits APPROVED it runs nothing and gets the exact-phrase reply (routing exec gaps) — the
 * write's own phrase stays the only executor. Pure; never consulted by an execution gate.
 */
export function isBareExecutionRequest(text: string): boolean {
  if (typeof text !== 'string') return false;
  const base = normalizeExecutionPhrase(text);
  const noPrefix = base.replace(BARE_EXECUTION_PREFIX, '');
  return [base, noPrefix, base.replace(BARE_EXECUTION_SUFFIX, ''), noPrefix.replace(BARE_EXECUTION_SUFFIX, '')].some(
    (form) => BARE_EXECUTION_REQUESTS.has(normalizeExecutionPhrase(form)),
  );
}

/**
 * A bare execution step asked as a question or negated, naming no step ("실행해도 돼?", "실행할까?", "실행하지 마",
 * "지금 실행해도 될까"): with nothing approved here the runtime answers it like a bare "실행" (nothing ran), never chat.
 * Pure; never consulted by an execution gate (every match is a question or a negation, which every gate vetoes).
 */
const BARE_EXECUTION_QUESTIONS =
  /^(?:(?:지금|이제|바로)\s*)?실행\s*(?:해도\s*(?:돼|돼요|될까|될까요|되나요|괜찮아|괜찮을까)|할까|할까요|해\s*볼까|해야\s*(?:해|돼|하나요)|하지\s*(?:마|마요|마세요|말아\s*줘|말아\s*주세요)|안\s*해도\s*(?:돼|돼요)|하면\s*안\s*돼|가능해|가능할까|해\s*줄래|해\s*줄\s*수\s*있어)$/u;

/** The prohibitions among them ("실행하지 마", "실행하면 안 돼", "don't run it"): with an approved grant they withdraw it. */
const BARE_EXECUTION_PROHIBITION =
  /^(?:(?:지금|이제|바로)\s*)?실행\s*(?:하지\s*(?:마|마요|마세요|말아\s*줘|말아\s*주세요)|하면\s*안\s*돼)$|^(?:do\s+not|don['’]t)\s+(?:run|execute)\s+it$/u;
const BARE_EXECUTION_QUESTION_EN = /^(?:should\s+i|can\s+(?:i|you)|may\s+i)\s+(?:run|execute)\s+it$/u;

function bareExecutionForm(text: string): string | null {
  if (typeof text !== 'string') return null;
  const bare = text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().replace(/[\s?？.!~。！]+$/u, '');
  return bare.length === 0 || bare.length > 30 ? null : bare;
}

export function isBareExecutionQuestionOrNegation(text: string): boolean {
  const bare = bareExecutionForm(text);
  if (bare === null) return false;
  return BARE_EXECUTION_QUESTIONS.test(bare) || BARE_EXECUTION_QUESTION_EN.test(bare) || BARE_EXECUTION_PROHIBITION.test(bare);
}

/**
 * True for the prohibitions of {@link isBareExecutionQuestionOrNegation} ("실행하지 마", "실행하면 안 돼", "don't run
 * it"). While a write waits approved, the runtime withdraws that grant through the serialized revoke path (a cancel,
 * nothing is sent); the questions ("실행해도 돼?", "실행할까?") only get the exact-phrase hint (Codex P2 on 5594c16).
 */
export function isBareExecutionProhibition(text: string): boolean {
  const bare = bareExecutionForm(text);
  return bare !== null && BARE_EXECUTION_PROHIBITION.test(bare);
}

/** The approval reason: operation, normalized target and payload hash — never the payload text. */
export function connectorWriteApprovalReason(operation: ConnectorWriteOperation, target: string, sha256: string): string {
  return `connector-write: ${operation} target=${target} sha256=${sha256}; one-time, exact payload, no automatic retry`;
}

const CONNECTOR_WRITE_HELP_LINES: Readonly<Record<'issue' | 'channel', string>> = {
  issue: '- Jira 쓰기: "KEY-1에 댓글: 내용" → "승인" → "댓글 실행", "KEY-1 진행 중으로 바꿔줘" → "승인" → "상태 변경 실행"',
  channel: '- Slack 게시: "#채널에 게시: 내용" 또는 "#채널에 내용이라고 올려줘" → "승인" → "Slack 게시 실행"',
};

/**
 * With both the Jira and the Slack write on, one compact line carries both (ADR-0096 D6 stays 14 x 120: with Gmail and
 * Drive also on, two separate lines would push a capability line past the bound). Every command and its execution
 * phrase stays quoted; both topic anchors ("Jira 쓰기", "Slack 게시") are present for the help-intent topic answers.
 */
const CONNECTOR_WRITE_COMBINED_HELP_LINE =
  '- Jira 쓰기·Slack 게시(승인 후): "KEY-1에 댓글: 내용"→"댓글 실행", "KEY-1 진행 중으로 바꿔줘"→"상태 변경 실행", "#채널에 게시: 내용"→"Slack 게시 실행"';

class ReadTimeout extends Error {}

export class StatelessConnectorWriteFlow implements ConnectorWriteFlow {
  readonly helpLines: readonly string[];
  private reconciled: Promise<void> | null = null;
  private readonly sessionLock: SessionWriteLock;

  constructor(private readonly deps: ConnectorWriteFlowDeps) {
    this.sessionLock = deps.sessionLock ?? SESSION_WRITE_LOCK;
    const lines: string[] = [];
    const issue = Boolean(deps.writers.issueComments || deps.writers.issueTransitions);
    const channel = Boolean(deps.writers.channelMessages);
    if (issue && channel && deps.writers.issueComments && deps.writers.issueTransitions) {
      lines.push(CONNECTOR_WRITE_COMBINED_HELP_LINE);
    } else {
      if (issue) lines.push(CONNECTOR_WRITE_HELP_LINES.issue);
      if (channel) lines.push(CONNECTOR_WRITE_HELP_LINES.channel);
    }
    this.helpLines = Object.freeze(lines);
  }

  supports(draft: ConnectorWriteDraft): boolean {
    switch (connectorWriteFamilyOf(draft)) {
      case 'issue-comment':
        return this.deps.writers.issueComments !== undefined;
      case 'issue-transition':
        return this.deps.writers.issueTransitions !== undefined;
      case 'channel-post':
        return this.deps.writers.channelMessages !== undefined;
      case 'calendar':
        return this.deps.writers.calendarEvents !== undefined;
    }
  }

  // ── lookup ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async find(session: Session, held?: SessionLockHold): Promise<ConnectorWriteAnchorView | null> {
    const found = await this.openAnchorOf(session);
    if (!found) return null;
    const { task, anchor } = found;
    if (anchor.status !== 'APPROVAL_PENDING') return { taskId: task.id, anchor, approval: null };
    const approval = anchor.approvalId ? await this.deps.approvals.get(anchor.approvalId) : null;
    if (!approval || approval.status !== ApprovalStatus.PENDING) {
      // Decided outside this flow (or missing): the anchor can no longer be proven to be this request.
      const view = { taskId: task.id, anchor, approval: null };
      await this.close(session, view, 'inconsistent', anchor.updatedAt, held);
      return null;
    }
    return { taskId: task.id, anchor, approval };
  }

  async peek(session: Session): Promise<ConnectorWriteAnchorView | null> {
    const found = await this.openAnchorOf(session);
    if (!found) return null;
    const { task, anchor } = found;
    const approval =
      anchor.status === 'APPROVAL_PENDING' && anchor.approvalId ? await this.deps.approvals.get(anchor.approvalId) : null;
    return { taskId: task.id, anchor, approval: approval?.status === ApprovalStatus.PENDING ? approval : null };
  }

  async approvedElsewhere(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<ConnectorWriteApprovedElsewhere | null> {
    let best: { anchor: ConnectorWriteAnchor; context: ConversationContext; preview: ConnectorWritePreview } | null = null;
    for (const other of await this.deps.store.sessions.list()) {
      if (other.id === session.id || other.actorId !== actorId || other.status !== SessionStatus.ACTIVE) continue;
      const found = await this.openAnchorOf(other);
      if (!found) continue;
      const { anchor } = found;
      if (anchor.status !== 'APPROVED' || anchor.operation !== operation || anchor.actorId !== actorId || !anchor.preview) continue;
      // A lapsed grant can no longer run there either (its own next turn releases it): never point at it.
      if (isConnectorWriteAnchorLapsed(anchor, now)) continue;
      if (!best || (anchor.approvedAt ?? '') > (best.anchor.approvedAt ?? '')) {
        best = { anchor, context: other.context, preview: anchor.preview };
      }
    }
    if (!best) return null;
    const approvedMs = Date.parse(best.anchor.approvedAt ?? best.anchor.updatedAt);
    return {
      operation,
      target: connectorWriteTargetOf(best.preview),
      context: best.context,
      executionPhrase: documentedExecutionPhrase(connectorWriteExecutionGate(operation)),
      remainingMs: Math.max(0, approvedMs + PENDING_APPROVAL_TTL_MS - Date.parse(now)),
    };
  }

  async recentSentInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<ConnectorWriteRecentSend | null> {
    const best = await this.newestSessionReceipt(session, actorId, operation, now, ['SENT'], PENDING_APPROVAL_TTL_MS);
    if (!best) return null;
    const { receipt, preview } = best;
    return {
      ...(receipt.data.externalRef ? { externalRef: receipt.data.externalRef } : {}),
      ...(receipt.data.url ? { url: receipt.data.url } : {}),
      sentAt: receipt.updatedAt,
      target: connectorWriteTargetOf(preview),
      timeZone: this.deps.timeZone,
    };
  }

  async recentUnconfirmedInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<ConnectorWriteRecentUnconfirmed | null> {
    // No age bound: only a later SENT write of the same kind supersedes an unresolved one.
    const best = await this.newestSessionReceipt(session, actorId, operation, now, ['SENT', 'UNCERTAIN', 'PREPARED'], null);
    if (!best || best.receipt.status === 'SENT') return null;
    return { operation, status: best.receipt.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'EXECUTING', at: best.receipt.updatedAt };
  }

  async latestRequestInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
  ): Promise<ConnectorWriteLatestRequest | null> {
    let best: { taskId: Id; anchor: ConnectorWriteAnchor; order: number } | null = null;
    const anchors = await this.sessionAnchorsWithTasks(session, actorId);
    anchors.forEach(({ taskId, anchor }, order) => {
      if (anchor.operation !== operation || !anchor.preview) return;
      const newer =
        !best ||
        anchor.createdAt > best.anchor.createdAt ||
        (anchor.createdAt === best.anchor.createdAt &&
          (anchor.updatedAt > best.anchor.updatedAt || (anchor.updatedAt === best.anchor.updatedAt && order > best.order)));
      if (newer) best = { taskId, anchor, order };
    });
    const found = best as { taskId: Id; anchor: ConnectorWriteAnchor; order: number } | null;
    if (!found?.anchor.preview) return null;
    return {
      taskId: found.taskId,
      operation,
      target: connectorWriteTargetOf(found.anchor.preview),
      createdAt: found.anchor.createdAt,
      state: await this.requestStateOf(found.anchor),
    };
  }

  /** What became of one request: the receipt decides once the grant was consumed (never trust a stale anchor alone). */
  private async requestStateOf(anchor: ConnectorWriteAnchor): Promise<ConnectorWriteRequestState> {
    if (!anchor.consumedAt) {
      if (anchor.status === 'CLOSED') return { kind: 'closed', reason: anchor.closedReason ?? 'cancelled' };
      return { kind: 'open' };
    }
    const receipt = anchor.approvalId ? await this.deps.receipts.findByIdempotencyKey(`cwr:${anchor.approvalId}`) : null;
    const status = receipt?.status ?? (anchor.status === 'CLOSED' ? 'NOT_SENT' : anchor.status);
    if (status === 'SENT') return { kind: 'sent' };
    if (status === 'NOT_SENT') return { kind: 'not-sent' };
    return { kind: 'unconfirmed', status: status === 'UNCERTAIN' ? 'UNCERTAIN' : 'EXECUTING' };
  }

  /** Every connector-write anchor this conversation created for `actorId` (any status), with its task id. Read-only. */
  private async sessionAnchorsWithTasks(session: Session, actorId: Id): Promise<Array<{ taskId: Id; anchor: ConnectorWriteAnchor }>> {
    const tasks = await this.deps.store.tasks.listByContext(session.context.channelId, session.context.threadId);
    const anchors: Array<{ taskId: Id; anchor: ConnectorWriteAnchor }> = [];
    for (const task of tasks) {
      if (task.planId) continue;
      const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
      if (anchor?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || anchor.sessionId !== session.id || anchor.actorId !== actorId) continue;
      anchors.push({ taskId: task.id, anchor });
    }
    return anchors;
  }

  /**
   * The newest receipt in one of `statuses` for a write of `operation` whose approval was anchored in THIS conversation
   * by `actorId`, changed within `maxAgeMs` of `now` (null: any age). Read-only.
   */
  private async newestSessionReceipt(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
    statuses: readonly ConnectorWriteReceipt['status'][],
    maxAgeMs: number | null,
  ): Promise<{ receipt: ConnectorWriteReceipt; preview: ConnectorWritePreview } | null> {
    // The anchors this conversation created (the session id and the approval id live in the anchor's JSON; the receipt
    // is keyed by the approval id), so no receipt column links a receipt to a conversation.
    const nowMs = Date.parse(now);
    let best: { receipt: ConnectorWriteReceipt; preview: ConnectorWritePreview } | null = null;
    for (const { anchor } of await this.sessionAnchorsWithTasks(session, actorId)) {
      // Only a consumed grant can have a receipt (the grant is consumed before anything is written).
      if (anchor.operation !== operation || !anchor.approvalId || !anchor.consumedAt || !anchor.preview) continue;
      const receipt = await this.deps.receipts.findByIdempotencyKey(`cwr:${anchor.approvalId}`);
      if (!receipt || !statuses.includes(receipt.status) || receipt.actorId !== actorId || receipt.operation !== operation) continue;
      if (maxAgeMs !== null) {
        const changedMs = Date.parse(receipt.updatedAt);
        if (!Number.isFinite(changedMs) || !Number.isFinite(nowMs) || nowMs - changedMs >= maxAgeMs) continue;
      }
      if (!best || receipt.updatedAt > best.receipt.updatedAt) best = { receipt, preview: anchor.preview };
    }
    return best;
  }

  async openAnchorsOf(actorId: Id): Promise<Array<{ readonly session: Session; readonly view: ConnectorWriteAnchorView }>> {
    const open: Array<{ session: Session; view: ConnectorWriteAnchorView }> = [];
    for (const session of await this.deps.store.sessions.list()) {
      if (session.actorId !== actorId || session.status !== SessionStatus.ACTIVE) continue;
      const found = await this.openAnchorOf(session);
      if (!found || found.anchor.actorId !== actorId) continue;
      const { task, anchor } = found;
      const approval =
        anchor.status === 'APPROVAL_PENDING' && anchor.approvalId ? await this.deps.approvals.get(anchor.approvalId) : null;
      open.push({ session, view: { taskId: task.id, anchor, approval: approval?.status === ApprovalStatus.PENDING ? approval : null } });
    }
    return open;
  }

  async releaseExpired(session: Session, now: IsoTimestamp): Promise<ConnectorWriteRelease | null> {
    const found = await this.openAnchorOf(session);
    if (!found) return null;
    const { task, anchor } = found;
    if ((anchor.status !== 'APPROVED' && anchor.status !== 'AWAITING_CHOICE') || !isConnectorWriteAnchorLapsed(anchor, now)) {
      return null;
    }
    await this.close(session, { taskId: task.id, anchor, approval: null }, 'expired', now);
    this.log('info', 'connector_write.lapsed', { status: anchor.status, ...(anchor.operation ? { operation: anchor.operation } : {}) });
    return {
      status: anchor.status,
      family: anchor.family,
      ...(anchor.operation ? { operation: anchor.operation } : {}),
      activeTaskId: anchor.previousActiveTaskId,
    };
  }

  /** Read-only: the connector-write anchor on `taskId` (any status), only when it belongs to this owner's `session`. */
  async anchorOfTask(session: Session, taskId: Id): Promise<ConnectorWriteAnchorView | null> {
    const task = await this.deps.store.tasks.get(taskId);
    if (!task || task.planId) return null;
    const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
    if (anchor?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || anchor.sessionId !== session.id) return null;
    return { taskId: task.id, anchor, approval: null };
  }

  /** The session's own, not yet closed connector-write anchor (via `activeTaskId`), or null. */
  private async openAnchorOf(session: Session): Promise<{ task: Task; anchor: ConnectorWriteAnchor } | null> {
    if (!session.activeTaskId) return null;
    const task = await this.deps.store.tasks.get(session.activeTaskId);
    if (!task || task.planId) return null;
    const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
    if (anchor?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || anchor.sessionId !== session.id) return null;
    if (anchor.status === 'CLOSED') return null;
    return { task, anchor };
  }

  // ── prepare: draft → exact payload → preview + CRITICAL approval ───────────────────────────────────────────────

  async prepare(input: FlowInput & { readonly draft: ConnectorWriteDraft }): Promise<ConnectorWriteStep> {
    const { draft } = input;
    if (!this.supports(draft)) return { kind: 'writes-off' };
    const family = connectorWriteFamilyOf(draft);
    const refused = (reason: ConnectorWriteRefusal, extra: { availableStatuses?: readonly string[] } = {}): ConnectorWriteStep => ({
      kind: 'refused',
      reason,
      family,
      ...extra,
    });
    switch (draft.kind) {
      case 'usage':
        return { kind: 'usage', topic: draft.topic };
      case 'issue-comment': {
        const writer = this.deps.writers.issueComments as IssueCommentWriter;
        const key = draft.issueKey.toUpperCase();
        if (!CONNECTOR_WRITE_ISSUE_KEY.test(key)) return refused('invalid-target');
        if (!writer.allowsIssue(key)) return refused('target-not-allowed');
        const textRefusal = checkOwnerText(draft.text, CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH);
        if (textRefusal) return refused(textRefusal);
        return this.propose(input, family, writer.source, key, { operation: 'ISSUE_COMMENT', issueKey: key, text: draft.text }, {
          operation: 'ISSUE_COMMENT',
          issueKey: key,
          text: draft.text,
        });
      }
      case 'issue-transition': {
        const writer = this.deps.writers.issueTransitions as IssueTransitionWriter;
        const key = draft.issueKey.toUpperCase();
        if (!CONNECTOR_WRITE_ISSUE_KEY.test(key)) return refused('invalid-target');
        if (!writer.allowsIssue(key)) return refused('target-not-allowed');
        const wanted = draft.toStatus.trim();
        if (!isValidConnectorWriteText(wanted, ISSUE_TRANSITION_STATUS_MAX_LENGTH)) return refused('invalid-text');
        if (containsCredentialMaterial(wanted)) return refused('credential');
        // ADR-0112 amendment 3 (O5): the status the issue is in now, recorded so the transition can later be reverted (and sent
        // only while the issue is still in it). A writer without the read records nothing (that transition has no undo).
        let from: IssueStatusReadout | undefined;
        if (writer.readIssueStatus !== undefined) {
          try {
            from = await writer.readIssueStatus(key);
          } catch {
            return refused('transition-lookup-failed');
          }
          // Review round 1 (P3): an issue that answers under another key was moved: said as such, not as a lookup failure.
          if (from.issueKey !== key) return refused('target-changed');
          if (!isNumericId(from.statusId)) return refused('transition-lookup-failed');
          // Review round 1 (P3): the status name is stored and shown, so it gets the same credential check as `toStatus`.
          if (containsCredentialMaterial(from.statusName)) return refused('credential');
        }
        let options: readonly IssueTransitionOption[];
        try {
          options = await writer.listTransitions(key);
        } catch {
          return refused('transition-lookup-failed');
        }
        const match = matchTransition(options, wanted);
        if (!match) return refused('transition-unavailable', { availableStatuses: availableStatuses(options) });
        // Bind the resolved transition and its destination by id: names may later mean something else.
        if (!isNumericId(match.id) || !isNumericId(match.toStatusId)) return refused('transition-lookup-failed');
        const bound = {
          issueKey: key,
          transitionId: match.id,
          transitionName: match.name,
          toStatusId: match.toStatusId,
          toStatus: match.toStatus,
        };
        const recorded = from !== undefined ? { fromStatusId: from.statusId, fromStatus: boundStatusName(from.statusName) } : {};
        return this.propose(
          input,
          family,
          writer.source,
          key,
          { operation: 'ISSUE_TRANSITION', ...bound, ...recorded },
          { operation: 'ISSUE_TRANSITION', ...bound, ...recorded },
        );
      }
      case 'channel-post': {
        const writer = this.deps.writers.channelMessages as ChannelMessageWriter;
        const channelId = writer.resolveChannel(draft.channel);
        if (channelId === undefined) return refused('target-not-allowed');
        const textRefusal = checkOwnerText(draft.text, CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH);
        if (textRefusal) return refused(textRefusal);
        const label = draft.channel.startsWith('#') ? draft.channel.slice(1) : draft.channel;
        return this.propose(
          input,
          family,
          writer.source,
          channelId,
          { operation: 'CHANNEL_POST', channel: channelId, text: draft.text },
          { operation: 'CHANNEL_POST', channelLabel: label, channelId, text: draft.text },
        );
      }
      case 'calendar-create': {
        const writer = this.deps.writers.calendarEvents as CalendarEventWriter;
        const eventRefusal = checkEventDraft(draft.event);
        if (eventRefusal) return refused(eventRefusal);
        return this.propose(
          input,
          family,
          writer.source,
          writer.target,
          { operation: 'CALENDAR_EVENT_CREATE', draft: draft.event },
          { operation: 'CALENDAR_EVENT_CREATE', event: draft.event, timeZone: this.deps.timeZone },
        );
      }
      case 'calendar-create-undo':
        return this.proposeCalendarCreateUndo(input, draft.receiptId);
      case 'calendar-update-undo':
        return this.proposeCalendarUpdateUndo(input, draft.receiptId);
      case 'calendar-delete-undo':
        return this.proposeCalendarDeleteUndo(input, draft.receiptId);
      case 'jira-comment-undo':
        return this.proposeJiraCommentUndo(input, draft.receiptId);
      case 'jira-transition-undo':
        return this.proposeJiraTransitionUndo(input, draft.receiptId);
      case 'calendar-update':
      case 'calendar-delete': {
        const changes = draft.kind === 'calendar-update' ? draft.changes : undefined;
        if (changes && changes.moveTo === undefined && changes.title === undefined && changes.location === undefined) {
          return refused('no-change');
        }
        const mode = draft.kind === 'calendar-update' ? 'update' : 'delete';
        const vagueRef = draft.ref.startTime === undefined && draft.ref.titleWords.length === 0;
        if (draft.ref.inferredDay === true) {
          // No day named (live QA D2): the session's most recent calendar context, never today's events by default.
          // Whatever it yields is always a numbered choice — an event the owner did not reference is never targeted.
          let contextual: { basis: ConnectorWriteChoiceBasis; candidates: ConnectorWriteEventSummary[] } | null;
          try {
            contextual = await this.contextualCandidates(input, draft.ref);
          } catch {
            return refused('calendar-read-failed');
          }
          if (contextual && contextual.candidates.length > CONNECTOR_WRITE_MAX_CHOICES) return refused('too-many-events');
          if (contextual) {
            return this.offerChoice(
              input,
              { mode, reference: draft.ref, candidates: contextual.candidates, ...(changes ? { changes } : {}) },
              contextual.basis,
            );
          }
          // No context: today and tomorrow, filtered by the time of day and title words the owner gave (Codex P2:
          // "9시 회의 취소해줘" finds tomorrow's 09:00 meeting too), still as a numbered choice.
          let nearby: ConnectorWriteEventSummary[];
          try {
            nearby = await this.nearbyCandidates(input.now, draft.ref);
          } catch {
            return refused('calendar-read-failed');
          }
          if (nearby.length === 0) return refused(vagueRef ? 'no-nearby-events' : 'event-not-found');
          return this.offerChoice(input, { mode, reference: draft.ref, candidates: nearby, ...(changes ? { changes } : {}) }, 'nearby');
        }
        let events: readonly CalendarEvent[];
        try {
          events = await this.readDay(draft.ref);
        } catch {
          return refused('calendar-read-failed');
        }
        const candidates = matchReference(events, draft.ref, this.deps.timeZone).map(summaryOf);
        if (candidates.length === 0) return refused('event-not-found');
        if (candidates.length > CONNECTOR_WRITE_MAX_CHOICES) return refused('too-many-events');
        // Never guess: several matches, a reference with neither a start time nor a title (a whole day), or a day the
        // owner did not name, is a numbered choice even with one candidate.
        if (candidates.length > 1 || vagueRef || draft.ref.inferredDay === true) {
          return this.offerChoice(input, {
            mode,
            reference: draft.ref,
            candidates,
            ...(changes ? { changes } : {}),
          });
        }
        return this.proposeEventChange(input, mode, candidates[0] as ConnectorWriteEventSummary, changes);
      }
    }
  }

  // ── choice (next turn only) ────────────────────────────────────────────────────────────────────────────────────

  async choose(input: FlowInput & { readonly view: ConnectorWriteAnchorView; readonly index: number }): Promise<ConnectorWriteStep> {
    const { anchor } = input.view;
    const choice = anchor.choice;
    if (anchor.status !== 'AWAITING_CHOICE' || !choice) return { kind: 'refused', reason: 'invalid-choice', family: anchor.family };
    if (!this.bound(input.view, input)) return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    // The candidates were read at listing time; past the lifetime they may no longer match the live calendar.
    if (isConnectorWriteAnchorLapsed(anchor, input.now)) {
      await this.close(input.session, input.view, 'expired', input.now);
      return { kind: 'refused', reason: 'choice-expired', family: anchor.family };
    }
    if (choice.mode === 'transition-revert') return this.chooseRevert(input, choice);
    const picked = choice.candidates[input.index - 1];
    if (!Number.isInteger(input.index) || picked === undefined) {
      return { kind: 'refused', reason: 'invalid-choice', family: anchor.family };
    }
    // The proposal's anchor displaces (and supersedes) this choice anchor; any other result releases it.
    const step = await this.proposeEventChange(input, choice.mode, picked, choice.changes);
    if (step.kind !== 'preview') await this.close(input.session, input.view, 'abandoned', input.now);
    return step;
  }

  // ── approval recorded by the runtime (it calls ApprovalManager.decide after its expiry re-check) ──────────────

  async recordApproval(input: FlowInput & { readonly view: ConnectorWriteAnchorView }): Promise<ConnectorWriteStep> {
    const { anchor, taskId } = input.view;
    if (anchor.status !== 'APPROVAL_PENDING' || !anchor.operation || !this.bound(input.view, input)) {
      return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    }
    await this.saveAnchor(
      taskId,
      input.session,
      { ...anchor, status: 'APPROVED', approvedAt: input.now, approvedBy: input.actor.id, updatedAt: input.now },
      {},
      input.held,
    );
    return {
      kind: 'approved',
      operation: anchor.operation,
      executionPhrase: documentedExecutionPhrase(connectorWriteExecutionGate(anchor.operation)),
    };
  }

  // ── execute: exactly the approved payload, once ────────────────────────────────────────────────────────────────

  async execute(input: ConnectorWriteExecuteInput): Promise<ConnectorWriteStep> {
    const { anchor, taskId } = input.view;
    const operation = anchor.operation;
    if (!operation) return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    if (anchor.status === 'EXECUTING' || anchor.status === 'SENT' || anchor.status === 'NOT_SENT' || anchor.status === 'UNCERTAIN') {
      return repeatOf(anchor, operation);
    }
    if (anchor.status !== 'APPROVED') return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    // Only the actor who asked (in the session it was asked in) may execute; anyone else is refused and the owner's
    // grant stays as it is (like a non-owner decision on a pending approval, which only re-prompts).
    if (!this.bound(input.view, input)) return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    // Codex P1 on 55c5a2f: validation and the consume run in ONE critical section shared with a revocation (the caller's
    // approval → session locks; the session lock alone without one), on the LIVE anchor and approval — so exactly one of
    // "execute" and "거절/취소" wins. The send itself runs after the section is released.
    const claim =
      input.claim ?? (<T>(work: (held: SessionLockHold) => Promise<T>) => this.sessionLock.run(input.session.id, work, input.held));
    const claimed = await claim((held) => this.claimGrant(input, operation, held));
    if ('step' in claimed) return claimed.step;
    const { consumed, send, approvalId, connector, target, payloadSha256, preview, undoes } = claimed;
    await this.reconcileOnce(input.now);
    const executor = new ConnectorWriteExecutor({ receipts: this.deps.receipts, now: () => input.now, newId: this.deps.newId });
    let outcome: ConnectorWriteOutcome;
    let receiptId: Id | undefined;
    // Whether the writer was ever called: the executor validates the request and writes the PREPARED receipt first,
    // so a throw before this flips is provably "nothing was sent".
    let sendStarted = false;
    const sendOnce = async (): Promise<ConnectorWriteOutcome> => {
      // ADR-0122 D2.5 (Codex): once more after the receipt was prepared and immediately before the writer is called; a
      // refusal completes the prepared receipt NOT_SENT and the writer is never called.
      if (input.beforeSend !== undefined) {
        try {
          await input.beforeSend();
        } catch {
          return connectorWriteNotSent('REJECTED');
        }
      }
      sendStarted = true;
      return send();
    };
    try {
      // ADR-0122 D2.5: the last check before the request is prepared and the writer called; a refusal here is provably
      // nothing sent (NOT_SENT, no receipt).
      if (input.beforeSend !== undefined) await input.beforeSend();
      const result = await executor.executeOnce(
        { actorId: input.actor.id, idempotencyKey: `cwr:${approvalId}`, connector, operation, target, payloadSha256, ...(undoes !== undefined ? { undoes } : {}) },
        sendOnce,
      );
      receiptId = result.receipt?.id;
      if (!result.executed) {
        // A receipt already existed for this approval: nothing was sent now (whatever its status).
        const status = result.receipt.status === 'PREPARED' ? 'UNCERTAIN' : result.receipt.status;
        outcome =
          status === 'SENT'
            ? { status: 'SENT', externalRef: result.receipt.data.externalRef ?? '-', ...(result.receipt.data.url ? { url: result.receipt.data.url } : {}) }
            : status === 'NOT_SENT'
              ? { status: 'NOT_SENT', reason: 'REJECTED', retryable: false }
              : connectorWriteUncertain('UNKNOWN');
      } else {
        outcome = result.outcome;
      }
    } catch (error) {
      // Before the writer was called (an invalid request, or the PREPARED receipt could not be written) nothing left:
      // NOT_SENT. After it (recording the outcome failed) the request may have left: UNCERTAIN, never retried.
      this.log('warn', 'connector_write.execute_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
        sendStarted,
      });
      outcome = sendStarted
        ? connectorWriteUncertain('UNKNOWN')
        : connectorWriteNotSent(error instanceof ConnectorWriteRequestError ? 'INVALID_REQUEST' : 'UNAVAILABLE');
    }
    const terminal: ConnectorWriteAnchor = {
      ...consumed,
      status: outcome.status,
      outcome:
        outcome.status === 'SENT'
          ? { status: 'SENT', externalRef: outcome.externalRef, ...(outcome.url ? { url: outcome.url } : {}) }
          : { status: outcome.status, reason: outcome.reason },
      updatedAt: input.now,
    };
    try {
      await this.saveAnchor(taskId, input.session, terminal, { restorePointer: true });
    } catch (error) {
      this.log('warn', 'connector_write.outcome_save_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
    this.log('info', 'connector_write.executed', { operation, status: outcome.status });
    return { kind: 'outcome', operation, outcome, preview, ...(receiptId !== undefined ? { receiptId } : {}) };
  }

  /**
   * Inside the claim section: re-read the anchor and the approval, re-prove the binding and consume the grant (EXECUTING)
   * — or say truthfully why it cannot run (revoked / expired / already started / inconsistent). Never sends.
   */
  private async claimGrant(
    input: ConnectorWriteExecuteInput,
    operation: ConnectorWriteOperation,
    held: SessionLockHold,
  ): Promise<
    | { readonly step: ConnectorWriteStep }
    | {
        readonly consumed: ConnectorWriteAnchor;
        readonly send: () => Promise<ConnectorWriteOutcome>;
        readonly approvalId: Id;
        readonly connector: string;
        readonly target: string;
        readonly payloadSha256: string;
        readonly preview: ConnectorWritePreview;
        /** Review round 1 (P2-C): the receipt an undo inverts (checked equal to `undoOf.receiptId` above), for its receipt. */
        readonly undoes?: Id;
      }
  > {
    const { taskId } = input.view;
    const task = await this.deps.store.tasks.get(taskId);
    const anchor = task?.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
    const family = input.view.anchor.family;
    if (!anchor || anchor.kind !== CONNECTOR_WRITE_ANCHOR_KIND || anchor.operation !== operation) {
      return { step: { kind: 'refused', reason: 'binding-mismatch', family } };
    }
    const view: ConnectorWriteAnchorView = { ...input.view, anchor };
    if (anchor.status === 'CLOSED') {
      const reason: ConnectorWriteRefusal =
        anchor.closedReason === 'denied' || anchor.closedReason === 'cancelled' || anchor.closedReason === 'stopped'
          ? 'grant-revoked'
          : anchor.closedReason === 'expired'
            ? 'grant-expired'
            : 'binding-mismatch';
      return { step: { kind: 'refused', reason, family } };
    }
    if (anchor.consumedAt || anchor.status !== 'APPROVED') {
      return { step: anchor.status === 'APPROVED' || anchor.status === 'APPROVAL_PENDING' || anchor.status === 'AWAITING_CHOICE'
        ? { kind: 'refused', reason: 'binding-mismatch', family }
        : repeatOf(anchor, operation) };
    }
    const { payload, payloadSha256, target, connector, approvalId, preview } = anchor;
    if (!payload || !payloadSha256 || !target || !connector || !approvalId || !preview) {
      await this.close(input.session, view, 'inconsistent', input.now, held);
      return { step: { kind: 'refused', reason: 'binding-mismatch', family } };
    }
    // The grant lives as long as a pending approval does (ADR-0093), counted from the approval decision.
    if (isConnectorWriteAnchorLapsed(anchor, input.now)) {
      await this.close(input.session, view, 'expired', input.now, held);
      return { step: { kind: 'refused', reason: 'grant-expired', family } };
    }
    // Re-prove the binding: the approval is this request's CRITICAL approval, APPROVED, with the same reason; the
    // anchored payload still hashes to the bound hash; the target is still allowed and the text still clean.
    const approval = await this.deps.approvals.get(approvalId);
    if (approval?.status === ApprovalStatus.REJECTED) {
      // Withdrawn (D12) without the anchor being closed yet: it never runs.
      await this.close(input.session, view, 'cancelled', input.now, held);
      return { step: { kind: 'refused', reason: 'grant-revoked', family } };
    }
    const expectedReason = connectorWriteApprovalReason(operation, target, payloadSha256);
    if (
      !approval ||
      approval.status !== ApprovalStatus.APPROVED ||
      approval.riskLevel !== RiskLevel.CRITICAL ||
      approval.reason !== expectedReason ||
      payload.operation !== operation ||
      connectorWritePayloadSha256(operation, target, sendableOf(payload)) !== payloadSha256 ||
      !this.stillAllowed(payload) ||
      // A restore is only ever the undo of this actor's own approved delete: without that link it never runs.
      (payload.operation === 'CALENDAR_EVENT_RESTORE' && anchor.undoOf?.family !== 'calendar-delete') ||
      // An undo is bound to the ONE source receipt it undoes (restore-duplicate fix): the payload's `undoes` and the anchor's
      // link must name the same receipt; an undo anchor without it (or a plain write carrying one) never runs.
      !undoBindingHolds(anchor, payload)
    ) {
      await this.close(input.session, view, 'inconsistent', input.now, held);
      return { step: { kind: 'refused', reason: 'binding-mismatch', family } };
    }
    // Review round 2: an update undo never trusts the inverse its proposal persisted. It is re-derived here from the undone
    // update's own anchor (lossless markers included) and must equal the payload exactly; otherwise nothing is sent.
    if (payload.operation === 'CALENDAR_EVENT_UPDATE' && anchor.undoOf !== undefined && !(await this.isExactUpdateInverse(anchor, payload))) {
      await this.close(input.session, view, 'inconsistent', input.now, held);
      return { step: { kind: 'refused', reason: 'undo-unavailable', family, undo: 'calendar-update' } };
    }
    // ADR-0112 amendment 3 (O4/O5): the Jira undos likewise never trust their persisted payload: it is re-derived from the undone
    // write's own anchor and receipt (`undoOf.sourceTaskId`, `undoOf.receiptId`) and must match exactly, or nothing is sent.
    if ((payload.operation === 'ISSUE_COMMENT_DELETE' || payload.operation === 'ISSUE_TRANSITION_REVERT') && !(await this.isExactJiraInverse(anchor, payload))) {
      await this.close(input.session, view, 'inconsistent', input.now, held);
      return { step: { kind: 'refused', reason: 'undo-unavailable', family, undo: payload.operation === 'ISSUE_COMMENT_DELETE' ? 'jira-comment' : 'jira-transition' } };
    }
    const send = this.sendFor(payload, `cwr:${approvalId}`);
    if (!send) {
      await this.close(input.session, view, 'inconsistent', input.now, held);
      return { step: { kind: 'writes-off' } };
    }
    // Consume the grant BEFORE anything leaves: a failed save sends nothing; a crash after it leaves EXECUTING,
    // which a repeated phrase reports and never re-sends.
    const consumed: ConnectorWriteAnchor = { ...anchor, status: 'EXECUTING', consumedAt: input.now, updatedAt: input.now };
    await this.saveAnchor(taskId, input.session, consumed, { keepPointer: true }, held);
    const undoes = 'undoes' in payload ? payload.undoes : undefined;
    return { consumed, send, approvalId, connector, target, payloadSha256, preview, ...(undoes !== undefined ? { undoes } : {}) };
  }

  async close(
    session: Session,
    view: ConnectorWriteAnchorView,
    reason: ConnectorWriteCloseReason,
    now: IsoTimestamp,
    held?: SessionLockHold,
  ): Promise<void> {
    await this.saveAnchor(
      view.taskId,
      session,
      { ...view.anchor, status: 'CLOSED', closedReason: reason, updatedAt: now },
      { restorePointer: true },
      held,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────

  private bound(view: ConnectorWriteAnchorView, input: FlowInput): boolean {
    return view.anchor.actorId === input.actor.id && view.anchor.sessionId === input.session.id;
  }

  private stillAllowed(payload: ConnectorWritePayload): boolean {
    switch (payload.operation) {
      case 'ISSUE_COMMENT':
        return (
          this.deps.writers.issueComments?.allowsIssue(payload.issueKey) === true &&
          checkOwnerText(payload.text, CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH) === null
        );
      case 'ISSUE_TRANSITION':
        // An anchor without the bound ids (approved before ids were bound) can never run.
        return (
          this.deps.writers.issueTransitions?.allowsIssue(payload.issueKey) === true &&
          isNumericId(payload.transitionId) &&
          isNumericId(payload.toStatusId) &&
          (payload.fromStatusId === undefined || isNumericId(payload.fromStatusId)) &&
          !containsCredentialMaterial(payload.toStatus) &&
          (payload.fromStatus === undefined || !containsCredentialMaterial(payload.fromStatus))
        );
      case 'ISSUE_COMMENT_DELETE':
        return (
          this.deps.writers.issueComments?.deleteComment !== undefined &&
          this.deps.writers.issueComments.allowsIssue(payload.issueKey) &&
          isNumericId(payload.commentId) &&
          isEventVersion(payload.expected?.version)
        );
      case 'ISSUE_TRANSITION_REVERT':
        return (
          this.deps.writers.issueTransitions?.allowsIssue(payload.issueKey) === true &&
          isNumericId(payload.transitionId) &&
          isNumericId(payload.toStatusId) &&
          isNumericId(payload.fromStatusId) &&
          !containsCredentialMaterial(payload.toStatus)
        );
      case 'CHANNEL_POST':
        return (
          this.deps.writers.channelMessages?.resolveChannel(payload.channel) === payload.channel &&
          checkOwnerText(payload.text, CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH) === null
        );
      case 'CALENDAR_EVENT_CREATE':
        return this.deps.writers.calendarEvents !== undefined && checkEventDraft(payload.draft) === null;
      case 'CALENDAR_EVENT_UPDATE':
        return this.deps.writers.calendarEvents !== undefined && isExpectation(payload.expected) && checkChanges(payload.changes) === null;
      case 'CALENDAR_EVENT_DELETE':
        return this.deps.writers.calendarEvents !== undefined && isExpectation(payload.expected);
      case 'CALENDAR_EVENT_RESTORE':
        return this.deps.writers.calendarEvents !== undefined && isRestoreExpectation(payload.expected);
    }
  }

  /** The single writer call for the exact payload. */
  private sendFor(payload: ConnectorWritePayload, idempotencyKey: string): (() => Promise<ConnectorWriteOutcome>) | null {
    const { issueComments, issueTransitions, channelMessages, calendarEvents } = this.deps.writers;
    switch (payload.operation) {
      case 'ISSUE_COMMENT':
        return issueComments ? () => issueComments.addComment({ issueKey: payload.issueKey, text: payload.text }) : null;
      case 'ISSUE_TRANSITION':
        return issueTransitions
          ? () =>
              issueTransitions.transition({
                issueKey: payload.issueKey,
                transitionId: payload.transitionId,
                toStatusId: payload.toStatusId,
                ...(payload.fromStatusId !== undefined ? { fromStatusId: payload.fromStatusId } : {}),
              })
          : null;
      case 'ISSUE_COMMENT_DELETE': {
        const remove = issueComments?.deleteComment?.bind(issueComments);
        return remove ? () => remove({ issueKey: payload.issueKey, commentId: payload.commentId, expected: { version: payload.expected.version } }) : null;
      }
      case 'ISSUE_TRANSITION_REVERT':
        // Compare-and-set: the writer sends it only while the issue is still in the status Quoky moved it to.
        return issueTransitions
          ? () =>
              issueTransitions.transition({
                issueKey: payload.issueKey,
                transitionId: payload.transitionId,
                toStatusId: payload.toStatusId,
                fromStatusId: payload.fromStatusId,
              })
          : null;
      case 'CHANNEL_POST':
        return channelMessages ? () => channelMessages.post({ channel: payload.channel, text: payload.text }) : null;
      case 'CALENDAR_EVENT_CREATE':
        return calendarEvents ? () => calendarEvents.createEvent({ draft: payload.draft, idempotencyKey }) : null;
      // An approved update / delete without a usable bound version (an anchor from before versions were required) is
      // recorded NOT_SENT('TARGET_CHANGED') without calling the writer: it is never sent unconditionally.
      case 'CALENDAR_EVENT_UPDATE':
        if (!calendarEvents) return null;
        if (!isEventVersion(payload.expected.version)) return async () => connectorWriteNotSent('TARGET_CHANGED');
        return () => calendarEvents.updateEvent({ eventId: payload.eventId, expected: payload.expected, changes: payload.changes });
      case 'CALENDAR_EVENT_DELETE':
        if (!calendarEvents) return null;
        if (!isEventVersion(payload.expected.version)) return async () => connectorWriteNotSent('TARGET_CHANGED');
        return () => calendarEvents.deleteEvent({ eventId: payload.eventId, expected: payload.expected });
      case 'CALENDAR_EVENT_RESTORE':
        return calendarEvents ? () => calendarEvents.restoreEvent({ eventId: payload.eventId, expected: payload.expected }) : null;
    }
  }

  /** Startup reconciliation (ADR-0112 D3), once per process, before the first write. */
  private reconcileOnce(now: IsoTimestamp): Promise<void> {
    this.reconciled ??= this.deps.receipts
      .markInterruptedPreparedUncertain(now)
      .then((count) => {
        if (count > 0) this.log('warn', 'connector_write.interrupted_receipts', { count });
      })
      .catch((error: unknown) => {
        this.reconciled = null; // retried before the next write; the write itself still runs at most once
        this.log('warn', 'connector_write.reconcile_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      });
    return this.reconciled;
  }

  private readDay(ref: CalendarEventReference): Promise<readonly CalendarEvent[]> {
    return this.readWindow(ref.window);
  }

  /**
   * The candidates of an undated reference from the session's most recent calendar context (live QA D2): the event
   * this session just created or changed (its SENT anchor, within the ADR-0093 lifetime) or the list the calendar
   * handler last showed here (`ref.recentListing`, likewise bounded), whichever is newer; an older context is tried
   * when the newer one has no event left. Each is re-read live and filtered by the reference's time of day and title
   * words. Null when no context yields an event.
   */
  private async contextualCandidates(
    input: FlowInput,
    ref: CalendarEventReference,
  ): Promise<{ basis: ConnectorWriteChoiceBasis; candidates: ConnectorWriteEventSummary[] } | null> {
    const nowMs = Date.parse(input.now);
    const fresh = (at: string): boolean => {
      const ms = Date.parse(at);
      return Number.isFinite(ms) && Number.isFinite(nowMs) && nowMs - ms >= 0 && nowMs - ms < PENDING_APPROVAL_TTL_MS;
    };
    const contexts: Array<{ basis: ConnectorWriteChoiceBasis; at: string; window: { from: IsoTimestamp; to: IsoTimestamp }; ids: readonly string[] }> = [];
    const listing = ref.recentListing;
    if (listing && listing.eventIds.length > 0 && fresh(listing.at)) {
      contexts.push({ basis: 'listed', at: listing.at, window: listing.window, ids: listing.eventIds });
    }
    const written = await this.recentCalendarWrite(input);
    if (written && fresh(written.at)) contexts.push({ basis: 'written', ...written, ids: [written.eventId] });
    contexts.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    for (const context of contexts) {
      const events = await this.readWindow(context.window);
      const byId = new Map(events.map((event) => [event.id, event]));
      const candidates = context.ids
        .map((id) => byId.get(id))
        .filter((event): event is CalendarEvent => event !== undefined)
        .filter((event) => matchesTimeAndTitle(event, ref, this.deps.timeZone))
        .map(summaryOf);
      if (candidates.length > 0) return { basis: context.basis, candidates };
    }
    return null;
  }

  /** The event this session's newest SENT create / update anchor wrote, and the day window it is on. */
  private async recentCalendarWrite(
    input: FlowInput,
  ): Promise<{ at: string; eventId: string; window: { from: IsoTimestamp; to: IsoTimestamp } } | null> {
    const tasks = await this.deps.store.tasks.listByContext(input.session.context.channelId, input.session.context.threadId);
    let best: { at: string; eventId: string; window: { from: IsoTimestamp; to: IsoTimestamp } } | null = null;
    for (const task of tasks) {
      if (task.planId) continue;
      const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
      if (anchor?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || anchor.sessionId !== input.session.id || anchor.actorId !== input.actor.id) continue;
      if (anchor.status !== 'SENT' || anchor.outcome?.status !== 'SENT' || !anchor.preview) continue;
      let eventId: string | undefined;
      let time: CalendarEventTime | undefined;
      if (anchor.preview.operation === 'CALENDAR_EVENT_CREATE') {
        eventId = anchor.outcome.externalRef;
        time = anchor.preview.event.time;
      } else if (anchor.preview.operation === 'CALENDAR_EVENT_UPDATE' && anchor.payload?.operation === 'CALENDAR_EVENT_UPDATE') {
        eventId = anchor.payload.eventId;
        time = anchor.preview.after.time;
      }
      if (!eventId || !time) continue;
      const day = localDayOf(time, this.deps.timeZone);
      if (!day) continue;
      if (best && anchor.updatedAt <= best.at) continue;
      const window = calendarWindowForDays(day, 1, this.deps.timeZone);
      best = { at: anchor.updatedAt, eventId, window: { from: window.from, to: window.to } };
    }
    return best;
  }

  /**
   * Today's and tomorrow's events matching the reference's time of day and title words (start order, at most
   * {@link CONNECTOR_WRITE_MAX_CHOICES}) for an undated choice.
   */
  private async nearbyCandidates(now: IsoTimestamp, ref: CalendarEventReference): Promise<ConnectorWriteEventSummary[]> {
    const today = localDateOf(Date.parse(now), this.deps.timeZone);
    const window = calendarWindowForDays(today, CONNECTOR_WRITE_NEARBY_DAYS, this.deps.timeZone);
    const events = await this.readWindow({ from: window.from, to: window.to });
    return events
      .filter((event) => matchesTimeAndTitle(event, ref, this.deps.timeZone))
      .map((event) => ({ event, startMs: eventStartMs(event, this.deps.timeZone) }))
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, CONNECTOR_WRITE_MAX_CHOICES)
      .map(({ event }) => summaryOf(event));
  }

  private async readWindow(window: { readonly from: IsoTimestamp; readonly to: IsoTimestamp }): Promise<readonly CalendarEvent[]> {
    const reader = this.deps.calendarReader;
    if (!reader) throw new Error('no calendar reader');
    return this.withReadTimeout(reader.listEvents({ from: window.from, to: window.to, limit: CALENDAR_EVENTS_MAX_LIMIT }));
  }

  private async withReadTimeout<T>(read: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadTimeout()), this.deps.readTimeoutMs ?? 30_000);
    });
    try {
      return await Promise.race([read, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * ADR-0112 amendment 1 S9 / amendment 3: the undo of an NL-created event. The draft carries a receipt id only; the
   * resolver proves it is this session's own last write (same actor, SENT, same session's anchor). The event id comes from
   * that receipt, never from text. The event must still be exactly what Quoky wrote: the version, the title and the time
   * equal the receipt and the approved draft, else nothing is proposed. The delete itself is the existing
   * `CALENDAR_EVENT_DELETE` flow with `If-Match` on Quoky's own post-create version.
   */
  private async proposeCalendarCreateUndo(input: FlowInput, receiptId: Id): Promise<ConnectorWriteStep> {
    const writer = this.deps.writers.calendarEvents;
    if (!writer) return { kind: 'writes-off' };
    const refused = (reason: ConnectorWriteRefusal): ConnectorWriteStep => ({ kind: 'refused', reason, family: 'calendar' });
    const resolved = await this.resolveOwnUndo(input, 'calendar-create', receiptId);
    if (resolved.kind === 'refused') return refused(resolved.reason);
    const created = resolved.anchor.payload;
    const version = resolved.receipt.data.version;
    if (created?.operation !== 'CALENDAR_EVENT_CREATE') return refused('undo-nothing');
    // No version on the create (no etag) means no compare-and-set: it cannot be undone safely.
    if (!isEventVersion(version)) return refused('undo-unavailable');
    // The calendar and the event come from the receipt (ARCHITECTURE section 8 provenance), never from a read or the words.
    const calendarId = resolved.receipt.target;
    if (calendarId !== writer.target) return refused('undo-nothing');
    const eventId = resolved.receipt.data.externalRef as string;
    const read = await this.readOwnEvent(calendarId, eventId);
    if (read.kind === 'refused') return refused(read.reason);
    const event = read.event;
    if (event === undefined) return refused('undo-event-gone');
    if (event.id !== eventId || event.version !== version || !sameAsDraft(event, created.draft)) return refused('undo-event-changed');
    const summary = summaryOf(event);
    const expected: CalendarEventExpectation = { allDay: event.allDay, start: event.start, end: event.end, version };
    return this.propose(
      input,
      'calendar',
      writer.source,
      `${writer.target}/${eventId}`,
      { operation: 'CALENDAR_EVENT_DELETE', eventId, expected, undoes: resolved.receipt.id },
      {
        operation: 'CALENDAR_EVENT_DELETE',
        before: summary,
        timeZone: this.deps.timeZone,
        receiptSourced: true,
        ...ownerSentenceOf(input.ownerText),
      },
      undefined,
      { entryId: 'calendar.create', receiptId: resolved.receipt.id },
    );
  }

  /**
   * ADR-0112 amendment 3 (O2): the undo of an approved calendar update. The draft carries a receipt id only; the resolver proves
   * it is this session's own last write. The inverse PATCHes back ONLY the fields the update changed, to the values its preview
   * showed (`preview.before`), as compare-and-set on Quoky's own post-update version (the update receipt's `version`, sent as
   * `If-Match` by the writer). The event must still be exactly what the update left (version, title, time, location), else
   * nothing is proposed (`undo-event-changed`); a field whose old value cannot be written back (an empty title, a location or
   * description the event did not have) makes the whole undo unavailable (fail closed, never a partial inverse).
   */
  private async proposeCalendarUpdateUndo(input: FlowInput, receiptId: Id): Promise<ConnectorWriteStep> {
    const writer = this.deps.writers.calendarEvents;
    if (!writer) return { kind: 'writes-off' };
    const refused = (reason: ConnectorWriteRefusal): ConnectorWriteStep => ({ kind: 'refused', reason, family: 'calendar', undo: 'calendar-update' });
    const resolved = await this.resolveOwnUndo(input, 'calendar-update', receiptId);
    if (resolved.kind === 'refused') return refused(resolved.reason);
    const updated = resolved.anchor.payload;
    const shown = resolved.anchor.preview;
    if (updated?.operation !== 'CALENDAR_EVENT_UPDATE' || shown?.operation !== 'CALENDAR_EVENT_UPDATE') return refused('undo-nothing');
    // An undo of an undo is never offered (the resolver refuses `action.undo` records); an update that itself carried a receipt
    // banner was an undo and is never undone again.
    if (shown.receiptSourced === true || resolved.anchor.undoOf !== undefined) return refused('undo-nothing');
    const eventId = resolved.receipt.data.externalRef as string;
    // The event comes from the receipt and must be the one the approved payload named, on the writer's calendar.
    if (eventId !== updated.eventId || resolved.receipt.target !== `${writer.target}/${eventId}` || shown.before.id !== eventId) {
      return refused('undo-nothing');
    }
    const version = resolved.receipt.data.version;
    // No post-update version (no etag) means no compare-and-set: it cannot be undone safely.
    if (!isEventVersion(version)) return refused('undo-unavailable');
    const inverse = inverseChanges(updated.changes, shown.before);
    if (inverse === undefined) return refused('undo-unavailable');
    const read = await this.readOwnEvent(writer.target, eventId);
    if (read.kind === 'refused') return refused(read.reason);
    const event = read.event;
    if (event === undefined) return refused('undo-event-gone');
    if (event.id !== eventId || event.version !== version || !sameAsAfter(event, updated.changes, shown.after)) return refused('undo-event-changed');
    const expected: CalendarEventExpectation = { allDay: event.allDay, start: event.start, end: event.end, version };
    const now = summaryOf(event);
    const afterLocation = inverse.location ?? event.location;
    return this.propose(
      input,
      'calendar',
      writer.source,
      `${writer.target}/${eventId}`,
      { operation: 'CALENDAR_EVENT_UPDATE', eventId, expected, changes: inverse, undoes: resolved.receipt.id },
      {
        operation: 'CALENDAR_EVENT_UPDATE',
        before: now,
        after: {
          title: inverse.title ?? event.title,
          time: inverse.time ?? eventTimeOf(event, shown.timeZone),
          ...(afterLocation !== undefined ? { location: afterLocation } : {}),
        },
        timeZone: this.deps.timeZone,
        receiptSourced: true,
        ...ownerSentenceOf(input.ownerText),
      },
      undefined,
      { entryId: LAST_ACTION_EXTERNAL_ENTRY, receiptId: resolved.receipt.id, family: 'calendar-update', sourceTaskId: resolved.anchorTaskId },
    );
  }

  /**
   * ADR-0112 amendment 3 (O3/O6): the restore of an approved calendar delete. The draft carries a receipt id only; the resolver
   * proves it is this session's own last write. The SAME event id (from the delete receipt, never from text) is restored through
   * `CalendarEventWriter.restoreEvent`, never re-created as a copy. The delete's own bound expectation (all-day shape, start,
   * end) is what the writer checks the deleted event against; an event that is already on the calendar again is not restored.
   */
  private async proposeCalendarDeleteUndo(input: FlowInput, receiptId: Id): Promise<ConnectorWriteStep> {
    const writer = this.deps.writers.calendarEvents;
    if (!writer) return { kind: 'writes-off' };
    const refused = (reason: ConnectorWriteRefusal): ConnectorWriteStep => ({ kind: 'refused', reason, family: 'calendar', undo: 'calendar-delete' });
    const resolved = await this.resolveOwnUndo(input, 'calendar-delete', receiptId);
    if (resolved.kind === 'refused') return refused(resolved.reason);
    const deleted = resolved.anchor.payload;
    const shown = resolved.anchor.preview;
    if (deleted?.operation !== 'CALENDAR_EVENT_DELETE' || shown?.operation !== 'CALENDAR_EVENT_DELETE') return refused('undo-nothing');
    // The delete that undid a create is itself an undo: it is never undone again (no restore of an undo).
    if (shown.receiptSourced === true || resolved.anchor.undoOf !== undefined) return refused('undo-nothing');
    const eventId = resolved.receipt.data.externalRef as string;
    if (eventId !== deleted.eventId || resolved.receipt.target !== `${writer.target}/${eventId}` || shown.before.id !== eventId) {
      return refused('undo-nothing');
    }
    if (!isExpectation(deleted.expected)) return refused('undo-unavailable');
    const presence = await this.readOwnEventPresence(writer.target, eventId);
    if (presence.kind === 'refused') return refused(presence.reason);
    // A live event with that id is back already (restored or re-created); an id the calendar no longer knows (purged) cannot
    // be restored. Only an event the reader POSITIVELY reports as deleted, with this id, is offered.
    if (presence.kind === 'live') return refused('undo-event-present');
    if (presence.kind === 'absent') return refused('undo-event-gone');
    const expected: CalendarEventRestoreExpectation = {
      allDay: deleted.expected.allDay,
      start: deleted.expected.start,
      end: deleted.expected.end,
      title: shown.before.title,
    };
    const gone = presence.event;
    const sameShape = expected.allDay
      ? gone.allDay && gone.start === expected.start && gone.end === expected.end
      : !gone.allDay && Date.parse(gone.start) === Date.parse(expected.start) && Date.parse(gone.end) === Date.parse(expected.end);
    if (gone.id !== eventId || !sameShape || gone.title !== expected.title) return refused('undo-event-changed');
    return this.propose(
      input,
      'calendar',
      writer.source,
      `${writer.target}/${eventId}`,
      { operation: 'CALENDAR_EVENT_RESTORE', eventId, expected, undoes: resolved.receipt.id },
      {
        operation: 'CALENDAR_EVENT_RESTORE',
        before: shown.before,
        timeZone: this.deps.timeZone,
        receiptSourced: true,
        ...ownerSentenceOf(input.ownerText),
      },
      undefined,
      { entryId: LAST_ACTION_EXTERNAL_ENTRY, receiptId: resolved.receipt.id, family: 'calendar-delete' },
    );
  }

  /**
   * ADR-0112 amendment 3 (O4): the delete of the comment Quoky added. The draft carries a receipt id only; the resolver proves it is
   * this session's own last write. The issue and the comment come from that receipt (never from text, a link or a listing). The
   * comment must still be exactly what Quoky wrote: present, the version Quoky's own add returned, positively unedited; the delete
   * permission is read, never requested. Anything else proposes nothing.
   */
  private async proposeJiraCommentUndo(input: FlowInput, receiptId: Id): Promise<ConnectorWriteStep> {
    const writer = this.deps.writers.issueComments;
    if (!writer) return { kind: 'writes-off' };
    const refused = (reason: ConnectorWriteRefusal): ConnectorWriteStep => ({ kind: 'refused', reason, family: 'issue-comment', undo: 'jira-comment' });
    const resolved = await this.resolveOwnUndo(input, 'jira-comment', receiptId);
    if (resolved.kind === 'refused') return refused(resolved.reason);
    const added = resolved.anchor.payload;
    if (added?.operation !== 'ISSUE_COMMENT' || resolved.anchor.preview?.operation !== 'ISSUE_COMMENT') return refused('undo-nothing');
    // A comment Quoky added as an undo does not exist (an undo is never a comment), but the rule is kept structural.
    if (resolved.anchor.undoOf !== undefined) return refused('undo-nothing');
    const issueKey = added.issueKey;
    const commentId = resolved.receipt.data.externalRef as string;
    if (resolved.receipt.target !== issueKey || !CONNECTOR_WRITE_ISSUE_KEY.test(issueKey) || !isNumericId(commentId)) return refused('undo-nothing');
    if (!writer.allowsIssue(issueKey)) return refused('target-not-allowed');
    const version = resolved.receipt.data.version;
    // No version recorded at write time (a legacy receipt, or the provider gave none): unedited cannot be proven.
    if (!isEventVersion(version) || writer.inspectComment === undefined || writer.deleteComment === undefined) return refused('undo-unavailable');
    let state: IssueCommentState;
    try {
      state = await this.withReadTimeout(writer.inspectComment(issueKey, commentId));
    } catch {
      return refused('undo-read-failed');
    }
    if (state.kind === 'absent') return refused('undo-target-gone');
    if (state.kind === 'moved' || state.commentId !== commentId || state.unedited !== true || state.version !== version) return refused('undo-target-changed');
    if (state.deletable !== true) return refused('undo-not-permitted');
    return this.propose(
      input,
      'issue-comment',
      writer.source,
      `${issueKey}/${commentId}`,
      { operation: 'ISSUE_COMMENT_DELETE', issueKey, commentId, expected: { version }, undoes: resolved.receipt.id },
      { operation: 'ISSUE_COMMENT_DELETE', issueKey, commentId, text: added.text, receiptSourced: true, ...ownerSentenceOf(input.ownerText) },
      undefined,
      { entryId: LAST_ACTION_EXTERNAL_ENTRY, receiptId: resolved.receipt.id, family: 'jira-comment', sourceTaskId: resolved.anchorTaskId },
    );
  }

  /**
   * ADR-0112 amendment 3 (O5): the revert of Quoky's own transition, bound to the `fromStatusId` recorded with it. The issue must
   * still be in the status Quoky moved it to; the transitions the provider lists NOW that lead back to `fromStatusId` decide:
   * exactly one is previewed, several are a numbered choice (the owner's number only indexes this Core-listed set), none is said
   * plainly. `pick` is the owner's choice from such a list; it must still be listed, leading back, when the preview is built.
   */
  private async proposeJiraTransitionUndo(
    input: FlowInput,
    receiptId: Id,
    chosen: { readonly pick: IssueTransitionOption; readonly ownerSentence?: string; readonly sourceTaskId: Id } | undefined = undefined,
  ): Promise<ConnectorWriteStep> {
    const writer = this.deps.writers.issueTransitions;
    if (!writer) return { kind: 'writes-off' };
    const refused = (reason: ConnectorWriteRefusal): ConnectorWriteStep => ({ kind: 'refused', reason, family: 'issue-transition', undo: 'jira-transition' });
    // Review round 1 (P2-A): a pick continues the origin resolved (window included) when the choice was offered: the same
    // receipt and anchor pinned on the choice are re-validated, never re-resolved from `lastAction` recency.
    const resolved =
      chosen !== undefined
        ? await this.revalidateOwnUndo(input, 'jira-transition', receiptId, chosen.sourceTaskId)
        : await this.resolveOwnUndo(input, 'jira-transition', receiptId);
    if (resolved.kind === 'refused') return refused(resolved.reason);
    const moved = resolved.anchor.payload;
    if (moved?.operation !== 'ISSUE_TRANSITION' || resolved.anchor.preview?.operation !== 'ISSUE_TRANSITION' || resolved.anchor.undoOf !== undefined) {
      return refused('undo-nothing');
    }
    const issueKey = moved.issueKey;
    if (
      resolved.receipt.target !== issueKey ||
      resolved.receipt.data.externalRef !== `${issueKey}:${moved.transitionId}` ||
      !CONNECTOR_WRITE_ISSUE_KEY.test(issueKey) ||
      !isNumericId(moved.toStatusId)
    ) {
      return refused('undo-nothing');
    }
    if (!writer.allowsIssue(issueKey)) return refused('target-not-allowed');
    // A transition recorded without the status it left (legacy) has nothing to go back to.
    if (!isNumericId(moved.fromStatusId) || moved.fromStatusId === moved.toStatusId || writer.readIssueStatus === undefined) return refused('undo-unavailable');
    let now: IssueStatusReadout;
    let options: readonly IssueTransitionOption[];
    try {
      now = await this.withReadTimeout(writer.readIssueStatus(issueKey));
      if (now.issueKey !== issueKey || now.statusId !== moved.toStatusId) return refused('undo-target-changed');
      options = await this.withReadTimeout(writer.listTransitions(issueKey));
    } catch {
      return refused('undo-read-failed');
    }
    const back = transitionsLeadingTo(options, moved.fromStatusId);
    if (back.length === 0) return refused('undo-no-path');
    const ownerSentence = chosen !== undefined ? chosen.ownerSentence : boundedOwnerSentence(input.ownerText);
    const link = { entryId: LAST_ACTION_EXTERNAL_ENTRY, receiptId: resolved.receipt.id, family: 'jira-transition', sourceTaskId: resolved.anchorTaskId } as const;
    let pick: IssueTransitionOption | undefined;
    if (chosen !== undefined) {
      // The picked transition must still be listed now, with the same id and leading back to the same status.
      pick = back.find((option) => option.id === chosen.pick.id && option.toStatusId === chosen.pick.toStatusId);
      if (pick === undefined) return refused('undo-target-changed');
    } else if (back.length === 1) {
      pick = back[0];
    } else {
      return this.offerRevertChoice(input, issueKey, back, ownerSentence, link, { current: displayStatusName(now.statusName), to: displayStatusName(moved.fromStatus ?? '') });
    }
    const target = pick as IssueTransitionOption;
    return this.propose(
      input,
      'issue-transition',
      writer.source,
      issueKey,
      {
        operation: 'ISSUE_TRANSITION_REVERT',
        issueKey,
        transitionId: target.id,
        transitionName: target.name,
        toStatusId: moved.fromStatusId,
        toStatus: target.toStatus,
        fromStatusId: moved.toStatusId,
        undoes: resolved.receipt.id,
      },
      {
        operation: 'ISSUE_TRANSITION_REVERT',
        issueKey,
        currentStatus: displayStatusName(now.statusName),
        currentStatusId: now.statusId,
        toStatus: target.toStatus,
        toStatusId: moved.fromStatusId,
        transitionName: target.name,
        transitionId: target.id,
        receiptSourced: true,
        ...(ownerSentence !== undefined ? { ownerSentence } : {}),
      },
      undefined,
      link,
    );
  }

  /** O5: the owner's number on a revert choice. It only indexes the Core-listed transitions; the proposal re-reads everything. */
  private async chooseRevert(
    input: FlowInput & { readonly view: ConnectorWriteAnchorView; readonly index: number },
    choice: ConnectorWriteRevertChoice,
  ): Promise<ConnectorWriteStep> {
    const { anchor } = input.view;
    const picked = choice.transitions[input.index - 1];
    if (!Number.isInteger(input.index) || picked === undefined) {
      // Review round 1 (P2-B): a number outside the list ends the choice; a later number never reaches it.
      await this.close(input.session, input.view, 'abandoned', input.now);
      return { kind: 'refused', reason: 'invalid-choice', family: anchor.family, undo: 'jira-transition' };
    }
    const link = anchor.undoOf;
    if (link?.family !== 'jira-transition' || anchor.family !== 'issue-transition' || link.sourceTaskId === undefined) {
      await this.close(input.session, input.view, 'inconsistent', input.now);
      return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    }
    const step = await this.proposeJiraTransitionUndo(input, link.receiptId, {
      pick: picked,
      sourceTaskId: link.sourceTaskId,
      ...(choice.ownerSentence !== undefined ? { ownerSentence: choice.ownerSentence } : {}),
    });
    if (step.kind !== 'preview') await this.close(input.session, input.view, 'abandoned', input.now);
    return step;
  }

  /** O5: several transitions lead back: a numbered choice anchor (next turn only), governed by the kill switch like any undo. */
  private async offerRevertChoice(
    input: FlowInput,
    issueKey: string,
    transitions: readonly IssueTransitionOption[],
    ownerSentence: string | undefined,
    undoOf: NonNullable<ConnectorWriteAnchor['undoOf']>,
    names: { readonly current: string; readonly to: string },
  ): Promise<ConnectorWriteStep> {
    const previous = await this.displacedPointer(input.session);
    const anchor: ConnectorWriteAnchor = {
      kind: CONNECTOR_WRITE_ANCHOR_KIND,
      status: 'AWAITING_CHOICE',
      actorId: input.actor.id,
      sessionId: input.session.id,
      family: 'issue-transition',
      choice: { mode: 'transition-revert', issueKey, transitions, ...(ownerSentence !== undefined ? { ownerSentence } : {}) },
      createdAt: input.now,
      updatedAt: input.now,
      undoOf,
      ...(previous ? { previousActiveTaskId: previous } : {}),
    };
    await this.createAnchor(input.session, anchor, input.now, input.held);
    return {
      kind: 'revert-choice',
      issueKey,
      currentStatus: names.current,
      toStatus: names.to,
      transitions,
      ...(ownerSentence !== undefined ? { ownerSentence } : {}),
    };
  }

  /**
   * O4/O5 execution-time proof: the Jira undo anchor must name the undone write's anchor Task and receipt; that anchor must be this
   * actor's plain approved write whose approval produced the receipt (SENT, same connector, target and payload hash); and the
   * payload re-derived from them now must equal the approved one (issue, comment id and version / statuses).
   */
  private async isExactJiraInverse(
    anchor: ConnectorWriteAnchor,
    payload: Extract<ConnectorWritePayload, { operation: 'ISSUE_COMMENT_DELETE' | 'ISSUE_TRANSITION_REVERT' }>,
  ): Promise<boolean> {
    const comment = payload.operation === 'ISSUE_COMMENT_DELETE';
    const link = anchor.undoOf;
    if (link?.family !== (comment ? 'jira-comment' : 'jira-transition') || link.entryId !== LAST_ACTION_EXTERNAL_ENTRY || link.sourceTaskId === undefined) return false;
    const receipt = await this.deps.receipts.findById(link.receiptId, anchor.actorId);
    if (receipt === null || receipt.status !== 'SENT' || receipt.operation !== (comment ? 'ISSUE_COMMENT' : 'ISSUE_TRANSITION')) return false;
    const task = await this.deps.store.tasks.get(link.sourceTaskId);
    const source = task?.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
    if (source?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || source.actorId !== anchor.actorId || source.undoOf !== undefined || source.status !== 'SENT') return false;
    if (
      source.approvalId === undefined ||
      receipt.idempotencyKey !== `cwr:${source.approvalId}` ||
      receipt.payloadSha256 !== source.payloadSha256 ||
      receipt.target !== source.target ||
      receipt.connector !== source.connector ||
      receipt.connector !== anchor.connector
    ) {
      return false;
    }
    const written = source.payload;
    if (payload.operation === 'ISSUE_COMMENT_DELETE') {
      return (
        written?.operation === 'ISSUE_COMMENT' &&
        written.issueKey === payload.issueKey &&
        receipt.target === payload.issueKey &&
        receipt.data.externalRef === payload.commentId &&
        receipt.data.version === payload.expected.version &&
        anchor.target === `${payload.issueKey}/${payload.commentId}`
      );
    }
    return (
      written?.operation === 'ISSUE_TRANSITION' &&
      written.issueKey === payload.issueKey &&
      receipt.data.externalRef === `${written.issueKey}:${written.transitionId}` &&
      isNumericId(written.fromStatusId) &&
      payload.toStatusId === written.fromStatusId &&
      payload.fromStatusId === written.toStatusId &&
      anchor.target === payload.issueKey
    );
  }

  /** The resolver over the LIVE session row (the lastAction the owner's last turn left), narrowed to one family and receipt. */
  private async resolveOwnUndo(
    input: FlowInput,
    family: ExternalUndoFamily,
    receiptId: Id,
  ): Promise<Extract<ExternalUndoResolution, { kind: 'resolved' }> | { readonly kind: 'refused'; readonly reason: ConnectorWriteRefusal }> {
    const live = (await this.deps.store.sessions.get(input.session.id)) ?? input.session;
    const resolver = new ExternalUndoResolver({
      receipts: this.deps.receipts,
      tasks: this.deps.store.tasks,
      readAnchor: (task) => {
        const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
        return anchor?.kind === CONNECTOR_WRITE_ANCHOR_KIND ? anchor : undefined;
      },
    });
    const resolved = await resolver.resolve({
      session: live,
      actor: input.actor,
      now: input.now,
      ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
    });
    // The anchor that holds the approved payload and version could not be found (for example its save failed): the write
    // is real, but there is nothing safe to compare against, so the owner is told to fix it by hand.
    if (resolved.kind === 'nothing-to-undo' && resolved.reason === 'anchor-missing') return { kind: 'refused', reason: 'undo-unavailable' };
    if (resolved.kind !== 'resolved' || resolved.family !== family || resolved.draft.receiptId !== receiptId) {
      return { kind: 'refused', reason: 'undo-nothing' };
    }
    return resolved;
  }

  /**
   * Review round 1 (P2-A): re-validates the origin pinned on an undo choice (receipt and anchor resolved when the choice was
   * offered): still this actor's own SENT write in this session with the same approval binding, the family still open, and
   * not undone since (no SENT undo receipt names it). `lastAction` recency is not re-read.
   */
  private async revalidateOwnUndo(
    input: FlowInput,
    family: ExternalUndoFamily,
    receiptId: Id,
    anchorTaskId: Id,
  ): Promise<Extract<ExternalUndoResolution, { kind: 'resolved' }> | { readonly kind: 'refused'; readonly reason: ConnectorWriteRefusal }> {
    const resolver = new ExternalUndoResolver({
      receipts: this.deps.receipts,
      tasks: this.deps.store.tasks,
      readAnchor: (task) => {
        const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
        return anchor?.kind === CONNECTOR_WRITE_ANCHOR_KIND ? anchor : undefined;
      },
    });
    const resolved = await resolver.revalidate({ session: input.session, actor: input.actor, family, receiptId, anchorTaskId });
    if (resolved.kind !== 'resolved' || resolved.family !== family || resolved.draft.receiptId !== receiptId) return { kind: 'refused', reason: 'undo-nothing' };
    if ((await this.deps.receipts.findSentUndoOf?.(input.actor.id, receiptId)) != null) return { kind: 'refused', reason: 'undo-nothing' };
    return resolved;
  }

  /** One authoritative read of ONE event by its receipt id: not a window, not a listing. Only "not found" means gone. */
  private async readOwnEvent(
    calendarId: string,
    eventId: string,
  ): Promise<{ readonly kind: 'read'; readonly event: CalendarEvent | undefined } | { readonly kind: 'refused'; readonly reason: ConnectorWriteRefusal }> {
    const reader = this.deps.calendarReader;
    if (!reader?.getEvent) return { kind: 'refused', reason: 'calendar-read-failed' };
    try {
      return { kind: 'read', event: await this.withReadTimeout(reader.getEvent(calendarId, eventId)) };
    } catch {
      return { kind: 'refused', reason: 'calendar-read-failed' };
    }
  }

  /**
   * Review round 2: the execution-time proof for an update undo. The undo anchor must name the undone update's anchor Task
   * (`undoOf.sourceTaskId`); that anchor must be this actor's plain approved update whose approval produced the receipt in
   * `undoOf.receiptId` (SENT, same event); and the inverse re-derived from it NOW (`inverseChanges`, which requires every
   * changed text field to be marked lossless and the time zone to be the recorded one) must equal the payload's changes
   * key for key. A legacy anchor (no marker, no source link) fails, so a pre-fix card never writes a lossy value.
   */
  private async isExactUpdateInverse(anchor: ConnectorWriteAnchor, payload: Extract<ConnectorWritePayload, { operation: 'CALENDAR_EVENT_UPDATE' }>): Promise<boolean> {
    const link = anchor.undoOf;
    if (link?.family !== 'calendar-update' || link.sourceTaskId === undefined) return false;
    const receipt = await this.deps.receipts.findById(link.receiptId, anchor.actorId);
    if (receipt === null || receipt.status !== 'SENT' || receipt.operation !== 'CALENDAR_EVENT_UPDATE' || receipt.data.externalRef !== payload.eventId) return false;
    const task = await this.deps.store.tasks.get(link.sourceTaskId);
    const source = task?.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
    if (source?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || source.actorId !== anchor.actorId || source.undoOf !== undefined) return false;
    if (source.approvalId === undefined || receipt.idempotencyKey !== `cwr:${source.approvalId}`) return false;
    const updated = source.payload;
    const shown = source.preview;
    if (updated?.operation !== 'CALENDAR_EVENT_UPDATE' || shown?.operation !== 'CALENDAR_EVENT_UPDATE' || shown.receiptSourced === true) return false;
    if (updated.eventId !== payload.eventId || shown.before.id !== payload.eventId) return false;
    const inverse = inverseChanges(updated.changes, shown.before);
    return inverse !== undefined && stableJson(inverse) === stableJson(payload.changes);
  }

  /** The same single read, with the deletion state (a restore needs a positive "deleted"). */
  private async readOwnEventPresence(
    calendarId: string,
    eventId: string,
  ): Promise<CalendarEventPresence | { readonly kind: 'refused'; readonly reason: ConnectorWriteRefusal }> {
    const reader = this.deps.calendarReader;
    if (!reader?.getEventPresence) return { kind: 'refused', reason: 'undo-unavailable' };
    try {
      return await this.withReadTimeout(reader.getEventPresence(calendarId, eventId));
    } catch {
      return { kind: 'refused', reason: 'calendar-read-failed' };
    }
  }

  private async proposeEventChange(
    input: FlowInput,
    mode: 'update' | 'delete',
    event: ConnectorWriteEventSummary,
    changes: CalendarDraftChanges | undefined,
    inheritedPrevious?: Id,
  ): Promise<ConnectorWriteStep> {
    const writer = this.deps.writers.calendarEvents;
    if (!writer) return { kind: 'writes-off' };
    const target = `${writer.target}/${event.id}`;
    // The event as previewed: an edit after this (any change of its version, time or shape) refuses the write. Without
    // a usable version the write could not be made conditional, so nothing is proposed (no approval, no change).
    if (!isEventVersion(event.version)) return { kind: 'refused', reason: 'event-unversioned', family: 'calendar' };
    const expected: CalendarEventExpectation = { allDay: event.allDay, start: event.start, end: event.end, version: event.version };
    if (mode === 'delete') {
      return this.propose(
        input,
        'calendar',
        writer.source,
        target,
        { operation: 'CALENDAR_EVENT_DELETE', eventId: event.id, expected },
        { operation: 'CALENDAR_EVENT_DELETE', before: event, timeZone: this.deps.timeZone },
        inheritedPrevious,
      );
    }
    const resolved = resolveChanges(event, changes ?? {}, this.deps.timeZone);
    if (typeof resolved === 'string') return { kind: 'refused', reason: resolved, family: 'calendar' };
    return this.propose(
      input,
      'calendar',
      writer.source,
      target,
      { operation: 'CALENDAR_EVENT_UPDATE', eventId: event.id, expected, changes: resolved.changes },
      { operation: 'CALENDAR_EVENT_UPDATE', before: event, after: resolved.after, timeZone: this.deps.timeZone },
      inheritedPrevious,
    );
  }

  private async offerChoice(input: FlowInput, choice: ConnectorWriteEventChoice, basis?: ConnectorWriteChoiceBasis): Promise<ConnectorWriteStep> {
    const previous = await this.displacedPointer(input.session);
    const anchor: ConnectorWriteAnchor = {
      kind: CONNECTOR_WRITE_ANCHOR_KIND,
      status: 'AWAITING_CHOICE',
      actorId: input.actor.id,
      sessionId: input.session.id,
      family: 'calendar',
      choice,
      createdAt: input.now,
      updatedAt: input.now,
      ...(previous ? { previousActiveTaskId: previous } : {}),
    };
    await this.createAnchor(input.session, anchor, input.now, input.held);
    return { kind: 'choice', mode: choice.mode, candidates: choice.candidates, timeZone: this.deps.timeZone, ...(basis ? { basis } : {}) };
  }

  /**
   * Dedup against a SENT receipt ("이미 보냈어요"), then the CRITICAL approval and the anchor. An unresolved receipt
   * (UNCERTAIN / PREPARED) for the same write does not block: the preview carries a duplicate warning (UNC-1).
   */
  private async propose(
    input: FlowInput,
    family: ConnectorWriteFamily,
    connector: string,
    target: string,
    payload: ConnectorWritePayload,
    preview: ConnectorWritePreview,
    inheritedPrevious?: Id,
    undoOf?: ConnectorWriteAnchor['undoOf'],
  ): Promise<ConnectorWriteStep> {
    const operation = payload.operation;
    const payloadSha256 = connectorWritePayloadSha256(operation, target, sendableOf(payload));
    const sent = await this.deps.receipts.findLatestSent({
      actorId: input.actor.id,
      connector,
      operation,
      target,
      payloadSha256,
    });
    // Review round 1 (P2-C): a SENT forward write that this actor has since undone (a SENT undo receipt names it) is not a
    // replay: asking for the same write again is a new write and gets a new approval. An undo payload (`undoes`) never takes
    // this path, and a replay of the same approval stays refused by its idempotency key.
    const undone = sent !== null && !('undoes' in payload && payload.undoes !== undefined) ? await this.deps.receipts.findSentUndoOf?.(input.actor.id, sent.id) : null;
    if (sent && !undone) {
      return {
        kind: 'already-sent',
        operation,
        ...(sent.data.externalRef ? { externalRef: sent.data.externalRef } : {}),
        ...(sent.data.url ? { url: sent.data.url } : {}),
      };
    }
    const unresolved = await this.deps.receipts.findLatestUnresolved({
      actorId: input.actor.id,
      connector,
      operation,
      target,
      payloadSha256,
    });
    const previous = inheritedPrevious ?? (await this.displacedPointer(input.session));
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: { id: this.deps.newId(), goal: `connector write: ${operation}` },
      riskLevel: RiskLevel.CRITICAL,
      reason: connectorWriteApprovalReason(operation, target, payloadSha256),
      requestedBy: input.actor.id,
    });
    const anchor: ConnectorWriteAnchor = {
      kind: CONNECTOR_WRITE_ANCHOR_KIND,
      status: 'APPROVAL_PENDING',
      actorId: input.actor.id,
      sessionId: input.session.id,
      family,
      operation,
      connector,
      target,
      payload,
      payloadSha256,
      preview,
      approvalId: approval.id,
      createdAt: input.now,
      updatedAt: input.now,
      ...(previous ? { previousActiveTaskId: previous } : {}),
      ...(undoOf ? { undoOf } : {}),
    };
    try {
      await this.createAnchor(input.session, anchor, input.now, input.held);
    } catch (error) {
      // Never leave an unreachable PENDING CRITICAL approval behind.
      await this.deps.approvals
        .decide(approval.id, { approvalId: approval.id, approved: false, decidedBy: 'system', decidedAt: input.now, comment: 'anchor-failed' })
        .catch(() => undefined);
      throw error;
    }
    this.log('info', 'connector_write.previewed', { operation, approvalId: approval.id });
    return {
      kind: 'preview',
      preview,
      approval,
      remainingMs: PENDING_APPROVAL_TTL_MS,
      executionPhrase: documentedExecutionPhrase(connectorWriteExecutionGate(operation)),
      ...(unresolved
        ? {
            unconfirmedEarlier: {
              status: unresolved.status === 'PREPARED' ? ('EXECUTING' as const) : ('UNCERTAIN' as const),
              at: unresolved.updatedAt,
              timeZone: this.deps.timeZone,
            },
          }
        : {}),
    };
  }

  /**
   * The pointer a new anchor displaces: the live session's `activeTaskId`, or — when that is one of OUR anchors — the
   * pointer IT displaced (so the chain restores to the original). An APPROVED grant superseded here is closed so it
   * can never run.
   */
  private async displacedPointer(session: Session): Promise<Id | undefined> {
    const live = (await this.deps.store.sessions.get(session.id)) ?? session;
    const current = live.activeTaskId;
    if (!current) return undefined;
    const task = await this.deps.store.tasks.get(current);
    const anchor = task?.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
    if (!task || task.planId || anchor?.kind !== CONNECTOR_WRITE_ANCHOR_KIND) return current;
    if (anchor.status === 'APPROVED' || anchor.status === 'AWAITING_CHOICE') {
      await this.deps.store.tasks.save({
        ...task,
        status: TaskStatus.CANCELED,
        metadata: { ...task.metadata, [ANCHOR_KEY]: { ...anchor, status: 'CLOSED', closedReason: 'superseded' } },
      });
    }
    return anchor.previousActiveTaskId;
  }

  private async createAnchor(session: Session, anchor: ConnectorWriteAnchor, now: IsoTimestamp, held?: SessionLockHold): Promise<void> {
    const task: Task = {
      id: this.deps.newId(),
      title: 'connector write approval',
      description: anchor.operation ?? 'connector write choice',
      status: taskStatusOf(anchor.status),
      intent: {
        type: IntentType.CHAT,
        capability: Capability.GENERAL_CHAT,
        confidence: 1,
        requiresWork: false,
        summary: anchor.operation ?? 'connector write choice',
        raw: { kind: 'connector-write-anchor' },
      },
      riskLevel: RiskLevel.CRITICAL,
      context: session.context,
      actorId: anchor.actorId,
      sessionId: session.id,
      createdAt: now,
      updatedAt: now,
      metadata: { [ANCHOR_KEY]: anchor },
    };
    await this.deps.store.tasks.save(task);
    // Under the session write lock, onto the live row (ADR-0113 D7).
    await this.sessionLock.saveFields(this.deps.store.sessions, session, { activeTaskId: task.id, lastActivityAt: now }, held);
  }

  private async saveAnchor(
    taskId: Id,
    session: Session,
    anchor: ConnectorWriteAnchor,
    options: { keepPointer?: boolean; restorePointer?: boolean } = {},
    held?: SessionLockHold,
  ): Promise<void> {
    const task = await this.deps.store.tasks.get(taskId);
    if (!task) throw new Error('connector write anchor task missing');
    await this.deps.store.tasks.save({
      ...task,
      status: taskStatusOf(anchor.status),
      updatedAt: anchor.updatedAt,
      metadata: { ...task.metadata, [ANCHOR_KEY]: anchor },
    });
    if (options.keepPointer || !options.restorePointer) return;
    // Terminal: hand the pointer back to what this anchor displaced. With nothing displaced a finished write keeps
    // the pointer (a repeated phrase is then answered from it); a closed one releases it.
    // Compare-and-set on the live row under the session write lock (ADR-0113 D7).
    await this.sessionLock.run(
      session.id,
      async () => {
        const live = await this.deps.store.sessions.get(session.id);
        if (!live || live.activeTaskId !== taskId) return;
        if (anchor.previousActiveTaskId) {
          await this.deps.store.sessions.save({ ...live, activeTaskId: anchor.previousActiveTaskId });
        } else if (anchor.status === 'CLOSED') {
          await this.deps.store.sessions.save({ ...live, activeTaskId: undefined });
        }
      },
      held,
    );
  }

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger?.[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

function taskStatusOf(status: ConnectorWriteAnchorStatus): TaskStatus {
  switch (status) {
    case 'APPROVAL_PENDING':
      return TaskStatus.WAITING_APPROVAL;
    case 'EXECUTING':
      return TaskStatus.RUNNING;
    case 'SENT':
      return TaskStatus.COMPLETED;
    case 'NOT_SENT':
      return TaskStatus.FAILED;
    case 'UNCERTAIN':
      return TaskStatus.NEEDS_REVIEW;
    case 'CLOSED':
      return TaskStatus.CANCELED;
    default:
      return TaskStatus.PENDING;
  }
}

/** Whether an anchor's payload and its undo link name the same source receipt (or neither is an undo). */
function undoBindingHolds(anchor: ConnectorWriteAnchor, payload: ConnectorWritePayload): boolean {
  const undoes = 'undoes' in payload ? payload.undoes : undefined;
  if (anchor.undoOf === undefined) return undoes === undefined;
  return typeof undoes === 'string' && undoes.length > 0 && undoes === anchor.undoOf.receiptId;
}

/** The hashed part of a payload: everything but the operation (an undo's `undoes` is hashed, never sent to a writer). */
function sendableOf(payload: ConnectorWritePayload): unknown {
  const { operation: _operation, ...rest } = payload;
  return rest;
}

function repeatOf(anchor: ConnectorWriteAnchor, operation: ConnectorWriteOperation): ConnectorWriteStep {
  const status = anchor.status === 'EXECUTING' ? 'EXECUTING' : (anchor.outcome?.status ?? 'UNCERTAIN');
  return {
    kind: 'repeat',
    operation,
    status,
    ...(anchor.outcome?.externalRef ? { externalRef: anchor.outcome.externalRef } : {}),
    ...(anchor.outcome?.url ? { url: anchor.outcome.url } : {}),
  };
}

function checkOwnerText(text: string, maxLength: number): ConnectorWriteRefusal | null {
  if (!isValidConnectorWriteText(text)) return 'invalid-text';
  if (Array.from(text).length > maxLength) return 'text-too-long';
  if (containsCredentialMaterial(text)) return 'credential';
  return null;
}

function checkOptionalField(value: string | undefined, maxLength: number): ConnectorWriteRefusal | null {
  if (value === undefined) return null;
  if (!isValidConnectorWriteText(value, maxLength)) return Array.from(value).length > maxLength ? 'text-too-long' : 'invalid-text';
  if (containsCredentialMaterial(value)) return 'credential';
  return null;
}

function checkEventDraft(event: CalendarEventDraft): ConnectorWriteRefusal | null {
  return (
    checkOptionalField(event.title, 200) ??
    checkOptionalField(event.location, 200) ??
    checkOptionalField(event.description, CONNECTOR_WRITE_PREVIEW_DESCRIPTION_MAX_LENGTH) ??
    (isValidEventTime(event.time) ? null : 'invalid-time')
  );
}

function checkChanges(changes: CalendarEventChanges): ConnectorWriteRefusal | null {
  if (changes.title === undefined && changes.location === undefined && changes.time === undefined && changes.description === undefined) {
    return 'no-change';
  }
  return (
    checkOptionalField(changes.title, 200) ??
    checkOptionalField(changes.location, 200) ??
    checkOptionalField(changes.description, CONNECTOR_WRITE_PREVIEW_DESCRIPTION_MAX_LENGTH) ??
    (changes.time === undefined || isValidEventTime(changes.time) ? null : 'invalid-time')
  );
}

function isValidEventTime(time: CalendarEventTime): boolean {
  if (time.allDay) return /^\d{4}-\d{2}-\d{2}$/.test(time.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(time.endDate) && time.endDate > time.startDate;
  const start = Date.parse(time.start);
  const end = Date.parse(time.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** The single transition whose target status (or, failing that, whose name) equals `wanted` (case-insensitive). */
function matchTransition(options: readonly IssueTransitionOption[], wanted: string): IssueTransitionOption | undefined {
  const fold = (value: string): string => value.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
  const target = fold(wanted);
  const byStatus = options.filter((option) => fold(option.toStatus) === target);
  if (byStatus.length === 1) return byStatus[0];
  if (byStatus.length > 1) return undefined;
  const byName = options.filter((option) => fold(option.name) === target);
  return byName.length === 1 ? byName[0] : undefined;
}

function availableStatuses(options: readonly IssueTransitionOption[]): string[] {
  const seen = new Set<string>();
  for (const option of options) {
    const status = option.toStatus.replace(/\s+/gu, ' ').trim();
    if (status.length > 0 && status.length <= ISSUE_TRANSITION_STATUS_MAX_LENGTH && !containsCredentialMaterial(status)) {
      seen.add(status);
    }
    if (seen.size >= MAX_LISTED_STATUSES) break;
  }
  return [...seen];
}

function summaryOf(event: CalendarEvent): ConnectorWriteEventSummary {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.version !== undefined ? { version: event.version } : {}),
    ...(event.timeZone !== undefined ? { timeZone: event.timeZone } : {}),
    ...(event.lossless !== undefined ? { lossless: { title: event.lossless.title === true, location: event.lossless.location === true } } : {}),
  };
}

function isNumericId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
}

/** A status name read from the provider, for display only: single line, control characters removed, bounded. */
function boundStatusName(name: string): string {
  return boundCalendarText(name, ISSUE_TRANSITION_STATUS_MAX_LENGTH);
}

/** Review round 1 (P3): a status name to show on an undo card: bounded, and empty (ids only) when it looks like a credential. */
function displayStatusName(name: string): string {
  return containsCredentialMaterial(name) ? '' : boundStatusName(name);
}

/**
 * O5: the transitions of `options` that lead to `statusId`, each once by id, bound by ids only (a transition without a numeric id
 * or destination is never offered), at most {@link CONNECTOR_WRITE_MAX_CHOICES}.
 */
function transitionsLeadingTo(options: readonly IssueTransitionOption[], statusId: string): IssueTransitionOption[] {
  const seen = new Set<string>();
  const out: IssueTransitionOption[] = [];
  for (const option of options) {
    if (!isNumericId(option.id) || option.toStatusId !== statusId || seen.has(option.id)) continue;
    if (containsCredentialMaterial(option.name) || containsCredentialMaterial(option.toStatus)) continue;
    seen.add(option.id);
    out.push({ id: option.id, name: boundStatusName(option.name), toStatus: boundStatusName(option.toStatus), toStatusId: option.toStatusId });
    if (out.length >= CONNECTOR_WRITE_MAX_CHOICES) break;
  }
  return out;
}

/** The shape of a bound event expectation (its version is checked when sending: missing = NOT_SENT TARGET_CHANGED). */
function isExpectation(value: CalendarEventExpectation | undefined): value is CalendarEventExpectation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.allDay === 'boolean' &&
    typeof value.start === 'string' &&
    typeof value.end === 'string'
  );
}

/** The owner's undo sentence for the card: single line, control characters removed, at most 120 characters; `undefined` when empty. */
function boundedOwnerSentence(text: string | undefined): string | undefined {
  const bounded = boundCalendarText(text, 120);
  return bounded.length > 0 ? bounded : undefined;
}

/** The live event is still exactly the event Quoky was approved to create: the same title, start and end. */
function sameAsDraft(event: CalendarEvent, draft: CalendarEventDraft): boolean {
  if (event.title !== boundCalendarText(draft.title, CALENDAR_EVENT_TITLE_MAX_LENGTH)) return false;
  const time = draft.time;
  if (time.allDay) return event.allDay && event.start === time.startDate && event.end === time.endDate;
  return !event.allDay && Date.parse(event.start) === Date.parse(time.start) && Date.parse(event.end) === Date.parse(time.end);
}

/** The bounded owner sentence as an optional preview field. */
function ownerSentenceOf(text: string | undefined): { ownerSentence?: string } {
  const sentence = boundedOwnerSentence(text);
  return sentence !== undefined ? { ownerSentence: sentence } : {};
}

/** The shape of a bound restore expectation. */
function isRestoreExpectation(value: CalendarEventRestoreExpectation | undefined): value is CalendarEventRestoreExpectation {
  return isExpectation(value as CalendarEventExpectation | undefined) && typeof value?.title === 'string';
}

/** An event's own time as a `CalendarEventTime` (a timed event in `timeZone`). */
function eventTimeOf(event: { readonly allDay: boolean; readonly start: string; readonly end: string }, timeZone: string): CalendarEventTime {
  return event.allDay ? { allDay: true, startDate: event.start, endDate: event.end } : { allDay: false, start: event.start, end: event.end, timeZone };
}

/**
 * ADR-0112 amendment 3 (O2): the inverse of an update's changes — ONLY the fields the update changed, each set back to the value
 * its preview showed (`before`). `undefined` (no undo) when a changed field has no value that can be written back exactly:
 * the title was empty, the event had no location, the description changed (the preview never holds one), a shown text value
 * is not byte-identical to the original (review round 1: the readout bounds, collapses and cuts text, so only a value the
 * reader marked lossless is written back), or the old value would fail the same checks a new write must pass. A time goes
 * back to the exact old instants only for a timed event whose recorded start time zone is the very zone the update wrote;
 * an all-day time, an unrecorded zone or a changed zone has no undo (never restamped in another zone).
 */
function inverseChanges(changes: CalendarEventChanges, before: ConnectorWriteEventSummary): CalendarEventChanges | undefined {
  if (changes.description !== undefined) return undefined;
  const out: { title?: string; location?: string; time?: CalendarEventTime } = {};
  if (changes.title !== undefined) {
    if (before.title.length === 0 || before.lossless?.title !== true) return undefined;
    out.title = before.title;
  }
  if (changes.location !== undefined) {
    if (before.location === undefined || before.location.length === 0 || before.lossless?.location !== true) return undefined;
    out.location = before.location;
  }
  if (changes.time !== undefined) {
    if (before.allDay || changes.time.allDay || before.timeZone === undefined || changes.time.timeZone !== before.timeZone) return undefined;
    out.time = eventTimeOf(before, before.timeZone);
    if (!isValidEventTime(out.time)) return undefined;
  }
  if (out.title === undefined && out.location === undefined && out.time === undefined) return undefined;
  return checkChanges(out) === null ? out : undefined;
}

/** JSON with object keys sorted (a key-for-key equality of two plain values). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** The live event is still exactly what the approved update left: each changed field equals the update's value. */
function sameAsAfter(event: CalendarEvent, changes: CalendarEventChanges, after: { readonly title: string; readonly time: CalendarEventTime; readonly location?: string }): boolean {
  if (event.title !== boundCalendarText(after.title, CALENDAR_EVENT_TITLE_MAX_LENGTH)) return false;
  if (changes.location !== undefined && event.location !== boundCalendarText(changes.location, CALENDAR_EVENT_LOCATION_MAX_LENGTH)) return false;
  const time = after.time;
  if (time.allDay) return event.allDay && event.start === time.startDate && event.end === time.endDate;
  return !event.allDay && Date.parse(event.start) === Date.parse(time.start) && Date.parse(event.end) === Date.parse(time.end);
}

/** A usable provider event version (printable ASCII, bounded) — the condition every update / delete is sent under. */
function isEventVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,200}$/.test(value);
}

/** Events on the referenced day that match the start time and every title word. Never a best guess. */
function matchReference(events: readonly CalendarEvent[], ref: CalendarEventReference, timeZone: string): CalendarEvent[] {
  return events.filter((event) => {
    if (typeof event.id !== 'string' || event.id.length === 0) return false;
    if (ref.startTime !== undefined) {
      if (event.allDay) return false;
      const start = Date.parse(event.start);
      if (!Number.isFinite(start)) return false;
      const local = toZonedDateTime(start, timeZone);
      if (
        local.year !== ref.date.year ||
        local.month !== ref.date.month ||
        local.day !== ref.date.day ||
        local.hour !== ref.startTime.hour ||
        local.minute !== ref.startTime.minute
      ) {
        return false;
      }
    }
    const title = event.title.toLowerCase();
    return ref.titleWords.every((word) => title.includes(word));
  });
}

/** An undated reference's time of day (any date) and every title word; no time and no words match any event. */
function matchesTimeAndTitle(event: CalendarEvent, ref: CalendarEventReference, timeZone: string): boolean {
  if (typeof event.id !== 'string' || event.id.length === 0) return false;
  if (ref.startTime !== undefined) {
    if (event.allDay) return false;
    const start = Date.parse(event.start);
    if (!Number.isFinite(start)) return false;
    const local = toZonedDateTime(start, timeZone);
    if (local.hour !== ref.startTime.hour || local.minute !== ref.startTime.minute) return false;
  }
  const title = event.title.toLowerCase();
  return ref.titleWords.every((word) => title.includes(word));
}

/** The local day an event time starts on, or undefined when unreadable. */
function localDayOf(time: CalendarEventTime, timeZone: string): LocalDate | undefined {
  if (time.allDay) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time.startDate);
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : undefined;
  }
  const start = Date.parse(time.start);
  return Number.isFinite(start) ? localDateOf(start, time.timeZone || timeZone) : undefined;
}

/** Sort key: the start instant (local midnight of the start date for an all-day event). */
function eventStartMs(event: CalendarEvent, timeZone: string): number {
  if (event.allDay) {
    const day = localDayOf({ allDay: true, startDate: event.start, endDate: event.end }, timeZone);
    if (!day) return Number.MAX_SAFE_INTEGER;
    return zonedToUtc({ ...day, hour: 0, minute: 0 }, timeZone).epochMs;
  }
  const ms = Date.parse(event.start);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

/** The exact `CalendarEventChanges` for an update and the "after" view, or a refusal. */
function resolveChanges(
  event: ConnectorWriteEventSummary,
  changes: CalendarDraftChanges,
  timeZone: string,
): { changes: CalendarEventChanges; after: { title: string; time: CalendarEventTime; location?: string } } | ConnectorWriteRefusal {
  const out: { title?: string; location?: string; time?: CalendarEventTime } = {};
  let afterTime: CalendarEventTime = event.allDay
    ? { allDay: true, startDate: event.start, endDate: event.end }
    : { allDay: false, start: event.start, end: event.end, timeZone };
  if (changes.moveTo) {
    if (event.allDay) return 'all-day-move';
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'invalid-time';
    const current = toZonedDateTime(start, timeZone);
    const date = changes.moveTo.date ?? { year: current.year, month: current.month, day: current.day };
    const resolved = zonedToUtc({ ...date, hour: changes.moveTo.time.hour, minute: changes.moveTo.time.minute }, timeZone);
    if (resolved.resolution === 'NONEXISTENT') return 'invalid-time';
    const newStart = new Date(resolved.epochMs).toISOString();
    const newEnd = new Date(resolved.epochMs + (end - start)).toISOString();
    if (newStart === new Date(start).toISOString()) return 'no-change';
    out.time = { allDay: false, start: newStart, end: newEnd, timeZone };
    afterTime = out.time;
  }
  if (changes.title !== undefined) out.title = changes.title;
  if (changes.location !== undefined) out.location = changes.location;
  const refusal = checkChanges(out);
  if (refusal) return refusal;
  const afterLocation = out.location ?? event.location;
  return {
    changes: out,
    after: { title: out.title ?? event.title, time: afterTime, ...(afterLocation !== undefined ? { location: afterLocation } : {}) },
  };
}
