import type { Actor, Id, IsoTimestamp, Session, Task } from '../../domain';
import { ConnectorWriteOperation, type ConnectorWriteReceipt, type ConnectorWriteReceiptRepository } from '../../ports';
import {
  EXTERNAL_UNDO_CAPABILITIES,
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
 * and so means nothing to undo. The capability set is empty in the foundation slice: nothing resolves until a family opens.
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

const FAMILIES: Readonly<Record<ExternalUndoFamily, FamilySpec>> = {
  'calendar-create': {
    draftKind: 'calendar-create-undo',
    operation: ConnectorWriteOperation.CALENDAR_EVENT_CREATE,
    refOk: (ref) => CALENDAR_EVENT_ID.test(ref),
  },
};

export interface ExternalUndoResolverDeps {
  readonly receipts: Pick<ConnectorWriteReceiptRepository, 'findById'>;
  readonly tasks: { get(id: Id): Promise<Task | null> };
  /** Reads the connector-write anchor off a Task (injected: this file never imports the flow's runtime values). */
  readonly readAnchor: (task: Task) => ConnectorWriteAnchor | undefined;
  /** The families whose undo is built; defaults to the closed constant (empty in the foundation slice). */
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
    const family = externalUndoFamilyOf(record.entryId);
    const capabilities = this.deps.capabilities ?? EXTERNAL_UNDO_CAPABILITIES;
    if (family === undefined || !capabilities.includes(family)) return nothing('not-open');
    const spec = FAMILIES[family];

    const receipt = await this.deps.receipts.findById(record.itemId, input.actor.id);
    if (receipt === null || receipt.actorId !== input.actor.id) return nothing('receipt-missing');
    if (receipt.operation !== spec.operation || receipt.status !== 'SENT') return nothing('receipt-mismatch');
    const ref = receipt.data.externalRef;
    if (typeof ref !== 'string' || !spec.refOk(ref)) return nothing('malformed-ref');

    if (record.anchorTaskId === undefined) return nothing('anchor-missing');
    const task = await this.deps.tasks.get(record.anchorTaskId);
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
    return { kind: 'resolved', draft: { kind: spec.draftKind, receiptId: receipt.id }, family, receipt, anchor, anchorTaskId: task.id };
  }
}
