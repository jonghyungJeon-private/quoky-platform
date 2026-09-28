import {
  ContinuationProviderRoutingService,
  AgentProfileRegistry,
  Capability,
  IntentType,
  ExecutionStatus,
  RiskLevel,
  createWorkHandoff,
  agentProfileId,
  assertRenderedPromptBytes,
  PromptComposer,
  PromptRenderer,
  ProviderDispatchCommitCoordinator,
} from '@quoky/core';
import type { AgentProfile, ArtifactManager, BoundLocalContinuitySelection,
  BoundLocalContinuitySelectionIssuer, ContinuationReceiver, PreparedContainmentExecution,
  ProviderExecutionPlan, ProviderId } from '@quoky/core';
import {
  buildProductionProviderRoutingConfiguration,
  createProductionProviderRoutingConfiguration,
} from '../provider-routing/production-provider-routing-config';
import type {
  ProductionProviderRoutingConfiguration,
  ProductionProviderRoutingFactoryInput,
} from '../provider-routing/production-provider-routing-config';
import { ProviderBackedContinuationReceiver } from './provider-backed-continuation-receiver';

export const CONTINUATION_RECEIVER_MODE_ENV_NAME = 'QUOKY_CONTINUATION_RECEIVER_MODE' as const;

/**
 * §31 typed continuation activation mode. Kept SEPARATE from QUOKY_PROVIDER_ROUTING_MODE: routing
 * configuration availability is never continuation execution authority. Default: 'disabled'.
 */
export type ContinuationReceiverMode = 'disabled' | 'general-chat-v1';

export enum ContinuationReceiverActivationErrorCode {
  INVALID_MODE = 'CONTINUATION_RECEIVER_INVALID_MODE',
  CONTAINMENT_UNAVAILABLE = 'CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE',
  CONTAINMENT_UNVERIFIED = 'CONTINUATION_RECEIVER_CONTAINMENT_UNVERIFIED',
  PROFILE_PROMPT_INFEASIBLE = 'CONTINUATION_RECEIVER_PROFILE_PROMPT_INFEASIBLE',
  DEPENDENCY_MISSING = 'CONTINUATION_RECEIVER_DEPENDENCY_MISSING',
}

export class ContinuationReceiverActivationError extends Error {
  constructor(readonly code: ContinuationReceiverActivationErrorCode) {
    super(code);
    this.name = 'ContinuationReceiverActivationError';
  }
}

/** Exact-match, fail-closed parse mirroring parseProviderRoutingMode. Message === code on failure. */
export function parseContinuationReceiverMode(raw: string | undefined): ContinuationReceiverMode {
  if (raw === undefined || raw === 'disabled') return 'disabled';
  if (raw === 'general-chat-v1') return raw;
  throw new ContinuationReceiverActivationError(ContinuationReceiverActivationErrorCode.INVALID_MODE);
}

/**
 * §33 fake containment seam. R3 owns REAL containment/egress enforcement; it is NOT implemented yet.
 * Production general-chat-v1 mode therefore has no verifiable containment and MUST fail closed. Tests
 * may inject a fake verified containment to exercise the enabled composition (§34).
 */
export interface ContinuationContainmentVerification {
  readonly status: 'verified' | 'unavailable' | 'unverified';
}

export interface ContinuationContainment {
  verify(): ContinuationContainmentVerification;
}

export interface ProductionContinuationReceiverActivationInput {
  readonly mode: ContinuationReceiverMode;
  readonly ollama: ProductionProviderRoutingFactoryInput;
  /** Mandatory in general-chat-v1. Absent in production today → startup fail-closed (R3 not built). */
  readonly containment?: ContinuationContainment;
  readonly promptComposer?: PromptComposer;
  readonly promptRenderer?: PromptRenderer;
  readonly artifactManager?: ArtifactManager;
  /** Destination profile snapshot; required before enabled offline composition. */
  readonly destinationAgentProfiles?: readonly AgentProfile[];
  /** Required for every effect-capable continuation receiver. */
  readonly dispatchCommit?: Pick<ProviderDispatchCommitCoordinator, 'commit'>;
  /** TEST-only C2C composition; no production prepared capability issuer exists. */
  readonly localContinuity?: Readonly<{
    issuer: BoundLocalContinuitySelectionIssuer;
    providerId: ProviderId;
    prepare: (selection: BoundLocalContinuitySelection) => Readonly<{
      plan: ProviderExecutionPlan;
      preparedExecution: PreparedContainmentExecution;
    }>;
  }>;
  readonly createConfiguration?: (
    input: ProductionProviderRoutingFactoryInput,
  ) => ProductionProviderRoutingConfiguration;
}

function continuationRoutingServiceFrom(
  configuration: ProductionProviderRoutingConfiguration,
  dispatchCommit: Pick<ProviderDispatchCommitCoordinator, 'commit'>,
  localContinuityIssuer?: BoundLocalContinuitySelectionIssuer,
): ContinuationProviderRoutingService {
  return new ContinuationProviderRoutingService({
    providerRegistry: configuration.providerRegistry,
    policyEngine: configuration.policyEngine,
    bindings: configuration.executableBindings,
    validationProfiles: configuration.validationProfiles,
    configurationVersion: configuration.version,
    configurationDigest: configuration.configurationDigest,
    deadlinePolicy: configuration.deadlinePolicy,
    dispatchCommit,
    ...(localContinuityIssuer ? { localContinuityIssuer } : {}),
  });
}

/**
 * §32/§33 continuation receiver activation. disabled → undefined (absent binding, no composition). For
 * general-chat-v1 EVERY mandatory dependency must be present AND containment must verify; anything
 * missing/unverified fails closed. This is an isolated offline factory, not production AppModule wiring.
 * Production loadConfig rejects general-chat-v1 until R3 containment is delivered.
 */
export function createProductionContinuationReceiverActivation(
  input: ProductionContinuationReceiverActivationInput,
): ContinuationReceiver | undefined {
  if (input.mode === 'disabled') return undefined;

  if (input.containment === undefined) {
    throw new ContinuationReceiverActivationError(
      ContinuationReceiverActivationErrorCode.CONTAINMENT_UNAVAILABLE,
    );
  }
  const verification = input.containment.verify();
  if (verification.status === 'unavailable') {
    throw new ContinuationReceiverActivationError(
      ContinuationReceiverActivationErrorCode.CONTAINMENT_UNAVAILABLE,
    );
  }
  if (verification.status === 'unverified') {
    throw new ContinuationReceiverActivationError(
      ContinuationReceiverActivationErrorCode.CONTAINMENT_UNVERIFIED,
    );
  }

  const promptComposer = input.promptComposer ?? new PromptComposer();
  const promptRenderer = input.promptRenderer ?? new PromptRenderer();
  const artifactManager = input.artifactManager;
  if (artifactManager === undefined || input.destinationAgentProfiles === undefined
    || input.dispatchCommit === undefined) {
    throw new ContinuationReceiverActivationError(
      ContinuationReceiverActivationErrorCode.DEPENDENCY_MISSING,
    );
  }

  for (const profile of new AgentProfileRegistry(input.destinationAgentProfiles).list()) {
    try {
      minimalContinuationPromptBytes(profile, promptComposer, promptRenderer);
    } catch {
      throw new ContinuationReceiverActivationError(
        ContinuationReceiverActivationErrorCode.PROFILE_PROMPT_INFEASIBLE,
      );
    }
  }

  const configuration = (input.createConfiguration ?? createProductionProviderRoutingConfiguration)(
    input.ollama,
  );
  const routing = continuationRoutingServiceFrom(configuration, input.dispatchCommit, input.localContinuity?.issuer);
  return new ProviderBackedContinuationReceiver({
    promptComposer,
    promptRenderer,
    routing,
    artifactManager,
    ...(input.localContinuity ? { localContinuityFor: async (executionId: string) => {
      const selection = await input.localContinuity!.issuer.issue(executionId, input.localContinuity!.providerId);
      return Object.freeze({ selection, ...input.localContinuity!.prepare(selection) });
    } } : {}),
  });
}

/** Re-exported for tests that build a configuration directly. */
export { buildProductionProviderRoutingConfiguration, continuationRoutingServiceFrom };

/** Pure feasibility witness: shortest nonempty objective/goal, empty summary, no steps or references.
 * Uses real authoring/rendering and never executes routing, a Provider, or persistence.
 */
export function minimalContinuationPromptBytes(
  profile: AgentProfile,
  composer = new PromptComposer(),
  renderer = new PromptRenderer(),
): number {
  const createdAt = '1970-01-01T00:00:00.000Z';
  const { spec } = composer.composeContinuation({
    destinationAgentProfile: profile,
    boundTaskFacts: { capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT },
    handoff: createWorkHandoff({
      id: 'h', workItemId: 'w', fromAgentProfileId: agentProfileId(profile.id === 'source' ? 'other' : 'source'),
      toAgentProfileId: profile.id, objective: 'x', resourceRefs: [], artifactIds: [],
      executionReceiptIds: [], createdAt,
    }),
    plan: {
      id: 'p', goal: 'x', summary: '', steps: [], requiredCapabilities: [Capability.GENERAL_CHAT],
      requiredResources: [], estimatedChanges: { fileCount: 0, scope: 'none' },
      approvalRequired: false, overallRisk: RiskLevel.LOW, expectedArtifacts: [],
      status: ExecutionStatus.PENDING, createdAt,
    },
  });
  const request = renderer.render(spec, { capability: Capability.GENERAL_CHAT });
  assertRenderedPromptBytes(request.prompt);
  return Buffer.byteLength(request.prompt, 'utf8');
}
