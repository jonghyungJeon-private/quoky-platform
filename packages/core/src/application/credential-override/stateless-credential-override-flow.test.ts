import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  CodeGenerationStatus,
  IntentType,
  RiskLevel,
  SessionStatus,
  TaskStatus,
} from '../../domain';
import type { ApprovalRequest, ConversationContext, Id, Session, Task, WorkspaceRef } from '../../domain';
import type { StorageProvider } from '../../ports';
import { ApprovalManager } from '../approval-manager';
import type { ApprovalPolicy } from '../approval-policy';
import type { CredentialOverrideGrant } from '../code-generation-context';
import type { ApplyPreviewAnchor, PendingScopeClarification } from '../conversation-runtime';
import type { ExecutionOutcome, ExecutionRequest } from '../execution-orchestrator';
import { StatelessApplyPreviewFlow } from '../stateless-apply-preview-flow';
import { StatelessApprovalFlow } from '../stateless-approval-flow';
import { StatelessScopeClarificationFlow } from '../stateless-scope-clarification-flow';
import {
  CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
  CREDENTIAL_OVERRIDE_DENY_COMMENT,
  MAX_CREDENTIAL_OVERRIDE_GRANTS,
  type CredentialOverrideAnchor,
  type CredentialOverrideDispatchInput,
  type CredentialOverrideInvalidationReason,
  type CredentialOverrideRefusal,
  credentialOverrideContentSha256,
} from './credential-override';
import { type CredentialOverrideFlowStore, StatelessCredentialOverrideFlow } from './stateless-credential-override-flow';

const T0 = '2026-10-02T00:00:00.000Z';
const setMinutes = (m: number): void => {
  vi.setSystemTime(new Date(Date.parse(T0) + m * 60_000));
};

const OWNER = 'owner-1';
const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };
const WS: WorkspaceRef = { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' };
const ANCHOR_KEY = 'conversationCredentialOverrideAnchor';

const ASSIGN_A = 'export const a = 1;\n\nconst password = "demo-value-a";\n';
const ASSIGN_B = 'const apiKey = "demo-value-b";\n';
const TOKEN = 'const k = "AKIAIOSFODNN7EXAMPLE";\n';

const request: ExecutionRequest = {
  goal: 'fix login',
  instruction: '로그인 버그 고쳐줘',
  requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
  requestedBy: OWNER,
  projectId: 'proj-1',
  workspaceRef: WS,
  targetFiles: ['src/a.ts', 'src/b.ts', 'src/new.ts'],
  newFileTargets: ['src/new.ts'],
  planningOnly: true,
};
const outcome = {
  status: 'COMPLETED',
  refs: { executionPlanRef: { id: 'plan-1', goal: 'fix login' } },
} as unknown as ExecutionOutcome;

const intent = {
  type: IntentType.IMPLEMENT_CODE,
  capability: Capability.CODE_IMPLEMENTATION,
  confidence: 1,
  requiresWork: true,
  summary: 's',
};

/** The CODE_IMPLEMENTATION request's approval-anchor Task — the shape StatelessApprovalFlow writes. */
const requestTask: Task = {
  id: 'task-request',
  title: 'fix login',
  description: 'd',
  status: TaskStatus.WAITING_APPROVAL,
  intent,
  riskLevel: RiskLevel.HIGH,
  context: CTX,
  actorId: OWNER,
  sessionId: 'sess-1',
  projectId: 'proj-1',
  planId: 'plan-1',
  createdAt: T0,
  updatedAt: T0,
  metadata: { conversationExecutionAnchor: { request, prior: outcome } },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** In-memory storage with the repository shapes the stateless flows and ApprovalManager use. */
class MemoryStore {
  readonly taskRows = new Map<Id, Task>();
  readonly approvalRows = new Map<Id, ApprovalRequest>();
  session: Session;
  failTaskSave: ((task: Task) => boolean) | null = null;
  failSessionSave: ((session: Session) => boolean) | null = null;

  constructor(session: Session) {
    this.session = session;
  }

  readonly sessions = {
    get: async (id: Id): Promise<Session | null> => (this.session.id === id ? clone(this.session) : null),
    save: async (session: Session): Promise<Session> => {
      if (this.failSessionSave?.(session)) throw new Error('disk full');
      this.session = clone(session);
      return session;
    },
  };
  readonly tasks = {
    get: async (id: Id): Promise<Task | null> => {
      const row = this.taskRows.get(id);
      return row ? clone(row) : null;
    },
    save: async (task: Task): Promise<Task> => {
      if (this.failTaskSave?.(task)) throw new Error('disk full');
      this.taskRows.set(task.id, clone(task));
      return task;
    },
  };
  readonly approvals = {
    get: async (id: Id): Promise<ApprovalRequest | null> => {
      const row = this.approvalRows.get(id);
      return row ? clone(row) : null;
    },
    save: async (r: ApprovalRequest): Promise<ApprovalRequest> => {
      this.approvalRows.set(r.id, clone(r));
      return r;
    },
    findByExecutionPlan: async (planId: Id): Promise<ApprovalRequest[]> =>
      [...this.approvalRows.values()].filter((r) => r.executionPlanRef.id === planId).map(clone),
  };

  anchorOf(taskId: Id): CredentialOverrideAnchor {
    return this.taskRows.get(taskId)?.metadata?.[ANCHOR_KEY] as CredentialOverrideAnchor;
  }
}

let store: MemoryStore;
let approvals: ApprovalManager;
let flow: StatelessCredentialOverrideFlow;
let files: Record<string, string>;

const reader = {
  read: async (_ref: WorkspaceRef, path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) throw new Error('unreadable');
    return content;
  },
};

const dispatchInput = (o: Partial<CredentialOverrideDispatchInput> = {}): CredentialOverrideDispatchInput => ({
  actorId: OWNER, workspaceRef: WS, projectId: 'proj-1', executionPlanId: 'plan-1', reader, ...o,
});

const refusalOf = (path: string, content: string, line: number, targetIndex = 0): CredentialOverrideRefusal => ({
  targetIndex, targetPath: path, contentSha256: credentialOverrideContentSha256(content), line,
});

const raise = (refusal = refusalOf('src/a.ts', ASSIGN_A, 3), ownerActorId = OWNER) =>
  flow.requestOverride(store.session, { request, outcome, ownerActorId, refusal }, approvals);

const decide = (approvalId: Id, approved: boolean, decidedBy = OWNER) =>
  approvals.decide(approvalId, {
    approvalId, approved, decidedBy, decidedAt: new Date().toISOString(),
    comment: approved ? CREDENTIAL_OVERRIDE_APPROVE_COMMENT : CREDENTIAL_OVERRIDE_DENY_COMMENT,
  });

const grant = async (approvalId: Id, decidedBy = OWNER) => {
  await decide(approvalId, true, decidedBy);
  return flow.recordGrant(store.session, approvalId);
};

/** One refused file raised and granted; returns the anchor Task id. */
const grantedSingle = async (): Promise<{ taskId: Id; approvalId: Id }> => {
  const raised = await raise();
  if (!raised.ok) throw new Error(raised.reason);
  const granted = await grant(raised.approval.id);
  expect(granted.ok).toBe(true);
  return { taskId: store.session.activeTaskId!, approvalId: raised.approval.id };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  store = new MemoryStore({
    id: 'sess-1',
    actorId: OWNER,
    context: CTX,
    status: SessionStatus.ACTIVE,
    activeProjectId: 'proj-1',
    activeTaskId: requestTask.id,
    createdAt: T0,
    lastActivityAt: T0,
  });
  store.taskRows.set(requestTask.id, clone(requestTask));
  approvals = new ApprovalManager(store as unknown as StorageProvider, {} as ApprovalPolicy);
  flow = new StatelessCredentialOverrideFlow(store);
  files = { 'src/a.ts': ASSIGN_A, 'src/b.ts': ASSIGN_B };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StatelessCredentialOverrideFlow — raising an override (ADR-0097 D3)', () => {
  it('creates a CRITICAL PENDING request via requestForRisk and a plan-less inert anchor bound to the request', async () => {
    const raised = await raise();
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    const approval = store.approvalRows.get(raised.approval.id)!;
    expect(approval).toMatchObject({
      status: ApprovalStatus.PENDING, riskLevel: RiskLevel.CRITICAL, requestedBy: OWNER,
      executionPlanRef: { id: 'plan-1' },
    });
    expect(approval.reason).toContain(`sha256=${credentialOverrideContentSha256(ASSIGN_A)}`);
    expect(approval.reason).toContain('line=3');
    expect(approval.reason).not.toContain('src/a.ts');

    const taskId = store.session.activeTaskId!;
    expect(taskId).not.toBe(requestTask.id);
    const task = store.taskRows.get(taskId)!;
    expect(task.planId).toBeUndefined();
    expect(task).toMatchObject({ status: TaskStatus.WAITING_APPROVAL, riskLevel: RiskLevel.CRITICAL, actorId: OWNER });
    const anchor = store.anchorOf(taskId);
    expect(anchor).toMatchObject({
      kind: 'code-preview-credential-override',
      status: 'PENDING',
      ownerActorId: OWNER,
      sessionId: 'sess-1',
      projectId: 'proj-1',
      workspaceRef: WS,
      requestTaskId: requestTask.id,
      executionPlanId: 'plan-1',
      newFileTargets: ['src/new.ts'],
    });
    expect(anchor.grants).toEqual([
      expect.objectContaining({
        approvalRequestId: approval.id, path: 'src/a.ts', line: 3, targetIndex: 0, state: 'PENDING',
        detector: 'credential-assignment', contentSha256: credentialOverrideContentSha256(ASSIGN_A),
        ownerActorId: OWNER, sessionId: 'sess-1', requestTaskId: requestTask.id, executionPlanId: 'plan-1',
      }),
    ]);
    // Content-free: the stored row never carries file content or the matched value.
    expect(JSON.stringify(task)).not.toContain('demo-value');
    expect(store.taskRows.get(requestTask.id)).toEqual(requestTask); // the request Task is untouched
  });

  it('refuses to bind when the session pointer is not this request, or the actor is not the owner', async () => {
    store.session = { ...store.session, activeTaskId: undefined };
    expect(await raise()).toEqual({ ok: false, reason: 'unbound' });
    store.session = { ...store.session, activeTaskId: 'missing' };
    expect(await raise()).toEqual({ ok: false, reason: 'unbound' });
    store.session = { ...store.session, activeTaskId: requestTask.id };
    expect(await raise(undefined, 'someone-else')).toEqual({ ok: false, reason: 'unbound' });
    expect(await raise({ ...refusalOf('src/a.ts', ASSIGN_A, 3), contentSha256: 'nope' })).toEqual({
      ok: false, reason: 'invalid-refusal',
    });
    expect(store.approvalRows.size).toBe(0); // nothing raised
  });

  it('reports an awaiting decision with the remaining time', async () => {
    const raised = await raise();
    setMinutes(10);
    const lookup = await flow.findPending(store.session);
    expect(lookup).toMatchObject({
      state: 'awaiting-decision', grant: { path: 'src/a.ts' }, approval: { id: raised.ok && raised.approval.id },
      remainingMs: 20 * 60_000,
    });
  });
});

describe('StatelessCredentialOverrideFlow — anchor collisions (ADR-0040 technique)', () => {
  it('StatelessApprovalFlow never picks up the CRITICAL request that shares the plan ref', async () => {
    const approvalFlow = new StatelessApprovalFlow(store);
    const raised = await raise();
    if (!raised.ok) throw new Error('raise');
    // The collision is real: pointed at the plan's approval anchor, the CRITICAL request WOULD be found ...
    const viaPlan = { ...store.session, activeTaskId: requestTask.id };
    expect(await approvalFlow.findPending(viaPlan)).toMatchObject({ id: raised.approval.id });
    // ... which is why the override anchor is plan-less and the pointer moves to it.
    expect(await approvalFlow.findPending(store.session)).toBeNull();
    expect(await approvalFlow.reconstructResume(store.session, raised.approval)).toBeNull();
  });

  it('the scope-clarification and apply-preview flows ignore the override anchor', async () => {
    await raise();
    const taskId = store.session.activeTaskId;
    expect(await new StatelessScopeClarificationFlow(store).findPending(store.session)).toBeNull();
    expect(await new StatelessApplyPreviewFlow(store).findAnchor(store.session)).toBeNull();
    await new StatelessScopeClarificationFlow(store).clear(store.session);
    await new StatelessApplyPreviewFlow(store).clear(store.session);
    expect(store.session.activeTaskId).toBe(taskId);
  });

  it('ignores approval, scope and apply anchors and never clears a foreign pointer', async () => {
    const foreign: Task[] = [
      requestTask,
      {
        ...requestTask, id: 'task-scope', planId: undefined,
        metadata: {
          conversationScopeClarificationAnchor: { kind: 'code-scope-clarification', summary: 's', createdAt: T0 } satisfies
            PendingScopeClarification,
        },
      },
      {
        ...requestTask, id: 'task-apply', planId: undefined,
        metadata: {
          conversationApplyPreviewAnchor: {
            kind: 'code-preview-apply', status: 'ELIGIBLE', executionPlanRef: { id: 'plan-1', goal: 'g' },
            workspaceRef: WS, targetFiles: ['src/a.ts'], codeGenerationRef: { id: 'g', status: CodeGenerationStatus.SUCCEEDED },
            codeProposalRef: { id: 'p' }, instruction: 'i', projectId: 'proj-1', createdAt: T0,
          } satisfies ApplyPreviewAnchor,
        },
      },
      // A plan-less Task carrying our key under a foreign discriminator.
      { ...requestTask, id: 'task-odd', planId: undefined, metadata: { [ANCHOR_KEY]: { kind: 'something-else' } } },
    ];
    for (const task of foreign) {
      store.taskRows.set(task.id, clone(task));
      store.session = { ...store.session, activeTaskId: task.id };
      expect(await flow.findPending(store.session)).toBeNull();
      await flow.clear(store.session);
      expect(await flow.invalidate(store.session, 'reset', OWNER)).toBeNull();
      expect(store.session.activeTaskId).toBe(task.id);
      expect(store.taskRows.get(task.id)).toEqual(task);
    }
  });
});

describe('StatelessCredentialOverrideFlow — grant, consume and dispatch (ADR-0097 D5)', () => {
  it('records an owner grant in place and reports the set ready', async () => {
    const { taskId } = await grantedSingle();
    const anchor = store.anchorOf(taskId);
    expect(anchor.status).toBe('GRANTED');
    expect(anchor.grants[0]).toMatchObject({ state: 'GRANTED', grantedBy: OWNER });
    expect(store.taskRows.get(taskId)!.status).toBe(TaskStatus.PENDING);
    expect(await flow.findPending(store.session)).toMatchObject({ state: 'ready' });
  });

  it('consumes every grant in ONE save before the single dispatch, then never replays', async () => {
    const { taskId } = await grantedSingle();
    const saves: string[] = [];
    store.failTaskSave = (task) => {
      saves.push((task.metadata?.[ANCHOR_KEY] as CredentialOverrideAnchor).status);
      return false;
    };
    const dispatched: (readonly CredentialOverrideGrant[])[] = [];
    const result = await flow.consumeAndDispatch(store.session, dispatchInput(), async (grants) => {
      // The consume save has resolved before generate() runs.
      expect(store.anchorOf(taskId).status).toBe('CONSUMED');
      dispatched.push(grants);
      return 'generated';
    });
    expect(result).toEqual({ ok: true, value: 'generated' });
    expect(saves).toEqual(['CONSUMED']);
    expect(dispatched).toEqual([
      [{ path: 'src/a.ts', contentSha256: credentialOverrideContentSha256(ASSIGN_A), detector: 'credential-assignment', line: 3, state: 'CONSUMED' }],
    ]);
    const row = store.taskRows.get(taskId)!;
    expect(row.status).toBe(TaskStatus.COMPLETED); // the inert row stays as the audit record
    expect(store.anchorOf(taskId).grants.every((g) => g.state === 'CONSUMED' && g.consumedAt)).toBe(true);
    // The pointer is released after the consume save: later turns never keep hitting the consumed anchor.
    expect(store.session.activeTaskId).toBeUndefined();
    expect(await flow.findPending(store.session)).toBeNull();
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), async () => 'twice')).toEqual({
      ok: false, reason: 'not-found',
    });

    // A stale session copy still pointing at the consumed anchor is never replayed (also after a restart).
    store.session = { ...store.session, activeTaskId: taskId };
    const again = await flow.consumeAndDispatch(store.session, dispatchInput(), async () => 'twice');
    expect(again).toEqual({ ok: false, reason: 'already-used' });
    expect(await flow.findPending(store.session)).toMatchObject({ state: 'consumed' });
    expect(await new StatelessCredentialOverrideFlow(store).findPending(store.session)).toMatchObject({ state: 'consumed' });
  });

  it('a concurrent second turn finds the single-flight claim held and gets "already used"', async () => {
    await grantedSingle();
    const turn = store.session; // both turns hold the same pre-dispatch session copy
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const first = flow.consumeAndDispatch(turn, dispatchInput(), async () => {
      calls++;
      await gate;
      return 'one';
    });
    const second = await flow.consumeAndDispatch(turn, dispatchInput(), async () => {
      calls++;
      return 'two';
    });
    expect(second).toEqual({ ok: false, reason: 'already-used' });
    expect(await flow.findPending(turn)).toMatchObject({ state: 'consumed' });
    release();
    expect(await first).toEqual({ ok: true, value: 'one' });
    expect(calls).toBe(1);
  });

  it('a failed consume save sends nothing', async () => {
    await grantedSingle();
    store.failTaskSave = (task) => (task.metadata?.[ANCHOR_KEY] as CredentialOverrideAnchor)?.status === 'CONSUMED';
    const dispatch = vi.fn(async () => 'x');
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'consume-failed',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a dispatch failure after consumption ends the request with no replay', async () => {
    const { taskId } = await grantedSingle();
    await expect(
      flow.consumeAndDispatch(store.session, dispatchInput(), async () => {
        throw new Error('provider timeout');
      }),
    ).rejects.toThrow('provider timeout');
    expect(store.anchorOf(taskId).status).toBe('CONSUMED');
    const dispatch = vi.fn(async () => 'x');
    const stale = { ...store.session, activeTaskId: taskId };
    expect(await flow.consumeAndDispatch(stale, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'already-used',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses to consume while a grant still awaits a decision (nothing changes)', async () => {
    await raise();
    const dispatch = vi.fn(async () => 'x');
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'not-granted',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await flow.findPending(store.session)).toMatchObject({ state: 'awaiting-decision' });
  });

  type RevalidationCase = readonly [
    name: string,
    mutate: () => void,
    input: Partial<CredentialOverrideDispatchInput>,
    reason: CredentialOverrideInvalidationReason,
  ];
  const revalidationCases: readonly RevalidationCase[] = [
    ['content hash changed', (): void => { files['src/a.ts'] = `${ASSIGN_A}// edited\n`; }, {}, 'changed'],
    ['no longer a credential assignment', (): void => { files['src/a.ts'] = 'export const a = 1;\n'; }, {}, 'changed'],
    ['now a secret token (never overridable)', (): void => { files['src/a.ts'] = `${ASSIGN_A}${TOKEN}`; }, {}, 'changed'],
    ['unreadable', (): void => { delete files['src/a.ts']; }, {}, 'changed'],
    ['workspace changed', (): void => undefined, { workspaceRef: { ...WS, rootPath: '/other' } }, 'project-changed'],
    ['project changed', (): void => undefined, { projectId: 'proj-2' }, 'project-changed'],
    ['different actor', (): void => undefined, { actorId: 'intruder' }, 'superseded'],
    ['different request', (): void => undefined, { executionPlanId: 'plan-2' }, 'superseded'],
    ['expired at dispatch time', (): void => setMinutes(30), {}, 'expired'],
  ];
  it.each(revalidationCases)(
    'revalidation failure (%s) invalidates the set and sends nothing',
    async (_name, mutate, input, reason) => {
      const { taskId } = await grantedSingle();
      mutate();
      const dispatch = vi.fn(async () => 'x');
      expect(await flow.consumeAndDispatch(store.session, dispatchInput(input), dispatch)).toEqual({ ok: false, reason });
      expect(dispatch).not.toHaveBeenCalled();
      const anchor = store.anchorOf(taskId);
      expect(anchor).toMatchObject({ status: 'INVALIDATED', invalidationReason: reason, invalidatedBy: 'system' });
      expect(anchor.grants.every((g) => g.state === 'INVALIDATED' && g.invalidationReason === reason)).toBe(true);
      expect(store.taskRows.get(taskId)!.status).toBe(TaskStatus.CANCELED);
      expect(store.session.activeTaskId).toBeUndefined();
    },
  );

  it('a moved session pointer (superseded by a newer anchor) finds nothing to consume', async () => {
    const { taskId } = await grantedSingle();
    store.session = { ...store.session, activeTaskId: 'newer-anchor' };
    const dispatch = vi.fn(async () => 'x');
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'not-found',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.anchorOf(taskId).status).toBe('GRANTED');
  });

  it('a grant decided by someone other than the owner invalidates the set (denied)', async () => {
    const raised = await raise();
    if (!raised.ok) throw new Error('raise');
    const result = await grant(raised.approval.id, 'intruder');
    expect(result).toMatchObject({ ok: false, reason: 'denied' });
    expect(store.session.activeTaskId).toBeUndefined();
  });

  it('recordGrant for an undecided request fails closed', async () => {
    const raised = await raise();
    if (!raised.ok) throw new Error('raise');
    const result = await flow.recordGrant(store.session, raised.approval.id);
    expect(result).toMatchObject({ ok: false, reason: 'inconsistent', pendingApproval: { id: raised.approval.id } });
    expect(await flow.recordGrant(store.session, raised.approval.id)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('recordGrant past the TTL invalidates the set (expired)', async () => {
    const raised = await raise();
    if (!raised.ok) throw new Error('raise');
    await decide(raised.approval.id, true);
    setMinutes(31);
    expect(await flow.recordGrant(store.session, raised.approval.id)).toMatchObject({ ok: false, reason: 'expired' });
  });
});

describe('StatelessCredentialOverrideFlow — multi-file sets', () => {
  it('each refused file needs its own CRITICAL override; one dispatch only after the last grant', async () => {
    const { taskId } = await grantedSingle();
    const second = await raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(store.session.activeTaskId).toBe(taskId); // the same anchor Task, extended in place
    expect(store.approvalRows.get(second.approval.id)!.riskLevel).toBe(RiskLevel.CRITICAL);
    expect(store.anchorOf(taskId).grants.map((g) => [g.path, g.state])).toEqual([
      ['src/a.ts', 'GRANTED'],
      ['src/b.ts', 'PENDING'],
    ]);
    const dispatch = vi.fn(async (grants: readonly CredentialOverrideGrant[]) => grants.map((g) => g.path));
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'not-granted',
    });
    expect((await grant(second.approval.id)).ok).toBe(true);
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: true, value: ['src/a.ts', 'src/b.ts'],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('the oldest override bounds the whole set', async () => {
    await grantedSingle();
    setMinutes(20);
    const second = await raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    if (!second.ok) throw new Error('raise');
    setMinutes(25);
    expect(await flow.findPending(store.session)).toMatchObject({ state: 'awaiting-decision', remainingMs: 5 * 60_000 });
    setMinutes(30);
    expect(await flow.findPending(store.session)).toMatchObject({
      state: 'invalidated', reason: 'expired', pendingApproval: { id: second.approval.id },
    });
  });

  it('rejects a duplicate target and more than the maximum number of targets', async () => {
    await grantedSingle();
    expect(await raise(refusalOf('./src/a.ts', ASSIGN_A, 3))).toEqual({ ok: false, reason: 'duplicate-target' });
    for (let i = 1; i < MAX_CREDENTIAL_OVERRIDE_GRANTS; i++) {
      const raised = await raise(refusalOf(`src/f${i}.ts`, ASSIGN_B, 1, i));
      if (!raised.ok) throw new Error(raised.reason);
      expect((await grant(raised.approval.id)).ok).toBe(true);
    }
    expect(await raise(refusalOf('src/f9.ts', ASSIGN_B, 1, 9))).toEqual({ ok: false, reason: 'too-many-targets' });
  });

  it('a granted set never takes a target from a different request or workspace', async () => {
    const { taskId } = await grantedSingle();
    const otherWorkspace = { ...request, workspaceRef: { ...WS, rootPath: '/elsewhere' } };
    const result = await flow.requestOverride(
      store.session,
      { request: otherWorkspace, outcome, ownerActorId: OWNER, refusal: refusalOf('src/b.ts', ASSIGN_B, 1, 1) },
      approvals,
    );
    expect(result).toEqual({ ok: false, reason: 'chain-invalid', pendingApproval: null });
    expect(store.anchorOf(taskId)).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'superseded' });
    expect(store.approvalRows.size).toBe(1);
  });

  it('raising while a decision is still pending invalidates the chain (no second prompt in place)', async () => {
    const first = await raise();
    if (!first.ok) throw new Error('raise');
    const taskId = store.session.activeTaskId!;
    const result = await raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    expect(result).toEqual({ ok: false, reason: 'chain-invalid', pendingApproval: expect.objectContaining({ id: first.approval.id }) });
    expect(store.anchorOf(taskId)).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'superseded' });
    expect(store.approvalRows.size).toBe(1);
  });
});

describe('StatelessCredentialOverrideFlow — reconstruction and invalidation', () => {
  it('rebuilds a pending set from storage alone after a restart', async () => {
    await raise();
    const restarted = new StatelessCredentialOverrideFlow(store);
    expect(await restarted.findPending(store.session)).toMatchObject({ state: 'awaiting-decision' });
  });

  it('after a restart, a PENDING grant whose request was rejected invalidates the set (denied)', async () => {
    const raised = await raise();
    if (!raised.ok) throw new Error('raise');
    const taskId = store.session.activeTaskId!;
    await decide(raised.approval.id, false);
    const lookup = await new StatelessCredentialOverrideFlow(store).findPending(store.session);
    expect(lookup).toMatchObject({ state: 'invalidated', reason: 'denied', pendingApproval: null });
    expect(store.session.activeTaskId).toBeUndefined();
    expect(store.taskRows.get(taskId)!.status).toBe(TaskStatus.CANCELED);
  });

  it('an expired PENDING request invalidates the set and is handed back for the system/expired decision', async () => {
    const raised = await raise();
    if (!raised.ok) throw new Error('raise');
    setMinutes(30);
    const lookup = await flow.findPending(store.session);
    expect(lookup).toMatchObject({ state: 'invalidated', reason: 'expired', pendingApproval: { id: raised.approval.id } });
    expect(store.approvalRows.get(raised.approval.id)!.status).toBe(ApprovalStatus.PENDING); // Approval-owned
    expect(await flow.findPending(store.session)).toBeNull();
  });

  it('after a restart, a GRANTED set past the TTL is invalidated (expired)', async () => {
    await grantedSingle();
    setMinutes(31);
    expect(await new StatelessCredentialOverrideFlow(store).findPending(store.session)).toMatchObject({
      state: 'invalidated', reason: 'expired',
    });
  });

  it('a project change auto-invalidates the set and releases the pointer', async () => {
    const raised = await raise();
    const taskId = store.session.activeTaskId!;
    store.session = { ...store.session, activeProjectId: 'proj-2' };
    const lookup = await flow.findPending(store.session);
    expect(lookup).toMatchObject({
      state: 'invalidated', reason: 'project-changed', pendingApproval: { id: raised.ok && raised.approval.id },
    });
    expect(store.session.activeTaskId).toBeUndefined();
    expect(store.taskRows.get(taskId)).toBeDefined(); // the row stays as the audit record
  });

  it('reset invalidates every unconsumed grant, keeps the row and releases the pointer', async () => {
    await grantedSingle();
    await raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    const taskId = store.session.activeTaskId!;
    const result = await flow.invalidate(store.session, 'reset', OWNER);
    expect(result).toMatchObject({
      state: 'invalidated', anchor: { status: 'INVALIDATED', invalidationReason: 'reset', invalidatedBy: OWNER },
    });
    expect(store.anchorOf(taskId).grants.map((g) => [g.state, g.invalidationReason])).toEqual([
      ['INVALIDATED', 'reset'],
      ['INVALIDATED', 'reset'],
    ]);
    expect(store.taskRows.get(taskId)!.status).toBe(TaskStatus.CANCELED);
    expect(store.session.activeTaskId).toBeUndefined();
  });

  it('denial invalidates the whole set (no partial dispatch)', async () => {
    await grantedSingle();
    const second = await raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    if (!second.ok) throw new Error('raise');
    const taskId = store.session.activeTaskId!;
    await decide(second.approval.id, false);
    await flow.invalidate(store.session, 'denied', OWNER);
    expect(store.anchorOf(taskId).grants.every((g) => g.state === 'INVALIDATED')).toBe(true);
    const dispatch = vi.fn(async () => 'x');
    store.session = { ...store.session, activeTaskId: taskId };
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'denied',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('clear on our unconsumed anchor invalidates it as superseded; a consumed anchor only releases the pointer', async () => {
    await raise();
    const pendingTask = store.session.activeTaskId!;
    await flow.clear(store.session);
    expect(store.anchorOf(pendingTask)).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'superseded' });
    expect(store.session.activeTaskId).toBeUndefined();

    store.session = { ...store.session, activeTaskId: requestTask.id };
    const { taskId } = await grantedSingle();
    await flow.consumeAndDispatch(store.session, dispatchInput(), async () => 'ok');
    await flow.clear(store.session);
    expect(store.anchorOf(taskId).status).toBe('CONSUMED');
    expect(store.session.activeTaskId).toBeUndefined();
  });
});

/** A reader whose reads block until `open()` — holds a dispatch between its first read and its consume save. */
const gatedReader = () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    open,
    reading,
    reader: {
      read: async (ref: WorkspaceRef, path: string): Promise<string> => {
        entered();
        await gate;
        return reader.read(ref, path);
      },
    },
  };
};

describe('StatelessCredentialOverrideFlow — concurrency and partial failures', () => {
  it('a reset landing mid-dispatch is never overwritten: it waits for the consume and reports "consumed"', async () => {
    const { taskId } = await grantedSingle();
    const turn = store.session;
    const gated = gatedReader();
    const dispatch = vi.fn(async () => 'sent');
    const dispatching = flow.consumeAndDispatch(turn, dispatchInput({ reader: gated.reader }), dispatch);
    await gated.reading; // the dispatch has read the anchor and is re-reading content
    let resetSettled = false;
    const resetting = flow.invalidate(turn, 'reset', OWNER).then((r) => {
      resetSettled = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resetSettled).toBe(false); // serialized behind the in-flight revalidate-and-consume
    expect(store.anchorOf(taskId).status).toBe('GRANTED'); // the reset did not write a row the dispatch then overwrites
    gated.open();
    expect(await dispatching).toEqual({ ok: true, value: 'sent' });
    // The reset never claims "nothing was sent": the set was already consumed.
    expect(await resetting).toMatchObject({ state: 'consumed', anchor: { status: 'CONSUMED' } });
    expect(store.anchorOf(taskId).status).toBe('CONSUMED');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a reset queued before the dispatch wins: the set is INVALIDATED{reset} and nothing is sent', async () => {
    const { taskId } = await grantedSingle();
    const turn = store.session;
    const resetting = flow.invalidate(turn, 'reset', OWNER);
    const dispatch = vi.fn(async () => 'sent');
    const dispatching = flow.consumeAndDispatch(turn, dispatchInput(), dispatch);
    expect(await resetting).toMatchObject({ state: 'invalidated', anchor: { status: 'INVALIDATED', invalidationReason: 'reset' } });
    expect(await dispatching).toEqual({ ok: false, reason: 'reset' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.anchorOf(taskId)).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'reset' });
  });

  it('a clear or a new raise mid-dispatch also waits and never re-opens the consumed set', async () => {
    const { taskId } = await grantedSingle();
    const turn = store.session;
    const gated = gatedReader();
    const dispatching = flow.consumeAndDispatch(turn, dispatchInput({ reader: gated.reader }), async () => 'sent');
    await gated.reading;
    const clearing = flow.clear(turn);
    const raising = raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    gated.open();
    expect(await dispatching).toEqual({ ok: true, value: 'sent' });
    await clearing;
    expect(await raising).toMatchObject({ ok: false });
    expect(store.anchorOf(taskId).status).toBe('CONSUMED');
    expect(store.approvalRows.size).toBe(1); // no CRITICAL request raised against the consumed set
  });

  it('a pointer moved outside the flow mid-dispatch sends nothing and leaves the new pointer alone', async () => {
    for (const moved of [undefined, 'newer-anchor']) {
      store.session = { ...store.session, activeTaskId: requestTask.id };
      const { taskId } = await grantedSingle();
      const turn = store.session;
      const gated = gatedReader();
      const dispatch = vi.fn(async () => 'sent');
      const dispatching = flow.consumeAndDispatch(turn, dispatchInput({ reader: gated.reader }), dispatch);
      await gated.reading;
      store.session = { ...store.session, activeTaskId: moved }; // e.g. a runtime reset that bypasses the flow
      gated.open();
      expect(await dispatching).toEqual({ ok: false, reason: 'superseded' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.anchorOf(taskId)).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'superseded' });
      expect(store.session.activeTaskId).toBe(moved);
    }
  });

  it('a row rewritten outside the flow mid-dispatch is never overwritten with CONSUMED', async () => {
    const { taskId } = await grantedSingle();
    const turn = store.session;
    const gated = gatedReader();
    const dispatch = vi.fn(async () => 'sent');
    const dispatching = flow.consumeAndDispatch(turn, dispatchInput({ reader: gated.reader }), dispatch);
    await gated.reading;
    const row = store.taskRows.get(taskId)!;
    const anchor = store.anchorOf(taskId);
    store.taskRows.set(taskId, {
      ...row,
      updatedAt: '2026-10-02T00:00:01.000Z',
      metadata: { [ANCHOR_KEY]: { ...anchor, status: 'INVALIDATED', invalidationReason: 'reset', updatedAt: '2026-10-02T00:00:01.000Z' } },
    });
    gated.open();
    expect(await dispatching).toEqual({ ok: false, reason: 'reset' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.anchorOf(taskId)).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'reset' });
  });

  it('a failed anchor save hands the just-created CRITICAL request back so the caller can close it', async () => {
    const approvalFlow = new StatelessApprovalFlow(store);
    store.failTaskSave = () => true;
    const result = await raise();
    expect(result).toMatchObject({ ok: false, reason: 'anchor-failed', pendingApproval: { riskLevel: RiskLevel.CRITICAL } });
    if (result.ok || !result.pendingApproval) throw new Error('expected anchor-failed');
    expect(store.session.activeTaskId).toBe(requestTask.id);
    // Left PENDING, the plan-approval flow WOULD surface it to the plain "승인" vocabulary ...
    expect(await approvalFlow.findPending(store.session)).toMatchObject({ id: result.pendingApproval.id });
    // ... so the caller closes it as rejected, and nothing is left for the plan path.
    await decide(result.pendingApproval.id, false);
    expect(await approvalFlow.findPending(store.session)).toBeNull();
  });

  it('a failed pointer move invalidates the unreachable anchor row and hands the request back', async () => {
    store.failSessionSave = () => true;
    const result = await raise();
    expect(result).toMatchObject({ ok: false, reason: 'anchor-failed', pendingApproval: { riskLevel: RiskLevel.CRITICAL } });
    expect(store.session.activeTaskId).toBe(requestTask.id);
    const rows = [...store.taskRows.values()].filter((t) => t.id !== requestTask.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata?.[ANCHOR_KEY]).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'inconsistent' });
  });

  it('a failed extension save keeps the GRANTED set and hands the new request back', async () => {
    const { taskId } = await grantedSingle();
    store.failTaskSave = () => true;
    const result = await raise(refusalOf('src/b.ts', ASSIGN_B, 1, 1));
    expect(result).toMatchObject({ ok: false, reason: 'anchor-failed', pendingApproval: { riskLevel: RiskLevel.CRITICAL } });
    expect(store.anchorOf(taskId).status).toBe('GRANTED');
    expect(store.anchorOf(taskId).grants).toHaveLength(1);
  });
});

describe('StatelessCredentialOverrideFlow — canonical session and TTL races at dispatch (ADR-0097 D5, ADR-0095 §5)', () => {
  /** Runs `onConsume` synchronously inside the CONSUMED anchor save, i.e. while that persistence await is pending. */
  const duringConsumeSave = (onConsume: () => void): void => {
    store.failTaskSave = (task) => {
      if ((task.metadata?.[ANCHOR_KEY] as CredentialOverrideAnchor)?.status === 'CONSUMED') onConsume();
      return false;
    };
  };

  type SessionRace = readonly [name: string, change: (s: Session) => Session, reason: CredentialOverrideInvalidationReason];
  const sessionRaces: readonly SessionRace[] = [
    ['the project changes', (s) => ({ ...s, activeProjectId: 'proj-2' }), 'project-changed'],
    ['the session is closed by a reset', (s) => ({ ...s, status: SessionStatus.CLOSED }), 'reset'],
  ];

  it.each(sessionRaces)(
    'when %s while the content is re-read, nothing is sent and the new session state is kept',
    async (_name, change, reason) => {
      const { taskId } = await grantedSingle();
      const turn = store.session; // the turn's (soon stale) copy
      const gated = gatedReader();
      const dispatch = vi.fn(async () => 'sent');
      const dispatching = flow.consumeAndDispatch(turn, dispatchInput({ reader: gated.reader }), dispatch);
      await gated.reading;
      store.session = change(store.session); // a canonical session write that bypasses the flow
      const changed = clone(store.session);
      gated.open();
      expect(await dispatching).toEqual({ ok: false, reason });
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.anchorOf(taskId)).toMatchObject({ status: 'INVALIDATED', invalidationReason: reason });
      // Only the pointer this flow owns was cleared; the stale turn copy was never written back.
      expect(store.session).toEqual({ ...changed, activeTaskId: undefined });
    },
  );

  it.each(sessionRaces)(
    'when %s while the consume save is pending, nothing is sent and the set stays CONSUMED',
    async (_name, change, reason) => {
      const { taskId } = await grantedSingle();
      const turn = store.session;
      let changed!: Session;
      duringConsumeSave(() => {
        store.session = change(store.session);
        changed = clone(store.session);
      });
      const dispatch = vi.fn(async () => 'sent');
      expect(await flow.consumeAndDispatch(turn, dispatchInput(), dispatch)).toEqual({ ok: false, reason });
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.anchorOf(taskId).status).toBe('CONSUMED'); // terminal: never re-opened, never replayed
      expect(store.session).toEqual({ ...changed, activeTaskId: undefined });
      store.failTaskSave = null;
      const stale = { ...turn, activeTaskId: taskId };
      expect(await flow.consumeAndDispatch(stale, dispatchInput(), dispatch)).toEqual({ ok: false, reason: 'already-used' });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('the pointer release never writes back stale fields of the turn copy', async () => {
    const { taskId } = await grantedSingle();
    const turn = store.session;
    const gated = gatedReader();
    const dispatching = flow.consumeAndDispatch(turn, dispatchInput({ reader: gated.reader }), async () => 'sent');
    await gated.reading;
    store.session = { ...store.session, lastActivityAt: '2026-10-02T00:00:05.000Z', metadata: { note: 'kept' } };
    gated.open();
    expect(await dispatching).toEqual({ ok: true, value: 'sent' });
    expect(store.anchorOf(taskId).status).toBe('CONSUMED');
    expect(store.session.activeTaskId).toBeUndefined();
    expect(store.session).toMatchObject({ lastActivityAt: '2026-10-02T00:00:05.000Z', metadata: { note: 'kept' } });
  });

  it('a consume at 29:59.999 whose save completes at 30:00 sends nothing, stays CONSUMED and reports expired', async () => {
    let nowMs = Date.parse(T0);
    flow = new StatelessCredentialOverrideFlow(store, { clock: () => new Date(nowMs).toISOString() });
    const { taskId } = await grantedSingle(); // the CRITICAL request was created at T0 (TTL 30 min)
    nowMs = Date.parse(T0) + 30 * 60_000 - 1; // 29:59.999 — every pre-save expiry check still passes
    duringConsumeSave(() => {
      nowMs = Date.parse(T0) + 30 * 60_000; // the save completes at 30:00.000
    });
    const dispatch = vi.fn(async () => 'sent');
    expect(await flow.consumeAndDispatch(store.session, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'expired',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.anchorOf(taskId)).toMatchObject({ status: 'CONSUMED', consumedAt: '2026-10-02T00:29:59.999Z' });
    expect(store.session.activeTaskId).toBeUndefined();
    // Non-replayable: a stale copy still pointing at the anchor never dispatches it.
    store.failTaskSave = null;
    const stale = { ...store.session, activeTaskId: taskId };
    expect(await flow.consumeAndDispatch(stale, dispatchInput(), dispatch)).toEqual({ ok: false, reason: 'already-used' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('happy path with the injected clock: dispatched once just inside the TTL, then "already used"', async () => {
    let nowMs = Date.parse(T0);
    flow = new StatelessCredentialOverrideFlow(store, { clock: () => new Date(nowMs).toISOString() });
    const { taskId } = await grantedSingle();
    nowMs = Date.parse(T0) + 30 * 60_000 - 1;
    const turn = store.session;
    const dispatch = vi.fn(async () => 'sent');
    expect(await flow.consumeAndDispatch(turn, dispatchInput(), dispatch)).toEqual({ ok: true, value: 'sent' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.anchorOf(taskId).status).toBe('CONSUMED');
    expect(store.session).toMatchObject({ status: SessionStatus.ACTIVE, activeProjectId: 'proj-1' });
    expect(store.session.activeTaskId).toBeUndefined();
    expect(await flow.consumeAndDispatch({ ...turn, activeTaskId: taskId }, dispatchInput(), dispatch)).toEqual({
      ok: false, reason: 'already-used',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('raising writes only the pointer onto the canonical session', async () => {
    const turn = store.session;
    store.session = { ...store.session, metadata: { note: 'kept' } };
    const raised = await flow.requestOverride(
      turn, { request, outcome, ownerActorId: OWNER, refusal: refusalOf('src/a.ts', ASSIGN_A, 3) }, approvals,
    );
    expect(raised.ok).toBe(true);
    expect(store.session.metadata).toEqual({ note: 'kept' });
    expect(store.session.activeTaskId).not.toBe(requestTask.id);
  });
});

describe('StatelessCredentialOverrideFlow — storage init order (ADR-0062)', () => {
  it('constructed before the storage is initialized, it resolves the repositories at call time', async () => {
    class LateStore {
      sessions!: CredentialOverrideFlowStore['sessions'];
      tasks!: CredentialOverrideFlowStore['tasks'];
      approvals!: CredentialOverrideFlowStore['approvals'];
    }
    const late = new LateStore();
    const lateFlow = new StatelessCredentialOverrideFlow(late);
    late.sessions = store.sessions;
    late.tasks = store.tasks;
    late.approvals = store.approvals;
    const result = await lateFlow.requestOverride(
      store.session, { request, outcome, ownerActorId: OWNER, refusal: refusalOf('src/a.ts', ASSIGN_A, 3) }, approvals,
    );
    expect(result.ok).toBe(true);
  });
});
