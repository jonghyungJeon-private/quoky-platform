import { describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  CodeGenerationStatus,
  CommandExecutionStatus,
  ExecutionStatus,
  PatchStatus,
  RiskLevel,
  WorkspaceChangeStatus,
} from '../domain';
import type {
  ApprovalRequest,
  CodeGeneration,
  CodeProposal,
  CommandExecution,
  ExecutionPlan,
  GenerateCodeInput,
  PatchSet,
  ProposedChange,
  WorkspaceChange,
  WorkspaceDiff,
  WorkspaceRef,
} from '../domain';
import type { Logger } from '../ports';
import {
  ExecutionOrchestrator,
  ExecutionOutcomeStatus,
  ExecutionStage,
  selectStages,
} from './execution-orchestrator';
import type { ExecutionOrchestratorDeps, ExecutionRequest, CancelToken } from './execution-orchestrator';
import { ExecutionReceiptRecordingError } from './execution-receipt-manager';

const TS = '2026-07-01T00:00:00.000Z';
const PLAN_REF = { id: 'plan-1', goal: 'goal' };
const APPROVED_REF = { id: 'appr-1', status: ApprovalStatus.APPROVED, executionPlanRef: PLAN_REF };
const WORKSPACE: WorkspaceRef = { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' };
const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const planOf = (o: Partial<ExecutionPlan> = {}): ExecutionPlan => ({
  id: 'plan-1',
  goal: 'goal',
  summary: 'summary',
  steps: [],
  requiredCapabilities: [],
  requiredResources: [],
  estimatedChanges: { fileCount: 0, scope: 'local' },
  approvalRequired: false,
  overallRisk: RiskLevel.MEDIUM,
  expectedArtifacts: [],
  status: ExecutionStatus.PENDING,
  createdAt: TS,
  ...o,
});

const codeGenOf = (o: Partial<CodeGeneration> = {}): CodeGeneration => ({
  id: 'gen-1',
  executionPlanRef: PLAN_REF,
  capability: Capability.CODE_IMPLEMENTATION,
  status: CodeGenerationStatus.SUCCEEDED,
  codeProposalRef: { id: 'prop-1' },
  createdAt: TS,
  updatedAt: TS,
  ...o,
});

const proposalOf = (o: Partial<CodeProposal> = {}): CodeProposal => ({
  id: 'prop-1',
  codeGenerationRef: { id: 'gen-1', status: CodeGenerationStatus.SUCCEEDED },
  proposal: [{ path: 'src/a.ts', newContent: 'x' }] as ProposedChange[],
  providerId: 'fake',
  createdAt: TS,
  ...o,
});

const approvalOf = (status: ApprovalStatus, o: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'appr-1',
  executionPlanRef: PLAN_REF,
  status,
  riskLevel: RiskLevel.MEDIUM,
  reason: 'r',
  requestedBy: 'user',
  createdAt: TS,
  updatedAt: TS,
  ...o,
});

const patchSetOf = (): PatchSet => ({
  id: 'patch-1',
  executionPlanRef: PLAN_REF,
  approvalRef: APPROVED_REF,
  operations: [],
  status: PatchStatus.GENERATED,
  createdAt: TS,
});

const changeOf = (status: WorkspaceChangeStatus): WorkspaceChange => ({
  id: 'wc-1',
  patchRef: { id: 'patch-1', status: PatchStatus.GENERATED },
  patchHash: 'h',
  executionPlanRef: PLAN_REF,
  approvalRef: APPROVED_REF,
  workspaceRef: WORKSPACE,
  status,
  results: [],
  createdAt: TS,
  updatedAt: TS,
});

const commandOf = (status: CommandExecutionStatus): CommandExecution => ({
  id: 'cmd-1',
  executionPlanRef: PLAN_REF,
  workspaceRef: WORKSPACE,
  command: 'pnpm',
  args: ['test'],
  commandHash: 'h',
  status,
  stdout: '',
  stderr: '',
  durationMs: 1,
  riskLevel: RiskLevel.MEDIUM,
  createdAt: TS,
  updatedAt: TS,
});

const diffOf = (changes: ProposedChange[]): WorkspaceDiff => ({
  refId: 'ws-1',
  files: changes.map((c) => ({ path: c.path, changeKind: 'modify' as const, unified: '', binary: false })),
  estimatedChangedLines: 0,
  truncated: false,
});

interface Calls {
  planning: number;
  codeGen: number;
  diff: number;
  approvalRequest: number;
  approvalGet: number;
  patch: number;
  write: number;
  command: number;
  read: string[];
  lastGenerateInput?: GenerateCodeInput;
}

interface FakeOpts {
  generation?: CodeGeneration;
  proposal?: CodeProposal | null;
  approval?: ApprovalRequest; // result of requestFor
  approvalGet?: ApprovalRequest | null; // result of get (resume)
  change?: WorkspaceChange;
  command?: CommandExecution;
  commandThrows?: Error;
  patchThrows?: boolean;
  /** `workspace.read` (QA-012) — defaults to `current:<path>`; throw per path to simulate a missing file. */
  read?: (path: string) => string;
}

function makeDeps(opts: FakeOpts = {}): { deps: ExecutionOrchestratorDeps; calls: Calls } {
  const calls: Calls = {
    planning: 0,
    codeGen: 0,
    diff: 0,
    approvalRequest: 0,
    approvalGet: 0,
    patch: 0,
    write: 0,
    command: 0,
    read: [],
  };
  const deps: ExecutionOrchestratorDeps = {
    planning: {
      async plan() {
        calls.planning++;
        return planOf();
      },
    },
    codeGeneration: {
      async generate(input) {
        calls.codeGen++;
        calls.lastGenerateInput = input;
        return opts.generation ?? codeGenOf();
      },
      async getProposal() {
        return opts.proposal === undefined ? proposalOf() : opts.proposal;
      },
      async get() {
        return opts.generation ?? codeGenOf();
      },
    },
    workspace: {
      async diff(_ref, changes) {
        calls.diff++;
        return diffOf(changes);
      },
      async read(_ref, relPath) {
        calls.read.push(relPath);
        return opts.read ? opts.read(relPath) : `current:${relPath}`;
      },
    },
    approval: {
      async requestFor() {
        calls.approvalRequest++;
        return opts.approval ?? approvalOf(ApprovalStatus.APPROVED);
      },
      async get() {
        calls.approvalGet++;
        return opts.approvalGet === undefined ? approvalOf(ApprovalStatus.APPROVED) : opts.approvalGet;
      },
    },
    patch: {
      async generate() {
        calls.patch++;
        if (opts.patchThrows) throw new Error('patch boom');
        return patchSetOf();
      },
    },
    workspaceWrite: {
      async apply() {
        calls.write++;
        return opts.change ?? changeOf(WorkspaceChangeStatus.APPLIED);
      },
    },
    command: {
      async run() {
        calls.command++;
        if (opts.commandThrows) throw opts.commandThrows;
        return opts.command ?? commandOf(CommandExecutionStatus.SUCCEEDED);
      },
    },
    logger: silentLogger,
  };
  return { deps, calls };
}

const codeChange = (o: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  goal: 'fix bug',
  instruction: 'fix the bug',
  requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
  requestedBy: 'user',
  workspaceRef: WORKSPACE,
  ...o,
});

const tokenThatCancelsAfter = (n: number): CancelToken => {
  let i = 0;
  return { isCancelled: () => i++ >= n };
};

describe('selectStages (Capability Selection, MB-1)', () => {
  it('analyze-only intent → only PLANNING (dynamic, not a fixed pipeline)', () => {
    expect(selectStages({ ...codeChange(), requiredCapabilities: [Capability.PROJECT_ANALYSIS] })).toEqual([
      ExecutionStage.PLANNING,
    ]);
  });

  it('code-change intent → Planning → CodeGen → Diff → Approval → Patch → Write', () => {
    expect(selectStages(codeChange())).toEqual([
      ExecutionStage.PLANNING,
      ExecutionStage.CODE_GENERATION,
      ExecutionStage.WORKSPACE_DIFF,
      ExecutionStage.APPROVAL,
      ExecutionStage.PATCH,
      ExecutionStage.WORKSPACE_WRITE,
    ]);
  });

  it('run-tests intent (with command) → Planning → Approval → Command (no code stages)', () => {
    expect(
      selectStages({
        ...codeChange(),
        requiredCapabilities: [Capability.TEST_EXECUTION],
        command: { command: 'pnpm', args: ['test'] },
      }),
    ).toEqual([ExecutionStage.PLANNING, ExecutionStage.APPROVAL, ExecutionStage.COMMAND_EXECUTION]);
  });

  it('test capability without a command → no COMMAND_EXECUTION stage', () => {
    expect(selectStages({ ...codeChange(), requiredCapabilities: [Capability.TEST_EXECUTION] })).toEqual([
      ExecutionStage.PLANNING,
    ]);
  });

  it('code-change intent with planningOnly → Planning → Approval only (ADR-0035)', () => {
    expect(selectStages({ ...codeChange(), planningOnly: true })).toEqual([
      ExecutionStage.PLANNING,
      ExecutionStage.APPROVAL,
    ]);
  });

  it('code-change intent without planningOnly → existing full pipeline unchanged (regression, ADR-0035)', () => {
    expect(selectStages(codeChange())).toEqual([
      ExecutionStage.PLANNING,
      ExecutionStage.CODE_GENERATION,
      ExecutionStage.WORKSPACE_DIFF,
      ExecutionStage.APPROVAL,
      ExecutionStage.PATCH,
      ExecutionStage.WORKSPACE_WRITE,
    ]);
  });
});

describe('ExecutionOrchestrator.run', () => {
  it('happy code-change chain (auto-approved) → COMPLETED, threads refs, runs only selected stages', async () => {
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).run(codeChange());
    expect(out.status).toBe(ExecutionOutcomeStatus.COMPLETED);
    expect(out.lastStage).toBe(ExecutionStage.WORKSPACE_WRITE);
    expect(out.refs.executionPlanRef?.id).toBe('plan-1');
    expect(out.refs.codeGenerationId).toBe('gen-1');
    expect(out.refs.approvalRef?.id).toBe('appr-1');
    expect(out.refs.patchSetId).toBe('patch-1');
    expect(out.refs.workspaceChangeId).toBe('wc-1');
    expect(calls).toMatchObject({ planning: 1, codeGen: 1, diff: 1, approvalRequest: 1, patch: 1, write: 1 });
    expect(calls.command).toBe(0); // COMMAND not selected
  });

  it('analyze-only → COMPLETED after PLANNING; no downstream capability is called', async () => {
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).run({
      ...codeChange(),
      requiredCapabilities: [Capability.PROJECT_ANALYSIS],
    });
    expect(out.status).toBe(ExecutionOutcomeStatus.COMPLETED);
    expect(out.lastStage).toBe(ExecutionStage.PLANNING);
    expect(calls).toMatchObject({ planning: 1, codeGen: 0, approvalRequest: 0, patch: 0, write: 0, command: 0 });
  });

  it('run-tests chain (auto-approved) → COMPLETED via Command; no code/patch/write', async () => {
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).run({
      ...codeChange(),
      requiredCapabilities: [Capability.TEST_EXECUTION],
      command: { command: 'pnpm', args: ['test'] },
    });
    expect(out.status).toBe(ExecutionOutcomeStatus.COMPLETED);
    expect(out.lastStage).toBe(ExecutionStage.COMMAND_EXECUTION);
    expect(calls).toMatchObject({ planning: 1, approvalRequest: 1, command: 1, codeGen: 0, patch: 0, write: 0 });
  });

  it('planningOnly code-change (HIGH risk → PENDING approval) → AWAITING_APPROVAL, no mutation (ADR-0035, Q9)', async () => {
    const { deps, calls } = makeDeps({ approval: approvalOf(ApprovalStatus.PENDING) });
    const out = await new ExecutionOrchestrator(deps).run({ ...codeChange(), planningOnly: true });

    expect(out.status).toBe(ExecutionOutcomeStatus.AWAITING_APPROVAL);
    expect(out.lastStage).toBe(ExecutionStage.APPROVAL);

    // Only executionPlanRef + approvalRef are ever produced — no other ref exists.
    expect(out.refs.executionPlanRef?.id).toBe('plan-1');
    expect(out.refs.approvalRef?.id).toBe('appr-1');
    expect(out.refs.codeGenerationId).toBeUndefined();
    expect(out.refs.codeProposalRef).toBeUndefined();
    expect(out.refs.patchSetId).toBeUndefined();
    expect(out.refs.workspaceChangeId).toBeUndefined();
    expect(out.refs.commandExecutionId).toBeUndefined();

    // No mutating/generating capability is ever called — proven by call count, not just outcome.
    expect(calls).toMatchObject({
      planning: 1,
      approvalRequest: 1,
      codeGen: 0,
      diff: 0,
      patch: 0,
      write: 0,
      command: 0,
    });
  });

  it('HIGH-risk plan → halts AWAITING_APPROVAL and does NOT call Patch/Write', async () => {
    const { deps, calls } = makeDeps({ approval: approvalOf(ApprovalStatus.PENDING) });
    const out = await new ExecutionOrchestrator(deps).run(codeChange());
    expect(out.status).toBe(ExecutionOutcomeStatus.AWAITING_APPROVAL);
    expect(out.lastStage).toBe(ExecutionStage.APPROVAL);
    expect(out.refs.approvalRef?.id).toBe('appr-1');
    expect(calls.patch).toBe(0);
    expect(calls.write).toBe(0);
  });

  it('code generation FAILED → STOPPED_ON_FAILURE; does NOT call diff/approval/patch', async () => {
    const { deps, calls } = makeDeps({
      generation: codeGenOf({ status: CodeGenerationStatus.FAILED }),
    });
    const out = await new ExecutionOrchestrator(deps).run(codeChange());
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.CODE_GENERATION);
    expect(calls.diff).toBe(0);
    expect(calls.approvalRequest).toBe(0);
    expect(calls.patch).toBe(0);
  });

  it('a thrown manager error (patch) → STOPPED_ON_FAILURE; does NOT call workspace write', async () => {
    const { deps, calls } = makeDeps({ patchThrows: true });
    const out = await new ExecutionOrchestrator(deps).run(codeChange());
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.PATCH);
    expect(out.stoppedReason).toContain('patch boom');
    expect(calls.write).toBe(0);
  });

  it('workspace write not APPLIED → STOPPED_ON_FAILURE', async () => {
    const { deps } = makeDeps({ change: changeOf(WorkspaceChangeStatus.FAILED) });
    const out = await new ExecutionOrchestrator(deps).run(codeChange());
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.WORKSPACE_WRITE);
  });

  it('command FAILED → STOPPED_ON_FAILURE', async () => {
    const { deps } = makeDeps({ command: commandOf(CommandExecutionStatus.FAILED) });
    const out = await new ExecutionOrchestrator(deps).run({
      ...codeChange(),
      requiredCapabilities: [Capability.TEST_EXECUTION],
      command: { command: 'pnpm', args: ['test'] },
    });
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.COMMAND_EXECUTION);
  });

  it('receipt failure preserves the already-persisted command id for downstream reconciliation', async () => {
    const insertFailure = new Error('receipt insert failed');
    const { deps, calls } = makeDeps({
      commandThrows: new ExecutionReceiptRecordingError('cmd-persisted', insertFailure),
    });
    const out = await new ExecutionOrchestrator(deps).run({
      ...codeChange(),
      requiredCapabilities: [Capability.TEST_EXECUTION],
      command: { command: 'pnpm', args: ['test'] },
    });

    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.COMMAND_EXECUTION);
    expect(out.refs.commandExecutionId).toBe('cmd-persisted');
    expect(out.stoppedReason).toContain('execution receipt recording failed');
    expect(calls.command).toBe(1);
  });

  it('cancellation before the first stage → CANCELLED; no capability is called', async () => {
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).run(codeChange(), tokenThatCancelsAfter(0));
    expect(out.status).toBe(ExecutionOutcomeStatus.CANCELLED);
    expect(out.lastStage).toBe(ExecutionStage.PLANNING);
    expect(calls.planning).toBe(0);
  });

  it('cancellation between stages → CANCELLED; does NOT call the next capability', async () => {
    const { deps, calls } = makeDeps();
    // Allow PLANNING (1 check), cancel before CODE_GENERATION.
    const out = await new ExecutionOrchestrator(deps).run(codeChange(), tokenThatCancelsAfter(1));
    expect(out.status).toBe(ExecutionOutcomeStatus.CANCELLED);
    expect(out.lastStage).toBe(ExecutionStage.CODE_GENERATION);
    expect(calls.planning).toBe(1);
    expect(calls.codeGen).toBe(0);
  });
});

describe('ExecutionOrchestrator.resume', () => {
  const halted = (): ReturnType<ExecutionOrchestrator['run']> => {
    const { deps } = makeDeps({ approval: approvalOf(ApprovalStatus.PENDING) });
    return new ExecutionOrchestrator(deps).run(codeChange());
  };

  it('APPROVED on resume → proceeds to Patch/Write → COMPLETED', async () => {
    const prior = await halted();
    const { deps, calls } = makeDeps({ approvalGet: approvalOf(ApprovalStatus.APPROVED) });
    const out = await new ExecutionOrchestrator(deps).resume(codeChange(), prior);
    expect(out.status).toBe(ExecutionOutcomeStatus.COMPLETED);
    expect(calls.approvalGet).toBe(1);
    expect(calls.patch).toBe(1);
    expect(calls.write).toBe(1);
  });

  it('REJECTED on resume → DENIED; does NOT call Patch', async () => {
    const prior = await halted();
    const { deps, calls } = makeDeps({ approvalGet: approvalOf(ApprovalStatus.REJECTED) });
    const out = await new ExecutionOrchestrator(deps).resume(codeChange(), prior);
    expect(out.status).toBe(ExecutionOutcomeStatus.DENIED);
    expect(calls.patch).toBe(0);
  });

  it('still PENDING on resume → AWAITING_APPROVAL again', async () => {
    const prior = await halted();
    const { deps, calls } = makeDeps({ approvalGet: approvalOf(ApprovalStatus.PENDING) });
    const out = await new ExecutionOrchestrator(deps).resume(codeChange(), prior);
    expect(out.status).toBe(ExecutionOutcomeStatus.AWAITING_APPROVAL);
    expect(calls.patch).toBe(0);
  });

  it('user cancel during the approval wait → CANCELLED; approval is not even re-read', async () => {
    const prior = await halted();
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).resume(codeChange(), prior, tokenThatCancelsAfter(0));
    expect(out.status).toBe(ExecutionOutcomeStatus.CANCELLED);
    expect(calls.approvalGet).toBe(0);
    expect(calls.patch).toBe(0);
  });

  it('resume on a non-halted outcome is an idempotent no-op (returns it unchanged)', async () => {
    const { deps, calls } = makeDeps();
    const completed = await new ExecutionOrchestrator(deps).run(codeChange());
    const { deps: deps2, calls: calls2 } = makeDeps();
    const out = await new ExecutionOrchestrator(deps2).resume(codeChange(), completed);
    expect(out).toBe(completed);
    expect(calls2.approvalGet).toBe(0);
    void calls;
  });
});

describe('ExecutionOrchestrator CODE_GENERATION target context (QA-012)', () => {
  it('reads each validated target via workspace.read and passes its current content as contextFiles', async () => {
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).run(codeChange({ targetFiles: ['src/greet.js'] }));
    expect(out.status).toBe(ExecutionOutcomeStatus.COMPLETED);
    expect(calls.read).toEqual(['src/greet.js']);
    expect(calls.lastGenerateInput?.contextFiles).toEqual([{ path: 'src/greet.js', content: 'current:src/greet.js' }]);
  });

  it('skips explicit new-file targets (they must not exist yet) — no read, no contextFiles', async () => {
    const { deps, calls } = makeDeps();
    await new ExecutionOrchestrator(deps).run(
      codeChange({ targetFiles: ['src/new.js'], newFileTargets: ['src/new.js'] }),
    );
    expect(calls.read).toEqual([]);
    expect(calls.lastGenerateInput?.contextFiles).toBeUndefined();
  });

  it('an unreadable (missing) target → STOPPED_ON_FAILURE at CODE_GENERATION; generate never called', async () => {
    const { deps, calls } = makeDeps({
      read: () => {
        throw new Error('ENOENT');
      },
    });
    const out = await new ExecutionOrchestrator(deps).run(codeChange({ targetFiles: ['src/missing.js'] }));
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.CODE_GENERATION);
    expect(out.stoppedReason).toContain('target-read-failed');
    expect(calls.codeGen).toBe(0);
    expect(calls.diff).toBe(0);
  });

  it('a target whose content carries credential material → STOPPED_ON_FAILURE; generate never called, no path in reason', async () => {
    const { deps, calls } = makeDeps({ read: () => '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE"}' });
    const out = await new ExecutionOrchestrator(deps).run(codeChange({ targetFiles: ['config/app.json'] }));
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.lastStage).toBe(ExecutionStage.CODE_GENERATION);
    expect(out.stoppedReason).toContain('target-contains-credential');
    expect(out.stoppedReason).not.toContain('config/app.json');
    expect(calls.codeGen).toBe(0);
  });

  it('an oversized target → STOPPED_ON_FAILURE at CODE_GENERATION (never truncated); generate never called', async () => {
    const { deps, calls } = makeDeps({ read: () => 'x'.repeat(64 * 1024 + 1) });
    const out = await new ExecutionOrchestrator(deps).run(codeChange({ targetFiles: ['src/big.js'] }));
    expect(out.status).toBe(ExecutionOutcomeStatus.STOPPED_ON_FAILURE);
    expect(out.stoppedReason).toContain('target-too-large');
    expect(calls.codeGen).toBe(0);
  });

  it('no targetFiles → unchanged behavior (no read, no contextFiles)', async () => {
    const { deps, calls } = makeDeps();
    const out = await new ExecutionOrchestrator(deps).run(codeChange());
    expect(out.status).toBe(ExecutionOutcomeStatus.COMPLETED);
    expect(calls.read).toEqual([]);
    expect(calls.lastGenerateInput?.contextFiles).toBeUndefined();
  });
});
