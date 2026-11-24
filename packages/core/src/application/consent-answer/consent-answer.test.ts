import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_ANSWER_CODES,
  answerConsentTurn,
  closedConsentToken,
  consentAnswerLabel,
  consentReaskQuestion,
  consentReplyShape,
  consentRerunText,
  type ConsentAnswerClassifier,
  type ConsentClassifierSwitch,
  type ConsentReplyTurn,
  type ConsentTurnDecision,
} from './consent-answer';
import {
  CONSENT_ANSWER_WINDOW_MS,
  ConsentPendingInvalidError,
  ConsentPendingStore,
  isConsentPending,
  summaryConsentPending,
  topicConsentPending,
  type ConsentPending,
  type ConsentScope,
} from './consent-pending';

/** ADR-0121 amendment A6, slice A6-S1: the claim, the structural checks, the fast path, the bind and the switch. */

const T0 = 1_800_000_000_000;
const DM: ConsentScope = { actorId: 'owner-1', conversationKey: 'dm-1' };
const OFF: ConsentClassifierSwitch = { mode: 'off' };
const on = (label: unknown): ConsentClassifierSwitch & { classify: ReturnType<typeof vi.fn> } => {
  const classify = vi.fn<ConsentAnswerClassifier>(async () => label);
  return { mode: 'on', classify };
};

function summary(overrides: Partial<Parameters<typeof summaryConsentPending>[0]> = {}): ConsentPending {
  return summaryConsentPending({ scope: DM, language: 'ko', createdAtMs: T0, recipient: 'Claude', itemIds: ['msg-1', 'msg-2'], sources: ['mail'], ...overrides });
}
function topic(): ConsentPending {
  return topicConsentPending({ scope: DM, language: 'ko', createdAtMs: T0, recipient: 'Claude', topic: 'AI Agent 1차 면접' });
}
function opened(pending: ConsentPending = summary()): ConsentPendingStore {
  const store = new ConsentPendingStore();
  store.open(pending);
  return store;
}
/** The tests supply the clock explicitly: the bind time is a fresh `now()` read, and by default the turn's own time. */
const answer = (store: ConsentPendingStore, t: ConsentReplyTurn, classifier: ConsentClassifierSwitch, now: () => number = () => t.atMs): Promise<ConsentTurnDecision> =>
  answerConsentTurn(store, t, classifier, now);
/** A clock whose successive reads are `times` (the claim read, then the bind read); the last value repeats. */
const reads = (...times: number[]): (() => number) => () => (times.length > 1 ? (times.shift() as number) : (times[0] as number));
const turn = (text: string, extra: Partial<ConsentReplyTurn> = {}): ConsentReplyTurn => ({ scope: DM, ownerDm: true, text, atMs: T0 + 30_000, ...extra });

describe('A6-S1 branded pending types and producers', () => {
  it('mints frozen steps with no origin field (AM-1) and refuses invalid input with a value-free code', () => {
    const p = summary();
    expect(isConsentPending(p)).toBe(true);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.keys(p).sort()).toEqual(['createdAtMs', 'itemIds', 'kind', 'language', 'reasked', 'recipient', 'scope', 'sources']);
    expect('origin' in p).toBe(false);
    expect(Object.keys(topic()).sort()).toEqual(['createdAtMs', 'kind', 'language', 'reasked', 'recipient', 'scope', 'topic']);
    for (const [bad, code] of [
      [{ itemIds: [] }, 'items'],
      [{ itemIds: ['a', 'a'] }, 'items'],
      [{ sources: [] }, 'sources'],
      [{ recipient: ' ' }, 'recipient'],
      [{ createdAtMs: Number.NaN }, 'time'],
      [{ scope: { actorId: '', conversationKey: 'x' } }, 'scope'],
    ] as const) {
      expect(() => summary(bad as never), code).toThrowError(new ConsentPendingInvalidError(code).message);
    }
  });

  it('refuses to open a structurally copied step: only a producer-made step has the run-time brand', () => {
    const copy = { ...summary() } as ConsentPending;
    expect(isConsentPending(copy)).toBe(false);
    expect(() => new ConsentPendingStore().open(copy)).toThrow('consent-pending-not-minted');
    // Any other pending step shape (an approval, an undo confirmation, a channel grant) is refused the same way.
    expect(() => new ConsentPendingStore().open({ kind: 'write-approval' } as never)).toThrow('consent-pending-not-minted');
  });
});

describe('A6-S1 the atomic claim and the compare-and-set bind (A6.3 steps 1, 4, 5)', () => {
  it('a closed yes binds exactly the pending step, once; a second yes answers nothing', async () => {
    const p = summary();
    const store = opened(p);
    const first = await answer(store, turn('응'), OFF);
    expect(first).toMatchObject({ kind: 'bound', audit: ['closed-yes'], next: 'consumed' });
    expect(first.kind === 'bound' && first.bound.pending).toBe(p);
    expect(store.stateOf(DM)).toBe('used');
    expect(await answer(store, turn('응'), OFF)).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    expect(await answer(store, turn('응'), OFF)).toEqual({ kind: 'not-an-answer', audit: [], next: 'ordinary' });
  });

  it('W2: 599 s answers, 600 s and later do not (the turn takes the normal path)', async () => {
    expect((await answer(opened(), turn('응', { atMs: T0 + 599_000 }), OFF)).kind).toBe('bound');
    for (const age of [CONSENT_ANSWER_WINDOW_MS, 601_000, 3_600_000]) {
      expect(await answer(opened(), turn('응', { atMs: T0 + age }), OFF), String(age)).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    }
    // A clock before the question is not fresh either (fail closed).
    expect((await answer(opened(), turn('응', { atMs: T0 - 1 }), OFF)).kind).toBe('not-an-answer');
  });

  it('only the owner DM of the question answers: another conversation, another actor or a channel turn leaves the step open', async () => {
    const store = opened();
    for (const t of [turn('응', { scope: { ...DM, conversationKey: 'channel-1' } }), turn('응', { scope: { ...DM, actorId: 'other' } }), turn('응', { ownerDm: false })]) {
      expect(await answer(store, t, OFF)).toEqual({ kind: 'not-an-answer', audit: [], next: 'ordinary' });
      expect(store.stateOf(DM)).toBe('open');
    }
    expect((await answer(store, turn('응'), OFF)).kind).toBe('bound');
  });

  it('an intervening owner turn supersedes the step, the kill switch voids it, a restart forgets it', async () => {
    const superseded = opened();
    expect((await answer(superseded, turn('주말 날씨는 어떨 것 같아'), OFF)).kind).toBe('cancelled');
    expect((await answer(superseded, turn('응'), OFF)).kind).toBe('not-an-answer');
    const voided = opened();
    voided.voidAll();
    expect(voided.stateOf(DM)).toBe('voided');
    expect(await answer(voided, turn('응'), OFF)).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    expect(await answer(new ConsentPendingStore(), turn('응'), OFF)).toEqual({ kind: 'not-an-answer', audit: [], next: 'ordinary' });
  });

  it('a newer step supersedes an older one: the older claim can never bind', () => {
    const store = opened();
    const claimed = store.claim(DM, T0 + 1);
    expect(claimed.ok).toBe(true);
    store.open(summary({ itemIds: ['msg-9'] }));
    expect(claimed.ok && store.bind(claimed.claim, T0 + 2)).toBeUndefined();
    expect(store.stateOf(DM)).toBe('open');
  });

  it('A6.3 step 5: a turn while the step is answering cancels it; the in-flight label is discarded and nothing binds', async () => {
    const store = opened();
    let release: (label: string) => void = () => undefined;
    const classify = vi.fn<ConsentAnswerClassifier>(() => new Promise((resolve) => (release = resolve)));
    const inFlight = answer(store, turn('ㅇㅇ'), { mode: 'on', classify });
    expect(store.stateOf(DM)).toBe('answering');
    expect(await answer(store, turn('응', { atMs: T0 + 31_000 }), OFF)).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    release('yes');
    expect(await inFlight).toEqual({ kind: 'cancelled', audit: ['classifier-yes', 'claim-lost'], next: 'consumed' });
  });

  it('the kill switch during the classifier call voids the step: the bind fails', async () => {
    const store = opened();
    const classify = vi.fn<ConsentAnswerClassifier>(async () => {
      store.voidAll();
      return 'yes';
    });
    expect(await answer(store, turn('ㅇㅇ'), { mode: 'on', classify })).toMatchObject({ kind: 'cancelled', audit: ['classifier-yes', 'claim-lost'] });
    expect(store.stateOf(DM)).toBe('voided');
  });

  it('a classifier result at exactly 600 s after the question does not bind (the label is late; fail closed)', async () => {
    const store = opened();
    const decision = await answer(store, turn('ㅇㅇ', { atMs: T0 + 100 }), on('yes'), reads(T0 + 100, T0 + CONSENT_ANSWER_WINDOW_MS));
    expect(decision).toMatchObject({ kind: 'cancelled', audit: ['classifier-yes', 'claim-lost'] });
    expect(store.stateOf(DM)).toBe('expired');
    const justBefore = await answer(opened(), turn('ㅇㅇ', { atMs: T0 + 100 }), on('yes'), reads(T0 + 100, T0 + CONSENT_ANSWER_WINDOW_MS - 1));
    expect(justBefore.kind).toBe('bound');
  });

  it('a closed yes binds on the supplied clock too: a bind time past W2 expires the step instead of binding', async () => {
    const store = opened();
    expect(await answer(store, turn('응', { atMs: T0 + 599_000 }), OFF, reads(T0 + 599_000, T0 + 601_000))).toEqual({ kind: 'cancelled', audit: ['closed-yes', 'claim-lost'], next: 'consumed' });
    expect(store.stateOf(DM)).toBe('expired');
  });

  it('the default clock is the real current time at bind, not the message arrival time', async () => {
    const real = Date.now();
    const pending = summary({ createdAtMs: real - 1_000 });
    // Arrival time claims freshness, but the real clock is far past W2 relative to a step created long ago.
    const stale = summary({ createdAtMs: real - 700_000 });
    const lateStore = opened(stale);
    const claimedAt = real - 700_000 + 1_000;
    expect(await answerConsentTurn(lateStore, { scope: DM, ownerDm: true, text: '응', atMs: claimedAt }, OFF, reads(claimedAt, real))).toMatchObject({ kind: 'cancelled', audit: ['closed-yes', 'claim-lost'] });
    expect(await answerConsentTurn(opened(pending), { scope: DM, ownerDm: true, text: '응', atMs: real }, OFF)).toMatchObject({ kind: 'bound' });
  });

  it('a clock that throws at the claim read leaves the step open; one that throws at bind releases the claim (never left answering) and rethrows', async () => {
    const untouched = opened();
    await expect(answer(untouched, turn('응'), OFF, () => { throw new Error('clock'); })).rejects.toThrow('clock');
    expect(untouched.stateOf(DM)).toBe('open');
    const throwAtBind = (): (() => number) => {
      let reads = 0;
      return () => {
        reads += 1;
        if (reads > 1) throw new Error('clock');
        return T0 + 30_000;
      };
    };
    const store = opened();
    await expect(answer(store, turn('응'), OFF, throwAtBind())).rejects.toThrow('clock');
    expect(store.stateOf(DM)).toBe('cancelled');
    expect(await answer(store, turn('응'), OFF)).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    const again = opened();
    await expect(answer(again, turn('ㅇㅇ'), on('yes'), throwAtBind())).rejects.toThrow('clock');
    expect(again.stateOf(DM)).toBe('cancelled');
    // The step is gone after the next turn consumed the chance; a later claim is lost, nothing binds (reopening is needed).
    expect(again.claim(DM, T0 + 40_000)).toEqual({ ok: false, reason: 'claim-lost' });
  });

  it('the claim is judged on now(), not on the platform arrival time: one clock domain', async () => {
    const lateClock = await answer(opened(), turn('응', { atMs: T0 + 1_000 }), OFF, () => T0 + CONSENT_ANSWER_WINDOW_MS + 5);
    expect(lateClock).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    const skewedArrival = await answer(opened(), turn('응', { atMs: T0 + CONSENT_ANSWER_WINDOW_MS + 5 }), OFF, () => T0 + 1_000);
    expect(skewedArrival.kind).toBe('bound');
  });

  it('a non-finite clock at the re-ask expires the step and voids the claim (never left answering, never bindable later)', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const store = opened();
      const reads = [T0 + 30_000, bad];
      const decision = await answer(store, turn('음…'), on('unclear'), () => reads.shift() ?? bad);
      expect(decision).toEqual({ kind: 'cancelled', audit: ['classifier-unclear', 'claim-lost'], next: 'consumed' });
      expect(store.stateOf(DM)).toBe('expired');
    }
  });

  it('a classifier-path answer with the real default clock binds a fresh step', async () => {
    const real = Date.now();
    const store = opened(summary({ createdAtMs: real - 1_000 }));
    expect(await answerConsentTurn(store, { scope: DM, ownerDm: true, text: 'ㅇㅇ', atMs: real }, on('yes'))).toMatchObject({ kind: 'bound', audit: ['classifier-yes'] });
  });

  it('a second unclear after the claim was lost carries claim-lost in the audit', async () => {
    const store = opened();
    await answer(store, turn('음…'), on('unclear'));
    let release: (label: string) => void = () => undefined;
    const classify = vi.fn<ConsentAnswerClassifier>(() => new Promise((resolve) => (release = resolve)));
    const inFlight = answer(store, turn('글쎄', { atMs: T0 + 40_000 }), { mode: 'on', classify });
    store.voidAll();
    release('unclear');
    expect(await inFlight).toEqual({ kind: 'cancelled', audit: ['classifier-unclear', 'claim-lost'], next: 'consumed' });
  });

  it('r-02 returns the remainder byte-identical after only the first line and its own terminator', () => {
    const rest = '드라이브도\u2028같이\r\n\n\n  그리고  캘린더 ';
    expect(consentRerunText(`응\n${rest}`)).toBe(rest);
    expect(consentRerunText(`네\r\n${rest}`)).toBe(rest);
    expect(consentRerunText(`yes\u2028${rest}`)).toBe(rest);
    expect(consentRerunText(`응\n\n${rest}`)).toBe(`\n${rest}`);
    // Only whitespace remains: no remaining request, the whole message as before.
    expect(consentRerunText('응\n  \n')).toBe('응\n  \n');
    expect(consentRerunText('응')).toBe('응');
  });

  it('the re-asked step still answers by a closed yes (the fast path never depends on the re-ask)', async () => {
    const store = opened();
    await answer(store, turn('음…'), on('unclear'));
    expect(await answer(store, turn('응', { atMs: T0 + 40_000 }), OFF)).toMatchObject({ kind: 'bound', audit: ['closed-yes'] });
  });

  it('audit codes are closed and content-free', async () => {
    const seen = new Set<string>();
    const replies: Array<[string, ConsentClassifierSwitch]> = [
      ['응', OFF], ['아니', OFF], ['ㅇㅇ', OFF], ['> 응', OFF], ['응\n응\n응\n응', OFF], ['ㅇㅇ', on('yes')], ['ㅇㅇ', on('yes-and-more')], ['ㅇㅇ', on('no')], ['ㅇㅇ', on('other')], ['ㅇㅇ', on('unclear')],
    ];
    for (const [text, sw] of replies) for (const code of (await answer(opened(), turn(text), sw)).audit) seen.add(code);
    const store = opened();
    store.voidAll();
    for (const code of (await answer(store, turn('응'), OFF)).audit) seen.add(code);
    expect([...seen].sort()).toEqual([...CONSENT_ANSWER_CODES].sort());
  });
});

describe('A6-S1 review round 2: non-finite times and generations', () => {
  it('reask with a non-finite time expires the step; the old claim can never bind later', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const store = opened();
      const claimed = store.claim(DM, T0 + 1_000);
      if (!claimed.ok) throw new Error('claim');
      expect(store.reask(claimed.claim, bad)).toBeUndefined();
      expect(store.stateOf(DM)).toBe('expired');
      expect(store.bind(claimed.claim, T0 + 2_000)).toBeUndefined();
      expect(store.holds(claimed.claim)).toBe(false);
    }
  });

  it('claim and bind with a non-finite time never leave a step answering or a claim alive', () => {
    const store = opened();
    expect(store.claim(DM, Number.NaN)).toEqual({ ok: false, reason: 'claim-lost' });
    expect(store.stateOf(DM)).toBeUndefined();
    const second = opened();
    const claimed = second.claim(DM, T0 + 1_000);
    if (!claimed.ok) throw new Error('claim');
    expect(second.bind(claimed.claim, Number.NaN)).toBeUndefined();
    expect(second.stateOf(DM)).toBe('expired');
    expect(second.bind(claimed.claim, T0 + 2_000)).toBeUndefined();
    const third = opened();
    const c3 = third.claim(DM, T0 + 1_000);
    if (!c3.ok) throw new Error('claim');
    third.cancel(c3.claim);
    expect(third.stateOf(DM)).toBe('cancelled');
  });

  it('versions are never reused across stores: a claim of one store cannot bind in another holding the same pending', () => {
    const pending = summary();
    const a = opened(pending);
    const b = opened(pending);
    const claimed = a.claim(DM, T0 + 1_000);
    if (!claimed.ok) throw new Error('claim');
    const other = b.claim(DM, T0 + 1_000);
    if (!other.ok) throw new Error('claim');
    expect(claimed.claim.version).not.toBe(other.claim.version);
    expect(b.bind(claimed.claim, T0 + 2_000)).toBeUndefined();
    expect(b.stateOf(DM)).toBe('answering');
    expect(a.bind(claimed.claim, T0 + 2_000)).toBeDefined();
  });
});
