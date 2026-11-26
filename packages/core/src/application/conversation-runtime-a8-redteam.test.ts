import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, InboundMessage } from '../domain';
import type { ConnectorItem } from '../ports';
import type { ConsentClassifierSwitch } from './consent-answer/consent-answer';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import { renderItemSummaryChangedLine } from './item-summary/item-summary-continuation';
import { renderItemSummaryNotSentLine } from './item-summary/summary-recipient-guard';
import { renderMailSummaryUnavailable } from './mail/mail-reply-renderer';
import { SURFACE_GRANT_PENDING_METADATA_KEY } from './surface-grants/surface-grant-service';
import { ASK, UNAVAILABLE, harness as d8Harness, item as d8Item, listingOf } from './d8-lookup-consent.test-support';
import { ATTRIBUTED, CANARY, CHANNEL, CLAIM, DM, LINE, OWNER, SUMMARY, harness as itemHarness } from './item-summary-consent.test-support';

/**
 * ADR-0121 amendment A8, slice OQ1-5: the deterministic, offline red-team lot for `QUOKY_ITEM_SUMMARY_CONSENT` (flag on) through the
 * REAL ConversationRuntime, the real mail / Drive / work-chat handlers and the real consent gate. No model, no prompt change. The
 * fakes are the ones the OQ1-2..OQ1-4 suites use (shared through the two `*.test-support.ts` files). P3 and P5 are driven through a
 * deterministic ACTIVE fake NL selector (`nlSelection.decide`), the real `handleNlSelection` dispatch and the real handlers.
 *
 * What a "REMOTE execute" is here: a provider call whose prompt carries the item (a bare chat reply after a stale yes carries none).
 */

const QUESTION_MARK = '보낼까요';
const OTHER_DM: ConversationContext = { ...DM, channelId: 'dm-2' };
const OTHER_ACTOR: Actor = { id: 'other-actor', displayName: 'Other', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const NL_TEXT = { mail: '아까 그 메일 내용 좀 정리해줘', drive: '아까 그 문서 내용 좀 정리해줘' } as const;
/** The deterministic fake selector: its one request text selects `item.summarize` over one item; every other text is `none`. */
const nlSelect = (source: 'mail' | 'drive') => (text: string) =>
  text === NL_TEXT[source]
    ? { kind: 'execute', command: { entryId: 'item.summarize', args: {}, language: 'ko', target: { source, id: source === 'mail' ? 'msg-1' : 'file-1' } } }
    : { kind: 'none' };

/** What the matrix needs from either harness. */
interface Common {
  send(text: string, context?: ConversationContext, marks?: Pick<InboundMessage, 'quotedRanges' | 'formatting'>): Promise<{ status: string; reply: { text: string }; rerun?: { text: string } }>;
  state: {
    selected: 'remote' | 'other' | 'local' | 'anon';
    expectedKey: string | undefined;
    selectGate: Promise<void> | undefined;
    selectEntered: (() => void) | undefined;
    assistantGate: Promise<void> | undefined;
    assistantEntered: (() => void) | undefined;
    actorFor: ((context: ConversationContext) => Actor) | undefined;
  };
  hooks: { afterSelect?: (n: number) => void; onExecute?: (n: number) => void };
  executed: { provider: string; request: { prompt: string } }[];
  logs: unknown[];
  clock: { now: number };
  sessions: Map<string, { id: string; metadata?: Record<string, unknown> }>;
  store: { stateOf(scope: { actorId: string; conversationKey: string }): string | undefined };
}

interface Sub {
  readonly h: Common;
  ask(): Promise<{ reply: { text: string } }>;
  /** Makes the confirmed item differ on the re-read (undefined: the path has no item identity beyond its id). */
  change?: () => void;
  /** The "changed" or "unavailable" fixed line this path answers a changed item with. */
  readonly changedLine: string;
}
interface MakeOptions {
  readonly expectedKey?: string | undefined;
  readonly stop?: boolean;
  readonly summaries?: readonly string[];
  readonly classifier?: ConsentClassifierSwitch;
}
interface Subject {
  readonly name: string;
  /** Selections on the ask turn that did not come from the item pre-resolve (the NL selector resolves the chat provider first). */
  readonly selectsOnAsk: number;
  readonly hasRegeneration: boolean;
  make(options?: MakeOptions): Sub;
}

const itemSubject = (name: string, texts: { list?: string; ask: string }, extra: { nl?: 'mail' | 'drive'; r2?: boolean; change?: (h: ReturnType<typeof itemHarness>) => void; selectsOnAsk?: number } = {}): Subject => ({
  name,
  selectsOnAsk: extra.selectsOnAsk ?? 1,
  hasRegeneration: true,
  make: (o = {}) => {
    const h = itemHarness({
      ...('expectedKey' in o ? { expectedKey: o.expectedKey } : { expectedKey: 'fake-other' }),
      ...(o.stop === true ? { stopPath: 'agent' as const } : {}),
      ...(o.summaries !== undefined ? { summaries: o.summaries } : {}),
      ...(o.classifier !== undefined ? { classifier: o.classifier } : {}),
      ...(extra.nl !== undefined ? { nlDecide: nlSelect(extra.nl) } : {}),
      ...(extra.r2 === true ? { nl: { level: 'local' as const, itemR2: 'all' as const, acting: true } } : {}),
    });
    return {
      h: h as unknown as Common,
      ask: async () => {
        if (texts.list !== undefined) await h.send(texts.list);
        return h.send(texts.ask);
      },
      ...(extra.change !== undefined ? { change: () => extra.change!(h) } : {}),
      changedLine: '',
    };
  },
});

const SUBJECTS: readonly Subject[] = [
  itemSubject('P1 mail item', { list: '안 읽은 메일', ask: '1번 메일 요약해줘' }),
  itemSubject('P2 mail thread', { list: '안 읽은 메일', ask: '1번 메일 스레드 요약해줘' }, { change: (h) => (h.state.threadTotal = 3) }),
  itemSubject('P3 mail NL', { ask: NL_TEXT.mail }, { nl: 'mail', selectsOnAsk: 2 }),
  itemSubject('P4 Drive file', { list: '최근 문서', ask: '1번 문서 요약해줘' }),
  itemSubject('P5 Drive NL', { ask: NL_TEXT.drive }, { nl: 'drive', selectsOnAsk: 2 }),
  itemSubject('P6 Jira item', { ask: '지라 이슈 요약' }, { r2: true, change: (h) => (h.state.jiraItem = 'A-2') }),
  {
    name: 'P7 D8 lookup',
    selectsOnAsk: 1,
    hasRegeneration: false,
    make: (o = {}) => {
      const h = d8Harness({
        ...('expectedKey' in o ? { expectedKey: o.expectedKey } : { expectedKey: 'fake-other' }),
        ...(o.stop === true ? { stop: true } : {}),
        ...(o.classifier !== undefined ? { classifier: o.classifier } : {}),
      });
      return { h: h as unknown as Common, ask: () => h.send(ASK), change: () => (h.state.items = [d8Item('A-1'), d8Item('A-3')]), changedLine: renderItemSummaryChangedLine('ko') };
    },
  },
];

/** Provider calls that carried the item. */
const remote = (h: Common) => h.executed.filter((entry) => entry.request.prompt.includes(CANARY));
const noContentInLogs = (h: Common, ...ownerTexts: string[]) => {
  const text = JSON.stringify(h.logs);
  for (const forbidden of [CANARY, SUMMARY, CLAIM, ATTRIBUTED, ...ownerTexts]) expect(text).not.toContain(forbidden);
};
const SCOPE = { actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(DM) };

/** Asks (unexpected recipient, DM) and checks that the question is the whole reply and nothing was sent. */
async function asked(subject: Subject, options?: MakeOptions): Promise<Sub> {
  const sub = subject.make(options);
  const question = await sub.ask();
  expect(question.reply.text).toContain(QUESTION_MARK);
  expect(question.reply.text).toContain('Remote');
  expect(remote(sub.h)).toEqual([]);
  expect(sub.h.store.stateOf(SCOPE)).toBe('open');
  return sub;
}

describe('OQ1-5 blocker (b): P3 and P5 through the real NL selection path (flag on)', () => {
  const NL = [
    ['P3 mail', 'mail'],
    ['P5 Drive', 'drive'],
  ] as const;

  it.each(NL)('%s: LOCAL: the summary as built, no recipient line, one call, the selector ran once', async (_name, source) => {
    const h = itemHarness({ selected: 'local', nlDecide: nlSelect(source) });
    const result = await h.send(NL_TEXT[source]);
    expect(result.reply.text).toContain(SUMMARY);
    expect(result.reply.text).not.toContain(LINE);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
    expect(h.nlCalls.decide).toBe(1);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
  });

  it.each(NL)('%s: expected REMOTE: exactly one call and the reply ends with the recipient line', async (_name, source) => {
    const h = itemHarness({ nlDecide: nlSelect(source) });
    const result = await h.send(NL_TEXT[source]);
    expect(result.reply.text.startsWith(SUMMARY)).toBe(true);
    expect(result.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(h.nlCalls.decide).toBe(1);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
  });

  it.each(NL)('%s: unexpected REMOTE in the DM: the question is the whole reply, zero calls, the history keeps the question', async (_name, source) => {
    const h = itemHarness({ expectedKey: 'fake-other', nlDecide: nlSelect(source) });
    const before = h.recordAssistant.length;
    const result = await h.send(NL_TEXT[source]);
    expect(result.reply.text).toMatch(/Remote에 보내 요약할게요\. 보낼까요\? \(응\/아니\)$/u);
    expect(result.reply.text).not.toContain(SUMMARY);
    expect(h.executed).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.recordAssistant.slice(before)).toEqual([result.reply.text]);
    expect(h.nlCalls.decide).toBe(1);
    noContentInLogs(h, NL_TEXT[source]);
  });

  it.each(NL)('%s: the yes: exactly one call, to exactly the consented recipient, the selector is not reached again', async (_name, source) => {
    const h = itemHarness({ expectedKey: 'fake-other', nlDecide: nlSelect(source) });
    await h.send(NL_TEXT[source]);
    const yes = await h.send('응');
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    // The continuation re-reads through the handler directly: no second selection, no receipt, no extra chat-provider resolve for it.
    expect(h.nlCalls.decide).toBe(1);
    expect(h.nlCalls.receipts).toBe(0);
    const again = await h.send('응');
    expect(h.executed).toHaveLength(1);
    expect(again.reply.text).not.toContain(SUMMARY);
    noContentInLogs(h, NL_TEXT[source]);
  });

  it.each(NL)('%s: the yes goes to the recipient the owner was asked about even when another becomes the expected one', async (_name, source) => {
    const h = itemHarness({ expectedKey: 'fake-other', nlDecide: nlSelect(source) });
    await h.send(NL_TEXT[source]);
    h.state.selected = 'other';
    h.state.expectedKey = 'fake-other';
    await h.send('응');
    expect(h.executed).toEqual([]);
  });

  it.each(NL)('%s: flag off is byte-identical to today (no gate vs QUOKY_SUMMARY_CONSENT=on alone): same reply, prompts, history, runs; no A8 hook, whatever the expected key', async (_name, source) => {
    const results = [];
    for (const consent of ['absent', 'gate'] as const) {
      for (const expectedKey of ['fake-remote', 'fake-other']) {
        const h = itemHarness({ consent, expectedKey, nlDecide: nlSelect(source) });
        const result = await h.send(NL_TEXT[source]);
        expect(result.reply.text).toContain(SUMMARY);
        expect(result.reply.text).not.toContain(LINE);
        expect(result.reply.text).not.toContain(QUESTION_MARK);
        expect(h.counts.expected).toBe(0);
        expect(h.counts.eligible).toBe(0);
        results.push({ reply: result.reply, prompts: h.executed.map((entry) => entry.request.prompt), history: h.recordAssistant, runs: h.runs, select: h.counts.select });
      }
    }
    for (const entry of results.slice(1)) expect(entry).toEqual(results[0]);
    expect(results[0]?.prompts).toHaveLength(1);
  });
});

describe('OQ1-5 blocker (c): another owner step genuinely pending (W2, fail closed)', () => {
  it('an open selection question (takePending) and an unexpected recipient: the fallback plus the fixed line, no question, zero calls; the selector state is untouched', async () => {
    const h = itemHarness({ expectedKey: 'fake-other', nlPending: true, nlDecide: () => ({ kind: 'skip', reason: 'disabled' }) });
    const result = await h.send('지라 이슈 요약');
    expect(result.reply.text).toBe(`JIRA FALLBACK\n${renderItemSummaryNotSentLine('ko')}`);
    expect(result.reply.text).not.toContain(QUESTION_MARK);
    expect(h.executed).toEqual([]);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    // The selection service was asked for its pending question once (the turn ends it, ADR-0120 D7) and nothing else was written.
    expect(h.nlCalls.takePending).toBe(1);
    // A later yes is not an answer to anything: no item ever reaches a provider.
    const yes = await h.send('응');
    expect(yes.reply.text).not.toContain(LINE);
    expect(h.executed.filter((entry) => entry.request.prompt.includes(CANARY))).toEqual([]);
    noContentInLogs(h, '지라 이슈 요약');
  });

  it('an open selection question and a mail item request: the mail fallback plus the fixed line, no question, zero calls', async () => {
    const h = itemHarness({ expectedKey: 'fake-other', nlPending: true, nlDecide: () => ({ kind: 'skip', reason: 'disabled' }) });
    await h.send('안 읽은 메일');
    const result = await h.send('1번 메일 요약해줘');
    expect(result.reply.text).toBe(`${renderMailSummaryUnavailable('ko')}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.executed).toEqual([]);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
  });

  it('an expected REMOTE recipient is not an ask, so a pending step does not change it: one call and the line', async () => {
    const h = itemHarness({ nlPending: true, nlDecide: () => ({ kind: 'skip', reason: 'disabled' }) });
    const result = await h.send('지라 이슈 요약');
    expect(result.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed).toHaveLength(1);
  });

  it('a pending channel grant (session state): the fallback plus the fixed line; the pending record is not changed or cleared', async () => {
    const h = itemHarness({ expectedKey: 'fake-other' });
    await h.send('안녕');
    const seeded = [...h.sessions.values()][0]!;
    const pending = { seeded: true };
    h.sessions.set(seeded.id, { ...seeded, metadata: { ...(seeded.metadata ?? {}), [SURFACE_GRANT_PENDING_METADATA_KEY]: pending } } as typeof seeded);
    const result = await h.send('지라 이슈 요약');
    expect(result.reply.text).toBe(`JIRA FALLBACK\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.executed.filter((entry) => entry.request.prompt.includes(CANARY))).toEqual([]);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect([...h.sessions.values()][0]?.metadata?.[SURFACE_GRANT_PENDING_METADATA_KEY]).toEqual(pending);
  });

  it('D8 with a pending channel grant: the listing plus the fixed line, no question, zero calls; the pending record is untouched', async () => {
    const h = d8Harness({ expectedKey: 'fake-other' });
    await h.send('안녕');
    const seeded = [...h.sessions.values()][0]!;
    const pending = { seeded: true };
    h.sessions.set(seeded.id, { ...seeded, metadata: { ...(seeded.metadata ?? {}), [SURFACE_GRANT_PENDING_METADATA_KEY]: pending } } as typeof seeded);
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${await listingOf(h.state.items)}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.executed.filter((entry) => entry.request.prompt.includes(CANARY))).toEqual([]);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect([...h.sessions.values()][0]?.metadata?.[SURFACE_GRANT_PENDING_METADATA_KEY]).toEqual(pending);
  });
});

describe.each(SUBJECTS)('OQ1-5 red-team matrix: $name (flag on)', (base) => {
  const ownerTexts = ['응', '좋아 그리고', '에이전트 중지', '안녕하세요'];
  // Every harness a case builds is checked for content-free logs after the case, so no branch can skip it.
  const built: Common[] = [];
  const subject: Subject = { ...base, make: (options) => { const sub = base.make(options); built.push(sub.h); return sub; } };
  afterEach(() => {
    const harnesses = built.splice(0);
    expect(harnesses.length).toBeGreaterThan(0);
    for (const h of harnesses) noContentInLogs(h, ...ownerTexts);
  });

  it('baseline: the question, then one yes sends exactly one call to the consented recipient', async () => {
    const sub = await asked(subject);
    await sub.h.send('응');
    expect(remote(sub.h).map((entry) => entry.provider)).toEqual(['fake-remote']);
    noContentInLogs(sub.h, ...ownerTexts);
  });

  it.each([
    ['another REMOTE, not expected', { selected: 'other', expectedKey: undefined }],
    ['another REMOTE, expected', { selected: 'other', expectedKey: 'fake-other' }],
    ['an unnamed REMOTE', { selected: 'anon', expectedKey: 'fake-anon' }],
  ] as const)('recipient flips between the ask and the yes (%s): zero calls', async (_name, flip) => {
    const sub = await asked(subject);
    sub.h.state.selected = flip.selected;
    sub.h.state.expectedKey = flip.expectedKey;
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
    noContentInLogs(sub.h, ...ownerTexts);
  });

  it('recipient flips between the continuation pre-resolve and hook 1: hook 1 refuses, zero calls', async () => {
    const sub = await asked(subject);
    sub.h.hooks.afterSelect = (n) => {
      if (n === subject.selectsOnAsk + 1) sub.h.state.selected = 'other';
    };
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  it('recipient flips before the ask resolves (between the ask pre-resolve and the question): the question still names what the owner sees and sends nothing', async () => {
    const sub = subject.make();
    sub.h.hooks.afterSelect = (n) => {
      if (n === subject.selectsOnAsk) sub.h.state.selected = 'other';
    };
    const question = await sub.ask();
    expect(remote(sub.h)).toEqual([]);
    expect(question.reply.text).not.toContain(SUMMARY);
    // The pre-resolve saw the first recipient; the yes then meets another one and sends nothing.
    sub.h.hooks.afterSelect = undefined;
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  if (subject.hasRegeneration) {
    it('recipient flips between hook 1 and hook 2 (during the first call): exactly one call, the regeneration is refused', async () => {
      const sub = await asked(subject, { summaries: [CLAIM, ATTRIBUTED] });
      sub.h.hooks.onExecute = (n) => {
        if (n === 1) sub.h.state.selected = 'other';
      };
      const yes = await sub.h.send('응');
      expect(remote(sub.h)).toHaveLength(1);
      expect(yes.reply.text).not.toContain(ATTRIBUTED);
      expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
      noContentInLogs(sub.h, ...ownerTexts);
    });

    it('the consented recipient is allowed the call and its one regeneration, no more: exactly two calls, the regenerated output is the reply', async () => {
      const sub = await asked(subject, { summaries: [CLAIM, ATTRIBUTED] });
      const yes = await sub.h.send('응');
      expect(remote(sub.h).map((entry) => entry.provider)).toEqual(['fake-remote', 'fake-remote']);
      expect(yes.reply.text).toContain(ATTRIBUTED);
      expect(yes.reply.text).not.toContain(CLAIM);
    });
  }

  it('a stop while the ask turn is in its pre-resolve: no question, no step, zero calls; a later yes sends nothing', async () => {
    const sub = subject.make({ stop: true });
    let release!: () => void;
    sub.h.state.selectGate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (sub.h.state.selectEntered = resolve));
    const request = sub.ask();
    await entered;
    expect((await sub.h.send('에이전트 중지')).reply.text).toContain('멈춤');
    release();
    const reply = await request;
    expect(reply.reply.text).not.toContain(QUESTION_MARK);
    expect(sub.h.store.stateOf(SCOPE)).toBeUndefined();
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  it('a stop between the question and the yes: the yes sends nothing', async () => {
    const sub = await asked(subject, { stop: true });
    await sub.h.send('에이전트 중지');
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  it('a stop while the continuation is in its pre-resolve: zero calls', async () => {
    const sub = await asked(subject, { stop: true });
    let release!: () => void;
    sub.h.state.selectGate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (sub.h.state.selectEntered = resolve));
    const yes = sub.h.send('응');
    await entered;
    await sub.h.send('에이전트 중지');
    release();
    const answered = await yes;
    expect(remote(sub.h)).toEqual([]);
    expect(answered.reply.text).not.toContain(LINE);
  });

  it('a second request before the yes: the first question is closed; only the second can be answered, once', async () => {
    const sub = await asked(subject);
    const second = await sub.ask();
    expect(second.reply.text).toContain(QUESTION_MARK);
    expect(remote(sub.h)).toEqual([]);
    await sub.h.send('응');
    expect(remote(sub.h)).toHaveLength(1);
    await sub.h.send('응');
    expect(remote(sub.h)).toHaveLength(1);
  });

  it('another turn instead of the yes ends the question: a later yes sends nothing', async () => {
    const sub = await asked(subject);
    await sub.h.send('안녕하세요');
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  it('a yes from another channel or another DM conversation is not an answer; the real yes still works once', async () => {
    const sub = await asked(subject);
    await sub.h.send('응', CHANNEL);
    await sub.h.send('응', OTHER_DM);
    expect(remote(sub.h)).toEqual([]);
    await sub.h.send('응');
    expect(remote(sub.h)).toHaveLength(1);
  });

  it('a yes from another actor is not an answer; the owner\'s yes still works once', async () => {
    const sub = await asked(subject);
    sub.h.state.actorFor = () => OTHER_ACTOR;
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
    sub.h.state.actorFor = undefined;
    await sub.h.send('응');
    expect(remote(sub.h)).toHaveLength(1);
  });

  it('a yes after 600 s is the expired line: zero calls, and a second yes is no second chance', async () => {
    const sub = await asked(subject);
    sub.h.clock.now += 601_000;
    const yes = await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
    expect(yes.reply.text).not.toContain(SUMMARY);
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  it('a yes twice: exactly one call', async () => {
    const sub = await asked(subject);
    await sub.h.send('응');
    await sub.h.send('응');
    expect(remote(sub.h)).toHaveLength(1);
  });

  it('yes-and-more: exactly one call; the rest rides on the result as a new ordinary turn and never reaches a provider here', async () => {
    const classifier = { mode: 'on', classify: async () => 'yes-and-more' } as unknown as ConsentClassifierSwitch;
    const sub = await asked(subject, { classifier });
    const yes = await sub.h.send('좋아 그리고 드라이브도');
    expect(remote(sub.h)).toHaveLength(1);
    expect(yes.rerun?.text).toBe('좋아 그리고 드라이브도');
    noContentInLogs(sub.h, '좋아 그리고 드라이브도');
  });

  it('pasted text that looks like a yes inside quotes is not an answer: zero calls; the question is ended by it, so a later yes sends nothing', async () => {
    const sub = await asked(subject);
    const quoted = await sub.h.send('응', DM, { quotedRanges: [{ start: 0, end: 1 }] });
    expect(remote(sub.h)).toEqual([]);
    expect(quoted.reply.text).not.toContain(LINE);
    // The quoted turn is another turn: it ends the question, so the later plain yes sends nothing either (observed on all seven paths).
    await sub.h.send('응');
    expect(remote(sub.h)).toEqual([]);
  });

  if (base.make().change !== undefined) {
    it('the item changed (thread grew / another item / lookup set changed) after the question: the fixed changed line, zero calls', async () => {
      const sub = await asked(subject);
      sub.change?.();
      const yes = await sub.h.send('응');
      expect(remote(sub.h)).toEqual([]);
      expect(yes.reply.text).toContain(renderItemSummaryChangedLine('ko'));
      noContentInLogs(sub.h, ...ownerTexts);
    });
  }
});

describe('OQ1-5 recorded residuals, pinned (any change must be visible)', () => {
  describe.each(SUBJECTS)('OQ1-3 R3 display-only question after a stop during its history write: $name', (subject) => {
    it('the owner sees one question, the yes is refused (nothing open), zero calls', async () => {
      const sub = subject.make({ stop: true });
      let release!: () => void;
      sub.h.state.assistantGate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (sub.h.state.assistantEntered = resolve));
      const request = sub.ask();
      await entered;
      expect((await sub.h.send('에이전트 중지')).reply.text).toContain('멈춤');
      release();
      const reply = await request;
      // The residual: the question text is still displayed (display-only) although the stop voided its record.
      expect(reply.reply.text).toContain(QUESTION_MARK);
      expect(sub.h.store.stateOf(SCOPE)).not.toBe('open');
      const yes = await sub.h.send('응');
      expect(remote(sub.h)).toEqual([]);
      expect(yes.reply.text).not.toContain(LINE);
      noContentInLogs(sub.h, '에이전트 중지');
    });
  });

  it('OQ1-4 long D8 listing (rows clipped by the renderer): the listing plus the not-sent line, no question, zero calls', async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ id: `A-${index + 1}`, title: 'tttttttttt', summary: 's'.repeat(200), url: `https://example.test/${'a'.repeat(50)}`, status: 'To Do' }) satisfies ConnectorItem);
    const h = d8Harness({ expectedKey: 'fake-other', numbered: true });
    h.state.items = items;
    const result = await h.send(ASK);
    expect(result.reply.text).not.toContain(QUESTION_MARK);
    expect(result.reply.text.endsWith(renderItemSummaryNotSentLine('ko'))).toBe(true);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    // The unavailable line is reserved for a refused yes: this turn never had a question.
    expect(result.reply.text).not.toContain(UNAVAILABLE);
    noContentInLogs(h as unknown as Common, ASK);
  });
});
