import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { answerConsentTurn, type ConsentAnswerClassifier, type ConsentClassifierSwitch, type ConsentReplyTurn, type ConsentTurnDecision } from './consent-answer';
import { ConsentPendingStore, summaryConsentPending, topicConsentPending, type ConsentScope } from './consent-pending';

/**
 * ADR-0121 amendment A6, slice A6-S1, against the gold: the REAL answer pipeline over every SR-1 summary-consent reply
 * (`agent-redteam.s2-read.v1.json`) and every A2 topic-consent reply (`golden/a2/s2-answer.redteam.v1.json`).
 * - Switch off (the default): the built `expect` / `expected` (the floor, W1 and A2 answer 2 as built) holds case by case,
 *   except where A6-S1 itself is the target: SR-1 `487` and A2 `rt-s2a-136` (the NFKC fast path) now bind.
 * - Switch on, with the owner's verdict as the stubbed label (the classifier is A6-S2): exactly the replies the gold marks as
 *   classifier targets reach the classifier, the structural half holds, and each `awaiting` target's `consentAnswer` (and
 *   rerun) is what the pipeline reports. No gold is changed.
 */

const NOW = 1_800_000_000_000;
const DM: ConsentScope = { actorId: 'owner', conversationKey: 'owner-dm' };
const OFF: ConsentClassifierSwitch = { mode: 'off' };
/** The bind time is a fresh `now()` read; the gold replays use the turn's own time as the clock. */
const answer = (store: ConsentPendingStore, t: ConsentReplyTurn, classifier: ConsentClassifierSwitch): Promise<ConsentTurnDecision> => answerConsentTurn(store, t, classifier, () => t.atMs);

interface Sr1Case {
  readonly id: string;
  readonly text: string;
  readonly channel?: string;
  readonly pending?: { readonly kind: string; readonly state: string; readonly itemIds?: readonly string[]; readonly source?: string; readonly ageSeconds?: number };
  readonly planner?: unknown;
  readonly expect: { readonly outcome: string; readonly remoteSummary: string };
  readonly awaiting?: { readonly slices: readonly string[]; readonly expect: { readonly consentAnswer?: string; readonly rerun?: string } };
}
interface A2Case {
  readonly id: string;
  readonly subFamily: string;
  readonly ownerReply?: string;
  readonly conversation?: string;
  readonly replyPlatform?: string;
  readonly turnsBetween?: readonly { readonly text: string }[];
  readonly turns?: readonly { readonly text: string }[];
  readonly fixture?: { readonly pendingConsent?: { readonly topic: string; readonly ageSeconds: number }; readonly serviceRestarted?: boolean };
  readonly expected: { readonly consentOutcome?: string };
  readonly awaiting?: { readonly slices: readonly string[]; readonly expected: { readonly consentAnswer?: string; readonly rerunAsNewTurn?: boolean } };
}

const golden = (path: string): unknown => JSON.parse(readFileSync(new URL(`../golden/${path}`, import.meta.url), 'utf8'));
const SR1 = (golden('agent-redteam.s2-read.v1.json') as { cases: Sr1Case[] }).cases.filter((c) => c.pending?.kind === 'summary-consent');
const A2 = (golden('a2/s2-answer.redteam.v1.json') as { cases: A2Case[] }).cases.filter((c) => c.subFamily === 'consent');

/** The owner's verdict as the stubbed classifier label (A6-S2 builds the real call). */
const labelOf = (consentAnswer: string | undefined): string | undefined =>
  consentAnswer === 'classifier-yes' ? 'yes' : consentAnswer === 'classifier-yes-and-more' ? 'yes-and-more' : undefined;

async function runSr1(c: Sr1Case, classifier: ConsentClassifierSwitch): Promise<ConsentTurnDecision> {
  const p = c.pending!;
  const store = new ConsentPendingStore();
  const age = (p.ageSeconds ?? 0) * 1000;
  store.open(summaryConsentPending({ scope: DM, language: 'ko', createdAtMs: NOW - age, recipient: 'Claude', sources: [{ source: (p.source ?? 'mail') as 'mail', itemIds: p.itemIds ?? ['item'] }], runRef: 'run-gold' }));
  if (p.state === 'superseded') await answer(store, { scope: DM, ownerDm: true, text: '다른 얘기', atMs: NOW - 1_000 }, OFF);
  if (p.state === 'consumed') await answer(store, { scope: DM, ownerDm: true, text: '응', atMs: NOW - 1_000 }, OFF);
  if (p.state === 'voided') store.voidAll();
  const other = p.state === 'other-conversation';
  return answer(store, { scope: other ? { ...DM, conversationKey: 'elsewhere' } : DM, ownerDm: (c.channel ?? 'owner-dm') === 'owner-dm', text: c.text, atMs: NOW }, classifier);
}

describe('A6-S1 over SR-1 (the summary consent)', () => {
  it('covers every summary-consent reply of SR-1 and every pending state the corpus uses', () => {
    expect(SR1.length).toBeGreaterThan(60);
    expect([...new Set(SR1.map((c) => c.pending!.state))].sort()).toEqual(['consumed', 'expired', 'fresh', 'other-conversation', 'superseded', 'voided']);
  });

  it('switch off: binds exactly where the built expect has a bound yes (plus the A6-S1 target 487); everything else sends nothing', async () => {
    const boundIds: string[] = [];
    for (const c of SR1) {
      const d = await runSr1(c, OFF);
      if (d.kind === 'bound') boundIds.push(c.id);
      const target = c.awaiting?.expect.consentAnswer === 'closed-yes';
      expect(d.kind === 'bound', c.id).toBe(c.expect.remoteSummary === 'bound-yes' || target);
      if (d.kind === 'bound') {
        expect(d.audit, c.id).toEqual(['closed-yes']);
        expect(d.next, c.id).toBe('consumed');
        expect(d.bound.pending.kind === 'summary-consent' && d.bound.pending.sources.flatMap((entry) => entry.itemIds), c.id).toEqual(c.pending!.itemIds);
      }
      // A case whose built expect plans a new request (472, 473) takes the normal path; nothing is consumed there.
      if (c.planner !== undefined) expect([d.kind, d.next], c.id).toEqual(['cancelled', 'ordinary']);
    }
    expect(boundIds).toContain('rt-s2r-487');
    // The multi-line replies are consumed and not re-planned (462 as built); the marked replies fail structurally.
    for (const id of ['rt-s2r-462', 'rt-s2r-463']) expect(await runSr1(SR1.find((c) => c.id === id)!, OFF), id).toEqual({ kind: 'cancelled', audit: ['classifier-off'], next: 'consumed' });
    for (const id of ['rt-s2r-483', 'rt-s2r-484', 'rt-s2r-485']) expect((await runSr1(SR1.find((c) => c.id === id)!, OFF)).audit, id).toEqual(['structural-fail']);
    // Every stale, consumed, superseded, voided or foreign step is not an answer.
    for (const c of SR1.filter((x) => x.pending!.state !== 'fresh')) expect((await runSr1(c, OFF)).kind, c.id).toBe('not-an-answer');
  });

  it('switch on: exactly the gold classifier targets reach the classifier, and each awaiting consentAnswer and rerun holds', async () => {
    const reached: string[] = [];
    for (const c of SR1) {
      const label = labelOf(c.awaiting?.expect.consentAnswer);
      const classify = vi.fn<ConsentAnswerClassifier>(async () => label ?? 'other');
      const d = await runSr1(c, { mode: 'on', classify });
      if (classify.mock.calls.length > 0) reached.push(c.id);
      const want = c.awaiting?.expect.consentAnswer;
      if (want === undefined) continue;
      expect(c.awaiting?.slices, c.id).toContain('A6-S1');
      expect([d.kind, d.audit[0]], c.id).toEqual(['bound', want]);
      if (d.kind !== 'bound') continue;
      expect(d.next, c.id).toBe(c.awaiting?.expect.rerun === 'new-turn' ? 'rerun' : 'consumed');
    }
    expect(reached).toEqual(SR1.filter((c) => labelOf(c.awaiting?.expect.consentAnswer) !== undefined).map((c) => c.id));
    expect(reached).toEqual(['rt-s2r-462', 'rt-s2r-463', 'rt-s2r-468', 'rt-s2r-469', 'rt-s2r-470', 'rt-s2r-472', 'rt-s2r-473', 'rt-s2r-488']);
    // r-02: 462 reruns only its second line; r-01: 472 and 473 rerun the whole message.
    const rerun = async (id: string): Promise<string | undefined> => {
      const d = await runSr1(SR1.find((c) => c.id === id)!, { mode: 'on', classify: async () => 'yes-and-more' });
      return d.kind === 'bound' ? d.rerunText : undefined;
    };
    expect(await rerun('rt-s2r-462')).toBe('드라이브도 같이');
    expect(await rerun('rt-s2r-472')).toBe('yes, and also summarize my drive files');
    expect(await rerun('rt-s2r-473')).toBe('응 근데 메일 10개 더 요약해줘');
  });
});

async function runA2(c: A2Case, classifier: ConsentClassifierSwitch): Promise<ConsentTurnDecision> {
  const p = c.fixture!.pendingConsent!;
  let store = new ConsentPendingStore();
  store.open(topicConsentPending({ scope: DM, language: 'ko', createdAtMs: NOW - p.ageSeconds * 1000, recipient: 'Claude', topic: p.topic }));
  if (c.fixture?.serviceRestarted) store = new ConsentPendingStore();
  for (const between of c.turnsBetween ?? []) {
    // The kill-switch command voids every pending consent; any other owner turn supersedes it by being the next turn.
    if (between.text === '에이전트 중지') store.voidAll();
    else await answer(store, { scope: DM, ownerDm: true, text: between.text, atMs: NOW - 1_000 }, OFF);
  }
  const scope = c.replyPlatform !== undefined ? { ...DM, conversationKey: `${c.replyPlatform}-dm` } : DM;
  return answer(store, { scope, ownerDm: c.conversation === undefined, text: c.ownerReply!, atMs: NOW }, classifier);
}

describe('A6-S1 over the A2 red-team corpus (the topic consent)', () => {
  // The consent replies the gold judges by `consentOutcome` (rt-s2a-162 and 163 judge the data use after a yes, not the answer).
  const single = A2.filter((c) => c.ownerReply !== undefined && c.fixture?.pendingConsent !== undefined && c.expected.consentOutcome !== undefined);

  it('switch off: the closed token set as built, except the A6-S1 target rt-s2a-136 (fullwidth yes) which binds', async () => {
    const outcomes = new Map<string, string>();
    for (const c of single) {
      const d = await runA2(c, OFF);
      const got = d.kind === 'bound' ? 'yes' : d.audit[0] === 'closed-no' ? 'no' : d.kind === 'cancelled' ? 'cancelled' : 'not-an-answer';
      outcomes.set(c.id, got);
      const built = c.expected.consentOutcome;
      if (c.awaiting?.expected.consentAnswer === 'closed-yes') expect([built, got], c.id).toEqual(['cancelled', 'yes']);
      else if (built === 'yes' || built === 'no' || built === 'cancelled') expect(got, c.id).toBe(built);
      else if (built === 'expired' || built === 'refused' || built === 'switch') expect(got, c.id).toBe('not-an-answer');
      // rt-s2a-152 (exactly 600 s) is `decision-needed` in the A2 gold; A6-S1 reads it as late, as SR-1 rt-s2r-450 (600 s, expired).
      else expect([c.id, built, got]).toEqual(['rt-s2a-152', 'decision-needed', 'not-an-answer']);
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(55);
    // The zero-width yes (rt-s2a-135) fails structurally; the empty reply (rt-s2a-142) too.
    for (const id of ['rt-s2a-135', 'rt-s2a-142']) expect((await runA2(single.find((c) => c.id === id)!, OFF)).audit, id).toEqual(['structural-fail']);
  });

  it('a second yes after a bound yes answers nothing (rt-s2a-154, single use)', async () => {
    const c = A2.find((x) => x.id === 'rt-s2a-154')!;
    const store = new ConsentPendingStore();
    store.open(topicConsentPending({ scope: DM, language: 'ko', createdAtMs: NOW - 10_000, recipient: 'Claude', topic: c.fixture!.pendingConsent!.topic }));
    const results: ConsentTurnDecision[] = [];
    for (const t of c.turns ?? []) results.push(await answer(store, { scope: DM, ownerDm: true, text: t.text, atMs: NOW }, OFF));
    expect(results.map((d) => d.kind)).toEqual(['bound', 'not-an-answer']);
  });

  it('switch on: the awaiting targets (owner verdicts) bind with their consentAnswer; only the classifier ones call it', async () => {
    const marked = single.filter((c) => c.awaiting !== undefined);
    expect(marked.map((c) => c.id)).toEqual(['rt-s2a-120', 'rt-s2a-123', 'rt-s2a-124', 'rt-s2a-125', 'rt-s2a-130', 'rt-s2a-136']);
    for (const c of marked) {
      const want = c.awaiting!.expected.consentAnswer!;
      const classify = vi.fn<ConsentAnswerClassifier>(async () => labelOf(want) ?? 'other');
      const d = await runA2(c, { mode: 'on', classify });
      expect(c.awaiting!.slices, c.id).toContain('A6-S1');
      expect([d.kind, d.audit[0]], c.id).toEqual(['bound', want]);
      expect(classify.mock.calls.length, c.id).toBe(want === 'closed-yes' ? 0 : 1);
      if (d.kind === 'bound') expect(d.next === 'rerun', c.id).toBe(c.awaiting!.expected.rerunAsNewTurn === true);
    }
  });
});
