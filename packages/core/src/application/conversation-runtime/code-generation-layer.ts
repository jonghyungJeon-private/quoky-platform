import { codeGenerationDispatchOfError } from '../code-generation-manager';
import {
  Capability,
  CodeGenerationStatus,
  codeGenerationRef,
  codeProposalRef,
} from '../../domain';
import type {
  Actor,
  ApprovalRequest,
  CodeGeneration,
  CodeGenerationDispatch,
  InboundMessage,
  OutboundMessage,
  Session,
  WorkspaceDiff,
} from '../../domain';
import {
  type LogFields,
} from '../../ports';
import { now } from '../../util/clock';
import { normalizeRelativePath } from '../target-scope';
import {
  type CredentialOverrideGrant,
  MAX_CODEGEN_CONTEXT_FILE_BYTES,
  MAX_CODEGEN_CONTEXT_TOTAL_BYTES,
  readCodeGenerationContextFiles,
} from '../code-generation-context';
import {
  type CredentialOverrideAnchor,
  type CredentialOverrideDispatchAuthorization,
  type CredentialOverrideInvalidationReason,
  type CredentialOverrideLookup,
  type CredentialOverrideRefusal,
  assessCredentialOverrideCoverage,
  interpretCredentialOverrideDecision,
} from '../credential-override';
import type {
  ExecutionOutcome,
  ExecutionOutcomeStatus,
  ExecutionRequest,
} from '../execution-orchestrator';
import {
  filterInScopeChanges,
  sameDispatchGrants,
  toCodeDiffPreview,
  toDispatchGrants,
} from './helpers';
import type { CodeGenerationPreparation, PreparedCodeGeneration } from './internal-types';
import { ConversationRuntimeNlDispatchLayer } from './nl-dispatch-layer';
import { interpretDecision } from './turn-intents';
import type { TurnResult } from './types';

export abstract class ConversationRuntimeCodeGenerationLayer extends ConversationRuntimeNlDispatchLayer {
  /** (A) A turn that lands while an approval is pending: interpret + route (ADR-0032 §6). */
  protected async handleApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    pending: ApprovalRequest,
  ): Promise<TurnResult> {
    const decision = interpretDecision(message.text);
    this.deps.logger.info('approval decision interpreted', { approvalId: pending.id, decision });

    if (decision === 'ambiguous') {
      // ADR-0093: a non-decision message is captured by the pending approval — a reminder, never chat.
      const reply = this.composePendingReminder(message.context, pending);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id }; // no resume
    }

    if (decision === 'approve') {
      // ADR-0113 D7: the shared decision path reconstructs FIRST (never records a decision we cannot act on), then
      // re-checks expiry and records the approval. The resume itself runs here, in chat only.
      const approved = await this.approvalDecisions.approvePlan(this.chatDecision(message, session, actor), pending);
      if (approved.kind === 'reply') return this.decisionTurn(session, approved.value);
      const ctx = { request: approved.request, prior: approved.prior };
      const outcome = await this.deps.orchestrator.resume(ctx.request, ctx.prior);
      // ADR-0038: a cleanly-resumed planningOnly request now runs an AI CodeGeneration preview
      // (never Patch/WorkspaceWrite/CommandExecution). A resume outcome that did NOT complete cleanly
      // (rare — e.g. the approval re-fetch failed) falls back to the existing generic handling.
      if (ctx.request.planningOnly) {
        if (outcome.status !== ('COMPLETED' as ExecutionOutcomeStatus)) {
          return this.replyForOutcome(message.context, session, outcome);
        }
        return this.runCodeGenerationPreview(message, session, ctx.request, outcome);
      }
      return this.replyForOutcome(message.context, session, outcome);
    }

    // deny / cancel — record the (rejecting) decision; never resume.
    return this.decisionTurn(session, await this.approvalDecisions.rejectPlan(this.chatDecision(message, session, actor), pending, decision));
  }

  /**
   * After a planningOnly CODE_IMPLEMENTATION approval resumes cleanly, run AI Code Generation once,
   * in preview mode, and render the result as a unified diff against the current workspace content
   * (ADR-0038, ADR-0039). Never calls ExecutionOrchestrator, Patch, WorkspaceWrite, or
   * CommandExecution — this method's only side effects are at most one CodeGenerationManager.generate()
   * call (CAP-008) and at most one WorkspaceManager.diff() call (CAP-001) — both read-only, neither
   * ever touches the filesystem. Before generate(), each validated (non-new-file) target's current
   * content is read through the read-only WorkspaceManager.read() (CAP-001) and passed as bounded
   * `contextFiles` (QA-012); an unreadable or oversized target fails the preview before any AI call.
   *
   * executionPlanRef, workspaceRef, and a non-empty targetFiles must ALL be present before
   * generate() is ever called — targetFiles is the only allowed scope source; there is no AI
   * target-file guessing. An empty diff result or a changeKind of 'add' for a validated target (its
   * current content could not be found/read at diff time) is a failed preview, never a partial or
   * degraded success (ADR-0039, CA Round 1).
   *
   * The credential-override dispatch (ADR-0097 D5) does not come through here: it prepares the same content
   * before its consume ({@link prepareCodeGeneration}) and enters {@link generateCodeChangePreview} directly.
   */
  protected async runCodeGenerationPreview(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
  ): Promise<TurnResult> {
    const prepared = await this.prepareCodeGeneration(request, outcome, []);
    if (!prepared.ok) return this.failCodeGenerationPreparation(message, session, request, outcome, prepared, []);
    return this.generateCodeChangePreview(message, session, request, outcome, prepared.value);
  }

  /**
   * Everything a code-change preview needs BEFORE the provider call: the refs, the targets and each validated
   * target's current content (QA-012). The AI request carries no workspace cwd (CAP-008 MB-2), so each validated
   * target's CURRENT content must arrive as read-only contextFiles — otherwise the provider only sees a bare path
   * and cannot propose a faithful full-file `newContent`. Read via the existing read-only WorkspaceManager.read
   * (CAP-001). An unreadable target or an oversized context is a failed preview (never truncated, never treated as
   * an 'add'); explicit new-file targets are skipped (they must not exist yet). generate() is never called on any
   * of these failures.
   *
   * `grants` admit exactly those refused files whose content still hashes to the grant (ADR-0097 D5). The override
   * path passes the grants it is about to consume, and only sends the prepared content once the flow has consumed
   * exactly those grants (`sameDispatchGrants`), so no read sits between the flow's final validation and generate().
   */
  protected async prepareCodeGeneration(
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    grants: readonly CredentialOverrideGrant[],
  ): Promise<CodeGenerationPreparation> {
    const planRef = outcome.refs.executionPlanRef;
    const workspaceRef = request.workspaceRef;
    const targetFiles = request.targetFiles;
    if (!planRef || !workspaceRef || !targetFiles?.length) return { ok: false, failure: 'missing-refs' };
    const context = await readCodeGenerationContextFiles(
      this.deps.workspace,
      workspaceRef,
      targetFiles,
      request.newFileTargets ?? [],
      { credentialOverrides: grants },
    );
    if (!context.ok) return { ok: false, failure: 'context', context };
    return { ok: true, value: { planRef, workspaceRef, targetFiles, contextFiles: context.contextFiles } };
  }

  /** The reply for a failed {@link prepareCodeGeneration} (nothing was sent to the provider). */
  protected async failCodeGenerationPreparation(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    failed: Extract<CodeGenerationPreparation, { ok: false }>,
    grants: readonly CredentialOverrideGrant[],
  ): Promise<TurnResult> {
    if (failed.failure === 'missing-refs') {
      this.logPreviewFailure('missing-refs-or-targets', message, session, request);
      return this.failComposed(
        message, session, this.deps.composer.composeCodeGenerationPreviewFailed(message.context), outcome,
      );
    }
    const context = failed.context;
    this.logPreviewFailure(`context-${context.reason}`, message, session, request, {
      targetIndex: context.targetIndex,
      maxFileBytes: MAX_CODEGEN_CONTEXT_FILE_BYTES,
      maxTotalBytes: MAX_CODEGEN_CONTEXT_TOTAL_BYTES,
    });
    const overrideFlow = this.deps.credentialOverrideFlow;
    // ADR-0097 D3: an overridable `credential-assignment` refusal (no hard failure on any target) raises ONE
    // CRITICAL owner override instead of the terminal refusal — only on the first, grant-free read (a refusal
    // inside a granted dispatch means the content changed after the coverage check: nothing is sent).
    if (
      context.reason === 'target-contains-credential' && context.overridable && overrideFlow && grants.length === 0
    ) {
      const refusal: CredentialOverrideRefusal = {
        targetIndex: context.targetIndex,
        targetPath: context.targetPath,
        contentSha256: context.contentSha256,
        line: context.line,
      };
      return this.requestCredentialOverride(message, session, request, outcome, refusal);
    }
    if (context.reason === 'target-changed-since-override') {
      this.deps.logger.warn('credential guard override content changed', {
        sessionId: session.id,
        targetIndex: context.targetIndex,
      });
      return this.failComposed(
        message,
        session,
        this.deps.composer.composeCredentialOverrideContentChanged(message.context, context.targetPath),
        outcome,
      );
    }
    // A target whose content carries credential material is never sent to the provider; the path
    // (user-supplied) goes to the reply only — the log above carries just the target index. With the
    // override flow wired, a token/private-key refusal also says it can never be sent (ADR-0097 D6).
    const reply = context.reason !== 'target-contains-credential'
      ? this.deps.composer.composeCodeGenerationPreviewFailed(message.context)
      : overrideFlow && !context.overridable
      ? this.deps.composer.composeCredentialOverrideHardRefused(message.context, context.targetPath)
      : this.deps.composer.composeCodeGenerationPreviewCredentialRefused(message.context, context.targetPath);
    return this.failComposed(message, session, reply, outcome);
  }

  /**
   * The provider call and the preview built from it, on content already prepared by {@link prepareCodeGeneration}.
   *
   * `override` (ADR-0097 D5, OVR-3 contract) is set only inside the credential-override flow's dispatch: the grants it
   * has just consumed, the grants the content was prepared under, and the dispatch's authorization. Then
   * - this method performs NO awaited I/O before generate(): the consumed grants must equal the prepared ones and
   *   `authorization.recheck()` (expiry by the injected clock, claim on the CONSUMED set, session ACTIVE and bound per
   *   the last canonical load) runs synchronously right before the call — otherwise nothing is sent;
   * - after the provider call it re-loads the canonical session and, unless it is still ACTIVE, bound to the same
   *   project and not re-pointed at a newer request, discards the preview (no anchor, no session save) and says the
   *   request was cancelled; otherwise the apply-preview anchor is written onto that FRESH session (never the turn's
   *   copy), so a reset close, a project switch or a newer pointer that landed meanwhile is never overwritten.
   */
  protected async generateCodeChangePreview(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    prepared: PreparedCodeGeneration,
    override?: {
      readonly grants: readonly CredentialOverrideGrant[];
      readonly preparedGrants: readonly CredentialOverrideGrant[];
      readonly authorization: CredentialOverrideDispatchAuthorization;
    },
  ): Promise<TurnResult> {
    const { planRef, workspaceRef, targetFiles, contextFiles } = prepared;
    const grants = override?.grants ?? [];
    // QA follow-up (ADR-0097 D7): once a granted dispatch has reached the provider, every later failure must say
    // the confirmed content WAS sent once but no proposal came of it (a fresh request and a fresh override are
    // needed) — never the plain "could not generate" copy that reads as if nothing left the machine.
    const afterSendFailure = (reply: OutboundMessage): OutboundMessage =>
      override
        ? this.deps.composer.composeCredentialOverrideSentNoProposal(message.context, grants.map((g) => g.path))
        : reply;
    // A failed generation reports truthfully how far the granted content got (ADR-0097 truthful copy): nothing
    // sent (failure before the provider was invoked), sent (the provider returned) or uncertain (the provider
    // call itself threw/timed out). The override was consumed in every case — it is never replayed.
    const generationFailure = (dispatch: CodeGenerationDispatch): OutboundMessage => {
      const failed = this.deps.composer.composeCodeGenerationPreviewFailed(message.context);
      if (!override) return failed;
      return dispatch === 'sent'
        ? afterSendFailure(failed)
        : this.deps.composer.composeCredentialOverrideGenerationFailed(
          message.context, grants.map((g) => g.path), dispatch,
        );
    };
    if (override) {
      // Synchronous — nothing below may await before generate() is invoked.
      const denied = sameDispatchGrants(override.grants, override.preparedGrants)
        ? override.authorization.recheck()
        : 'inconsistent';
      if (denied) {
        this.deps.logger.warn('credential guard override not dispatched', { sessionId: session.id, reason: denied });
        return this.failComposed(
          message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, denied), outcome,
        );
      }
    }

    let generation: CodeGeneration;
    try {
      generation = await this.deps.codeGeneration.generate({
        executionPlanRef: planRef,
        capability: Capability.CODE_IMPLEMENTATION,
        instruction: request.instruction,
        workspaceRef,
        targetFiles,
        ...(contextFiles.length ? { contextFiles } : {}),
      });
    } catch (err) {
      // An exception raised before provider.execute() was invoked is untagged → nothing was sent.
      const dispatch = codeGenerationDispatchOfError(err);
      this.logPreviewFailure('code-generation-exception', message, session, request, { dispatch });
      return this.failComposed(message, session, generationFailure(dispatch), outcome);
    }
    if (generation.status !== CodeGenerationStatus.SUCCEEDED) {
      // A recorded failure without a transmission state cannot be claimed as "not sent".
      const dispatch = generation.dispatch ?? 'uncertain';
      this.logPreviewFailure('code-generation-not-succeeded', message, session, request, {
        codeGenerationId: generation.id,
        dispatch,
        ...(generation.failureKind ? { failureKind: String(generation.failureKind) } : {}),
      });
      return this.failComposed(message, session, generationFailure(dispatch), outcome);
    }

    const proposal = await this.deps.codeGeneration.getProposal(generation);
    if (!proposal) {
      this.logPreviewFailure('missing-proposal', message, session, request, { codeGenerationId: generation.id });
      return this.failComposed(
        message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
      );
    }

    const { inScope, outOfScopeWarnings } = filterInScopeChanges(proposal.proposal, targetFiles);
    if (inScope.length === 0) {
      // Every proposed path was outside the validated targetFiles — never present this as a
      // successful code-change proposal.
      this.logPreviewFailure('out-of-scope-proposal', message, session, request, {
        codeGenerationId: generation.id,
        proposalId: proposal.id,
        outOfScopeCount: outOfScopeWarnings.length,
      });
      return this.failComposed(
        message,
        session,
        afterSendFailure(this.deps.composer.composeCodeGenerationPreviewNoValidChange(message.context, outOfScopeWarnings)),
        outcome,
      );
    }

    let diff: WorkspaceDiff;
    try {
      diff = await this.deps.workspace.diff(workspaceRef, inScope);
    } catch {
      // Read-only failure (e.g. current file unreadable) — same guaranteed non-mutation as every
      // other preview failure (ADR-0039, CA Round 1 Required Change #8).
      this.logPreviewFailure('workspace-diff-throw', message, session, request, {
        codeGenerationId: generation.id,
        proposalId: proposal.id,
      });
      return this.failComposed(
        message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
      );
    }

    // An empty diff result cannot be a successful preview (ADR-0039, CA Round 1 Required Change #3).
    if (diff.files.length === 0) {
      this.logPreviewFailure('empty-diff', message, session, request, {
        codeGenerationId: generation.id,
        proposalId: proposal.id,
      });
      return this.failComposed(
        message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
      );
    }

    // F3-A (Sprint 4c-Follow-up-3, CA APPROVED_WITH_CHANGES §3.1/§3.2): a `changeKind='add'` diff is a
    // valid NEW-FILE preview ONLY for a path that (a) originated from the EXPLICIT new-file flow
    // (`request.newFileTargets`, set by A2 — never inferred from arbitrary targetFiles), (b) is in
    // targetFiles, (c) normalizes to a safe relative path (already guaranteed by
    // extractTargetPathCandidates + normalizeRelativePath), and (d) a read-only existence check
    // confirms does NOT currently exist. Any other `add` — an existing/unreadable file, an
    // extra/unexpected path, or a path not from the explicit new-file flow — stays a FAILED preview
    // (preserves the ADR-0039/ADR-0036 safety the old unconditional gate provided). Every rejection is
    // non-mutating (no file is created — the existence check only lists) and emits an F3-B branch log.
    const normalizedTargets = new Set(targetFiles.map((p) => normalizeRelativePath(p)));
    const newFileTargets = new Set((request.newFileTargets ?? []).map((p) => normalizeRelativePath(p)));
    for (const file of diff.files) {
      if (file.changeKind !== 'add') continue;
      const norm = normalizeRelativePath(file.path);
      if (!newFileTargets.has(norm) || !normalizedTargets.has(norm)) {
        // 'add' for a non-explicit / unexpected / not-a-new-file target — the original failure.
        this.logPreviewFailure('unexpected-add-diff', message, session, request, {
          codeGenerationId: generation.id,
          proposalId: proposal.id,
        });
        return this.failComposed(
          message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
        );
      }
      // Read-only existence re-check (only lists; never creates the file): an explicit new-file target
      // must NOT already exist. If it exists — or we cannot confirm non-existence — reject; this keeps
      // the "existing file, content unreadable at diff time" case the old gate caught.
      let exists: boolean;
      try {
        const hits = await this.deps.workspace.list(workspaceRef, file.path);
        exists = hits.some((hit) => normalizeRelativePath(hit) === norm);
      } catch {
        this.logPreviewFailure('add-existence-check-failed', message, session, request, {
          codeGenerationId: generation.id,
          proposalId: proposal.id,
        });
        return this.failComposed(
          message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
        );
      }
      if (exists) {
        this.logPreviewFailure('add-diff-for-existing-file', message, session, request, {
          codeGenerationId: generation.id,
          proposalId: proposal.id,
        });
        return this.failComposed(
          message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
        );
      }
    }

    const diffPreview = toCodeDiffPreview(diff, outOfScopeWarnings);
    // ADR-0097 D7: a preview built from granted content leads with the one-time-send notice (in the preview
    // header, so lossless preview delivery keeps it); every other preview is rendered exactly as before.
    const reply = grants.length
      ? this.deps.composer.composeCodeDiffPreview(message.context, diffPreview, {
          credentialOverrideSentPaths: grants.map((g) => g.path),
        })
      : this.deps.composer.composeCodeDiffPreview(message.context, diffPreview);
    // ADR-0097 D5 (OVR-3 contract): a granted dispatch writes onto the canonical session re-loaded AFTER the provider
    // call, and only while it still admits this request; otherwise the preview is discarded (no anchor, no save).
    let anchorSession = session;
    if (override) {
      const reloaded = await override.authorization.reloadSession();
      if (!reloaded.ok) {
        this.deps.logger.warn('credential guard override preview discarded', {
          sessionId: session.id,
          reason: reloaded.reason,
          codeGenerationId: generation.id,
        });
        // Truthful: the granted content WAS sent once; the request itself is cancelled and nothing was kept
        // (dedicated copy — not the reused scope-clarification "request cancelled" text).
        const cancelled = this.deps.composer.composeCredentialOverrideSentThenCancelled(
          message.context,
          grants.map((g) => g.path),
        );
        return this.failComposed(message, session, cancelled, outcome);
      }
      anchorSession = reloaded.session;
    }
    // Sprint 2s (ADR-0040): remember what was just previewed, in case the user explicitly asks to apply
    // it on a later turn. A plan-less Task anchor — never discoverable by approvalFlow.
    await this.deps.applyPreviewFlow.anchor(anchorSession, {
      kind: 'code-preview-apply',
      status: 'ELIGIBLE',
      executionPlanRef: planRef,
      workspaceRef,
      targetFiles,
      // ADR-0099 D1: persist the explicit new-file targets — the only paths a later add may target.
      ...(newFileTargets.size ? { newFileTargets: [...newFileTargets] } : {}),
      codeGenerationRef: codeGenerationRef(generation),
      codeProposalRef: codeProposalRef(proposal),
      ...(grants.length ? { credentialOverrideSentPaths: grants.map((g) => g.path) } : {}),
      instruction: request.instruction,
      ...(anchorSession.activeProjectId ? { projectId: anchorSession.activeProjectId } : {}),
      createdAt: now(),
    });
    return this.respondComposed(message, session, reply, outcome);
  }

  /**
   * F3-B (Sprint 4c-Follow-up-3): secret-free branch log for an internally-caught preview failure. The
   * `runCodeGenerationPreview` failure branches are NOT covered by the inbound catch (Track B), so
   * without this the branch was only diagnosable by inspecting the sqlite aggregate (as the last
   * disambiguation required). Emits ONLY safe metadata — a branch identifier + non-secret ids/counts.
   * NEVER proposal content, file contents, rendered diff text, tokens, or secrets (the `Logger` port's
   * `LogFields` is primitive-only by contract, and callers pass only ids/counts).
   */
  protected logPreviewFailure(
    branch: string,
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    extra: LogFields = {},
  ): void {
    this.deps.logger.warn('code preview failed', {
      stage: 'code-generation-preview',
      branch,
      capability: 'CODE_IMPLEMENTATION',
      sessionId: session.id,
      messageId: message.id,
      ...(request.targetFiles ? { targetPathCount: request.targetFiles.length } : {}),
      ...(request.newFileTargets ? { newFileTargetCount: request.newFileTargets.length } : {}),
      ...extra,
    }); // deliberately NO proposal content / file contents / diff text / tokens / secrets
  }

  // ---------------------------------------------------------------------------------------------------------
  // Credential-guard override (ADR-0097). The flow owns every grant record (on the inert plan-less anchor Task);
  // the runtime only routes, records ApprovalManager decisions, and runs the single dispatch through the flow.
  // Logs carry ids, target index, hash and line only — never a path or any file content.
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Raise one CRITICAL override for an overridable refusal of the request in flight (ADR-0097 D3): the flow creates
   * the request via `requestForRisk` and anchors (or extends) the request's grant set; the reply names file and
   * line. When the set cannot be raised, the refusal stays terminal and a just-created request is closed.
   */
  protected async requestCredentialOverride(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    refusal: CredentialOverrideRefusal,
  ): Promise<TurnResult> {
    const flow = this.deps.credentialOverrideFlow;
    // The owner is the session's actor; fail closed when the session carries none (never a placeholder owner).
    const ownerActorId = session.actorId;
    const raised = flow && ownerActorId
      ? await flow.requestOverride(session, { request, outcome, ownerActorId, refusal }, this.deps.approvals)
      : null;
    if (!raised?.ok) {
      if (raised?.pendingApproval) {
        await this.closeCredentialOverrideApproval(raised.pendingApproval, 'system', `credential-override-${raised.reason}`);
      }
      // A set already holding grants of this request can no longer complete: never leave it GRANTED.
      await flow?.invalidate(session, 'inconsistent', 'system');
      this.deps.logger.warn('credential guard override not raised', {
        sessionId: session.id,
        reason: raised ? raised.reason : 'unbound',
        targetIndex: refusal.targetIndex,
      });
      return this.failComposed(
        message,
        session,
        this.deps.composer.composeCodeGenerationPreviewCredentialRefused(message.context, refusal.targetPath),
        outcome,
      );
    }
    this.deps.logger.warn('credential guard override requested', {
      sessionId: session.id,
      approvalId: raised.approval.id,
      targetIndex: refusal.targetIndex,
      contentSha256: refusal.contentSha256,
      line: refusal.line,
      grantCount: raised.anchor.grants.length,
    });
    const reply = this.deps.composer.composeCredentialOverridePrompt(message.context, refusal.targetPath, refusal.line);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id, executionOutcome: outcome };
  }

  /**
   * A turn while a credential-override set is live (ADR-0097 D3/D5): only the dedicated send phrase sends;
   * deny/cancel ends the whole set; anything else (including "승인") re-prompts with the remaining time. A send
   * re-checks the set's expiry synchronously right before `decide` (ADR-0095 §5), records the grant, then either
   * raises the next refused target's override or runs the single revalidated dispatch.
   */
  protected async handleCredentialOverrideTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    override: Extract<CredentialOverrideLookup, { state: 'awaiting-decision' | 'ready' }>,
  ): Promise<TurnResult> {
    const flow = this.deps.credentialOverrideFlow!; // a lookup exists only when the flow is wired
    const grant = override.state === 'awaiting-decision' ? override.grant : override.anchor.grants.at(-1);
    const path = grant?.path ?? '';
    const decision = interpretCredentialOverrideDecision(message.text);
    this.deps.logger.info('credential override decision interpreted', {
      sessionId: session.id,
      decision,
      state: override.state,
      ...(override.state === 'awaiting-decision' ? { approvalId: override.approval.id } : {}),
    });

    if (decision === 'reprompt') {
      const reply = this.deps.composer.composeCredentialOverrideReprompt(message.context, path, override.remainingMs);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }

    if (decision === 'deny') {
      // ADR-0113 D7: the shared deny path (record the rejection, invalidate the set) — the UI runs it too.
      return this.decisionTurn(
        session,
        await this.approvalDecisions.rejectCredentialOverride(this.chatDecision(message, session, actor), override),
      );
    }

    // send
    if (override.state === 'ready') return this.continueCredentialOverride(message, session, actor, override.anchor);
    const approval = override.approval;
    // ADR-0113 D7: the send's re-read, the whole-set expiry re-check (the set expires with its OLDEST override,
    // ADR-0097 D5; synchronous right before `decide`), the decision and the grant run in the shared decision service
    // under the same locks as the deny and the operations UI's reject — a request decided meanwhile is never approved.
    const sent = await this.approvalDecisions.approveCredentialOverride(this.chatDecision(message, session, actor), override);
    if (sent.kind === 'reply') return this.decisionTurn(session, sent.value);
    const { granted } = sent;
    if (!granted.ok) {
      if (granted.pendingApproval) {
        await this.closeCredentialOverrideApproval(granted.pendingApproval, 'system', `credential-override-${granted.reason}`);
      }
      this.deps.logger.warn('credential guard override grant not recorded', {
        sessionId: session.id,
        approvalId: approval.id,
        reason: granted.reason,
      });
      const reason: CredentialOverrideInvalidationReason =
        granted.reason === 'not-found' || granted.reason === 'not-pending' ? 'inconsistent' : granted.reason;
      return this.failComposed(message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, reason));
    }
    this.deps.logger.warn('credential guard override granted', {
      sessionId: session.id,
      approvalId: approval.id,
      targetIndex: override.grant.targetIndex,
      contentSha256: override.grant.contentSha256,
      line: override.grant.line,
    });
    return this.continueCredentialOverride(message, session, actor, granted.anchor);
  }

  /**
   * After a grant (or for a fully granted set found at turn start): if another target of the same request still
   * needs its own override, raise it on the same anchor; on a hard failure invalidate the set; otherwise consume
   * the whole set and run the preview ONCE with the consumed grants and the anchor's `newFileTargets`.
   */
  protected async continueCredentialOverride(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: CredentialOverrideAnchor,
  ): Promise<TurnResult> {
    const flow = this.deps.credentialOverrideFlow!;
    // ADR-0099: the anchor holds the request's explicit new-file targets; the re-run must keep them.
    const request: ExecutionRequest = anchor.newFileTargets.length
      ? { ...anchor.request, newFileTargets: [...anchor.newFileTargets] }
      : anchor.request;
    const coverage = await assessCredentialOverrideCoverage(
      this.deps.workspace,
      anchor.workspaceRef,
      request.targetFiles ?? [],
      anchor.newFileTargets,
      anchor.grants,
    );
    if (coverage.kind === 'needs-override') {
      return this.requestCredentialOverride(message, session, request, anchor.outcome, coverage.refusal);
    }
    if (coverage.kind === 'blocked') {
      // Something changed since the override was raised (at refusal time no target had a hard failure).
      await flow.invalidate(session, 'changed', 'system');
      this.deps.logger.warn('credential guard override blocked', {
        sessionId: session.id,
        reason: coverage.reason,
        targetIndex: coverage.targetIndex,
      });
      const targetPath = coverage.targetPath ?? '';
      const reply =
        coverage.reason === 'target-changed-since-override'
          ? this.deps.composer.composeCredentialOverrideContentChanged(message.context, targetPath)
          : coverage.reason === 'target-contains-credential'
          ? this.deps.composer.composeCredentialOverrideHardRefused(message.context, targetPath)
          : this.deps.composer.composeCredentialOverrideInvalidated(message.context, 'changed');
      return this.failComposed(message, session, reply, anchor.outcome);
    }

    // The binding is to the request's workspace: it must still be the active project's workspace.
    const project = session.activeProjectId ? await this.deps.projects.get(session.activeProjectId) : null;
    if (!project || project.id !== anchor.projectId || project.rootPath !== anchor.workspaceRef.rootPath) {
      await flow.invalidate(session, 'project-changed', 'system');
      return this.failComposed(
        message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, 'project-changed'),
      );
    }
    // OVR-3 contract: read, classify and grant-check every target's content BEFORE the consume, so the dispatch
    // below performs no awaited I/O between the flow's final validation and generate(). The content is prepared
    // under the grants about to be consumed and sent only if the flow consumes exactly those grants; a granted
    // target's content must still hash to its grant here, and the flow's own revalidation read (under its
    // serialization) must match it too. A failure here leaves the set GRANTED, so it is invalidated: nothing sent.
    const preparedGrants = toDispatchGrants(anchor);
    const prepared = await this.prepareCodeGeneration(request, anchor.outcome, preparedGrants);
    if (!prepared.ok) {
      await flow.invalidate(session, prepared.failure === 'missing-refs' ? 'inconsistent' : 'changed', 'system');
      return this.failCodeGenerationPreparation(message, session, request, anchor.outcome, prepared, preparedGrants);
    }
    const dispatched = await flow.consumeAndDispatch(
      session,
      {
        actorId: actor.id,
        workspaceRef: anchor.workspaceRef,
        projectId: session.activeProjectId,
        executionPlanId: anchor.executionPlanId,
        reader: this.deps.workspace,
      },
      (grants, authorization) =>
        this.generateCodeChangePreview(message, session, request, anchor.outcome, prepared.value, {
          grants,
          preparedGrants,
          authorization,
        }),
    );
    if (dispatched.ok) return dispatched.value;
    this.deps.logger.warn('credential guard override not dispatched', { sessionId: session.id, reason: dispatched.reason });
    if (dispatched.reason === 'already-used') {
      return this.failComposed(message, session, this.deps.composer.composeCredentialOverrideAlreadyUsed(message.context));
    }
    let reason: CredentialOverrideInvalidationReason;
    if (dispatched.reason === 'not-found' || dispatched.reason === 'not-granted' || dispatched.reason === 'consume-failed') {
      reason = 'inconsistent';
      await flow.invalidate(session, reason, 'system'); // never leave an undispatchable set GRANTED
    } else {
      reason = dispatched.reason;
    }
    return this.failComposed(message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, reason));
  }

  /**
   * A set the flow invalidated while reconstructing it at turn start (expired, project changed, superseded,
   * inconsistent, …): close its still-PENDING request and return the notice answered like an ADR-0093 expiry.
   */
  protected async closeInvalidatedCredentialOverride(
    message: InboundMessage,
    session: Session,
    override: Extract<CredentialOverrideLookup, { state: 'invalidated' }>,
  ): Promise<OutboundMessage> {
    if (override.pendingApproval) {
      const comment = override.reason === 'expired' ? 'expired' : `credential-override-${override.reason}`;
      await this.closeCredentialOverrideApproval(override.pendingApproval, 'system', comment);
    }
    this.deps.logger.info('credential guard override invalidated', { sessionId: session.id, reason: override.reason });
    return this.deps.composer.composeCredentialOverrideInvalidated(message.context, override.reason);
  }

  /** Close a still-PENDING override request as rejected (it is never left PENDING); an already-decided one is kept. */
  protected async closeCredentialOverrideApproval(approval: ApprovalRequest, decidedBy: string, comment: string): Promise<void> {
    await this.approvalDecisions.closeIfPending(approval.id, decidedBy, comment);
  }
}
