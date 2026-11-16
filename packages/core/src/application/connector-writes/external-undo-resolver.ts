import type { Actor, Id, IsoTimestamp, Session, Task } from '../../domain';
import { ConnectorWriteOperation, type ConnectorWriteReceipt, type ConnectorWriteReceiptRepository } from '../../ports';
import {
  activeExternalUndoCapabilities,
  externalUndoFamilyOf,
  isLastActionExternalSource,
  readSessionLastAction,
  type ExternalUndoFamily,
} from '../nl-routing/last-action';
import type { ConnectorWriteAnchor } from './connector-write-flow';
import type { ExternalUndoDraft, ExternalUndoDraftKind } from './connector-write-draft';

/**
 * ADR-0112 amendment 3 (O1): the Core resolver of "undo the approved external write I just made". It turns this session's
 * own `lastAction` into an undo draft `{ kind, receiptId }`, never from text, a link or a listing:
 *
 *   lastAction (this Session + Actor, fresh or echo-replied, SENT, not undone, family in the capability set)
 *     -> receipt by id for THIS actor (`findById`) of the family's operation, SENT, with a well-formed external reference
 *     -> the approval's anchor Task (`lastAction.anchorTaskId`), same actor and session, same operation, SENT
 *     -> `{ kind, receiptId }`
 *
 * Every other state is `nothing-to-undo` with a value-free reason (no id, text or reference in it). A `lastAction` whose
 * `itemId` is not a receipt (the anchor task id the runtime falls back to when a write left no receipt) finds no receipt
 * and so means nothing to undo. Only a family in the capability set resolves (ADR-0112 amendment 3); any other family stays closed until its slice opens it.
 *
 * It never calls a writer and the nl-routing layer never imports it (an import scan pins that).
 */

export type ExternalUndoRefusal =
  | 'no-last-action'
  | 'stale'
  | 'echo-mismatch'
  | 'not-external'
  | 'not-open'
  | 'not-sent'
  | 'already-undone'
  | 'receipt-missing'
  | 'receipt-mismatch'
  | 'malformed-ref'
  | 'anchor-missing'
  | 'anchor-mismatch';

export type ExternalUndoResolution =
  | {
      readonly kind: 'resolved';
      readonly draft: ExternalUndoDraft;
      readonly family: ExternalUndoFamily;
      readonly receipt: ConnectorWriteReceipt;
      readonly anchor: ConnectorWriteAnchor;
      readonly anchorTaskId: Id;
    }
  | { readonly kind: 'nothing-to-undo'; readonly reason: ExternalUndoRefusal };

interface FamilySpec {
  readonly draftKind: ExternalUndoDraftKind;
  readonly operation: ConnectorWriteOperation;
  /** Whether the receipt's `externalRef` has the exact form this family's inverse needs. */
  readonly refOk: (ref: string) => boolean;
}

/** A Google Calendar event id: base32hex characters, 5 to 1024 long (what the writer derives and the receipt keeps). */
const CALENDAR_EVENT_ID = /^[0-9a-v]{5,1024}$/;
/**
 * The id of an event Quoky changed or deleted (any event of the calendar, so not only the ids Quoky derives): the bounded
 * id alphabet the writer itself accepts. The flow additionally requires it to equal the id the approved payload named.
 */
const CHANGED_EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
/** A Jira comment id (digits), as the comment writer returns it. */
const COMMENT_ID = /^[0-9]{1,20}$/;
/** A Jira transition receipt reference: `<issue key>:<transition id>`, as the transition writer returns it. */
const TRANSITION_REF = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,9}:[0-9]{1,20}$/;
/** A Slack post receipt reference: `<channel id>:<message ts>`, exactly as the post writer returns it. */
export const CHANNEL_POST_REF = /^([CG][A-Z0-9]{8,20}):([0-9]{1,12}\.[0-9]{1,8})$/;

const FAMILIES: Readonly<Record<ExternalUndoFamily, FamilySpec>> = {
  'calendar-create': {
    draftKind: 'calendar-create-undo',
    operation: ConnectorWriteOperation.CALENDAR_EVENT_CREATE,
    refOk: (ref) => CALENDAR_EVENT_ID.test(ref),
  },
  'calendar-update': {
    draftKind: 'calendar-update-undo',
    operation: ConnectorWriteOperation.CALENDAR_EVENT_UPDATE,
    refOk: (ref) => CHANGED_EVENT_ID.test(ref),
  },
  'calendar-delete': {
    draftKind: 'calendar-delete-undo',
    operation: ConnectorWriteOperation.CALENDAR_EVENT_DELETE,
    refOk: (ref) => CHANGED_EVENT_ID.test(ref),
  },
  'jira-comment': {
    draftKind: 'jira-comment-undo',
    operation: ConnectorWriteOperation.ISSUE_COMMENT,
    refOk: (ref) => COMMENT_ID.test(ref),
  },
  'jira-transition': {
    draftKind: 'jira-transition-undo',
    operation: ConnectorWriteOperation.ISSUE_TRANSITION,
    refOk: (ref) => TRANSITION_REF.test(ref),
  },
  'slack-post': {
    draftKind: 'slack-post-undo',
    operation: ConnectorWriteOperation.CHANNEL_POST,
    refOk: (ref) => CHANNEL_POST_REF.test(ref),
  },
};

/** The draft kind of a family's undo (the only place the family-to-kind mapping lives). */
export function externalUndoDraftKindOf(family: ExternalUndoFamily): ExternalUndoDraftKind {
  return FAMILIES[family].draftKind;
}

export interface ExternalUndoResolverDeps {
  readonly receipts: Pick<ConnectorWriteReceiptRepository, 'findById'>;
  readonly tasks: { get(id: Id): Promise<Task | null> };
  /** Reads the connector-write anchor off a Task (injected: this file never imports the flow's runtime values). */
  readonly readAnchor: (task: Task) => ConnectorWriteAnchor | undefined;
  /** The families whose undo is built; defaults to the active capability set (the production constant). */
  readonly capabilities?: readonly ExternalUndoFamily[];
}

export interface ExternalUndoInput {
  readonly session: Pick<Session, 'id' | 'metadata'>;
  readonly actor: Pick<Actor, 'id'>;
  readonly now: IsoTimestamp;
  /** The platform id of the message the owner replied to, when the undo is a reply to an action's echo. */
  readonly replyToMessageId?: string;
}

export class ExternalUndoResolver {
  constructor(private readonly deps: ExternalUndoResolverDeps) {}

  async resolve(input: ExternalUndoInput): Promise<ExternalUndoResolution> {
    const nothing = (reason: ExternalUndoRefusal): ExternalUndoResolution => ({ kind: 'nothing-to-undo', reason });
    const view = readSessionLastAction(input.session, input.actor.id, input.now);
    if (view === undefined) return nothing('no-last-action');
    const { record } = view;
    // The same window rule as the local undo: the latest action within 10 minutes, or the action a reply to its echo names.
    if (input.replyToMessageId !== undefined) {
      if (!record.echoReplyIds.includes(input.replyToMessageId)) return nothing('echo-mismatch');
    } else if (!view.fresh) {
      return nothing('stale');
    }
    if (record.entryId === 'action.undo' || record.undone) return nothing('already-undone');
    if (!isLastActionExternalSource(record.source)) return nothing('not-external');
    if (record.outcome !== 'SENT') return nothing('not-sent');
    const family = externalUndoFamilyOf(record.entryId, record.operation);
    const capabilities = this.deps.capabilities ?? activeExternalUndoCapabilities();
    if (family === undefined || !capabilities.includes(family) || !record.undoable) return nothing('not-open');
    return this.bindOrigin(family, input, record.itemId, record.anchorTaskId);
  }

  /**
   * Review round 1 (P2-A): re-validates an origin this resolver already resolved (a numbered continuation of an undo, the
   * revert choice), WITHOUT re-reading `lastAction` recency: the window was checked when the origin was resolved, and the
   * choice anchor itself is next-turn only and expires with the anchor lifetime. The same receipt and anchor must still be
   * this actor's own SENT write in this session, the anchor's approval must still be the one that produced the receipt, and
   * the family must still be open. Never called with ids from text: only with the ids pinned on the choice anchor.
   */
  async revalidate(input: Pick<ExternalUndoInput, 'session' | 'actor'> & { readonly family: ExternalUndoFamily; readonly receiptId: Id; readonly anchorTaskId: Id }): Promise<ExternalUndoResolution> {
    const capabilities = this.deps.capabilities ?? activeExternalUndoCapabilities();
    if (!capabilities.includes(input.family)) return { kind: 'nothing-to-undo', reason: 'not-open' };
    return this.bindOrigin(input.family, input, input.receiptId, input.anchorTaskId);
  }

  /** The receipt and anchor checks shared by {@link resolve} and {@link revalidate}. */
  private async bindOrigin(
    family: ExternalUndoFamily,
    input: Pick<ExternalUndoInput, 'session' | 'actor'>,
    receiptId: Id,
    anchorTaskId: Id | undefined,
  ): Promise<ExternalUndoResolution> {
    const nothing = (reason: ExternalUndoRefusal): ExternalUndoResolution => ({ kind: 'nothing-to-undo', reason });
    const spec = FAMILIES[family];
    const receipt = await this.deps.receipts.findById(receiptId, input.actor.id);
    if (receipt === null || receipt.actorId !== input.actor.id) return nothing('receipt-missing');
    if (receipt.operation !== spec.operation || receipt.status !== 'SENT') return nothing('receipt-mismatch');
    const ref = receipt.data.externalRef;
    if (typeof ref !== 'string' || !spec.refOk(ref)) return nothing('malformed-ref');

    if (anchorTaskId === undefined) return nothing('anchor-missing');
    const task = await this.deps.tasks.get(anchorTaskId);
    const anchor = task === null ? undefined : this.deps.readAnchor(task);
    if (task === null || anchor === undefined) return nothing('anchor-missing');
    if (
      anchor.actorId !== input.actor.id ||
      anchor.sessionId !== input.session.id ||
      anchor.operation !== spec.operation ||
      anchor.status !== 'SENT'
    ) {
      return nothing('anchor-mismatch');
    }
    // Defence in depth: the receipt must be the one THIS anchor's approval produced (idempotency key `cwr:<approvalId>`, same
    // connector, target and payload hash), not merely another SENT receipt of the same actor and operation.
    if (
      anchor.approvalId === undefined ||
      receipt.idempotencyKey !== `cwr:${anchor.approvalId}` ||
      receipt.payloadSha256 !== anchor.payloadSha256 ||
      receipt.target !== anchor.target ||
      receipt.connector !== anchor.connector
    ) {
      return nothing('receipt-mismatch');
    }
    return { kind: 'resolved', draft: { kind: spec.draftKind, receiptId: receipt.id }, family, receipt, anchor, anchorTaskId: task.id };
  }
}
