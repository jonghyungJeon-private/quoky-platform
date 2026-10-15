import {
  WORK_ITEM_MAX_RESOURCE_REFS,
  WORK_ITEM_MAX_TITLE_LENGTH,
  WorkItemCorrelationError,
  WorkItemStatus,
  WorkItemTitleError,
  normalizeWorkItemTitle,
} from '../../domain';
import { ActionWriteStoppedError, WorkItemReopenError } from '../../domain';
import type { ActionWriteCondition, Actor, MessageBody, MessageContent, ResourceRef, WorkItem } from '../../domain';
import type { NlActionReceipt, NlListingReceipt, NlSelectedCommand } from '../nl-routing/catalog';
import type { ListingSlot } from '../last-listing';
import { renderActionStopped } from '../nl-routing/nl-action-policy';
import {
  CONNECTOR_QUERY_MAX_LIMIT,
  ConnectorQueryName,
  isConnectorQueryError,
} from '../../ports';
import type { ConnectorProvider, ConnectorQuery, PersonalWorkFilter } from '../../ports';
import { containsCredentialMaterial } from '../credential-guard';
import { messageFields } from '../message-rendering';
import type { WorkManager } from '../work-manager';
import type { WorkSurface, WorkSurfaceReadOptions } from '../work-surface-query';
import { surfacePermittedWorkSources, type SurfacePermit } from '../surface-grants/surface-permit';
import {
  buildExternalWorkReadout,
  fitExternalWorkReadoutToPrompt,
  renderExternalWorkFooter,
} from './external-work-readout';
import type { ExternalWorkReadout } from './external-work-readout';
import { lookupJiraRelease } from './jira-release-lookup';
import {
  WORK_CHAT_SEARCH_TEXT_MAX_LENGTH,
  WORK_CHAT_SOURCES,
  WORK_CHAT_SOURCE_QUERIES,
} from './work-chat-command';
import type {
  TodoListStatusFilter,
  WorkChatCommand,
  WorkChatLookupQuery,
  WorkChatSource,
  WorkChatTarget,
} from './work-chat-command';
import {
  renderExternalWorkList,
  renderExternalWriteRefusal,
  renderLookupFailure,
  renderLookupUnsupported,
  renderMyWork,
  renderSearchCredentialRefused,
  renderTodoStatusList,
  renderTodoAdded,
  renderTodoAmbiguous,
  renderTodoCanceled,
  renderTodoCompleted,
  renderTodoCompletionHint,
  renderTodoCredentialRefused,
  renderTodoEmptyTitle,
  renderTodoFailure,
  renderTodoListFailure,
  renderTodoLinked,
  renderTodoNotActive,
  renderTodoNotFound,
  renderTodoSnapshotDrift,
  renderTodoStatusAnswer,
  renderTodoTitleTooLong,
  renderTodoTooManyRefs,
  renderWorkChatUsage,
  renderTodoActionAddUndone,
  renderTodoActionAdded,
  renderTodoActionNotActionable,
  renderTodoActionReopened,
  renderTodoActionTransitioned,
  renderTodoActionWhich,
  renderTodoUndoRefused,
  renderedTodoRows,
  todoNumberOf,
} from './work-chat-renderer';
import type { WorkChatLookupFailure } from './work-chat-renderer';
import { parseReminderMessage } from '../reminders/reminder-grammar';

/** What the runtime presents for one work-chat command (ADR-0100 D8/D10). */
export type WorkChatOutcome =
  /**
   * `text` is the plain rendering; `content` is present when the reply carries platform-rendered spans (PLT-0).
   * `listed` (a connector lookup's deterministic list only): how many items the list shows and whether it was cut, so a
   * count answer (ADR-0120) never re-parses the text.
   */
  | {
      readonly kind: 'reply';
      readonly text: string;
      readonly content?: MessageContent;
      readonly listed?: { readonly count: number; readonly truncated: boolean };
      /** ADR-0120 amendment A6 (only with `actionReceipts`): the to-do action this reply reports, content-free. */
      readonly action?: NlActionReceipt;
      /** ADR-0120 amendment A6 (only with `actionReceipts`): the to-do listing this reply shows (labels and ids). */
      readonly listing?: NlListingReceipt;
    }
  /** The command did not apply (e.g. a completion hint that names no single open to-do): the turn falls through. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'summarize';
      readonly readout: ExternalWorkReadout;
      /** The deterministic list, used whenever summarization does not produce a reply. */
      readonly fallbackText: MessageBody;
      /** Deterministic source links and the disclosure line, appended to a successful summary. */
      readonly footer: MessageBody;
    };

/**
 * The work desk the runtime talks to (ADR-0100 D10). `forActor` is the read-only Jira/GitHub surface (kept for the
 * legacy `personal-work-surface` path); `handle` executes one detected command for the resolved owner Actor.
 */
export interface WorkDesk {
  forActor(actor: Actor): Promise<WorkSurface>;
  /**
   * `options.permit` (ADR-0122 D2.4, P2): the channel's content-free permit; the combined "my work" view reads its Jira /
   * GitHub sections only when the permit allows them. Absent (DM, gate off): exactly as before.
   */
  handle(command: WorkChatCommand, actor: Actor, options?: WorkDeskHandleOptions): Promise<WorkChatOutcome>;
  /** The work sources with a registered read-only connector (ADR-0120 D1: only those are offered to selection). */
  configuredSources?(): readonly WorkChatSource[];
  /**
   * ADR-0120 amendment A6: one validated natural-language to-do action (`todo.add`, `todo.complete`, `todo.cancel`, or
   * `action.undo` of a to-do action), its target already resolved by Core. Absent: no A6 to-do entry is offered.
   */
  handleAction?(command: NlSelectedCommand, actor: Actor, condition?: ActionWriteCondition): Promise<WorkChatOutcome>;
}

export interface WorkDeskHandleOptions {
  readonly permit?: SurfacePermit;
  /**
   * ADR-0120 amendment A6-D2 amendment note (2026-10-16): the owner's fresh (unexpired) to-do listing slot of this
   * (Session, Actor) — the labels and ids the owner last saw. Read only with `actionReceipts`. When present, a numbered
   * to-do command ("N번 완료", "할 일 N번 취소", "완료 처리: N", "할 일 N번에 … 연결") resolves N by the slot's item id and
   * never by the live order; absent (no listing, or it expired), N is the live open-list number as before.
   */
  readonly todoListing?: ListingSlot;
}

export interface WorkChatServiceDeps {
  readonly workSurface: { forActor(actor: Actor, options?: WorkSurfaceReadOptions): Promise<WorkSurface> };
  readonly connectors: { list(): readonly ConnectorProvider[] };
  /** The only to-do state owner; to-do commands never touch storage directly. */
  readonly work: Pick<WorkManager, 'create' | 'listByActor' | 'listActiveByActor' | 'transition' | 'correlate'> &
    Partial<Pick<WorkManager, 'get' | 'reopen'>>;
}

export interface WorkChatServiceOptions {
  /** `QUOKY_WORK_SUMMARY_ENABLED`: false means a lookup never returns `summarize`. */
  readonly summaryEnabled: boolean;
  /** One deadline for availability check plus query. Defaults to 15 seconds. */
  readonly lookupDeadlineMs?: number;
  /**
   * ADR-0120 amendment A6: attach content-free action and listing receipts to to-do replies (`QUOKY_NL_ACTIONS` not
   * `off`). False (the default): every reply, read and write is exactly as before A6.
   */
  readonly actionReceipts?: boolean;
  /**
   * ADR-0120 amendment A8: the configured site host of each work source (`jira`: the Jira Cloud host). A Jira release
   * link in the owner's words is used only when its host equals this one; any other link is ignored and never fetched.
   */
  readonly linkHosts?: { readonly jira?: string };
}

export const WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS = 15_000;

const PERSONAL_WORK_FILTER: Readonly<Record<'my-items' | 'due-this-week' | 'review-requests', PersonalWorkFilter>> = {
  'my-items': 'all',
  'due-this-week': 'due-this-week',
  'review-requests': 'review-requested',
};

class LookupTimeoutError extends Error {
  constructor() {
    super('work-chat lookup timed out');
    this.name = 'LookupTimeoutError';
  }
}

async function withDeadline<T>(run: () => Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LookupTimeoutError()), deadlineMs);
  });
  const task = run();
  // A late rejection after the deadline must not surface as an unhandled rejection.
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compareTodos(left: WorkItem, right: WorkItem): number {
  return (
    (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** Letters and digits only, NFC lower-cased: trivial whitespace/punctuation/quote differences do not matter. */
function hintKey(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The shorter key of a partial hint match must have at least this many characters… */
const HINT_PARTIAL_MIN_CHARS = 3;
/** …and cover at least this share of the longer one ("QA 스윕 정리" ⊂ "내일 9시에 QA 스윕 정리"; never "회의" ⊂ "주간 회의 준비"). */
const HINT_PARTIAL_MIN_SHARE = 0.5;

function partialHintMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const shortLen = [...short].length;
  return shortLen >= HINT_PARTIAL_MIN_CHARS && shortLen / [...long].length >= HINT_PARTIAL_MIN_SHARE && long.includes(short);
}

/**
 * Exactly one open to-do named by an exact (hint-normalised) title or a listed number; else (live QA session 3, D11)
 * exactly one whose title contains the named text, or is contained in it, with a substantial overlap
 * ("QA 스윕 정리 완료" for the to-do "내일 9시에 QA 스윕 정리"). Anything else is `null`. A hint only — it never changes a to-do.
 */
function resolveHintTarget(todos: readonly WorkItem[], target: WorkChatTarget): { no: number; item: WorkItem } | null {
  if ('index' in target) {
    const item = todos[target.index - 1];
    return item ? { no: target.index, item } : null;
  }
  const wanted = hintKey(target.text);
  if (wanted.length === 0) return null;
  const numbered = todos.map((item, index) => ({ no: index + 1, item }));
  const exact = numbered.filter(({ item }) => item.title !== undefined && hintKey(item.title) === wanted);
  if (exact.length > 0) return exact.length === 1 ? (exact[0] as { no: number; item: WorkItem }) : null;
  const partial = numbered.filter(({ item }) => item.title !== undefined && partialHintMatch(hintKey(item.title), wanted));
  return partial.length === 1 ? (partial[0] as { no: number; item: WorkItem }) : null;
}

/** A6-D2 amendment: the open to-do the fresh listing showed under `label` (its live number kept for the receipt-free hint). */
function resolveListedHint(todos: readonly WorkItem[], label: number, listing: ListingSlot): { no: number; item: WorkItem } | null {
  const shown = listing.items.find((entry) => entry.label === label);
  const index = shown === undefined ? -1 : todos.findIndex((candidate) => candidate.id === shown.id);
  return index < 0 ? null : { no: index + 1, item: todos[index] as WorkItem };
}

/** A fixed instant: only "is this reminder-shaped at all" matters, never the resolved time. */
const REMINDER_SHAPE_PROBE_NOW = '2026-01-01T00:00:00.000Z';

/** Whether a to-do title contains a reminder-shaped phrase (reuses the ADR-0101 grammar; no duplicate rules). */
function looksReminderShaped(title: string): boolean {
  try {
    const parsed = parseReminderMessage(title, { now: REMINDER_SHAPE_PROBE_NOW });
    if (parsed.kind === 'CREATE' || parsed.kind === 'CREATE_EVENT_RELATIVE') return true;
    return parsed.kind === 'CLARIFY' && parsed.reason !== 'EMPTY_BODY' && parsed.reason !== 'MISSING_TIME';
  } catch {
    return false;
  }
}

type Resolution =
  | { readonly kind: 'found'; readonly no: number; readonly item: WorkItem }
  | { readonly kind: 'ambiguous'; readonly candidates: ReadonlyArray<{ no: number; item: WorkItem }> }
  | { readonly kind: 'none' };

/** A numbered target the owner's fresh listing cannot act on (A6-D2 amendment): nothing is written. */
type SnapshotDrift =
  /** The listing showed `label` for `id`, but that to-do is no longer open (or no longer exists). */
  | { readonly kind: 'gone'; readonly label: number; readonly id: string }
  /** The listing never showed `label` (out of range, or a row beyond what was rendered). */
  | { readonly kind: 'unlisted'; readonly label: number };

/**
 * A6-D2 amendment (2026-10-16): with a fresh listing, a numbered target is the item the owner SAW under that number,
 * found by id among the open to-dos — never the live ordinal. Title targets, and every target without a fresh listing,
 * resolve exactly as before (`resolveTarget`).
 */
function resolveListedTarget(todos: readonly WorkItem[], target: WorkChatTarget, listing: ListingSlot | undefined): Resolution | SnapshotDrift {
  if (!('index' in target) || listing === undefined) return resolveTarget(todos, target);
  const shown = listing.items.find((entry) => entry.label === target.index);
  if (shown === undefined) return { kind: 'unlisted', label: target.index };
  const item = todos.find((candidate) => candidate.id === shown.id);
  return item === undefined ? { kind: 'gone', label: target.index, id: shown.id } : { kind: 'found', no: target.index, item };
}

/**
 * The label a deterministic receipt may carry (A6-D2 amendment): the number the owner saw for this item in the fresh
 * listing, or — for an add (`liveNo`) — its live number only when the listing does not use that label for another item.
 * Without a fresh listing: none, so a deterministic reply (which shows no number) never writes a label the owner did not
 * see, and never turns into a partial listing that would later stop the live numbering.
 */
function receiptLabel(listing: ListingSlot | undefined, id: string, liveNo?: number): number | undefined {
  if (listing === undefined) return undefined;
  const own = listing.items.find((entry) => entry.id === id);
  if (own !== undefined) return own.label;
  if (liveNo === undefined || listing.items.some((entry) => entry.label === liveNo)) return undefined;
  return liveNo;
}

/** The number to name for an open to-do in a read-only hint: the listing's label, or the live number without one. */
function hintNumber(listing: ListingSlot | undefined, id: string, liveNo: number): number | undefined {
  if (listing === undefined) return liveNo;
  return listing.items.find((entry) => entry.id === id)?.label;
}

/** The owner's ACTIVE to-dos, `createdAt` ascending: the same order the combined view numbers them in. */
function resolveTarget(todos: readonly WorkItem[], target: WorkChatTarget): Resolution {
  if ('index' in target) {
    const item = todos[target.index - 1];
    return item ? { kind: 'found', no: target.index, item } : { kind: 'none' };
  }
  const wanted = fold(target.text);
  if (wanted.length === 0) return { kind: 'none' };
  const numbered = todos.map((item, index) => ({ no: index + 1, item }));
  const exact = numbered.filter(({ item }) => item.title !== undefined && fold(item.title) === wanted);
  const matches = exact.length > 0 ? exact : numbered.filter(({ item }) => item.title !== undefined && fold(item.title).includes(wanted));
  if (matches.length === 1) return { kind: 'found', ...(matches[0] as { no: number; item: WorkItem }) };
  return matches.length === 0 ? { kind: 'none' } : { kind: 'ambiguous', candidates: matches };
}

/**
 * CAP-011 chat entry point (ADR-0100 D10): executes work-chat commands. To-do commands run immediately through
 * `WorkManager` for the resolved owner Actor (LOW-risk local actions, no approval); lookups call only the connector
 * port's named read-only queries. It never calls a provider, never writes externally, and catches its own errors.
 */
export class WorkChatService implements WorkDesk {
  private readonly summaryEnabled: boolean;
  private readonly lookupDeadlineMs: number;
  private readonly actionReceipts: boolean;
  private readonly jiraSiteHost: string | undefined;

  constructor(
    private readonly deps: WorkChatServiceDeps,
    options: WorkChatServiceOptions,
  ) {
    this.summaryEnabled = options.summaryEnabled;
    this.lookupDeadlineMs = options.lookupDeadlineMs ?? WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS;
    this.actionReceipts = options.actionReceipts === true;
    this.jiraSiteHost = options.linkHosts?.jira;
  }

  forActor(actor: Actor): Promise<WorkSurface> {
    return this.deps.workSurface.forActor(actor);
  }

  configuredSources(): readonly WorkChatSource[] {
    const registered = new Set(this.deps.connectors.list().map((connector) => connector.source));
    return WORK_CHAT_SOURCES.filter((source) => registered.has(source));
  }

  async handle(command: WorkChatCommand, actor: Actor, options: WorkDeskHandleOptions = {}): Promise<WorkChatOutcome> {
    // A6-D2 amendment: the listing snapshot is honoured only while receipts (and so snapshots) are on.
    const listing = this.actionReceipts ? options.todoListing : undefined;
    if (command.kind === 'todo.hint') return this.completionHint(command, actor, listing);
    if (command.kind === 'todo.status') return this.statusAnswer(command, actor, listing);
    try {
      switch (command.kind) {
        case 'todo.add': {
          const added = await this.addTodoItem(command.title, command.refs, actor);
          return replyWith(added.body, added.item === undefined ? {} : await this.addReceipt(added.item, actor, listing));
        }
        case 'todo.list':
          // A status view (owner-approved 2026-10-15): read-only, unnumbered, never an A6 listing (numbers stay the open list's).
          if (command.kind === 'todo.list' && command.status !== undefined) return reply(await this.listTodosByStatus(command.status, actor));
        // falls through
        // ADR-0104 D3 (DET-2): a status question about the whole list is answered with the same store-backed view.
        case 'todo.summary': {
          const listed = await this.listWorkWithItems(actor, options.permit);
          return replyWith(listed.body, this.listingReceipt(listed.todos));
        }
        case 'todo.complete':
        case 'todo.cancel': {
          const status = command.kind === 'todo.complete' ? WorkItemStatus.COMPLETED : WorkItemStatus.CANCELED;
          const moved = await this.transitionTodoItem(command.target, status, actor, listing);
          return replyWith(moved.body, moved.updated === undefined ? { ...moved.extra } : this.transitionReceipt(command.kind, moved.updated, receiptLabel(listing, moved.updated.id)));
        }
        case 'todo.link': {
          const linked = await this.linkTodo(command.target, command.refs, actor, listing);
          return replyWith(linked.body, linked.extra ?? {});
        }
        case 'lookup':
          return await this.lookup(command.source, command.query, command.text, actor, command);
        case 'release':
          return await this.release(command, actor);
        case 'external-write-unsupported':
        // ADR-0112 D5: the turn handler hands an exact write request to the runtime's write flow; reaching the desk
        // (no handler in between) still answers with the fixed refusal — the desk never writes.
        case 'connector-write':
          return reply(renderExternalWriteRefusal(command.source));
        case 'usage':
          return reply(renderWorkChatUsage(command.topic));
      }
    } catch (error) {
      if (command.kind === 'todo.list' || command.kind === 'todo.summary') return reply(renderTodoListFailure());
      return reply(isTodoCommand(command) ? this.todoFailureText(error) : renderLookupFailure(lookupSource(command), 'UNAVAILABLE'));
    }
  }

  /**
   * Read-only status question (QA-V2-W7-05): exactly one of the actor's to-dos (open or closed) by exact normalised
   * title, or an open to-do by list number. Anything else is `none` and the turn falls through unchanged.
   */
  private async statusAnswer(
    command: Extract<WorkChatCommand, { kind: 'todo.status' }>,
    actor: Actor,
    listing?: ListingSlot,
  ): Promise<WorkChatOutcome> {
    try {
      const all = [...(await this.deps.work.listByActor(actor.id))].sort(compareTodos);
      const active = all.filter((item) => item.status === WorkItemStatus.ACTIVE);
      const target = command.target;
      let item: WorkItem | undefined;
      if ('index' in target) {
        // A6-D2 amendment: with a fresh listing, the number is the one the owner saw (an item no longer open falls through).
        const shown = listing?.items.find((entry) => entry.label === target.index);
        item = listing === undefined ? active[target.index - 1] : shown === undefined ? undefined : active.find((candidate) => candidate.id === shown.id);
      } else {
        const wanted = hintKey(target.text);
        const matches = wanted.length === 0 ? [] : all.filter((candidate) => candidate.title !== undefined && hintKey(candidate.title) === wanted);
        if (matches.length === 1) item = matches[0];
      }
      if (!item) return { kind: 'none' };
      const no = item.status === WorkItemStatus.ACTIVE ? hintNumber(listing, item.id, active.indexOf(item) + 1) : 0;
      return reply(renderTodoStatusAnswer(item, no));
    } catch {
      return { kind: 'none' };
    }
  }

  /**
   * Read-only: lists the actor's open to-dos, never transitions, never calls a provider. Any doubt means `none`.
   * Wrong state (ADR-0104 D3, DET-2): when no open to-do matches but exactly one closed to-do has exactly that title
   * ("주간 보고서 쓰기 완료" after "완료 처리: 1"), the reply says it is already completed or canceled.
   */
  private async completionHint(
    command: Extract<WorkChatCommand, { kind: 'todo.hint' }>,
    actor: Actor,
    listing?: ListingSlot,
  ): Promise<WorkChatOutcome> {
    try {
      const todos = await this.activeTodos(actor);
      // A6-D2 amendment: a numbered hint names the item the owner saw under that number (none still open: fall through),
      // and any hint names only a number the numbered command would resolve to the same item.
      const resolved =
        'index' in command.target && listing !== undefined ? resolveListedHint(todos, command.target.index, listing) : resolveHintTarget(todos, command.target);
      if (resolved) return reply(renderTodoCompletionHint(command.action, hintNumber(listing, resolved.item.id, resolved.no), resolved.item));
      if ('index' in command.target) return { kind: 'none' };
      const wanted = hintKey(command.target.text);
      if (wanted.length === 0) return { kind: 'none' };
      const closed = (await this.deps.work.listByActor(actor.id)).filter(
        (item) => item.status !== WorkItemStatus.ACTIVE && item.title !== undefined && hintKey(item.title) === wanted,
      );
      return closed.length === 1 ? reply(renderTodoStatusAnswer(closed[0] as WorkItem, 0)) : { kind: 'none' };
    } catch {
      return { kind: 'none' };
    }
  }

  // -- to-do commands (WorkManager only) --------------------------------------------------------------------------------

  /** The actor's to-dos of one status view (read-only; rows keep their status, no migration). */
  private async listTodosByStatus(status: TodoListStatusFilter, actor: Actor): Promise<MessageBody> {
    const wanted: ReadonlySet<WorkItemStatus> =
      status === 'canceled' ? new Set([WorkItemStatus.CANCELED]) : status === 'completed' ? new Set([WorkItemStatus.COMPLETED]) : new Set(Object.values(WorkItemStatus));
    const todos = (await this.deps.work.listByActor(actor.id)).filter((item) => wanted.has(item.status));
    return renderTodoStatusList([...todos].sort(compareTodos), status);
  }

  private async activeTodos(actor: Actor): Promise<WorkItem[]> {
    return [...(await this.deps.work.listActiveByActor(actor.id))].sort(compareTodos);
  }

  /** The anchored add, plus the created item (A6 receipts). The reply copy is unchanged. */
  private async addTodoItem(
    rawTitle: string,
    refs: readonly ResourceRef[],
    actor: Actor,
    condition?: ActionWriteCondition,
  ): Promise<{ readonly body: MessageBody; readonly item?: WorkItem }> {
    if (rawTitle.trim().length === 0) return { body: renderTodoEmptyTitle() };
    // A credential-bearing title is refused before anything is stored (ADR-0100 D5; the guard is unchanged, ADR-0097).
    if (containsCredentialMaterial(rawTitle)) return { body: renderTodoCredentialRefused() };
    let title: string;
    try {
      title = normalizeWorkItemTitle(rawTitle);
    } catch (error) {
      if (error instanceof WorkItemTitleError) {
        return { body: error.code === 'EMPTY' ? renderTodoEmptyTitle() : renderTodoTitleTooLong(WORK_ITEM_MAX_TITLE_LENGTH) };
      }
      throw error;
    }
    if (containsCredentialMaterial(title)) return { body: renderTodoCredentialRefused() };
    try {
      const item = await this.deps.work.create(
        {
          actorId: actor.id,
          title,
          resourceRefs: refs,
          origin: 'conversation',
        },
        ...(condition !== undefined ? [condition] : []),
      );
      return { body: renderTodoAdded(item, looksReminderShaped(title)), item };
    } catch (error) {
      if (error instanceof WorkItemCorrelationError && error.code === 'TOO_MANY_REFS') {
        return { body: renderTodoTooManyRefs(WORK_ITEM_MAX_RESOURCE_REFS) };
      }
      throw error;
    }
  }

  /**
   * The anchored complete / cancel, plus the updated item (A6 receipts). Copy unchanged. With a fresh listing a numbered
   * target is the listed item by id; a listed item no longer open, or a number the listing never showed, writes nothing
   * and answers with the current list (A6-D2 amendment).
   */
  private async transitionTodoItem(
    target: WorkChatTarget,
    status: WorkItemStatus,
    actor: Actor,
    listing: ListingSlot | undefined,
  ): Promise<{ readonly body: MessageBody; readonly updated?: WorkItem; readonly extra?: { readonly listing?: NlListingReceipt } }> {
    const todos = await this.activeTodos(actor);
    const action = status === WorkItemStatus.COMPLETED ? 'complete' : 'cancel';
    const resolution = resolveListedTarget(todos, target, listing);
    if (resolution.kind === 'gone' || resolution.kind === 'unlisted') return this.driftRefusal(resolution, todos, actor);
    if (resolution.kind === 'none') return { body: renderTodoNotFound(target, todos.length) };
    if (resolution.kind === 'ambiguous') return { body: renderTodoAmbiguous(action, resolution.candidates) };
    const updated = await this.deps.work.transition(resolution.item.id, status);
    return { body: status === WorkItemStatus.COMPLETED ? renderTodoCompleted(updated) : renderTodoCanceled(updated), updated };
  }

  /**
   * A6-D2 amendment: the refusal of a numbered command whose listed item drifted. It names what happened (the listed
   * item's title only when it is the actor's own) and shows the current open list, which becomes the new listing.
   */
  private async driftRefusal(
    drift: SnapshotDrift,
    todos: readonly WorkItem[],
    actor: Actor,
  ): Promise<{ readonly body: MessageBody; readonly extra: { readonly listing?: NlListingReceipt } }> {
    let item: WorkItem | undefined;
    if (drift.kind === 'gone' && this.deps.work.get !== undefined) {
      const found = await this.deps.work.get(drift.id);
      if (found !== null && found.actorId === actor.id && found.status !== WorkItemStatus.ACTIVE) item = found;
    }
    const shown = renderedTodoRows(todos);
    const body = renderTodoSnapshotDrift(
      drift.kind === 'unlisted' ? drift : { kind: 'gone', label: drift.label, ...(item !== undefined ? { item } : {}) },
      todos,
      shown,
    );
    return { body, extra: this.listingReceipt(todos) };
  }

  // -- ADR-0120 amendment A6: receipts and natural-language to-do actions ---------------------------------------------

  private async addReceipt(item: WorkItem, actor: Actor, listing: ListingSlot | undefined): Promise<{ readonly action?: NlActionReceipt }> {
    if (!this.actionReceipts) return {};
    let no: number | undefined;
    try {
      // A6-D2 amendment: the anchored add shows no number, so its live number is a label only when it extends the fresh
      // listing without renaming one of its labels.
      no = listing === undefined ? undefined : receiptLabel(listing, item.id, todoNumberOf(await this.activeTodos(actor), item.id));
    } catch {
      no = undefined;
    }
    return { action: { entryId: 'todo.add', result: 'executed', source: 'todo', itemId: item.id, ...(no !== undefined ? { label: no } : {}), version: item.updatedAt, undoable: true } };
  }

  private transitionReceipt(kind: 'todo.complete' | 'todo.cancel', item: WorkItem, no: number | undefined): { readonly action?: NlActionReceipt } {
    if (!this.actionReceipts) return {};
    return { action: { entryId: kind, result: 'executed', source: 'todo', itemId: item.id, ...(no !== undefined ? { label: no } : {}), version: item.updatedAt, undoable: true } };
  }

  /** The to-do rows as rendered (an empty list clears the slot, so an older list is never picked from). */
  private listingReceipt(todos: readonly WorkItem[]): { readonly listing?: NlListingReceipt } {
    if (!this.actionReceipts) return {};
    return { listing: { source: 'todo', items: todos.slice(0, renderedTodoRows(todos)).map((item, index) => ({ label: index + 1, id: item.id })) } };
  }

  /**
   * ADR-0120 amendment A6: one validated to-do action (A6-D1/D3), the target resolved by Core. Re-reads the item by id at
   * execution (A6-D2 step 5: it must exist, belong to the actor and be ACTIVE); never throws.
   */
  async handleAction(command: NlSelectedCommand, actor: Actor, condition?: ActionWriteCondition): Promise<WorkChatOutcome> {
    // A6-D3: every write below carries `condition`; the store evaluates it atomically with the write.
    try {
      switch (command.entryId) {
        case 'todo.add':
          return await this.actionAdd(command, actor, condition);
        case 'todo.complete':
        case 'todo.cancel':
          return await this.actionTransition(command, actor, condition);
        case 'action.undo':
          return command.target?.source === 'todo' ? await this.actionUndo(command, actor, condition) : { kind: 'none' };
        default:
          return { kind: 'none' };
      }
    } catch (error) {
      if (error instanceof ActionWriteStoppedError) return stoppedOutcome(command.entryId, command.language);
      return reply(renderTodoFailure());
    }
  }

  private async actionAdd(command: NlSelectedCommand, actor: Actor, condition?: ActionWriteCondition): Promise<WorkChatOutcome> {
    const title = typeof command.args.title === 'string' ? command.args.title : '';
    const added = await this.addTodoItem(title, [], actor, condition);
    if (added.item === undefined) return replyWith(added.body, { action: { entryId: 'todo.add', result: 'refused', source: 'todo', reason: 'invalid' } });
    const no = todoNumberOf(await this.activeTodos(actor), added.item.id) ?? 0;
    return replyWith(renderTodoActionAdded(added.item, no), {
      action: { entryId: 'todo.add', result: 'executed', source: 'todo', itemId: added.item.id, ...(no > 0 ? { label: no } : {}), version: added.item.updatedAt, undoable: true },
    });
  }

  private async actionTransition(command: NlSelectedCommand, actor: Actor, condition?: ActionWriteCondition): Promise<WorkChatOutcome> {
    const entryId = command.entryId as 'todo.complete' | 'todo.cancel';
    const status = entryId === 'todo.complete' ? WorkItemStatus.COMPLETED : WorkItemStatus.CANCELED;
    const todos = await this.activeTodos(actor);
    let item: WorkItem | undefined;
    let no: number | undefined;
    if (command.target?.id !== undefined) {
      // Execution-time check: re-read by id, owned, ACTIVE.
      item = todos.find((candidate) => candidate.id === command.target?.id);
      if (item === undefined) return replyWith(renderTodoActionNotActionable(), { action: { entryId, result: 'refused', source: 'todo', reason: 'already-final' } });
      no = command.target.label;
    } else {
      const match = typeof command.args.match === 'string' ? command.args.match : '';
      const wanted = fold(match);
      const numbered = todos.map((candidate, index) => ({ no: index + 1, item: candidate }));
      const exact = wanted.length === 0 ? [] : numbered.filter((candidate) => candidate.item.title !== undefined && fold(candidate.item.title) === wanted);
      if (exact.length !== 1) {
        const candidates = exact.length > 1 ? exact : [];
        return replyWith(renderTodoActionWhich(candidates), {
          action: {
            entryId,
            result: candidates.length > 0 ? 'asked' : 'refused',
            source: 'todo',
            reason: candidates.length > 0 ? 'ambiguous' : 'none',
            ...(candidates.length > 0 ? { candidates: candidates.slice(0, 10).map((candidate) => ({ label: candidate.no, id: candidate.item.id })) } : {}),
          },
        });
      }
      item = (exact[0] as { no: number; item: WorkItem }).item;
      no = (exact[0] as { no: number; item: WorkItem }).no;
    }
    const updated = await this.deps.work.transition(item.id, status, condition);
    return replyWith(renderTodoActionTransitioned(updated, no, entryId === 'todo.complete' ? 'complete' : 'cancel'), {
      action: { entryId, result: 'executed', source: 'todo', itemId: updated.id, ...(no !== undefined ? { label: no } : {}), version: updated.updatedAt, undoable: true },
    });
  }

  /** Record A: the per-action inverse of a to-do action; an inverse that cannot run is said plainly. */
  private async actionUndo(command: NlSelectedCommand, actor: Actor, condition?: ActionWriteCondition): Promise<WorkChatOutcome> {
    const id = command.target?.id;
    const undone = command.undo?.entryId;
    const refused = (reason: 'already-final' | 'changed' | 'not-found' | 'not-final') =>
      replyWith(renderTodoUndoRefused(reason), { action: { entryId: 'action.undo', result: 'refused', source: 'todo', reason } });
    if (id === undefined || undone === undefined || this.deps.work.get === undefined) return refused('not-found');
    const item = await this.deps.work.get(id);
    if (item === null || item.actorId !== actor.id) return refused('not-found');
    if (undone === 'todo.add') {
      if (item.status !== WorkItemStatus.ACTIVE) return refused('already-final');
      const canceled = await this.deps.work.transition(item.id, WorkItemStatus.CANCELED, condition);
      return replyWith(renderTodoActionAddUndone(canceled), {
        action: { entryId: 'action.undo', result: 'undone', source: 'todo', itemId: canceled.id, undoOf: 'todo.add', undoable: false },
      });
    }
    if (undone !== 'todo.complete' && undone !== 'todo.cancel') return refused('not-found');
    if (this.deps.work.reopen === undefined || command.undo?.version === undefined) return refused('changed');
    let reopened: WorkItem;
    try {
      reopened = await this.deps.work.reopen(item.id, command.undo.version, condition);
    } catch (error) {
      if (error instanceof WorkItemReopenError) return refused(error.code === 'CHANGED' ? 'changed' : 'not-final');
      throw error;
    }
    const no = todoNumberOf(await this.activeTodos(actor), reopened.id);
    return replyWith(renderTodoActionReopened(reopened, no), {
      action: { entryId: 'action.undo', result: 'undone', source: 'todo', itemId: reopened.id, ...(no !== undefined ? { label: no } : {}), undoOf: undone, version: reopened.updatedAt, undoable: false },
    });
  }

  private async linkTodo(
    target: WorkChatTarget,
    refs: readonly ResourceRef[],
    actor: Actor,
    listing: ListingSlot | undefined,
  ): Promise<{ readonly body: MessageBody; readonly extra?: { readonly listing?: NlListingReceipt } }> {
    if (refs.length === 0) return { body: renderWorkChatUsage('todo-link') };
    const todos = await this.activeTodos(actor);
    const resolution = resolveListedTarget(todos, target, listing);
    if (resolution.kind === 'gone' || resolution.kind === 'unlisted') return this.driftRefusal(resolution, todos, actor);
    if (resolution.kind === 'none') return { body: renderTodoNotFound(target, todos.length) };
    if (resolution.kind === 'ambiguous') return { body: renderTodoAmbiguous('link', resolution.candidates) };
    const known = new Set(resolution.item.resourceRefs.map((ref) => ref.identity));
    const added = refs.filter((ref, index) => !known.has(ref.identity) && refs.findIndex((r) => r.identity === ref.identity) === index);
    if (known.size + added.length > WORK_ITEM_MAX_RESOURCE_REFS) return { body: renderTodoTooManyRefs(WORK_ITEM_MAX_RESOURCE_REFS) };
    // No connector call at link time (ADR-0100 D6).
    const updated = await this.deps.work.correlate(resolution.item.id, refs);
    return { body: renderTodoLinked(updated, added) };
  }

  private todoFailureText(error: unknown): string {
    if (error instanceof WorkItemCorrelationError) {
      return error.code === 'NOT_ACTIVE' ? renderTodoNotActive() : renderTodoTooManyRefs(WORK_ITEM_MAX_RESOURCE_REFS);
    }
    return renderTodoFailure();
  }

  // -- combined view ------------------------------------------------------------------------------------------------

  private async listWorkWithItems(actor: Actor, permit?: SurfacePermit): Promise<{ readonly body: MessageBody; readonly todos: readonly WorkItem[] }> {
    const todos = await this.activeTodos(actor);
    // ADR-0122 D2.4: without a permit every section is read exactly as before; with one, a withheld section is not read.
    if (permit === undefined) {
      let surface: WorkSurface | null = null;
      try {
        surface = await this.deps.workSurface.forActor(actor);
      } catch {
        surface = null;
      }
      return { body: renderMyWork(todos, surface), todos };
    }
    const { sources, withheld } = surfacePermittedWorkSources(permit);
    let surface: WorkSurface | null = null;
    if (sources.length > 0) {
      try {
        surface = await this.deps.workSurface.forActor(actor, { sources });
      } catch {
        surface = null;
      }
    }
    return { body: renderMyWork(todos, surface, withheld), todos };
  }

  // -- connector lookups (named read-only queries only) --------------------------------------------------------------

  /**
   * ADR-0120 amendment A8: one Jira release (or a project's release list), read-only through the `containers`,
   * `releases` and `release-items` named queries, under the same lookup deadline. Always the deterministic list: a
   * release report is never summarised by a model (no item text leaves the host).
   */
  private async release(command: Extract<WorkChatCommand, { kind: 'release' }>, actor: Actor): Promise<WorkChatOutcome> {
    const connector = this.deps.connectors.list().find((candidate) => candidate.source === 'jira');
    if (!connector) return reply(renderLookupFailure('jira', 'NOT_CONFIGURED'));
    const identity = actor.identities
      .filter((candidate) => candidate.platform === 'jira')
      .map((candidate) => candidate.externalId.trim())
      .filter(Boolean)
      .sort()[0];
    let result: Awaited<ReturnType<typeof lookupJiraRelease>>;
    // The deadline also stops the chain: no further query starts once it passed (a request in flight is not cancelled).
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.lookupDeadlineMs);
    try {
      result = await withDeadline(
        () =>
          lookupJiraRelease({
            connector,
            command,
            signal: deadline.signal,
            ...(command.inChannel === true ? { inChannel: true } : {}),
            ...(identity !== undefined ? { identity } : {}),
            ...(this.jiraSiteHost !== undefined ? { siteHost: this.jiraSiteHost } : {}),
          }),
        this.lookupDeadlineMs,
      );
    } catch (error) {
      return reply(renderLookupFailure('jira', failureReason(error)));
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
    if (result.kind === 'failure') return reply(renderLookupFailure('jira', result.reason));
    return { ...messageFields(result.body), kind: 'reply', ...(result.listed !== undefined ? { listed: result.listed } : {}) };
  }

  private async lookup(
    source: WorkChatSource,
    query: WorkChatLookupQuery,
    rawText: string | undefined,
    actor: Actor,
    options: Pick<Extract<WorkChatCommand, { kind: 'lookup' }>, 'personalWork' | 'limit' | 'listOnly'> = {},
  ): Promise<WorkChatOutcome> {
    const supported = WORK_CHAT_SOURCE_QUERIES[source];
    if (!supported.includes(query)) return reply(renderLookupUnsupported(source, query, supported));

    let searchText: string | undefined;
    // A keyword on `my-items` filters the owner's own items locally; it is validated like a search text.
    const keywordFilter = query === 'my-items' && rawText !== undefined;
    if (query === 'search' || keywordFilter) {
      // eslint-disable-next-line no-control-regex
      searchText = (rawText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (searchText.length === 0) return reply(renderWorkChatUsage('search'));
      if (Array.from(searchText).length > WORK_CHAT_SEARCH_TEXT_MAX_LENGTH) return reply(renderWorkChatUsage('search-too-long'));
      // Search text leaves the machine: a credential-bearing query is never sent.
      if (containsCredentialMaterial(searchText)) return reply(renderSearchCredentialRefused());
    }

    const connector = this.deps.connectors.list().find((candidate) => candidate.source === source);
    if (!connector) return reply(renderLookupFailure(source, 'NOT_CONFIGURED'));

    let namedQuery: ConnectorQuery;
    if (query === 'search') {
      namedQuery = { query: ConnectorQueryName.SEARCH, params: { text: searchText as string, limit: CONNECTOR_QUERY_MAX_LIMIT } };
    } else {
      const identity = actor.identities
        .filter((candidate) => candidate.platform === source)
        .map((candidate) => candidate.externalId.trim())
        .filter(Boolean)
        .sort()[0];
      if (!identity) return reply(renderLookupFailure(source, 'IDENTITY_MISSING'));
      // ADR-0120 D13: the optional window/role/status reach the named query only when selection set them.
      const personalWork = options.personalWork;
      namedQuery = {
        query: ConnectorQueryName.PERSONAL_WORK,
        params: {
          actorExternalId: identity,
          filter: PERSONAL_WORK_FILTER[query],
          limit: CONNECTOR_QUERY_MAX_LIMIT,
          ...(personalWork?.window !== undefined ? { window: { ...personalWork.window } } : {}),
          ...(personalWork?.role !== undefined ? { role: personalWork.role } : {}),
          ...(personalWork?.status !== undefined ? { status: personalWork.status } : {}),
          ...(personalWork?.sort !== undefined ? { sort: personalWork.sort } : {}),
        },
      };
    }

    let result: Awaited<ReturnType<ConnectorProvider['query']>> | 'UNAVAILABLE';
    try {
      result = await withDeadline(async () => {
        if (!(await connector.isAvailable())) return 'UNAVAILABLE' as const;
        return connector.query(namedQuery);
      }, this.lookupDeadlineMs);
    } catch (error) {
      return reply(renderLookupFailure(source, failureReason(error)));
    }
    if (result === 'UNAVAILABLE') return reply(renderLookupFailure(source, 'UNAVAILABLE'));

    let items = Array.isArray(result.items) ? result.items : [];
    const fetched = items.length;
    if (keywordFilter) {
      const needle = (searchText as string).toLowerCase();
      items = items.filter((item) => [item.title ?? '', item.summary ?? ''].join('\n').toLowerCase().includes(needle));
    }
    // ADR-0120 D4: a selected "N개만" shows at most N items (the list says it was cut).
    const limited = options.limit !== undefined && items.length > options.limit;
    if (options.limit !== undefined) items = items.slice(0, options.limit);
    const builtFull = buildExternalWorkReadout({
      source,
      query,
      ...(searchText !== undefined ? { text: searchText } : {}),
      items,
    });
    const built = limited ? { ...builtFull, truncated: true } : builtFull;
    // The connector returns a bounded page of the owner's items: when it was full, a filtered list may be incomplete.
    const readout = keywordFilter && fetched >= CONNECTOR_QUERY_MAX_LIMIT ? { ...built, truncated: true } : built;
    const fallbackText = renderExternalWorkList(readout);
    if (this.summaryEnabled && readout.items.length > 0 && options.listOnly !== true) {
      const summaryReadout = fitExternalWorkReadoutToPrompt(readout);
      return { kind: 'summarize', readout: summaryReadout, fallbackText, footer: renderExternalWorkFooter(summaryReadout) };
    }
    const listed: WorkChatOutcome = { ...messageFields(fallbackText), kind: 'reply', listed: { count: readout.items.length, truncated: readout.truncated } };
    return listed;
  }
}

function reply(body: MessageBody): WorkChatOutcome {
  return { kind: 'reply', ...messageFields(body) };
}

/** The kill switch stopped a to-do action at its mutation (A6-D3): nothing changed. */
function stoppedOutcome(entryId: NlSelectedCommand['entryId'], language: NlSelectedCommand['language']): WorkChatOutcome {
  return replyWith(renderActionStopped(language), { action: { entryId: entryId as NlActionReceipt['entryId'], result: 'refused', source: 'todo', reason: 'stopped' } });
}

/** A reply plus the A6 receipts (absent fields are simply not set, so a receipt-free reply equals `reply(body)`). */
function replyWith(body: MessageBody, extra: { readonly action?: NlActionReceipt; readonly listing?: NlListingReceipt }): WorkChatOutcome {
  return {
    kind: 'reply',
    ...messageFields(body),
    ...(extra.action !== undefined ? { action: extra.action } : {}),
    ...(extra.listing !== undefined ? { listing: extra.listing } : {}),
  };
}

function failureReason(error: unknown): WorkChatLookupFailure {
  if (error instanceof LookupTimeoutError) return 'TIMEOUT';
  if (isConnectorQueryError(error)) return error.reason;
  return 'UNAVAILABLE';
}

function isTodoCommand(command: WorkChatCommand): boolean {
  return command.kind.startsWith('todo.');
}

function lookupSource(command: WorkChatCommand): WorkChatSource {
  return command.kind === 'lookup' || command.kind === 'release' || command.kind === 'external-write-unsupported' || command.kind === 'connector-write'
    ? command.source
    : 'jira';
}
