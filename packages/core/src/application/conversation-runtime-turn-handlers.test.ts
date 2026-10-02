import { describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  IntentType,
  MemoryType,
  RiskLevel,
  SessionStatus,
  TaskStatus,
} from '../domain';
import type {
  Actor,
  ApprovalRequest,
  ConversationContext,
  InboundMessage,
  Intent,
  IsoTimestamp,
  Project,
  Session,
  Task,
  TaskRun,
  WorkspaceRef,
} from '../domain';
import type {
  AiProvider,
  AiRequest,
  ConversationTurnHandler,
  Logger,
  StorageProvider,
  TurnHandlerContext,
  TurnHandlerReply,
  TurnHandlerStage,
} from '../ports';
import { ApprovalManager } from './approval-manager';
import type { ApprovalPolicy } from './approval-policy';
import { PENDING_APPROVAL_TTL_MS } from './conversation-commands';
import {
  ConversationRuntime,
  type ApplyPreviewAnchor,
  type ApplyPreviewFlow,
  type ConversationRuntimeDeps,
} from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import type { MemoryWriter } from './memory-writer';
import { MAX_CONTRIBUTED_HELP_LINES, ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';

// ADR-0096 deterministic turn-handler registry, driven through the real ConversationRuntime. Pins the three
// dispatch points relative to pending approvals / scope clarification / anchors / control turns, the registry
// ordering, null fall-through, and that a handler reply never reaches a provider or creates a Task.

const CTX: ConversationContext = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-10-02T09:00:00.000Z';
const at = (offsetMs: number): IsoTimestamp => new Date(Date.parse(T0) + offsetMs).toISOString();
const MINUTE = 60_000;
const MAY_HAVE_APPLIED = '변경 적용 여부를 확인할 수 없어요';
const WORKSPACE: WorkspaceRef = { id: 'ws-active', rootPath: '/active', kind: 'local-clone' } as WorkspaceRef;

const composer = new ResponseComposer();

const bad = (name: string) => () => {
  throw new Error(`${name} must not be called`);
};

/** A probe handler: logs `stage:id` on every invocation and replies with `respond(ctx)` (default: null). */
interface Probe {
  readonly handler: ConversationTurnHandler;
  readonly seen: TurnHandlerContext[];
}

function probe(
  log: string[],
  id: string,
  stage: TurnHandlerStage,
  order = 100,
  respond: (ctx: TurnHandlerContext) => TurnHandlerReply | null | Promise<TurnHandlerReply | null> = () => null,
  helpLines?: readonly string[],
): Probe {
  const seen: TurnHandlerContext[] = [];
  return {
    seen,
    handler: {
      id,
      stage,
      order,
      ...(helpLines ? { helpLines } : {}),
      async handle(ctx) {
        log.push(`${stage}:${id}`);
        seen.push(ctx);
        return respond(ctx);
      },
    },
  };
}

const replyText = (text: string) => (ctx: TurnHandlerContext): TurnHandlerReply => ({
  reply: { context: ctx.message.context, text },
});

interface HarnessOptions {
  turnHandlers?: readonly ConversationTurnHandler[];
  /** Leave `turnHandlers` out of the deps entirely (the pre-ADR-0096 shape). */
  omitTurnHandlers?: boolean;
  log?: string[];
  pendingApproval?: boolean;
  applyAnchor?: ApplyPreviewAnchor;
  pendingScope?: boolean;
  activeProjectId?: string;
  workspaceOpenThrows?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const log = opts.log ?? [];
  let clockNow: IsoTimestamp = T0;
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, ApprovalRequest>();
  const tasks = new Map<string, Task>();
  const calls = {
    recordShortTerm: 0,
    recordAssistant: 0,
    classify: 0,
    routerSelect: 0,
    providerExecute: 0,
    createTask: 0,
    startRun: 0,
    requestForRisk: 0,
    memoryPromote: 0,
    workspaceOpen: 0,
  };

  const storage = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, { ...s });
        return s;
      },
      async get(id: string) {
        return sessions.get(id) ?? null;
      },
      async findActiveByContext(channelId: string, threadId?: string) {
        const active = [...sessions.values()]
          .filter((s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId)
          .filter((s) => s.context.threadId === threadId)
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
        return active[0] ?? null;
      },
    },
    approvals: {
      async save(a: ApprovalRequest) {
        approvals.set(a.id, { ...a });
        return a;
      },
      async get(id: string) {
        return approvals.get(id) ?? null;
      },
      async findByExecutionPlan(planId: string) {
        return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId);
      },
    },
    tasks: {
      async get(id: string) {
        return tasks.get(id) ?? null;
      },
      async save(t: Task) {
        tasks.set(t.id, t);
        return t;
      },
    },
  };
  const sessionManager = new SessionManager(storage as unknown as StorageProvider);
  const approvalManager = new ApprovalManager(storage as unknown as StorageProvider, {} as ApprovalPolicy);
  const approvalFlow = new StatelessApprovalFlow(storage);

  const seeded: Session = {
    id: 'sess-seeded',
    actorId: OWNER.id,
    context: CTX,
    status: SessionStatus.ACTIVE,
    createdAt: T0,
    lastActivityAt: T0,
    ...(opts.activeProjectId ? { activeProjectId: opts.activeProjectId } : {}),
  };
  const pendingRequest: ApprovalRequest = {
    id: 'appr-1',
    executionPlanRef: { kind: 'ExecutionPlan', id: 'plan-1' } as ApprovalRequest['executionPlanRef'],
    status: ApprovalStatus.PENDING,
    riskLevel: RiskLevel.HIGH,
    reason: 'Change packages/core/src/foo.ts',
    requestedBy: OWNER.id,
    createdAt: T0,
    updatedAt: T0,
  };
  if (opts.pendingApproval) {
    tasks.set('task-1', {
      id: 'task-1',
      title: 'fix foo',
      description: 'fix foo',
      status: TaskStatus.WAITING_APPROVAL,
      intent: { type: IntentType.IMPLEMENT_CODE, capability: Capability.CODE_IMPLEMENTATION, confidence: 1, requiresWork: true, summary: 'fix foo' },
      riskLevel: RiskLevel.HIGH,
      context: CTX,
      planId: 'plan-1',
      createdAt: T0,
      updatedAt: T0,
    });
    approvals.set(pendingRequest.id, pendingRequest);
    seeded.activeTaskId = 'task-1';
  }
  if (opts.applyAnchor) {
    approvals.set('apply-appr-1', { ...pendingRequest, id: 'apply-appr-1', reason: 'Commit packages/core/src/foo.ts' });
  }
  sessions.set(seeded.id, seeded);

  let currentAnchor: ApplyPreviewAnchor | null = opts.applyAnchor ?? null;
  let scopePending = Boolean(opts.pendingScope);
  const applyPreviewFlow: ApplyPreviewFlow = {
    async findAnchor() {
      return currentAnchor;
    },
    async anchor(_s, anchor) {
      currentAnchor = anchor;
    },
    async clear() {
      currentAnchor = null;
    },
  };

  const provider: AiProvider = {
    id: 'fake-provider',
    capabilities: [],
    async isAvailable() {
      return true;
    },
    async execute(_request: AiRequest) {
      calls.providerExecute++;
      return { text: '안녕하세요!', artifacts: [] };
    },
  };

  const memoryWriter: MemoryWriter = {
    createCandidate(input) {
      return { ...input, validationState: 'PENDING', metadata: Object.freeze(input.metadata ?? {}) };
    },
    async promote(candidate) {
      calls.memoryPromote++;
      log.push('memory.promote');
      return {
        outcome: 'PROMOTED',
        memory: {
          id: 'durable-1',
          content: candidate.content,
          memoryType: MemoryType.LONG_TERM,
          kind: candidate.kind,
          provenance: candidate.provenance,
          authorityLevel: candidate.authorityLevel,
          scope: candidate.scope,
          createdAt: T0,
          updatedAt: T0,
          metadata: candidate.metadata,
        },
        policyReason: 'accepted',
      };
    },
    forget: bad('memoryWriter.forget') as unknown as MemoryWriter['forget'],
  };

  const project: Project = { id: 'proj-1', name: 'demo', rootPath: '/active' } as Project;
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm() {
        calls.recordShortTerm++;
        log.push('memory.recordShortTerm');
        return { id: 'mem-user' };
      },
      async recordAssistant() {
        calls.recordAssistant++;
        return undefined;
      },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        calls.classify++;
        log.push('classifier.classify');
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' };
      },
    },
    projects: {
      register: bad('projects.register'),
      get: async (id: string) => (id === project.id ? project : null),
    } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      async createTask() {
        calls.createTask++;
        throw new Error('createTask must not be called');
      },
      async transition(task, to) { return { ...task, status: to }; },
      async startRun() {
        calls.startRun++;
        throw new Error('startRun must not be called');
      },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: {
      prepare: async () => undefined,
      async open(p) {
        calls.workspaceOpen++;
        if (opts.workspaceOpenThrows) throw new Error('open failed');
        return { ...WORKSPACE, projectId: p.id, rootPath: p.rootPath };
      },
      list: bad('workspace.list'),
      diff: bad('workspace.diff'),
      read: bad('workspace.read'),
    },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: bad('contextBuilder.build') },
    promptComposer: { compose: bad('promptComposer.compose') },
    promptRenderer: { render: bad('promptRenderer.render') },
    router: {
      async select() {
        calls.routerSelect++;
        return provider;
      },
    },
    artifacts: { async persistAll() { return []; } },
    composer,
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: {
      decide: (id, d) => approvalManager.decide(id, d),
      get: (id) => approvalManager.get(id),
      async requestForRisk() {
        calls.requestForRisk++;
        throw new Error('requestForRisk must not be called');
      },
    },
    approvalFlow,
    scopeClarificationFlow: {
      async findPending() {
        return scopePending ? { kind: 'code-scope-clarification' as const, summary: 'fix foo', createdAt: T0 } : null;
      },
      anchor: bad('scope.anchor'),
      async clear() {
        scopePending = false;
      },
    },
    applyPreviewFlow,
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('codeGeneration.getProposal') },
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
    ...(opts.omitTurnHandlers ? {} : { turnHandlers: opts.turnHandlers ?? [] }),
    logger,
  };

  const runtime = new ConversationRuntime(deps, { clock: () => clockNow });
  let seq = 0;
  const send = (text: string) =>
    runtime.handle({ id: `msg-${++seq}`, context: CTX, text, receivedAt: clockNow } satisfies InboundMessage);

  return {
    send,
    calls,
    log,
    approvals,
    approvalFlow,
    setClock(ts: IsoTimestamp) {
      clockNow = ts;
    },
    currentAnchor: () => currentAnchor,
    seededSession: () => sessions.get('sess-seeded')!,
  };
}

const anchorOf = (over: Partial<ApplyPreviewAnchor>): ApplyPreviewAnchor => ({
  kind: 'code-preview-apply',
  status: 'WORKSPACE_APPLIED',
  executionPlanRef: { kind: 'ExecutionPlan', id: 'plan-1' } as ApplyPreviewAnchor['executionPlanRef'],
  workspaceRef: { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' } as ApplyPreviewAnchor['workspaceRef'],
  targetFiles: ['packages/core/src/foo.ts'],
  codeGenerationRef: { kind: 'CodeGeneration', id: 'gen-1' } as ApplyPreviewAnchor['codeGenerationRef'],
  codeProposalRef: { kind: 'CodeProposal', id: 'prop-1' } as ApplyPreviewAnchor['codeProposalRef'],
  instruction: 'fix foo',
  projectId: 'proj-1',
  createdAt: T0,
  approvalId: 'apply-approval-earlier',
  workspaceChangeRef: { kind: 'WorkspaceChange', id: 'wc-1' } as ApplyPreviewAnchor['workspaceChangeRef'],
  ...over,
});
const commitPendingAnchor = (): ApplyPreviewAnchor =>
  anchorOf({
    status: 'COMMIT_APPROVAL_PENDING',
    commitApprovalId: 'apply-appr-1',
    proposedCommitMessage: 'chore: update foo',
    commitCandidateFiles: ['packages/core/src/foo.ts'],
  });

/** One always-responding probe per stage, so a test can see which stage (if any) captured the turn. */
function everyStage(log: string[]) {
  const control = probe(log, 'ctl', 'control', 100, () => null);
  const post = probe(log, 'post', 'post-anchor', 100, replyText('POST-ANCHOR'));
  const pre = probe(log, 'pre', 'pre-classify', 100, replyText('PRE-CLASSIFY'));
  return { control, post, pre, handlers: [pre.handler, post.handler, control.handler] };
}

describe('ConversationRuntime turn handlers — registry (ADR-0096 D2)', () => {
  it('dispatches control → post-anchor → pre-classify, each stage by (order, id), around memory and classify', async () => {
    const log: string[] = [];
    const handlers = [
      probe(log, 'q-b', 'pre-classify', 300).handler,
      probe(log, 'p-a', 'post-anchor', 100).handler,
      probe(log, 'q-a', 'pre-classify', 100).handler,
      probe(log, 'c-z', 'control', 100).handler,
      probe(log, 'q-z', 'pre-classify', 200).handler,
      probe(log, 'q-y', 'pre-classify', 200).handler,
      probe(log, 'c-a', 'control', 100).handler,
      probe(log, 'c-n', 'control', -5).handler,
    ];
    const h = harness({ log, turnHandlers: handlers });
    const result = await h.send('오늘 날씨 어때?');
    expect(result.status).toBe('RESPONDED');
    expect(log).toEqual([
      'control:c-n',
      'control:c-a',
      'control:c-z',
      'memory.recordShortTerm',
      'post-anchor:p-a',
      'pre-classify:q-a',
      'pre-classify:q-y',
      'pre-classify:q-z',
      'pre-classify:q-b',
      'classifier.classify',
    ]);
  });

  it('rejects a duplicate handler id at construction, across stages too', () => {
    const log: string[] = [];
    expect(() =>
      harness({ turnHandlers: [probe(log, 'dup', 'control').handler, probe(log, 'dup', 'pre-classify', 200).handler] }),
    ).toThrow('duplicate conversation turn handler id: dup');
  });

  it('rejects an empty id, an unknown stage and a non-finite order at construction', () => {
    const log: string[] = [];
    const ok = probe(log, 'ok', 'control').handler;
    expect(() => harness({ turnHandlers: [{ ...ok, id: '' }] })).toThrow('non-empty');
    expect(() => harness({ turnHandlers: [{ ...ok, stage: 'late' as TurnHandlerStage }] })).toThrow('unknown stage');
    expect(() => harness({ turnHandlers: [{ ...ok, order: Number.NaN }] })).toThrow('non-finite order');
  });

  it('the first non-null reply wins; later handlers of the same stage and the classifier never run', async () => {
    const log: string[] = [];
    const first = probe(log, 'first', 'pre-classify', 100, replyText('FIRST'));
    const second = probe(log, 'second', 'pre-classify', 200, replyText('SECOND'));
    const h = harness({ log, turnHandlers: [second.handler, first.handler] });
    const result = await h.send('아무 말');
    expect(result.reply.text).toBe('FIRST');
    expect(second.seen).toHaveLength(0);
    expect(h.calls.classify).toBe(0);
  });
});

describe('ConversationRuntime turn handlers — empty registry and null fall-through are behaviour-identical', () => {
  const scenarios: Array<[string, HarnessOptions, string]> = [
    ['plain chat', {}, '오늘 날씨 어때?'],
    ['help', {}, '도움말'],
    ['reset', {}, '새 대화'],
    ['stray decision (QA-018)', {}, '승인'],
    ['durable memory', {}, '기억해: 나는 민트초코를 좋아해'],
    ['pending approval reminder', { pendingApproval: true }, '음 글쎄'],
    ['anchor-scoped pending approval', { applyAnchor: commitPendingAnchor() }, '음 글쎄'],
    ['scope clarification cancel', { pendingScope: true }, '취소'],
    ['WORKSPACE_APPLIED git-mutating reject', { applyAnchor: anchorOf({}) }, '브랜치 만들어줘'],
    ['ADR-0043 deny fragment', { applyAnchor: anchorOf({}) }, '테스트 돌려줘 rm -rf /'],
  ];

  it.each(scenarios)('%s: omitted, empty and all-null registries give the same turn', async (_name, opts, text) => {
    const omitted = harness({ ...opts, omitTurnHandlers: true });
    const empty = harness({ ...opts, turnHandlers: [] });
    const nullLog: string[] = [];
    const allNull = harness({
      ...opts,
      log: nullLog,
      turnHandlers: [
        probe(nullLog, 'n-ctl', 'control').handler,
        probe(nullLog, 'n-post', 'post-anchor').handler,
        probe(nullLog, 'n-pre', 'pre-classify').handler,
      ],
    });
    const base = await omitted.send(text);
    for (const h of [empty, allNull]) {
      const result = await h.send(text);
      expect(result).toEqual(base);
      expect(h.calls).toEqual(omitted.calls);
      expect(h.currentAnchor()).toEqual(omitted.currentAnchor());
      expect([...h.approvals.values()]).toEqual([...omitted.approvals.values()]);
    }
  });

  it('with no contributed help lines the help reply is the fixed base text', async () => {
    const h = harness({ turnHandlers: [] });
    expect((await h.send('도움말')).reply.text).toBe(composer.composeHelp(CTX).text);
  });
});

describe('ConversationRuntime turn handlers — never pre-empt pending-approval capture (ADR-0096 D3)', () => {
  it('a plan-scoped pending approval captures the turn before post-anchor and pre-classify', async () => {
    const log: string[] = [];
    const stages = everyStage(log);
    const h = harness({ log, pendingApproval: true, turnHandlers: stages.handlers });
    h.setClock(at(5 * MINUTE));
    const result = await h.send('음 글쎄');
    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).not.toMatch(/POST-ANCHOR|PRE-CLASSIFY/);
    expect(stages.post.seen).toHaveLength(0);
    expect(stages.pre.seen).toHaveLength(0);
    expect(stages.control.seen).toHaveLength(1); // control runs in every state
    expect(h.approvals.get('appr-1')!.status).toBe(ApprovalStatus.PENDING);
  });

  it('a decision phrase on an anchor-scoped pending approval is never offered to post-anchor / pre-classify handlers', async () => {
    const log: string[] = [];
    const stages = everyStage(log);
    const h = harness({ log, applyAnchor: commitPendingAnchor(), turnHandlers: stages.handlers });
    h.setClock(at(5 * MINUTE));
    await h.send('거절');
    expect(stages.post.seen).toHaveLength(0);
    expect(stages.pre.seen).toHaveLength(0);
    expect(h.approvals.get('apply-appr-1')!.status).toBe(ApprovalStatus.REJECTED);
  });

  it.each([
    ['AWAITING_APPROVAL', { approvalId: 'apply-appr-1' }],
    ['COMMIT_APPROVAL_PENDING', { commitApprovalId: 'apply-appr-1' }],
    ['PUSH_APPROVAL_PENDING', { pushApprovalId: 'apply-appr-1' }],
    ['PR_APPROVAL_PENDING', { prApprovalId: 'apply-appr-1' }],
    ['MERGE_APPROVAL_PENDING', { mergeApprovalId: 'apply-appr-1' }],
    ['REMOTE_BRANCH_CLEANUP_PENDING', { remoteBranchCleanupApprovalId: 'apply-appr-1' }],
  ] as const)('the %s anchor intercept captures the turn before post-anchor', async (status, ids) => {
    const log: string[] = [];
    const stages = everyStage(log);
    const h = harness({ log, applyAnchor: anchorOf({ status, ...ids }), turnHandlers: stages.handlers });
    h.setClock(at(5 * MINUTE));
    const result = await h.send('음 글쎄');
    expect(result.reply.text).not.toMatch(/POST-ANCHOR|PRE-CLASSIFY/);
    expect(stages.post.seen).toHaveLength(0);
    expect(stages.pre.seen).toHaveLength(0);
  });

  it('a pending scope clarification captures the turn before post-anchor', async () => {
    const log: string[] = [];
    const stages = everyStage(log);
    const h = harness({ log, pendingScope: true, turnHandlers: stages.handlers });
    const result = await h.send('취소');
    expect(result.status).toBe('CANCELLED');
    expect(stages.post.seen).toHaveLength(0);
    expect(stages.pre.seen).toHaveLength(0);
  });

  it('with nothing pending, the turn reaches post-anchor', async () => {
    const log: string[] = [];
    const stages = everyStage(log);
    const h = harness({ log, turnHandlers: stages.handlers });
    const result = await h.send('음 글쎄');
    expect(result.reply.text).toBe('POST-ANCHOR');
    expect(stages.pre.seen).toHaveLength(0);
  });
});

describe('ConversationRuntime turn handlers — control stage (ADR-0096 D3)', () => {
  it('runs while an approval is pending, records nothing, and leaves the approval PENDING', async () => {
    const log: string[] = [];
    const control = probe(log, 'feedback-summary', 'control', 100, replyText('CONTROL'));
    const h = harness({ log, pendingApproval: true, turnHandlers: [control.handler] });
    h.setClock(at(5 * MINUTE));
    const result = await h.send('피드백 요약');
    expect(result).toEqual({ status: 'RESPONDED', reply: { context: CTX, text: 'CONTROL' }, sessionId: 'sess-seeded' });
    expect(h.calls.recordShortTerm).toBe(0);
    expect(h.calls.recordAssistant).toBe(0);
    expect(h.calls.classify).toBe(0);
    expect(h.approvals.get('appr-1')!.status).toBe(ApprovalStatus.PENDING);
    expect(await h.approvalFlow.findPending(h.seededSession())).not.toBeNull();
  });

  it('help and reset still win over control handlers', async () => {
    const log: string[] = [];
    const control = probe(log, 'greedy', 'control', 100, replyText('CONTROL'));
    const h = harness({ log, turnHandlers: [control.handler] });
    expect((await h.send('도움말')).reply.text).toBe(composer.composeHelp(CTX).text);
    expect(control.seen).toHaveLength(0);
  });

  it('on an expired turn: expiry recorded by "system" and the expiry notice is prepended to the handler reply', async () => {
    const log: string[] = [];
    const control = probe(log, 'feedback-summary', 'control', 100, replyText('CONTROL'));
    const h = harness({ log, pendingApproval: true, turnHandlers: [control.handler] });
    h.setClock(at(45 * MINUTE));
    const result = await h.send('피드백 요약');
    const notice = composer.composeApprovalExpired(CTX, h.approvals.get('appr-1')!, PENDING_APPROVAL_TTL_MS).text;
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(`${notice}\n\nCONTROL`);
    expect(h.approvals.get('appr-1')!.decidedBy).toBe('system');
    expect(h.approvals.get('appr-1')!.comment).toBe('expired');
    expect(h.calls.recordShortTerm).toBe(0);
    expect(h.calls.recordAssistant).toBe(0);
  });

  it('after an anchor-scoped expiry the snapshot shows the released anchor state', async () => {
    const log: string[] = [];
    const control = probe(log, 'ctl', 'control', 100, replyText('CONTROL'));
    const h = harness({ log, applyAnchor: commitPendingAnchor(), turnHandlers: [control.handler] });
    h.setClock(at(40 * MINUTE));
    await h.send('피드백 요약');
    expect(control.seen[0]!.applyAnchor?.status).toBe('WORKSPACE_APPLIED');
    expect(h.currentAnchor()!.status).toBe('WORKSPACE_APPLIED');
  });

  it('an expired turn that no control handler answers keeps the plain expiry denial', async () => {
    const log: string[] = [];
    const control = probe(log, 'ctl', 'control');
    const h = harness({ log, pendingApproval: true, turnHandlers: [control.handler] });
    h.setClock(at(45 * MINUTE));
    const result = await h.send('피드백 요약');
    expect(result.status).toBe('DENIED');
    expect(control.seen).toHaveLength(1);
  });
});

describe('ConversationRuntime turn handlers — post-anchor and pre-classify positions (ADR-0096 D3)', () => {
  it('post-anchor runs before the WORKSPACE_APPLIED git-mutating-word reject', async () => {
    const log: string[] = [];
    const branch = probe(log, 'code-work-branch', 'post-anchor', 100, (ctx) =>
      /브랜치/u.test(ctx.message.text) ? replyText('BRANCH')(ctx) : null,
    );
    const h = harness({ log, applyAnchor: anchorOf({}), turnHandlers: [branch.handler] });
    const result = await h.send('브랜치 만들어줘');
    expect(result.reply.text).toBe('BRANCH');
    expect(branch.seen[0]!.applyAnchor?.status).toBe('WORKSPACE_APPLIED');

    const without = harness({ applyAnchor: anchorOf({}), turnHandlers: [] });
    expect((await without.send('브랜치 만들어줘')).reply.text).not.toBe('BRANCH');
  });

  it('post-anchor runs before the ADR-0043 deny-fragment check; null keeps the refusal', async () => {
    const log: string[] = [];
    const post = probe(log, 'post', 'post-anchor');
    const h = harness({ log, applyAnchor: anchorOf({}), turnHandlers: [post.handler] });
    const result = await h.send('테스트 돌려줘 rm -rf /');
    expect(post.seen).toHaveLength(1);
    expect(result.reply.text).toBe(composer.composePostApplyValidationUnsupported(CTX).text);
  });

  it('pre-classify runs after the QA-018 stray-decision reply and the 기억해: block', async () => {
    const log: string[] = [];
    const stages = everyStage(log);
    const nullPost = probe(log, 'post', 'post-anchor');
    const h = harness({ log, turnHandlers: [stages.control.handler, nullPost.handler, stages.pre.handler] });

    const stray = await h.send('승인');
    expect(stray.reply.text).toBe(composer.composeNoPendingDecision(CTX).text);
    const memory = await h.send('기억해: 나는 민트초코를 좋아해');
    expect(memory.reply.text).toBe(composer.composeMemoryStored(CTX).text);
    expect(stages.pre.seen).toHaveLength(0);
    expect(nullPost.seen).toHaveLength(2);
    expect(h.calls.memoryPromote).toBe(1);

    const chat = await h.send('오늘 할 일 알려줘');
    expect(chat.reply.text).toBe('PRE-CLASSIFY');
    expect(log.slice(-3)).toEqual(['memory.recordShortTerm', 'post-anchor:post', 'pre-classify:pre']);
    expect(h.calls.classify).toBe(0);
  });

  it.each(['post-anchor', 'pre-classify'] as const)(
    'a %s reply is recorded like a composed reply and reaches no provider, Task, TaskRun or approval',
    async (stage) => {
      const log: string[] = [];
      const handler = probe(log, 'h', stage, 100, replyText('HANDLED'));
      const h = harness({ log, turnHandlers: [handler.handler] });
      const result = await h.send('오늘 할 일 알려줘');
      expect(result).toEqual({ status: 'RESPONDED', reply: { context: CTX, text: 'HANDLED' }, sessionId: 'sess-seeded' });
      expect(h.calls.recordShortTerm).toBe(1);
      expect(h.calls.recordAssistant).toBe(1);
      expect(h.calls.classify).toBe(0);
      expect(h.calls.routerSelect).toBe(0);
      expect(h.calls.providerExecute).toBe(0);
      expect(h.calls.createTask).toBe(0);
      expect(h.calls.startRun).toBe(0);
      expect(h.calls.requestForRisk).toBe(0);
    },
  );

  it.each(['control', 'post-anchor', 'pre-classify'] as const)('a %s FAILED reply keeps its status', async (stage) => {
    const log: string[] = [];
    const handler = probe(log, 'h', stage, 100, (ctx) => ({ ...replyText('NOPE')(ctx), status: 'FAILED' }));
    const h = harness({ log, turnHandlers: [handler.handler] });
    const result = await h.send('오늘 할 일 알려줘');
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe('NOPE');
    expect(h.calls.providerExecute).toBe(0);
  });

  it('a leaked handler exception reaches the generic handle backstop', async () => {
    const log: string[] = [];
    const handler = probe(log, 'boom', 'pre-classify', 100, () => {
      throw new Error('handler bug');
    });
    const h = harness({ log, turnHandlers: [handler.handler] });
    const result = await h.send('오늘 할 일 알려줘');
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toContain(MAY_HAVE_APPLIED);
    expect(h.calls.classify).toBe(0);
  });
});

describe('ConversationRuntime turn handlers — context (ADR-0096 D1)', () => {
  it('passes the message, session, actor, the shared clock and a frozen anchor snapshot', async () => {
    const log: string[] = [];
    const post = probe(log, 'post', 'post-anchor');
    const h = harness({ log, applyAnchor: anchorOf({}), turnHandlers: [post.handler] });
    h.setClock(at(3 * MINUTE));
    await h.send('그냥 이야기');
    const ctx = post.seen[0]!;
    expect(ctx.message.text).toBe('그냥 이야기');
    expect(ctx.session.id).toBe('sess-seeded');
    expect(ctx.actor).toBe(OWNER);
    expect(ctx.now).toBe(at(3 * MINUTE));
    expect(ctx.applyAnchor).toEqual({
      status: 'WORKSPACE_APPLIED',
      workspaceRef: { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' },
      projectId: 'proj-1',
    });
    expect(Object.isFrozen(ctx.applyAnchor)).toBe(true);
    expect(Object.isFrozen(ctx.applyAnchor!.workspaceRef)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('applyAnchor is null without an anchor', async () => {
    const log: string[] = [];
    const pre = probe(log, 'pre', 'pre-classify');
    const h = harness({ log, turnHandlers: [pre.handler] });
    await h.send('그냥 이야기');
    expect(pre.seen[0]!.applyAnchor).toBeNull();
  });

  it('resolveActiveWorkspace is lazy and returns null without an active project or when opening fails', async () => {
    const run = async (opts: HarnessOptions) => {
      const log: string[] = [];
      let resolved: WorkspaceRef | null | undefined;
      const pre = probe(log, 'pre', 'pre-classify', 100, async (ctx) => {
        resolved = await ctx.resolveActiveWorkspace();
        return null;
      });
      const h = harness({ ...opts, log, turnHandlers: [pre.handler] });
      await h.send('그냥 이야기');
      return { resolved, opens: h.calls.workspaceOpen };
    };
    expect(await run({})).toEqual({ resolved: null, opens: 0 });
    expect(await run({ activeProjectId: 'proj-missing' })).toEqual({ resolved: null, opens: 0 });
    expect(await run({ activeProjectId: 'proj-1' })).toEqual({
      resolved: { ...WORKSPACE, projectId: 'proj-1', rootPath: '/active' },
      opens: 1,
    });
    expect(await run({ activeProjectId: 'proj-1', workspaceOpenThrows: true })).toEqual({ resolved: null, opens: 1 });

    const log: string[] = [];
    const lazy = probe(log, 'lazy', 'pre-classify');
    const h = harness({ log, activeProjectId: 'proj-1', turnHandlers: [lazy.handler] });
    await h.send('그냥 이야기');
    expect(h.calls.workspaceOpen).toBe(0);
  });
});

describe('ConversationRuntime turn handlers — contributed help lines (ADR-0096 D6)', () => {
  it('appends handler help lines in registry order, bounded by the composer', async () => {
    const log: string[] = [];
    const handlers = [
      probe(log, 'w-lookup', 'pre-classify', 300, undefined, ['- WORK LOOKUP']).handler,
      probe(log, 'fb', 'control', 100, undefined, ['- FEEDBACK']).handler,
      probe(log, 'rem', 'pre-classify', 200, undefined, ['- REMINDER A', '- REMINDER B']).handler,
      probe(log, 'branch', 'post-anchor', 100, undefined, ['- BRANCH']).handler,
      probe(log, 'silent', 'pre-classify', 100).handler,
    ];
    const h = harness({ log, turnHandlers: handlers });
    const expected = ['- FEEDBACK', '- BRANCH', '- REMINDER A', '- REMINDER B', '- WORK LOOKUP'];
    const result = await h.send('도움말');
    expect(result.reply.text).toBe(composer.composeHelp(CTX, expected).text);
    expect(result.reply.text).not.toBe(composer.composeHelp(CTX).text);
    expect(log).toEqual([]); // help never invokes a handler

    const many = probe(log, 'many', 'control', 100, undefined, Array.from({ length: 20 }, (_, i) => `- L${i}`));
    const bounded = await harness({ turnHandlers: [many.handler] }).send('도움말');
    const contributed = bounded.reply.text.split('\n').filter((line) => /^- L\d+$/u.test(line));
    expect(contributed).toHaveLength(MAX_CONTRIBUTED_HELP_LINES);
  });
});
