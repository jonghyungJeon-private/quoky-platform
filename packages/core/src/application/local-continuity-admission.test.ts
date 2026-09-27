import { describe, expect, it } from 'vitest';
import { Capability, IntentType } from '../domain';
import {
  AuthorityRequirement,
  AvailabilityClass,
  ConcurrencyClass,
  ContextCapacity,
  CostTier,
  ExecutionLocality,
  LatencyClass,
  LatencyTier,
  OutputSizeClass,
  ProviderDescriptor,
  RankingDimension,
  ReliabilityTier,
  Requirement,
  RoutingClass,
  RoutingContext,
  RoutingPolicy,
  RoutingRequestType,
  SemanticRisk,
  SortDirection,
  SupportLevel,
  TerminalDecision,
  TimeoutClass,
  adapterId,
  policyId,
  providerId,
  validationProfileId,
} from './provider-routing-contracts';
import { ProviderRegistry } from './provider-registry';
import { RoutingPolicyEngine } from './routing-policy-engine';
import {
  LocalContinuityAdmission,
  LocalContinuityAdmissionError,
  WorkloadLocalFallbackPolicy,
  admitPriorAttemptFailure,
  admitTrustedCurrentUnavailability,
  deriveKindAStaticFacts,
  type LocalContinuityAdmissionInput,
  type LocalContinuityQualityFloor,
} from './local-continuity-admission';

interface DescriptorOptions {
  locality?: ExecutionLocality;
  semantic?: ReliabilityTier;
  authority?: ReliabilityTier;
  continuity?: ReliabilityTier;
  context?: ContextCapacity;
  toolUse?: SupportLevel;
  structured?: SupportLevel;
  enabled?: boolean;
  capabilities?: readonly Capability[];
  routingClass?: RoutingClass;
}

function descriptor(id: string, options: DescriptorOptions = {}): ProviderDescriptor {
  return {
    providerId: providerId(id),
    adapterId: adapterId('fixture-adapter'),
    modelId: `opaque-${id}`,
    capabilities: {
      supportedCapabilities: options.capabilities ?? [Capability.GENERAL_CHAT],
      routingClasses: [options.routingClass ?? RoutingClass.BALANCED],
      semanticReliability: options.semantic ?? ReliabilityTier.STANDARD,
      authorityReliability: options.authority ?? ReliabilityTier.STANDARD,
      continuityReliability: options.continuity ?? ReliabilityTier.STANDARD,
      toolUse: options.toolUse ?? SupportLevel.UNSUPPORTED,
      structuredOutput: options.structured ?? SupportLevel.SUPPORTED,
      contextCapacity: options.context ?? ContextCapacity.MEDIUM,
      streaming: SupportLevel.UNSUPPORTED,
      executionLocality: options.locality ?? ExecutionLocality.LOCAL,
    },
    operationalProfile: {
      latencyTier: LatencyTier.BALANCED,
      timeoutClass: TimeoutClass.STANDARD,
      costTier: CostTier.LOW,
      concurrencyClass: ConcurrencyClass.LIMITED,
      availabilityClass: AvailabilityClass.LOCAL_STABLE,
    },
    enabled: options.enabled ?? true,
    profileVersion: 'profile-v1',
  };
}

function registryOf(values: readonly ProviderDescriptor[]): ProviderRegistry {
  return new ProviderRegistry(
    'registry-v1',
    values.map((value) => ({ providerId: value.providerId, descriptor: value })),
  );
}

const BASE_POLICY: RoutingPolicy = {
  policyId: policyId('balanced-v1'),
  version: '1.0.0',
  precedence: 10,
  when: { semanticRisks: [SemanticRisk.STANDARD, SemanticRisk.UNKNOWN] },
  eligibility: {},
  ranking: [
    { dimension: RankingDimension.SEMANTIC_RELIABILITY, direction: SortDirection.DESCENDING },
    { dimension: RankingDimension.LATENCY_TIER, direction: SortDirection.ASCENDING },
  ],
  terminal: TerminalDecision.NO_SELECTION,
};

const engine = new RoutingPolicyEngine({ version: 'policy-set-v1', policies: [BASE_POLICY] });

function contextFor(capability: Capability): RoutingContext {
  return {
    capability,
    requestType: RoutingRequestType.CONVERSATIONAL,
    intentType: IntentType.CHAT,
    semanticRisk: SemanticRisk.STANDARD,
    latencyClass: LatencyClass.BALANCED,
    toolUseRequirement: Requirement.NOT_REQUIRED,
    authorityRequirement: AuthorityRequirement.NOT_REQUIRED,
    continuityRequirement: Requirement.UNKNOWN,
    expectedOutputSize: OutputSizeClass.MEDIUM,
    validationProfile: validationProfileId('general-chat-v1'),
  };
}

const NO_FLOOR: LocalContinuityQualityFloor = {};

/** Build a registry with a disabled cloud provider (A2) and an eligible local GENERAL_CHAT provider. */
function admissibleSetup() {
  const cloud = descriptor('cloud-provider', {
    locality: ExecutionLocality.NETWORK,
    enabled: false, // A2: administratively disabled by canonical config.
  });
  const local = descriptor('local-provider', {
    locality: ExecutionLocality.LOCAL,
    capabilities: [Capability.GENERAL_CHAT],
  });
  const registry = registryOf([cloud, local]);
  const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
  return { registry, admission };
}

function inputFor(
  registry: ProviderRegistry,
  overrides: Partial<LocalContinuityAdmissionInput> = {},
): LocalContinuityAdmissionInput {
  return {
    capability: Capability.GENERAL_CHAT,
    routingContext: contextFor(Capability.GENERAL_CHAT),
    requiredCapabilities: [Capability.GENERAL_CHAT],
    qualityFloor: NO_FLOOR,
    normalCloudProviderId: providerId('cloud-provider'),
    localProviderId: providerId('local-provider'),
    selectionConfigurationRef: registry.configurationDigest,
    ...overrides,
  };
}

// A. Workload policy
describe('R3-C1 A — workload local-fallback policy', () => {
  it('admits an eligible workload (GENERAL_CHAT) when all other conditions hold', () => {
    const { registry, admission } = admissibleSetup();
    const { decision, soleSelection } = admission.admit(inputFor(registry));
    expect(decision.admitted).toBe(true);
    expect(decision.providerCandidate).toBe('local-provider');
    expect(soleSelection).toBeDefined();
  });

  it.each([
    Capability.CODE_IMPLEMENTATION,
    Capability.CODE_REVIEW,
    Capability.ARCHITECTURE_PLANNING,
    Capability.DOCUMENT_ANALYSIS,
  ])('denies local-fallback-ineligible workload %s with zero selection/preparation', (capability) => {
    const { registry, admission } = admissibleSetup();
    const { decision, soleSelection } = admission.admit(
      inputFor(registry, {
        capability,
        routingContext: contextFor(capability),
        requiredCapabilities: [capability],
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('WORKLOAD_LOCAL_FALLBACK_DISALLOWED');
    expect(decision.providerCandidate).toBeUndefined();
    expect(soleSelection).toBeUndefined();
  });

  it('policy owner is deterministic and versioned', () => {
    const policy = new WorkloadLocalFallbackPolicy();
    expect(policy.localFallbackAllowed(Capability.GENERAL_CHAT)).toBe(true);
    expect(policy.localFallbackAllowed(Capability.CODE_IMPLEMENTATION)).toBe(false);
    expect(policy.version).toBe('r3c1-workload-local-fallback-v1');
  });
});

// B. Quality / capability
describe('R3-C1 B — quality and capability floor (local must independently satisfy)', () => {
  it('denies when local provider is below the quality floor', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', {
      locality: ExecutionLocality.LOCAL,
      semantic: ReliabilityTier.LOW,
    });
    const registry = registryOf([cloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(
      inputFor(registry, { qualityFloor: { minimumSemanticReliability: ReliabilityTier.HIGH } }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_BELOW_QUALITY_FLOOR');
  });

  it('denies when local provider is missing a required capability', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', {
      locality: ExecutionLocality.LOCAL,
      capabilities: [Capability.GENERAL_CHAT],
    });
    const registry = registryOf([cloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(
      inputFor(registry, { requiredCapabilities: [Capability.GENERAL_CHAT, Capability.SUMMARIZATION] }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_MISSING_CAPABILITY');
  });

  it('admits when local candidate independently satisfies the floor and other conditions hold', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', {
      locality: ExecutionLocality.LOCAL,
      semantic: ReliabilityTier.HIGH,
      context: ContextCapacity.LARGE,
    });
    const registry = registryOf([cloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(
      inputFor(registry, {
        qualityFloor: {
          minimumSemanticReliability: ReliabilityTier.HIGH,
          minimumContextCapacity: ContextCapacity.LARGE,
        },
      }),
    );
    expect(decision.admitted).toBe(true);
  });
});

// C. Kind A
describe('R3-C1 C — Kind A closed derived static facts', () => {
  it('A1: derives PROVIDER_NOT_CONFIGURED when the normal cloud provider is absent', () => {
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([local]);
    const facts = deriveKindAStaticFacts(registry, {
      normalCloudProviderId: providerId('missing-cloud'),
      selectionConfigurationRef: registry.configurationDigest,
    });
    expect(facts?.satisfiedFacts).toContain('PROVIDER_NOT_CONFIGURED');
  });

  it('A2: derives PROVIDER_ADMINISTRATIVELY_DISABLED from the canonical enabled flag', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloud, local]);
    const facts = deriveKindAStaticFacts(registry, {
      normalCloudProviderId: providerId('cloud-provider'),
      selectionConfigurationRef: registry.configurationDigest,
    });
    expect(facts?.satisfiedFacts).toContain('PROVIDER_ADMINISTRATIVELY_DISABLED');
  });

  it('A3: derives REQUIRED_PROVIDER_CONFIGURATION_ABSENT when a required cloud id is absent', () => {
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([local]);
    const facts = deriveKindAStaticFacts(registry, {
      requiredCloudProviderIds: [providerId('required-cloud')],
      selectionConfigurationRef: registry.configurationDigest,
    });
    expect(facts?.satisfiedFacts).toContain('REQUIRED_PROVIDER_CONFIGURATION_ABSENT');
  });

  it('returns null (no static fact) when the normal cloud provider is configured and enabled', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloud, local]);
    const facts = deriveKindAStaticFacts(registry, {
      normalCloudProviderId: providerId('cloud-provider'),
      selectionConfigurationRef: registry.configurationDigest,
    });
    expect(facts).toBeNull();
  });

  it('a configured+enabled cloud denies admission with NO_DERIVED_STATIC_UNAVAILABILITY', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NO_DERIVED_STATIC_UNAVAILABILITY');
  });

  it('Kind A cannot be supplied by a caller: forged evidence field is ignored (excess property)', () => {
    const { registry } = admissibleSetup();
    const input = inputFor(registry) as Record<string, unknown>;
    expect(input.evidence).toBeUndefined();
    expect(input.evidenceKind).toBeUndefined();
    const { registry: r2, admission } = admissibleSetup();
    const forged = { ...inputFor(r2), evidenceKind: 'STATIC_INELIGIBILITY' } as LocalContinuityAdmissionInput;
    const { decision } = admission.admit(forged);
    expect(decision.admitted).toBe(true); // still derives A2 from config; forged field has no effect
  });

  it('quality-floor exclusion of cloud is NOT Kind A: configured+enabled weak cloud yields null', () => {
    const cloud = descriptor('cloud-provider', {
      locality: ExecutionLocality.NETWORK,
      enabled: true,
      semantic: ReliabilityTier.LOW,
    });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloud, local]);
    const facts = deriveKindAStaticFacts(registry, {
      normalCloudProviderId: providerId('cloud-provider'),
      selectionConfigurationRef: registry.configurationDigest,
    });
    expect(facts).toBeNull();
  });

  it('availabilityClass NETWORK_DEPENDENT is never consulted by Kind A derivation', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: true });
    const withNetworkDependent: ProviderDescriptor = {
      ...cloud,
      operationalProfile: {
        ...cloud.operationalProfile,
        availabilityClass: AvailabilityClass.NETWORK_DEPENDENT,
      },
    };
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([withNetworkDependent, local]);
    const facts = deriveKindAStaticFacts(registry, {
      normalCloudProviderId: providerId('cloud-provider'),
      selectionConfigurationRef: registry.configurationDigest,
    });
    expect(facts).toBeNull();
  });
});

// D. Configuration binding
describe('R3-C1 D — immutable configuration identity binding', () => {
  it('admits when selectionConfigurationRef matches the registry configuration digest', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(
      inputFor(registry, { selectionConfigurationRef: registry.configurationDigest }),
    );
    expect(decision.admitted).toBe(true);
  });

  it('denies with CONFIGURATION_IDENTITY_MISMATCH when the config ref does not match', () => {
    const { registry, admission } = admissibleSetup();
    const otherDigest = 'a'.repeat(64);
    const { decision } = admission.admit(inputFor(registry, { selectionConfigurationRef: otherDigest }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CONFIGURATION_IDENTITY_MISMATCH');
  });

  it('deriveKindAStaticFacts returns null when the config ref does not match (recompute required)', () => {
    const { registry } = admissibleSetup();
    const facts = deriveKindAStaticFacts(registry, {
      normalCloudProviderId: providerId('cloud-provider'),
      selectionConfigurationRef: 'b'.repeat(64),
    });
    expect(facts).toBeNull();
  });
});

// E. Kind B
describe('R3-C1 E — Kind B TRUSTED_CURRENT_UNAVAILABILITY is always DENY (no issuer)', () => {
  it('the only Kind B entry point fails closed unconditionally', () => {
    expect(() => admitTrustedCurrentUnavailability()).toThrowError(LocalContinuityAdmissionError);
    try {
      admitTrustedCurrentUnavailability();
    } catch (error) {
      expect((error as LocalContinuityAdmissionError).reason).toBe('DYNAMIC_EVIDENCE_UNSUPPORTED');
    }
  });

  it('no caller path admits via a CURRENT/trusted label or availability snapshot', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const forged = {
      ...inputFor(registry),
      freshness: 'CURRENT',
      trusted: true,
      isAvailable: false,
    } as LocalContinuityAdmissionInput;
    const { decision } = admission.admit(forged);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NO_DERIVED_STATIC_UNAVAILABILITY');
  });
});

// F. Kind C
describe('R3-C1 F — Kind C PRIOR_ATTEMPT_FAILURE is unsupported/DENY', () => {
  it('the only Kind C entry point fails closed unconditionally', () => {
    expect(() => admitPriorAttemptFailure()).toThrowError(LocalContinuityAdmissionError);
    try {
      admitPriorAttemptFailure();
    } catch (error) {
      expect((error as LocalContinuityAdmissionError).reason).toBe('PRIOR_ATTEMPT_FAILURE_UNSUPPORTED');
    }
  });
});

// G. Attempt accounting
describe('R3-C1 G — attempt accounting', () => {
  it('an admitted local invocation is attempt 1 with zero additional hops', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(registry));
    expect(decision.admitted).toBe(true);
    expect(decision.attemptNumber).toBe(1);
    expect(decision.additionalProviderHops).toBe(0);
  });

  it('a denied decision still reports fixed one-attempt/zero-hop accounting (no nested budgets)', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(
      inputFor(registry, {
        capability: Capability.CODE_IMPLEMENTATION,
        routingContext: contextFor(Capability.CODE_IMPLEMENTATION),
        requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
      }),
    );
    expect(decision.attemptNumber).toBe(1);
    expect(decision.additionalProviderHops).toBe(0);
  });

  it('the decision encodes exactly one provider candidate and no cloud predecessor/successor', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(registry));
    expect(decision.providerCandidate).toBe('local-provider');
    expect(Object.keys(decision)).not.toContain('cloudAttempt');
    expect(Object.keys(decision)).not.toContain('nextProvider');
  });
});

// H. DENY semantics
describe('R3-C1 H — DENY means local not admitted, not whole-request STOP', () => {
  it('a denial reason names local-continuity non-admission only; it is not a request STOP', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(
      inputFor(registry, {
        capability: Capability.CODE_IMPLEMENTATION,
        routingContext: contextFor(Capability.CODE_IMPLEMENTATION),
        requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(Object.keys(decision)).not.toContain('requestDisposition');
    expect(decision.denialReason).toBe('WORKLOAD_LOCAL_FALLBACK_DISALLOWED');
  });
});

// I. Trust / runtime
describe('R3-C1 I — admission creates no production trust and no runtime/containment preparation', () => {
  it('an admitted decision is a plain immutable value with no capability/trust/instance handles', () => {
    const { registry, admission } = admissibleSetup();
    const { decision, soleSelection } = admission.admit(inputFor(registry));
    expect(Object.isFrozen(decision)).toBe(true);
    const asRecord = decision as unknown as Record<string, unknown>;
    expect(asRecord.containmentCapability).toBeUndefined();
    expect(asRecord.productionTrust).toBeUndefined();
    expect(asRecord.instance).toBeUndefined();
    expect(soleSelection).toBeDefined();
    const selRecord = soleSelection as unknown as Record<string, unknown>;
    expect(selRecord.schemaVersion).toBe('sole-provider-selection-v1');
    expect(selRecord.execute).toBeUndefined();
  });
});

// malformed / mismatch inputs
describe('R3-C1 — malformed and mismatch inputs fail closed', () => {
  it('malformed selectionConfigurationRef → MALFORMED_INPUT', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(registry, { selectionConfigurationRef: 'not-a-digest' }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('MALFORMED_INPUT');
  });

  it('routingContext.capability mismatch → ROUTING_CONTEXT_MISMATCH', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(
      inputFor(registry, {
        capability: Capability.GENERAL_CHAT,
        routingContext: contextFor(Capability.SUMMARIZATION),
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('ROUTING_CONTEXT_MISMATCH');
  });

  it('local provider not configured → LOCAL_PROVIDER_NOT_CONFIGURED', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(registry, { localProviderId: providerId('missing-local') }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_CONFIGURED');
  });

  it('a NETWORK-locality "local" provider is rejected as not a local provider', () => {
    const cloud = descriptor('cloud-provider', { locality: ExecutionLocality.NETWORK, enabled: false });
    const notLocal = descriptor('local-provider', { locality: ExecutionLocality.NETWORK });
    const registry = registryOf([cloud, notLocal]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_CONFIGURED');
  });
});
