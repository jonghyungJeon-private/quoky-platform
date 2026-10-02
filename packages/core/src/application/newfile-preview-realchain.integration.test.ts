import { describe, expect, it } from 'vitest';
import { Capability, CodeGenerationStatus, IntentType, RiskLevel, SessionStatus, WorkspaceChangeStatus } from '../domain';
import type {
  ApprovalRequest,
  ChangeSetApplyResult,
  CodeProposal,
  ConversationContext,
  ExecutionPlan,
  FileDiff,
  GitCommitResult,
  GitStatus,
  Id,
  InboundMessage,
  Intent,
  PatchOperation,
  PatchSet,
  ProposedChange,
  Session,
  WorkspaceChange,
  WorkspaceRef,
} from '../domain';
import type { GitProvider, Logger, StorageProvider, WorkspaceWriter } from '../ports';
import { ExecutionOrchestrator, ExecutionOutcomeStatus, ExecutionStage } from './execution-orchestrator';
import type { ExecutionOutcome, ExecutionRequest, PlanningRequest } from './execution-orchestrator';
import { ApprovalManager } from './approval-manager';
import { ApprovalPolicy } from './approval-policy';
import { RiskPolicy } from './risk-policy';
import { ConversationRuntime } from './conversation-runtime';
import type { ApplyPreviewAnchor, ConversationRuntimeDeps } from './conversation-runtime';
import { GitManager } from './git-manager';
import { IntentResolver } from './intent-resolver';
import { PatchManager } from './patch-manager';
import { ResponseComposer } from './response-composer';
import { WorkspaceWriteManager } from './workspace-write-manager';

// Sprint 4c-Follow-up-2, Track A / ADR-0062 — A2 real-chain coverage (CA §5.3).
// The ConversationRuntime tests fake the orchestrator; this exercises the REAL ExecutionOrchestrator + REAL
// ApprovalManager (+ real ApprovalPolicy/RiskPolicy, and the real approvals `.save`/`.get` persistence) for a
// planningOnly CODE_IMPLEMENTATION request whose target is a NEW file that does not exist yet — the exact shape
// A2 now routes to planning/preview. It must reach AWAITING_APPROVAL WITHOUT running code-generation / workspace
// diff / patch / workspace-write / command (no mutation, no file read pre-approval). Planning is a deterministic
// stand-in mirroring the real single-step planner (HIGH risk → approval PENDING); everything downstream of
// routing — orchestrator pipeline selection + the approval gate + persistence — is the real code.

const logger: Logger = { info() {}, warn() {}, error() {} };

/** In-memory approvals repo — the only StorageProvider surface ApprovalManager touches. */
function makeStorage(): StorageProvider {
  const approvals = new Map<string, ApprovalRequest>();
  return {
    approvals: {
      async save(r: ApprovalRequest) {
        approvals.set(r.id, r);
        return r;
      },
      async get(id: Id) {
        return approvals.get(id) ?? null;
      },
    },
  } as unknown as StorageProvider;
}

describe('new-file planningOnly preview — real orchestrator + real ApprovalManager (A2 real-chain)', () => {
  it('reaches AWAITING_APPROVAL for a NEW-file target without any codegen/diff/patch/write/command', async () => {
    const calls = { plan: 0, codeGen: 0, workspaceDiff: 0, workspaceRead: 0, patch: 0, write: 0, command: 0 };
    const orchestrator = new ExecutionOrchestrator({
      planning: {
        async plan(req: PlanningRequest): Promise<ExecutionPlan> {
          calls.plan++;
          // Deterministic single-step HIGH-risk plan (mirrors the real Planner for a CODE_IMPLEMENTATION intent).
          return {
            id: 'plan-int-1',
            goal: req.goal,
            summary: req.goal,
            overallRisk: RiskLevel.HIGH,
            requiredResources: req.requiredResources ?? [],
          } as unknown as ExecutionPlan;
        },
      },
      codeGeneration: {
        async generate() {
          calls.codeGen++;
          throw new Error('codeGeneration must not run for planningOnly');
        },
        async getProposal() {
          return null;
        },
        async get() {
          return null;
        },
      },
      workspace: {
        async diff() {
          calls.workspaceDiff++;
          throw new Error('workspace.diff must not run for planningOnly');
        },
        async read() {
          calls.workspaceRead++;
          throw new Error('workspace.read must not run for planningOnly');
        },
      },
      approval: new ApprovalManager(makeStorage(), new ApprovalPolicy(new RiskPolicy())),
      patch: {
        async generate() {
          calls.patch++;
          throw new Error('patch must not run for planningOnly');
        },
      },
      workspaceWrite: {
        async apply() {
          calls.write++;
          throw new Error('workspaceWrite must not run for planningOnly');
        },
      },
      command: {
        async run() {
          calls.command++;
          throw new Error('command must not run for planningOnly');
        },
      },
      logger,
    });

    const request: ExecutionRequest = {
      goal: 'preview docs/uat/github-app-auth-smoke.md',
      instruction: 'preview docs/uat/github-app-auth-smoke.md',
      requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
      requestedBy: 'u1',
      targetFiles: ['docs/uat/github-app-auth-smoke.md'], // a NEW file (does not exist)
      planningOnly: true,
    };

    const outcome = await orchestrator.run(request);

    expect(outcome.status).toBe(ExecutionOutcomeStatus.AWAITING_APPROVAL);
    expect(calls.plan).toBe(1); // real planning ran
    expect(calls.codeGen).toBe(0); // no pre-approval code generation / file read
    expect(calls.workspaceDiff).toBe(0);
    expect(calls.workspaceRead).toBe(0); // no pre-approval codegen context read (QA-012)
    expect(calls.patch).toBe(0);
    expect(calls.write).toBe(0); // no workspace mutation
    expect(calls.command).toBe(0);
    expect(outcome.refs.approvalRef?.id).toBeTruthy(); // a real PENDING approval was persisted
  });
});

// ── CODE-3 (ADR-0099 D1–D3) — 2-file update+add change set through the REAL runtime + REAL managers ─────────
//
// REAL: ConversationRuntime, IntentResolver, ApprovalManager (+ApprovalPolicy/RiskPolicy), PatchManager,
// WorkspaceWriteManager (its change-set status derivation), GitManager (its newFiles ⊆ files gate), ResponseComposer.
// MODELED (Core may not import adapters — AGENTS.md): the workspace, the WorkspaceWriter and the GitProvider are
// in-memory models of one repo. The real LocalWorkspaceWriter / LocalGitProvider change-set behavior is covered
// by their own adapter tests (CODE-1, CODE-2). Drives the exact UAT phrases end to end; no provider, no network.

const EXISTING = 'src/app.ts';
const NEW_FILE = 'src/helper.ts';
const BASELINE = 'export const app = 1;\n';
const PROPOSED: Record<string, string> = {
  [EXISTING]: "import { helper } from './helper';\nexport const app = helper();\n",
  [NEW_FILE]: 'export const helper = () => 1;\n',
};
const CHAIN_CTX: ConversationContext = { platform: 'test', channelId: 'chain-ch', userId: 'chain-user' };
const CHAIN_WS: WorkspaceRef = { id: 'chain-ws', rootPath: '/repo/chain', kind: 'local-clone' };

/** The '+' lines of a model unified diff, i.e. the full proposed content (models' own diff format). */
function proposedFromDiff(diff: string): string {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => `${l.slice(1)}\n`)
    .join('');
}

function modelDiff(path: string, before: string | undefined, after: string): string {
  const minus = (before ?? '').split('\n').filter(Boolean).map((l) => `-${l}`);
  const plus = after.split('\n').filter(Boolean).map((l) => `+${l}`);
  return [`--- ${before === undefined ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`, '@@ model @@', ...minus, ...plus, ''].join('\n');
}

interface RepoModel {
  files: Map<string, string>;
  tracked: Map<string, string>;
  commits: Array<{ files: string[]; newFiles?: string[]; message: string }>;
  failApplyOn?: string;
}

function repoModel(): RepoModel {
  return { files: new Map([[EXISTING, BASELINE]]), tracked: new Map([[EXISTING, BASELINE]]), commits: [] };
}

/** In-memory WorkspaceWriter: all-or-nothing over the model (`failApplyOn` → nothing written, rolled_back). */
function modelWriter(repo: RepoModel): WorkspaceWriter & { changeSetCalls: number; operationCalls: number } {
  const writer = {
    kind: 'model',
    changeSetCalls: 0,
    operationCalls: 0,
    async applyOperation(): Promise<never> {
      writer.operationCalls++;
      throw new Error('per-file apply must not run for a change set');
    },
    async applyChangeSet(_ref: WorkspaceRef, ops: PatchOperation[]): Promise<ChangeSetApplyResult> {
      writer.changeSetCalls++;
      const ok = ops.every((op) =>
        op.path !== repo.failApplyOn && (op.operation === 'add' ? !repo.files.has(op.path) : repo.files.has(op.path)),
      );
      if (!ok) {
        return {
          outcome: 'rolled_back',
          results: ops.map((op) => ({ path: op.path, operation: op.operation, status: 'failed' as const, message: 'refused', durationMs: 0 })),
        };
      }
      for (const op of ops) repo.files.set(op.path, proposedFromDiff(op.diff));
      return {
        outcome: 'applied',
        results: ops.map((op) => ({ path: op.path, operation: op.operation, status: 'applied' as const, message: 'ok', durationMs: 0 })),
      };
    },
  };
  return writer;
}

/** In-memory GitProvider: status from the model (modified tracked → unstaged, untracked → untracked). */
function modelGit(repo: RepoModel): GitProvider {
  const status = async (): Promise<GitStatus> => {
    const unstaged = [...repo.tracked.keys()].filter((p) => repo.files.get(p) !== repo.tracked.get(p));
    const untracked = [...repo.files.keys()].filter((p) => !repo.tracked.has(p));
    return { clean: unstaged.length + untracked.length === 0, branch: 'feature/chain', staged: [], unstaged, untracked };
  };
  return {
    kind: 'model',
    status,
    async commitFiles(_root: string, files: string[], message: string, options?: { newFiles?: string[] }): Promise<GitCommitResult> {
      // Only an approved new file is ever added; any other untracked path stays out of the commit.
      for (const f of files) {
        if (!repo.tracked.has(f) && !(options?.newFiles ?? []).includes(f)) throw new Error(`untracked ${f} not added`);
      }
      for (const f of files) repo.tracked.set(f, repo.files.get(f) ?? '');
      repo.commits.push({ files, message, ...(options?.newFiles ? { newFiles: options.newFiles } : {}) });
      return { commitHash: 'abcdef0123456789abcdef0123456789abcdef01', committedFiles: files, message };
    },
  } as unknown as GitProvider;
}

function chainStorage(): StorageProvider {
  const approvals = new Map<Id, ApprovalRequest>();
  const patches = new Map<Id, PatchSet>();
  const changes = new Map<Id, WorkspaceChange>();
  return {
    approvals: {
      async save(r: ApprovalRequest) { approvals.set(r.id, r); return r; },
      async get(id: Id) { return approvals.get(id) ?? null; },
      async findByExecutionPlan(planId: Id) { return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId); },
    },
    patches: {
      async save(p: PatchSet) { patches.set(p.id, p); return p; },
      async get(id: Id) { return patches.get(id) ?? null; },
      async findByExecutionPlan(planId: Id) { return [...patches.values()].filter((p) => p.executionPlanRef.id === planId); },
    },
    workspaceChanges: {
      async save(c: WorkspaceChange) { changes.set(c.id, c); return c; },
      async get(id: Id) { return changes.get(id) ?? null; },
      async findByPatchSet(patchId: Id) { return [...changes.values()].filter((c) => c.patchRef.id === patchId); },
    },
  } as unknown as StorageProvider;
}

function chainRuntime(repo: RepoModel) {
  const storage = chainStorage();
  const approvalManager = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  const writer = modelWriter(repo);
  const counts = { classify: 0, generate: 0 };
  const plan = { id: 'chain-plan', goal: 'chain' };
  let planApprovalId: Id | undefined;
  let halted: { request: ExecutionRequest; prior: ExecutionOutcome } | null = null;
  let anchor: ApplyPreviewAnchor | null = null;
  const session: Session = {
    id: 'chain-sess',
    actorId: 'chain-actor',
    context: CHAIN_CTX,
    status: SessionStatus.ACTIVE,
    activeProjectId: 'chain-proj',
    createdAt: '2026-10-02T00:00:00.000Z',
    lastActivityAt: '2026-10-02T00:00:00.000Z',
  } as Session;
  const outcome = (status: ExecutionOutcomeStatus): ExecutionOutcome => ({
    status,
    lastStage: ExecutionStage.APPROVAL,
    selectedStages: [ExecutionStage.PLANNING, ExecutionStage.APPROVAL],
    refs: { executionPlanRef: plan },
  });
  const proposal: CodeProposal = {
    id: 'chain-prop',
    codeGenerationRef: { id: 'chain-gen', status: CodeGenerationStatus.SUCCEEDED },
    proposal: [EXISTING, NEW_FILE].map((path) => ({ path, newContent: PROPOSED[path] })),
    providerId: 'model',
    createdAt: '2026-10-02T00:00:00.000Z',
  } as CodeProposal;
  const codeIntent: Intent = {
    type: IntentType.IMPLEMENT_CODE,
    capability: Capability.CODE_IMPLEMENTATION,
    confidence: 1,
    requiresWork: true,
    summary: 'change set',
  };
  const unexpected = (name: string) => async (): Promise<never> => { throw new Error(`unexpected dep call: ${name}`); };

  const deps = {
    dispatchCommit: { commit: unexpected('dispatchCommit.commit') },
    actors: { async resolveFromContext() { return { id: 'chain-actor' }; } },
    sessions: { async openForContext() { return session; }, async touch(s: Session) { return s; }, close: unexpected('sessions.close') },
    memory: {
      async recordShortTerm() { return { id: 'm' }; },
      async recordAssistant() { return undefined; },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: unexpected('memoryWriter.createCandidate'), promote: unexpected('memoryWriter.promote'), forget: unexpected('memoryWriter.forget') },
    classifier: { async classify() { counts.classify++; return codeIntent; } },
    projects: { register: unexpected('projects.register'), async get() { return { id: 'chain-proj', name: 'chain', rootPath: CHAIN_WS.rootPath, createdAt: 't' }; } },
    analyzer: { prepare: unexpected('analyzer.prepare') },
    tasks: { createTask: unexpected('tasks.createTask'), transition: unexpected('tasks.transition'), startRun: unexpected('tasks.startRun'), completeRun: unexpected('tasks.completeRun'), failRun: unexpected('tasks.failRun') },
    workspace: {
      prepare: unexpected('workspace.prepare'),
      async open() { return CHAIN_WS; },
      async list(_ref: WorkspaceRef, glob?: string) { return glob !== undefined && repo.files.has(glob) ? [glob] : []; },
      async read(_ref: WorkspaceRef, path: string) {
        const content = repo.files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      async diff(_ref: WorkspaceRef, changesIn: ProposedChange[]) {
        const files: FileDiff[] = changesIn.map((c) => {
          const before = repo.files.get(c.path);
          const after = c.newContent ?? '';
          return {
            path: c.path,
            changeKind: before === undefined ? 'add' : 'modify',
            unified: modelDiff(c.path, before, after),
            binary: false,
            ...(before === undefined ? {} : { oldSize: Buffer.byteLength(before) }),
            newSize: Buffer.byteLength(after),
          };
        });
        return { refId: CHAIN_WS.id, files, estimatedChangedLines: files.length, truncated: false };
      },
    },
    commandExecutions: { async get() { return null; } },
    contextBuilder: { build: unexpected('contextBuilder.build') },
    promptComposer: { compose: () => { throw new Error('unexpected promptComposer.compose'); } },
    promptRenderer: { render: () => { throw new Error('unexpected promptRenderer.render'); } },
    router: { select: unexpected('router.select') },
    artifacts: { persistAll: unexpected('artifacts.persistAll') },
    composer: new ResponseComposer(),
    workSurface: { forActor: unexpected('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: {
      async run(request: ExecutionRequest) {
        const approval = await approvalManager.requestForRisk({ executionPlanRef: plan, riskLevel: RiskLevel.HIGH, reason: 'plan', requestedBy: request.requestedBy });
        planApprovalId = approval.id;
        return outcome(ExecutionOutcomeStatus.AWAITING_APPROVAL);
      },
      async resume() { return outcome(ExecutionOutcomeStatus.COMPLETED); },
    },
    approvals: approvalManager,
    approvalFlow: {
      async findPending() {
        const a = planApprovalId ? await approvalManager.get(planApprovalId) : null;
        return a && a.status === 'PENDING' ? a : null;
      },
      async anchor(_s: Session, request: ExecutionRequest, prior: ExecutionOutcome) { halted = { request, prior }; },
      async reconstructResume() { return halted; },
    },
    scopeClarificationFlow: { async findPending() { return null; }, anchor: unexpected('scope.anchor'), clear: unexpected('scope.clear') },
    applyPreviewFlow: {
      async findAnchor() { return anchor; },
      async anchor(_s: Session, next: ApplyPreviewAnchor) { anchor = next; },
      async clear() { anchor = null; },
    },
    codeGeneration: {
      async generate() {
        counts.generate++;
        return { id: 'chain-gen', executionPlanRef: plan, capability: Capability.CODE_IMPLEMENTATION, status: CodeGenerationStatus.SUCCEEDED, codeProposalRef: { id: proposal.id }, createdAt: 't', updatedAt: 't' };
      },
      async getProposal() { return proposal; },
    },
    patch: new PatchManager(storage),
    codeProposals: { async get() { return proposal; } },
    workspaceWrite: new WorkspaceWriteManager(storage, writer),
    command: { run: unexpected('command.run') },
    git: new GitManager(modelGit(repo)),
    turnHandlers: [],
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as Logger,
  } as unknown as ConversationRuntimeDeps;

  const runtime = new ConversationRuntime(deps);
  let n = 0;
  const say = (text: string) => {
    const message: InboundMessage = { id: `chain-${++n}`, context: CHAIN_CTX, text, receivedAt: new Date().toISOString() };
    return runtime.handle(message);
  };
  return { say, writer, counts, anchor: () => anchor };
}

describe('2-file update+add change set — real runtime + real managers (CODE-3, ADR-0099)', () => {
  it('preview → 적용해줘 → 승인 → 패치 만들어줘 → 패치 적용해줘 → 커밋해줘 → 승인 → 커밋 실행 commits the new file via newFiles', async () => {
    const repo = repoModel();
    const { say, writer, counts, anchor } = chainRuntime(repo);

    const planned = await say(`${EXISTING}에서 helper를 쓰도록 고치고 새 파일 ${NEW_FILE}도 만들어줘`);
    expect(planned.status).toBe('AWAITING_APPROVAL');

    const preview = await say('승인');
    expect(counts.generate).toBe(1);
    expect(preview.reply.text).toContain(`${NEW_FILE} (새 파일)`);
    expect(preview.reply.text).toContain('"적용해줘"');
    expect(anchor()?.targetFiles).toEqual([EXISTING, NEW_FILE]);
    expect(anchor()?.newFileTargets).toEqual([NEW_FILE]);
    expect(repo.files.has(NEW_FILE)).toBe(false); // preview is read-only

    expect((await say('적용해줘')).status).toBe('AWAITING_APPROVAL');
    await say('승인');
    const patch = await say('패치 만들어줘');
    expect(patch.reply.text).toContain(`${NEW_FILE} (새 파일)`);
    expect(anchor()?.status).toBe('PATCH_READY');
    expect(repo.files.has(NEW_FILE)).toBe(false); // a PatchSet is a representation only

    const applied = await say('패치 적용해줘');
    expect(writer.changeSetCalls).toBe(1);
    expect(writer.operationCalls).toBe(0);
    expect(anchor()?.status).toBe('WORKSPACE_APPLIED');
    expect(anchor()?.workspaceChangeRef?.status).toBe(WorkspaceChangeStatus.APPLIED);
    expect(applied.reply.text).toContain(`${EXISTING}, ${NEW_FILE} (새 파일)`);
    expect(repo.files.get(NEW_FILE)).toBe(PROPOSED[NEW_FILE]);
    expect(repo.files.get(EXISTING)).toBe(PROPOSED[EXISTING]);

    const commitAsk = await say('커밋해줘');
    expect(commitAsk.status).toBe('AWAITING_APPROVAL');
    expect(commitAsk.reply.text).toContain(`${NEW_FILE} (새 파일)`);
    await say('승인');
    const committed = await say('커밋 실행');
    expect(anchor()?.status).toBe('GIT_COMMITTED');
    expect(repo.commits).toEqual([{ files: [EXISTING, NEW_FILE], newFiles: [NEW_FILE], message: expect.any(String) }]);
    expect(committed.reply.text).toContain(`${NEW_FILE} (새 파일)`);
    expect(counts.classify).toBe(1); // every later turn was an anchored intercept, never re-classified
  });

  it('a change set the writer rolls back → "nothing changed", anchor stays PATCH_READY, no file written', async () => {
    const repo = repoModel();
    const { say, anchor } = chainRuntime(repo);
    await say(`${EXISTING}를 고치고 새 파일 ${NEW_FILE}도 만들어줘`);
    await say('승인');
    await say('적용해줘');
    await say('승인');
    await say('패치 만들어줘');
    repo.failApplyOn = NEW_FILE;
    const result = await say('패치 적용해줘');
    expect(result.status).toBe('FAILED');
    expect(result.reply.text).toContain('바뀐 파일은 없어요');
    expect(anchor()?.status).toBe('PATCH_READY');
    expect(repo.files.get(EXISTING)).toBe(BASELINE);
    expect(repo.files.has(NEW_FILE)).toBe(false);
  });
});
