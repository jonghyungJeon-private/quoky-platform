import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun } from '../domain';
import type { AiProvider, AiRequest, ConversationTurnHandler, DriveDocument, DriveReader, LogFields, Logger, MailMessage, MailReader, StorageProvider, TurnHandlerOutcome } from '../ports';
import { ConsentPendingStore } from './consent-answer/consent-pending';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import type { ConsentClassifierSwitch } from './consent-answer/consent-answer';
import type { ItemSummaryConsentToken } from './consent-answer/item-summary-consent';
import { nlActionEntry } from './nl-routing/action-entries';
import type { NlActionLevel } from './nl-routing/nl-action-policy';
import type { NlItemR2Level } from './nl-routing/nl-selection-service';
import { renderItemSummaryChangedLine } from './item-summary/item-summary-continuation';
import { ItemSummaryConsent } from './consent-answer/item-summary-consent';
import { ContextBuilder } from './context-builder';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { createDriveTurnHandler } from './drive/drive-turn-handler';
import { IntentResolver } from './intent-resolver';
import { itemSummaryConsentDescriptor } from './item-summary-consent-descriptor';
import { SummaryRecipientGuard, renderItemSummaryNotSentLine, SUMMARY_CONSENT_REFUSED_REPLY_ID, SUMMARY_RECIPIENT_RECHECK_REFUSED } from './item-summary/summary-recipient-guard';
import { createMailTurnHandler } from './mail/mail-turn-handler';
import { renderMailSummaryFooter, renderMailSummaryUnavailable } from './mail/mail-reply-renderer';
import type { MemoryManager } from './memory-manager';
import type { MemoryRetriever } from './memory-retriever';
import type { MemoryWriter } from './memory-writer';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { buildUntrustedDocumentReadout, renderUntrustedDocumentHistoryNote } from './untrusted-document-readout';
import { buildExternalWorkReadout } from './work-chat/external-work-readout';
import { ATTRIBUTED, CANARY, CHANNEL, CLAIM, DM, LINE, OWNER, PATHS, SUMMARY, T0, harness, noContentInLogs, runPath, view, type Harness } from './item-summary-consent.test-support';


describe('OQ1-2 dormancy: QUOKY_ITEM_SUMMARY_CONSENT off is byte-identical (P1–P7)', () => {
  it.each(PATHS)('$name: no gate vs QUOKY_SUMMARY_CONSENT=on alone: same reply, calls, prompts and history; the A8 hooks never run', async (path) => {
    const results = [];
    for (const consent of ['absent', 'gate'] as const) {
      const h = harness({ consent });
      const result = await runPath(h, path);
      results.push({
        reply: view(result),
        prompts: h.executed.map((entry) => ({ provider: entry.provider, prompt: entry.request.prompt })),
        history: h.recordAssistant,
        runs: h.runs,
        select: h.counts.select,
      });
      // No pre-resolve, no guard, no expected-key read.
      expect(h.counts.expected).toBe(0);
      expect(h.counts.eligible).toBe(0);
      expect(h.events.filter((event) => event === 'guard')).toEqual([]);
      expect(result.reply.text).not.toContain(LINE);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.prompts).toHaveLength(1);
  });
});

describe('OQ1-2 flag on: the recipient decides', () => {
  it('LOCAL: the summary as today, held to LOCAL by the guard, no recipient line', async () => {
    const h = harness({ selected: 'local' });
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text).toBe(`${SUMMARY}\n\n${renderMailSummaryFooter('ko')}`);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
  });

  it.each(PATHS.slice(0, 4))('$name, expected REMOTE: one call and the reply ends with the recipient line', async (path) => {
    const h = harness();
    const result = await runPath(h, path);
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    // The selection was resolved twice (pre-resolve, work path) and re-checked once, right before the call.
    expect(h.counts.select).toBe(2);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
    noContentInLogs(h);
  });

  it('expected: the line sits after the footer (mail item, exact text)', async () => {
    const h = harness();
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text).toBe(`${SUMMARY}\n\n${renderMailSummaryFooter('ko')}\n${LINE}`);
    expect(h.recordAssistant.at(-1)).toBe(renderUntrustedDocumentHistoryNote('mail', 'ko'));
  });

  it('expected: a regenerated summary carries the line; the regeneration is re-checked too', async () => {
    const h = harness({ summaries: [CLAIM, ATTRIBUTED] });
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text).toBe(`${ATTRIBUTED}\n\n${renderMailSummaryFooter('ko')}\n${LINE}`);
    expect(h.events).toEqual(['commit', 'guard', 'execute', 'guard', 'execute']);
  });

  it('ruling (d): a fixed notice after a completed REMOTE call also carries the line', async () => {
    const h = harness({ summaries: [CLAIM, CLAIM] });
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text.endsWith(`${renderMailSummaryFooter('ko')}\n${LINE}`)).toBe(true);
    expect(result.reply.text.startsWith(CLAIM)).toBe(false);
    expect(h.executed).toHaveLength(2);
  });

  it('no completed REMOTE call: a first-call provider failure is the fallback without the line', async () => {
    const h = harness({ failExecute: true });
    const result = await runPath(h, PATHS[3]!);
    expect(result.reply.text).toBe('JIRA FALLBACK');
    expect(h.recordAssistant.at(-1)).toBe('JIRA NOTE');
  });

  it('a completed REMOTE call then a failed regeneration: the fixed notice (a reply of a completed call) ends with the recipient line', async () => {
    const h = harness({ summaries: [CLAIM, ATTRIBUTED], failOnCall: 2 });
    const result = await runPath(h, PATHS[3]!);
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text.endsWith(`JIRA FOOTER\n${LINE}`)).toBe(true);
    expect(result.reply.text).not.toContain('JIRA FALLBACK');
    expect(h.executed).toHaveLength(2);
  });

  it('unexpected in the DM: the fixed question is the whole reply, the history keeps it, zero execute calls', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text).toBe('메일 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)');
    expect(h.recordAssistant.at(-1)).toBe(result.reply.text);
    expect(h.executed).toEqual([]);
    expect(h.counts.select).toBe(1);
    expect(h.runs).toEqual([]);
    // OQ1-3: the yes runs the continuation (covered below); the agent continuation is never reached.
    expect(h.continued.count).toBe(0);
    noContentInLogs(h);
  });

  it('unexpected in the DM for a thread and a Jira item: the v2 nouns name exactly one item', async () => {
    const thread = harness({ expectedKey: undefined });
    expect((await runPath(thread, PATHS[1]!)).reply.text).toBe('메일 스레드 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)');
    const issue = harness({ expectedKey: undefined });
    expect((await runPath(issue, PATHS[3]!)).reply.text).toBe('지라 이슈 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)');
    expect([...thread.executed, ...issue.executed]).toEqual([]);
  });

  it('unexpected in a channel: the fallback plus the fixed line, nothing sent, nothing asked', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    const result = await runPath(h, PATHS[3]!, CHANNEL);
    expect(result.reply.text).toBe(`JIRA FALLBACK\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.recordAssistant.at(-1)).toBe('JIRA NOTE');
    expect(h.executed).toEqual([]);
  });

  it('unexpected without the descriptor: the fallback plus the fixed line, nothing sent', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    const result = await h.send('지라 이슈 요약 (설명 없음)');
    expect(result.reply.text).toBe(`JIRA FALLBACK\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.executed).toEqual([]);
  });

  it('unnamed REMOTE recipient: the fallback plus the fixed line, nothing sent', async () => {
    const h = harness({ selected: 'anon', expectedKey: 'fake-anon' });
    const result = await runPath(h, PATHS[3]!);
    expect(result.reply.text).toBe(`JIRA FALLBACK\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.executed).toEqual([]);
  });

  it('D8 lookup with a REMOTE recipient (expected or not) and no lookup descriptor: the listing plus the fixed line, no summary call (OQ1-4)', async () => {
    for (const expectedKey of ['fake-remote', 'fake-other']) {
      const h = harness({ expectedKey });
      const result = await runPath(h, PATHS[4]!);
      expect(result.reply.text).toBe(`LOOKUP LISTING\n${renderItemSummaryNotSentLine('ko')}`);
      expect(h.executed).toEqual([]);
      // In a channel the listing only (OQ1-4, W2).
      const c = harness({ expectedKey });
      expect((await runPath(c, PATHS[4]!, CHANNEL)).reply.text).toBe('LOOKUP LISTING');
      expect(c.executed).toEqual([]);
    }
  });

  it('D8 lookup with a LOCAL recipient: summarised as built, no line', async () => {
    const h = harness({ selected: 'local' });
    const result = await runPath(h, PATHS[4]!);
    expect(result.reply.text).toContain(SUMMARY);
    expect(result.reply.text).toContain('LOOKUP FOOTER');
    expect(result.reply.text).not.toContain(LINE);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
  });
});

describe('OQ1-2 re-check guard (A8.3c)', () => {
  it('hook 1: the work path selects another recipient than the pre-resolve: no call, run failed with a content-free code, fallback', async () => {
    const h = harness();
    h.hooks.afterSelect = (n) => {
      if (n === 1) h.state.selected = 'other';
    };
    const result = await runPath(h, PATHS[3]!);
    expect(result.reply.text).toBe('JIRA FALLBACK');
    expect(h.executed).toEqual([]);
    expect(h.runs).toEqual([{ kind: 'fail', summary: SUMMARY_RECIPIENT_RECHECK_REFUSED, metadata: { deterministicReply: SUMMARY_CONSENT_REFUSED_REPLY_ID } }]);
  });

  it('hook 1: the expected identity changes after the dispatch commit: no call', async () => {
    const h = harness();
    h.hooks.onCommit = () => {
      h.state.expectedKey = undefined;
    };
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text).not.toContain(SUMMARY);
    expect(result.reply.text).not.toContain(LINE);
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual(['commit', 'guard']);
  });

  it('hook 1: the provider is no longer eligible, or the selector has no dispatch-time check: no call (fail closed)', async () => {
    const stale = harness();
    stale.hooks.onCommit = () => {
      stale.state.eligible = false;
    };
    await runPath(stale, PATHS[0]!);
    expect(stale.executed).toEqual([]);
    const unverifiable = harness({ noEligibility: true });
    const result = await runPath(unverifiable, PATHS[0]!);
    expect(unverifiable.executed).toEqual([]);
    expect(result.reply.text).not.toContain(LINE);
  });

  it('hook 1: a LOCAL turn whose work path lands on a REMOTE provider makes no call', async () => {
    const h = harness({ selected: 'local' });
    h.hooks.afterSelect = (n) => {
      if (n === 1) h.state.selected = 'remote';
    };
    await runPath(h, PATHS[0]!);
    expect(h.executed).toEqual([]);
  });

  it('hook 2: the recipient changes during the first call: the regeneration is refused, the reply is the fallback with the line (no claim notice)', async () => {
    const h = harness({ summaries: [CLAIM, ATTRIBUTED] });
    h.hooks.onExecute = (n) => {
      if (n === 1) h.state.expectedKey = 'fake-other';
    };
    const result = await runPath(h, PATHS[3]!);
    // Call 1 completed on a REMOTE provider: the fallback names its recipient and the failed run keeps call 1's usage.
    expect(result.reply.text).toBe(`JIRA FALLBACK\n${LINE}`);
    expect(h.executed).toHaveLength(1);
    expect(h.events).toEqual(['commit', 'guard', 'execute', 'guard']);
    expect(h.runs).toEqual([{ kind: 'fail', summary: SUMMARY_RECIPIENT_RECHECK_REFUSED, metadata: { deterministicReply: SUMMARY_CONSENT_REFUSED_REPLY_ID }, usage: expect.objectContaining({ totalTokens: 10 }) }]);
  });

  it('the GENERAL_CHAT routed seam refuses a guarded call in one line: no execute, content-free code', async () => {
    const h = harness({ routing: true });
    const guard = new SummaryRecipientGuard({
      capability: Capability.GENERAL_CHAT,
      context: {} as never,
      snapshot: { kind: 'local' },
      selector: {},
      recipientLabel: () => undefined,
    });
    const session = { id: 'session-x', context: DM, status: SessionStatus.ACTIVE, createdAt: T0, updatedAt: T0 } as unknown as Session;
    const intent: Intent = { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'chat', raw: {} } as Intent;
    const message: InboundMessage = { id: 'msg-direct', context: DM, text: '안녕', receivedAt: T0 };
    const handle = (h.runtime as unknown as { handleWorkTurn(...args: unknown[]): Promise<{ status: string }> }).handleWorkTurn.bind(h.runtime);
    const result = await handle(message, session, OWNER, intent, 'mem-x', undefined, undefined, guard);
    expect(result.status).toBe('FAILED');
    expect(h.events).not.toContain('routed-execute');
    expect(h.executed).toEqual([]);
    expect(h.runs).toEqual([{ kind: 'fail', summary: SUMMARY_RECIPIENT_RECHECK_REFUSED, metadata: { deterministicReply: SUMMARY_CONSENT_REFUSED_REPLY_ID } }]);
  });

  it('nothing is awaited between the guard and the call: a microtask queued by the check has not run when the call starts', async () => {
    const h = harness({ summaries: [CLAIM, ATTRIBUTED] });
    await runPath(h, PATHS[0]!);
    expect(h.events).toEqual(['commit', 'guard', 'execute', 'guard', 'execute']);
    expect(h.events).not.toContain('execute-after-microtask');
  });

  it('logs stay content-free on every refusal path', async () => {
    const h = harness();
    h.hooks.onCommit = () => {
      h.state.expectedKey = undefined;
    };
    await runPath(h, PATHS[0]!);
    noContentInLogs(h);
    expect(h.logs.some((entry) => entry.message === 'item summary recipient re-check refused' && entry.fields?.phase === 'call')).toBe(true);
  });
});

describe('OQ1-3 continuation: the owner says yes to the question for an unexpected recipient (A8.5)', () => {
  const QUESTION = '메일 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)';
  const UNAVAILABLE = '지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.';
  const R2 = { level: 'local', itemR2: 'all', acting: true } as const;

  /** Asks (unexpected: the owner expects another provider), checks the question, and returns the harness for the yes. */
  async function asked(opts: HarnessOptions = {}, path: (typeof PATHS)[number] = PATHS[0]!) {
    const h = harness({ expectedKey: 'fake-other', ...opts });
    const question = await runPath(h, path);
    expect(question.reply.text).toContain('Remote에 보내 요약할게요');
    expect(h.executed).toEqual([]);
    return h;
  }
  /** Only the provider calls that carried the item (a chat call after a routed turn carries none). */
  const itemCalls = (h: Harness) => h.executed.filter((entry) => entry.request.prompt.includes(CANARY));

  it('a yes: exactly one REMOTE call to the confirmed recipient, the reply ends with the recipient line, the history keeps the fixed notes', async () => {
    const h = await asked();
    const before = h.recordAssistant.length;
    const yes = await h.send('응');
    expect(yes.status).toBe('RESPONDED');
    expect(yes.reply.text).toBe(`${SUMMARY}\n\n${renderMailSummaryFooter('ko')}\n${LINE}`);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    // One fixed note for the yes turn (the work path's document note); never the summary or the item.
    expect(h.recordAssistant.slice(before)).toEqual([renderUntrustedDocumentHistoryNote('mail', 'ko')]);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
    expect(h.continued.count).toBe(0);
    noContentInLogs(h);
  });

  it('the summarization prompt is byte-identical to the one the same request sends without a question', async () => {
    const consented = await asked();
    await consented.send('응');
    const direct = harness();
    await runPath(direct, PATHS[0]!);
    expect(consented.executed).toHaveLength(1);
    expect(direct.executed).toHaveLength(1);
    expect(consented.executed[0]?.request).toEqual(direct.executed[0]?.request);
  });

  it('a yes with one regeneration: two calls, both admitted by the token, the regenerated reply carries the line', async () => {
    const h = await asked({ summaries: [CLAIM, ATTRIBUTED] });
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(`${ATTRIBUTED}\n\n${renderMailSummaryFooter('ko')}\n${LINE}`);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote', 'fake-remote']);
    expect(h.events).toEqual(['commit', 'guard', 'execute', 'guard', 'execute']);
  });

  it('the token is retired after the call: a replay of it is refused', async () => {
    const h = await asked();
    const spent: ItemSummaryConsentToken[] = [];
    const spend = h.items!.spend.bind(h.items);
    h.items!.spend = (token) => {
      spent.push(token);
      spend(token);
    };
    await h.send('응');
    expect(spent).toHaveLength(1);
    const use = { phase: 'call' as const, actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(DM), source: 'mail' as const, itemId: 'msg-1' };
    expect(h.items!.allowsContinuation(spent[0], { kind: 'unexpected', key: 'fake-remote', label: 'Remote' }, use)).toBe(false);
    expect(h.items!.allowsContinuation(spent[0], { kind: 'unexpected', key: 'fake-remote', label: 'Remote' }, { ...use, phase: 'regeneration' })).toBe(false);
  });

  it('a second yes is not a second summary (single use): the step is used and no item call follows', async () => {
    const h = await asked();
    await h.send('응');
    const again = await h.send('응');
    expect(again.reply.text).not.toContain(SUMMARY);
    expect(again.reply.text).not.toContain(LINE);
    expect(itemCalls(h)).toHaveLength(1);
  });

  it('a recipient flip after the yes (another unexpected REMOTE): refused, the fallback plus the not-sent line, nothing sent', async () => {
    const h = await asked();
    h.state.expectedKey = undefined;
    h.state.selected = 'other';
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(`${renderMailSummaryUnavailable('ko')}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.executed).toEqual([]);
    expect(h.recordAssistant.at(-1)).toBe(renderUntrustedDocumentHistoryNote('mail', 'ko'));
  });

  it('a REMOTE recipient that lost its name after the yes: refused, nothing sent', async () => {
    const h = await asked();
    h.state.selected = 'anon';
    await h.send('응');
    expect(h.executed).toEqual([]);
  });

  it('the live verdict became LOCAL after the yes: summarised under the normal rules, no line', async () => {
    const h = await asked();
    h.state.selected = 'local';
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(`${SUMMARY}\n\n${renderMailSummaryFooter('ko')}`);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
  });

  it('the consented recipient became the expected one after the yes: same key AND label, admitted by the token, the line', async () => {
    const h = await asked();
    h.state.expectedKey = 'fake-remote';
    const yes = await h.send('응');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
  });

  describe('review round 1 (P1, strict A8.5): the yes names ONE recipient; every REMOTE recipient needs the token', () => {
    it('asked for A, B became the EXPECTED recipient before the yes: zero REMOTE calls, the fallback plus the not-sent line', async () => {
      const h = await asked();
      // B (`fake-other`) was the expected key all along; now the selection lands on it, so it is expected, not A.
      h.state.selected = 'other';
      const yes = await h.send('응');
      expect(h.executed).toEqual([]);
      expect(yes.reply.text).toBe(`${renderMailSummaryUnavailable('ko')}\n${renderItemSummaryNotSentLine('ko')}`);
      expect(yes.reply.text).not.toContain('Other');
    });

    it('B becomes expected and selected only between the continuation pre-resolve and hook 1: refused at hook 1, zero calls', async () => {
      const h = await asked();
      h.hooks.afterSelect = (n) => {
        if (n === 2) {
          h.state.selected = 'other';
          h.state.expectedKey = 'fake-other';
        }
      };
      await h.send('응');
      expect(h.executed).toEqual([]);
    });

    it.each([
      ['unexpected', 'fake-other'],
      ['expected', 'fake-remote'],
    ] as const)('the same key with another label after the yes (%s): refused, nothing sent', async (_kind, expectedKey) => {
      const h = await asked();
      h.hooks.onRead = () => {
        h.state.expectedKey = expectedKey;
        h.labels['fake-remote'] = 'Remote 2';
      };
      const yes = await h.send('응');
      expect(h.executed).toEqual([]);
      expect(yes.reply.text).toBe(`${renderMailSummaryUnavailable('ko')}\n${renderItemSummaryNotSentLine('ko')}`);
    });

    it('a relabel between the pre-resolve and hook 1 is refused at hook 1 (expected case)', async () => {
      const h = await asked();
      h.state.expectedKey = 'fake-remote';
      h.hooks.afterSelect = (n) => {
        if (n === 2) h.labels['fake-remote'] = 'Remote 2';
      };
      await h.send('응');
      expect(h.executed).toEqual([]);
    });

    it('LOCAL after the yes: proceeds without the token, no recipient line', async () => {
      const h = await asked();
      h.state.selected = 'local';
      const yes = await h.send('응');
      expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
      expect(yes.reply.text).not.toContain(LINE);
    });

    it('expected case: an expired token (more than 600 s from the mint) is refused at hook 1, nothing sent', async () => {
      const h = await asked();
      h.state.expectedKey = 'fake-remote';
      h.hooks.onRead = () => {
        h.clock.now += 601_000;
      };
      const yes = await h.send('응');
      expect(h.executed).toEqual([]);
      expect(yes.reply.text).toBe(renderMailSummaryUnavailable('ko'));
    });

    it('expected case: a token voided (voidAll) after the mint is refused, nothing sent', async () => {
      const h = await asked();
      h.state.expectedKey = 'fake-remote';
      h.hooks.onRead = () => h.gate?.voidAll();
      const yes = await h.send('응');
      expect(h.executed).toEqual([]);
      expect(yes.reply.text).toBe(renderMailSummaryUnavailable('ko'));
    });

    it('expected case: the regeneration also needs the token (a void during the first call refuses it)', async () => {
      const h = await asked({ summaries: [CLAIM, ATTRIBUTED] });
      h.state.expectedKey = 'fake-remote';
      h.hooks.onExecute = (n) => {
        if (n === 1) h.gate?.voidAll();
      };
      const yes = await h.send('응');
      expect(h.executed).toHaveLength(1);
      expect(yes.reply.text).toBe(`${renderMailSummaryUnavailable('ko')}\n${LINE}`);
    });
  });

  describe('review round 1 (CA P3 ordering): a stop phrase voids consents BEFORE the switch save is awaited', () => {
    it.each(['nlSelection', 'agent', 'surface'] as const)('%s path: a stop racing a continuation between the take and hook 1: zero REMOTE calls', async (stopPath) => {
      const h = await asked({ stopPath });
      let releaseRead!: () => void;
      let releaseStop!: () => void;
      h.state.readGate = new Promise<void>((resolve) => (releaseRead = resolve));
      h.state.stopSave = new Promise<void>((resolve) => (releaseStop = resolve));
      const readStarted = new Promise<void>((resolve) => (h.hooks.onRead = resolve));
      const stopStarted = new Promise<void>((resolve) => (h.state.stopEntered = resolve));
      const yes = h.send('응');
      await readStarted;
      // The token is minted and the re-read is in flight; the owner stops, and the switch save is still pending.
      const stop = h.send('에이전트 중지');
      await stopStarted;
      releaseRead();
      const answered = await yes;
      releaseStop();
      expect((await stop).reply.text).toContain('멈춤');
      expect(h.executed).toEqual([]);
      expect(answered.reply.text).not.toContain(SUMMARY);
    });
  });

  describe('review round 1 (CA P3): a throw while the reply is built after a completed REMOTE call', () => {
    it('continuation: the handler fallback still ends with the recipient line', async () => {
      const h = await asked({ nl: R2 }, PATHS[3]!);
      h.hooks.onExecute = () => {
        h.state.throwParticipants = true;
      };
      const before = h.recordAssistant.length;
      const yes = await h.send('응');
      expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
      expect(yes.reply.text).toBe(`JIRA FALLBACK\n${LINE}`);
      // Review round 2 (CA P3): exactly ONE new history note (the work path's document note); the fallback records nothing again.
      expect(h.recordAssistant.slice(before).length).toBe(1);
      expect(h.recordAssistant.slice(before)).toEqual([renderUntrustedDocumentHistoryNote('jira-issue', 'ko')]);
      noContentInLogs(h);
    });

    it('expected recipient on the ask turn (OQ1-2): the fallback also ends with the recipient line', async () => {
      const h = harness();
      h.hooks.onExecute = () => {
        h.state.throwParticipants = true;
      };
      const before = h.recordAssistant.length;
      const reply = await runPath(h, PATHS[3]!);
      expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
      expect(reply.reply.text).toBe(`JIRA FALLBACK\n${LINE}`);
      // Review round 2 (CA P3): exactly ONE new history note on the ask turn too.
      expect(h.recordAssistant.slice(before).length).toBe(1);
      expect(h.recordAssistant.slice(before)).toEqual([renderUntrustedDocumentHistoryNote('jira-issue', 'ko')]);
    });

    it('LOCAL: the fallback carries no line', async () => {
      const h = harness({ selected: 'local' });
      h.hooks.onExecute = () => {
        h.state.throwParticipants = true;
      };
      const before = h.recordAssistant.length;
      const reply = await runPath(h, PATHS[3]!);
      expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
      expect(reply.reply.text).toBe('JIRA FALLBACK');
      expect(h.recordAssistant.slice(before).length).toBe(1);
    });
  });

  describe('review round 2 (Codex P2): a stop while an item request is in flight voids it too (the turn-entry void epoch)', () => {
    /** Sends the item request, holds its provider resolve (the pre-resolve), stops in between, then releases it. */
    async function stopDuringPreResolve(h: Harness, path: (typeof PATHS)[number]) {
      if (path.list !== undefined) await h.send(path.list);
      let release!: () => void;
      h.state.selectGate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (h.state.selectEntered = resolve));
      const request = h.send(path.ask);
      await entered;
      const stop = await h.send('에이전트 중지');
      expect(stop.reply.text).toContain('멈춤');
      release();
      return request;
    }

    it.each([
      ['P1 mail item', PATHS[0]!, '메일'],
      ['P4 Drive file', PATHS[2]!, '문서'],
    ] as const)('%s, unexpected recipient: no question, no record, zero REMOTE calls; a later yes sends nothing', async (_name, path) => {
      const h = harness({ expectedKey: 'fake-other', stopPath: 'agent' });
      const reply = await stopDuringPreResolve(h, path);
      expect(reply.status).toBe('RESPONDED');
      expect(reply.reply.text).not.toContain('보낼까요');
      expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(DM) })).toBeUndefined();
      expect(h.executed).toEqual([]);
      // No step is open, so the yes is ordinary chat: no item ever reaches a provider and no recipient line appears.
      const yes = await h.send('응');
      expect(yes.reply.text).not.toContain(LINE);
      expect(itemCalls(h)).toEqual([]);
      expect(h.logs.some((entry) => entry.fields?.outcome === 'stopped')).toBe(true);
      noContentInLogs(h);
    });

    it.each(['nlSelection', 'agent', 'surface'] as const)('%s stop path, expected recipient: nothing is sent either', async (stopPath) => {
      const h = harness({ stopPath });
      const reply = await stopDuringPreResolve(h, PATHS[0]!);
      expect(reply.reply.text).not.toContain(SUMMARY);
      expect(h.executed).toEqual([]);
    });

    it('a stop between the pre-resolve and hook 1 (expected recipient): hook 1 refuses, zero calls', async () => {
      const h = harness({ stopPath: 'agent' });
      await h.send(PATHS[0]!.list!);
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (h.state.selectEntered = resolve));
      // The first resolve (the pre-resolve) runs free; the work path's own resolve waits, and the stop lands there.
      let selects = 0;
      h.hooks.afterSelect = () => {
        selects += 1;
        if (selects === 1) h.state.selectGate = new Promise<void>((resolve) => (release = resolve));
      };
      const request = h.send(PATHS[0]!.ask);
      await entered;
      await h.send('에이전트 중지');
      release();
      const reply = await request;
      expect(reply.reply.text).not.toContain(SUMMARY);
      expect(h.executed).toEqual([]);
    });

    it('without a stop the same request is unaffected (control): the question for an unexpected recipient, one call for an expected one', async () => {
      const unexpectedHarness = harness({ expectedKey: 'fake-other', stopPath: 'agent' });
      expect((await runPath(unexpectedHarness, PATHS[0]!)).reply.text).toContain('보낼까요');
      const expectedHarness = harness({ stopPath: 'agent' });
      await runPath(expectedHarness, PATHS[0]!);
      expect(expectedHarness.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    });
  });

  it('a flip between the continuation pre-resolve and the call: hook 1 refuses, no call, content-free failed run', async () => {
    const h = await asked();
    // Select #1 was the ask turn's pre-resolve; #2 the continuation's; #3 the work path's.
    h.hooks.afterSelect = (n) => {
      if (n === 2) h.state.selected = 'other';
    };
    const yes = await h.send('응');
    expect(h.executed).toEqual([]);
    expect(yes.reply.text).toBe(renderMailSummaryUnavailable('ko'));
    expect(h.runs).toEqual([{ kind: 'fail', summary: SUMMARY_RECIPIENT_RECHECK_REFUSED, metadata: { deterministicReply: SUMMARY_CONSENT_REFUSED_REPLY_ID } }]);
  });

  it('a recipient flip during the first call: the regeneration is refused, the fallback names the completed call', async () => {
    const h = await asked({ summaries: [CLAIM, ATTRIBUTED] });
    h.hooks.onExecute = (n) => {
      if (n === 1) h.state.selected = 'other';
    };
    const yes = await h.send('응');
    expect(h.executed).toHaveLength(1);
    expect(yes.reply.text).toBe(`${renderMailSummaryUnavailable('ko')}\n${LINE}`);
  });

  it('a refused re-read: nothing sent, the fixed unavailable line', async () => {
    const h = await asked();
    h.state.failRead = true;
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(UNAVAILABLE);
    expect(h.executed).toEqual([]);
    expect(h.recordAssistant.at(-1)).toBe(UNAVAILABLE);
  });

  it('the thread grew after the question: the fixed "changed" line, nothing sent', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    expect((await runPath(h, PATHS[1]!)).reply.text).toBe('메일 스레드 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)');
    h.state.threadTotal = 3;
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(renderItemSummaryChangedLine('ko'));
    expect(h.executed).toEqual([]);
    expect(h.recordAssistant.at(-1)).toBe(renderItemSummaryChangedLine('ko'));
  });

  it('the same thread (same count) after the question: one call, the line', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    await runPath(h, PATHS[1]!);
    const yes = await h.send('응');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
  });

  it('expiry: more than 600 s between the mint and the call refuses the call (hook 1), nothing sent', async () => {
    const h = await asked();
    h.hooks.onRead = () => {
      h.clock.now += 601_000;
    };
    const yes = await h.send('응');
    expect(h.executed).toEqual([]);
    expect(yes.reply.text).toBe(renderMailSummaryUnavailable('ko'));
  });

  it('expiry: a yes more than 600 s after the question is the expired line, nothing sent', async () => {
    const h = await asked();
    h.clock.now += 601_000;
    const yes = await h.send('응');
    expect(yes.reply.text).toBe('요약 확인 시간이 지났어요. 다시 요청해 주세요.');
    expect(h.executed).toEqual([]);
  });

  it('the kill switch (voidAll) before the yes: the yes summarises nothing', async () => {
    const h = await asked();
    h.gate?.voidAll();
    const yes = await h.send('응');
    expect(yes.reply.text).not.toContain(SUMMARY);
    expect(itemCalls(h)).toEqual([]);
  });

  it('the kill switch (voidAll) after the mint, during the re-read: the token is void, no call', async () => {
    const h = await asked();
    h.hooks.onRead = () => h.gate?.voidAll();
    await h.send('응');
    expect(h.executed).toEqual([]);
  });

  it('a restart (a new runtime with a new store) voids the pending question: the yes summarises nothing', async () => {
    await asked();
    const restarted = harness({ expectedKey: 'fake-other' });
    const yes = await restarted.send('응');
    // The yes is an ordinary chat turn now (the fake provider answers any call alike): the item never leaves, no recipient line.
    expect(yes.reply.text).not.toContain(LINE);
    expect(itemCalls(restarted)).toEqual([]);
  });

  it('a no cancels: nothing sent', async () => {
    const h = await asked();
    const no = await h.send('아니');
    expect(no.reply.text).toBe('요약을 취소했어요. 원문은 보내지 않았어요.');
    expect(h.executed).toEqual([]);
  });

  it.each(['ㅇㅇ', 'ok'])('%s with the classifier off cancels silently (existing gate rule): the item is never sent', async (text) => {
    const h = await asked();
    await h.send(text);
    expect(itemCalls(h)).toEqual([]);
  });

  it.each(['ㅇㅇ', 'ok'])('%s is a yes when the gate classifier answers yes (existing gate rule): one call', async (text) => {
    const h = await asked({ classifier: { mode: 'on', classify: async () => 'yes' } as unknown as ConsentClassifierSwitch });
    const yes = await h.send(text);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(itemCalls(h).map((entry) => entry.provider)).toEqual(['fake-remote']);
  });

  it('yes-and-more: the summary once, and the rest rides on the result as a new ordinary turn', async () => {
    const h = await asked({ classifier: { mode: 'on', classify: async () => 'yes-and-more' } as unknown as ConsentClassifierSwitch });
    const yes = await h.send('좋아 그리고 드라이브도');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(yes.rerun?.text).toBe('좋아 그리고 드라이브도');
    expect(yes.rerun?.id).toMatch(/:rerun$/u);
    expect(itemCalls(h)).toHaveLength(1);
  });

  it('a yes in a channel is not an answer: the step stays open, nothing sent', async () => {
    const h = await asked();
    await h.send('응', CHANNEL);
    expect(itemCalls(h)).toEqual([]);
  });

  it('Jira (A6 R2): with the R2 level acting and the switch running, one call; no selection and no receipt on the re-read', async () => {
    const h = await asked({ nl: R2 }, PATHS[3]!);
    const before = { ...h.nlCalls };
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(`${SUMMARY}\n\nJIRA FOOTER\n${LINE}`);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    // The re-read never reaches the selector (no second D8 cap charge) and rewrites no receipt.
    expect(h.nlCalls).toEqual(before);
    expect(h.nlCalls.decide).toBe(0);
    noContentInLogs(h);
  });

  it.each([
    ['the kill switch was stopped', { ...R2, acting: false }],
    ['QUOKY_NL_ITEM_R2 no longer acts for Jira', { ...R2, itemR2: 'shadow' as const }],
    ['QUOKY_NL_ACTIONS is shadow', { ...R2, level: 'shadow' as const }],
  ])('Jira: %s: the unavailable line, nothing sent', async (_name, nl) => {
    const h = await asked({ nl }, PATHS[3]!);
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(UNAVAILABLE);
    expect(h.executed).toEqual([]);
  });

  it('Jira: without the selection slot the R2 re-check fails closed', async () => {
    const h = await asked({}, PATHS[3]!);
    expect((await h.send('응')).reply.text).toBe(UNAVAILABLE);
    expect(h.executed).toEqual([]);
  });

  it('Jira: the re-read names another item: the "changed" line, nothing sent', async () => {
    const h = await asked({ nl: R2 }, PATHS[3]!);
    h.state.jiraItem = 'A-2';
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(renderItemSummaryChangedLine('ko'));
    expect(h.executed).toEqual([]);
  });

  it('the continuation message is separate: the request text, no attachments or reply-to, and it never re-enters the gate', async () => {
    const h = await asked();
    const yes = await h.runtime.handle({ id: 'yes-1', context: DM, text: '응', receivedAt: T0, replyTo: { messageId: 'q-1' } } as InboundMessage);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    const prompt = h.executed[0]?.request.prompt ?? '';
    expect(prompt).toContain('1번 메일 요약해줘');
    expect(prompt).not.toContain('응\n');
    expect(h.logs.some((entry) => entry.fields?.messageId === 'yes-1:consent')).toBe(true);
  });

  it('logs stay content-free across the continuation outcomes', async () => {
    const flip = (h: Harness) => {
      h.state.expectedKey = undefined;
      h.state.selected = 'other';
    };
    for (const setup of [flip, (h: Harness) => (h.state.failRead = true), (h: Harness) => (h.state.selected = 'remote')]) {
      const h = await asked();
      setup(h);
      await h.send('응');
      noContentInLogs(h);
    }
  });
});
