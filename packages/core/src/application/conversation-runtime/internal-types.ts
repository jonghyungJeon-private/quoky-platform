import {
  type ConnectorWriteLatestRequest,
  type ConnectorWriteRecentSend,
} from '../connector-writes/connector-write-flow';
import { type NlCatalogEntry } from '../nl-routing/catalog';
import {
  type ShownListing,
} from '../nl-routing/honest-chat';
import type {
  ContextFile,
  ExecutionPlanRef,
  IsoTimestamp,
  WorkspaceRef,
} from '../../domain';
import {
  type ConnectorWriteOperation,
} from '../../ports';
import {
  type CodeGenerationContextResult,
} from '../code-generation-context';

/** ADR-0120 D9: what the chat turn after a `none` (or unavailable) selection carries — the configured entries. */
export interface NlChatFacts {
  readonly entries: readonly NlCatalogEntry[];
  /**
   * #280 follow-up: the listing the previous turn showed (Core's own `lastSelection` record, read at the start of this
   * turn) and whether a quoted command re-runs exactly that listing (the handlers' pure Class B probes). Absent when no
   * offered listing was shown.
   */
  readonly listing?: { readonly shown: ShownListing; readonly rerunsListing: (segment: string) => boolean };
}

/** A code-change preview's refs, targets and prepared (read, classified, grant-checked) context content. */
/** This conversation's most recent write of one kind (stray-phrase replies; Codex P2 on 039d5ff). */
export type RecentConnectorWrite =
  | { readonly kind: 'sent'; readonly operation: ConnectorWriteOperation; readonly sent: ConnectorWriteRecentSend; readonly at: IsoTimestamp }
  | {
      readonly kind: 'latest';
      readonly operation: ConnectorWriteOperation;
      readonly latest: ConnectorWriteLatestRequest & { readonly state: { readonly kind: 'closed' | 'not-sent' } };
      /** An older request of the kind may have been sent (UNCERTAIN / in flight, no later SENT). */
      readonly olderUnconfirmed: boolean;
      readonly at: IsoTimestamp;
    }
  | {
      readonly kind: 'unconfirmed';
      readonly operation: ConnectorWriteOperation;
      readonly status: 'UNCERTAIN' | 'EXECUTING';
      readonly at: IsoTimestamp;
    };

export interface PreparedCodeGeneration {
  readonly planRef: ExecutionPlanRef;
  readonly workspaceRef: WorkspaceRef;
  readonly targetFiles: string[];
  readonly contextFiles: ContextFile[];
}

export type CodeGenerationPreparation =
  | { readonly ok: true; readonly value: PreparedCodeGeneration }
  | { readonly ok: false; readonly failure: 'missing-refs' }
  | {
      readonly ok: false;
      readonly failure: 'context';
      readonly context: Extract<CodeGenerationContextResult, { ok: false }>;
    };

/** ADR-0120 D6 Phase C: a selection already made at a Class B position this turn (the honest-chat fact it left, if any). */
export interface NlEarlySelection {
  readonly facts?: NlChatFacts;
  /** The selector ran at a Class B position and answered `none` (live UAT R9): the frozen surface clause must not answer. */
  readonly declined?: true;
}
