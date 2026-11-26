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

/**
 * ADR-0121 amendment A8, slice OQ1-2: the egress guard, the recipient line and the ask for an unexpected recipient, through the
 * REAL ConversationRuntime, the real mail and Drive handlers, PromptComposer and PromptRenderer (Jira and the D8 lookup through
 * fixed handlers that return what the real ones return). Only storage, the readers, the providers, the router and Task bookkeeping
 * are fakes. The router answers like the composition root: `select`, the dispatch-time `isStillEligible` and the data-only
 * `expectedRecipientKey`.
 */

export const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
export const CHANNEL: ConversationContext = { platform: 'test', spaceId: 'g-1', channelId: 'chan-1', userId: 'owner-user', direct: false };
export const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
export const T0 = '2026-11-26T01:00:00.000Z';
/** In every item: it must never reach a log line. */
export const CANARY = ['zq', 'canary', 'vxw'].join('');
export const SUMMARY = '요약 본문이에요.';
export const ATTRIBUTED = "메일에서 보낸이는 '견적서를 보냈다'고 적었어요.";
export const CLAIM = '김철수 님께 견적서 전달 완료.';
export const LINE = '· Remote로 요약';

export type ProviderName = 'remote' | 'other' | 'local' | 'anon';

export interface HarnessOptions {
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
  /** Only the Nth execute call throws (1-based); earlier calls return normally with reported usage. */
  readonly failOnCall?: number;
  /** Adds a recording `runtimeProviderRouting` seam (the GENERAL_CHAT routed branch). */
  readonly routing?: boolean;
  /** The consent classifier switch (default off: only closed tokens answer). */
  readonly classifier?: ConsentClassifierSwitch;
  /** OQ1-3: an A6 selection service slot with the R2 level and the kill switch (mode `off`: it selects nothing). */
  readonly nl?: { readonly level: NlActionLevel; readonly itemR2: NlItemR2Level; readonly acting: boolean };
  /** OQ1-3 review round 1: which kill-switch path handles `에이전트 중지` (its save waits for `state.stopSave`). */
  readonly stopPath?: 'nlSelection' | 'agent' | 'surface';
  /** OQ1-5: an ACTIVE fake NL selector (deterministic): `decide` answers each selected turn's text; `calls` counts the selector calls. */
  readonly nlDecide?: (text: string) => unknown;
  /** OQ1-5: the selector reports an open selection question for the turn (another owner step pending, W2). */
  readonly nlPending?: boolean;
}

export function harness(opts: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const events: string[] = [];
  const executed: { provider: string; request: AiRequest }[] = [];
  const recordAssistant: string[] = [];
  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const runs: { kind: 'complete' | 'fail'; summary?: string; metadata?: unknown; usage?: unknown }[] = [];
  const counts = { select: 0, eligible: 0, expected: 0 };
  const state = {
    selected: opts.selected ?? 'remote',
    expectedKey: 'expectedKey' in opts ? opts.expectedKey : 'fake-remote',
    eligible: true,
    microtaskRan: false,
    /** OQ1-3: the mail thread's message count, the read failing, the Jira item id the probe re-reads, the kill switch. */
    threadTotal: 2,
    failRead: false,
    jiraItem: 'A-1',
    acting: opts.nl?.acting ?? false,
    /** OQ1-5: the actor a conversation resolves to (default the owner). */
    /** OQ1-5: the next recordAssistant of a question waits for this (a stop racing the question's history write); `assistantEntered` runs when it starts waiting. */
    assistantGate: undefined as Promise<void> | undefined,
    assistantEntered: undefined as (() => void) | undefined,
    actorFor: undefined as ((context: ConversationContext) => Actor) | undefined,
    /** OQ1-3 review round 1: the re-read waits for this (a race window between the take and hook 1). */
    readGate: undefined as Promise<void> | undefined,
    /** OQ1-3 review round 1: the kill-switch save waits for this; `stopEntered` runs when the save starts. */
    stopSave: undefined as Promise<void> | undefined,
    stopEntered: undefined as (() => void) | undefined,
    /** OQ1-3 review round 1 (CA P3): the Jira outcome's participants read throws (after the call, while the reply is built). */
    throwParticipants: false,
    /** OQ1-3 review round 2: the next provider resolve waits for this (one-shot); `selectEntered` runs when it starts waiting. */
    selectGate: undefined as Promise<void> | undefined,
    selectEntered: undefined as (() => void) | undefined,
  };
  /** Called at the named points (tests flip the selection there). */
  const hooks: { onCommit?: () => void; onExecute?: (n: number) => void; afterSelect?: (n: number) => void; onRead?: () => void } = {};
  const nlCalls = { decide: 0, receipts: 0, takePending: 0 };

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
      hooks.onRead?.();
      if (state.readGate !== undefined) await state.readGate;
      if (state.failRead) throw new Error('read failed');
      return { ...mailSummary, bodyText: `짧은 메일이에요 ${CANARY}.`, bodyTruncated: false };
    },
    async getThread() {
      hooks.onRead?.();
      if (state.failRead) throw new Error('read failed');
      return {
        messages: Array.from({ length: state.threadTotal }, (_, index) => ({ ...mailSummary, id: `msg-${index}`, sender: { name: `보낸이${index}`, address: `p${index}@example.com` }, bodyText: `스레드 ${index} ${CANARY}`, bodyTruncated: false })),
        totalMessages: state.threadTotal,
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
      if (opts.failExecute === true || opts.failOnCall === executeCount) throw new Error('provider down');
      const list = opts.summaries ?? [SUMMARY];
      return { text: list[Math.min(executeCount - 1, list.length - 1)] ?? SUMMARY, artifacts: [], usage: { label: 'fake-usage', inputTokens: 7, outputTokens: 3 } };
    },
  });
  const providers: Record<ProviderName, AiProvider> = {
    remote: provider('fake-remote', 'REMOTE'),
    other: provider('fake-other', 'REMOTE'),
    local: provider('fake-local', 'LOCAL'),
    anon: provider('fake-anon', 'REMOTE'),
  };
  /** Mutable: a test renames a recipient (same key, another label). */
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
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, ...(fields !== undefined ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ level: 'warn', message, ...(fields !== undefined ? { fields } : {}) }),
    error: (message, fields) => logs.push({ level: 'error', message, ...(fields !== undefined ? { fields } : {}) }),
  };

  // Jira (A6 R2 single item) and the D8 lookup: fixed handlers returning what the real ones return for these phrases.
  const jira = buildUntrustedDocumentReadout({ source: 'jira-issue', title: `이슈 ${CANARY}`, author: 'Reporter', date: '2026-11-25T00:30:00.000Z', body: `이슈 본문 ${CANARY}` });
  if (!jira.ok) throw new Error('fixture');
  const jiraOutcome = (consent: boolean, itemId = 'A-1'): TurnHandlerOutcome => {
    const outcome: TurnHandlerOutcome = {
      kind: 'summarize',
      readout: jira.readout,
      fallbackText: 'JIRA FALLBACK',
      footer: 'JIRA FOOTER',
      history: { assistant: 'JIRA NOTE' },
      nlAction: { entryId: 'item.summarize', result: 'executed', source: 'jira', itemId },
      ...(consent ? { consent: itemSummaryConsentDescriptor({ handlerId: 'jira-probe', source: 'jira', itemId, language: 'ko' }) } : {}),
    };
    // CA P3: a participants read that throws only once the test arms it (after the summary call), never before.
    Object.defineProperty(outcome, 'participants', {
      enumerable: false,
      get: () => {
        if (state.throwParticipants) throw new Error('participants failed');
        return undefined;
      },
    });
    return outcome;
  };
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
    catalog: [nlActionEntry('item.summarize')],
    // OQ1-3: the re-read of the confirmed Jira item (the real handler reads it again by the selection's id).
    async handleSelected(selected) {
      if (selected.entryId !== 'item.summarize' || selected.target?.source !== 'jira') return null;
      hooks.onRead?.();
      return jiraOutcome(true, state.jiraItem);
    },
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
  /** The kill-switch save: signals its start, then waits for the test to release it. */
  const stopSave = async (reply: string): Promise<string> => {
    state.stopEntered?.();
    if (state.stopSave !== undefined) await state.stopSave;
    return reply;
  };
  const router: ConversationRuntimeDeps['router'] = {
    async select() {
      const wait = state.selectGate;
      if (wait !== undefined) {
        state.selectGate = undefined;
        state.selectEntered?.();
        await wait;
      }
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
      async completeRun(_run, o) {
        runs.push({ kind: 'complete', metadata: o.metadata });
        return undefined;
      },
      async failRun(_run, summary, o: { metadata?: unknown; usage?: unknown }) {
        runs.push({ kind: 'fail', summary, metadata: o.metadata, ...(o.usage ? { usage: o.usage } : {}) });
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
    ...(opts.nl !== undefined
      ? {
          nlSelection: {
            mode: 'off',
            decide: async () => {
              nlCalls.decide += 1;
              throw new Error('the continuation never selects');
            },
            actionLevel: () => opts.nl!.level,
            itemR2Level: () => opts.nl!.itemR2,
            actionsStillActing: async () => state.acting,
            recordActionReceipt: async () => {
              nlCalls.receipts += 1;
            },
          } as unknown as ConversationRuntimeDeps['nlSelection'],
        }
      : {}),
    ...(opts.nlDecide !== undefined
      ? {
          nlSelection: {
            mode: 'active',
            decide: async (input: { text: string }) => {
              nlCalls.decide += 1;
              return opts.nlDecide!(input.text);
            },
            actionsActing: () => false,
            actionsOffered: () => false,
            takePending: async () => {
              nlCalls.takePending += 1;
              return opts.nlPending === true ? { kind: 'entry' } : undefined;
            },
            recordActionReceipt: async () => {
              nlCalls.receipts += 1;
            },
          } as unknown as ConversationRuntimeDeps['nlSelection'],
        }
      : {}),
    ...(opts.stopPath === 'nlSelection'
      ? { nlSelection: { mode: 'off', handleSwitchPhrase: async (_actor: Actor, text: string) => (text.trim() === '에이전트 중지' ? stopSave('멈춤(선택)') : undefined) } as unknown as ConversationRuntimeDeps['nlSelection'] }
      : {}),
    ...(opts.stopPath === 'agent'
      ? {
          agentRuns: {
            mode: 'shadow',
            shadowAdmits: () => false,
            runShadow: bad('runShadow'),
            handleSwitchPhrase: async (_actor: Actor, text: string) => (text.trim() === '에이전트 중지' ? stopSave('멈춤(에이전트)') : undefined),
            switchSuffix: () => undefined,
          } as unknown as ConversationRuntimeDeps['agentRuns'],
        }
      : {}),
    ...(opts.stopPath === 'surface'
      ? {
          surfaceGrants: {
            gate: { enforced: true },
            service: {
              handleSwitchPhrase: async (_actor: Actor, message: InboundMessage) => (message.text.trim() === '에이전트 중지' ? stopSave('멈춤(채널)') : undefined),
              handlePhrase: async () => undefined,
            },
          } as unknown as ConversationRuntimeDeps['surfaceGrants'],
        }
      : {}),
    ...(opts.routing === true ? { runtimeProviderRouting: { execute: async () => { events.push('routed-execute'); throw new Error('routed seam must not run'); } } as unknown as ConversationRuntimeDeps['runtimeProviderRouting'] } : {}),
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
          classifier: opts.classifier ?? { mode: 'off' },
          chargeModelCall: () => true,
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
  const send = (text: string, context: ConversationContext = DM, marks: Pick<InboundMessage, 'quotedRanges' | 'formatting'> = {}) =>
    runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0, ...marks } satisfies InboundMessage);
  return { runtime, sessions, send, nlCalls, state, hooks, events, executed, recordAssistant, logs, runs, counts, continued, items, store, gate, clock, labels };
}

export type Harness = ReturnType<typeof harness>;
export const view = (result: { readonly status: string; readonly reply: OutboundMessage }) => ({ status: result.status, reply: result.reply });

/** P1–P7 as the owner sends them (P3/P5, the NL `item.summarize` selection, reaches the same summarize outcome as P1/P4). */
export const PATHS: readonly { readonly name: string; readonly list?: string; readonly ask: string }[] = [
  { name: 'P1 mail item', list: '안 읽은 메일', ask: '1번 메일 요약해줘' },
  { name: 'P2 mail thread', list: '안 읽은 메일', ask: '1번 메일 스레드 요약해줘' },
  { name: 'P4 Drive file', list: '최근 문서', ask: '1번 문서 요약해줘' },
  { name: 'P6 Jira item', ask: '지라 이슈 요약' },
  { name: 'P7 D8 lookup', ask: '내 지라 일 요약' },
];

export async function runPath(h: Harness, path: (typeof PATHS)[number], context: ConversationContext = DM) {
  if (path.list !== undefined) await h.send(path.list, context);
  return h.send(path.ask, context);
}

export const noContentInLogs = (h: Harness) => {
  const text = JSON.stringify(h.logs);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(SUMMARY);
  expect(text).not.toContain('요약해줘');
};
