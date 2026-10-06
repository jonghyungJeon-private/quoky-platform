import type { Id, IsoTimestamp } from '../domain';
import type {
  ConnectorWriteNotSentReason,
  ConnectorWriteOperation,
  ConnectorWriteOutcome,
  ConnectorWriteUncertainReason,
} from './connector-write.port';

/**
 * PORT: connector write receipts (ADR-0112 D3, schema v15; DI token `CONNECTOR_WRITE_RECEIPT_REPOSITORY`).
 *
 * Deliberately NOT part of `StorageProvider`. One receipt per idempotency key (UNIQUE). The receipt holds the target,
 * the operation and the payload SHA-256 only: there is NO payload text, and `data` holds only the outcome's
 * external reference, link and reason. State machine (at most once):
 *
 *   PREPARED ──(write outcome)──▶ SENT | NOT_SENT | UNCERTAIN
 *   PREPARED ──(found at startup)──▶ UNCERTAIN
 *
 * `PREPARED` is written before any network call; a terminal receipt never changes again.
 */

export const ConnectorWriteReceiptStatus = {
  PREPARED: 'PREPARED',
  SENT: 'SENT',
  NOT_SENT: 'NOT_SENT',
  UNCERTAIN: 'UNCERTAIN',
} as const;
export type ConnectorWriteReceiptStatus = (typeof ConnectorWriteReceiptStatus)[keyof typeof ConnectorWriteReceiptStatus];

/** Outcome details only. Never the payload, a credential or a provider response body. */
export interface ConnectorWriteReceiptData {
  externalRef?: string;
  url?: string;
  reason?: ConnectorWriteNotSentReason | ConnectorWriteUncertainReason | 'INTERRUPTED';
}

export interface ConnectorWriteReceipt {
  id: Id;
  actorId: Id;
  idempotencyKey: string;
  /** The writer's neutral source label (audit data; never branched on). */
  connector: string;
  operation: ConnectorWriteOperation;
  /** The normalized target (issue key, channel id, `primary` or `primary/<eventId>`). Never payload text. */
  target: string;
  /** Lowercase hex SHA-256 of the canonical payload. */
  payloadSha256: string;
  status: ConnectorWriteReceiptStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  data: ConnectorWriteReceiptData;
}

/** The identity of a write, used to find an earlier SENT receipt for the same target and payload (ADR-0112 D6). */
export interface ConnectorWriteMatch {
  actorId: Id;
  connector: string;
  operation: ConnectorWriteOperation;
  target: string;
  payloadSha256: string;
}

export type ConnectorWritePrepareResult =
  | { readonly created: true; readonly receipt: ConnectorWriteReceipt }
  /** A receipt with this idempotency key already exists; nothing was written and the caller must not send. */
  | { readonly created: false; readonly receipt: ConnectorWriteReceipt };

export interface ConnectorWriteReceiptRepository {
  /** Insert a `PREPARED` receipt, or return the existing receipt for its idempotency key unchanged. */
  prepare(receipt: ConnectorWriteReceipt): Promise<ConnectorWritePrepareResult>;
  /**
   * Record the write outcome on a `PREPARED` receipt (compare-and-set). Returns the updated receipt, or null when the
   * receipt does not exist or is no longer `PREPARED` (a terminal receipt never changes).
   */
  complete(id: Id, outcome: ConnectorWriteOutcome, now: IsoTimestamp): Promise<ConnectorWriteReceipt | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<ConnectorWriteReceipt | null>;
  /** The newest `SENT` receipt for the same actor, connector, operation, target and payload hash, or null. */
  findLatestSent(match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null>;
  /**
   * Startup reconciliation: every `PREPARED` receipt (a write interrupted mid-flight) becomes `UNCERTAIN` with reason
   * `INTERRUPTED`. Returns the number of receipts changed. Must run before any new write.
   */
  markInterruptedPreparedUncertain(now: IsoTimestamp): Promise<number>;
}
