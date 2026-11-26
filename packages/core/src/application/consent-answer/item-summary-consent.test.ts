import { describe, expect, it } from 'vitest';
import type { Actor } from '../../domain';
import { itemSummaryConsentDescriptor, type ItemSummaryConsentDescriptor } from '../item-summary-consent-descriptor';
import type { RecipientVerdict } from '../item-summary/expected-recipient';
import { yesBound } from '../agent/summary-consent.test-support';
import { ITEM_SUMMARY_CONSENT_MAX_RECORDS, ITEM_SUMMARY_TOKEN_TTL_MS, ItemSummaryConsent, type ItemSummaryConsentToken, type ItemSummaryUse } from './item-summary-consent';
import { ConsentPendingStore, type BoundConsent } from './consent-pending';

// A8 OQ1-1: the item-summary continuation and its token, over a REAL store and the REAL answer pipeline (the owner-yes mark).

const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: '2026-11-26T00:00:00.000Z' };
const KEY = 'discord||dm-1|';
const SCOPE = { actorId: OWNER.id, conversationKey: KEY };
const T0 = 1_000;
const RECIPIENT = { key: 'k-remote', label: 'Rcpt' };
const DESCRIPTOR: ItemSummaryConsentDescriptor = itemSummaryConsentDescriptor({ handlerId: 'h', source: 'mail', itemId: 'item-1', language: 'ko' });
const unexpected = (key = RECIPIENT.key, label = RECIPIENT.label): RecipientVerdict => ({ kind: 'unexpected', key, label });
const use = (phase: ItemSummaryUse['phase'] = 'call', over: Partial<ItemSummaryUse> = {}): ItemSummaryUse => ({ phase, actorId: OWNER.id, conversationKey: KEY, source: 'mail', itemId: 'item-1', ...over });
const direct = { actor: OWNER, conversationKey: KEY, direct: true };

function rig() {
  const store = new ConsentPendingStore();
  const clock = { now: T0 };
  const logs: unknown[] = [];
  const items = new ItemSummaryConsent({ store, now: () => clock.now, logger: { info: (m: string, f?: unknown) => logs.push([m, f]), warn: (m: string, f?: unknown) => logs.push([m, f]), error: () => undefined } });
  const ask = (descriptor = DESCRIPTOR, scope = SCOPE) => items.ask({ scope, descriptor, recipient: RECIPIENT, requestText: 'summarise item 1' });
  const yes = (atMs = T0 + 1): BoundConsent => yesBound(store, SCOPE, '응', atMs);
  return { store, clock, items, ask, yes, logs };
}

describe('ItemSummaryConsent (A8 OQ1-1)', () => {
  it('ask opens a one-item pending step naming the recipient label; owns reports it', () => {
    const r = rig();
    const asked = r.ask();
    expect(asked).toBeDefined();
    expect(r.items.owns(asked!.runRef)).toBe(true);
    expect(r.items.owns('other-run')).toBe(false);
    expect(r.store.stateOf(SCOPE)).toBe('open');
  });

  it('a yes takes the continuation once and mints a token for exactly the recipient key and label', () => {
    const r = rig();
    r.ask();
    const taken = r.items.take(r.yes(), direct);
    expect(taken?.descriptor).toBe(DESCRIPTOR);
    expect(taken?.requestText).toBe('summarise item 1');
    expect(taken?.recipient).toEqual(RECIPIENT);
    expect(r.items.allows(taken?.token, unexpected(), use('call'))).toBe(true);
  });

  it('single use: a second take of the same bound finds nothing', () => {
    const r = rig();
    r.ask();
    const bound = r.yes();
    expect(r.items.take(bound, direct)).toBeDefined();
    expect(r.items.take(bound, direct)).toBeUndefined();
  });

  it('no mint without the owner-yes mark: an open step, a claim, a copy or a no is refused', () => {
    const r = rig();
    const asked = r.ask()!;
    const forged = { pending: { kind: 'summary-consent', runRef: asked.runRef, scope: SCOPE, sources: [{ source: 'mail', itemIds: ['item-1'] }], recipient: RECIPIENT.label }, boundAtMs: T0 } as unknown as BoundConsent;
    expect(r.items.take(forged, direct)).toBeUndefined();
    expect(r.items.owns(asked.runRef)).toBe(true);
    const claimed = r.store.claim(SCOPE, T0 + 1);
    expect(claimed.ok).toBe(true);
    const bound = claimed.ok ? r.store.bind(claimed.claim, T0 + 2) : undefined;
    expect(bound).toBeDefined();
    // Store-bound but never recorded as a yes by the answer pipeline: refused.
    expect(r.items.take(bound as BoundConsent, direct)).toBeUndefined();
  });

  it('refuses another actor, another conversation and a channel turn; the record is consumed by the genuine yes', () => {
    for (const turn of [{ actor: { ...OWNER, id: 'intruder' }, conversationKey: KEY, direct: true }, { actor: OWNER, conversationKey: 'discord||dm-2|', direct: true }, { actor: OWNER, conversationKey: KEY, direct: false }]) {
      const r = rig();
      const asked = r.ask()!;
      expect(r.items.take(r.yes(), turn)).toBeUndefined();
      expect(r.items.owns(asked.runRef)).toBe(false);
    }
  });

  it('a record dies after its window: a late take is refused', () => {
    const r = rig();
    r.ask();
    const bound = r.yes();
    r.clock.now = T0 + 1_200_001;
    expect(r.items.take(bound, direct)).toBeUndefined();
  });

  describe('re-ask', () => {
    const reasked = (r: ReturnType<typeof rig>, reaskAtMs: number) => {
      const claimed = r.store.claim(SCOPE, reaskAtMs);
      if (!claimed.ok) throw new Error('claim lost');
      expect(r.store.reask(claimed.claim, reaskAtMs)).toBeDefined();
    };

    it('a re-ask near the end of the first window, then a yes within the new window, mints', () => {
      const r = rig();
      r.ask();
      reasked(r, T0 + 590_000);
      r.clock.now = T0 + 1_150_000;
      const taken = r.items.take(r.yes(T0 + 1_150_000), direct);
      expect(taken).toBeDefined();
      expect(r.items.allows(taken?.token, unexpected(), use('call'))).toBe(true);
    });

    it('a yes more than 600 s after the re-ask is refused', () => {
      const r = rig();
      r.ask();
      reasked(r, T0 + 590_000);
      r.clock.now = T0 + 1_195_000;
      let taken: ReturnType<typeof r.items.take>;
      try {
        taken = r.items.take(r.yes(T0 + 1_195_000), direct);
      } catch {
        taken = undefined; // the store refused the late claim: no bound consent exists
      }
      expect(taken).toBeUndefined();
    });
  });

  it('keeps at most 64 records (the oldest is dropped)', () => {
    const r = rig();
    const refs: string[] = [];
    for (let i = 0; i < ITEM_SUMMARY_CONSENT_MAX_RECORDS + 3; i += 1) refs.push(r.ask(DESCRIPTOR, { actorId: `a-${i}`, conversationKey: `c-${i}` })!.runRef);
    const alive = refs.filter((ref) => r.items.owns(ref));
    expect(alive).toHaveLength(ITEM_SUMMARY_CONSENT_MAX_RECORDS);
    expect(r.items.owns(refs[0] as string)).toBe(false);
    expect(r.items.owns(refs[refs.length - 1] as string)).toBe(true);
  });

  it('invalid input opens nothing', () => {
    const r = rig();
    expect(r.items.ask({ scope: SCOPE, descriptor: { ...DESCRIPTOR, source: 'calendar-x' as never }, recipient: RECIPIENT, requestText: '' })).toBeUndefined();
    expect(r.items.ask({ scope: SCOPE, descriptor: DESCRIPTOR, recipient: { key: '', label: 'L' }, requestText: '' })).toBeUndefined();
    expect(r.items.ask({ scope: { actorId: '', conversationKey: KEY }, descriptor: DESCRIPTOR, recipient: RECIPIENT, requestText: '' })).toBeUndefined();
    expect(r.store.stateOf(SCOPE)).toBeUndefined();
  });

  describe('allows(token, verdict)', () => {
    const token = (): { r: ReturnType<typeof rig>; token: ItemSummaryConsentToken } => {
      const r = rig();
      r.ask();
      return { r, token: r.items.take(r.yes(), direct)!.token };
    };

    it('local and expected need no token; unnamed never', () => {
      const r = rig();
      expect(r.items.allows(undefined, { kind: 'local' }, use())).toBe(true);
      expect(r.items.allows(undefined, { kind: 'expected', key: 'k', label: 'L' }, use())).toBe(true);
      expect(r.items.allows(undefined, { kind: 'unexpected', key: 'k', label: 'L' }, use())).toBe(false);
      expect(r.items.allows(undefined, { kind: 'unnamed' }, use())).toBe(false);
      const { r: r2, token: t } = token();
      expect(r2.items.allows(t, { kind: 'unnamed' }, use())).toBe(false);
      // Local and expected stay unaffected by a spent or expired token.
      r2.items.spend(t);
      r2.clock.now = T0 + 10 * ITEM_SUMMARY_TOKEN_TTL_MS;
      expect(r2.items.allows(t, { kind: 'local' }, use())).toBe(true);
      expect(r2.items.allows(t, { kind: 'expected', key: 'k', label: 'L' }, use('regeneration'))).toBe(true);
    });

    it('unexpected needs the unspent token of the same key AND label', () => {
      const { r, token: t } = token();
      expect(r.items.allows(t, unexpected('k-other'), use())).toBe(false);
      expect(r.items.allows(t, unexpected(RECIPIENT.key, 'Other'), use())).toBe(false);
      expect(r.items.allows(undefined, unexpected(), use())).toBe(false);
      // The refusals consumed nothing.
      expect(r.items.allows(t, unexpected(), use())).toBe(true);
    });

    it('OQ1-3 review round 1: allowsContinuation judges EVERY REMOTE recipient (expected too) by the token; LOCAL and unnamed are false', () => {
      const expected = (key = RECIPIENT.key, label = RECIPIENT.label): RecipientVerdict => ({ kind: 'expected', key, label });
      const { r, token: t } = token();
      expect(r.items.allowsContinuation(undefined, expected(), use())).toBe(false);
      expect(r.items.allowsContinuation(t, expected('k-other'), use())).toBe(false);
      expect(r.items.allowsContinuation(t, expected(RECIPIENT.key, 'Other'), use())).toBe(false);
      expect(r.items.allowsContinuation(t, { kind: 'local' }, use())).toBe(false);
      expect(r.items.allowsContinuation(t, { kind: 'unnamed' }, use())).toBe(false);
      expect(r.items.allowsContinuation(t, expected(), use('regeneration'))).toBe(false);
      expect(r.items.allowsContinuation(t, expected(), use('call'))).toBe(true);
      expect(r.items.allowsContinuation(t, unexpected(), use('call'))).toBe(false);
      expect(r.items.allowsContinuation(t, unexpected(), use('regeneration'))).toBe(true);
      expect(r.items.allowsContinuation(t, expected(), use('regeneration'))).toBe(false);
      // Expired, voided and spent tokens grant nothing, expected or not.
      const late = token();
      late.r.clock.now = T0 + 1 + ITEM_SUMMARY_TOKEN_TTL_MS + 1;
      expect(late.r.items.allowsContinuation(late.token, expected(), use())).toBe(false);
      const voided = token();
      voided.r.items.voidAll();
      expect(voided.r.items.allowsContinuation(voided.token, expected(), use())).toBe(false);
      const spent = token();
      spent.r.items.spend(spent.token);
      expect(spent.r.items.allowsContinuation(spent.token, expected(), use())).toBe(false);
    });

    it('the call is single-use; the regeneration is allowed once and only after the call', () => {
      const { r, token: t } = token();
      expect(r.items.allows(t, unexpected(), use('regeneration'))).toBe(false);
      expect(r.items.allows(t, unexpected(), use('call'))).toBe(true);
      expect(r.items.allows(t, unexpected(), use('call'))).toBe(false);
      expect(r.items.allows(t, unexpected(), use('regeneration'))).toBe(true);
      expect(r.items.allows(t, unexpected(), use('regeneration'))).toBe(false);
    });

    it('another item, source, actor or conversation is refused and consumes nothing', () => {
      const { r, token: t } = token();
      expect(r.items.allows(t, unexpected(), use('call', { itemId: 'item-2' }))).toBe(false);
      expect(r.items.allows(t, unexpected(), use('call', { source: 'drive' }))).toBe(false);
      expect(r.items.allows(t, unexpected(), use('call', { actorId: 'intruder' }))).toBe(false);
      expect(r.items.allows(t, unexpected(), use('call', { conversationKey: 'discord||dm-2|' }))).toBe(false);
      expect(r.items.allows(t, unexpected(), use('call'))).toBe(true);
    });

    it('an expired token is refused (600 s from its mint, shared clock)', () => {
      const { r, token: t } = token();
      r.clock.now = T0 + 1 + ITEM_SUMMARY_TOKEN_TTL_MS - 2;
      expect(r.items.allows(t, unexpected(), use('call'))).toBe(true);
      r.clock.now = T0 + 1 + ITEM_SUMMARY_TOKEN_TTL_MS + 1;
      expect(r.items.allows(t, unexpected(), use('regeneration'))).toBe(false);
      const fresh = token();
      fresh.r.clock.now = T0 + 1 + ITEM_SUMMARY_TOKEN_TTL_MS + 1;
      expect(fresh.r.items.allows(fresh.token, unexpected(), use('call'))).toBe(false);
    });

    it('a forged token, a foreign instance token and a spent token grant nothing', () => {
      const { r, token: t } = token();
      expect(r.items.allows({ kind: 'item-summary-consent-token' }, unexpected(), use())).toBe(false);
      expect(rig().items.allows(t, unexpected(), use())).toBe(false);
      r.items.spend(t);
      expect(r.items.allows(t, unexpected(), use())).toBe(false);
    });

    it('voidAll voids records and outstanding tokens', () => {
      const { r, token: t } = token();
      const again = r.ask(DESCRIPTOR, { actorId: 'x', conversationKey: 'y' })!;
      r.items.voidAll();
      expect(r.items.allows(t, unexpected(), use())).toBe(false);
      expect(r.items.owns(again.runRef)).toBe(false);
    });
  });

  it('logs hold no owner text or ids on a refused ask', () => {
    const r = rig();
    r.items.ask({ scope: SCOPE, descriptor: DESCRIPTOR, recipient: { key: '', label: '' }, requestText: 'SECRET-TEXT' });
    expect(JSON.stringify(r.logs)).not.toContain('SECRET-TEXT');
  });
});
