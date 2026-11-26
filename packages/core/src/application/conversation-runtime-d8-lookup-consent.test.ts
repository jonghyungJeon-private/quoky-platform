import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun } from '../domain';
import type { AiProvider, AiRequest, ConnectorItem, ConnectorProvider, ConversationTurnHandler, LogFields, Logger, StorageProvider } from '../ports';
import { ConsentPendingStore } from './consent-answer/consent-pending';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import { ItemSummaryConsent, type ItemSummaryConsentToken } from './consent-answer/item-summary-consent';
import { ContextBuilder } from './context-builder';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import { workLookupRefsKey } from './item-summary-consent-descriptor';
import { renderItemSummaryChangedLine } from './item-summary/item-summary-continuation';
import { renderItemSummaryNotSentLine } from './item-summary/summary-recipient-guard';
import type { MemoryManager } from './memory-manager';
import type { MemoryRetriever } from './memory-retriever';
import type { MemoryWriter } from './memory-writer';
import type { NlSelectedCommand } from './nl-routing/catalog';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { WorkChatService, type WorkChatServiceDeps } from './work-chat/work-chat-service';
import { WORK_CHAT_LOOKUP_TURN_HANDLER_ID, createWorkChatTurnHandlers } from './work-chat/work-chat-turn-handler';
import { ASK, CANARY, CHANNEL, DM, LINE, OWNER, QUESTION, SCOPE, SUMMARY, T0, UNAVAILABLE, harness, item, listingOf, noContentInLogs, view, type Harness } from './d8-lookup-consent.test-support';

describe('OQ1-4 dormancy: flag off is byte-identical for the D8 lookup summary', () => {
  it('no gate vs QUOKY_SUMMARY_CONSENT=on alone: same reply, prompt, history and runs; no pre-resolve, no question', async () => {
    const results = [];
    for (const consent of ['absent', 'gate'] as const) {
      const h = harness({ consent });
      const result = await h.send(ASK);
      results.push({ reply: view(result), requests: h.executed.map((entry) => entry.request), history: h.recordAssistant, runs: h.runs, select: h.counts.select });
      expect(h.counts.expected).toBe(0);
      expect(h.events.filter((event) => event === 'guard')).toEqual([]);
      expect(result.reply.text).toContain(SUMMARY);
      expect(result.reply.text).not.toContain(LINE);
      expect(result.reply.text).not.toContain('보낼까요');
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.requests).toHaveLength(1);
  });
});

describe('OQ1-4 flag on: the D8 lookup asks before a REMOTE summary (A8.6)', () => {
  it('LOCAL: summarised as built, held to LOCAL by the guard, no question and no line', async () => {
    const h = harness({ selected: 'local' });
    const result = await h.send(ASK);
    expect(result.reply.text).toContain(SUMMARY);
    expect(result.reply.text).not.toContain(LINE);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
  });

  it.each([
    ['unexpected', 'fake-other'],
    ['expected (A8.6: D8 asks even for the expected recipient)', 'fake-remote'],
  ] as const)('REMOTE %s in the DM: the listing, then ONE fixed question naming the recipient and the count; zero execute calls', async (_name, expectedKey) => {
    const h = harness({ expectedKey });
    const before = h.recordAssistant.length;
    const result = await h.send(ASK);
    const listing = await listingOf(h.state.items);
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(`${listing}\n${QUESTION}`);
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.runs).toEqual([]);
    // The step holds the asked refs as its item ids (ids only), the history keeps the listing and the question.
    expect(h.store.stateOf(SCOPE)).toBe('open');
    expect(h.recordAssistant.slice(before)).toEqual([`${listing}\n${QUESTION}`]);
    noContentInLogs(h);
  });

  it('a channel never asks: the listing only, no step, zero execute calls (W2)', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    const result = await h.send(ASK, CHANNEL);
    expect(result.reply.text).toBe(await listingOf(h.state.items));
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(CHANNEL) })).toBeUndefined();
    expect(h.executed).toEqual([]);
  });

  it('an unnamed REMOTE recipient: the listing plus the fixed not-sent line, no question, nothing sent', async () => {
    const h = harness({ selected: 'anon', expectedKey: 'fake-other' });
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${await listingOf(h.state.items)}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
  });

  it('another turn instead of a yes ends the question (A8.5 "the NEXT DM turn"): a new lookup asks anew, one yes is one call', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    await h.send(ASK);
    h.state.items = [item('A-1')];
    const second = await h.send(ASK);
    expect(second.reply.text.endsWith('지라 이슈 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)')).toBe(true);
    expect(h.executed).toEqual([]);
    await h.send('응');
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]?.request.prompt).not.toContain('jira:A-2');
  });

  it('a stop while the lookup is in its pre-resolve: no question, no step, zero calls; a later yes sends nothing', async () => {
    const h = harness({ expectedKey: 'fake-other', stop: true });
    let release!: () => void;
    h.state.selectGate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (h.state.selectEntered = resolve));
    const request = h.send(ASK);
    await entered;
    const stop = await h.send('에이전트 중지');
    expect(stop.reply.text).toContain('멈춤');
    release();
    const reply = await request;
    expect(reply.reply.text).toBe(await listingOf(h.state.items));
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    // No step is open, so the yes is ordinary chat: no item ever reaches a provider and no recipient line appears.
    const yes = await h.send('응');
    expect(yes.reply.text).not.toContain(LINE);
    expect(h.executed.filter((entry) => entry.request.prompt.includes(CANARY))).toEqual([]);
  });
});

describe('OQ1-4 continuation: the owner says yes to the D8 question (A8.6)', () => {
  async function asked(opts: HarnessOptions = {}, text = ASK) {
    const h = harness({ expectedKey: 'fake-other', ...opts });
    const question = await h.send(text);
    expect(question.reply.text.endsWith(QUESTION)).toBe(true);
    expect(h.executed).toEqual([]);
    return h;
  }

  it('a yes: the lookup re-runs, exactly one REMOTE call over exactly the asked refs, the reply ends with the recipient line', async () => {
    const h = await asked();
    const yes = await h.send('응');
    expect(yes.status).toBe('RESPONDED');
    expect(yes.reply.text).toContain(SUMMARY);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
    expect(h.counts.queries).toBe(2);
    const prompt = h.executed[0]?.request.prompt ?? '';
    expect(prompt).toContain('[jira:A-1]');
    expect(prompt).toContain('[jira:A-2]');
    noContentInLogs(h);
  });

  it('the summarization request is byte-identical to the one the D8 path sends without a question', async () => {
    const consented = await asked();
    await consented.send('응');
    const direct = harness({ consent: 'absent' });
    await direct.send(ASK);
    expect(consented.executed).toHaveLength(1);
    expect(direct.executed).toHaveLength(1);
    expect(consented.executed[0]?.request).toEqual(direct.executed[0]?.request);
  });

  it('W3: an item the owner was not asked about is dropped; the call carries only the asked refs', async () => {
    const h = await asked();
    h.state.items = [item('A-0'), ...h.state.items];
    const yes = await h.send('응');
    expect(h.executed).toHaveLength(1);
    const prompt = h.executed[0]?.request.prompt ?? '';
    expect(prompt).not.toContain('jira:A-0');
    expect(prompt).toContain('[jira:A-1]');
    expect(prompt).toContain('[jira:A-2]');
    expect(yes.reply.text).toContain('외부 항목 2건을 요약에 사용했어요.');
    expect(yes.reply.text).not.toContain('browse/A-0');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
  });

  it('a changed set (an asked ref missing on the re-run): the fixed "changed" line, nothing sent', async () => {
    const h = await asked();
    h.state.items = [item('A-1'), item('A-3')];
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(renderItemSummaryChangedLine('ko'));
    expect(h.executed).toEqual([]);
  });

  it('a recipient flip after the yes (another REMOTE, expected or not): refused, the listing plus the not-sent line, nothing sent', async () => {
    for (const expectedKey of [undefined, 'fake-other']) {
      const h = await asked();
      h.state.selected = 'other';
      h.state.expectedKey = expectedKey;
      const yes = await h.send('응');
      expect(yes.reply.text).toBe(`${await listingOf(h.state.items)}\n${renderItemSummaryNotSentLine('ko')}`);
      expect(h.executed).toEqual([]);
    }
  });

  it('a flip between the continuation pre-resolve and hook 1: hook 1 refuses, zero calls, the listing without a line', async () => {
    const h = await asked();
    h.hooks.afterSelect = (n) => {
      if (n === 2) h.state.selected = 'other';
    };
    const yes = await h.send('응');
    expect(h.executed).toEqual([]);
    expect(yes.reply.text).toBe(await listingOf(h.state.items));
  });

  it('LOCAL after the yes: proceeds without the token, no line', async () => {
    const h = await asked();
    h.state.selected = 'local';
    const yes = await h.send('응');
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
    expect(yes.reply.text).not.toContain(LINE);
  });

  it('single use: the token is retired after the call and a second yes is no second summary', async () => {
    const h = await asked();
    const spent: ItemSummaryConsentToken[] = [];
    const spend = h.items!.spend.bind(h.items);
    h.items!.spend = (token) => {
      spent.push(token);
      spend(token);
    };
    await h.send('응');
    expect(spent).toHaveLength(1);
    const use = { phase: 'call' as const, actorId: OWNER.id, conversationKey: SCOPE.conversationKey, source: 'jira' as const, itemId: workLookupRefsKey(['jira:A-1', 'jira:A-2']), kind: 'work-lookup' as const };
    expect(h.items!.allowsContinuation(spent[0], { kind: 'unexpected', key: 'fake-remote', label: 'Remote' }, use)).toBe(false);
    const again = await h.send('응');
    expect(again.reply.text).not.toContain(LINE);
    expect(h.executed).toHaveLength(1);
  });

  it('expiry: a yes more than 600 s after the question is the expired line, nothing sent', async () => {
    const h = await asked();
    h.clock.now += 601_000;
    const yes = await h.send('응');
    expect(yes.reply.text).toBe('요약 확인 시간이 지났어요. 다시 요청해 주세요.');
    expect(h.executed).toEqual([]);
  });

  it('expiry during the re-run (more than 600 s from the mint): hook 1 refuses, nothing sent', async () => {
    const h = await asked();
    h.hooks.onQuery = (n) => {
      if (n === 2) h.clock.now += 601_000;
    };
    await h.send('응');
    expect(h.executed).toEqual([]);
  });

  it('a stop (voidAll) before the yes: the yes summarises nothing', async () => {
    const h = await asked();
    h.gate?.voidAll();
    const yes = await h.send('응');
    expect(yes.reply.text).not.toContain(SUMMARY);
    expect(h.executed).toEqual([]);
  });

  it('a no sends nothing', async () => {
    const h = await asked();
    await h.send('아니');
    expect(h.executed).toEqual([]);
    expect(h.counts.queries).toBe(1);
  });

  it('a refused re-run (the connector fails): the unavailable line, nothing sent', async () => {
    const h = await asked();
    h.hooks.onQuery = (n) => {
      if (n === 2) throw new Error('connector down');
    };
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(UNAVAILABLE);
    expect(h.executed).toEqual([]);
  });

  it('a lookup that came through selection re-runs through handleSelected with the same selection, never the selector', async () => {
    const h = await asked({ selectionProbe: true }, '선택한 지라 조회');
    expect(h.counts.handleSelected).toBe(1);
    const yes = await h.send('응');
    expect(h.counts.handleSelected).toBe(2);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.lookupHandler.id).toBe(WORK_CHAT_LOOKUP_TURN_HANDLER_ID);
  });
});

describe('OQ1-4 review round 1', () => {
  async function asked(opts: HarnessOptions = {}, text = ASK, marks: Pick<InboundMessage, 'quotedRanges' | 'formatting'> = {}) {
    const h = harness({ expectedKey: 'fake-other', ...opts });
    const question = await h.send(text, DM, marks);
    expect(question.reply.text.endsWith(QUESTION)).toBe(true);
    expect(h.executed).toEqual([]);
    return h;
  }

  it('item 2: every asked item gone on the re-run (a successful empty lookup): the fixed "changed" line, nothing sent', async () => {
    const h = await asked();
    h.state.items = [];
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(renderItemSummaryChangedLine('ko'));
    expect(yes.reply.text).not.toBe(UNAVAILABLE);
    expect(h.counts.queries).toBe(2);
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('item 3: items overflowing the prompt budget: the listing shows more rows than the prompt carries, so no question; the listing plus the fixed not-sent line, nothing sent', async () => {
    const long = (id: string): ConnectorItem => ({ ...item(id), title: `${'긴 제목 '.repeat(30)}${id}`, summary: `${'본문 내용 '.repeat(70)}${id}` });
    const h = harness({ expectedKey: 'fake-other' });
    h.state.items = Array.from({ length: 10 }, (_, index) => long(`A-${index + 1}`));
    const listing = await listingOf(h.state.items);
    // The listing names all ten rows; the prompt budget fits fewer (the precondition of the finding).
    expect(listing).toContain('browse/A-10');
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${listing}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    noContentInLogs(h);
  });

  it('item 4: the re-run keeps the ASKING message\'s quoted ranges and formatting (offsets and flags only), stored with the request text', async () => {
    const marks = { quotedRanges: [{ start: 0, end: 2 }], formatting: { code: true as const } };
    const h = await asked({ selectionProbe: true }, '선택한 지라 조회', marks);
    // The yes itself carries no marks: the marks the re-run reads are the ones stored with the request text.
    const yes = await h.send('응');
    expect(h.counts.handleSelected).toBe(2);
    const rerun = h.selectedMessages[1];
    expect(rerun?.id.endsWith(':consent')).toBe(true);
    expect(rerun?.text).toBe('선택한 지라 조회');
    expect(rerun?.quotedRanges).toEqual(marks.quotedRanges);
    expect(rerun?.formatting).toEqual(marks.formatting);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
  });

  it('item 5: the EXPECTED REMOTE recipient: asked, yes, exactly one call, the reply ends with the A8.4 recipient line', async () => {
    const h = await asked({ expectedKey: 'fake-remote' });
    const yes = await h.send('응');
    expect(yes.status).toBe('RESPONDED');
    expect(yes.reply.text).toContain(SUMMARY);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(h.events.filter((event) => event === 'execute')).toHaveLength(1);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    noContentInLogs(h);
  });
});

describe('OQ1-4 review round 2: the question counts exactly the rows the listing displays', () => {
  /** A long URL: the prompt never carries URLs, so ten such items all fit the prompt while the listing's own budget drops rows. */
  const longUrlItem = (id: string): ConnectorItem => ({ ...item(id), url: `https://example.atlassian.net/browse/${id}/${'segment/'.repeat(30)}end` });
  const longItems = () => Array.from({ length: 10 }, (_, index) => longUrlItem(`A-${index + 1}`));

  it('reproduction: ten items fit the prompt but the listing displays fewer rows: no question, the not-sent line, zero calls', async () => {
    const items = longItems();
    // Precondition (the finding): the summary readout carries all ten; the listing's renderer reports fewer displayed rows.
    const desk = new WorkChatService(
      {
        workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) },
        connectors: { list: () => [{ source: 'jira', readOnly: true, isAvailable: async () => true, query: async () => ({ source: 'jira', items }) }] },
        work: {} as WorkChatServiceDeps['work'],
      },
      { summaryEnabled: true },
    );
    const outcome = await desk.handle({ kind: 'lookup', source: 'jira', query: 'my-items' }, OWNER);
    expect(outcome.kind).toBe('summarize');
    if (outcome.kind !== 'summarize') return;
    expect(outcome.readout.items).toHaveLength(10);
    expect(outcome.listedRefs).toEqual([]); // round 3: any clipping gives no listed refs
    const listing = await listingOf(items);
    expect(listing).not.toContain('[jira:A-10]');

    const h = harness({ expectedKey: 'fake-other' });
    h.state.items = items;
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${listing}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    // A later yes sends no item: there is no question to answer (it is an ordinary chat turn, no lookup re-run).
    await h.send('응');
    expect(h.counts.queries).toBe(1);
    expect(h.executed.filter((entry) => entry.request.capability === Capability.SUMMARIZATION)).toEqual([]);
    expect(JSON.stringify(h.executed)).not.toContain('jira:A-');
    noContentInLogs(h);
  });

  it('the count preview (a cut list of a count question) never asks: zero calls, no step', async () => {
    const h = harness({ expectedKey: 'fake-other', selectionProbe: true });
    h.state.items = Array.from({ length: 8 }, (_, index) => item(`A-${index + 1}`));
    const result = await h.send('선택한 지라 개수');
    expect(result.reply.text).toContain('[jira:A-1]');
    expect(result.reply.text).not.toContain('[jira:A-8]');
    expect(result.reply.text).not.toContain('보낼까요');
    expect(result.reply.text).not.toContain(renderItemSummaryNotSentLine('ko'));
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('the normal case: the listing displays every asked ref, so it asks, and a yes sends exactly those refs', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    h.state.items = Array.from({ length: 10 }, (_, index) => item(`A-${index + 1}`));
    const listing = await listingOf(h.state.items);
    expect(listing).toContain('[jira:A-10]');
    const question = await h.send(ASK);
    expect(question.reply.text).toBe(`${listing}\n지라 이슈 10건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)`);
    expect(h.executed).toEqual([]);
    const yes = await h.send('응');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    const prompt = h.executed[0]?.request.prompt ?? '';
    for (let n = 1; n <= 10; n += 1) expect(prompt).toContain(`[jira:A-${n}]`);
    noContentInLogs(h);
  });

  it('flag off: the long-URL lookup is byte-identical with or without QUOKY_SUMMARY_CONSENT alone (summarised as built, no question)', async () => {
    const results = [];
    for (const consent of ['absent', 'gate'] as const) {
      const h = harness({ consent });
      h.state.items = longItems();
      const result = await h.send(ASK);
      results.push({ reply: view(result), requests: h.executed.map((entry) => entry.request), history: h.recordAssistant, runs: h.runs });
      expect(result.reply.text).toContain(SUMMARY);
      expect(result.reply.text).not.toContain('보낼까요');
      expect(h.counts.expected).toBe(0);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.requests).toHaveLength(1);
  });
});

describe('OQ1-4 review round 3: ask only when the listing is unclipped', () => {
  // Codex R3 reproduction: numbered Jira listing, 10 items, 10-char titles, 200-char summaries, short-ish URLs.
  const r3Items = () =>
    Array.from({ length: 10 }, (_, index): ConnectorItem => ({
      id: `A-${index + 1}`,
      title: 'tttttttttt',
      summary: 's'.repeat(200),
      url: `https://example.test/${'a'.repeat(50)}`,
      status: 'To Do',
    }));

  it('the service passes no listed refs unless the displayed rows equal the whole readout (any clipping fails closed)', async () => {
    const run = async (items: ConnectorItem[], numbered: boolean) => {
      const desk = new WorkChatService(
        {
          workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) },
          connectors: { list: () => [{ source: 'jira', readOnly: true, isAvailable: async () => true, query: async () => ({ source: 'jira', items }) }] },
          work: {} as WorkChatServiceDeps['work'],
        },
        { summaryEnabled: true, ...(numbered ? { numberedLists: true } : {}) },
      );
      return desk.handle({ kind: 'lookup', source: 'jira', query: 'my-items' }, OWNER);
    };
    const clipped = await run(r3Items(), true);
    expect(clipped.kind).toBe('summarize');
    if (clipped.kind === 'summarize') expect(clipped.listedRefs).toEqual([]);
    const short = await run(Array.from({ length: 10 }, (_, index) => item(`A-${index + 1}`)), false);
    expect(short.kind === 'summarize' && short.listedRefs?.length).toBe(10);
  });

  it('Codex R3 reproduction: no question, the not-sent line, zero calls', async () => {
    const items = r3Items();
    const h = harness({ expectedKey: 'fake-other', numbered: true });
    h.state.items = items;
    const result = await h.send(ASK);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(result.reply.text.endsWith(renderItemSummaryNotSentLine('ko'))).toBe(true);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    noContentInLogs(h);
  });
});
