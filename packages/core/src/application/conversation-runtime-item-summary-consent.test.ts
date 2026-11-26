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
}

function harness(opts: HarnessOptions = {}) {
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
  const nlCalls = { decide: 0, receipts: 0 };

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
  const send = (text: string, context: ConversationContext = DM) => runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0 } satisfies InboundMessage);
  return { runtime, send, state, hooks, events, executed, recordAssistant, logs, runs, counts, continued, items, store, gate, clock, nlCalls, labels };
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
