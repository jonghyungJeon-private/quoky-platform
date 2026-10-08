import { ApprovalStatus, Capability, IntentType, RiskLevel, SessionStatus, TaskStatus } from '../../domain';
import type { Actor, ApprovalRequest, ConversationContext, ExecutionPlanRef, Id, IsoTimestamp, Session, Task } from '../../domain';
import type { CalendarEvent, CalendarReader } from '../../ports/calendar-reader.port';
import { CALENDAR_EVENTS_MAX_LIMIT } from '../../ports/calendar-reader.port';
import {
  CONNECTOR_WRITE_OPERATIONS,
  ISSUE_TRANSITION_STATUS_MAX_LENGTH,
  connectorWriteNotSent,
  connectorWriteUncertain,
  isValidConnectorWriteText,
  type CalendarEventChanges,
  type CalendarEventDraft,
  type CalendarEventExpectation,
  type CalendarEventTime,
  type CalendarEventWriter,
  type ChannelMessageWriter,
  type ConnectorWriteOperation,
  type ConnectorWriteOutcome,
  type IssueCommentWriter,
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
import { toZonedDateTime, zonedToUtc } from '../reminders/zoned-time';
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
  | 'inconsistent';

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
    }
  | { readonly operation: 'CHANNEL_POST'; readonly channel: string; readonly text: string }
  | { readonly operation: 'CALENDAR_EVENT_CREATE'; readonly draft: CalendarEventDraft }
  | {
      readonly operation: 'CALENDAR_EVENT_UPDATE';
      readonly eventId: string;
      readonly expected: CalendarEventExpectation;
      readonly changes: CalendarEventChanges;
    }
  | { readonly operation: 'CALENDAR_EVENT_DELETE'; readonly eventId: string; readonly expected: CalendarEventExpectation };

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
    }
  | { readonly operation: 'CHANNEL_POST'; readonly channelLabel: string; readonly channelId: string; readonly text: string }
  | { readonly operation: 'CALENDAR_EVENT_CREATE'; readonly event: CalendarEventDraft; readonly timeZone: string }
  | {
      readonly operation: 'CALENDAR_EVENT_UPDATE';
      readonly before: ConnectorWriteEventSummary;
      readonly after: { readonly title: string; readonly time: CalendarEventTime; readonly location?: string };
      readonly timeZone: string;
    }
  | { readonly operation: 'CALENDAR_EVENT_DELETE'; readonly before: ConnectorWriteEventSummary; readonly timeZone: string };

/** The pending numbered choice of an update or delete (next turn only). */
export interface ConnectorWriteChoice {
  readonly mode: 'update' | 'delete';
  readonly changes?: CalendarDraftChanges;
  readonly reference: CalendarEventReference;
  readonly candidates: readonly ConnectorWriteEventSummary[];
}

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
  | 'event-not-found'
  | 'event-unversioned'
  | 'too-many-events'
  | 'calendar-read-failed'
  | 'all-day-move'
  | 'invalid-time'
  | 'no-change'
  | 'invalid-choice'
  | 'binding-mismatch'
  | 'grant-expired'
  | 'choice-expired';

/** What one flow step produced; the runtime renders it through `ResponseComposer` (reply text lives there). */
export type ConnectorWriteStep =
  /** No writer is bound for this draft (writes are off): the handler's fixed `fallbackText` is the reply. */
  | { readonly kind: 'writes-off' }
  | { readonly kind: 'usage'; readonly topic: ConnectorWriteUsageTopic }
  | {
      readonly kind: 'refused';
      readonly reason: ConnectorWriteRefusal;
      readonly family: ConnectorWriteFamily;
      /** `transition-unavailable`: the statuses the issue can move to now (untrusted readout). */
      readonly availableStatuses?: readonly string[];
    }
  | {
      readonly kind: 'preview';
      readonly preview: ConnectorWritePreview;
      readonly approval: ApprovalRequest;
      readonly remainingMs: number;
      readonly executionPhrase: string;
    }
  | {
      readonly kind: 'choice';
      readonly mode: 'update' | 'delete';
      readonly candidates: readonly ConnectorWriteEventSummary[];
      readonly timeZone: string;
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
 * {@link ConnectorWriteFlow.closedAfterInSession}); nothing is ever executed from them.
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
   * Live QA session 3 (D1): the newest write REQUEST of `operation` in THIS conversation by `actorId` that was closed
   * without ever being dispatched (denied, cancelled, expired, superseded, …) after `after` — the newest; null otherwise.
   * An older send must not answer "already sent" for it (it would read as if the rejected request went out).
   */
  closedAfterInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    after: IsoTimestamp,
  ): Promise<ConnectorWriteClosedRequest | null>;
  /**
   * Lazy expiry of an APPROVED grant or an AWAITING_CHOICE choice past the ADR-0093 lifetime: closes it `expired`
   * (restoring the pointer it displaced) and says what was released; null when nothing lapsed.
   */
  releaseExpired(session: Session, now: IsoTimestamp): Promise<ConnectorWriteRelease | null>;
  prepare(input: FlowInput & { readonly draft: ConnectorWriteDraft }): Promise<ConnectorWriteStep>;
  choose(input: FlowInput & { readonly view: ConnectorWriteAnchorView; readonly index: number }): Promise<ConnectorWriteStep>;
  recordApproval(input: FlowInput & { readonly view: ConnectorWriteAnchorView }): Promise<ConnectorWriteStep>;
  execute(input: FlowInput & { readonly view: ConnectorWriteAnchorView }): Promise<ConnectorWriteStep>;
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

/** A write request of this conversation closed without being dispatched ({@link ConnectorWriteFlow.closedAfterInSession}). */
export interface ConnectorWriteClosedRequest {
  readonly operation: ConnectorWriteOperation;
  readonly reason: ConnectorWriteCloseReason;
  readonly target: ConnectorWriteTargetSummary;
  /** When it was closed. */
  readonly at: IsoTimestamp;
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
      return { kind: 'issue', issueKey: preview.issueKey };
    case 'CHANNEL_POST':
      return { kind: 'channel', channelLabel: preview.channelLabel, channelId: preview.channelId };
    case 'CALENDAR_EVENT_CREATE':
    case 'CALENDAR_EVENT_UPDATE':
    case 'CALENDAR_EVENT_DELETE':
      return { kind: 'calendar' };
  }
}

export interface FlowInput {
  readonly session: Session;
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** A caller already holding the session write lock passes its hold (ADR-0113 D7); absent → the flow takes it. */
  readonly held?: SessionLockHold;
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

/** The approval reason: operation, normalized target and payload hash — never the payload text. */
export function connectorWriteApprovalReason(operation: ConnectorWriteOperation, target: string, sha256: string): string {
  return `connector-write: ${operation} target=${target} sha256=${sha256}; one-time, exact payload, no automatic retry`;
}

const CONNECTOR_WRITE_HELP_LINES: Readonly<Record<'issue' | 'channel', string>> = {
  issue: '- Jira 쓰기: "KEY-1에 댓글: 내용" → "승인" → "댓글 실행", "KEY-1 진행 중으로 바꿔줘" → "승인" → "상태 변경 실행"',
  channel: '- Slack 게시: "#채널에 게시: 내용" 또는 "#채널에 내용이라고 올려줘" → "승인" → "Slack 게시 실행"',
};

class ReadTimeout extends Error {}

export class StatelessConnectorWriteFlow implements ConnectorWriteFlow {
  readonly helpLines: readonly string[];
  private reconciled: Promise<void> | null = null;
  private readonly sessionLock: SessionWriteLock;

  constructor(private readonly deps: ConnectorWriteFlowDeps) {
    this.sessionLock = deps.sessionLock ?? SESSION_WRITE_LOCK;
    const lines: string[] = [];
    if (deps.writers.issueComments || deps.writers.issueTransitions) lines.push(CONNECTOR_WRITE_HELP_LINES.issue);
    if (deps.writers.channelMessages) lines.push(CONNECTOR_WRITE_HELP_LINES.channel);
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

  async closedAfterInSession(
    session: Session,
    actorId: Id,
    operation: ConnectorWriteOperation,
    after: IsoTimestamp,
  ): Promise<ConnectorWriteClosedRequest | null> {
    let best: ConnectorWriteAnchor | null = null;
    for (const anchor of await this.sessionAnchorsOf(session, actorId)) {
      if (anchor.operation !== operation || anchor.status !== 'CLOSED' || anchor.consumedAt || !anchor.preview) continue;
      if (anchor.updatedAt <= after) continue;
      if (!best || anchor.updatedAt > best.updatedAt) best = anchor;
    }
    if (!best?.preview) return null;
    return { operation, reason: best.closedReason ?? 'cancelled', target: connectorWriteTargetOf(best.preview), at: best.updatedAt };
  }

  /** Every connector-write anchor this conversation created for `actorId` (any status). Read-only. */
  private async sessionAnchorsOf(session: Session, actorId: Id): Promise<ConnectorWriteAnchor[]> {
    const tasks = await this.deps.store.tasks.listByContext(session.context.channelId, session.context.threadId);
    const anchors: ConnectorWriteAnchor[] = [];
    for (const task of tasks) {
      if (task.planId) continue;
      const anchor = task.metadata?.[ANCHOR_KEY] as ConnectorWriteAnchor | undefined;
      if (anchor?.kind !== CONNECTOR_WRITE_ANCHOR_KIND || anchor.sessionId !== session.id || anchor.actorId !== actorId) continue;
      anchors.push(anchor);
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
    for (const anchor of await this.sessionAnchorsOf(session, actorId)) {
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
        return this.propose(
          input,
          family,
          writer.source,
          key,
          { operation: 'ISSUE_TRANSITION', ...bound },
          { operation: 'ISSUE_TRANSITION', ...bound },
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
      case 'calendar-update':
      case 'calendar-delete': {
        const changes = draft.kind === 'calendar-update' ? draft.changes : undefined;
        if (changes && changes.moveTo === undefined && changes.title === undefined && changes.location === undefined) {
          return refused('no-change');
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
        const mode = draft.kind === 'calendar-update' ? 'update' : 'delete';
        // Never guess: several matches, or a reference with neither a start time nor a title (a whole day), is a
        // numbered choice even with one candidate.
        const vague = draft.ref.startTime === undefined && draft.ref.titleWords.length === 0;
        if (candidates.length > 1 || vague) {
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

  async execute(input: FlowInput & { readonly view: ConnectorWriteAnchorView }): Promise<ConnectorWriteStep> {
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
    const { payload, payloadSha256, target, connector, approvalId, preview } = anchor;
    if (!payload || !payloadSha256 || !target || !connector || !approvalId || !preview) {
      await this.close(input.session, input.view, 'inconsistent', input.now);
      return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    }
    // The grant lives as long as a pending approval does (ADR-0093), counted from the approval decision.
    if (isConnectorWriteAnchorLapsed(anchor, input.now)) {
      await this.close(input.session, input.view, 'expired', input.now);
      return { kind: 'refused', reason: 'grant-expired', family: anchor.family };
    }
    // Re-prove the binding: the approval is this request's CRITICAL approval, APPROVED, with the same reason; the
    // anchored payload still hashes to the bound hash; the target is still allowed and the text still clean.
    const approval = await this.deps.approvals.get(approvalId);
    const expectedReason = connectorWriteApprovalReason(operation, target, payloadSha256);
    if (
      !approval ||
      approval.status !== ApprovalStatus.APPROVED ||
      approval.riskLevel !== RiskLevel.CRITICAL ||
      approval.reason !== expectedReason ||
      payload.operation !== operation ||
      connectorWritePayloadSha256(operation, target, sendableOf(payload)) !== payloadSha256 ||
      !this.stillAllowed(payload)
    ) {
      await this.close(input.session, input.view, 'inconsistent', input.now);
      return { kind: 'refused', reason: 'binding-mismatch', family: anchor.family };
    }
    const send = this.sendFor(payload, `cwr:${approvalId}`);
    if (!send) {
      await this.close(input.session, input.view, 'inconsistent', input.now);
      return { kind: 'writes-off' };
    }
    // Consume the grant BEFORE anything leaves: a failed save sends nothing; a crash after it leaves EXECUTING,
    // which a repeated phrase reports and never re-sends.
    const consumed: ConnectorWriteAnchor = { ...anchor, status: 'EXECUTING', consumedAt: input.now, updatedAt: input.now };
    await this.saveAnchor(taskId, input.session, consumed, { keepPointer: true });
    await this.reconcileOnce(input.now);
    const executor = new ConnectorWriteExecutor({ receipts: this.deps.receipts, now: () => input.now, newId: this.deps.newId });
    let outcome: ConnectorWriteOutcome;
    // Whether the writer was ever called: the executor validates the request and writes the PREPARED receipt first,
    // so a throw before this flips is provably "nothing was sent".
    let sendStarted = false;
    const sendOnce = (): Promise<ConnectorWriteOutcome> => {
      sendStarted = true;
      return send();
    };
    try {
      const result = await executor.executeOnce(
        { actorId: input.actor.id, idempotencyKey: `cwr:${approvalId}`, connector, operation, target, payloadSha256 },
        sendOnce,
      );
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
    return { kind: 'outcome', operation, outcome, preview };
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

  private async readDay(ref: CalendarEventReference): Promise<readonly CalendarEvent[]> {
    const reader = this.deps.calendarReader;
    if (!reader) throw new Error('no calendar reader');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadTimeout()), this.deps.readTimeoutMs ?? 30_000);
    });
    try {
      return await Promise.race([
        reader.listEvents({ from: ref.window.from, to: ref.window.to, limit: CALENDAR_EVENTS_MAX_LIMIT }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  private async offerChoice(input: FlowInput, choice: ConnectorWriteChoice): Promise<ConnectorWriteStep> {
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
    return { kind: 'choice', mode: choice.mode, candidates: choice.candidates, timeZone: this.deps.timeZone };
  }

  /** Dedup against a SENT receipt, then the CRITICAL approval and the anchor. */
  private async propose(
    input: FlowInput,
    family: ConnectorWriteFamily,
    connector: string,
    target: string,
    payload: ConnectorWritePayload,
    preview: ConnectorWritePreview,
    inheritedPrevious?: Id,
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
    if (sent) {
      return {
        kind: 'already-sent',
        operation,
        ...(sent.data.externalRef ? { externalRef: sent.data.externalRef } : {}),
        ...(sent.data.url ? { url: sent.data.url } : {}),
      };
    }
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

/** The part of a payload the writer receives (the hash covers exactly this). */
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
  };
}

function isNumericId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
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
