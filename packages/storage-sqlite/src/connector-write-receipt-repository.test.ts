import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectorWriteExecutor,
  connectorWritePayloadSha256,
  connectorWriteSent,
  type ConnectorWriteReceipt,
} from '@quoky/core';
import { runMigrations } from './migrations';
import {
  CONNECTOR_WRITE_RECEIPTS_SCHEMA_VERSION,
  SqliteConnectorWriteReceiptRepository,
} from './connector-write-receipt-repository';
import { SqliteStorageProvider } from './index';

const HASH = connectorWritePayloadSha256('ISSUE_COMMENT', 'PROJ-1', { issueKey: 'PROJ-1', text: 'secret payload text' });

function setup(): { db: Database.Database; repo: SqliteConnectorWriteReceiptRepository } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, repo: new SqliteConnectorWriteReceiptRepository(db) };
}

function receipt(overrides: Partial<ConnectorWriteReceipt> = {}): ConnectorWriteReceipt {
  return {
    id: 'r1',
    actorId: 'actor-1',
    idempotencyKey: 'approval:0001-abcd',
    connector: 'jira',
    operation: 'ISSUE_COMMENT',
    target: 'PROJ-1',
    payloadSha256: HASH,
    status: 'PREPARED',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    data: {},
    ...overrides,
  };
}

describe('SqliteConnectorWriteReceiptRepository (ADR-0112 D3, schema v15)', () => {
  it('is the v15 table', () => {
    expect(CONNECTOR_WRITE_RECEIPTS_SCHEMA_VERSION).toBe(15);
  });

  it('prepares one receipt per idempotency key and returns the existing receipt on a second prepare', async () => {
    const { repo, db } = setup();
    const first = await repo.prepare(receipt());
    expect(first).toMatchObject({ created: true, receipt: { id: 'r1', status: 'PREPARED', data: {} } });
    const second = await repo.prepare(receipt({ id: 'r2', target: 'PROJ-2' }));
    expect(second).toMatchObject({ created: false, receipt: { id: 'r1', target: 'PROJ-1', status: 'PREPARED' } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM connector_write_receipts').get()).toEqual({ n: 1 });
    db.close();
  });

  it('refuses to insert anything but a well-formed PREPARED receipt', async () => {
    const { repo, db } = setup();
    await expect(repo.prepare(receipt({ status: 'SENT' }))).rejects.toThrow('CONNECTOR_WRITE_RECEIPT_INVALID');
    await expect(repo.prepare(receipt({ payloadSha256: 'abc' }))).rejects.toThrow('CONNECTOR_WRITE_RECEIPT_INVALID');
    await expect(repo.prepare(receipt({ operation: 'DROP' as never }))).rejects.toThrow('CONNECTOR_WRITE_RECEIPT_INVALID');
    expect(db.prepare('SELECT COUNT(*) AS n FROM connector_write_receipts').get()).toEqual({ n: 0 });
    db.close();
  });

  it('completes a PREPARED receipt exactly once (compare-and-set) and never changes a terminal receipt', async () => {
    const { repo, db } = setup();
    await repo.prepare(receipt());
    const sent = await repo.complete('r1', connectorWriteSent('10001', 'https://example.atlassian.net/browse/PROJ-1'), 't2');
    expect(sent).toMatchObject({
      status: 'SENT', updatedAt: 't2', data: { externalRef: '10001', url: 'https://example.atlassian.net/browse/PROJ-1' },
    });
    expect(await repo.complete('r1', { status: 'UNCERTAIN', reason: 'TRANSPORT' }, 't3')).toBeNull();
    expect(await repo.complete('missing', { status: 'UNCERTAIN', reason: 'TRANSPORT' }, 't3')).toBeNull();
    expect((await repo.findByIdempotencyKey('approval:0001-abcd'))?.status).toBe('SENT');
    db.close();
  });

  it('stores only whitelisted outcome data: no payload text, no non-https link, no unknown reason', async () => {
    const { repo, db } = setup();
    await repo.prepare(receipt({ data: { externalRef: 'x', reason: 'secret payload text' as never } }));
    await repo.complete('r1', {
      status: 'SENT', externalRef: '1', url: 'javascript:alert(1)', text: 'secret payload text',
    } as never, 't2');
    const raw = JSON.stringify(db.prepare('SELECT * FROM connector_write_receipts').all());
    expect(raw).not.toContain('secret payload text');
    expect(raw).not.toContain('javascript:');
    expect((await repo.findByIdempotencyKey('approval:0001-abcd'))?.data).toEqual({ externalRef: '1' });

    await repo.prepare(receipt({ id: 'r2', idempotencyKey: 'approval:0002-abcd' }));
    await repo.complete('r2', { status: 'NOT_SENT', reason: 'TARGET_NOT_ALLOWED', retryable: false }, 't2');
    expect((await repo.findByIdempotencyKey('approval:0002-abcd'))?.data).toEqual({ reason: 'TARGET_NOT_ALLOWED' });
    db.close();
  });

  it('finds the newest SENT receipt for the same actor, connector, operation, target and payload hash only', async () => {
    const { repo, db } = setup();
    await repo.prepare(receipt({ id: 'a', idempotencyKey: 'approval:aaaa-0001' }));
    await repo.complete('a', connectorWriteSent('old'), '2026-10-06T01:00:00.000Z');
    await repo.prepare(receipt({ id: 'b', idempotencyKey: 'approval:bbbb-0002' }));
    await repo.complete('b', connectorWriteSent('new'), '2026-10-06T02:00:00.000Z');
    await repo.prepare(receipt({ id: 'c', idempotencyKey: 'approval:cccc-0003' }));
    await repo.complete('c', { status: 'UNCERTAIN', reason: 'TRANSPORT' }, '2026-10-06T03:00:00.000Z');
    const match = { actorId: 'actor-1', connector: 'jira', operation: 'ISSUE_COMMENT' as const, target: 'PROJ-1', payloadSha256: HASH };
    expect((await repo.findLatestSent(match))?.data.externalRef).toBe('new');
    expect(await repo.findLatestSent({ ...match, actorId: 'actor-2' })).toBeNull();
    expect(await repo.findLatestSent({ ...match, target: 'PROJ-2' })).toBeNull();
    expect(await repo.findLatestSent({ ...match, payloadSha256: '0'.repeat(64) })).toBeNull();
    expect(await repo.findLatestSent({ ...match, operation: 'ISSUE_TRANSITION' })).toBeNull();
    db.close();
  });

  it('turns every PREPARED receipt into UNCERTAIN (INTERRUPTED) at startup and leaves terminal receipts alone', async () => {
    const { repo, db } = setup();
    await repo.prepare(receipt({ id: 'p', idempotencyKey: 'approval:pppp-0001' }));
    await repo.prepare(receipt({ id: 's', idempotencyKey: 'approval:ssss-0002' }));
    await repo.complete('s', connectorWriteSent('1'), 't2');
    expect(await repo.markInterruptedPreparedUncertain('t9')).toBe(1);
    expect(await repo.findByIdempotencyKey('approval:pppp-0001')).toMatchObject({
      status: 'UNCERTAIN', updatedAt: 't9', data: { reason: 'INTERRUPTED' },
    });
    expect((await repo.findByIdempotencyKey('approval:ssss-0002'))?.status).toBe('SENT');
    expect(await repo.markInterruptedPreparedUncertain('t10')).toBe(0);
    // The interrupted write can no longer be completed, so a late outcome never overwrites UNCERTAIN.
    expect(await repo.complete('p', connectorWriteSent('late'), 't11')).toBeNull();
    db.close();
  });

  it('with the core executor: a replayed idempotency key sends nothing (at most once end to end)', async () => {
    const { repo, db } = setup();
    let seq = 0;
    const executor = new ConnectorWriteExecutor({ receipts: repo, now: () => 't', newId: () => `id-${++seq}` });
    let sends = 0;
    const send = async () => {
      sends += 1;
      return connectorWriteSent('c-1');
    };
    const request = {
      actorId: 'actor-1', idempotencyKey: 'approval:0001-abcd', connector: 'jira', operation: 'ISSUE_COMMENT' as const,
      target: 'PROJ-1', payloadSha256: HASH,
    };
    expect(await executor.executeOnce(request, send)).toMatchObject({ executed: true, receipt: { status: 'SENT' } });
    expect(await executor.executeOnce(request, send)).toMatchObject({ executed: false, receipt: { status: 'SENT' } });
    expect(sends).toBe(1);
    db.close();
  });

  it('is exposed by the storage provider after init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-cwr-'));
    const storage = new SqliteStorageProvider({ dbPath: join(dir, 'q.db') });
    try {
      await storage.init();
      expect(await storage.connectorWriteReceipts.prepare(receipt())).toMatchObject({ created: true });
    } finally {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
