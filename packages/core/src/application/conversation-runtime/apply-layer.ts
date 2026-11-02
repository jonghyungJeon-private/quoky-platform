import { ApprovalStatus, CommandExecutionStatus, RiskLevel, approvalRef, commandExecutionRef, patchRef, workspaceChangeRef } from '../../domain';
import type { Actor, ApplyInput, CommandExecution, InboundMessage, PatchSet, Session, WorkspaceChange, WorkspaceDiff } from '../../domain';
import { normalizeRelativePath } from '../target-scope';
import {
  classifyUnverifiedChangeSet,
  isSingleUpdateChangeSet,
  validateChangeSetForApply,
  validatePatchableDiff,
  verifyAppliedChangeSet,
} from '../code-work/code-change-set';
import { ConversationRuntimeCodeGenerationLayer } from './code-generation-layer';
import { filterInScopeChanges } from './helpers';
import { interpretDecision, interpretPushIntent, toTestResultDetail } from './turn-intents';
import type { ApplyPreviewAnchor, TurnResult } from './types';

export abstract class ConversationRuntimeApplyLayer extends ConversationRuntimeCodeGenerationLayer {
  /**
   * Discard an ELIGIBLE diff preview on "취소" (QA-V2-CL-03). Clears the inert apply-preview anchor only — no
   * ApprovalRequest existed, no PatchSet, no file change — so a later "적용해줘" gets the apply-unavailable reply.
   * Deterministic, provider-free. Truthful copy: preview discarded, no file changed; content already sent to the AI
   * under an owner override (ADR-0097) cannot be unsent.
   *
   * The clear is conditional ({@link ApplyPreviewFlow.clearIfCurrent}): the flow re-reads the live session and clears
   * only while its current anchor is still THIS preview (same code generation) at `ELIGIBLE`. If another turn
   * advanced it meanwhile (ELIGIBLE → AWAITING_APPROVAL → APPROVED) nothing is cleared and the reply is the
   * non-mutating "state changed" copy. A flow without the conditional clear fails closed the same way.
   */
  protected async handlePreviewDiscardTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // A malformed persisted anchor without a generation id cannot be matched — fail closed like a lost race.
    const codeGenerationId = anchor.codeGenerationRef?.id;
    const cleared = this.deps.applyPreviewFlow.clearIfCurrent && codeGenerationId
      ? await this.deps.applyPreviewFlow.clearIfCurrent(session, { status: 'ELIGIBLE', codeGenerationId })
      : false;
    if (!cleared) {
      return this.respondComposed(message, session, this.deps.composer.composeCodePreviewDiscardSuperseded(message.context));
    }
    const reply = this.deps.composer.composeCodePreviewDiscarded(message.context, anchor.credentialOverrideSentPaths ?? []);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'CANCELLED', reply, sessionId: session.id };
  }

  /** No eligible apply-preview anchor exists at all (Sprint 2s, ADR-0040) — an explicit apply phrase is
   *  never reinterpreted as a new, unscoped code-change request. Never reaches the classifier or the
   *  Orchestrator. */
  protected async handleApplyPreviewUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeApplyPreviewUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** The apply approval was already decided APPROVED and the user asked to apply again (Sprint 2s,
   *  ADR-0040) — never re-asks, never creates a duplicate approval. */
  protected async handleApplyAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeApplyApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /**
   * An explicit apply phrase arrived while the anchor is ELIGIBLE (Sprint 2s, ADR-0040) — create the
   * second, HIGH-risk ApprovalRequest and halt. Never calls ExecutionOrchestrator, Patch, WorkspaceWrite,
   * or CommandExecution.
   */
  protected async handleApplyIntentTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    if (!anchor.workspaceRef || !anchor.targetFiles.length || !anchor.codeProposalRef) {
      // Defensive — the anchor is always written complete (runCodeGenerationPreview), but never trust
      // it blindly.
      const reply = this.deps.composer.composeApplyPreviewUnavailable(message.context);
      return this.failComposed(message, session, reply);
    }
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.HIGH, // apply approval is unconditionally HIGH, never auto-approved
      reason:
        `Apply AI code proposal ${anchor.codeProposalRef.id} from generation ${anchor.codeGenerationRef.id} ` +
        `to ${anchor.targetFiles.join(', ')}`,
      requestedBy: actor.id,
    });
    const pendingAnchor: ApplyPreviewAnchor = { ...anchor, status: 'AWAITING_APPROVAL', approvalId: approval.id };
    await this.deps.applyPreviewFlow.anchor(session, pendingAnchor);
    const reply = this.deps.composer.composeApplyApprovalRequested(message.context, anchor.targetFiles);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply: this.previewWithReference(session, reply, approval, pendingAnchor), sessionId: session.id };
  }

  /**
   * Decide the already-created second (apply) approval (Sprint 2s, ADR-0040). Reuses the same
   * interpretDecision (./approval-decision) the first approval uses — only the *creation* trigger needed a
   * distinct word-set, not the decision itself. Approving re-anchors as
   * APPROVED (never clears) so a future Apply sprint can recover every ref; denying/cancelling clears.
   */
  protected async handleApplyApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const decision = interpretDecision(message.text);
    if (decision === 'ambiguous') {
      return this.respondAnchoredReminder(
        message,
        session,
        anchor.approvalId!,
        anchor,
        this.deps.composer.composeApplyPreviewUnavailable(message.context), // pathological
      );
    }
    // ADR-0113 D7: the shared decision path (expiry re-check, decide, re-anchor APPROVED or clear) — the UI runs it too.
    return this.decisionTurn(
      session,
      await this.approvalDecisions.decideAnchored(this.chatDecision(message, session, actor), anchor, decision),
    );
  }

  /**
   * An explicit patch command arrived while the apply anchor is APPROVED (Sprint 2t, ADR-0041) — recover
   * the approved context, re-validate against the latest workspace content, and generate a PatchSet
   * REPRESENTATION via the existing Patch capability (CAP-005). Never applies: no WorkspaceWrite, no
   * CommandExecution, no git/file mutation. The Application layer derives the ApprovalRef and injects it;
   * PatchManager never queries ApprovalManager. On success the anchor becomes PATCH_READY (patchRef
   * preserved for Sprint 2u); a PatchSet existing does NOT mean it was applied.
   */
  protected async handlePatchGenerationTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. Approved-context guards.
    if (!anchor.approvalId || !anchor.workspaceRef || !anchor.targetFiles.length || !anchor.codeProposalRef) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }
    const approval = await this.deps.approvals.get(anchor.approvalId);
    if (!approval || approval.status !== ApprovalStatus.APPROVED) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }

    // 2. Source of truth = the CodeProposal aggregate, never rendered diff text / chat memory.
    const proposal = await this.deps.codeProposals.get(anchor.codeProposalRef.id);
    if (!proposal) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }

    // 3. Re-filter against validated targetFiles — targetFiles stays authoritative.
    const { inScope } = filterInScopeChanges(proposal.proposal, anchor.targetFiles);
    if (inScope.length === 0) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }

    // 4. Re-run WorkspaceManager.diff against CURRENT content — staleness/add/binary/empty check.
    let diff: WorkspaceDiff;
    try {
      diff = await this.deps.workspace.diff(anchor.workspaceRef, inScope);
    } catch {
      this.logPatchGenerationFailed(session, anchor, 'workspace diff failed');
      return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
    }
    // No PatchSet for empty / delete / binary / oversized (empty unified) / out-of-bounds results, nor for an
    // `add` outside the anchor's persisted newFileTargets (ADR-0099 D1; a pre-ADR-0099 anchor admits none).
    const patchable = validatePatchableDiff(diff, anchor);
    if (!patchable.ok) {
      this.logPatchGenerationFailed(session, anchor, patchable.reason);
      return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
    }
    // Each `add` path is re-checked absent (read-only list; never creates anything) — ADR-0099 D1.
    for (const addPath of patchable.addPaths) {
      let exists: boolean;
      try {
        const hits = await this.deps.workspace.list(anchor.workspaceRef, addPath);
        exists = hits.some((hit) => normalizeRelativePath(hit) === normalizeRelativePath(addPath));
      } catch {
        exists = true; // cannot confirm absence → fail closed
      }
      if (exists) {
        this.logPatchGenerationFailed(session, anchor, 'new-file target exists or could not be checked');
        return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
      }
    }

    // 5. Application derives the ApprovalRef; PatchManager receives it and re-validates.
    let patchSet: PatchSet;
    try {
      patchSet = await this.deps.patch.generate({
        executionPlanRef: anchor.executionPlanRef,
        approvalRef: approvalRef(approval),
        changes: inScope,
        diff,
      });
    } catch {
      this.logPatchGenerationFailed(session, anchor, 'patch generation failed');
      return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
    }

    // 6. Preserve PatchRef on the anchor for Sprint 2u — re-anchor PATCH_READY, never clear.
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'PATCH_READY', patchRef: patchRef(patchSet) });

    // 7. ResponseComposer renders the preview from PatchSet facts.
    const reply = this.deps.composer.composePatchSetPreview(message.context, {
      operations: patchSet.operations.map((op) => ({ path: op.path, kind: op.operation, unified: op.diff })),
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A patch command arrived while the anchor is already PATCH_READY (Sprint 2t) — never regenerates. */
  protected async handlePatchAlreadyGeneratedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePatchAlreadyGenerated(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A patch command arrived with no APPROVED/PATCH_READY apply context (Sprint 2t) — never a new
   *  code-change request, never reaches the classifier or the Orchestrator. */
  protected async handlePatchUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePatchUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for PatchSet generation (Sprint 2t, ADR-0041 — CA Round 1) — so
   *  operators can trace failures without the user seeing internals and without leaking diff/file text. */
  protected logPatchGenerationFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('PatchSet generation failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
      approvalId: anchor.approvalId,
      codeProposalId: anchor.codeProposalRef.id,
      targetFiles: anchor.targetFiles.join(', '),
    }); // deliberately NO diff text / file content
  }

  /**
   * An explicit final workspace-apply command arrived while the anchor is PATCH_READY (Sprint 2u,
   * ADR-0042) — the first real file mutation. Loads the PatchSet by patchRef, verifies its integrity
   * (identity/status/approval/plan, 1..5 in-scope `update`/`add` ops with add ⇔ newFileTargets — ADR-0099),
   * applies it through WorkspaceWrite (the ONLY file mutator: a single `update` via the per-file `apply`, any
   * other set via the all-or-nothing `applyChangeSet`; both re-validate each diff against current content),
   * verifies the returned WorkspaceChange, and re-anchors WORKSPACE_APPLIED. Never calls git,
   * CommandExecution, ExecutionOrchestrator, PatchManager.generate, or CodeGeneration.
   */
  protected async handleWorkspaceApplyTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. Anchor-state guard: PATCH_READY must carry a patchRef + the refs we need.
    if (!anchor.patchRef || !anchor.workspaceRef || !anchor.approvalId || !anchor.executionPlanRef) {
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyUnavailable(message.context));
    }

    // 2. Load the PatchSet — the artifact to apply (CA Q2).
    const patchSet = await this.deps.patch.get(anchor.patchRef.id);
    if (!patchSet) {
      this.logWorkspaceApplyFailed(session, anchor, 'patch set not found');
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }

    // 3. PatchSet integrity (CA Q5 + CA Round 1 #1/#2, widened by ADR-0099 D1): the anchored, GENERATED,
    //    approval/plan-bound PatchSet with 1..5 unique in-scope `update`/`add` ops, add ⇔ newFileTargets;
    //    delete/binary/out-of-scope all rejected.
    const integrity = validateChangeSetForApply(patchSet, anchor);
    if (!integrity.ok) {
      this.logWorkspaceApplyFailed(session, anchor, `patch set failed integrity/support checks: ${integrity.reason}`);
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }

    // 4. Apply through WorkspaceWrite — the ONLY file mutation. The single-`update` ADR-0042 shape keeps the
    //    per-file `apply` (its applyPatch re-validates the diff against current content: stale → 'failed',
    //    file unchanged). Every other allowed set goes through the all-or-nothing `applyChangeSet` (ADR-0099 D2).
    const applyInput: ApplyInput = {
      patchSet,
      approvalRef: patchSet.approvalRef, // the approval that authorized THIS patch (§5.3)
      workspaceRef: anchor.workspaceRef,
    };
    const single = isSingleUpdateChangeSet(patchSet.operations);
    const applyChangeSet = this.deps.workspaceWrite.applyChangeSet?.bind(this.deps.workspaceWrite);
    if (!single && !applyChangeSet) {
      this.logWorkspaceApplyFailed(session, anchor, 'change-set apply unavailable');
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }
    let change: WorkspaceChange;
    try {
      change = single || !applyChangeSet
        ? await this.deps.workspaceWrite.apply(applyInput)
        : await applyChangeSet(applyInput);
    } catch {
      this.logWorkspaceApplyFailed(session, anchor, 'workspace write threw');
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }

    // 5. Result-integrity gate (CA Round 1 #3/#4, ADR-0099 D2). Success requires APPLIED AND a full match of the
    //    returned change to the artifact/context, results one-to-one with the ops; anything else → no
    //    WORKSPACE_APPLIED. A change set reports by outcome: rolled back → "nothing changed"; a partial or
    //    unverifiable state → "may have applied" with the file list.
    if (!verifyAppliedChangeSet(change, patchSet, anchor.workspaceRef)) {
      this.logWorkspaceApplyFailed(session, anchor, `workspace change not cleanly applied (status ${change.status})`);
      const outcome = single ? 'failed' : classifyUnverifiedChangeSet(change);
      const files = patchSet.operations.map((o) => o.path);
      const reply =
        outcome === 'rolled-back'
          ? this.deps.composer.composeWorkspaceApplyRolledBack(message.context, files)
          : outcome === 'may-have-applied'
            ? this.deps.composer.composeWorkspaceApplyPartiallyApplied(message.context, files)
            : this.deps.composer.composeWorkspaceApplyFailed(message.context);
      return this.failComposed(message, session, reply);
    }

    // 6. Success — re-anchor WORKSPACE_APPLIED, preserving the WorkspaceChangeRef for a future git/test sprint.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'WORKSPACE_APPLIED',
      workspaceChangeRef: workspaceChangeRef(change),
    });
    const reply = this.deps.composer.composeWorkspaceApplied(
      message.context,
      patchSet.operations.map((o) => o.path),
      integrity.newFiles,
    );
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A final/patch/apply command arrived while the anchor is WORKSPACE_APPLIED (Sprint 2u) — never
   *  re-applies, and never understates the applied state (CA Round 1 #8). */
  protected async handleWorkspaceAlreadyAppliedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeWorkspaceAlreadyApplied(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A final-apply command arrived with no PATCH_READY/WORKSPACE_APPLIED apply context (Sprint 2u) —
   *  never a new code-change request, never reaches the classifier or the Orchestrator. */
  protected async handleWorkspaceApplyUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeWorkspaceApplyUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for workspace apply (Sprint 2u, ADR-0042 — CA Round 1) — so
   *  operators can trace failures without the user seeing internals and without leaking diff/file text. */
  protected logWorkspaceApplyFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('workspace apply failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
      approvalId: anchor.approvalId,
      patchId: anchor.patchRef?.id,
      targetFiles: anchor.targetFiles.join(', '),
    }); // deliberately NO diff text / file content
  }

  /**
   * An explicit post-apply validation command arrived while the anchor is WORKSPACE_APPLIED (Sprint 2v,
   * ADR-0043) — run exactly one allow-listed validation command (`pnpm test`/`pnpm typecheck`) through
   * CommandExecution, against the workspace the file was applied to (`anchor.workspaceRef`), tied to the
   * applied change (`anchor.workspaceChangeRef`). Never spawns a shell, calls git, mutates a file, or
   * touches the ExecutionOrchestrator. `kind` came from `interpretPostApplyValidationIntent`:
   *  - `'unsupported'` → a validation phrase carried an out-of-allow-list command fragment (CA #2);
   *  - `'ambiguous'`   → bare "검증" or BOTH test+typecheck requested (CA #1);
   * both are NORMAL responses (RESPONDED), run nothing, never re-anchor, never set a ref (CA #3).
   */
  protected async handlePostApplyValidationTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
    kind: 'test' | 'typecheck' | 'ambiguous' | 'unsupported',
  ): Promise<TurnResult> {
    // 1. (CA #2/#3) Dangerous/arbitrary command fragment → a distinct "unsupported" reply. NORMAL turn.
    if (kind === 'unsupported') {
      return this.respondComposed(message, session, this.deps.composer.composePostApplyValidationUnsupported(message.context));
    }

    // 2. (CA #1/#3) Ambiguous — bare "검증" OR both test+typecheck → ask for exactly one. NORMAL turn.
    if (kind === 'ambiguous') {
      return this.respondComposed(message, session, this.deps.composer.composePostApplyValidationClarify(message.context));
    }

    // 3. Anchor guard: WORKSPACE_APPLIED must carry the refs we need (defensive; set at apply time).
    if (!anchor.workspaceRef || !anchor.executionPlanRef) {
      return this.failComposed(message, session, this.deps.composer.composePostApplyValidationUnavailable(message.context));
    }

    // 4. Derive exactly one allow-listed command — NEVER from user text (CA Constraint 3 / #2).
    const args = kind === 'typecheck' ? ['typecheck'] : ['test'];

    // 5. Run via CommandExecution — the ONLY command runner. cwd = the applied workspace (CA Q6); tied to
    //    the applied change via workspaceChangeRef (CA Q8). `pnpm test`/`pnpm typecheck` are MEDIUM risk →
    //    no approvalRef needed. (CA #4) A throw BEFORE a CommandExecution exists → no re-anchor, no ref.
    let execution: CommandExecution;
    try {
      execution = await this.deps.command.run({
        executionPlanRef: anchor.executionPlanRef,
        workspaceRef: anchor.workspaceRef,
        ...(anchor.workspaceChangeRef ? { workspaceChangeRef: anchor.workspaceChangeRef } : {}),
        command: 'pnpm',
        args,
      });
    } catch {
      this.logPostApplyValidationFailed(session, anchor, 'command execution threw');
      return this.failComposed(message, session, this.deps.composer.composePostApplyValidationUnavailable(message.context));
    }

    // 6. (CA #4/#6) A CommandExecution now exists (SUCCEEDED/FAILED/TIMED_OUT). Preserve its ref on the
    //    anchor — LATEST ONLY (replaces any prior; no history on the anchor). `status` stays
    //    WORKSPACE_APPLIED — no WORKSPACE_VALIDATED.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      postApplyValidationRef: commandExecutionRef(execution),
    });

    // 7. Render (CA Q9/Q10/Q11) — reuses the Sprint 2m/2n bounded-output helpers via toTestResultDetail.
    const detail = toTestResultDetail(execution);
    if (
      execution.status === CommandExecutionStatus.SUCCEEDED ||
      execution.status === CommandExecutionStatus.FAILED
    ) {
      const passed = execution.status === CommandExecutionStatus.SUCCEEDED;
      const reply = passed
        ? this.deps.composer.composePostApplyValidationPassed(message.context, detail)
        : this.deps.composer.composePostApplyValidationFailed(message.context, detail);
      // pass and fail are both the project's result (not a bot error) — recorded as a normal turn.
      return this.respondComposed(message, session, reply);
    }
    if (execution.status === CommandExecutionStatus.TIMED_OUT) {
      const reply = this.deps.composer.composePostApplyValidationTimedOut(message.context, detail);
      return this.failComposed(message, session, reply);
    }
    // Non-terminal / unexpected (defensive) — CommandExecution normally returns a terminal status.
    return this.failComposed(message, session, this.deps.composer.composePostApplyValidationUnavailable(message.context));
  }

  /** Structured, no-content failure log for a post-apply validation error (Sprint 2v) — mirrors the Sprint
   *  2t/2u pattern; never logs stdout/stderr or file content. */
  protected logPostApplyValidationFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('post-apply validation failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
      workspaceChangeId: anchor.workspaceChangeRef?.id,
    }); // deliberately NO stdout/stderr / file content
  }

  /**
   * An explicit read-only git-preview command arrived while the anchor is WORKSPACE_APPLIED (Sprint 2w,
   * ADR-0044). Runs ONLY read-only Git methods (`git.status`, and for a diff preview `git.status` then
   * `git.diff`) against the applied workspace (`anchor.workspaceRef.rootPath`). Never shells out, never calls
   * a mutating git operation, WorkspaceWrite, CommandExecution, Patch, CodeGeneration, or the
   * ExecutionOrchestrator; never re-anchors. A git-MUTATION phrase is rejected (read-only reminder). A git
   * read throw → safe failure, with no CommandExecution/shell/re-resolve fallback.
   */
  protected async handleGitPreviewTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
    kind: 'status' | 'diff' | 'mutating',
  ): Promise<TurnResult> {
    // 1. (CA Q4/#6) A git MUTATION phrase → read-only "not supported" reply. NORMAL turn (RESPONDED),
    //    no git call, anchor unchanged.
    if (kind === 'mutating') {
      // QA-020: a push/remote request gets remote-specific copy; other local git mutations (add/reset/stash/…)
      // keep the local wording. Both point at the supported local commit phrase "커밋해줘".
      const scope = interpretPushIntent(message.text) !== null ? 'remote' : 'local';
      return this.respondComposed(
        message,
        session,
        this.deps.composer.composeGitMutationNotSupported(message.context, { scope, remoteEnabled: this.gitRemoteEnabled }),
      );
    }

    // 2. Anchor guard: WORKSPACE_APPLIED must carry the workspaceRef we read against (defensive).
    if (!anchor.workspaceRef) {
      return this.failComposed(message, session, this.deps.composer.composeGitPreviewUnavailable(message.context));
    }
    const rootPath = anchor.workspaceRef.rootPath;

    // 3. Read-only validation context (CA Q8/#8) — a missing/failed lookup NEVER fails the git preview.
    const validation = await this.loadValidationContext(anchor);

    // 4. Read-only Git call (CA Constraint 1/2, Q10/#2/#7). A throw → safe failure; NO CommandExecution/
    //    shell fallback, NO workspace re-resolution. A diff preview reads status FIRST (branch/clean +
    //    UNTRACKED paths, which `git diff HEAD` omits); if status throws, git.diff is NOT called (CA #7).
    try {
      if (kind === 'diff') {
        const status = await this.deps.git.status(rootPath);
        const diff = await this.deps.git.diff(rootPath);
        return this.respondComposed(message, session, this.deps.composer.composeGitDiffPreview(message.context, { status, diff, validation }));
      }
      const status = await this.deps.git.status(rootPath);
      return this.respondComposed(message, session, this.deps.composer.composeGitStatusPreview(message.context, { status, validation }));
    } catch {
      this.logGitPreviewFailed(session, anchor, `git ${kind} read failed`);
      return this.failComposed(message, session, this.deps.composer.composeGitPreviewUnavailable(message.context));
    }
  }

  /**
   * Read-only: resolve the last post-apply validation's command + status for git-preview display context
   * (Sprint 2w, CA Q8). Uses the existing read-only `commandExecutions.get`; never runs a command. `null`
   * ref → 'none'; a record that is gone or a THROW → 'unavailable' — a validation-lookup failure must NOT
   * fail the git preview (CA Required Change #8).
   */
  protected async loadValidationContext(
    anchor: ApplyPreviewAnchor,
  ): Promise<{ command: string; status: string } | 'unavailable' | 'none'> {
    const ref = anchor.postApplyValidationRef;
    if (!ref) return 'none';
    try {
      const exec = await this.deps.commandExecutions.get(ref.id);
      if (!exec) return 'unavailable';
      return { command: [exec.command, ...exec.args].join(' '), status: exec.status };
    } catch {
      return 'unavailable';
    }
  }

  /** Structured, no-content failure log for a git preview read error (Sprint 2w) — never logs diff/file
   *  content or stderr. */
  protected logGitPreviewFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('git preview failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
    }); // deliberately NO diff text / file content / stderr
  }
}
