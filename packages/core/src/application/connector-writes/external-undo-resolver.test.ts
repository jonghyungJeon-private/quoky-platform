import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, Task } from '../../domain';
import type { ConnectorWriteReceipt } from '../../ports';
import { withLastAction, type LastActionRecord } from '../nl-routing/last-action';
import { ExternalUndoResolver } from './external-undo-resolver';
import { CONNECTOR_WRITE_ANCHOR_KIND, type ConnectorWriteAnchor } from './connector-write-flow';
import { setExternalUndoCapabilitiesForTest } from '../nl-routing/last-action';
import { CONNECTOR_UNDO_RECEIPT_BANNER } from './connector-write-copy';

const NOW = '2026-11-02T10:00:00.000Z';
const EARLIER = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const ACTOR = 'actor-1';
const SESSION = 'session-1';
const EVENT_ID = 'abcde12345';

function receipt(overrides: Partial<ConnectorWriteReceipt> = {}): ConnectorWriteReceipt {
  return {
    id: 'receipt-1',
    actorId: ACTOR,
    idempotencyKey: 'cwr:approval-1',
    connector: 'google-calendar',
    operation: 'CALENDAR_EVENT_CREATE',
    target: 'primary',
    payloadSha256: 'a'.repeat(64),
    status: 'SENT',
    createdAt: NOW,
    updatedAt: NOW,
    data: { externalRef: EVENT_ID },
    ...overrides,
  };
}

function anchor(overrides: Partial<ConnectorWriteAnchor> = {}): ConnectorWriteAnchor {
  return {
    kind: CONNECTOR_WRITE_ANCHOR_KIND,
    status: 'SENT',
    actorId: ACTOR,
    sessionId: SESSION,
    family: 'calendar',
    operation: 'CALENDAR_EVENT_CREATE',
    connector: 'google-calendar',
    target: 'primary',
    payloadSha256: 'a'.repeat(64),
    approvalId: 'approval-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function record(overrides: Partial<LastActionRecord> = {}): LastActionRecord {
  return {
    entryId: 'calendar.create',
    source: 'calendar',
    itemId: 'receipt-1',
    at: EARLIER(2),
    undoable: true,
    undone: false,
    outcome: 'SENT',
    anchorTaskId: 'task-1',
    echoReplyIds: [],
    ...overrides,
  };
}

function sessionWith(last: LastActionRecord | undefined, actorId = ACTOR): Pick<Session, 'id' | 'metadata'> {
  return { id: SESSION, metadata: last === undefined ? {} : { 'quoky.lastAction': withLastAction(undefined, actorId, last, NOW) } };
}

function resolver(options: { receipts?: ConnectorWriteReceipt[]; anchors?: Record<string, ConnectorWriteAnchor>; open?: boolean } = {}) {
  const receipts = options.receipts ?? [receipt()];
  const anchors = options.anchors ?? { 'task-1': anchor() };
  return new ExternalUndoResolver({
    receipts: { findById: async (id, actorId) => receipts.find((row) => row.id === id && row.actorId === actorId) ?? null },
    tasks: { get: async (id) => (anchors[id] === undefined ? null : ({ id, metadata: { anchor: anchors[id] } } as unknown as Task)) },
    readAnchor: (task) => (task.metadata as { anchor?: ConnectorWriteAnchor } | undefined)?.anchor,
    capabilities: options.open === false ? [] : (['calendar-create'] as const),
  });
}

const input = (last: LastActionRecord | undefined, extra: { replyToMessageId?: string; actorId?: string } = {}) => ({
  session: sessionWith(last),
  actor: { id: extra.actorId ?? ACTOR },
  now: NOW,
  ...(extra.replyToMessageId !== undefined ? { replyToMessageId: extra.replyToMessageId } : {}),
});

describe('ExternalUndoResolver (amendment 3: lastAction -> receipt -> anchor -> undo draft)', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(['calendar-create']));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('resolves this session\'s own SENT write to a draft that carries the receipt id only', async () => {
    const result = await resolver().resolve(input(record()));
    expect(result).toMatchObject({ kind: 'resolved', family: 'calendar-create', anchorTaskId: 'task-1', draft: { kind: 'calendar-create-undo', receiptId: 'receipt-1' } });
    expect(Object.keys((result as { draft: object }).draft).sort()).toEqual(['kind', 'receiptId']);
  });

  it('resolves nothing while the family is not in the capability set', async () => {
    expect(await resolver({ open: false }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'not-open' });
  });

  it('refuses a receipt that belongs to another actor (wrong actor)', async () => {
    const other = await resolver({ receipts: [receipt({ actorId: 'actor-2' })] }).resolve(input(record()));
    expect(other).toEqual({ kind: 'nothing-to-undo', reason: 'receipt-missing' });
    // another actor's own lastAction is never read for this actor
    expect(await resolver().resolve({ ...input(record(), { actorId: 'actor-2' }), session: sessionWith(record()) })).toEqual({ kind: 'nothing-to-undo', reason: 'no-last-action' });
  });

  it('refuses another session: an anchor of a different session, and a session that has no lastAction', async () => {
    expect(await resolver({ anchors: { 'task-1': anchor({ sessionId: 'session-2' }) } }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'anchor-mismatch' });
    expect(await resolver({ anchors: { 'task-1': anchor({ actorId: 'actor-2' }) } }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'anchor-mismatch' });
    expect(await resolver().resolve({ session: { id: 'session-2', metadata: {} }, actor: { id: ACTOR }, now: NOW })).toEqual({ kind: 'nothing-to-undo', reason: 'no-last-action' });
  });

  it('refuses a malformed external reference, a wrong operation and a receipt that is not SENT', async () => {
    for (const ref of ['', 'not an id', 'ABCDE12345', 'abc', 'abcde12345/../x', 'a'.repeat(1025)]) {
      expect(await resolver({ receipts: [receipt({ data: { externalRef: ref } })] }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'malformed-ref' });
    }
    expect(await resolver({ receipts: [receipt({ data: {} })] }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'malformed-ref' });
    expect(await resolver({ receipts: [receipt({ operation: 'CALENDAR_EVENT_DELETE' })] }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'receipt-mismatch' });
    expect(await resolver({ receipts: [receipt({ status: 'UNCERTAIN' })] }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'receipt-mismatch' });
  });

  it('a task id in itemId (the fallback when a write left no receipt) means nothing to undo', async () => {
    const result = await resolver().resolve(input(record({ itemId: 'task-1' })));
    expect(result).toEqual({ kind: 'nothing-to-undo', reason: 'receipt-missing' });
  });

  it('refuses a record without an anchor, with a missing anchor, or whose anchor is not a SENT write of the operation', async () => {
    const { anchorTaskId: _drop, ...bare } = record();
    expect(await resolver().resolve(input(bare as LastActionRecord))).toEqual({ kind: 'nothing-to-undo', reason: 'anchor-missing' });
    expect(await resolver({ anchors: {} }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'anchor-missing' });
    expect(await resolver({ anchors: { 'task-1': anchor({ status: 'APPROVAL_PENDING' }) } }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'anchor-mismatch' });
    expect(await resolver({ anchors: { 'task-1': anchor({ operation: 'CALENDAR_EVENT_DELETE' }) } }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'anchor-mismatch' });
  });

  it('applies the local window rule: older than 10 minutes asks for an echo reply, and a reply must name the echo', async () => {
    const old = record({ at: EARLIER(20), echoReplyIds: ['echo-1'] });
    expect(await resolver().resolve(input(old))).toEqual({ kind: 'nothing-to-undo', reason: 'stale' });
    expect(await resolver().resolve(input(old, { replyToMessageId: 'echo-1' }))).toMatchObject({ kind: 'resolved' });
    expect(await resolver().resolve(input(old, { replyToMessageId: 'other' }))).toEqual({ kind: 'nothing-to-undo', reason: 'echo-mismatch' });
    expect(await resolver().resolve(input(record({ at: EARLIER(40) })))).toEqual({ kind: 'nothing-to-undo', reason: 'no-last-action' });
  });

  it('never undoes an undo, an uncertain or not-sent write, or a non-external record', async () => {
    expect(await resolver().resolve(input(record({ entryId: 'action.undo', undoOf: 'calendar.create' })))).toEqual({ kind: 'nothing-to-undo', reason: 'already-undone' });
    expect(await resolver().resolve(input(record({ undone: true })))).toEqual({ kind: 'nothing-to-undo', reason: 'already-undone' });
    expect(await resolver().resolve(input(record({ outcome: 'UNCERTAIN' })))).toEqual({ kind: 'nothing-to-undo', reason: 'not-sent' });
    expect(await resolver().resolve(input(record({ outcome: 'NOT_SENT' })))).toEqual({ kind: 'nothing-to-undo', reason: 'not-sent' });
    expect(await resolver().resolve(input({ entryId: 'todo.add', source: 'todo', itemId: 'todo-1', at: EARLIER(1), undoable: true, undone: false, echoReplyIds: [] }))).toEqual({ kind: 'nothing-to-undo', reason: 'not-external' });
    expect(await resolver().resolve(input(record({ entryId: 'external.write' })))).toEqual({ kind: 'nothing-to-undo', reason: 'not-open' });
  });
});

describe('ExternalUndoResolver defence in depth (P3-4): the receipt must be the one this anchor produced', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(['calendar-create']));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('refuses a receipt whose idempotency key, payload hash, target or connector is not the anchor\'s', async () => {
    for (const other of [
      receipt({ idempotencyKey: 'cwr:approval-2' }),
      receipt({ payloadSha256: 'b'.repeat(64) }),
      receipt({ target: 'primary/zzzzz' }),
      receipt({ connector: 'other-connector' }),
    ]) {
      expect(await resolver({ receipts: [other] }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'receipt-mismatch' });
    }
    expect(await resolver({ anchors: { 'task-1': anchor({ approvalId: undefined }) } }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'receipt-mismatch' });
  });

  it('refuses a record that is not undoable (a stored flag cannot open it, and the normaliser drops it with the family off)', async () => {
    expect(await resolver({ open: false }).resolve(input(record()))).toEqual({ kind: 'nothing-to-undo', reason: 'not-open' });
    setExternalUndoCapabilitiesForTest([]); // the off path, through the seam (the shipped set is ['calendar-create'])
    expect(await resolver().resolve(input(record({ undoable: true })))).toEqual({ kind: 'nothing-to-undo', reason: 'not-open' });
  });
});

describe('the receipt-sourced banner (A6-D4 variant)', () => {
  it('is the fixed sentence naming the receipt as the source of the target', () => {
    expect(CONNECTOR_UNDO_RECEIPT_BANNER).toBe('되돌리기 요청 — 대상은 Quoky가 보낸 기록(영수증)에서 가져왔어요. 문장에서 가져온 대상은 없어요');
  });
});
