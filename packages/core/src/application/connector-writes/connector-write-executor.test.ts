import { describe, expect, it, vi } from 'vitest';
import {
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  isValidConnectorWriteText,
  type ConnectorWriteMatch,
  type ConnectorWriteOutcome,
  type ConnectorWritePrepareResult,
  type ConnectorWriteReceipt,
  type ConnectorWriteReceiptRepository,
} from '../../ports';
import { ConnectorWriteExecutor, ConnectorWriteRequestError, type ConnectorWriteExecutionRequest } from './connector-write-executor';
import {
  canonicalJson,
  connectorWritePayloadSha256,
  isConnectorWriteIdempotencyKey,
  isConnectorWritePayloadSha256,
} from './connector-write-payload';

/** An in-memory receipts store with the same at-most-once semantics as the SQLite adapter. */
class FakeReceipts implements ConnectorWriteReceiptRepository {
  readonly rows = new Map<string, ConnectorWriteReceipt>();
  readonly events: string[] = [];

  async prepare(receipt: ConnectorWriteReceipt): Promise<ConnectorWritePrepareResult> {
    const existing = [...this.rows.values()].find((row) => row.idempotencyKey === receipt.idempotencyKey);
    if (existing) return { created: false, receipt: existing };
    this.rows.set(receipt.id, { ...receipt });
    this.events.push(`prepare:${receipt.status}`);
    return { created: true, receipt };
  }

  async complete(id: string, outcome: ConnectorWriteOutcome, now: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'PREPARED') return null;
    const data = outcome.status === 'SENT'
      ? { externalRef: outcome.externalRef, ...(outcome.url ? { url: outcome.url } : {}) }
      : { reason: outcome.reason };
    const next = { ...row, status: outcome.status, updatedAt: now, data };
    this.rows.set(id, next);
    this.events.push(`complete:${outcome.status}`);
    return next;
  }

  async findByIdempotencyKey(key: string): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].find((row) => row.idempotencyKey === key) ?? null;
  }

  async findLatestSent(_match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    return null;
  }

  async findLatestUnresolved(_match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    return null;
  }

  async findLatestForOperation(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }

  async markInterruptedPreparedUncertain(): Promise<number> {
    return 0;
  }
}

const HASH = connectorWritePayloadSha256('ISSUE_COMMENT', 'PROJ-1', { issueKey: 'PROJ-1', text: 'hello' });

function request(overrides: Partial<ConnectorWriteExecutionRequest> = {}): ConnectorWriteExecutionRequest {
  return {
    actorId: 'actor-1',
    idempotencyKey: 'approval:0001-abcd',
    connector: 'jira',
    operation: 'ISSUE_COMMENT',
    target: 'PROJ-1',
    payloadSha256: HASH,
    ...overrides,
  };
}

function executor(receipts: FakeReceipts): ConnectorWriteExecutor {
  let seq = 0;
  return new ConnectorWriteExecutor({
    receipts,
    now: () => '2026-10-06T00:00:00.000Z',
    newId: () => `receipt-${++seq}`,
  });
}

describe('ConnectorWriteExecutor (ADR-0112 D3/D6 at-most-once)', () => {
  it('writes PREPARED before the send, sends once and records SENT', async () => {
    const receipts = new FakeReceipts();
    const send = vi.fn(async () => {
      receipts.events.push('send');
      return connectorWriteSent('10001', 'https://example.atlassian.net/browse/PROJ-1');
    });
    const result = await executor(receipts).executeOnce(request(), send);
    expect(receipts.events).toEqual(['prepare:PREPARED', 'send', 'complete:SENT']);
    expect(result).toMatchObject({ executed: true, outcome: { status: 'SENT', externalRef: '10001' } });
    expect(result.executed && result.receipt?.status).toBe('SENT');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never sends again for an idempotency key that already has a receipt, whatever its status', async () => {
    for (const first of [
      connectorWriteSent('1'),
      connectorWriteNotSent('REJECTED'),
      connectorWriteUncertain('TRANSPORT'),
    ] as ConnectorWriteOutcome[]) {
      const receipts = new FakeReceipts();
      const run = executor(receipts);
      await run.executeOnce(request(), async () => first);
      const replay = vi.fn(async () => connectorWriteSent('2'));
      const second = await run.executeOnce(request(), replay);
      expect(replay).not.toHaveBeenCalled();
      expect(second).toMatchObject({ executed: false, receipt: { status: first.status } });
    }
  });

  it('a receipt left PREPARED (an interrupted write) also blocks a resend', async () => {
    const receipts = new FakeReceipts();
    await receipts.prepare({
      id: 'r0', actorId: 'actor-1', idempotencyKey: 'approval:0001-abcd', connector: 'jira', operation: 'ISSUE_COMMENT',
      target: 'PROJ-1', payloadSha256: HASH, status: 'PREPARED', createdAt: 't', updatedAt: 't', data: {},
    });
    const send = vi.fn(async () => connectorWriteSent('x'));
    expect(await executor(receipts).executeOnce(request(), send)).toMatchObject({ executed: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('records UNCERTAIN, with no retry, when the send throws or returns a malformed outcome', async () => {
    const receipts = new FakeReceipts();
    const throwing = vi.fn(async (): Promise<ConnectorWriteOutcome> => {
      throw new Error('socket hang up with secret-token');
    });
    const result = await executor(receipts).executeOnce(request(), throwing);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ executed: true, outcome: { status: 'UNCERTAIN', reason: 'UNKNOWN' } });
    expect(JSON.stringify([...receipts.rows.values()])).not.toContain('secret-token');

    const malformed = await executor(new FakeReceipts()).executeOnce(
      request(),
      async () => ({ status: 'SENT', externalRef: '' }) as ConnectorWriteOutcome,
    );
    expect(malformed).toMatchObject({ executed: true, outcome: { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' } });
  });

  it('refuses an invalid request before writing any receipt or sending', async () => {
    const receipts = new FakeReceipts();
    const send = vi.fn(async () => connectorWriteSent('x'));
    for (const bad of [
      { idempotencyKey: 'short' },
      { payloadSha256: 'not-a-hash' },
      { connector: 'Jira!' },
      { operation: 'DELETE_EVERYTHING' as never },
      { target: '' },
      { actorId: '' },
    ]) {
      await expect(executor(receipts).executeOnce(request(bad), send)).rejects.toBeInstanceOf(ConnectorWriteRequestError);
    }
    expect(receipts.rows.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('connector write payload hash and validation', () => {
  it('is stable across key order, binds operation, target and payload, and is lowercase hex', () => {
    const a = connectorWritePayloadSha256('CHANNEL_POST', 'C0123ABCD', { channelId: 'C0123ABCD', text: 'hi' });
    const b = connectorWritePayloadSha256('CHANNEL_POST', 'C0123ABCD', { text: 'hi', channelId: 'C0123ABCD' });
    expect(a).toBe(b);
    expect(isConnectorWritePayloadSha256(a)).toBe(true);
    expect(connectorWritePayloadSha256('CHANNEL_POST', 'C0123ABCD', { channelId: 'C0123ABCD', text: 'hi ' })).not.toBe(a);
    expect(connectorWritePayloadSha256('CHANNEL_POST', 'C0999ABCD', { channelId: 'C0123ABCD', text: 'hi' })).not.toBe(a);
    expect(connectorWritePayloadSha256('ISSUE_COMMENT', 'C0123ABCD', { channelId: 'C0123ABCD', text: 'hi' })).not.toBe(a);
  });

  it('canonical JSON sorts keys, drops undefined members and refuses non-JSON values', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, undefined] } })).toBe('{"a":{"c":[2,null]},"b":1}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow('CONNECTOR_WRITE_PAYLOAD_INVALID');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('CONNECTOR_WRITE_PAYLOAD_INVALID');
  });

  it('validates idempotency keys and owner text', () => {
    expect(isConnectorWriteIdempotencyKey('approval:0001-abcd')).toBe(true);
    expect(isConnectorWriteIdempotencyKey('short')).toBe(false);
    expect(isConnectorWriteIdempotencyKey('has space in it')).toBe(false);
    expect(isValidConnectorWriteText('정상 댓글')).toBe(true);
    expect(isValidConnectorWriteText('   ')).toBe(false);
    expect(isValidConnectorWriteText('a\u0000b')).toBe(false);
    expect(isValidConnectorWriteText('가'.repeat(4000))).toBe(true);
    expect(isValidConnectorWriteText('가'.repeat(4001))).toBe(false);
  });
});
