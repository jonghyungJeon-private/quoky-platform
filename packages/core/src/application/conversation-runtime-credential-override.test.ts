import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  CodeGenerationStatus,
  RiskLevel,
  SessionStatus,
  TaskStatus,
} from '../domain';
import type {
  ApprovalRequest,
  CodeGeneration,
  CodeProposal,
  ConversationContext,
  GenerateCodeInput,
  Id,
  InboundMessage,
  ProposedChange,
  Session,
  Task,
  WorkspaceDiff,
  WorkspaceRef,
} from '../domain';
import type { ConversationTurnHandler, LogFields, Logger, StorageProvider } from '../ports';
import { newId } from '../util/id';
import { ApprovalManager } from './approval-manager';
import type { ApprovalPolicy } from './approval-policy';
import { ConversationRuntime } from './conversation-runtime';
import type { ApplyPreviewAnchor, ConversationRuntimeDeps } from './conversation-runtime';
import { classifyCredentialFileContent } from './credential-guard';
import {
  CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
  CREDENTIAL_OVERRIDE_DENY_COMMENT,
  type CredentialOverrideAnchor,
  StatelessCredentialOverrideFlow,
  credentialOverrideContentSha256,
} from './credential-override';
import { ExecutionOutcomeStatus, ExecutionStage } from './execution-orchestrator';
import type { ExecutionOutcome, ExecutionRequest } from './execution-orchestrator';
import { ResponseComposer } from './response-composer';
import { StatelessApplyPreviewFlow } from './stateless-apply-preview-flow';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { StatelessScopeClarificationFlow } from './stateless-scope-clarification-flow';

// OVR-4 (ADR-0097): the REAL ConversationRuntime driven end-to-end with the REAL ApprovalManager,
// StatelessApprovalFlow, StatelessScopeClarificationFlow, StatelessApplyPreviewFlow and
// StatelessCredentialOverrideFlow over in-memory storage. Only the workspace, the orchestrator resume and the code
// generation are fakes; generate() records every input so "nothing was sent" is checked at the provider boundary.

const T0 = '2026-10-02T00:00:00.000Z';
const setMinutes = (m: number): void => {
  vi.setSystemTime(new Date(Date.parse(T0) + m * 60_000));
};

const OWNER = 'owner-1';
const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };
const WS: WorkspaceRef = { id: 'ws-1', projectId: 'proj-1', rootPath: '/repo', kind: 'local-clone' };
const ANCHOR_KEY = 'conversationCredentialOverrideAnchor';
const composer = new ResponseComposer();

/** Ordinary source the strict guard refuses (ADR-0097 D1 "strictness kept"). */
const USER_TS = 'export class User {\n  constructor(token: string) {\n    this.token = token;\n  }\n}\n';
const CONFIG_TS = 'export const config = {\n  password: "demo-only",\n};\n';
const TOKEN_TS = 'const k = "AKIAIOSFODNN7EXAMPLE";\n';
const PLAIN_TS = 'export const greet = (name: string) => `hi ${name}`;\n';

const lineOf = (content: string): number => {
  const finding = classifyCredentialFileContent(content);
  if (finding.kind !== 'credential-assignment') throw new Error(`fixture not an assignment: ${finding.kind}`);
  return finding.line;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** In-memory repositories with the shapes the stateless flows and ApprovalManager use. */
class MemoryStore {
  readonly taskRows = new Map<Id, Task>();
  readonly approvalRows = new Map<Id, ApprovalRequest>();
  readonly sessionRows = new Map<Id, Session>();
  currentSessionId: Id = 'sess-1';

  readonly sessions = {
    get: async (id: Id): Promise<Session | null> => {
      const row = this.sessionRows.get(id);
      return row ? clone(row) : null;
    },
    save: async (session: Session): Promise<Session> => {
      this.sessionRows.set(session.id, clone(session));
      return session;
    },
  };
  readonly tasks = {
    get: async (id: Id): Promise<Task | null> => {
      const row = this.taskRows.get(id);
      return row ? clone(row) : null;
    },
    save: async (task: Task): Promise<Task> => {
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

  get session(): Session {
    return this.sessionRows.get(this.currentSessionId)!;
  }

  activeTask(): Task | undefined {
    const id = this.session.activeTaskId;
    return id ? this.taskRows.get(id) : undefined;
  }

  overrideTasks(): Task[] {
    return [...this.taskRows.values()].filter((t) => t.metadata?.[ANCHOR_KEY]);
  }

  overrideAnchor(): CredentialOverrideAnchor {
    const tasks = this.overrideTasks();
    return tasks[tasks.length - 1]!.metadata![ANCHOR_KEY] as CredentialOverrideAnchor;
  }

  critical(): ApprovalRequest[] {
    return [...this.approvalRows.values()].filter((r) => r.riskLevel === RiskLevel.CRITICAL);
  }
}

interface Harness {
  store: MemoryStore;
  approvals: ApprovalManager;
  approvalFlow: StatelessApprovalFlow;
  flow: StatelessCredentialOverrideFlow;
  files: Record<string, string>;
  generated: GenerateCodeInput[];
  logs: Array<{ level: string; message: string; fields?: LogFields }>;
  classifierCalls: number;
  handlerCalls: string[];
  /** Hook run inside memory.recordShortTerm (after the turn-start checks, before routing). */
  onShortTerm: (() => void) | null;
  /** Count of workspace.read calls; `onRead` runs inside each one (awaited) before the content is returned. */
  reads: number;
  onRead: ((n: number, path: string) => void | Promise<void>) | null;
  /** Awaited inside generate() after the input is recorded: a controllable provider call. */
  onGenerate: (() => Promise<void>) | null;
  runtime: ConversationRuntime;
  send(text: string): ReturnType<ConversationRuntime['handle']>;
  /** Anchor a fresh planningOnly CODE_IMPLEMENTATION request awaiting its plan approval. */
  startRequest(targetFiles: string[], newFileTargets?: string[]): Promise<ExecutionRequest>;
}

let planSeq = 0;

function makeHarness(opts: { withFlow?: boolean; turnHandlers?: ConversationTurnHandler[] } = {}): Harness {
  const store = new MemoryStore();
  store.sessionRows.set('sess-1', {
    id: 'sess-1',
    actorId: OWNER,
    context: CTX,
    status: SessionStatus.ACTIVE,
    activeProjectId: 'proj-1',
    createdAt: T0,
    lastActivityAt: T0,
  });
  const approvals = new ApprovalManager(store as unknown as StorageProvider, {} as ApprovalPolicy);
  const approvalFlow = new StatelessApprovalFlow(store as unknown as StorageProvider);
  const flow = new StatelessCredentialOverrideFlow(store);
  const h = {
    store,
    approvals,
    approvalFlow,
    flow,
    files: {} as Record<string, string>,
    generated: [] as GenerateCodeInput[],
    logs: [] as Harness['logs'],
    classifierCalls: 0,
    handlerCalls: [] as string[],
    onShortTerm: null as (() => void) | null,
    reads: 0,
    onRead: null,
    onGenerate: null,
  } as Harness;

  const logger: Logger = {
    info: (message, fields) => void h.logs.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => void h.logs.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => void h.logs.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
  };

  const deps = {
    dispatchCommit: { commit: async () => { throw new Error('dispatchCommit not expected'); } },
    actors: { resolveFromContext: async () => ({ id: OWNER }) },
    sessions: {
      openForContext: async (_context: ConversationContext, actorId: Id): Promise<Session> => {
        const current = store.session;
        if (current.status === SessionStatus.ACTIVE) return clone(current);
        const next: Session = {
          id: newId(), actorId, context: CTX, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0,
        };
        store.sessionRows.set(next.id, clone(next));
        store.currentSessionId = next.id;
        return clone(next);
      },
      touch: async (session: Session) => session,
      close: async (session: Session) => {
        const closed = { ...session, status: SessionStatus.CLOSED };
        store.sessionRows.set(session.id, clone(closed));
        return closed;
      },
    },
    memory: {
      recordShortTerm: async () => {
        h.onShortTerm?.();
        return { id: newId() };
      },
      recordAssistant: async () => undefined,
      recordToolMemory: async () => undefined,
    },
    memoryWriter: {},
    classifier: {
      classify: async () => {
        h.classifierCalls++;
        throw new Error('classifier not expected');
      },
    },
    projects: {
      register: async () => ({ ok: false, message: 'not expected' }),
      get: async (id: Id) => (id === 'proj-1' ? { id: 'proj-1', name: 'p', rootPath: '/repo', createdAt: T0 } : null),
    },
    analyzer: {},
    tasks: {},
    workspace: {
      prepare: async () => WS,
      open: async () => WS,
      list: async (_ref: WorkspaceRef, glob?: string) => (glob && h.files[glob] !== undefined ? [glob] : []),
      diff: async (_ref: WorkspaceRef, changes: ProposedChange[]): Promise<WorkspaceDiff> => ({
        refId: WS.id,
        files: changes.map((c) => ({
          path: c.path,
          changeKind: h.files[c.path] === undefined ? 'add' : 'modify',
          unified: `--- a/${c.path}\n+++ b/${c.path}\n@@ -1 +1 @@\n-old\n+${c.newContent ?? ''}\n`,
          binary: false,
        })),
        estimatedChangedLines: changes.length,
        truncated: false,
      }),
      read: async (_ref: WorkspaceRef, relPath: string): Promise<string> => {
        // The adapter refuses secret FILENAMES (ADR-0019): Core never gets their content.
        if (relPath.endsWith('.env')) throw new Error('refusing to read a secret file');
        h.reads++;
        await h.onRead?.(h.reads, relPath);
        const content = h.files[relPath];
        if (content === undefined) throw new Error('ENOENT');
        return content;
      },
    },
    commandExecutions: {},
    command: {},
    contextBuilder: {},
    promptComposer: {},
    promptRenderer: {},
    router: {},
    artifacts: {},
    composer,
    workSurface: {},
    intentResolver: { resolve: () => null, isExecution: () => false },
    orchestrator: {
      run: async () => { throw new Error('orchestrator.run not expected'); },
      resume: async (_request: ExecutionRequest, prior: ExecutionOutcome): Promise<ExecutionOutcome> => ({
        ...prior,
        status: ExecutionOutcomeStatus.COMPLETED,
      }),
    },
    approvals,
    approvalFlow,
    scopeClarificationFlow: new StatelessScopeClarificationFlow(store as unknown as StorageProvider),
    applyPreviewFlow: new StatelessApplyPreviewFlow(store as unknown as StorageProvider),
    codeGeneration: {
      generate: async (input: GenerateCodeInput): Promise<CodeGeneration> => {
        h.generated.push(clone(input));
        await h.onGenerate?.();
        return {
          id: newId(),
          executionPlanRef: input.executionPlanRef,
          capability: Capability.CODE_IMPLEMENTATION,
          status: CodeGenerationStatus.SUCCEEDED,
          codeProposalRef: { id: 'prop-1', status: CodeGenerationStatus.SUCCEEDED },
          createdAt: T0,
          updatedAt: T0,
        };
      },
      getProposal: async (generation: CodeGeneration): Promise<CodeProposal> => ({
        id: 'prop-1',
        codeGenerationRef: { id: generation.id, status: CodeGenerationStatus.SUCCEEDED },
        proposal: (h.generated[h.generated.length - 1]?.targetFiles ?? []).map((path) => ({
          path,
          newContent: 'export const fixed = true;\n',
        })),
        providerId: 'fake',
        createdAt: T0,
      }),
    },
    patch: {},
    codeProposals: {},
    workspaceWrite: {},
    git: {},
    turnHandlers: opts.turnHandlers ?? [],
    ...(opts.withFlow === false ? {} : { credentialOverrideFlow: flow }),
    logger,
  } as unknown as ConversationRuntimeDeps;

  h.runtime = new ConversationRuntime(deps);
  let seq = 0;
  h.send = (text: string) => {
    const message: InboundMessage = { id: `m-${++seq}`, context: CTX, text, receivedAt: new Date().toISOString() };
    return h.runtime.handle(message);
  };
  h.startRequest = async (targetFiles: string[], newFileTargets?: string[]): Promise<ExecutionRequest> => {
    const planId = `plan-${++planSeq}`;
    const request: ExecutionRequest = {
      goal: '로그인 버그 고쳐줘',
      instruction: '로그인 버그 고쳐줘',
      requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
      requestedBy: OWNER,
      planningOnly: true,
      workspaceRef: WS,
      targetFiles,
      ...(newFileTargets ? { newFileTargets } : {}),
    };
    const outcome: ExecutionOutcome = {
      status: ExecutionOutcomeStatus.AWAITING_APPROVAL,
      lastStage: ExecutionStage.PLANNING,
      selectedStages: [ExecutionStage.PLANNING],
      refs: { executionPlanRef: { id: planId, goal: request.goal } },
    };
    await approvals.requestForRisk({
      executionPlanRef: { id: planId, goal: request.goal },
      riskLevel: RiskLevel.HIGH,
      reason: 'code change needs approval',
      requestedBy: OWNER,
    });
    await approvalFlow.anchor(store.session, request, outcome);
    return request;
  };
  return h;
}

const PROMPT_USER = () => composer.composeCredentialOverridePrompt(CTX, 'src/user.ts', lineOf(USER_TS)).text;

/** The plan approval turn that hits the refusal and raises the first override. */
async function promptFor(h: Harness, targets: string[] = ['src/user.ts']) {
  await h.startRequest(targets);
  return h.send('승인');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConversationRuntime credential override — raising the CRITICAL override (ADR-0097 D3)', () => {
  it('a refused assignment file → zero generate(), a CRITICAL PENDING approval (hash/index/line, no path/content), an anchor, AWAITING_APPROVAL', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;

    const result = await promptFor(h);

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).toBe(PROMPT_USER());
    expect(result.reply.text).toContain('src/user.ts');
    expect(result.reply.text).toContain(`${lineOf(USER_TS)}번째 줄`);
    expect(result.reply.text).toContain('"그래도 보내줘"');
    expect(result.reply.text).not.toContain('this.token');
    expect(h.generated).toHaveLength(0);

    const [critical, ...rest] = h.store.critical();
    expect(rest).toHaveLength(0);
    expect(critical!.status).toBe(ApprovalStatus.PENDING);
    expect(critical!.requestedBy).toBe(OWNER);
    expect(critical!.reason).toContain(`sha256=${credentialOverrideContentSha256(USER_TS)}`);
    expect(critical!.reason).toContain('target #0');
    expect(critical!.reason).toContain(`line=${lineOf(USER_TS)}`);
    expect(critical!.reason).not.toContain('src/user.ts');
    expect(critical!.reason).not.toContain('this.token');

    const task = h.store.activeTask()!;
    expect(task.planId).toBeUndefined();
    expect(task.status).toBe(TaskStatus.WAITING_APPROVAL);
    expect(task.riskLevel).toBe(RiskLevel.CRITICAL);
    const anchor = task.metadata![ANCHOR_KEY] as CredentialOverrideAnchor;
    expect(anchor.status).toBe('PENDING');
    expect(anchor.grants).toHaveLength(1);
    expect(anchor.grants[0]).toMatchObject({ path: 'src/user.ts', approvalRequestId: critical!.id, state: 'PENDING' });
  });

  it('StatelessApprovalFlow never picks up the override approval (plan-less anchor), so "승인" re-prompts', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);

    expect(await h.approvalFlow.findPending(h.store.session)).toBeNull();
    const result = await h.send('승인');

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).toContain('"승인", "좋아", "ok"로는 보내지 않아요.');
    expect(h.store.critical()[0]!.status).toBe(ApprovalStatus.PENDING);
    expect(h.generated).toHaveLength(0);
  });

  it('a secret-token file → hard refusal (never overridable), no CRITICAL approval, no generate()', async () => {
    const h = makeHarness();
    h.files['src/keys.ts'] = TOKEN_TS;

    const result = await promptFor(h, ['src/keys.ts']);

    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideHardRefused(CTX, 'src/keys.ts').text);
    expect(result.reply.text).toContain('확인을 받아도 보낼 수 없어요');
    expect(h.store.critical()).toHaveLength(0);
    expect(h.store.overrideTasks()).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  });

  it('a secret-token target anywhere in the set fails the whole set with no prompt', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    h.files['src/keys.ts'] = TOKEN_TS;

    const result = await promptFor(h, ['src/user.ts', 'src/keys.ts']);

    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideHardRefused(CTX, 'src/keys.ts').text);
    expect(h.store.critical()).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  });

  it('a secret FILENAME target is unreadable in the adapter: failed preview, no override offered', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;

    const result = await promptFor(h, ['src/user.ts', 'config/.env']);

    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(composer.composeCodeGenerationPreviewFailed(CTX).text);
    expect(h.store.critical()).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  });

  it('without credentialOverrideFlow the refusal stays terminal exactly as before (no approval, no phrase)', async () => {
    const h = makeHarness({ withFlow: false });
    h.files['src/user.ts'] = USER_TS;

    const result = await promptFor(h);

    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(composer.composeCodeGenerationPreviewCredentialRefused(CTX, 'src/user.ts').text);
    expect(h.store.critical()).toHaveLength(0);
    expect(h.store.overrideTasks()).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  });
});

describe('ConversationRuntime credential override — decisions (ADR-0097 D3/D5)', () => {
  it('"그래도 보내줘" → exactly one generate() with the file, APPROVED by the owner, anchor CONSUMED/COMPLETED, notice + ELIGIBLE apply anchor', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const overrideTaskId = h.store.session.activeTaskId!;

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('RESPONDED');
    expect(h.generated).toHaveLength(1);
    expect(h.generated[0]!.contextFiles).toEqual([{ path: 'src/user.ts', content: USER_TS }]);
    const notice = composer.composeCredentialOverrideSentNotice(CTX, ['src/user.ts']).text;
    expect(result.reply.text.startsWith(notice)).toBe(true);
    expect(result.reply.preview?.header.startsWith(notice)).toBe(true);

    const critical = h.store.critical()[0]!;
    expect(critical.status).toBe(ApprovalStatus.APPROVED);
    expect(critical.decidedBy).toBe(OWNER);
    expect(critical.comment).toBe(CREDENTIAL_OVERRIDE_APPROVE_COMMENT);

    const overrideTask = h.store.taskRows.get(overrideTaskId)!;
    expect(overrideTask.status).toBe(TaskStatus.COMPLETED);
    const anchor = overrideTask.metadata![ANCHOR_KEY] as CredentialOverrideAnchor;
    expect(anchor.status).toBe('CONSUMED');
    expect(anchor.grants.every((g) => g.state === 'CONSUMED')).toBe(true);

    const apply = h.store.activeTask()!.metadata?.conversationApplyPreviewAnchor as ApplyPreviewAnchor | undefined;
    expect(apply?.status).toBe('ELIGIBLE');
    expect(apply?.targetFiles).toEqual(['src/user.ts']);
  });

  it.each(['승인', 'ok', '좋아', '이 파일 그냥 고쳐줘', '그래도 보내줘?'])(
    '"%s" → re-prompt with the remaining time, still PENDING, no generate(), no classifier',
    async (text) => {
      const h = makeHarness();
      h.files['src/user.ts'] = USER_TS;
      await promptFor(h);
      setMinutes(10);

      const result = await h.send(text);

      expect(result.status).toBe('AWAITING_APPROVAL');
      expect(result.reply.text).toBe(composer.composeCredentialOverrideReprompt(CTX, 'src/user.ts', 20 * 60_000).text);
      expect(h.store.critical()[0]!.status).toBe(ApprovalStatus.PENDING);
      expect(h.store.overrideAnchor().status).toBe('PENDING');
      expect(h.generated).toHaveLength(0);
      expect(h.classifierCalls).toBe(0);
    },
  );

  it.each(['취소', '거절', '보내지 마'])('"%s" → REJECTED by the owner, set INVALIDATED{denied}, no generate()', async (text) => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const overrideTaskId = h.store.session.activeTaskId!;

    const result = await h.send(text);

    expect(result.status).toBe('DENIED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideDenied(CTX, 'src/user.ts').text);
    const critical = h.store.critical()[0]!;
    expect(critical.status).toBe(ApprovalStatus.REJECTED);
    expect(critical.decidedBy).toBe(OWNER);
    expect(critical.comment).toBe(CREDENTIAL_OVERRIDE_DENY_COMMENT);
    const task = h.store.taskRows.get(overrideTaskId)!;
    expect(task.status).toBe(TaskStatus.CANCELED);
    expect((task.metadata![ANCHOR_KEY] as CredentialOverrideAnchor).invalidationReason).toBe('denied');
    expect(h.store.session.activeTaskId).toBeUndefined();
    expect(h.generated).toHaveLength(0);
    // A later send phrase has nothing to send.
    expect((await h.send('그래도 보내줘')).reply.text).toBe(composer.composeNoPendingCredentialOverride(CTX).text);
    expect(h.generated).toHaveLength(0);
  });

  it('"새 대화" → REJECTED (reset, by the owner), set INVALIDATED{reset} first, session closed, no generate()', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const overrideTaskId = h.store.session.activeTaskId!;
    const sessionId = h.store.session.id;

    const result = await h.send('새 대화');

    expect(result.reply.text).toBe(
      composer.composeConversationReset(CTX, { deniedPendingApproval: true }).text,
    );
    const critical = h.store.critical()[0]!;
    expect(critical.status).toBe(ApprovalStatus.REJECTED);
    expect(critical.decidedBy).toBe(OWNER);
    expect(critical.comment).toBe('reset');
    const anchor = h.store.taskRows.get(overrideTaskId)!.metadata![ANCHOR_KEY] as CredentialOverrideAnchor;
    expect(anchor.status).toBe('INVALIDATED');
    expect(anchor.invalidationReason).toBe('reset');
    expect(anchor.invalidatedBy).toBe(OWNER);
    expect(h.store.sessionRows.get(sessionId)!.status).toBe(SessionStatus.CLOSED);
    expect(h.generated).toHaveLength(0);
  });
});

describe('ConversationRuntime credential override — expiry, change, multi-target (ADR-0097 D5)', () => {
  it('past 30 minutes → recorded system/expired at turn start, set INVALIDATED{expired}, no generate()', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const overrideTaskId = h.store.session.activeTaskId!;
    setMinutes(31);

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('DENIED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideInvalidated(CTX, 'expired').text);
    const critical = h.store.critical()[0]!;
    expect(critical.status).toBe(ApprovalStatus.REJECTED);
    expect(critical.decidedBy).toBe('system');
    expect(critical.comment).toBe('expired');
    const anchor = h.store.taskRows.get(overrideTaskId)!.metadata![ANCHOR_KEY] as CredentialOverrideAnchor;
    expect(anchor.invalidationReason).toBe('expired');
    expect(h.generated).toHaveLength(0);
  });

  it('expiry found by the synchronous re-check right before decide (mid-turn) → system/expired, no generate()', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    setMinutes(29);
    h.onShortTerm = () => setMinutes(31); // live at turn start, past the deadline when the send is decided

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('DENIED');
    const critical = h.store.critical()[0]!;
    expect(critical.status).toBe(ApprovalStatus.REJECTED);
    expect(critical.decidedBy).toBe('system');
    expect(critical.comment).toBe('expired');
    expect(h.store.overrideAnchor().invalidationReason).toBe('expired');
    expect(h.generated).toHaveLength(0);
  });

  it('file content edited between prompt and confirm → content-changed reply, set INVALIDATED{changed}, no generate()', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    h.files['src/user.ts'] = `${USER_TS}// edited\n`;

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideContentChanged(CTX, 'src/user.ts').text);
    expect(h.store.overrideAnchor().status).toBe('INVALIDATED');
    expect(h.store.overrideAnchor().invalidationReason).toBe('changed');
    expect(h.generated).toHaveLength(0);
  });

  it('two refused targets → two sequential CRITICAL overrides; generate() once, only after the second confirm, with both files', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    h.files['src/config.ts'] = CONFIG_TS;
    await h.startRequest(['src/user.ts', 'src/config.ts', 'src/new.ts'], ['src/new.ts']);

    const first = await h.send('승인');
    expect(first.reply.text).toBe(PROMPT_USER());
    const second = await h.send('그래도 보내줘');
    expect(second.status).toBe('AWAITING_APPROVAL');
    expect(second.reply.text).toBe(composer.composeCredentialOverridePrompt(CTX, 'src/config.ts', lineOf(CONFIG_TS)).text);
    expect(h.generated).toHaveLength(0);
    expect(h.store.critical()).toHaveLength(2);
    expect(h.store.overrideTasks()).toHaveLength(1); // one anchor per original request

    const done = await h.send('그래도 보내줘');

    expect(done.status).toBe('RESPONDED');
    expect(h.generated).toHaveLength(1);
    expect(h.generated[0]!.contextFiles).toEqual([
      { path: 'src/user.ts', content: USER_TS },
      { path: 'src/config.ts', content: CONFIG_TS },
    ]);
    expect(h.store.critical().map((r) => r.status)).toEqual([ApprovalStatus.APPROVED, ApprovalStatus.APPROVED]);
    expect(h.store.overrideAnchor().status).toBe('CONSUMED');
    // ADR-0099: the grant re-run keeps the request's explicit new-file targets.
    const apply = h.store.activeTask()!.metadata?.conversationApplyPreviewAnchor as ApplyPreviewAnchor | undefined;
    expect(apply?.newFileTargets).toEqual(['src/new.ts']);
    expect(done.reply.text).toContain(composer.composeCredentialOverrideSentNotice(CTX, ['src/user.ts', 'src/config.ts']).text);
  });

  it('a project change while pending voids the set at turn start (project-changed), nothing sent', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    h.store.sessionRows.set('sess-1', { ...h.store.session, activeProjectId: 'proj-2' });

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('DENIED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideInvalidated(CTX, 'project-changed').text);
    expect(h.store.critical()[0]!.status).toBe(ApprovalStatus.REJECTED);
    expect(h.store.overrideAnchor().invalidationReason).toBe('project-changed');
    expect(h.generated).toHaveLength(0);
  });
});

describe('ConversationRuntime credential override — no replay, stray phrase, routing order', () => {
  it('a stray "그래도 보내줘" with nothing pending → deterministic reply, no provider call, no classifier', async () => {
    const h = makeHarness();

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(composer.composeNoPendingCredentialOverride(CTX).text);
    expect(h.generated).toHaveLength(0);
    expect(h.classifierCalls).toBe(0);
  });

  it('after a successful override the phrase sends nothing again, and the same file requested again prompts again', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    await h.send('그래도 보내줘');
    expect(h.generated).toHaveLength(1);

    const replay = await h.send('그래도 보내줘');
    expect(replay.reply.text).toBe(composer.composeNoPendingCredentialOverride(CTX).text);
    expect(h.generated).toHaveLength(1);

    const again = await promptFor(h);
    expect(again.status).toBe('AWAITING_APPROVAL');
    expect(again.reply.text).toBe(PROMPT_USER());
    expect(h.store.critical()).toHaveLength(2);
    expect(h.store.overrideTasks()).toHaveLength(2);
    expect(h.generated).toHaveLength(1);
  });

  it('a fully granted set whose dispatch never ran (restart) re-prompts, then sends once on the phrase', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const approvalId = h.store.critical()[0]!.id;
    await h.approvals.decide(approvalId, {
      approvalId, approved: true, decidedBy: OWNER, decidedAt: new Date().toISOString(),
      comment: CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
    });
    expect((await h.flow.recordGrant(h.store.session, approvalId)).ok).toBe(true);

    const reprompt = await h.send('ok');
    expect(reprompt.status).toBe('AWAITING_APPROVAL');
    expect(h.generated).toHaveLength(0);

    const sent = await h.send('그래도 보내줘');
    expect(sent.status).toBe('RESPONDED');
    expect(h.generated).toHaveLength(1);
    expect(h.store.overrideAnchor().status).toBe('CONSUMED');
  });

  it('a consumed set whose pointer was left behind answers "already used" and releases the pointer', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const overrideTaskId = h.store.session.activeTaskId!;
    await h.send('그래도 보내줘');
    h.store.sessionRows.set('sess-1', { ...h.store.session, activeTaskId: overrideTaskId });

    const result = await h.send('그래도 보내줘');

    expect(result.reply.text).toBe(composer.composeCredentialOverrideAlreadyUsed(CTX).text);
    expect(h.store.session.activeTaskId).toBeUndefined();
    expect(h.generated).toHaveLength(1);
  });

  it('the override intercept runs after control handlers and before post-anchor / pre-classify handlers', async () => {
    const handler = (id: string, stage: ConversationTurnHandler['stage'], claims: (text: string) => boolean): ConversationTurnHandler => ({
      id,
      stage,
      order: 0,
      async handle(ctx) {
        h.handlerCalls.push(id);
        return claims(ctx.message.text) ? { reply: { context: CTX, text: `handled by ${id}` } } : null;
      },
    });
    const h = makeHarness({
      turnHandlers: [
        handler('ctl', 'control', (t) => t === '피드백 요약'),
        handler('post', 'post-anchor', () => true),
        handler('pre', 'pre-classify', () => true),
      ],
    });
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    h.handlerCalls.length = 0;

    const reprompt = await h.send('할 일 추가: 내일 회의');
    expect(reprompt.status).toBe('AWAITING_APPROVAL');
    expect(h.handlerCalls).toEqual(['ctl']);

    const control = await h.send('피드백 요약');
    expect(control.reply.text).toBe('handled by ctl');
    expect(h.store.critical()[0]!.status).toBe(ApprovalStatus.PENDING);
  });

  it('logs carry ids, index, hash and line only — never the path or any file content', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    h.files['src/config.ts'] = CONFIG_TS;
    await h.startRequest(['src/user.ts', 'src/config.ts']);
    await h.send('승인');
    await h.send('승인');
    await h.send('그래도 보내줘');
    await h.send('그래도 보내줘');
    expect(h.generated).toHaveLength(1);

    const requested = h.logs.filter((l) => l.message === 'credential guard override requested');
    expect(requested).toHaveLength(2);
    expect(requested[0]!.fields).toMatchObject({
      targetIndex: 0,
      contentSha256: credentialOverrideContentSha256(USER_TS),
      line: lineOf(USER_TS),
    });
    expect(h.logs.filter((l) => l.message === 'credential guard override granted')).toHaveLength(2);
    const serialized = JSON.stringify(h.logs);
    for (const leak of ['src/user.ts', 'src/config.ts', 'this.token', 'demo-only']) {
      expect(serialized).not.toContain(leak);
    }
  });
});

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** The truthful reply when the request was cancelled while (or after) the granted content was sent (dedicated
 *  sent-then-cancelled copy, CODE-5 QA follow-up — it still leads with the one-time-send notice). */
const CANCELLED_AFTER_SEND = (): string => {
  const text = composer.composeCredentialOverrideSentThenCancelled(CTX, ['src/user.ts']).text;
  expect(text.startsWith(composer.composeCredentialOverrideSentNotice(CTX, ['src/user.ts']).text)).toBe(true);
  return text;
};

describe('ConversationRuntime credential override — dispatch races (ADR-0097 D5, OVR-3 contract)', () => {
  // A single-target send turn reads the workspace three times: the coverage check, the context preparation and the
  // flow's revalidation read. None of them may sit between the flow's final validation and generate().
  it.each([1, 2, 3])(
    'expiry landing during workspace read #%i of the send turn → nothing sent (expired), no generate()',
    async (at) => {
      const h = makeHarness();
      h.files['src/user.ts'] = USER_TS;
      await promptFor(h);
      setMinutes(29);
      h.reads = 0;
      h.onRead = (n) => {
        if (n === at) setMinutes(31);
      };

      const result = await h.send('그래도 보내줘');

      expect(h.reads).toBeGreaterThanOrEqual(at);
      expect(h.generated).toHaveLength(0);
      expect(result.status).toBe('FAILED');
      expect(result.reply.text).toBe(composer.composeCredentialOverrideInvalidated(CTX, 'expired').text);
    },
  );

  it.each([1, 2, 3])(
    'a reset close landing during workspace read #%i of the send turn → nothing sent (reset), no generate()',
    async (at) => {
      const h = makeHarness();
      h.files['src/user.ts'] = USER_TS;
      await promptFor(h);
      h.reads = 0;
      h.onRead = (n) => {
        // A session writer outside the override flow (SessionManager.close).
        if (n === at) h.store.sessionRows.set('sess-1', { ...h.store.session, status: SessionStatus.CLOSED });
      };

      const result = await h.send('그래도 보내줘');

      expect(h.reads).toBeGreaterThanOrEqual(at);
      expect(h.generated).toHaveLength(0);
      expect(result.status).toBe('FAILED');
      expect(result.reply.text).toBe(composer.composeCredentialOverrideInvalidated(CTX, 'reset').text);
      expect(h.store.sessionRows.get('sess-1')!.status).toBe(SessionStatus.CLOSED);
    },
  );

  it('no workspace read runs after the set is consumed: the granted content is prepared before the dispatch', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const overrideTaskId = h.store.session.activeTaskId!;
    const statusAtRead: string[] = [];
    h.onRead = () => {
      const anchor = h.store.taskRows.get(overrideTaskId)!.metadata![ANCHOR_KEY] as CredentialOverrideAnchor;
      statusAtRead.push(anchor.status);
    };

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('RESPONDED');
    expect(h.generated).toHaveLength(1);
    expect(h.generated[0]!.contextFiles).toEqual([{ path: 'src/user.ts', content: USER_TS }]);
    expect(statusAtRead.length).toBeGreaterThan(0);
    expect(statusAtRead).not.toContain('CONSUMED');
  });

  it('a reset turn completing during generation → the preview is discarded: session stays CLOSED, no apply anchor', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const tasksBefore = h.store.taskRows.size;
    const entered = deferred();
    const gate = deferred();
    h.onGenerate = async () => {
      entered.resolve();
      await gate.promise;
    };

    const sending = h.send('그래도 보내줘');
    await entered.promise;
    const reset = await h.send('새 대화');
    expect(reset.reply.text).toBe(composer.composeConversationReset(CTX, { deniedPendingApproval: false }).text);
    expect(h.store.sessionRows.get('sess-1')!.status).toBe(SessionStatus.CLOSED);
    gate.resolve();
    const result = await sending;

    expect(h.generated).toHaveLength(1);
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(CANCELLED_AFTER_SEND());
    expect(result.reply.preview).toBeUndefined();
    const session = h.store.sessionRows.get('sess-1')!;
    expect(session.status).toBe(SessionStatus.CLOSED); // never re-opened by a stale save
    expect(session.activeTaskId).toBeUndefined();
    expect(h.store.taskRows.size).toBe(tasksBefore); // no apply-preview anchor Task
    expect(h.store.overrideAnchor().status).toBe('CONSUMED');
  });

  it.each([
    ['a project switch', (s: Session): Session => ({ ...s, activeProjectId: 'proj-2' })],
    ['a newer request taking the session pointer', (s: Session): Session => ({ ...s, activeTaskId: 'newer-task' })],
  ])('%s during generation → the preview is discarded and the concurrent update is kept', async (_name, update) => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    const tasksBefore = h.store.taskRows.size;
    const gate = deferred();
    let expected: Session | null = null;
    h.onGenerate = async () => {
      expected = update(h.store.session);
      h.store.sessionRows.set('sess-1', clone(expected));
      await gate.promise;
    };

    const sending = h.send('그래도 보내줘');
    await vi.waitFor(() => expect(h.generated).toHaveLength(1));
    gate.resolve();
    const result = await sending;

    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(CANCELLED_AFTER_SEND());
    expect(h.store.sessionRows.get('sess-1')).toEqual(expected);
    expect(h.store.taskRows.size).toBe(tasksBefore);
  });

  it('happy path: the apply anchor is saved onto the freshly loaded session (a concurrent unrelated update is kept)', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    h.onGenerate = async () => {
      h.store.sessionRows.set('sess-1', { ...h.store.session, metadata: { concurrent: 'kept' } });
    };

    const result = await h.send('그래도 보내줘');

    expect(result.status).toBe('RESPONDED');
    expect(h.generated).toHaveLength(1);
    const session = h.store.sessionRows.get('sess-1')!;
    expect(session.status).toBe(SessionStatus.ACTIVE);
    expect(session.activeProjectId).toBe('proj-1');
    expect(session.metadata).toEqual({ concurrent: 'kept' });
    const apply = h.store.activeTask()!.metadata?.conversationApplyPreviewAnchor as ApplyPreviewAnchor | undefined;
    expect(apply?.status).toBe('ELIGIBLE');
    expect(apply?.projectId).toBe('proj-1');
  });
});

describe('ConversationRuntime credential override — failure after the one-time send (CODE-5 QA follow-up)', () => {
  it('generate() failing after the granted send → "sent once, no proposal" (never the plain could-not-generate copy)', async () => {
    const h = makeHarness();
    h.files['src/user.ts'] = USER_TS;
    await promptFor(h);
    h.onGenerate = async () => {
      throw new Error('provider boom');
    };

    const result = await h.send('그래도 보내줘');

    expect(h.generated).toHaveLength(1); // the content WAS handed to the provider once
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toBe(composer.composeCredentialOverrideSentNoProposal(CTX, ['src/user.ts']).text);
    expect(result.reply.text.startsWith(composer.composeCredentialOverrideSentNotice(CTX, ['src/user.ts']).text)).toBe(true);
    expect(result.reply.text).toContain('코드 변경 제안은 만들어지지 않았어요');
    expect(result.reply.text).toContain('파일 전송 확인도 다시 받아 주세요');
    expect(result.reply.text).not.toBe(composer.composeCodeGenerationPreviewFailed(CTX).text);
    expect(h.store.overrideAnchor().status).toBe('CONSUMED');

    // the consumed set is never replayed
    const again = await h.send('그래도 보내줘');
    expect(h.generated).toHaveLength(1);
    expect(again.reply.text).toBe(composer.composeNoPendingCredentialOverride(CTX).text);
  });

  it('the sent-then-cancelled copy is dedicated: it is not the scope-clarification "request cancelled" text', () => {
    const text = composer.composeCredentialOverrideSentThenCancelled(CTX, ['src/user.ts']).text;
    expect(text).not.toContain(composer.composeScopeClarificationCancelled(CTX).text);
    expect(text).toContain('이번 한 번만 AI에게 보냈어요');
    expect(text).toContain('보여 주지도 저장하지도 않았고');
  });
});
