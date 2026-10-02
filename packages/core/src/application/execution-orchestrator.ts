import {
  ApprovalStatus,
  Capability,
  CodeGenerationStatus,
  CommandExecutionStatus,
  WorkspaceChangeStatus,
  approvalRef,
  executionPlanRef,
} from '../domain';
import type {
  ApplyInput,
  ApprovalRef,
  ApprovalRequest,
  CodeGeneration,
  CodeProposal,
  CodeProposalRef,
  CommandExecution,
  ContextFile,
  ExecutionPlan,
  ExecutionPlanRef,
  GenerateCodeInput,
  Id,
  PatchGenerationInput,
  PatchSet,
  PlanningRequest,
  ProposedChange,
  RunCommandInput,
  WorkspaceChange,
  WorkspaceDiff,
  WorkspaceRef,
} from '../domain';
import type { Logger } from '../ports';
import { ExecutionReceiptRecordingError } from './execution-receipt-manager';
import { readCodeGenerationContextFiles } from './code-generation-context';

/**
 * Execution Orchestrator (Sprint 2j, ADR-0031) — the FIRST Application-layer
 * composition over the completed capabilities (CAP-001…009). It does NOT do any
 * capability's work: Planning plans, AI generates a proposal, Approval governs,
 * Patch builds, Workspace Write applies, Command Execution runs. The orchestrator
 * only **selects** which capability stages an intent needs (Capability Selection),
 * sequences them, threads Refs, halts at the Approval gate, and stops on
 * failure/denial/cancellation.
 *
 * Boundaries (CA-approved):
 *  - **Owns no aggregate.** Progress is the capabilities' aggregates (correlated by
 *    `executionPlanRef`); the orchestrator persists nothing. `ExecutionContext` and
 *    `ExecutionOutcome` are transient, rebuilt per invocation.
 *  - **Intra-task only.** It composes one `ExecutionPlan`'s stages — it is NOT the
 *    `Workflow` engine and NOT the Agent Runtime (single forward pass, no retry).
 *  - **Capability managers stay mutually unaware** — only the orchestrator composes
 *    them, and it depends on their public method shapes (narrow interfaces below),
 *    never on each other's internals. Provider selection stays with `ProviderSelector`.
 */

/** The ordered stages the orchestrator can run. A given execution runs a SUBSET. */
export enum ExecutionStage {
  PLANNING = 'PLANNING',
  CODE_GENERATION = 'CODE_GENERATION',
  WORKSPACE_DIFF = 'WORKSPACE_DIFF',
  APPROVAL = 'APPROVAL',
  PATCH = 'PATCH',
  WORKSPACE_WRITE = 'WORKSPACE_WRITE',
  COMMAND_EXECUTION = 'COMMAND_EXECUTION',
}

/** Terminal/halt status of one execution — Application-layer state, NOT an aggregate status. */
export enum ExecutionOutcomeStatus {
  COMPLETED = 'COMPLETED',
  AWAITING_APPROVAL = 'AWAITING_APPROVAL',
  DENIED = 'DENIED',
  STOPPED_ON_FAILURE = 'STOPPED_ON_FAILURE',
  CANCELLED = 'CANCELLED',
}

/** Cooperative cancellation signal (MB-3). Checked at stage boundaries only. */
export interface CancelToken {
  isCancelled(): boolean;
}

/** The orchestrator's entry input, produced by the Intent Resolver. */
export interface ExecutionRequest {
  goal: string;
  /** What the AI should author (code generation instruction). */
  instruction: string;
  /** Capabilities the intent requires — drives Capability Selection (MB-1). */
  requiredCapabilities: Capability[];
  /** Principal id for the approval request. */
  requestedBy: string;
  projectId?: Id;
  /** Resolved working directory for FS/command stages (read-only context for codegen). */
  workspaceRef?: WorkspaceRef;
  targetFiles?: string[];
  /**
   * The subset of `targetFiles` that originated from the EXPLICIT new-file flow (Sprint 4c-Follow-up-3,
   * F3-A). Set ONLY by `ConversationRuntime.handleExecutionIntent` via `explicitNewFileTarget` (A2) and
   * threaded through `IntentResolver.resolve`; never from user text, never by `IntentClassifier`, never
   * from the scope-clarification recovery (which only ever routes existing files). It is the positive
   * ORIGIN signal that lets `runCodeGenerationPreview` accept a `changeKind='add'` diff — and only for a
   * path that is also re-verified as non-existent by a read-only existence check at diff time.
   */
  newFileTargets?: string[];
  /** Optional command to run (e.g. tests) when COMMAND_EXECUTION is selected. */
  command?: { command: string; args: string[] };
  /**
   * Request PLANNING + APPROVAL only — skip CODE_GENERATION/WORKSPACE_DIFF/PATCH/WORKSPACE_WRITE/
   * COMMAND_EXECUTION this turn (Sprint 2n, ADR-0035). Absent/false preserves the full pipeline.
   *
   * SCOPE CONSTRAINT (ADR-0035): a narrow Application-layer execution mode for the first live
   * CODE_IMPLEMENTATION product slice — NOT a general stage-override system. Set only by
   * `IntentResolver`, only when `intent.capability === Capability.CODE_IMPLEMENTATION`. Never set
   * from user input, never by `IntentClassifier`, never generalized to another capability.
   */
  planningOnly?: boolean;
}

/**
 * In-flight Application-layer context (MB-2). NOT an aggregate, NOT persisted,
 * rebuilt on each `run`/`resume` (consistent with the stateless orchestrator).
 */
export interface ExecutionContext {
  executionPlanRef?: ExecutionPlanRef;
  workspaceRef?: WorkspaceRef;
  projectId?: Id;
  requestedBy: string;
  selectedStages: ExecutionStage[];
  logger: Logger;
  cancelToken?: CancelToken;
}

/** Refs gathered as the pipeline advances — surfaced on the outcome, never persisted. */
export interface ExecutionRefs {
  executionPlanRef?: ExecutionPlanRef;
  codeGenerationId?: Id;
  codeProposalRef?: CodeProposalRef;
  approvalRef?: ApprovalRef;
  patchSetId?: Id;
  workspaceChangeId?: Id;
  commandExecutionId?: Id;
  workspaceRef?: WorkspaceRef;
}

/** Transient read-model returned by the orchestrator (NOT an aggregate). */
export interface ExecutionOutcome {
  status: ExecutionOutcomeStatus;
  lastStage: ExecutionStage;
  selectedStages: ExecutionStage[];
  refs: ExecutionRefs;
  stoppedReason?: string;
}

/**
 * Narrow capability dependencies — only the public methods the orchestrator calls.
 * The real CAP managers structurally satisfy these; the orchestrator never imports a
 * concrete manager, and the managers never import each other.
 */
export interface ExecutionOrchestratorDeps {
  readonly planning: { plan(request: PlanningRequest): Promise<ExecutionPlan> };
  readonly codeGeneration: {
    generate(input: GenerateCodeInput): Promise<CodeGeneration>;
    getProposal(generation: CodeGeneration): Promise<CodeProposal | null>;
    get(id: Id): Promise<CodeGeneration | null>;
  };
  readonly workspace: {
    diff(ref: WorkspaceRef, changes: ProposedChange[]): Promise<WorkspaceDiff>;
    /** Read-only WorkspaceManager.read (CAP-001) — reused for codegen target context (QA-012). */
    read(ref: WorkspaceRef, relPath: string): Promise<string>;
  };
  readonly approval: {
    requestFor(plan: ExecutionPlan, requestedBy: string): Promise<ApprovalRequest>;
    get(id: Id): Promise<ApprovalRequest | null>;
  };
  readonly patch: { generate(input: PatchGenerationInput): Promise<PatchSet> };
  readonly workspaceWrite: { apply(input: ApplyInput): Promise<WorkspaceChange> };
  readonly command: { run(input: RunCommandInput): Promise<CommandExecution> };
  readonly logger: Logger;
}

/**
 * Capability Selection (MB-1): map a request's required capabilities to the ordered
 * SUBSET of stages this execution needs — `Intent → Capability Selection → Pipeline`.
 * This is NOT provider selection (`ProviderSelector` picks the provider per capability).
 */
export function selectStages(request: ExecutionRequest): ExecutionStage[] {
  const caps = new Set(request.requiredCapabilities);
  const needsCode = caps.has(Capability.CODE_IMPLEMENTATION);
  // planningOnly (ADR-0035) requests PLANNING + APPROVAL only — no codegen/diff/patch/write this
  // turn. Absent/false for every pre-Sprint-2n caller, so needsCodeGeneration === needsCode exactly.
  const needsCodeGeneration = needsCode && !request.planningOnly;
  const needsCommand = caps.has(Capability.TEST_EXECUTION) && request.command !== undefined;

  const stages: ExecutionStage[] = [ExecutionStage.PLANNING]; // always the entry stage
  if (needsCodeGeneration) stages.push(ExecutionStage.CODE_GENERATION, ExecutionStage.WORKSPACE_DIFF);
  // Approval gates every mutating/executing stage; auto-APPROVED for LOW/MEDIUM by the
  // ApprovalManager, PENDING (→ halt) only for HIGH/CRITICAL.
  if (needsCode || needsCommand) stages.push(ExecutionStage.APPROVAL);
  if (needsCodeGeneration) stages.push(ExecutionStage.PATCH, ExecutionStage.WORKSPACE_WRITE);
  if (needsCommand) stages.push(ExecutionStage.COMMAND_EXECUTION);
  return stages;
}

export class ExecutionOrchestrator {
  constructor(private readonly deps: ExecutionOrchestratorDeps) {}

  /**
   * Run an execution: select stages → build context → run the selected pipeline.
   * Halts at the Approval gate (PENDING) returning `AWAITING_APPROVAL`; stops on any
   * failure, denial, or cancellation WITHOUT calling the next capability.
   */
  async run(request: ExecutionRequest, cancelToken?: CancelToken): Promise<ExecutionOutcome> {
    const selectedStages = selectStages(request);
    const ctx = this.buildContext(request, selectedStages, cancelToken);
    const refs: ExecutionRefs = {};
    if (request.workspaceRef) refs.workspaceRef = request.workspaceRef;

    // STAGE 1: PLANNING (always first) — produces the plan + correlation root.
    if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.PLANNING, selectedStages, refs);
    let plan: ExecutionPlan;
    try {
      plan = await this.deps.planning.plan({
        goal: request.goal,
        requiredCapabilities: request.requiredCapabilities,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        ...(request.targetFiles ? { requiredResources: request.targetFiles } : {}),
      });
    } catch (err) {
      return this.failed(ExecutionStage.PLANNING, selectedStages, refs, err);
    }
    ctx.executionPlanRef = executionPlanRef(plan);
    refs.executionPlanRef = ctx.executionPlanRef;
    this.deps.logger.info('execution: planned', { planId: plan.id, stages: selectedStages.join(',') });

    // STAGE 2-3: AI Code Generation + Workspace diff (pre-approval authoring).
    let changes: ProposedChange[] | undefined;
    let diff: WorkspaceDiff | undefined;
    if (selectedStages.includes(ExecutionStage.CODE_GENERATION)) {
      if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.CODE_GENERATION, selectedStages, refs);
      // QA-012: the AI request carries no cwd (CAP-008 MB-2) — inject each validated target's current
      // content as bounded read-only contextFiles via WorkspaceManager.read (CAP-001). An unreadable or
      // oversized target stops this stage before any AI call (never truncated, never an implicit 'add').
      let contextFiles: ContextFile[] = [];
      if (request.workspaceRef && request.targetFiles?.length) {
        const context = await readCodeGenerationContextFiles(
          this.deps.workspace,
          request.workspaceRef,
          request.targetFiles,
          request.newFileTargets ?? [],
        );
        if (!context.ok) {
          return this.failed(
            ExecutionStage.CODE_GENERATION,
            selectedStages,
            refs,
            `code generation context ${context.reason} (target #${context.targetIndex})`,
          );
        }
        contextFiles = context.contextFiles;
      }
      let generation: CodeGeneration;
      try {
        generation = await this.deps.codeGeneration.generate({
          executionPlanRef: ctx.executionPlanRef,
          capability: Capability.CODE_IMPLEMENTATION,
          instruction: request.instruction,
          ...(request.workspaceRef ? { workspaceRef: request.workspaceRef } : {}),
          ...(request.targetFiles ? { targetFiles: request.targetFiles } : {}),
          ...(contextFiles.length ? { contextFiles } : {}),
        });
      } catch (err) {
        return this.failed(ExecutionStage.CODE_GENERATION, selectedStages, refs, err);
      }
      refs.codeGenerationId = generation.id;
      if (generation.status !== CodeGenerationStatus.SUCCEEDED) {
        const why = generation.failureKind ? ` (${generation.failureKind})` : '';
        return this.failed(ExecutionStage.CODE_GENERATION, selectedStages, refs, `code generation ${generation.status}${why}`);
      }
      const proposal = await this.deps.codeGeneration.getProposal(generation);
      if (!proposal) return this.failed(ExecutionStage.CODE_GENERATION, selectedStages, refs, 'no code proposal produced');
      if (generation.codeProposalRef) refs.codeProposalRef = generation.codeProposalRef;
      changes = proposal.proposal;

      // Workspace diff (CAP-001) — for human review + Patch input.
      if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.WORKSPACE_DIFF, selectedStages, refs);
      if (!request.workspaceRef) return this.failed(ExecutionStage.WORKSPACE_DIFF, selectedStages, refs, 'workspace diff requires a workspaceRef');
      try {
        diff = await this.deps.workspace.diff(request.workspaceRef, changes);
      } catch (err) {
        return this.failed(ExecutionStage.WORKSPACE_DIFF, selectedStages, refs, err);
      }
    }

    // STAGE 4: Approval gate. requestFor auto-APPROVES LOW/MEDIUM; PENDING for HIGH/CRITICAL.
    if (selectedStages.includes(ExecutionStage.APPROVAL)) {
      if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.APPROVAL, selectedStages, refs);
      let request_: ApprovalRequest;
      try {
        request_ = await this.deps.approval.requestFor(plan, request.requestedBy);
      } catch (err) {
        return this.failed(ExecutionStage.APPROVAL, selectedStages, refs, err);
      }
      refs.approvalRef = approvalRef(request_);
      if (request_.status === ApprovalStatus.PENDING) {
        this.deps.logger.info('execution: awaiting approval', { planId: plan.id, approvalId: request_.id });
        return this.outcome(ExecutionOutcomeStatus.AWAITING_APPROVAL, ExecutionStage.APPROVAL, selectedStages, refs);
      }
      if (request_.status !== ApprovalStatus.APPROVED) {
        return this.outcome(ExecutionOutcomeStatus.DENIED, ExecutionStage.APPROVAL, selectedStages, refs, `approval ${request_.status}`);
      }
    }

    // STAGE 5-7: post-approval mutating/executing stages.
    return this.runMutatingStages(ctx, refs, request, changes, diff);
  }

  /**
   * Resume a flow halted at `AWAITING_APPROVAL` once the human has decided (MB-3 also
   * handles a user-cancel during the wait). Stateless: it re-reads the approval
   * aggregate and reconstructs the proposal/diff from the prior refs + the request —
   * the orchestrator stored nothing. The caller re-supplies the original request and
   * the halt outcome (the resume *wiring* is a future Conversation Runtime concern).
   */
  async resume(
    request: ExecutionRequest,
    prior: ExecutionOutcome,
    cancelToken?: CancelToken,
  ): Promise<ExecutionOutcome> {
    if (prior.status !== ExecutionOutcomeStatus.AWAITING_APPROVAL) {
      this.deps.logger.info('execution: resume ignored (not halted)', { status: prior.status });
      return prior; // only a halted flow can be resumed; idempotent otherwise
    }
    const selectedStages = prior.selectedStages;
    const refs: ExecutionRefs = { ...prior.refs };
    const ctx = this.buildContext(request, selectedStages, cancelToken);
    if (refs.executionPlanRef) ctx.executionPlanRef = refs.executionPlanRef;

    // Cancel during the approval wait (MB-3).
    if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.APPROVAL, selectedStages, refs);

    // Re-derive the decision from the (now possibly decided) approval aggregate.
    if (!refs.approvalRef) return this.failed(ExecutionStage.APPROVAL, selectedStages, refs, 'cannot resume without an approval reference');
    const decided = await this.deps.approval.get(refs.approvalRef.id);
    if (!decided) return this.failed(ExecutionStage.APPROVAL, selectedStages, refs, `approval ${refs.approvalRef.id} not found`);
    refs.approvalRef = approvalRef(decided);
    if (decided.status === ApprovalStatus.PENDING) {
      return this.outcome(ExecutionOutcomeStatus.AWAITING_APPROVAL, ExecutionStage.APPROVAL, selectedStages, refs);
    }
    if (decided.status !== ApprovalStatus.APPROVED) {
      return this.outcome(ExecutionOutcomeStatus.DENIED, ExecutionStage.APPROVAL, selectedStages, refs, `approval ${decided.status}`);
    }

    // Reconstruct the proposal + diff from refs (only when PATCH is selected).
    let changes: ProposedChange[] | undefined;
    let diff: WorkspaceDiff | undefined;
    if (selectedStages.includes(ExecutionStage.PATCH)) {
      if (!refs.codeGenerationId) return this.failed(ExecutionStage.PATCH, selectedStages, refs, 'cannot resume: missing code-generation reference');
      const generation = await this.deps.codeGeneration.get(refs.codeGenerationId);
      if (!generation) return this.failed(ExecutionStage.PATCH, selectedStages, refs, 'cannot resume: code generation not found');
      const proposal = await this.deps.codeGeneration.getProposal(generation);
      if (!proposal) return this.failed(ExecutionStage.PATCH, selectedStages, refs, 'cannot resume: code proposal not found');
      changes = proposal.proposal;
      if (!request.workspaceRef) return this.failed(ExecutionStage.WORKSPACE_DIFF, selectedStages, refs, 'cannot resume: missing workspaceRef');
      try {
        diff = await this.deps.workspace.diff(request.workspaceRef, changes);
      } catch (err) {
        return this.failed(ExecutionStage.WORKSPACE_DIFF, selectedStages, refs, err);
      }
    }

    this.deps.logger.info('execution: resumed (approved)', { approvalId: decided.id });
    return this.runMutatingStages(ctx, refs, request, changes, diff);
  }

  /** STAGE 5-7: Patch → Workspace Write → Command Execution (those that are selected). */
  private async runMutatingStages(
    ctx: ExecutionContext,
    refs: ExecutionRefs,
    request: ExecutionRequest,
    changes: ProposedChange[] | undefined,
    diff: WorkspaceDiff | undefined,
  ): Promise<ExecutionOutcome> {
    const { selectedStages } = ctx;
    const planRef = refs.executionPlanRef;
    if (!planRef) return this.failed(ExecutionStage.PATCH, selectedStages, refs, 'missing execution plan reference');
    const approved = refs.approvalRef;

    let patchSet: PatchSet | undefined;
    if (selectedStages.includes(ExecutionStage.PATCH)) {
      if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.PATCH, selectedStages, refs);
      if (!approved || approved.status !== ApprovalStatus.APPROVED) {
        return this.failed(ExecutionStage.PATCH, selectedStages, refs, 'patch requires an APPROVED approval');
      }
      if (!changes || !diff) return this.failed(ExecutionStage.PATCH, selectedStages, refs, 'patch requires code changes and a diff');
      try {
        patchSet = await this.deps.patch.generate({ executionPlanRef: planRef, approvalRef: approved, changes, diff });
      } catch (err) {
        return this.failed(ExecutionStage.PATCH, selectedStages, refs, err);
      }
      refs.patchSetId = patchSet.id;
    }

    if (selectedStages.includes(ExecutionStage.WORKSPACE_WRITE)) {
      if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.WORKSPACE_WRITE, selectedStages, refs);
      if (!patchSet) return this.failed(ExecutionStage.WORKSPACE_WRITE, selectedStages, refs, 'workspace write requires a patch set');
      if (!approved) return this.failed(ExecutionStage.WORKSPACE_WRITE, selectedStages, refs, 'workspace write requires an approval');
      if (!request.workspaceRef) return this.failed(ExecutionStage.WORKSPACE_WRITE, selectedStages, refs, 'workspace write requires a workspaceRef');
      let change: WorkspaceChange;
      try {
        change = await this.deps.workspaceWrite.apply({ patchSet, approvalRef: approved, workspaceRef: request.workspaceRef });
      } catch (err) {
        return this.failed(ExecutionStage.WORKSPACE_WRITE, selectedStages, refs, err);
      }
      refs.workspaceChangeId = change.id;
      if (change.status !== WorkspaceChangeStatus.APPLIED) {
        return this.failed(ExecutionStage.WORKSPACE_WRITE, selectedStages, refs, `workspace write ${change.status}`);
      }
    }

    if (selectedStages.includes(ExecutionStage.COMMAND_EXECUTION)) {
      if (this.cancelledAt(ctx)) return this.cancelled(ExecutionStage.COMMAND_EXECUTION, selectedStages, refs);
      if (!request.command) return this.failed(ExecutionStage.COMMAND_EXECUTION, selectedStages, refs, 'command execution requires a command');
      if (!request.workspaceRef) return this.failed(ExecutionStage.COMMAND_EXECUTION, selectedStages, refs, 'command execution requires a workspaceRef');
      let execution: CommandExecution;
      try {
        execution = await this.deps.command.run({
          executionPlanRef: planRef,
          ...(approved ? { approvalRef: approved } : {}),
          workspaceRef: request.workspaceRef,
          command: request.command.command,
          args: request.command.args,
        });
      } catch (err) {
        if (err instanceof ExecutionReceiptRecordingError) {
          // The command already reached a terminal persisted state before CAP-013
          // receipt recording failed. Preserve its canonical id so downstream
          // consumers report the real command result instead of "never ran".
          refs.commandExecutionId = err.commandExecutionId;
        }
        return this.failed(ExecutionStage.COMMAND_EXECUTION, selectedStages, refs, err);
      }
      refs.commandExecutionId = execution.id;
      if (execution.status !== CommandExecutionStatus.SUCCEEDED) {
        return this.failed(ExecutionStage.COMMAND_EXECUTION, selectedStages, refs, `command ${execution.status}`);
      }
    }

    const lastStage = selectedStages[selectedStages.length - 1] ?? ExecutionStage.PLANNING;
    this.deps.logger.info('execution: completed', { stages: selectedStages.join(',') });
    return this.outcome(ExecutionOutcomeStatus.COMPLETED, lastStage, selectedStages, refs);
  }

  private buildContext(
    request: ExecutionRequest,
    selectedStages: ExecutionStage[],
    cancelToken?: CancelToken,
  ): ExecutionContext {
    return {
      requestedBy: request.requestedBy,
      selectedStages,
      logger: this.deps.logger,
      ...(request.workspaceRef ? { workspaceRef: request.workspaceRef } : {}),
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(cancelToken ? { cancelToken } : {}),
    };
  }

  private cancelledAt(ctx: ExecutionContext): boolean {
    return ctx.cancelToken?.isCancelled() === true;
  }

  private cancelled(stage: ExecutionStage, selectedStages: ExecutionStage[], refs: ExecutionRefs): ExecutionOutcome {
    this.deps.logger.info('execution: cancelled', { stage });
    return this.outcome(ExecutionOutcomeStatus.CANCELLED, stage, selectedStages, refs, `cancelled before ${stage}`);
  }

  private failed(
    stage: ExecutionStage,
    selectedStages: ExecutionStage[],
    refs: ExecutionRefs,
    reason: unknown,
  ): ExecutionOutcome {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.deps.logger.error('execution: stopped on failure', { stage, reason: message });
    return this.outcome(ExecutionOutcomeStatus.STOPPED_ON_FAILURE, stage, selectedStages, refs, `${stage}: ${message}`);
  }

  private outcome(
    status: ExecutionOutcomeStatus,
    lastStage: ExecutionStage,
    selectedStages: ExecutionStage[],
    refs: ExecutionRefs,
    stoppedReason?: string,
  ): ExecutionOutcome {
    return {
      status,
      lastStage,
      selectedStages,
      refs,
      ...(stoppedReason ? { stoppedReason } : {}),
    };
  }
}
