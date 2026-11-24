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
    const inFlight = answerConsentTurn(store, turn('ㅇㅇ'), { mode: 'on', classify });
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
    const decision = await answer(store, turn('ㅇㅇ', { atMs: T0 + 100 }), on('yes'), () => T0 + CONSENT_ANSWER_WINDOW_MS);
    expect(decision).toMatchObject({ kind: 'cancelled', audit: ['classifier-yes', 'claim-lost'] });
    expect(store.stateOf(DM)).toBe('expired');
    const justBefore = await answer(opened(), turn('ㅇㅇ', { atMs: T0 + 100 }), on('yes'), () => T0 + CONSENT_ANSWER_WINDOW_MS - 1);
    expect(justBefore.kind).toBe('bound');
  });

  it('a closed yes binds on the supplied clock too: a bind time past W2 expires the step instead of binding', async () => {
    const store = opened();
    expect(await answer(store, turn('응', { atMs: T0 + 599_000 }), OFF, () => T0 + 601_000)).toEqual({ kind: 'cancelled', audit: ['closed-yes', 'claim-lost'], next: 'consumed' });
    expect(store.stateOf(DM)).toBe('expired');
  });

  it('the default clock is the real current time at bind, not the message arrival time', async () => {
    const real = Date.now();
    const pending = summary({ createdAtMs: real - 1_000 });
    // Arrival time claims freshness, but the real clock is far past W2 relative to a step created long ago.
    const stale = summary({ createdAtMs: real - 700_000 });
    const lateStore = opened(stale);
    const claimedAt = real - 700_000 + 1_000;
    expect(await answerConsentTurn(lateStore, { scope: DM, ownerDm: true, text: '응', atMs: claimedAt }, OFF)).toMatchObject({ kind: 'cancelled', audit: ['closed-yes', 'claim-lost'] });
    expect(await answerConsentTurn(opened(pending), { scope: DM, ownerDm: true, text: '응', atMs: real }, OFF)).toMatchObject({ kind: 'bound' });
  });

  it('a throwing clock releases the claimed step (never left answering) and rethrows; the next answer is processed normally', async () => {
    const store = opened();
    await expect(answer(store, turn('응'), OFF, () => { throw new Error('clock'); })).rejects.toThrow('clock');
    expect(store.stateOf(DM)).toBe('cancelled');
    expect(await answer(store, turn('응'), OFF)).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    const again = opened();
    await expect(answer(again, turn('ㅇㅇ'), on('yes'), () => { throw new Error('clock'); })).rejects.toThrow('clock');
    expect(again.stateOf(DM)).toBe('cancelled');
    again.open(summary());
    expect((await answer(again, turn('응'), OFF)).kind).toBe('bound');
  });

  it('a version is never reused: an old claim cannot bind after the record was deleted and the same step reopened', () => {
    const p = summary();
    const store = opened(p);
    const old = store.claim(DM, T0 + 1);
    expect(old.ok).toBe(true);
    store.voidAll();
    expect(store.claim(DM, T0 + 2)).toEqual({ ok: false, reason: 'claim-lost' }); // forgets (deletes) the voided record
    store.open(p);
    expect(old.ok && store.bind(old.claim, T0 + 3)).toBeUndefined();
    const fresher = store.claim(DM, T0 + 4);
    expect(fresher.ok && old.ok && fresher.claim.version > old.claim.version).toBe(true);
    expect(old.ok && store.bind(old.claim, T0 + 5)).toBeUndefined();
    expect(fresher.ok && store.bind(fresher.claim, T0 + 6)).toBeDefined();
  });

  it('a label that arrives after W2 cannot bind (the bind re-checks freshness)', async () => {
    const store = opened();
    const decision = await answer(store, turn('ㅇㅇ', { atMs: T0 + 595_000 }), on('yes'), () => T0 + 605_000);
    expect(decision).toMatchObject({ kind: 'cancelled', audit: ['classifier-yes', 'claim-lost'] });
    expect(store.stateOf(DM)).toBe('expired');
  });
});

describe('A6-S1 the structural checks and the caps (A6.3 step 1, a6-05)', () => {
  it.each([
    ['> 응', 'quote-only'],
    ['"응"', 'quotation marks'],
    ['`yes`', 'code marking'],
    ['응\u200b', 'zero-width space (rt-s2a-135)'],
    ['\u202e응', 'bidi override'],
    ['\ufeff응', 'byte order mark'],
    ['', 'empty'],
    ['응 https://example.test', 'URL shape'],
  ])('%j (%s) fails structurally and never reaches the classifier', async (text) => {
    const classifier = on('yes');
    expect(await answer(opened(), turn(text), classifier)).toEqual({ kind: 'cancelled', audit: ['structural-fail'], next: 'ordinary' });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('a platform quote range or an attachment fails structurally', async () => {
    expect((await answer(opened(), turn('응', { quotedRanges: [{ start: 0, end: 1 }] }), OFF)).audit).toEqual(['structural-fail']);
    expect((await answer(opened(), turn('응', { attachmentCount: 1 }), OFF)).audit).toEqual(['structural-fail']);
  });

  it('a multi-line structural failure is consumed and not re-planned; a single-line one takes the normal path', async () => {
    expect(await answer(opened(), turn('응\n> 응'), OFF)).toEqual({ kind: 'cancelled', audit: ['structural-fail'], next: 'consumed' });
    expect(await answer(opened(), turn('> 응'), OFF)).toEqual({ kind: 'cancelled', audit: ['structural-fail'], next: 'ordinary' });
  });

  it('over the caps (4 lines or 61 characters) is not an answer: cancelled, never consumed, the message runs as a new request', async () => {
    const classifier = on('yes');
    const long = '응 그런데 이 메일들은 지난주에 받은 거라서 다시 확인해 보고 싶은데 우선 목록부터 다시 한 번 정리해서 보여줄 수 있을까';
    for (const text of ['응\n응\n응\n응', long, `${'가'.repeat(61)}`, `> ${'응'.repeat(70)}`]) {
      const store = opened();
      expect(await answer(store, turn(text), classifier), text).toEqual({ kind: 'cancelled', audit: ['over-caps'], next: 'ordinary' });
      expect(store.stateOf(DM)).toBe('cancelled');
    }
    expect(classifier.classify).not.toHaveBeenCalled();
    // At the caps exactly: still a reply (3 lines, 60 characters).
    expect(consentReplyShape({ text: '가'.repeat(60) })).toEqual({ kind: 'answer', lines: 1 });
    expect(consentReplyShape({ text: '응\n응\n응' })).toEqual({ kind: 'answer', lines: 3 });
  });
});

describe('A6-S1 the NFKC fast path (A6.3 step 2) for both consents', () => {
  it.each([
    ['응', 'yes'], ['네', 'yes'], ['예', 'yes'], ['yes', 'yes'], ['YES', 'yes'], ['Yes', 'yes'], ['응.', 'yes'], ['네!', 'yes'], ['응~', 'yes'], ['응?', 'yes'], ['  응  ', 'yes'],
    ['ｙｅｓ', 'yes'], ['ⓨⓔⓢ', 'yes'],
    ['ㄴㅔ', 'yes'], ['ㅇㅖ', 'yes'], ['ʸᵉˢ', 'yes'], ['yeſ', 'yes'], ['𝐲𝐞𝐬', 'yes'], ['№', 'no'],
    ['아니', 'no'], ['아니요', 'no'], ['아니오', 'no'], ['아뇨', 'no'], ['취소', 'no'], ['no', 'no'], ['NO', 'no'], ['아니.', 'no'],
    ['уеs', undefined], ['ㅇㅇ', undefined], ['응!!', undefined], ['응??', undefined], ['응...', undefined], ['응응', undefined], ['ok', undefined], ['y', undefined], ['응\n응', undefined],
  ])('%j → %s', (reply, token) => {
    expect(closedConsentToken(reply)).toBe(token);
  });

  it('a closed yes binds and a closed no cancels (consumed) without any classifier call, for the summary and the topic consent', async () => {
    for (const make of [summary, topic]) {
      const classifier = on('other');
      expect(await answer(opened(make()), turn('ｙｅｓ'), classifier)).toMatchObject({ kind: 'bound', audit: ['closed-yes'], next: 'consumed' });
      expect(await answer(opened(make()), turn('아니요'), classifier)).toEqual({ kind: 'cancelled', audit: ['closed-no'], next: 'consumed' });
      expect(classifier.classify).not.toHaveBeenCalled();
    }
  });
});

describe('A6-S1 the switch QUOKY_CONSENT_ANSWER_CLASSIFIER (default off)', () => {
  it('off: every other reply cancels as W1 does today; a single line takes the normal path, a multi-line reply is consumed (462)', async () => {
    for (const text of ['ㅇㅇ', 'ok', '좋아', '보내', '응!!', 'yes, and also summarize my drive files', '응 근데 메일 10개 더 요약해줘']) {
      const store = opened();
      expect(await answer(store, turn(text), OFF), text).toEqual({ kind: 'cancelled', audit: ['classifier-off'], next: 'ordinary' });
      expect(store.stateOf(DM)).toBe('cancelled');
    }
    for (const text of ['응\n드라이브도 같이', '응\n응']) {
      expect(await answer(opened(), turn(text), OFF), text).toEqual({ kind: 'cancelled', audit: ['classifier-off'], next: 'consumed' });
    }
  });

  it('on: the classifier sees only the consent kind, the language and the reply (content-free, A6.4)', async () => {
    const classifier = on('yes');
    await answer(opened(summary({ language: 'en' })), turn('ok'), classifier);
    await answer(opened(topic()), turn('ㅇㅇ'), classifier);
    expect(classifier.classify.mock.calls).toEqual([[{ consent: 'summary-consent', language: 'en', reply: 'ok' }], [{ consent: 'topic-consent', language: 'ko', reply: 'ㅇㅇ' }]]);
    for (const [request] of classifier.classify.mock.calls) expect(Object.keys(request as object).sort()).toEqual(['consent', 'language', 'reply']);
  });

  it('on: yes binds; no is consumed; a single-line other takes the normal path; a multi-line other is consumed', async () => {
    expect(await answer(opened(), turn('ㅇㅇ'), on('yes'))).toMatchObject({ kind: 'bound', audit: ['classifier-yes'], next: 'consumed' });
    expect(await answer(opened(), turn('ㄴㄴ'), on('no'))).toEqual({ kind: 'cancelled', audit: ['classifier-no'], next: 'consumed' });
    expect(await answer(opened(), turn('응 근데 메일 말고 드라이브만'), on('other'))).toEqual({ kind: 'cancelled', audit: ['classifier-other'], next: 'ordinary' });
    expect(await answer(opened(), turn('응\n누구한테 보내는 건데?'), on('other'))).toEqual({ kind: 'cancelled', audit: ['classifier-other'], next: 'consumed' });
  });

  it('on: yes-and-more binds the asked items once and reruns the whole message (r-01), or the lines after a closed-yes first line (r-02)', async () => {
    const store = opened();
    const single = await answer(store, turn('응 근데 메일 10개 더 요약해줘'), on('yes-and-more'));
    expect(single).toMatchObject({ kind: 'bound', audit: ['classifier-yes-and-more'], next: 'rerun', rerunText: '응 근데 메일 10개 더 요약해줘' });
    // The rerun is a new ordinary turn: the bound step is used, so it can never answer, widen or revive it.
    expect(await answer(store, turn('응 근데 메일 10개 더 요약해줘'), on('yes'))).toEqual({ kind: 'not-an-answer', audit: ['claim-lost'], next: 'ordinary' });
    expect(await answer(opened(), turn('응\n드라이브도 같이'), on('yes-and-more'))).toMatchObject({ next: 'rerun', rerunText: '드라이브도 같이' });
    expect(consentRerunText('네\n드라이브도 같이\n그리고 캘린더')).toBe('드라이브도 같이\n그리고 캘린더');
    // The first line is no closed token: the whole message reruns (no cut by the classifier, never a rewrite).
    expect(consentRerunText('ㅇㅇ\n드라이브도 같이')).toBe('ㅇㅇ\n드라이브도 같이');
    expect(consentRerunText('yes, and also summarize my drive files')).toBe('yes, and also summarize my drive files');
  });

  it('on: unclear (or a malformed result or a failed call) re-asks the fixed question once with the same items; a second unclear cancels', async () => {
    for (const label of ['yes', 'yes-and-more', 'no', 'other', 'unclear']) expect(consentAnswerLabel(label)).toBe(label);
    for (const result of ['YES', ' yes', '{"label":"yes"}', undefined, 42, { label: 'yes' }]) expect(consentAnswerLabel(result), String(result)).toBe('unclear');
    const p = summary();
    const store = opened(p);
    const first = await answer(store, turn('음…'), on('maybe'));
    expect(first).toMatchObject({ kind: 'reask', audit: ['classifier-unclear', 'reask'], question: '보낼까요? (응/아니)', next: 'consumed' });
    const reasked = first.kind === 'reask' ? first.pending : undefined;
    expect(reasked).toMatchObject({ kind: 'summary-consent', itemIds: p.kind === 'summary-consent' ? p.itemIds : [], recipient: p.recipient, reasked: true, createdAtMs: T0 + 30_000 });
    expect(isConsentPending(reasked)).toBe(true);
    // W2 restarted at the re-ask.
    expect(store.stateOf(DM)).toBe('open');
    const failing = vi.fn<ConsentAnswerClassifier>(async () => {
      throw new Error('timeout');
    });
    expect(await answer(store, turn('글쎄', { atMs: T0 + 40_000 }), { mode: 'on', classify: failing })).toEqual({ kind: 'cancelled', audit: ['classifier-unclear'], next: 'consumed' });
    expect(store.stateOf(DM)).toBe('cancelled');
    expect(consentReaskQuestion('en')).toBe('Shall I send it? (yes/no)');
  });

  it('unclear with the clock past W2 expires the step: no re-ask, createdAtMs not refreshed', async () => {
    const p = summary();
    const store = opened(p);
    expect(await answer(store, turn('음…', { atMs: T0 + 595_000 }), on('unclear'), () => T0 + 605_000)).toEqual({ kind: 'cancelled', audit: ['classifier-unclear', 'claim-lost'], next: 'consumed' });
    expect(store.stateOf(DM)).toBe('expired');
    expect(store.claim(DM, T0 + 606_000)).toEqual({ ok: false, reason: 'claim-lost' });
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
    const rest = '드라이브도 같이\r\n\n\n  그리고  캘린더 ';
    expect(consentRerunText(`응\n${rest}`)).toBe(rest);
    expect(consentRerunText(`네\r\n${rest}`)).toBe(rest);
    expect(consentRerunText(`yes ${rest}`)).toBe(rest);
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
