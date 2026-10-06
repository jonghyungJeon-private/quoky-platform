import type { Id, IsoTimestamp } from '../../domain';
import {
  CONNECTOR_WRITE_OPERATIONS,
  connectorWriteUncertain,
  type ConnectorWriteOperation,
  type ConnectorWriteOutcome,
  type ConnectorWriteReceipt,
  type ConnectorWriteReceiptRepository,
} from '../../ports';
import { isConnectorWriteIdempotencyKey, isConnectorWritePayloadSha256 } from './connector-write-payload';

/** Bound on receipt target and connector labels. */
const TARGET_MAX_LENGTH = 300;
const CONNECTOR_LABEL = /^[a-z][a-z0-9-]{0,39}$/;

export interface ConnectorWriteExecutionRequest {
  readonly actorId: Id;
  readonly idempotencyKey: string;
  readonly connector: string;
  readonly operation: ConnectorWriteOperation;
  readonly target: string;
  readonly payloadSha256: string;
}

export type ConnectorWriteExecution =
  /** This call sent the write exactly once and recorded `outcome` on the receipt. */
  | { readonly executed: true; readonly outcome: ConnectorWriteOutcome; readonly receipt: ConnectorWriteReceipt | null }
  /**
   * A receipt with this idempotency key already existed: nothing was sent (whatever its status, including
   * `PREPARED` and `UNCERTAIN` — there is no automatic retry).
   */
  | { readonly executed: false; readonly receipt: ConnectorWriteReceipt };

export interface ConnectorWriteExecutorDeps {
  readonly receipts: ConnectorWriteReceiptRepository;
  readonly now: () => IsoTimestamp;
  readonly newId: () => Id;
}

/** A programming error in the request (never a provider failure). The message is a fixed code. */
export class ConnectorWriteRequestError extends Error {
  constructor(readonly code: 'CONNECTOR_WRITE_REQUEST_INVALID') {
    super(code);
    this.name = 'ConnectorWriteRequestError';
  }
}

/**
 * The at-most-once write step (ADR-0112 D3/D6). `executeOnce` writes a `PREPARED` receipt BEFORE calling `send`, calls
 * `send` at most once, and records its typed outcome. A second call with the same idempotency key never sends. A
 * `send` that throws is recorded as `UNCERTAIN` (the request may have left). There is no retry of any kind here.
 *
 * Callers (CWR-2) consume the approval grant before calling this, pass the exact approved payload's hash, and use
 * `findLatestSent` on the repository for the "이미 보냈어요" reply.
 */
export class ConnectorWriteExecutor {
  constructor(private readonly deps: ConnectorWriteExecutorDeps) {}

  async executeOnce(
    request: ConnectorWriteExecutionRequest,
    send: () => Promise<ConnectorWriteOutcome>,
  ): Promise<ConnectorWriteExecution> {
    assertValidRequest(request);
    const createdAt = this.deps.now();
    const prepared = await this.deps.receipts.prepare({
      id: this.deps.newId(),
      actorId: request.actorId,
      idempotencyKey: request.idempotencyKey,
      connector: request.connector,
      operation: request.operation,
      target: request.target,
      payloadSha256: request.payloadSha256,
      status: 'PREPARED',
      createdAt,
      updatedAt: createdAt,
      data: {},
    });
    if (!prepared.created) return { executed: false, receipt: prepared.receipt };

    let outcome: ConnectorWriteOutcome;
    try {
      outcome = normalizeOutcome(await send());
    } catch {
      outcome = connectorWriteUncertain('UNKNOWN');
    }
    const receipt = await this.deps.receipts.complete(prepared.receipt.id, outcome, this.deps.now());
    return { executed: true, outcome, receipt };
  }
}

function assertValidRequest(request: ConnectorWriteExecutionRequest): void {
  const valid =
    typeof request?.actorId === 'string' && request.actorId.length > 0 &&
    isConnectorWriteIdempotencyKey(request.idempotencyKey) &&
    typeof request.connector === 'string' && CONNECTOR_LABEL.test(request.connector) &&
    CONNECTOR_WRITE_OPERATIONS.includes(request.operation) &&
    typeof request.target === 'string' && request.target.length > 0 && request.target.length <= TARGET_MAX_LENGTH &&
    isConnectorWritePayloadSha256(request.payloadSha256);
  if (!valid) throw new ConnectorWriteRequestError('CONNECTOR_WRITE_REQUEST_INVALID');
}

/** A malformed outcome from a writer is treated as UNCERTAIN (when in doubt), never as SENT. */
function normalizeOutcome(outcome: ConnectorWriteOutcome): ConnectorWriteOutcome {
  if (outcome?.status === 'SENT' && typeof outcome.externalRef === 'string' && outcome.externalRef.length > 0) {
    return outcome;
  }
  if (outcome?.status === 'NOT_SENT' && typeof outcome.reason === 'string') return outcome;
  if (outcome?.status === 'UNCERTAIN' && typeof outcome.reason === 'string') return outcome;
  return connectorWriteUncertain('INVALID_RESPONSE');
}
