import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun } from '../domain';
import type { AiProvider, AiRequest, ConversationTurnHandler, DriveDocument, DriveReader, LogFields, Logger, MailMessage, MailReader, StorageProvider, TurnHandlerOutcome } from '../ports';
import { ConsentPendingStore } from './consent-answer/consent-pending';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import { ItemSummaryConsent } from './consent-answer/item-summary-consent';
import { ContextBuilder } from './context-builder';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { createDriveTurnHandler } from './drive/drive-turn-handler';
import { IntentResolver } from './intent-resolver';
import { itemSummaryConsentDescriptor } from './item-summary-consent-descriptor';
import { renderItemSummaryNotSentLine, SUMMARY_CONSENT_REFUSED_REPLY_ID, SUMMARY_RECIPIENT_RECHECK_REFUSED } from './item-summary/summary-recipient-guard';
import { createMailTurnHandler } from './mail/mail-turn-handler';
import { renderMailSummaryFooter } from './mail/mail-reply-renderer';
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

/**
 * ADR-0121 amendment A8, slice OQ1-2: the egress guard, the recipient line and the ask for an unexpected recipient, through the
 * REAL ConversationRuntime, the real mail and Drive handlers, PromptComposer and PromptRenderer (Jira and the D8 lookup through
 * fixed handlers that return what the real ones return). Only storage, the readers, the providers, the router and Task bookkeeping
 * are fakes. The router answers like the composition root: `select`, the dispatch-time `isStillEligible` and the data-only
 * `expectedRecipientKey`.
 */

const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
const CHANNEL: ConversationContext = { platform: 'test', spaceId: 'g-1', channelId: 'chan-1', userId: 'owner-user', direct: false };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-11-26T01:00:00.000Z';
/** In every item: it must never reach a log line. */
const CANARY = ['zq', 'canary', 'vxw'].join('');
const SUMMARY = '요약 본문이에요.';
const ATTRIBUTED = "메일에서 보낸이는 '견적서를 보냈다'고 적었어요.";
const CLAIM = '김철수 님께 견적서 전달 완료.';
const LINE = '· Remote로 요약';

type ProviderName = 'remote' | 'other' | 'local' | 'anon';

interface HarnessOptions {
  /** `absent`: no gate at all; `gate`: QUOKY_SUMMARY_CONSENT=on only; `items`: both switches on. */
  readonly consent?: 'absent' | 'gate' | 'items';
  readonly selected?: ProviderName;
  /** The policy's expected key (`undefined`: nothing expected). */
  readonly expectedKey?: string;
  /** The router has no `isStillEligible` (fail closed). */
  readonly noEligibility?: boolean;
  /** The summaries the selected provider returns, in order (the last repeats). */
  readonly summaries?: readonly string[];
  readonly failExecute?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const events: string[] = [];
  const executed: { provider: string; request: AiRequest }[] = [];
  const recordAssistant: string[] = [];
  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const runs: { kind: 'complete' | 'fail'; summary?: string; metadata?: unknown }[] = [];
  const counts = { select: 0, eligible: 0, expected: 0 };
  const state = { selected: opts.selected ?? 'remote', expectedKey: 'expectedKey' in opts ? opts.expectedKey : 'fake-remote', eligible: true, microtaskRan: false };
  /** Called at the named points (tests flip the selection there). */
  const hooks: { onCommit?: () => void; onExecute?: (n: number) => void; afterSelect?: (n: number) => void } = {};

  const storage = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, { ...s });
        return s;
      },
      async get(id: string) {
        return sessions.get(id) ?? null;
      },
      async findActiveByContext(platform: string, channelId: string, threadId?: string) {
        return [...sessions.values()].find((s) => s.status === SessionStatus.ACTIVE && s.context.platform === platform && s.context.channelId === channelId && s.context.threadId === threadId) ?? null;
      },
    },
  };
  const sessionManager = new SessionManager(storage as unknown as StorageProvider);

  const mailSummary = { id: 'msg-1', sender: { name: 'Planner', address: 'planner@example.com' }, subject: `분기 계획 ${CANARY}`, receivedAt: '2026-11-25T00:30:00.000Z', snippet: '', unread: true };
  const mailReader: MailReader = {
    source: 'mail',
    readOnly: true,
    async search() {
      return { messages: [mailSummary], matched: 1, matchedIsLowerBound: false };
    },
    async getMessage(): Promise<MailMessage> {
      return { ...mailSummary, bodyText: `짧은 메일이에요 ${CANARY}.`, bodyTruncated: false };
    },
    async getThread() {
      return {
        messages: [0, 1].map((index) => ({ ...mailSummary, id: `msg-${index}`, sender: { name: `보낸이${index}`, address: `p${index}@example.com` }, bodyText: `스레드 ${index} ${CANARY}`, bodyTruncated: false })),
        totalMessages: 2,
      };
    },
  };
  const file = { id: 'file-1', name: `계획 문서 ${CANARY}`, kind: 'document' as const, modifiedAt: '2026-11-25T00:30:00.000Z' };
  const driveReader: DriveReader = {
    source: 'drive',
    readOnly: true,
    async searchByName() {
      return { files: [file], matched: 1, matchedIsLowerBound: false };
    },
    async recentFiles() {
      return { files: [file], matched: 1, matchedIsLowerBound: false };
    },
    async exportText(): Promise<DriveDocument> {
      return { ...file, ownerName: 'Planner', text: `문서 본문 ${CANARY}`, textTruncated: false };
    },
  };

  let executeCount = 0;
  const provider = (id: string, executionLocality: 'LOCAL' | 'REMOTE'): AiProvider => ({
    id,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 50 }],
    executionLocality,
    async isAvailable() {
      return true;
    },
    async execute(request: AiRequest) {
      // Recorded synchronously at entry: whether a microtask queued by the guard's check already ran (it must not have).
      events.push(state.microtaskRan ? 'execute-after-microtask' : 'execute');
      executed.push({ provider: id, request });
      executeCount += 1;
      hooks.onExecute?.(executeCount);
      if (opts.failExecute === true) throw new Error('provider down');
      const list = opts.summaries ?? [SUMMARY];
      return { text: list[Math.min(executeCount - 1, list.length - 1)] ?? SUMMARY, artifacts: [] };
    },
  });
  const providers: Record<ProviderName, AiProvider> = {
    remote: provider('fake-remote', 'REMOTE'),
    other: provider('fake-other', 'REMOTE'),
    local: provider('fake-local', 'LOCAL'),
    anon: provider('fake-anon', 'REMOTE'),
  };
  const labels: Readonly<Record<string, string>> = { 'fake-remote': 'Remote', 'fake-other': 'Other' };
  const recipientLabel = (p: AiProvider): string | undefined => labels[p.id];

  const shortTerm: MemoryRecord[] = [];
  const contextBuilder = new ContextBuilder(
    {
      async recentShortTerm(scope: { sessionId?: string }, limit: number) {
        return shortTerm.filter((r) => r.scope.sessionId === scope.sessionId).slice(-limit);
      },
      async projectMemory() {
        return undefined;
      },
    } as unknown as MemoryManager,
    {},
    { async retrieve() { return []; } } as unknown as MemoryRetriever,
  );
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, ...(fields !== undefined ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ level: 'warn', message, ...(fields !== undefined ? { fields } : {}) }),
    error: (message, fields) => logs.push({ level: 'error', message, ...(fields !== undefined ? { fields } : {}) }),
  };

  // Jira (A6 R2 single item) and the D8 lookup: fixed handlers returning what the real ones return for these phrases.
  const jira = buildUntrustedDocumentReadout({ source: 'jira-issue', title: `이슈 ${CANARY}`, author: 'Reporter', date: '2026-11-25T00:30:00.000Z', body: `이슈 본문 ${CANARY}` });
  if (!jira.ok) throw new Error('fixture');
  const jiraOutcome = (consent: boolean): TurnHandlerOutcome => ({
    kind: 'summarize',
    readout: jira.readout,
    fallbackText: 'JIRA FALLBACK',
    footer: 'JIRA FOOTER',
    history: { assistant: 'JIRA NOTE' },
    ...(consent ? { consent: itemSummaryConsentDescriptor({ handlerId: 'jira-probe', source: 'jira', itemId: 'A-1', language: 'ko' }) } : {}),
  });
  const lookup: TurnHandlerOutcome = {
    kind: 'summarize',
    readout: buildExternalWorkReadout({ source: 'jira', query: 'my-items', items: [{ id: 'A-1', title: `일 ${CANARY}` }] }),
    fallbackText: 'LOOKUP LISTING',
    footer: 'LOOKUP FOOTER',
  };
  const fixed: ConversationTurnHandler = {
    id: 'jira-probe',
    stage: 'pre-classify',
    order: 1,
    async handle(ctx) {
      const text = ctx.message.text;
      if (text === '지라 이슈 요약') return jiraOutcome(true);
      if (text === '지라 이슈 요약 (설명 없음)') return jiraOutcome(false);
      if (text === '내 지라 일 요약') return lookup;
      return null;
    },
  };
  const handlers: ConversationTurnHandler[] = [
    createMailTurnHandler({ reader: mailReader, timeZone: 'Asia/Seoul', logger }),
    createDriveTurnHandler({ reader: driveReader, timeZone: 'Asia/Seoul', logger }),
    fixed,
  ];
  const bad = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  let taskSeq = 0;
  let selectCount = 0;
  const router: ConversationRuntimeDeps['router'] = {
    async select() {
      counts.select += 1;
      selectCount += 1;
      const chosen = providers[state.selected];
      hooks.afterSelect?.(selectCount);
      return chosen;
    },
    expectedRecipientKey: () => {
      counts.expected += 1;
      return state.expectedKey;
    },
    ...(opts.noEligibility === true
      ? {}
      : {
          isStillEligible: (_capability: Capability, _context: unknown, p: AiProvider) => {
            counts.eligible += 1;
            events.push('guard');
            // A microtask queued here runs only if something is awaited before the call.
            state.microtaskRan = false;
            void Promise.resolve().then(() => {
              state.microtaskRan = true;
            });
            return state.eligible && p === providers[state.selected];
          },
        }),
  };
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: {
      async commit() {
        events.push('commit');
        hooks.onCommit?.();
        return {} as TaskRun;
      },
    } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm(message: InboundMessage, sessionId?: string) {
        const n = shortTerm.length + 1;
        shortTerm.push({ id: `mem-${n}`, type: MemoryType.SHORT_TERM, scope: sessionId ? { sessionId } : {}, content: message.text, metadata: { role: 'user' }, createdAt: T0, updatedAt: T0 });
        return { id: `mem-${n}` };
      },
      async recordAssistant(text: string) {
        recordAssistant.push(text);
        return undefined;
      },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('createCandidate'), promote: bad('promote'), forget: bad('forget') } as unknown as MemoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' };
      },
    },
    projects: { register: bad('projects.register'), get: async () => null } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      async createTask(intent, context, anchor) {
        return { id: `task-${++taskSeq}`, title: intent.summary, description: anchor.requestText, status: TaskStatus.PENDING, intent, riskLevel: RiskLevel.LOW, context, actorId: anchor.actorId, sessionId: anchor.sessionId, createdAt: T0, updatedAt: T0 } as Task;
      },
      async transition(task, to) { return { ...task, status: to }; },
      async startRun(task, capability) { return { id: `run-${task.id}`, taskId: task.id, capability } as TaskRun; },
      async completeRun(_run, o) {
        runs.push({ kind: 'complete', metadata: o.metadata });
        return undefined;
      },
      async failRun(_run, summary, o) {
        runs.push({ kind: 'fail', summary, metadata: o.metadata });
        return undefined;
      },
    },
    workspace: { prepare: async () => undefined, open: bad('workspace.open'), list: bad('list'), diff: bad('diff'), read: bad('read') },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: (task, exclude) => contextBuilder.build(task, exclude) },
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router,
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: { decide: bad('approvals.decide'), get: bad('approvals.get'), requestForRisk: bad('approvals.requestForRisk') } as unknown as ConversationRuntimeDeps['approvals'],
    approvalFlow: new StatelessApprovalFlow(storage as never),
    scopeClarificationFlow: { findPending: async () => null, anchor: bad('scope.anchor'), clear: async () => undefined },
    applyPreviewFlow: { findAnchor: async () => null, anchor: bad('applyPreview.anchor'), clear: async () => undefined },
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('getProposal') },
    patch: { generate: bad('patch.generate'), get: bad('patch.get') },
    codeProposals: { get: bad('codeProposals.get') },
    workspaceWrite: { apply: bad('workspaceWrite.apply') },
    git: {
      status: bad('git.status'),
      diff: bad('git.diff'),
      commitFiles: bad('git.commitFiles'),
      info: bad('git.info'),
      pushApprovedCommit: bad('git.pushApprovedCommit'),
      syncMain: bad('git.syncMain'),
      deleteMergedLocalBranch: bad('git.deleteMergedLocalBranch'),
    },
    turnHandlers: handlers,
    logger,
  };

  const consent = opts.consent ?? 'items';
  const clock = { now: 1_000_000 };
  const store = new ConsentPendingStore();
  const items = consent === 'items' ? new ItemSummaryConsent({ store, now: () => clock.now, logger, recipientLabel }) : undefined;
  const continued = { count: 0 };
  const gate =
    consent === 'absent'
      ? undefined
      : new ConsentTurnGate({
          store,
          classifier: { mode: 'off' },
          continueSummary: async () => {
            continued.count += 1;
            return { kind: 'reply', reply: { text: 'AGENT CONTINUATION' } };
          },
          ...(items !== undefined ? { items } : {}),
          now: () => clock.now,
          logger,
        });
  const runtime = new ConversationRuntime(deps, { clock: () => T0, ...(gate !== undefined ? { consentTurnGate: gate } : {}) });
  let seq = 0;
  const send = (text: string, context: ConversationContext = DM) => runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0 } satisfies InboundMessage);
  return { send, state, hooks, events, executed, recordAssistant, logs, runs, counts, continued, items, store };
}

type Harness = ReturnType<typeof harness>;
const view = (result: { readonly status: string; readonly reply: OutboundMessage }) => ({ status: result.status, reply: result.reply });

/** P1–P7 as the owner sends them (P3/P5, the NL `item.summarize` selection, reaches the same summarize outcome as P1/P4). */
const PATHS: readonly { readonly name: string; readonly list?: string; readonly ask: string }[] = [
  { name: 'P1 mail item', list: '안 읽은 메일', ask: '1번 메일 요약해줘' },
  { name: 'P2 mail thread', list: '안 읽은 메일', ask: '1번 메일 스레드 요약해줘' },
  { name: 'P4 Drive file', list: '최근 문서', ask: '1번 문서 요약해줘' },
  { name: 'P6 Jira item', ask: '지라 이슈 요약' },
  { name: 'P7 D8 lookup', ask: '내 지라 일 요약' },
];

async function runPath(h: Harness, path: (typeof PATHS)[number], context: ConversationContext = DM) {
  if (path.list !== undefined) await h.send(path.list, context);
  return h.send(path.ask, context);
}

const noContentInLogs = (h: Harness) => {
  const text = JSON.stringify(h.logs);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(SUMMARY);
  expect(text).not.toContain('요약해줘');
};

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

  it('never on the handler fallback: a provider failure is the fallback without the line', async () => {
    const h = harness({ failExecute: true });
    const result = await runPath(h, PATHS[3]!);
    expect(result.reply.text).toBe('JIRA FALLBACK');
    expect(h.recordAssistant.at(-1)).toBe('JIRA NOTE');
  });

  it('unexpected in the DM: the fixed question is the whole reply, the history keeps it, zero execute calls', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    const result = await runPath(h, PATHS[0]!);
    expect(result.reply.text).toBe('메일 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)');
    expect(h.recordAssistant.at(-1)).toBe(result.reply.text);
    expect(h.executed).toEqual([]);
    expect(h.counts.select).toBe(1);
    expect(h.runs).toEqual([]);
    // A yes in this slice is the fixed unavailable line (the continuation is OQ1-3); still nothing is sent.
    const yes = await h.send('응');
    expect(yes.reply.text).toBe('지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.');
    expect(h.executed).toEqual([]);
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

  it('D8 lookup with a REMOTE recipient (expected or not): the listing only, no summary call', async () => {
    for (const expectedKey of ['fake-remote', 'fake-other']) {
      const h = harness({ expectedKey });
      const result = await runPath(h, PATHS[4]!);
      expect(result.reply.text).toBe('LOOKUP LISTING');
      expect(h.executed).toEqual([]);
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

  it('hook 2: the recipient changes during the first call: the regeneration is refused, the reply is the fallback (no claim notice, no line)', async () => {
    const h = harness({ summaries: [CLAIM, ATTRIBUTED] });
    h.hooks.onExecute = (n) => {
      if (n === 1) h.state.expectedKey = 'fake-other';
    };
    const result = await runPath(h, PATHS[3]!);
    expect(result.reply.text).toBe('JIRA FALLBACK');
    expect(h.executed).toHaveLength(1);
    expect(h.events).toEqual(['commit', 'guard', 'execute', 'guard']);
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
