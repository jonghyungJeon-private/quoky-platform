import {
  ArtifactKind,
  ContinuationPromptError,
  PromptComposer,
  PromptRenderer,
  assertContinuationFacts,
  Capability,
  IntentType,
} from '@quoky/core';
import type {
  Artifact,
  Capability as CapabilityT,
  ContinuationProviderRouting,
  ContinuationReceiver,
  ContinuationReceiverInput,
  ContinuationReceiverOutcome,
  ContinuationRoutingAudit,
  ExecutionPlan,
  Id,
  Metadata,
  BoundLocalContinuitySelection,
  PreparedContainmentExecution,
  ProviderExecutionPlan,
} from '@quoky/core';

/**
 * R2 app/composition-layer receiver (§21). Implements the Core ContinuationReceiver port. Narrow
 * dependencies only: PromptComposer + PromptRenderer (prompt ownership), a ContinuationProviderRouting
 * seam (Stage2B orchestration), and a narrow Artifact persistence port. It does NOT inject
 * StorageProvider, TaskManager, ApprovalManager, or a concrete Provider adapter, and it NEVER
 * terminalizes the TaskRun (§30) — it only returns a bounded ContinuationReceiverOutcome.
 */

/** Narrow platform-owned Artifact persistence port (§27/§28). No Provider-supplied ownership trusted. */
export interface ContinuationArtifactSink {
  create(input: {
    kind: ArtifactKind;
    title: string;
    content?: string;
    mimeType?: string;
    taskId?: Id;
    taskRunId?: Id;
    metadata?: Metadata;
  }): Promise<Artifact>;
}

export interface ProviderBackedContinuationReceiverDependencies {
  readonly promptComposer: PromptComposer;
  readonly promptRenderer: PromptRenderer;
  readonly routing: ContinuationProviderRouting;
  readonly artifactManager: ContinuationArtifactSink;
  readonly localContinuityFor?: (executionId: Id) => Promise<Readonly<{
    selection: BoundLocalContinuitySelection;
    plan: ProviderExecutionPlan;
    preparedExecution: PreparedContainmentExecution;
  }>>;
}

const SUPPORTED_CAPABILITIES: readonly CapabilityT[] = Object.freeze([Capability.GENERAL_CHAT]);

function failed(routingAudit?: ContinuationRoutingAudit): ContinuationReceiverOutcome {
  return Object.freeze({
    disposition: 'FAILED',
    error: 'CONTINUATION_RECEIVER_FAILED',
    ...(routingAudit ? { routingAudit } : {}),
  }) as ContinuationReceiverOutcome;
}

function unresolved(routingAudit?: ContinuationRoutingAudit): ContinuationReceiverOutcome {
  return Object.freeze({
    disposition: 'UNRESOLVED',
    reason: 'EXECUTION_UNCERTAIN',
    ...(routingAudit ? { routingAudit } : {}),
  }) as ContinuationReceiverOutcome;
}

export class ProviderBackedContinuationReceiver implements ContinuationReceiver {
  readonly supportedCapabilities = SUPPORTED_CAPABILITIES;
  private readonly promptComposer: PromptComposer;
  private readonly promptRenderer: PromptRenderer;
  private readonly routing: ContinuationProviderRouting;
  private readonly artifactManager: ContinuationArtifactSink;
  private readonly localContinuityFor?: ProviderBackedContinuationReceiverDependencies['localContinuityFor'];

  constructor(dependencies: ProviderBackedContinuationReceiverDependencies) {
    this.promptComposer = dependencies.promptComposer;
    this.promptRenderer = dependencies.promptRenderer;
    this.routing = dependencies.routing;
    this.artifactManager = dependencies.artifactManager;
    this.localContinuityFor = dependencies.localContinuityFor;
  }

  async receive(input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> {
    const executionId = input.taskRun.id;

    // §22 receiver preflight. Known deterministic pre-dispatch failures return bounded FAILED — they
    // are NOT thrown, so 6K never converts them to UNRESOLVED (§24). Only positive pre-dispatch
    // evidence is caught here; post-dispatch uncertainty is decided by the routing service.
    let composition;
    try {
      const facts = input.boundTaskFacts;
      if (
        !SUPPORTED_CAPABILITIES.includes(input.taskRun.capability) ||
        input.taskRun.capability !== facts.capability ||
        facts.capability !== Capability.GENERAL_CHAT ||
        facts.intentType !== IntentType.CHAT
      ) {
        return failed();
      }
      const promptInput = {
        handoff: input.handoff,
        destinationAgentProfile: input.destinationAgentProfile,
        plan: input.plan as ExecutionPlan,
        boundTaskFacts: { capability: facts.capability, intentType: facts.intentType },
      };
      assertContinuationFacts(promptInput);
      composition = this.promptComposer.composeContinuation(promptInput);
    } catch (error) {
      // A ContinuationPromptError is positive, deterministic pre-dispatch evidence → bounded FAILED.
      if (error instanceof ContinuationPromptError) return failed();
      // Any other pre-composition escape is genuine uncertainty; re-throw so 6K maps it to UNRESOLVED.
      throw error;
    }

    const request = this.promptRenderer.render(composition.spec, {
      capability: Capability.GENERAL_CHAT,
    });

    // Preserve post-invocation uncertainty. Do NOT wrap this in a
    // catch that turns arbitrary post-dispatch exceptions into FAILED (§24).
    let localContinuity: Awaited<ReturnType<NonNullable<typeof this.localContinuityFor>>> | undefined;
    try {
      localContinuity = await this.localContinuityFor?.(executionId);
    } catch {
      // This seam only prepares authority and containment; no dispatch or effect has started.
      return failed();
    }
    const result = await this.routing.execute({
      facts: { capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT },
      request,
      validationFacts: { contextCorpus: composition.validationCorpus.entries.map((entry) => entry.content) },
      executionId,
      ...(localContinuity ? { localContinuity } : {}),
    });

    if (result.disposition === 'UNRESOLVED') return unresolved(result.audit);
    if (result.disposition === 'FAILED') return failed(result.audit);

    // ACCEPTED → persist exactly ONE platform-owned Artifact. Provider-supplied artifact/task/run ids
    // and URIs are ignored (§28); only the validated text is used. Artifact save failure → FAILED (§29).
    if (result.output === undefined || result.acceptedProviderId === undefined) return failed(result.audit);
    let artifact: Artifact;
    try {
      artifact = await this.artifactManager.create({
        kind: ArtifactKind.MARKDOWN_REPORT,
        title: 'Continuation response',
        content: result.output.text,
        mimeType: 'text/markdown',
        taskId: input.taskRun.taskId,
        taskRunId: input.taskRun.id,
      });
    } catch {
      // Accepted output but definite persistence failure → FAILED (no fabricated success, no retry).
      return failed(result.audit);
    }

    return Object.freeze({
      disposition: 'SUCCEEDED',
      artifactIds: Object.freeze([artifact.id]),
      acceptedProviderId: result.acceptedProviderId,
      routingAudit: result.audit,
    }) as ContinuationReceiverOutcome;
  }
}
