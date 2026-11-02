import { describeAiFailure } from '../ai-failure';
import { type CodeChainStatusDomain, noticeLanguage, renderInternalActionNotDone } from '../chat-policy/internal-action-vocabulary';
import {
  IMAGE_UNDERSTANDING_INTENT_KIND,
  composeImageUnderstandingPrompt,
  imageInputsOf,
  imageProviderAllowed,
  imageUnderstandingPolicyFromResolution,
  renderImageUnderstandingUnavailable,
  textAttachmentsOf,
  LOCAL_ONLY_IMAGE_UNDERSTANDING_POLICY,
  type ImageUnderstandingPolicy,
} from '../image-understanding';
import { withAttachedTextFiles } from '../attachment-context';
import { NoProviderAvailableError } from '../../errors';
import { interpretStrayDecisionUtterance } from '../approval-decision';
import { type MutationSafety, safeRequestId, toSafeError } from '../safe-error';
import { Capability, IntentType, TaskStatus } from '../../domain';
import type { Actor, InboundImageAttachment, InboundMessage, Intent, OutboundMessage, Session, TurnWorkFacts, WorkspaceRef } from '../../domain';
import { type ProviderSelectionContext, type AiProvider, type AiRequest } from '../../ports';
import { now } from '../../util/clock';
import { extractMentionedPathTokens, normalizeRelativePath } from '../target-scope';
import { collectCodeChangeTargets, extractSafeTargetCandidates } from '../code-work/code-change-set';
import { runUsageRecord } from '../provider-usage-record';
import type { CodeChangeTargetCollection } from '../code-work/code-change-set';
import type { ExecutionOutcomeStatus } from '../execution-orchestrator';
import { ConversationRuntimeGitPrMergeLayer } from './git-pr-merge-layer';
import { CANCEL_WORDS, MERGED_CHAIN_STATUSES, POST_PUSH_CHAIN_STATUSES } from './intent-words';
import { asksForWholeRequestAgain, isExplicitNewFileRequest, needsWorkspace } from './turn-intents';
import type { ApplyPreviewAnchor, PendingScopeClarification, TurnResult } from './types';

export abstract class ConversationRuntimeExecutionImageLayer extends ConversationRuntimeGitPrMergeLayer {
  /** (C) Resolve the workspace (if the capability needs it), run the execution, and frame the reply. */
  protected async handleExecutionIntent(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
  ): Promise<TurnResult> {
    const ws = await this.resolveExecutionWorkspace(message, session, intent.capability);
    if ('status' in ws) return ws;
    const workspaceRef = ws.workspaceRef;

    // ADR-0036: a code-change request needs a validated target before it may reach Planning/Approval.
    let targetFiles: string[] | undefined;
    // F3-A (Sprint 4c-Follow-up-3): the positive origin signal for the new-file add-diff preview guard.
    // Set ONLY when A2's explicit new-file flow fires below — never for an ordinary existing-file target.
    let newFileTargets: string[] | undefined;
    // F4-A (Sprint 4c-Follow-up-4): the FULL inbound request is the authoritative code-generation
    // instruction (never the ≤200-char display summary). Set ONLY for CODE_IMPLEMENTATION so no other
    // capability's behavior changes. Per the CA input-fidelity amendment, every accepted inbound request
    // is preserved COMPLETELY — no application-level length cap, no silent truncation. The instruction is
    // bounded only by what the inbound chat transport accepts; a small app cap is explicitly NOT
    // imposed here (long-preview delivery is handled losslessly downstream — Sprint 4c-Follow-up-5).
    let authoritativeInstruction: string | undefined;
    if (intent.capability === Capability.CODE_IMPLEMENTATION) {
      authoritativeInstruction = message.text;
      // ADR-0099 D1: EVERY safe named path is a target (≤ MAX_CHANGE_SET_FILES), never only the first hit.
      // An existing path is an update target; a missing one is a new-file target only with the negation-aware
      // ADR-0062 create wording (A2, now for each missing path — F3-A marks it as an explicit new-file origin
      // so runCodeGenerationPreview may accept its `add` diff, still re-checked absent at diff time); otherwise
      // the reply names the missing paths and asks again. This changes ROUTING only: preview stays
      // non-mutating and the apply/commit/push/PR approval gates are untouched. A typed absolute / home /
      // traversal / dot-leading path is never a target (never rewritten into an in-project path) but does not
      // refuse a request that also names a safe target — an API route or import specifier in the prose is
      // instruction content. Fenced code is pasted content, never a target.
      const { candidates, unsafe } = extractSafeTargetCandidates(message.text);
      const collected = await this.collectCodeChangeTargets(
        workspaceRef!, candidates, isExplicitNewFileRequest(message.text),
      );
      if (collected.kind === 'targets') {
        targetFiles = collected.targets;
        if (collected.newFileTargets.length) newFileTargets = collected.newFileTargets;
      } else if (collected.kind === 'too-many') {
        return this.respondComposed(
          message, session, this.deps.composer.composeTooManyTargets(message.context, collected.count, collected.max),
        );
      }
      if (!targetFiles) {
        // ADR-0099 D1: a "some named paths are missing" reply asks for the WHOLE request again (with create
        // wording for a new file), so it is NOT anchored — the resend must route as a fresh request, where the
        // create wording is honored and its own text becomes the instruction. Anchoring it would send the resend
        // to the existing-files-only recovery with the stale instruction and dead-end on the same reply.
        if (asksForWholeRequestAgain(collected)) {
          return this.respondComposed(message, session, this.composeTargetScopeReply(message, collected, unsafe));
        }
        // ADR-0037: anchor so the user's very next reply (even a bare path) can recover this
        // request. Reached only for a fresh CODE_IMPLEMENTATION request with an active project and
        // an opened workspace (both already required to reach this line) and no validated target.
        await this.deps.credentialOverrideFlow?.clear(session); // ADR-0097 D5: never orphan a live set
        await this.deps.scopeClarificationFlow.anchor(session, {
          kind: 'code-scope-clarification',
          summary: intent.summary,
          // F4-B/RC4: preserve the ORIGINAL full request so a next-turn bare-path reply recovers the
          // complete instruction, never the path-only text or the ≤200-char summary.
          ...(authoritativeInstruction ? { authoritativeInstruction } : {}),
          ...(typeof intent.raw?.kind === 'string' ? { rawKind: intent.raw.kind } : {}),
          ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
          createdAt: now(),
        });
        return this.respondComposed(message, session, this.composeTargetScopeReply(message, collected, unsafe));
      }
    }

    return this.runResolvedExecution(
      message, session, actor, intent, workspaceRef, targetFiles, newFileTargets, authoritativeInstruction,
    );
  }

  /** Resolve the active project's workspace for a needsWorkspace capability, or an early-return reply. */
  protected async resolveExecutionWorkspace(
    message: InboundMessage,
    session: Session,
    capability: Capability,
  ): Promise<{ workspaceRef?: WorkspaceRef } | TurnResult> {
    if (!needsWorkspace(capability)) return {};
    if (!session.activeProjectId) {
      return this.respondComposed(message, session, this.deps.composer.composeNeedsProject(message.context));
    }
    const project = await this.deps.projects.get(session.activeProjectId);
    if (!project) {
      return this.respondComposed(message, session, this.deps.composer.composeNeedsProject(message.context));
    }
    try {
      const workspaceRef = await this.deps.workspace.open({ id: project.id, rootPath: project.rootPath });
      return { workspaceRef };
    } catch {
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceUnavailable(message.context));
    }
  }

  /**
   * Resolve → run → frame the halt/complete/fail reply. Shared tail for a ready ExecutionRequest.
   *
   * MUTATION-CERTAINTY BOUNDARY (Sprint 4c-Follow-up-7; narrowed per CA re-review). This is a SHARED
   * execution tail — it runs `orchestrator.run` for EVERY execution capability, including `TEST_EXECUTION`
   * and command flows that CAN produce side effects (generated files, snapshots, caches, artifacts,
   * side-effecting scripts) before an error escapes. So the method as a whole is NOT read-only, and the
   * mutation-safety invariant covers ALL mutations, not only `WorkspaceWrite.apply`. On a thrown error the
   * sanitized FAILED reply's mutation-certainty is therefore chosen by capability:
   *   - `CODE_IMPLEMENTATION` — the approval-gated preview flow. The orchestrator computes a read-only diff
   *     and stops at AWAITING_APPROVAL BEFORE any apply; the actual WorkspaceWrite apply / git ops live
   *     exclusively in the separate approval-decision turns (`handleApplyApprovalTurn` et al.). No
   *     mutation-capable port is reachable on this first-turn/recovered preview path, so a failure is
   *     provably pre-mutation → `CONFIRMED_NOT_APPLIED`.
   *   - EVERY OTHER capability (`TEST_EXECUTION`, command execution, any other shared execution capability)
   *     — a side effect may already have happened, so the verdict stays conservative → `MAY_HAVE_APPLIED`.
   * Never rethrows (so this specific verdict wins over the generic backstop) and never leaks raw/stack. The
   * generic `handle()` and `QuokyCore` backstops stay conservative (`MAY_HAVE_APPLIED`) for everything else.
   */
  protected async runResolvedExecution(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    workspaceRef: WorkspaceRef | undefined,
    targetFiles: string[] | undefined,
    newFileTargets?: string[],
    authoritativeInstruction?: string,
  ): Promise<TurnResult> {
    try {
      return await this.runResolvedExecutionInner(
        message,
        session,
        actor,
        intent,
        workspaceRef,
        targetFiles,
        newFileTargets,
        authoritativeInstruction,
      );
    } catch (err) {
      const safe = toSafeError(err);
      this.deps.logger.error('execution turn failed', {
        errorName: err instanceof Error ? err.name : typeof err,
        code: safe.code,
        capability: intent.capability,
        messageId: message.id,
        // internal-only sink — never sent to the user
        stack: err instanceof Error ? err.stack : undefined,
      });
      // CONFIRMED_NOT_APPLIED ONLY for the approval-gated CODE_IMPLEMENTATION preview flow (provably
      // pre-mutation on this shared tail). TEST_EXECUTION / command execution / any other shared capability
      // may already have triggered a side effect, so they MUST stay conservative (CA re-review).
      const mutationSafety: MutationSafety =
        intent.capability === Capability.CODE_IMPLEMENTATION ? 'CONFIRMED_NOT_APPLIED' : 'MAY_HAVE_APPLIED';
      const reply = this.deps.composer.composeSanitizedError(message.context, safe, {
        requestId: safeRequestId(message.id),
        mutationSafety,
      });
      return { status: 'FAILED', reply, sessionId: session.id };
    }
  }

  protected async runResolvedExecutionInner(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    workspaceRef: WorkspaceRef | undefined,
    targetFiles: string[] | undefined,
    newFileTargets?: string[],
    authoritativeInstruction?: string,
  ): Promise<TurnResult> {
    const request = this.deps.intentResolver.resolve(intent, {
      requestedBy: actor.id,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
      ...(workspaceRef ? { workspaceRef } : {}),
      ...(targetFiles ? { targetFiles } : {}),
      ...(newFileTargets ? { newFileTargets } : {}),
      // F4-A (Sprint 4c-Follow-up-4): the full authoritative instruction → ExecutionRequest.instruction;
      // goal stays the bounded display summary.
      ...(authoritativeInstruction ? { authoritativeInstruction } : {}),
    });
    if (!request) {
      // Defensive: isExecution() gated this path, so resolve should not return null.
      return this.failComposed(message, session, this.deps.composer.composeCommandUnavailable(message.context));
    }

    // F4-C (Sprint 4c-Follow-up-4): safe, length-only observability for instruction fidelity — proves the
    // display summary is bounded while the authoritative instruction carries the full request. NEVER logs
    // raw instruction/request/file content (LogFields is primitive-only; only lengths/booleans passed).
    if (intent.capability === Capability.CODE_IMPLEMENTATION) {
      this.deps.logger.info('code-change instruction fidelity', {
        stage: 'intent-resolution',
        capability: 'CODE_IMPLEMENTATION',
        displaySummaryLength: intent.summary.length,
        authoritativeInstructionLength: request.instruction.length,
        instructionTruncatedForDisplay: request.instruction.length > intent.summary.length,
      });
    }

    const outcome = await this.deps.orchestrator.run(request);
    if (outcome.status === ('AWAITING_APPROVAL' as ExecutionOutcomeStatus)) {
      // ADR-0097 D5 (OVR-3 contract): a newer request never orphans a live override set (`superseded`).
      await this.deps.credentialOverrideFlow?.clear(session);
      await this.deps.approvalFlow.anchor(session, request, outcome); // enable next-turn resume
      // ADR-0035: a code-change halt gets a more specific prompt than the generic approval text —
      // it names this as a code-change request and states that no file is modified yet.
      if (intent.capability === Capability.CODE_IMPLEMENTATION) {
        // New-file targets have no current content to send; only existing target files are disclosed.
        const sentFiles = (request.targetFiles ?? []).filter((f) => !(request.newFileTargets ?? []).includes(f));
        const reply = this.deps.composer.composeCodeChangeApprovalRequired(
          message.context, sentFiles, request.newFileTargets ?? [],
        );
        await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
        return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id, executionOutcome: outcome };
      }
      return this.replyForOutcome(message.context, session, outcome);
    }
    if (intent.capability === Capability.TEST_EXECUTION) {
      return this.frameTestResult(message, session, outcome);
    }
    return this.replyForOutcome(message.context, session, outcome);
  }

  /**
   * (A2) Recover a code-change request from a pending scope clarification (ADR-0037). Consumes the
   * anchor unconditionally (next-turn-only) before evaluating the reply. The recovered request's
   * goal/instruction always comes from `pending.summary` — the ORIGINAL first message — never from
   * this follow-up message's text.
   */
  protected async handleScopeClarificationTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    pending: PendingScopeClarification,
  ): Promise<TurnResult> {
    await this.deps.scopeClarificationFlow.clear(session); // next-turn-only: consumed either way

    if (CANCEL_WORDS.some((w) => message.text.trim() === w || message.text.includes(w))) {
      const reply = this.deps.composer.composeScopeClarificationCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'CANCELLED', reply, sessionId: session.id };
    }
    // QA-V2-004: a bare decision word ("승인", "거절", "ok") right after a rejected target is not a file path and
    // there is no approval to decide — the deterministic QA-018 "nothing to approve" reply, never the "which file?"
    // clarification copy. The clarification was consumed above.
    if (interpretStrayDecisionUtterance(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeNoPendingDecision(message.context));
    }

    const ws = await this.resolveExecutionWorkspace(message, session, Capability.CODE_IMPLEMENTATION);
    if ('status' in ws) return ws; // no active project / workspace unavailable — same replies as fresh

    const recovered: Intent = {
      type: IntentType.IMPLEMENT_CODE,
      capability: Capability.CODE_IMPLEMENTATION,
      confidence: 1,
      requiresWork: true,
      summary: pending.summary,
      ...(pending.rawKind ? { raw: { kind: pending.rawKind } } : {}),
    };

    // ADR-0099 D1: the same collector as a fresh request. Recovery only ever routes EXISTING files (never a
    // new-file origin), so a missing path here is named and asked again; an unsafe typed path is never a target
    // and is refused when no safe target is left.
    const { candidates, unsafe } = extractSafeTargetCandidates(message.text);
    const collected = await this.collectCodeChangeTargets(ws.workspaceRef!, candidates, false);
    if (collected.kind === 'targets') {
      // F4-B/RC4: recover with the ORIGINAL full instruction from the anchor — never `message.text`
      // (the bare-path follow-up) and never the ≤200-char summary.
      return this.runResolvedExecution(
        message, session, actor, recovered, ws.workspaceRef, collected.targets, undefined, pending.authoritativeInstruction,
      );
    }
    if (collected.kind === 'too-many') {
      return this.respondComposed(
        message, session, this.deps.composer.composeTooManyTargets(message.context, collected.count, collected.max),
      );
    }

    const reply = this.composeTargetScopeReply(message, collected, unsafe);
    return this.respondComposed(message, session, reply); // no re-anchor (next-turn-only)
  }

  /**
   * ADR-0099 D1 target collection over the read-only workspace listing. Never assume list()'s glob is
   * exact-match — a hit counts only when it normalizes to the candidate, and THAT hit (never the raw
   * candidate) becomes the target. At most MAX_CHANGE_SET_FILES lookups; more candidates are refused unlooked.
   */
  protected collectCodeChangeTargets(
    workspaceRef: WorkspaceRef,
    candidates: readonly string[],
    allowNewFiles: boolean,
  ): Promise<CodeChangeTargetCollection> {
    return collectCodeChangeTargets({
      candidates,
      allowNewFiles,
      resolveExisting: async (candidate) => {
        const hits = await this.deps.workspace.list(workspaceRef, candidate);
        return hits.find((hit) => normalizeRelativePath(hit) === normalizeRelativePath(candidate)) ?? null;
      },
    });
  }

  /**
   * The "which file?" reply for a code-change request with no usable target set (ADR-0036/0037; QA-016;
   * ADR-0099 D1). Some named paths resolved but others are missing, or several are missing → name every
   * missing path and ask again (never a silent drop). Otherwise, when the user DID type a path that could not
   * be used (missing, outside the project, absolute, traversal), say so and echo the path as typed — never
   * whether an out-of-root file exists; with no safe path left, a typed unsafe path (`unsafe`, already dropped
   * as a target) is the one echoed. With no path typed at all, keep the original clarification copy.
   */
  protected composeTargetScopeReply(
    message: InboundMessage,
    collected: CodeChangeTargetCollection,
    unsafe: readonly string[],
  ): OutboundMessage {
    // A missing safe path is the one the owner meant (echoed from the collection itself, so a bare root-level
    // filename such as `test.js` — never a slash-bearing mention — is named too: QA-V2-CL-01); only with no safe
    // path at all is the unsafe one echoed.
    // QA-V2-CL-02: a secret-looking file NAME is refused by name (ADR-0099 D6) — never the "not found" copy, since the
    // workspace never lists it. Name-only, so nothing is revealed about whether the file exists.
    if (collected.kind === 'secret-named') {
      return this.deps.composer.composeTargetSecretNamed(message.context, collected.paths);
    }
    const firstMissing = collected.kind === 'missing' ? collected.missing[0] : undefined;
    if (asksForWholeRequestAgain(collected)) {
      return this.deps.composer.composeTargetsMissing(message.context, collected.missing);
    }
    const mentioned = extractMentionedPathTokens(message.text);
    const typed = collected.kind === 'none'
      ? (unsafe[0] ?? mentioned[0])
      : (firstMissing ?? mentioned.find((token) => !unsafe.includes(token)) ?? mentioned[0]);
    return typed
      ? this.deps.composer.composeTargetPathRejected(message.context, typed)
      : this.deps.composer.composeTargetScopeClarification(message.context);
  }

  /**
   * ADR-0111 D3–D5 (MM-2) and amendment A2/A3: one image turn. The provider is selected by capability
   * (`IMAGE_UNDERSTANDING`) and its declared `executionLocality` must be in the composition-time image policy (data,
   * never its id) — `LOCAL` only by default, so a REMOTE selection is treated as no provider and receives nothing; a
   * REMOTE provider is allowed only when the owner selected a cloud image provider. With no ready allowed provider the
   * reply is the truthful deterministic notice and no Task runs. The request carries the bounded prompt (caption and text attachments as untrusted, JSON-quoted
   * readout) and the adapter's opaque temp-file references; the provider call is awaited inside the turn, so each
   * reference stays valid until it settles and the adapter deletes it afterwards. Image references are never
   * recorded in memory, Task/TaskRun metadata or logs (counts only).
   */
  protected async handleImageUnderstandingTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    images: readonly InboundImageAttachment[],
  ): Promise<TurnResult> {
    const capability = Capability.IMAGE_UNDERSTANDING;
    // Resolved before selection, per turn: an owner who switched away from a cloud image provider stops egress now.
    const selection = { sessionId: session.id, actorId: actor.id };
    const imagePolicy = await this.imagePolicyFor(selection);
    let provider: AiProvider;
    try {
      provider = await this.deps.router.select(capability, selection);
    } catch (err) {
      if (!(err instanceof NoProviderAvailableError)) throw err;
      return this.respondImageUnderstandingUnavailable(message, session, images.length, 'no-ready-provider', imagePolicy);
    }
    if (!imageProviderAllowed(provider, imagePolicy)) {
      return this.respondImageUnderstandingUnavailable(message, session, images.length, 'locality-not-allowed', imagePolicy);
    }

    const intent: Intent = {
      type: IntentType.ANALYZE_DOCUMENT,
      capability,
      confidence: 1,
      requiresWork: true,
      summary: 'Image understanding',
      raw: { kind: IMAGE_UNDERSTANDING_INTENT_KIND, imageCount: images.length },
    };
    let task = await this.deps.tasks.createTask(intent, message.context, {
      requestText: message.text,
      actorId: actor.id,
      sessionId: session.id,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
    });
    task = await this.deps.tasks.transition(task, TaskStatus.PLANNING);
    task = await this.deps.tasks.transition(task, TaskStatus.RUNNING);
    const run = await this.deps.tasks.startRun(task, capability);
    const providerId = provider.id;
    const workFacts: TurnWorkFacts = {
      intentType: intent.type,
      capability,
      taskId: task.id,
      runId: run.id,
      providerId,
    };
    try {
      const request: AiRequest = {
        capability,
        prompt: composeImageUnderstandingPrompt({
          caption: message.text,
          images,
          textAttachments: textAttachmentsOf(message),
        }),
        images: imageInputsOf(images),
      };
      await this.deps.dispatchCommit.commit(run.id, run.id);
      // Dispatch-time re-check (ADR-0111 amendment, runtime switching): the selection may have changed during the awaits
      // above (a concurrent `이미지 모델 변경: off`, an operations-UI change). Re-resolve the effective image selection and
      // its locality policy now; no I/O runs between this check and `execute`, so the provider that receives the image
      // is one the CURRENT selection allows. Otherwise nothing is sent and the reply is the truthful notice.
      const current = await this.imageDispatchStillAllowed(capability, selection, provider);
      // Last, synchronously, with nothing awaited before `execute`: the LIVE selection must still make this provider
      // eligible. A switch that landed while the re-selection above awaited readiness (`ollama` → `off`) is caught here.
      if (!current.allowed || this.deps.router.isStillEligible?.(capability, selection, provider) === false) {
        await this.deps.tasks.failRun(run, 'image selection changed before dispatch; nothing was sent', { providerId });
        await this.deps.tasks.transition(task, TaskStatus.FAILED);
        return this.respondImageUnderstandingUnavailable(message, session, images.length, 'selection-changed', current.policy);
      }
      const executed = await provider.execute(request);
      // ADR-0104 D1: the provider-neutral internal-action claim guard also covers an image reply.
      // ADR-0111 D3 + amendment A3: the attachment credential check runs FIRST, on the original reply and every
      // artifact, on EVERY image turn (the image itself is attachment content, so text the provider read off it — a
      // password in a screenshot — is withheld like a model-made match on a text-file turn).
      const withheld = this.withheldAttachmentReply(
        withAttachedTextFiles({ taskId: task.id, conversationTranscript: [], backgroundResources: [] }, message),
        message,
        executed.text,
        executed.artifacts ?? [],
        task.id,
        { imageTurn: true },
      );
      const guard = withheld ? null : this.guardChatReply(capability, executed.text, message.text, task.id);
      const result = withheld ? { ...executed, ...withheld } : { ...executed, text: guard?.text ?? executed.text };
      const artifactIds = await this.deps.artifacts.persistAll(task.id, run.id, result.artifacts ?? []);
      // ADR-0115 D8 (PRV-3): the image-understanding run records its `Usage` the same way.
      const usage = runUsageRecord(executed.usage);
      await this.deps.tasks.completeRun(run, {
        artifactIds,
        providerId,
        metadata: { ...(result.audit ?? {}), imageCount: images.length },
        ...(usage ? { usage } : {}),
      });
      await this.deps.memory.recordAssistant(result.text, message.context, task.sessionId ?? session.id);
      await this.deps.tasks.transition(task, TaskStatus.COMPLETED);
      this.deps.logger.info('image turn answered', { taskId: task.id, imageCount: images.length });
      const composed = this.deps.composer.compose(message.context, result, result.artifacts ?? []);
      const reply = this.asModelReply(composed, executed.text, { withheld: withheld !== null, guarded: guard?.guarded === true });
      return this.responded(session, reply, workFacts);
    } catch (err) {
      const failure = describeAiFailure(err);
      await this.deps.tasks.failRun(run, failure.errorSummary, { providerId });
      await this.deps.tasks.transition(task, TaskStatus.FAILED);
      this.deps.logger.error('image turn failed', { taskId: task.id, runId: run.id, kind: failure.kind });
      const reply = this.deps.composer.composeError(message.context, failure.userMessage);
      return { status: 'FAILED', reply, sessionId: session.id, workFacts };
    }
  }

  /** ADR-0111 D4: the truthful "image analysis unavailable" reply; no provider runs and nothing is sent anywhere. */
  protected async respondImageUnderstandingUnavailable(
    message: InboundMessage,
    session: Session,
    imageCount: number,
    reason: 'no-ready-provider' | 'locality-not-allowed' | 'selection-changed',
    imagePolicy: ImageUnderstandingPolicy,
  ): Promise<TurnResult> {
    // Content-free: a fixed reason and a count, never a file name, reference or caption.
    this.deps.logger.info('image turn answered without a provider', { reason, imageCount });
    const text = renderImageUnderstandingUnavailable(noticeLanguage(undefined, message.text), imagePolicy);
    return this.respondComposed(message, session, { context: message.context, text });
  }

  /**
   * Whether the already selected image provider may still receive the image: the router, asked again with the same
   * context, still selects the same provider (compared by its opaque key, never a literal) and the freshly resolved
   * locality policy still allows its declared locality. Any doubt (no provider now, a resolver failure) is "no".
   */
  protected async imageDispatchStillAllowed(
    capability: Capability,
    selection: ProviderSelectionContext,
    provider: AiProvider,
  ): Promise<{ readonly allowed: boolean; readonly policy: ImageUnderstandingPolicy }> {
    let again: AiProvider;
    try {
      again = await this.deps.router.select(capability, selection);
    } catch {
      return { allowed: false, policy: await this.imagePolicyFor(selection) };
    }
    const policy = await this.imagePolicyFor(selection);
    return { allowed: again.id === provider.id && imageProviderAllowed(provider, policy), policy };
  }

  /** The image egress policy for this turn: the composition-time one, or the resolver's answer (fail closed). */
  protected async imagePolicyFor(selection: ProviderSelectionContext): Promise<ImageUnderstandingPolicy> {
    const policy = this.imagePolicy;
    if (typeof policy !== 'function') return policy;
    try {
      return imageUnderstandingPolicyFromResolution(await policy(selection));
    } catch {
      this.deps.logger.warn('image policy resolution failed; local only');
      return LOCAL_ONLY_IMAGE_UNDERSTANDING_POLICY;
    }
  }

  /**
   * ADR-0104 D3 (DET-1): answer a code-chain status question / completion statement from the apply-preview anchor.
   * A state the anchor proves reuses that state's existing deterministic reply (already committed / pushed / PR
   * created / merged / branch cleaned, or the already-approved replies); otherwise the fixed not-done reply, which
   * never affirms the User's statement. Read-only: no git, hosting or provider call, no anchor change.
   */
  protected async handleInternalActionStatusTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor | null | undefined,
    domain: CodeChainStatusDomain,
  ): Promise<TurnResult> {
    const status = anchor?.status;
    if (anchor && status) {
      if (domain === 'commit') {
        if (status === 'COMMIT_APPROVED') return this.handleCommitAlreadyApprovedTurn(message, session);
        if (status === 'GIT_COMMITTED' || status === 'PUSH_APPROVED' || status === 'GIT_PUSHED' || POST_PUSH_CHAIN_STATUSES.has(status)) {
          return this.handleCommitAlreadyCommittedTurn(message, session, {
            ...anchor,
            commitHash: anchor.commitHash ?? anchor.pushedCommitHash,
          });
        }
      }
      if (domain === 'push') {
        if (status === 'PUSH_APPROVED') return this.handlePushAlreadyApprovedTurn(message, session);
        if (status === 'GIT_PUSHED' || POST_PUSH_CHAIN_STATUSES.has(status)) {
          return this.handlePushAlreadyPushedTurn(message, session, anchor);
        }
      }
      if (domain === 'pr') {
        if (status === 'PR_APPROVED') {
          return this.respondComposed(message, session, this.deps.composer.composePrAlreadyApproved(message.context));
        }
        if (POST_PUSH_CHAIN_STATUSES.has(status) && anchor.pullRequestNumber) {
          return this.handlePrAlreadyCreatedTurn(message, session, anchor);
        }
      }
      if (domain === 'merge') {
        if (status === 'MERGE_APPROVED') return this.handleMergeAlreadyApprovedTurn(message, session);
        // A merged state never gets the not-done reply (the existing already-merged reply has its own fallback).
        if (MERGED_CHAIN_STATUSES.has(status)) return this.handleMergeAlreadyMergedTurn(message, session, anchor);
      }
      if (domain === 'branch') {
        if (status === 'REMOTE_BRANCH_CLEANED') return this.handleRemoteBranchAlreadyCleanedTurn(message, session, anchor);
        if (status === 'BRANCH_CLEANED' || status === 'REMOTE_BRANCH_CLEANUP_APPROVED') {
          return this.handleBranchAlreadyCleanedTurn(message, session, anchor);
        }
      }
    }
    const text = renderInternalActionNotDone(domain, noticeLanguage(undefined, message.text));
    return this.respondComposed(message, session, { context: message.context, text });
  }
}
