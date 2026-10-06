import type Database from 'better-sqlite3';
import {
  CONNECTOR_WRITE_NOT_SENT_REASONS,
  CONNECTOR_WRITE_OPERATIONS,
  CONNECTOR_WRITE_UNCERTAIN_REASONS,
} from '@quoky/core';
import type {
  ConnectorWriteMatch,
  ConnectorWriteOperation,
  ConnectorWriteOutcome,
  ConnectorWritePrepareResult,
  ConnectorWriteReceipt,
  ConnectorWriteReceiptData,
  ConnectorWriteReceiptRepository,
  ConnectorWriteReceiptStatus,
  Id,
  IsoTimestamp,
} from '@quoky/core';

type Db = Database.Database;

type ReceiptRow = {
  id: string; actor_id: string; idempotency_key: string; connector: string; operation: string; target: string;
  payload_sha256: string; status: string; created_at: string; updated_at: string; data: string;
};

/** The schema version that introduced `connector_write_receipts` (ADR-0112 D3). */
export const CONNECTOR_WRITE_RECEIPTS_SCHEMA_VERSION = 15;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const REF_MAX_LENGTH = 300;
const URL_MAX_LENGTH = 2000;
const REASONS: readonly string[] = [...CONNECTOR_WRITE_NOT_SENT_REASONS, ...CONNECTOR_WRITE_UNCERTAIN_REASONS, 'INTERRUPTED'];

/**
 * The JSON `data` column: an explicit whitelist so no payload text, credential or response body can ever be persisted
 * by spreading. Only a bounded external reference, an `https:` link and a known reason code survive.
 */
function receiptData(data: ConnectorWriteReceiptData): ConnectorWriteReceiptData {
  const out: ConnectorWriteReceiptData = {};
  if (typeof data.externalRef === 'string' && data.externalRef.length > 0 && data.externalRef.length <= REF_MAX_LENGTH) {
    out.externalRef = data.externalRef;
  }
  if (typeof data.url === 'string' && data.url.startsWith('https://') && data.url.length <= URL_MAX_LENGTH) {
    out.url = data.url;
  }
  if (typeof data.reason === 'string' && REASONS.includes(data.reason)) out.reason = data.reason;
  return out;
}

function dataOfOutcome(outcome: ConnectorWriteOutcome): ConnectorWriteReceiptData {
  if (outcome.status === 'SENT') {
    return receiptData({ externalRef: outcome.externalRef, ...(outcome.url !== undefined ? { url: outcome.url } : {}) });
  }
  return receiptData({ reason: outcome.reason });
}

function receiptOf(row: ReceiptRow): ConnectorWriteReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(row.data);
  } catch {
    raw = {};
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    connector: row.connector,
    operation: row.operation as ConnectorWriteOperation,
    target: row.target,
    payloadSha256: row.payload_sha256,
    status: row.status as ConnectorWriteReceiptStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: typeof raw === 'object' && raw !== null ? receiptData(raw as ConnectorWriteReceiptData) : {},
  };
}

/**
 * SQLite connector write receipts (ADR-0112 D3, migration v15). Not part of `StorageProvider`. At most one receipt per
 * idempotency key; only `PREPARED` receipts are inserted, and only a `PREPARED` receipt ever changes status.
 */
export class SqliteConnectorWriteReceiptRepository implements ConnectorWriteReceiptRepository {
  constructor(private readonly db: Db) {}

  async prepare(receipt: ConnectorWriteReceipt): Promise<ConnectorWritePrepareResult> {
    if (receipt.status !== 'PREPARED') throw new Error('CONNECTOR_WRITE_RECEIPT_INVALID');
    if (!CONNECTOR_WRITE_OPERATIONS.includes(receipt.operation)) throw new Error('CONNECTOR_WRITE_RECEIPT_INVALID');
    if (!SHA256_HEX.test(receipt.payloadSha256)) throw new Error('CONNECTOR_WRITE_RECEIPT_INVALID');
    return this.db.transaction((): ConnectorWritePrepareResult => {
      const inserted = this.db.prepare(
        `INSERT INTO connector_write_receipts
           (id, actor_id, idempotency_key, connector, operation, target, payload_sha256, status, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(
        receipt.id, receipt.actorId, receipt.idempotencyKey, receipt.connector, receipt.operation, receipt.target,
        receipt.payloadSha256, receipt.createdAt, receipt.updatedAt, JSON.stringify(receiptData(receipt.data)),
      );
      const row = this.db.prepare(
        'SELECT * FROM connector_write_receipts WHERE idempotency_key = ?',
      ).get(receipt.idempotencyKey) as ReceiptRow;
      return { created: inserted.changes > 0, receipt: receiptOf(row) };
    })();
  }

  async complete(id: Id, outcome: ConnectorWriteOutcome, now: IsoTimestamp): Promise<ConnectorWriteReceipt | null> {
    const status = outcome.status;
    if (status !== 'SENT' && status !== 'NOT_SENT' && status !== 'UNCERTAIN') throw new Error('CONNECTOR_WRITE_OUTCOME_INVALID');
    return this.db.transaction((): ConnectorWriteReceipt | null => {
      const result = this.db.prepare(
        `UPDATE connector_write_receipts SET status = ?, updated_at = ?, data = ?
         WHERE id = ? AND status = 'PREPARED'`,
      ).run(status, now, JSON.stringify(dataOfOutcome(outcome)), id);
      if (result.changes === 0) return null;
      const row = this.db.prepare('SELECT * FROM connector_write_receipts WHERE id = ?').get(id) as ReceiptRow;
      return receiptOf(row);
    })();
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.db.prepare(
      'SELECT * FROM connector_write_receipts WHERE idempotency_key = ?',
    ).get(idempotencyKey) as ReceiptRow | undefined;
    return row ? receiptOf(row) : null;
  }

  async findLatestSent(match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    const row = this.db.prepare(
      `SELECT * FROM connector_write_receipts
       WHERE actor_id = ? AND connector = ? AND operation = ? AND target = ? AND payload_sha256 = ? AND status = 'SENT'
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    ).get(match.actorId, match.connector, match.operation, match.target, match.payloadSha256) as ReceiptRow | undefined;
    return row ? receiptOf(row) : null;
  }

  async findLatestForOperation(actorId: Id, operation: ConnectorWriteOperation): Promise<ConnectorWriteReceipt | null> {
    const row = this.db.prepare(
      `SELECT * FROM connector_write_receipts
       WHERE actor_id = ? AND operation = ?
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    ).get(actorId, operation) as ReceiptRow | undefined;
    return row ? receiptOf(row) : null;
  }

  async markInterruptedPreparedUncertain(now: IsoTimestamp): Promise<number> {
    return this.db.prepare(
      `UPDATE connector_write_receipts SET status = 'UNCERTAIN', updated_at = ?, data = ?
       WHERE status = 'PREPARED'`,
    ).run(now, JSON.stringify({ reason: 'INTERRUPTED' })).changes;
  }
}
