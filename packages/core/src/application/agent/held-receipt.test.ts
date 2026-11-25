import { isListingSource } from '../last-listing';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../ports/logger.port';
import {
  A7_HELD_RECEIPT_SHADOW_LOG_EVENT,
  HELD_RECEIPT_FROZEN_TTL_MS,
  HELD_RECEIPT_SHADOW_SOURCES,
  HELD_RECEIPT_TTL_MS,
  bindHeldReceipt,
  buildHeldReceipt,
  carryOverReceipt,
  digestHeldItemFields,
  heldReceiptShadowOutcome,
  isYesAndMoreRerun,
  logHeldReceiptShadow,
  parseHeldReceipt,
  reexecuteHeldReceipt,
  verifyHeldItems,
  type HeldReceipt,
  type HeldReceiptInput,
} from './held-receipt';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const T0 = '2026-11-25T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const d = (n: number) => digestHeldItemFields({ title: `t${n}`, body: `b${n}` }, sha);

function input(over: Partial<HeldReceiptInput> = {}): HeldReceiptInput {
  return {
    conversation: 'dm-1',
    actorId: 'owner',
    turnId: 'turn-1',
    entryId: 'jira.issues',
    validatedArgs: { scope: 'mine' },
    items: [1, 2, 3].map((n) => ({ id: `I-${n}`, digest: d(n) })),
    kind: 'listing',
    egress: 'LOCAL',
    at: T0,
    sourceOn: true,
    ...over,
  };
}
function held(over: Partial<HeldReceiptInput> = {}): HeldReceipt {
  const built = buildHeldReceipt(input(over));
  if ('refused' in built) throw new Error(built.refused);
  return built.receipt;
}
const ctx = (over = {}) => ({ actorId: 'owner', conversation: 'dm-1', now: at(60_000), previousTurnId: 'turn-1', sourceOn: true, ...over });

describe('buildHeldReceipt', () => {
  it('holds ids, digests, kind, egress and at, in delivered order, and nothing textual', () => {
    const receipt = held();
    expect(receipt.itemIds).toEqual(['I-1', 'I-2', 'I-3']);
    expect(receipt.itemDigests).toEqual([d(1), d(2), d(3)]);
    expect(Object.keys(receipt).sort()).toEqual(['actorId', 'at', 'conversation', 'egress', 'entryId', 'itemDigests', 'itemIds', 'kind', 'turnId', 'validatedArgs']);
    expect(JSON.stringify(receipt)).not.toContain('t1');
  });
  it('the digest is SHA-256, key-order independent and changes with a field', () => {
    expect(d(1)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestHeldItemFields({ a: 'x', b: 'y' }, sha)).toBe(digestHeldItemFields({ b: 'y', a: 'x' }, sha));
    expect(digestHeldItemFields({ a: 'x' }, sha)).not.toBe(digestHeldItemFields({ a: 'y' }, sha));
  });
  it.each([
    ['empty', { items: [] }],
    ['too-many', { items: Array.from({ length: 11 }, (_, n) => ({ id: `I-${n}`, digest: d(n) })) }],
    ['handoff-built', { handoffBuilt: true }],
    ['host-only', { hostOnly: true }],
    ['source-off', { sourceOn: false }],
    ['destination-listing', { destinationListing: true }],
    ['duplicate', { items: [{ id: 'I-1', digest: d(1) }, { id: 'I-1', digest: d(2) }] }],
    ['shape', { items: [{ id: 'I-1', digest: 'not-a-digest' }] }],
    ['shape', { at: 'yesterday' }],
    ['shape', { at: '2026-11-25' }],
    ['shape', { at: '2026-11-25 10:00:00Z' }],
    ['shape', { at: '2026-11-25T10:00:00+09:00' }],
    ['shape', { at: '2026-02-30T10:00:00.000Z' }],
    ['shape', { kind: 'card' }],
    ['shape', { validatedArgs: { x: 'y'.repeat(201) } }],
  ] as const)('refuses with %s', (code, over) => {
    expect(buildHeldReceipt(input(over as Partial<HeldReceiptInput>))).toEqual({ refused: code });
  });
  it('holds exactly 10 items (the cap) and never truncates 11', () => {
    expect('receipt' in buildHeldReceipt(input({ items: Array.from({ length: 10 }, (_, n) => ({ id: `I-${n}`, digest: d(n) })) }))).toBe(true);
  });
  it('parseHeldReceipt round-trips and treats a malformed or text-bearing value as absent', () => {
    const receipt = held();
    expect(parseHeldReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(parseHeldReceipt({ ...receipt, itemDigests: ['x'] })).toBeUndefined();
    expect(parseHeldReceipt({ ...receipt, kind: 'text' })).toBeUndefined();
    expect(parseHeldReceipt({ ...receipt, title: 'secret' })).toBeUndefined();
    expect(parseHeldReceipt({ ...receipt, kind: 'card' })).toBeUndefined();
    expect(parseHeldReceipt({ ...receipt, carried: true })).toBeUndefined();
    expect(parseHeldReceipt({ ...receipt, at: 'Nov 25 2026' })).toBeUndefined();
    expect(parseHeldReceipt(null)).toBeUndefined();
    expect(parseHeldReceipt('nope')).toBeUndefined();
  });
});

describe('bindHeldReceipt', () => {
  it('binds the next owner turn in the same DM within 10 minutes', () => {
    expect(bindHeldReceipt(held(), ctx())).toEqual({ bound: true });
  });
  it.each([
    ['absent', undefined, {}],
    ['other-actor', held(), { actorId: 'someone' }],
    ['other-conversation', held(), { conversation: 'dm-2' }],
    ['expired', held(), { now: at(HELD_RECEIPT_TTL_MS) }],
    ['expired', held(), { now: at(-1) }],
    ['not-next-turn', held(), { previousTurnId: 'turn-0' }],
    ['not-next-turn', held(), { previousTurnId: undefined }],
    ['source-off', held(), { sourceOn: false }],
    ['host-only', held(), { hostOnly: true }],
    ['kill-switch', held(), { killSwitch: true }],
  ] as const)('does not bind: %s', (reason, receipt, over) => {
    expect(bindHeldReceipt(receipt as HeldReceipt | undefined, ctx(over))).toEqual({ bound: false, reason });
  });
  it('a card or carried receipt lives 20 minutes from its original at', () => {
    const card = { ...held(), kind: 'card' as const };
    expect(bindHeldReceipt(card, ctx({ now: at(HELD_RECEIPT_TTL_MS + 1) }))).toEqual({ bound: true });
    expect(bindHeldReceipt(card, ctx({ now: at(HELD_RECEIPT_FROZEN_TTL_MS) }))).toEqual({ bound: false, reason: 'expired' });
  });
});

describe('yes-and-more re-run (A7.4c)', () => {
  const answer = held({ kind: 'answer', turnId: 'msg-9' });
  it('counts as the next turn only for the receipt its own yes-part wrote', () => {
    expect(isYesAndMoreRerun(answer, { messageId: 'msg-9', marker: true })).toBe(true);
    expect(bindHeldReceipt(answer, ctx({ previousTurnId: 'older', rerun: { messageId: 'msg-9', marker: true } }))).toEqual({ bound: true });
  });
  it.each([
    ['another message', answer, { messageId: 'msg-10', marker: true }],
    ['no re-run marker', answer, { messageId: 'msg-9', marker: false }],
    ['a listing receipt', held({ turnId: 'msg-9' }), { messageId: 'msg-9', marker: true }],
    ['no receipt', undefined, { messageId: 'msg-9', marker: true }],
  ] as const)('is not a re-run for %s', (_name, receipt, rerun) => {
    expect(isYesAndMoreRerun(receipt as HeldReceipt | undefined, rerun)).toBe(false);
  });
});

describe('forged re-run flag (A7.4c: for no other receipt)', () => {
  it('a listing or an unmarked re-run never binds as the next turn, whatever the caller passes', () => {
    const listing = held({ turnId: 'msg-9' });
    expect(bindHeldReceipt(listing, ctx({ previousTurnId: 'older', rerun: { messageId: 'msg-9', marker: true } }))).toEqual({ bound: false, reason: 'not-next-turn' });
    const answer = held({ kind: 'answer', turnId: 'msg-9' });
    expect(bindHeldReceipt(answer, ctx({ previousTurnId: 'older', rerun: { messageId: 'msg-9', marker: false } }))).toEqual({ bound: false, reason: 'not-next-turn' });
    expect(bindHeldReceipt(answer, ctx({ previousTurnId: 'older', rerunOfOwnYes: true }))).toEqual({ bound: false, reason: 'not-next-turn' });
  });
  it('an unparseable now or at is expired (fail closed)', () => {
    expect(bindHeldReceipt(held(), ctx({ now: 'Nov 25 2026 10:01' }))).toEqual({ bound: false, reason: 'expired' });
    expect(bindHeldReceipt({ ...held(), at: '2026-11-25' }, ctx())).toEqual({ bound: false, reason: 'expired' });
  });
});

describe('re-execution and the digest check (A7.4, a7-06)', () => {
  const receipt = held();
  const current = (ids: number[], changed: number[] = []) => ids.map((n) => ({ id: `I-${n}`, digest: changed.includes(n) ? d(99) : d(n) }));
  it('keeps unchanged items in receipt order, never adds, drops changed and missing', () => {
    expect(verifyHeldItems(receipt, current([3, 2, 1]))).toEqual({ keptIds: ['I-1', 'I-2', 'I-3'], dropped: 0, outcome: 'all' });
    expect(verifyHeldItems(receipt, [...current([1, 2, 3], [2]), { id: 'I-4', digest: d(4) }])).toEqual({ keptIds: ['I-1', 'I-3'], dropped: 1, outcome: 'some' });
    expect(verifyHeldItems(receipt, current([2], [2]))).toEqual({ keptIds: [], dropped: 3, outcome: 'none' });
  });
  it('a duplicate id in the re-read is a change', () => {
    expect(verifyHeldItems(receipt, [...current([1, 2, 3]), { id: 'I-1', digest: d(1) }]).keptIds).toEqual(['I-2', 'I-3']);
  });
  it('re-runs the held read once with the held entry and args, nothing from the second turn', async () => {
    const calls: unknown[] = [];
    const result = await reexecuteHeldReceipt(receipt, {
      async reread(entryId, args) {
        calls.push([entryId, args]);
        return current([1, 2, 3]);
      },
    });
    expect(calls).toEqual([['jira.issues', { scope: 'mine' }]]);
    expect(result.outcome).toBe('all');
  });
  it('a failed or throwing read keeps nothing (unverified)', async () => {
    expect(await reexecuteHeldReceipt(receipt, { reread: async () => undefined })).toEqual({ keptIds: [], dropped: 3, outcome: 'unverified' });
    expect((await reexecuteHeldReceipt(receipt, { reread: async () => Promise.reject(new Error('x')) })).outcome).toBe('unverified');
  });
});

describe('carry-over of a closed card (A7.4c item 4)', () => {
  const frozen = held({ kind: 'answer' });
  it('hands the frozen items on as a card receipt with the original at', () => {
    const result = carryOverReceipt(frozen, { by: 'sent', turnId: 'turn-5', cardBuiltFromCarried: false });
    expect(result).toEqual({ receipt: { ...frozen, kind: 'card', turnId: 'turn-5', carried: true } });
    if ('receipt' in result) expect(result.receipt.at).toBe(T0);
  });
  it.each(['declined', 'expired', 'owner-void'] as const)('carries on %s', (by) => {
    expect('receipt' in carryOverReceipt(frozen, { by, turnId: 't', cardBuiltFromCarried: false })).toBe(true);
  });
  it.each(['kill-switch', 'trip'] as const)('hands nothing on after %s', (by) => {
    expect(carryOverReceipt(frozen, { by, turnId: 't', cardBuiltFromCarried: false })).toEqual({ refused: 'closed-by-stop' });
  });
  it('a card receipt is never carried again, with or without the carried flag', () => {
    expect(carryOverReceipt({ ...frozen, kind: 'card' }, { by: 'sent', turnId: 't', cardBuiltFromCarried: false })).toEqual({ refused: 'carried-twice' });
  });
  it('at most one carry-over', () => {
    expect(carryOverReceipt(frozen, { by: 'sent', turnId: 't', cardBuiltFromCarried: true })).toEqual({ refused: 'carried-twice' });
    const carried = carryOverReceipt(frozen, { by: 'sent', turnId: 't', cardBuiltFromCarried: false });
    if ('receipt' in carried) expect(carryOverReceipt(carried.receipt, { by: 'sent', turnId: 't2', cardBuiltFromCarried: false })).toEqual({ refused: 'carried-twice' });
  });
});

describe('shadow logging', () => {
  it('logs only mode, kind, a closed source, the count and a closed outcome', () => {
    const lines: [string, unknown][] = [];
    const logger = { info: (event: string, fields: unknown) => lines.push([event, fields]), warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;
    logHeldReceiptShadow(logger, { kind: 'listing', source: 'jira', items: 3 });
    logHeldReceiptShadow(logger, { kind: 'listing', source: 'Title: secret text', items: 12 });
    expect(lines.slice(0, 2)).toEqual([
      [A7_HELD_RECEIPT_SHADOW_LOG_EVENT, { mode: 'shadow', kind: 'listing', source: 'jira', items: 3, outcome: 'count-ok' }],
      [A7_HELD_RECEIPT_SHADOW_LOG_EVENT, { mode: 'shadow', kind: 'listing', source: 'other', items: 12, outcome: 'too-many' }],
    ]);
    logHeldReceiptShadow(logger, { kind: 'listing', source: 'canary-token-shaped-text', items: 1 });
    expect(lines[2]).toEqual([A7_HELD_RECEIPT_SHADOW_LOG_EVENT, { mode: 'shadow', kind: 'listing', source: 'other', items: 1, outcome: 'count-ok' }]);
    expect([...HELD_RECEIPT_SHADOW_SOURCES].every((source) => isListingSource(source))).toBe(true);
    expect(HELD_RECEIPT_SHADOW_SOURCES).toHaveLength(6);
    expect([heldReceiptShadowOutcome(0), heldReceiptShadowOutcome(-1)]).toEqual(['empty', 'shape']);
  });
  it('a throwing logger never throws', () => {
    const logger = { info: () => { throw new Error('x'); } } as unknown as Logger;
    expect(() => logHeldReceiptShadow(logger, { kind: 'answer', source: 'slack', items: 1 })).not.toThrow();
  });
});
