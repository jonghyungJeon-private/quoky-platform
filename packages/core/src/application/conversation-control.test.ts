import { describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  IntentType,
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
  Session,
  Task,
  TaskRun,
} from '../domain';
import type { AiProvider, AiRequest, Logger, StorageProvider } from '../ports';
import { ApprovalManager } from './approval-manager';
import type { ApprovalPolicy } from './approval-policy';
import type { CapabilityRouter } from './capability-router';
import { PENDING_APPROVAL_TTL_MS } from './conversation-commands';
import {
  ConversationRuntime,
  type ApplyPreviewAnchor,
  type ApplyPreviewFlow,
  type ConversationRuntimeDeps,
} from './conversation-runtime';
import { IntentClassifier, type IntentClassifyContext } from './intent-classifier';
import { IntentResolver } from './intent-resolver';
import { ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';

// ADR-0093 conversation control, driven through the real ConversationRuntime with in-process fakes. The
// session, approval and plan-scoped approval-flow collaborators are the REAL SessionManager / ApprovalManager /
// StatelessApprovalFlow over in-memory repositories, so "closed", "denied" and "no longer pending" are read back
// from storage rather than asserted on a mock.

const CTX: ConversationContext = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-10-02T09:00:00.000Z';
const at = (offsetMs: number): IsoTimestamp => new Date(Date.parse(T0) + offsetMs).toISOString();
const MINUTE = 60_000;
const MAY_HAVE_APPLIED = '변경 적용 여부를 확인할 수 없어요';
const CONFIRMED_NOT_APPLIED = '아직 어떤 변경도 적용되지 않았어요';

const composer = new ResponseComposer();

const bad = (name: string) => () => {
  throw new Error(`${name} must not be called`);
};

interface HarnessOptions {
  /** Seed one PENDING plan-scoped approval created at T0 into the active session. */
  pendingApproval?: boolean;
  /** Seed an apply-preview anchor whose pending request is created at T0 (stateful fake flow). */
  applyAnchor?: ApplyPreviewAnchor;
  classifier?: ConversationRuntimeDeps['classifier'];
  activeProjectId?: string;
  providerExecute?: (request: AiRequest) => Promise<{ text: string }>;
  routerSelectThrows?: boolean;
  createTaskThrows?: boolean;
  /** Anchor a resumable `{request, prior}` on the seeded task so an approve reaches the decision point. */
  resumable?: boolean;
  /** Runs inside `memory.recordShortTerm` — i.e. AFTER the turn-start expiry check, BEFORE any decision. */
  onRecordShortTerm?: () => void;
}

function harness(opts: HarnessOptions = {}) {
  let clockNow: IsoTimestamp = T0;
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, ApprovalRequest>();
  const tasks = new Map<string, Task>();
  const calls = {
    recordShortTerm: 0,
    recordAssistant: 0,
    classify: [] as Array<IntentClassifyContext | undefined>,
    routerSelect: [] as Capability[],
    providerExecute: 0,
    createTask: 0,
    orchestratorRun: 0,
    orchestratorResume: 0,
    applyAnchorWrites: [] as ApplyPreviewAnchor[],
    applyClear: 0,
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

  // Seed: the owner's active session (and optionally a plan-scoped PENDING approval anchored on it).
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
      ...(opts.resumable
        ? { metadata: { conversationExecutionAnchor: { request: { instruction: 'fix foo' }, prior: { status: 'WAITING_APPROVAL' } } } }
        : {}),
    });
    approvals.set(pendingRequest.id, pendingRequest);
    seeded.activeTaskId = 'task-1';
  }
  if (opts.applyAnchor) {
    const id = 'apply-appr-1';
    approvals.set(id, { ...pendingRequest, id, reason: 'Commit packages/core/src/foo.ts' });
  }
  sessions.set(seeded.id, seeded);

  let currentAnchor: ApplyPreviewAnchor | null = opts.applyAnchor ?? null;
  const applyPreviewFlow: ApplyPreviewFlow = {
    async findAnchor() {
      return currentAnchor;
    },
    async anchor(_s, anchor) {
      calls.applyAnchorWrites.push(anchor);
      currentAnchor = anchor;
    },
    async clear() {
      calls.applyClear++;
      currentAnchor = null;
    },
  };

  const provider: AiProvider = {
    id: 'fake-provider',
    capabilities: [],
    async isAvailable() {
      return true;
    },
    async execute(request: AiRequest) {
      calls.providerExecute++;
      return opts.providerExecute ? opts.providerExecute(request) : { text: '안녕하세요!', artifacts: [] };
    },
  };

  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm() { calls.recordShortTerm++; opts.onRecordShortTerm?.(); return { id: 'mem-user' }; },
      async recordAssistant() { calls.recordAssistant++; return undefined; },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('memoryWriter.createCandidate'), promote: bad('memoryWriter.promote'), forget: bad('memoryWriter.forget') } as unknown as ConversationRuntimeDeps['memoryWriter'],
    classifier: opts.classifier ?? {
      async classify(_m: InboundMessage, ctx?: IntentClassifyContext): Promise<Intent> {
        calls.classify.push(ctx);
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'chat' };
      },
    },
    projects: { register: bad('projects.register'), get: async () => null },
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      async createTask(intent, context, anchor) {
        calls.createTask++;
        if (opts.createTaskThrows) throw new Error('sqlite: database is locked');
        return {
          id: `task-work-${calls.createTask}`,
          title: intent.summary,
          description: anchor.requestText,
          status: TaskStatus.PENDING,
          intent,
          riskLevel: RiskLevel.LOW,
          context,
          actorId: anchor.actorId,
          sessionId: anchor.sessionId,
          createdAt: T0,
          updatedAt: T0,
        };
      },
      async transition(task, to) { return { ...task, status: to }; },
      async startRun(task, capability) { return { id: 'run-1', taskId: task.id, capability } as TaskRun; },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: { prepare: async () => undefined, open: bad('workspace.open'), list: bad('workspace.list'), diff: bad('workspace.diff'), read: bad('workspace.read') },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { async build() { return {} as Awaited<ReturnType<ConversationRuntimeDeps['contextBuilder']['build']>>; } },
    promptComposer: { compose() { return {} as ReturnType<ConversationRuntimeDeps['promptComposer']['compose']>; } },
    promptRenderer: { render(_spec, o) { return { capability: o.capability, prompt: 'rendered' } as AiRequest; } },
    router: {
      async select(capability) {
        calls.routerSelect.push(capability);
        if (opts.routerSelectThrows) throw new Error('provider registry unavailable');
        return provider;
      },
    },
    artifacts: { async persistAll() { return []; } },
    composer,
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: {
      async run() { calls.orchestratorRun++; throw new Error('orchestrator.run must not be called'); },
      async resume() { calls.orchestratorResume++; throw new Error('orchestrator.resume must not be called'); },
    },
    approvals: {
      decide: (id, d) => approvalManager.decide(id, d),
      get: (id) => approvalManager.get(id),
      requestForRisk: bad('approvals.requestForRisk'),
    },
    approvalFlow,
    scopeClarificationFlow: { async findPending() { return null; }, anchor: bad('scope.anchor'), clear: bad('scope.clear') },
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
    logger,
  };

  const runtime = new ConversationRuntime(deps, { clock: () => clockNow });
  let seq = 0;
  const send = (text: string) =>
    runtime.handle({ id: `msg-${++seq}`, context: CTX, text, receivedAt: clockNow } satisfies InboundMessage);

  return {
    runtime,
    send,
    calls,
    sessions,
    approvals,
    approvalFlow,
    sessionManager,
    setClock(ts: IsoTimestamp) {
      clockNow = ts;
    },
    currentAnchor: () => currentAnchor,
    seededSession: () => sessions.get('sess-seeded')!,
  };
}

const commitPendingAnchor = (): ApplyPreviewAnchor => ({
  kind: 'code-preview-apply',
  status: 'COMMIT_APPROVAL_PENDING',
  executionPlanRef: { kind: 'ExecutionPlan', id: 'plan-1' } as ApplyPreviewAnchor['executionPlanRef'],
  workspaceRef: { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' } as ApplyPreviewAnchor['workspaceRef'],
  targetFiles: ['packages/core/src/foo.ts'],
  codeGenerationRef: { kind: 'CodeGeneration', id: 'gen-1' } as ApplyPreviewAnchor['codeGenerationRef'],
  codeProposalRef: { kind: 'CodeProposal', id: 'prop-1' } as ApplyPreviewAnchor['codeProposalRef'],
  instruction: 'fix foo',
  createdAt: T0,
  approvalId: 'apply-approval-earlier',
  workspaceChangeRef: { kind: 'WorkspaceChange', id: 'wc-1' } as ApplyPreviewAnchor['workspaceChangeRef'],
  commitApprovalId: 'apply-appr-1',
  proposedCommitMessage: 'chore: update foo',
  commitCandidateFiles: ['packages/core/src/foo.ts'],
});

describe('ConversationRuntime — help (ADR-0093)', () => {
  it.each(['도움말', '/help', '  /HELP  '])('"%s" replies with the fixed help text, deterministically', async (text) => {
    const h = harness();
    const result = await h.send(text);
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(composer.composeHelp(CTX).text);
    expect(result.sessionId).toBe('sess-seeded');
    // No provider call, no Task/TaskRun, no classification, nothing written to conversational memory.
    expect(h.calls.routerSelect).toHaveLength(0);
    expect(h.calls.providerExecute).toBe(0);
    expect(h.calls.createTask).toBe(0);
    expect(h.calls.classify).toHaveLength(0);
    expect(h.calls.recordShortTerm).toBe(0);
    expect(h.calls.recordAssistant).toBe(0);
  });

  it('help while an unexpired approval is pending answers help and leaves the approval PENDING', async () => {
    const h = harness({ pendingApproval: true });
    h.setClock(at(5 * MINUTE));
    const result = await h.send('도움말');
    expect(result.reply.text).toBe(composer.composeHelp(CTX).text);
    expect(h.approvals.get('appr-1')!.status).toBe(ApprovalStatus.PENDING);
    expect(await h.approvalFlow.findPending(h.seededSession())).not.toBeNull();
  });
});

describe('ConversationRuntime — reset (ADR-0093)', () => {
  it('"새 대화" closes the session; the next message opens a NEW session', async () => {
    const h = harness();
    const reset = await h.send('새 대화');
    expect(reset.status).toBe('RESPONDED');
    expect(reset.sessionId).toBe('sess-seeded');
    expect(reset.reply.text).toBe(composer.composeConversationReset(CTX, { deniedPendingApproval: false }).text);
    expect(h.seededSession().status).toBe(SessionStatus.CLOSED);
    expect(h.calls.recordShortTerm).toBe(0);
    expect(h.calls.recordAssistant).toBe(0);
    expect(h.calls.routerSelect).toHaveLength(0);

    const next = await h.send('안녕');
    expect(next.status).toBe('RESPONDED');
    expect(next.sessionId).not.toBe('sess-seeded');
    expect(h.sessions.get(next.sessionId)!.status).toBe(SessionStatus.ACTIVE);
  });

  it('"/reset" with a pending approval records it denied by the OWNER actor (comment "reset"), then closes', async () => {
    const h = harness({ pendingApproval: true });
    h.setClock(at(10 * MINUTE));
    const reset = await h.send('/reset');
    expect(reset.reply.text).toBe(composer.composeConversationReset(CTX, { deniedPendingApproval: true }).text);
    expect(reset.reply.text).toContain('거절로 처리했어요');

    const decided = h.approvals.get('appr-1')!;
    expect(decided.status).toBe(ApprovalStatus.REJECTED);
    expect(decided.decision).toBe(false);
    expect(decided.decidedBy).toBe(OWNER.id);
    expect(decided.comment).toBe('reset');
    expect(decided.decidedAt).toBe(at(10 * MINUTE));
    expect(h.seededSession().status).toBe(SessionStatus.CLOSED);
    expect(h.calls.orchestratorResume).toBe(0);

    // The next turn opens a new session with nothing pending; "승인" can no longer approve anything.
    const next = await h.send('승인');
    expect(next.sessionId).not.toBe('sess-seeded');
    expect(await h.approvalFlow.findPending(h.sessions.get(next.sessionId)!)).toBeNull();
    expect(await h.approvalFlow.findPending(h.seededSession())).toBeNull();
    expect(h.calls.orchestratorResume).toBe(0);
  });

  it('a sentence that merely contains "새 대화" is ordinary work, not a reset', async () => {
    const h = harness();
    const result = await h.send('새 대화 기능 만들어줘');
    expect(h.calls.classify).toHaveLength(1);
    expect(result.reply.text).toBe('안녕하세요!');
    expect(h.seededSession().status).toBe(SessionStatus.ACTIVE);
  });
});

describe('ConversationRuntime — pending-approval TTL (ADR-0093)', () => {
  it('expires a PENDING approval lazily after 30 minutes: denied by "system", notice only, never approvable', async () => {
    const h = harness({ pendingApproval: true });
    const expiredAt = at(PENDING_APPROVAL_TTL_MS + 1);
    h.setClock(expiredAt);
    const result = await h.send('승인');
    expect(result.status).toBe('DENIED');
    expect(result.reply.text).toBe(
      composer.composeApprovalExpired(CTX, h.approvals.get('appr-1')!, PENDING_APPROVAL_TTL_MS).text,
    );
    expect(result.reply.text).toContain('30분');

    const decided = h.approvals.get('appr-1')!;
    expect(decided.status).toBe(ApprovalStatus.REJECTED);
    expect(decided.decidedBy).toBe('system');
    expect(decided.comment).toBe('expired');
    expect(decided.decidedAt).toBe(expiredAt);
    expect(h.calls.orchestratorResume).toBe(0);
    expect(h.calls.classify).toHaveLength(0); // the expiry notice is the whole turn
    expect(h.calls.providerExecute).toBe(0);

    // Still the same (open) session, but nothing pending: a later "승인" approves nothing.
    expect(h.seededSession().status).toBe(SessionStatus.ACTIVE);
    expect(await h.approvalFlow.findPending(h.seededSession())).toBeNull();
    await h.send('승인');
    expect(h.calls.orchestratorResume).toBe(0);
    expect(h.approvals.get('appr-1')!.status).toBe(ApprovalStatus.REJECTED);
  });

  it('exactly at 30 minutes the approval is expired; one millisecond before it is not', async () => {
    const fresh = harness({ pendingApproval: true });
    fresh.setClock(at(PENDING_APPROVAL_TTL_MS - 1));
    const reminder = await fresh.send('음 글쎄');
    expect(reminder.status).toBe('AWAITING_APPROVAL');
    expect(fresh.approvals.get('appr-1')!.status).toBe(ApprovalStatus.PENDING);

    const edge = harness({ pendingApproval: true });
    edge.setClock(at(PENDING_APPROVAL_TTL_MS));
    const expired = await edge.send('음 글쎄');
    expect(expired.status).toBe('DENIED');
    expect(edge.approvals.get('appr-1')!.decidedBy).toBe('system');
  });

  it('help on an expired turn: expiry recorded by "system" AND help runs, with the expiry notice prepended', async () => {
    const h = harness({ pendingApproval: true });
    h.setClock(at(45 * MINUTE));
    const result = await h.send('도움말');
    const notice = composer.composeApprovalExpired(CTX, h.approvals.get('appr-1')!, PENDING_APPROVAL_TTL_MS).text;
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(`${notice}\n\n${composer.composeHelp(CTX).text}`);
    expect(h.approvals.get('appr-1')!.decidedBy).toBe('system');
    expect(h.approvals.get('appr-1')!.comment).toBe('expired');
    expect(h.calls.recordShortTerm).toBe(0);
    expect(h.calls.recordAssistant).toBe(0);
  });

  it('reset on an expired turn: denial stays attributed to "system" (expiry), the reset closes the session', async () => {
    const h = harness({ pendingApproval: true });
    h.setClock(at(31 * MINUTE));
    const result = await h.send('새 대화');
    const notice = composer.composeApprovalExpired(CTX, h.approvals.get('appr-1')!, PENDING_APPROVAL_TTL_MS).text;
    expect(result.reply.text).toBe(
      `${notice}\n\n${composer.composeConversationReset(CTX, { deniedPendingApproval: false }).text}`,
    );
    expect(h.approvals.get('appr-1')!.decidedBy).toBe('system');
    expect(h.approvals.get('appr-1')!.comment).toBe('expired');
    expect(h.seededSession().status).toBe(SessionStatus.CLOSED);
  });

  it('an expired anchor-scoped (commit) approval is denied by "system" and the anchor reverts like a denial', async () => {
    const h = harness({ applyAnchor: commitPendingAnchor() });
    h.setClock(at(40 * MINUTE));
    const result = await h.send('승인');
    expect(result.status).toBe('DENIED');
    expect(h.approvals.get('apply-appr-1')!.status).toBe(ApprovalStatus.REJECTED);
    expect(h.approvals.get('apply-appr-1')!.decidedBy).toBe('system');
    const anchor = h.currentAnchor()!;
    expect(anchor.status).toBe('WORKSPACE_APPLIED'); // the applied workspace state survives
    expect(anchor.commitApprovalId).toBeUndefined();
    expect(anchor.proposedCommitMessage).toBeUndefined();
    expect(anchor.workspaceChangeRef?.id).toBe('wc-1');
  });

  describe('an approval that expires MID-TURN (after the turn-start check) is never approved', () => {
    const justBefore = at(PENDING_APPROVAL_TTL_MS - 1);
    const pastDeadline = at(PENDING_APPROVAL_TTL_MS + 1);

    it('plan-scoped: resume context reconstructed, but the clock passed the deadline → expiry denial, no resume', async () => {
      const h: ReturnType<typeof harness> = harness({
        pendingApproval: true,
        resumable: true,
        onRecordShortTerm: () => h.setClock(pastDeadline),
      });
      h.setClock(justBefore);
      const result = await h.send('승인');
      expect(result.status).toBe('DENIED');
      expect(result.reply.text).toBe(
        composer.composeApprovalExpired(CTX, h.approvals.get('appr-1')!, PENDING_APPROVAL_TTL_MS).text,
      );
      const decided = h.approvals.get('appr-1')!;
      expect(decided.status).toBe(ApprovalStatus.REJECTED);
      expect(decided.decidedBy).toBe('system');
      expect(decided.comment).toBe('expired');
      expect(decided.decidedAt).toBe(pastDeadline);
      expect(h.calls.orchestratorResume).toBe(0);
    });

    it('anchor-scoped (commit): denied by "system" and the anchor reverts; never COMMIT_APPROVED', async () => {
      const h: ReturnType<typeof harness> = harness({
        applyAnchor: commitPendingAnchor(),
        onRecordShortTerm: () => h.setClock(pastDeadline),
      });
      h.setClock(justBefore);
      const result = await h.send('승인');
      expect(result.status).toBe('DENIED');
      const decided = h.approvals.get('apply-appr-1')!;
      expect(decided.status).toBe(ApprovalStatus.REJECTED);
      expect(decided.decidedBy).toBe('system');
      expect(decided.comment).toBe('expired');
      expect(h.currentAnchor()!.status).toBe('WORKSPACE_APPLIED');
      expect(h.calls.applyAnchorWrites.map((a) => a.status)).not.toContain('COMMIT_APPROVED');
    });

    it('apply (AWAITING_APPROVAL): denied by "system" and the anchor is cleared; never APPROVED', async () => {
      const h: ReturnType<typeof harness> = harness({
        applyAnchor: { ...commitPendingAnchor(), status: 'AWAITING_APPROVAL', approvalId: 'apply-appr-1' },
        onRecordShortTerm: () => h.setClock(pastDeadline),
      });
      h.setClock(justBefore);
      const result = await h.send('승인');
      expect(result.status).toBe('DENIED');
      expect(h.approvals.get('apply-appr-1')!.decidedBy).toBe('system');
      expect(h.approvals.get('apply-appr-1')!.comment).toBe('expired');
      expect(h.currentAnchor()).toBeNull();
      expect(h.calls.applyAnchorWrites.map((a) => a.status)).not.toContain('APPROVED');
    });

    it('a deny that lands after the deadline is still the user\'s deny (only positive decisions are re-checked)', async () => {
      const h: ReturnType<typeof harness> = harness({
        pendingApproval: true,
        onRecordShortTerm: () => h.setClock(pastDeadline),
      });
      h.setClock(justBefore);
      const result = await h.send('거절');
      expect(result.status).toBe('DENIED');
      expect(h.approvals.get('appr-1')!.decidedBy).toBe(OWNER.id);
    });
  });

  it('an expired apply (AWAITING_APPROVAL) approval clears the anchor, exactly like a denial', async () => {
    const h = harness({ applyAnchor: { ...commitPendingAnchor(), status: 'AWAITING_APPROVAL', approvalId: 'apply-appr-1' } });
    h.setClock(at(40 * MINUTE));
    await h.send('승인');
    expect(h.approvals.get('apply-appr-1')!.decidedBy).toBe('system');
    expect(h.calls.applyClear).toBe(1);
    expect(h.currentAnchor()).toBeNull();
  });
});

describe('ConversationRuntime — pending-approval reminder (ADR-0093)', () => {
  it('an ambiguous message while an approval is pending gets a reminder (what, 승인/거절, time left, 새 대화) — no chat', async () => {
    const h = harness({ pendingApproval: true });
    h.setClock(at(10 * MINUTE));
    const result = await h.send('음 글쎄, 오늘 날씨 어때?');
    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).toContain('위험도: 높음'); // names the pending risk in Korean (QA-017)
    expect(result.reply.text).not.toContain('Change packages/core/src/foo.ts'); // internal reason is never shown
    expect(result.reply.text).toContain('"승인"');
    expect(result.reply.text).toContain('"거절"');
    expect(result.reply.text).toContain('남은 시간: 약 20분');
    expect(result.reply.text).toContain('"새 대화"');
    expect(h.calls.classify).toHaveLength(0);
    expect(h.calls.routerSelect).toHaveLength(0);
    expect(h.calls.providerExecute).toBe(0);
    expect(h.approvals.get('appr-1')!.status).toBe(ApprovalStatus.PENDING);
  });

  it('an anchor-scoped pending approval reminds the same way', async () => {
    const h = harness({ applyAnchor: commitPendingAnchor() });
    h.setClock(at(29 * MINUTE + 30_000));
    const result = await h.send('이거 뭐였지?');
    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).toContain('위험도: 높음');
    expect(result.reply.text).not.toContain('Commit packages/core/src/foo.ts');
    expect(result.reply.text).toContain('남은 시간: 약 1분');
    expect(result.reply.text).toContain('"새 대화"');
    expect(h.approvals.get('apply-appr-1')!.status).toBe(ApprovalStatus.PENDING);
  });
});

describe('ConversationRuntime — read-only failure wording', () => {
  it('a GENERAL_CHAT work turn whose infrastructure throws never says a change may have been applied', async () => {
    const h = harness({ createTaskThrows: true });
    const result = await h.send('안녕?');
    expect(result.status).toBe('FAILED');
    expect(result.sessionId).toBe('sess-seeded');
    expect(result.reply.text).not.toContain(MAY_HAVE_APPLIED);
    expect(result.reply.text).toContain(CONFIRMED_NOT_APPLIED);
    expect(result.reply.text).not.toContain('database is locked'); // still sanitized
  });

  it('a GENERAL_CHAT provider-selection failure inside the work turn uses the plain retry copy, not "may have applied"', async () => {
    const h = harness({ routerSelectThrows: true });
    const result = await h.send('오늘 뭐 할까?');
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).not.toContain(MAY_HAVE_APPLIED);
  });

  it('a classifier failure is reported as confirmed-not-applied', async () => {
    const h = harness({
      classifier: {
        async classify() {
          throw new Error('classifier exploded');
        },
      },
    });
    const result = await h.send('README 요약해줘');
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).not.toContain(MAY_HAVE_APPLIED);
    expect(result.reply.text).toContain(CONFIRMED_NOT_APPLIED);
  });
});

describe('ConversationRuntime — project-aware classification (T2 wiring)', () => {
  const snippetMessage = '이 코드 버그 고쳐줘\n```js\nconst total = items.reduce((a, b) => a + b);\n```';

  it('passes hasActiveProject=false to the classifier when the session has no active project', async () => {
    const h = harness();
    await h.send('안녕');
    expect(h.calls.classify).toEqual([{ hasActiveProject: false }]);
  });

  it('passes hasActiveProject=true when the session has an active project', async () => {
    const h = harness({ activeProjectId: 'proj-1' });
    await h.send('안녕');
    expect(h.calls.classify).toEqual([{ hasActiveProject: true }]);
  });

  it('with no active project, "이 코드 버그 고쳐줘 <snippet>" is answered as chat (real classifier) — no code-change execution', async () => {
    const classifier = new IntentClassifier({} as CapabilityRouter);
    const h = harness({ classifier });
    const result = await h.send(snippetMessage);
    expect(result.status).toBe('RESPONDED');
    expect(h.calls.routerSelect).toEqual([Capability.GENERAL_CHAT]);
    expect(h.calls.orchestratorRun).toBe(0);
    expect(result.reply.text).toBe('안녕하세요!');
  });
});

describe('Help text names only phrases the runtime actually accepts (ADR-0093)', () => {
  const help = composer.composeHelp(CTX).text;

  it.each<[string, () => unknown, unknown]>([
    ['적용해줘', () => ConversationRuntime.interpretApplyIntent('적용해줘'), true],
    ['패치 만들어줘', () => ConversationRuntime.interpretPatchIntent('패치 만들어줘'), true],
    ['패치 적용해줘', () => ConversationRuntime.interpretFinalApplyIntent('패치 적용해줘'), true],
    ['테스트 실행해줘', () => ConversationRuntime.interpretPostApplyValidationIntent('테스트 실행해줘'), 'test'],
    ['타입체크 실행해줘', () => ConversationRuntime.interpretPostApplyValidationIntent('타입체크 실행해줘'), 'typecheck'],
    ['커밋해줘', () => ConversationRuntime.interpretCommitIntent('커밋해줘'), 'commit'],
    ['커밋 실행', () => ConversationRuntime.interpretCommitExecutionIntent('커밋 실행'), 'execute'],
    ['승인', () => ConversationRuntime.interpretDecision('승인'), 'approve'],
    ['거절', () => ConversationRuntime.interpretDecision('거절'), 'deny'],
  ])('"%s" appears in help and is accepted', (phrase, interpret, expected) => {
    expect(help).toContain(`"${phrase}"`);
    expect(interpret()).toBe(expected);
  });

  it('the project-registration example classifies as REGISTER_PROJECT', async () => {
    const example = '이 프로젝트 등록해줘: /path/to/project';
    expect(help).toContain(`"${example}"`);
    const intent = await new IntentClassifier({} as CapabilityRouter).classify(
      { id: 'm', context: CTX, text: example, receivedAt: T0 },
      { hasActiveProject: false },
    );
    expect(intent.type).toBe(IntentType.REGISTER_PROJECT);
  });
});

describe('ConversationRuntime — stray decision with nothing pending (QA-018)', () => {
  const NO_PENDING =
    '지금 승인하거나 거절할 작업이 없어요. 기다리던 승인 요청은 처리됐거나 만료됐을 수 있어요. 새로 요청하려면 원하는 작업을 말해 주세요.';

  it.each(['승인', '승인해줘', '거절', '거절합니다', '취소', '취소해 주세요', 'approve', 'ok', 'OK thanks', '진행해'])(
    '"%s" with no pending approval gets the deterministic reply — no classifier, provider or Task',
    async (text) => {
      const h = harness();
      const result = await h.send(text);
      expect(result.status).toBe('RESPONDED');
      expect(result.reply.text).toBe(NO_PENDING);
      expect(h.calls.classify).toHaveLength(0);
      expect(h.calls.routerSelect).toHaveLength(0);
      expect(h.calls.providerExecute).toBe(0);
      expect(h.calls.createTask).toBe(0);
    },
  );

  it.each(['승인 절차가 뭐야?', '승인 절차 설명해줘', '회의 취소해줘', '좋아', '아니', '네'])(
    '"%s" is not a stray decision and still goes to chat',
    async (text) => {
      const h = harness();
      const result = await h.send(text);
      expect(result.reply.text).not.toBe(NO_PENDING);
      expect(h.calls.routerSelect).toEqual([Capability.GENERAL_CHAT]);
    },
  );

  it('with an anchor that holds no pending approval (COMMIT_APPROVED) "승인" decides nothing and says so', async () => {
    const anchor: ApplyPreviewAnchor = { ...commitPendingAnchor(), status: 'COMMIT_APPROVED' };
    const h = harness({ applyAnchor: anchor });
    const result = await h.send('승인');
    expect(result.reply.text).toBe(NO_PENDING);
    expect(h.calls.providerExecute).toBe(0);
    expect(h.calls.applyAnchorWrites).toHaveLength(0);
  });

  it('a real pending approval still takes "거절" as its decision (not the stray reply)', async () => {
    const h = harness({ pendingApproval: true });
    const result = await h.send('거절');
    expect(result.reply.text).not.toBe(NO_PENDING);
    expect(h.approvals.get('appr-1')!.status).toBe(ApprovalStatus.REJECTED);
  });
});
