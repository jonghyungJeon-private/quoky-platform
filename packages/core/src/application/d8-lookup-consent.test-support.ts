import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun } from '../domain';
import type { AiProvider, AiRequest, ConnectorItem, ConnectorProvider, ConversationTurnHandler, LogFields, Logger, StorageProvider } from '../ports';
import { ConsentPendingStore } from './consent-answer/consent-pending';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import type { ConsentClassifierSwitch } from './consent-answer/consent-answer';
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

/**
 * ADR-0121 amendment A8.6, slice OQ1-4 (= A5-S6): rule ① for the ADR-0100 D8 work-lookup summary, through the REAL
 * ConversationRuntime, the REAL WorkChatService and work-chat turn handlers, PromptComposer and PromptRenderer. Only storage, the
 * Jira connector, the providers, the router and Task bookkeeping are fakes. The router answers like the composition root.
 */

export const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
export const CHANNEL: ConversationContext = { platform: 'test', spaceId: 'g-1', channelId: 'chan-1', userId: 'owner-user', direct: false };
export const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [{ platform: 'jira', externalId: 'jira-owner' }], createdAt: '2026-10-01T00:00:00.000Z' };
export const T0 = '2026-11-26T01:00:00.000Z';
/** In every item title: it must never reach a log line. */
export const CANARY = ['zq', 'canary', 'vxw'].join('');
export const SUMMARY = '요약 본문이에요.';
export const LINE = '· Remote로 요약';
export const ASK = '내 Jira 이슈 보여줘';
export const QUESTION = '지라 이슈 2건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)';
export const UNAVAILABLE = '지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.';
export const SCOPE = { actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(DM) };

export const item = (id: string): ConnectorItem => ({ id, title: `일 ${id} ${CANARY}`, url: `https://example.atlassian.net/browse/${id}`, status: 'To Do' });

export type ProviderName = 'remote' | 'other' | 'local' | 'anon';

export interface HarnessOptions {
  /** Numbered Jira / Slack listings (the A6 R2 desk option). */
  readonly numbered?: boolean;
  /** `absent`: no gate; `gate`: QUOKY_SUMMARY_CONSENT=on only; `items`: both switches on (QUOKY_ITEM_SUMMARY_CONSENT=on). */
  readonly consent?: 'absent' | 'gate' | 'items';
  readonly selected?: ProviderName;
  readonly expectedKey?: string;
  /** Adds a kill-switch path (`에이전트 중지`) through the agent switch. */
  readonly stop?: boolean;
  /** Adds a handler that answers `선택한 지라 조회` through the real lookup handler's `handleSelected` (the NL-selection outcome). */
  readonly selectionProbe?: boolean;
  /** OQ1-5: the consent classifier switch (default off). */
  readonly classifier?: ConsentClassifierSwitch;
}

export function harness(opts: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const events: string[] = [];
  const executed: { provider: string; request: AiRequest }[] = [];
  const recordAssistant: string[] = [];
  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const runs: { kind: 'complete' | 'fail'; summary?: string }[] = [];
  const counts = { select: 0, expected: 0, queries: 0, handleSelected: 0 };
  /** The message each `handleSelected` call saw (review round 1: the re-run keeps the asking message's marks). */
  const selectedMessages: InboundMessage[] = [];
  const state = {
    selected: opts.selected ?? 'remote',
    expectedKey: 'expectedKey' in opts ? opts.expectedKey : 'fake-remote',
    items: [item('A-1'), item('A-2')],
    /** OQ1-5: the next recordAssistant of a question waits for this (a stop racing the question's history write); `assistantEntered` runs when it starts waiting. */
    assistantGate: undefined as Promise<void> | undefined,
    assistantEntered: undefined as (() => void) | undefined,
    actorFor: undefined as ((context: ConversationContext) => Actor) | undefined,
    selectGate: undefined as Promise<void> | undefined,
    selectEntered: undefined as (() => void) | undefined,
  };
  const hooks: { onQuery?: (n: number) => void; afterSelect?: (n: number) => void } = {};

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

  const jira: ConnectorProvider = {
    source: 'jira',
    readOnly: true,
    async isAvailable() {
      return true;
    },
    async query() {
      counts.queries += 1;
      hooks.onQuery?.(counts.queries);
      return { source: 'jira', items: state.items };
    },
  };
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, ...(fields !== undefined ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ level: 'warn', message, ...(fields !== undefined ? { fields } : {}) }),
    error: (message, fields) => logs.push({ level: 'error', message, ...(fields !== undefined ? { fields } : {}) }),
  };
  const desk = new WorkChatService(
    { workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) }, connectors: { list: () => [jira] }, work: {} as WorkChatServiceDeps['work'] },
    { summaryEnabled: true, ...(opts.numbered === true ? { numberedLists: true } : {}) },
  );
  const [todoHandler, lookupHandler] = createWorkChatTurnHandlers({ desk, summaryEnabled: true, logger });
  const realSelected = lookupHandler.handleSelected.bind(lookupHandler);
  lookupHandler.handleSelected = async (selected, ctx) => {
    counts.handleSelected += 1;
    selectedMessages.push(ctx.message);
    return realSelected(selected, ctx);
  };
  const SELECTED: NlSelectedCommand = { entryId: 'jira.issues', args: {}, language: 'ko' };
  const selectionProbe: ConversationTurnHandler = {
    id: 'selection-probe',
    stage: 'pre-classify',
    order: 1,
    async handle(ctx) {
      if (ctx.message.text === '선택한 지라 개수') return lookupHandler.handleSelected({ ...SELECTED, args: { count: true } }, ctx);
      return ctx.message.text === '선택한 지라 조회' ? lookupHandler.handleSelected(SELECTED, ctx) : null;
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
      events.push('execute');
      executed.push({ provider: id, request });
      executeCount += 1;
      return { text: SUMMARY, artifacts: [], usage: { label: 'fake-usage', inputTokens: 7, outputTokens: 3 } };
    },
  });
  const providers: Record<ProviderName, AiProvider> = {
    remote: provider('fake-remote', 'REMOTE'),
    other: provider('fake-other', 'REMOTE'),
    local: provider('fake-local', 'LOCAL'),
    anon: provider('fake-anon', 'REMOTE'),
  };
  const labels: Record<string, string> = { 'fake-remote': 'Remote', 'fake-other': 'Other' };
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
  const bad = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  let taskSeq = 0;
  const router: ConversationRuntimeDeps['router'] = {
    async select() {
      const wait = state.selectGate;
      if (wait !== undefined) {
        state.selectGate = undefined;
        state.selectEntered?.();
        await wait;
      }
      counts.select += 1;
      const chosen = providers[state.selected];
      hooks.afterSelect?.(counts.select);
      return chosen;
    },
    expectedRecipientKey: () => {
      counts.expected += 1;
      return state.expectedKey;
    },
    isStillEligible: (_capability: Capability, _context: unknown, p: AiProvider) => {
      events.push('guard');
      return p === providers[state.selected];
    },
  };
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: {
      async commit() {
        events.push('commit');
        return {} as TaskRun;
      },
    } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext(context: ConversationContext) { return state.actorFor?.(context) ?? OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm(message: InboundMessage, sessionId?: string) {
        const n = shortTerm.length + 1;
        shortTerm.push({ id: `mem-${n}`, type: MemoryType.SHORT_TERM, scope: sessionId ? { sessionId } : {}, content: message.text, metadata: { role: 'user' }, createdAt: T0, updatedAt: T0 });
        return { id: `mem-${n}` };
      },
      async recordAssistant(text: string) {
        if (state.assistantGate !== undefined && text.includes('보낼까요')) {
          const wait = state.assistantGate;
          state.assistantGate = undefined;
          state.assistantEntered?.();
          await wait;
        }
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
      async completeRun() {
        runs.push({ kind: 'complete' });
        return undefined;
      },
      async failRun(_run, summary) {
        runs.push({ kind: 'fail', summary });
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
    turnHandlers: [...(opts.selectionProbe === true ? [selectionProbe] : []), todoHandler, lookupHandler],
    logger,
    ...(opts.stop === true
      ? {
          agentRuns: {
            mode: 'shadow',
            shadowAdmits: () => false,
            runShadow: bad('runShadow'),
            handleSwitchPhrase: async (_actor: Actor, text: string) => (text.trim() === '에이전트 중지' ? '멈춤(에이전트)' : undefined),
            switchSuffix: () => undefined,
          } as unknown as ConversationRuntimeDeps['agentRuns'],
        }
      : {}),
  };

  const consent = opts.consent ?? 'items';
  const clock = { now: 1_000_000 };
  const store = new ConsentPendingStore();
  const items = consent === 'items' ? new ItemSummaryConsent({ store, now: () => clock.now, logger, recipientLabel }) : undefined;
  const gate =
    consent === 'absent'
      ? undefined
      : new ConsentTurnGate({
          store,
          classifier: opts.classifier ?? { mode: 'off' },
          chargeModelCall: () => true,
          continueSummary: async () => ({ kind: 'reply', reply: { text: 'AGENT CONTINUATION' } }),
          ...(items !== undefined ? { items } : {}),
          now: () => clock.now,
          logger,
        });
  const runtime = new ConversationRuntime(deps, { clock: () => T0, ...(gate !== undefined ? { consentTurnGate: gate } : {}) });
  let seq = 0;
  const send = (text: string, context: ConversationContext = DM, marks: Pick<InboundMessage, 'quotedRanges' | 'formatting'> = {}) =>
    runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0, ...marks } satisfies InboundMessage);
  return { sessions, send, state, hooks, events, executed, recordAssistant, logs, runs, counts, items, store, gate, clock, labels, lookupHandler, selectedMessages };
}

export type Harness = ReturnType<typeof harness>;
export const view = (result: { readonly status: string; readonly reply: OutboundMessage }) => ({ status: result.status, reply: result.reply });

export const noContentInLogs = (h: Harness) => {
  const text = JSON.stringify(h.logs);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(SUMMARY);
  expect(text).not.toContain(ASK);
  expect(text).not.toContain('jira:A-');
};

/** The listing the D8 lookup shows for these items (the summary-off desk renders the same deterministic list). */
export async function listingOf(items: readonly ConnectorItem[]): Promise<string> {
  const desk = new WorkChatService(
    {
      workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) },
      connectors: { list: () => [{ source: 'jira', readOnly: true, isAvailable: async () => true, query: async () => ({ source: 'jira', items: [...items] }) }] },
      work: {} as WorkChatServiceDeps['work'],
    },
    { summaryEnabled: false },
  );
  const out = await desk.handle({ kind: 'lookup', source: 'jira', query: 'my-items' }, OWNER);
  return out.kind === 'reply' ? out.text : '';
}

