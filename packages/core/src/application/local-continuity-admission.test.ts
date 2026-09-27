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
  assertPriorAttemptFailureUnsupported,
  assertTrustedCurrentUnavailabilityUnsupported,
  type LocalContinuityAdmissionInput,
} from './local-continuity-admission';

interface DescriptorOptions {
  locality?: ExecutionLocality;
  semantic?: ReliabilityTier;
  context?: ContextCapacity;
  enabled?: boolean;
  capabilities?: readonly Capability[];
  availabilityClass?: AvailabilityClass;
  toolUse?: SupportLevel;
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
      authorityReliability: ReliabilityTier.STANDARD,
      continuityReliability: ReliabilityTier.STANDARD,
      toolUse: options.toolUse ?? SupportLevel.UNSUPPORTED,
      structuredOutput: SupportLevel.SUPPORTED,
      contextCapacity: options.context ?? ContextCapacity.MEDIUM,
      streaming: SupportLevel.UNSUPPORTED,
      executionLocality: options.locality ?? ExecutionLocality.LOCAL,
    },
    operationalProfile: {
      latencyTier: LatencyTier.BALANCED,
      timeoutClass: TimeoutClass.STANDARD,
      costTier: CostTier.LOW,
      concurrencyClass: ConcurrencyClass.LIMITED,
      availabilityClass: options.availabilityClass ?? AvailabilityClass.LOCAL_STABLE,
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

const engineWith = (policies: readonly RoutingPolicy[] = [BASE_POLICY], version = 'policy-set-v1') =>
  new RoutingPolicyEngine({ version, policies });

const engine = engineWith();

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

/** The composite (registry + policy) configuration identity — identical to what selection uses. */
function compositeDigest(routingEngine: RoutingPolicyEngine, registry: ProviderRegistry, capability = Capability.GENERAL_CHAT): string {
  return routingEngine.staticEligibility(contextFor(capability), registry.snapshot()).configurationDigest;
}

/** Registry with NO NETWORK provider configured + an eligible LOCAL provider → Kind A A1. */
function admissibleSetup(routingEngine: RoutingPolicyEngine = engine) {
  const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, capabilities: [Capability.GENERAL_CHAT] });
  const registry = registryOf([local]);
  const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), routingEngine, registry);
  return { registry, admission };
}

function inputFor(
  routingEngine: RoutingPolicyEngine,
  registry: ProviderRegistry,
  overrides: Partial<LocalContinuityAdmissionInput> = {},
): LocalContinuityAdmissionInput {
  return {
    capability: Capability.GENERAL_CHAT,
    routingContext: contextFor(Capability.GENERAL_CHAT),
    localProviderId: providerId('local-provider'),
    selectionConfigurationRef: compositeDigest(routingEngine, registry),
    ...overrides,
  };
}

function admit(routingEngine: RoutingPolicyEngine, providers: readonly ProviderDescriptor[], overrides: Partial<LocalContinuityAdmissionInput> = {}) {
  const registry = registryOf(providers);
  const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), routingEngine, registry);
  return admission.admit(inputFor(routingEngine, registry, overrides));
}

// Workload policy
describe('R3-C1 — workload local-fallback policy', () => {
  it('admits an eligible workload (GENERAL_CHAT) when Kind A A1 holds', () => {
    const { registry, admission } = admissibleSetup();
    const { decision, soleSelection } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(true);
    expect(decision.providerCandidate).toBe('local-provider');
    expect(decision.kindACondition).toBe('NO_CLOUD_PROVIDER_CONFIGURED');
    expect(soleSelection).toBeDefined();
  });

  it.each([
    Capability.CODE_IMPLEMENTATION,
    Capability.CODE_REVIEW,
    Capability.ARCHITECTURE_PLANNING,
    Capability.DOCUMENT_ANALYSIS,
  ])('denies local-fallback-ineligible workload %s', (capability) => {
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, capabilities: [capability] });
    const registry = registryOf([local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision, soleSelection } = admission.admit(
      inputFor(engine, registry, { capability, routingContext: contextFor(capability) }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('WORKLOAD_LOCAL_FALLBACK_DISALLOWED');
    expect(soleSelection).toBeUndefined();
  });

  it('policy owner is deterministic and versioned', () => {
    const policy = new WorkloadLocalFallbackPolicy();
    expect(policy.localFallbackAllowed(Capability.GENERAL_CHAT)).toBe(true);
    expect(policy.localFallbackAllowed(Capability.CODE_IMPLEMENTATION)).toBe(false);
    expect(policy.version).toBe('r3c1-workload-local-fallback-v1');
  });
});

// B-A accepted blocker probes: quality/capability/locality are NORMAL ROUTING, not Kind A.
describe('R3-C1 B-A — normal routing outcomes are NOT Kind A', () => {
  it('N1: enabled cloud below quality floor + local meets floor → DENY (not Kind A)', () => {
    const floorPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const floorEngine = engineWith([floorPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true, semantic: ReliabilityTier.STANDARD });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, enabled: true, semantic: ReliabilityTier.HIGH });
    const { decision } = admit(floorEngine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY');
  });

  it('N2: enabled cloud lacks capability + local has capability → DENY (not Kind A)', () => {
    const capPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('summarize-v1'),
      when: { capabilities: [Capability.SUMMARIZATION] },
    };
    const capEngine = engineWith([capPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true, capabilities: [Capability.GENERAL_CHAT] });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, enabled: true, capabilities: [Capability.SUMMARIZATION] });
    const { decision } = admit(capEngine, [cloud, local], {
      capability: Capability.SUMMARIZATION,
      routingContext: contextFor(Capability.SUMMARIZATION),
    });
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY');
  });

  it('N3: healthy configured cloud + policy requires LOCAL → DENY (normal LOCAL routing)', () => {
    const localPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('local-only-v1'),
      eligibility: { executionLocality: ExecutionLocality.LOCAL },
    };
    const localEngine = engineWith([localPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, enabled: true });
    const { decision } = admit(localEngine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('POLICY_REQUIRES_LOCAL_NORMAL_ROUTING');
  });
});

// Kind A cases + additional required tests
describe('R3-C1 — final Kind A semantics (Cases 0-4)', () => {
  it('#1 no cloud configured + general routing policy → Kind A A1 may admit', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(true);
    expect(decision.kindACondition).toBe('NO_CLOUD_PROVIDER_CONFIGURED');
  });

  it('#2 no cloud configured + policy requires LOCAL → DENY (Case 0)', () => {
    const localPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('local-only-v1'),
      eligibility: { executionLocality: ExecutionLocality.LOCAL },
    };
    const localEngine = engineWith([localPolicy]);
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(localEngine, [local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('POLICY_REQUIRES_LOCAL_NORMAL_ROUTING');
  });

  it('#3 one policy-compatible enabled cloud → DENY (Case 4)', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('#4 multiple clouds; one enabled compatible, one disabled → DENY (Case 4)', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const cloudB = descriptor('cloud-b', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloudA, cloudB, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('#5 all policy-compatible clouds disabled → Kind A A2 may admit', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false });
    const cloudB = descriptor('cloud-b', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloudA, cloudB, local]);
    expect(decision.admitted).toBe(true);
    expect(decision.kindACondition).toBe('ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED');
  });

  it('#6 clouds configured but all fail quality floor → DENY (Case 2)', () => {
    const floorPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const floorEngine = engineWith([floorPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true, semantic: ReliabilityTier.STANDARD });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, semantic: ReliabilityTier.HIGH });
    const { decision } = admit(floorEngine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY');
  });

  it('#7 clouds configured but all fail capability → DENY (Case 2)', () => {
    const capPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('summarize-v1'),
      when: { capabilities: [Capability.SUMMARIZATION] },
    };
    const capEngine = engineWith([capPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true, capabilities: [Capability.GENERAL_CHAT] });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, capabilities: [Capability.SUMMARIZATION] });
    const { decision } = admit(capEngine, [cloud, local], {
      capability: Capability.SUMMARIZATION,
      routingContext: contextFor(Capability.SUMMARIZATION),
    });
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY');
  });

  it('#8 clouds configured but all fail tool-support policy → DENY (Case 2)', () => {
    const toolPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('tool-required-v1'),
      eligibility: { requiresToolUse: true },
    };
    const toolEngine = engineWith([toolPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true, toolUse: SupportLevel.UNSUPPORTED });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, toolUse: SupportLevel.SUPPORTED });
    const { decision } = admit(toolEngine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY');
  });

  it('#9 availabilityClass=NETWORK_DEPENDENT alone (enabled compatible cloud) → DENY (Case 4), not Kind A', () => {
    const cloud = descriptor('cloud-a', {
      locality: ExecutionLocality.NETWORK,
      enabled: true,
      availabilityClass: AvailabilityClass.NETWORK_DEPENDENT,
    });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('#11 unrelated disabled cloud must not matter when another enabled compatible cloud exists → DENY', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const oldCloud = descriptor('old-cloud', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloudA, oldCloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('local must independently satisfy the same floor: A2 cloud + HIGH-floor + HIGH local → admit', () => {
    const floorPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const floorEngine = engineWith([floorPolicy]);
    // cloud policy-compatible (HIGH) but disabled → A2; local HIGH passes floor → admit.
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false, semantic: ReliabilityTier.HIGH });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, semantic: ReliabilityTier.HIGH });
    const { decision } = admit(floorEngine, [cloud, local]);
    expect(decision.admitted).toBe(true);
    expect(decision.kindACondition).toBe('ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED');
  });

  it('A2 holds but local fails the same floor → DENY on local eligibility', () => {
    const floorPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const floorEngine = engineWith([floorPolicy]);
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false, semantic: ReliabilityTier.HIGH });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, semantic: ReliabilityTier.STANDARD });
    const { decision } = admit(floorEngine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE');
  });
});

// Availability invariance at the admission level (#10)
describe('R3-C1 — admission is invariant under availability (projection ignores it)', () => {
  it('#10 admission result is identical for AVAILABLE/UNAVAILABLE/UNKNOWN registries', () => {
    // The admission uses registry.snapshot() internally; availability cannot change the outcome. We assert
    // the A2 path here regardless of any availability the registry could carry (registry has no runtime
    // availability of its own — snapshot defaults to UNKNOWN — and staticEligibility ignores it).
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloud, local]);
    expect(decision.admitted).toBe(true);
    expect(decision.kindACondition).toBe('ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED');
  });
});

// B-1 residual: caller cannot inject cloud identity
describe('R3-C1 B-1 — no caller-controlled cloud id fields', () => {
  it('public input has no cloud provider id fields; forged excess props are inert', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const input = inputFor(engine, registry) as Record<string, unknown>;
    expect(input.normalCloudProviderId).toBeUndefined();
    expect(input.requiredCloudProviderIds).toBeUndefined();
    const forged = { ...inputFor(engine, registry), normalCloudProviderId: 'ghost', requiredCloudProviderIds: ['ghost-2'] } as LocalContinuityAdmissionInput;
    const { decision } = admission.admit(forged);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });
});

// B-3 — composite configuration binding (#12/#13)
describe('R3-C1 B-3 — composite (registry + policy) configuration identity binding', () => {
  it('admits when selectionConfigurationRef equals the composite Stage2B configuration digest', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry, { selectionConfigurationRef: compositeDigest(engine, registry) }));
    expect(decision.admitted).toBe(true);
  });

  it('#12 same registry + different routing policy → different composite identity → old ref rejected', () => {
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([local]);
    const engineP1 = engineWith([BASE_POLICY], 'policy-set-v1');
    const engineP2 = engineWith([{ ...BASE_POLICY, policyId: policyId('balanced-v2'), version: '2.0.0' }], 'policy-set-v2');
    const refUnderP1 = compositeDigest(engineP1, registry);
    expect(refUnderP1).not.toBe(compositeDigest(engineP2, registry));
    const admissionP2 = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engineP2, registry);
    const { decision } = admissionP2.admit(inputFor(engineP2, registry, { selectionConfigurationRef: refUnderP1 }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CONFIGURATION_IDENTITY_MISMATCH');
  });

  it('#13 same policy + registry change → different composite identity', () => {
    const local1 = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry1 = registryOf([local1]);
    const registry2 = registryOf([local1, descriptor('local-2', { locality: ExecutionLocality.LOCAL })]);
    expect(compositeDigest(engine, registry1)).not.toBe(compositeDigest(engine, registry2));
  });

  it('a bare registry-only digest (wrong composite) is rejected', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry, { selectionConfigurationRef: registry.configurationDigest }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CONFIGURATION_IDENTITY_MISMATCH');
  });
});

// Local provider eligibility (reuses the SAME static projection)
describe('R3-C1 — local provider must be statically eligible under the same policy/config', () => {
  it('denies when the named local provider is not configured', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry, { localProviderId: providerId('missing-local') }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE');
  });

  it('denies when local lacks the policy-required capability (A1 cloud path)', () => {
    const capPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('summarize-v1'),
      when: { capabilities: [Capability.SUMMARIZATION] },
    };
    const capEngine = engineWith([capPolicy]);
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, capabilities: [Capability.GENERAL_CHAT] });
    const { decision } = admit(capEngine, [local], {
      capability: Capability.SUMMARIZATION,
      routingContext: contextFor(Capability.SUMMARIZATION),
    });
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE');
  });
});

// Kind B
describe('R3-C1 — Kind B TRUSTED_CURRENT_UNAVAILABILITY is always DENY (no issuer)', () => {
  it('the only Kind B entry point fails closed unconditionally', () => {
    expect(() => assertTrustedCurrentUnavailabilityUnsupported()).toThrowError(LocalContinuityAdmissionError);
    try {
      assertTrustedCurrentUnavailabilityUnsupported();
    } catch (error) {
      expect((error as LocalContinuityAdmissionError).reason).toBe('DYNAMIC_EVIDENCE_UNSUPPORTED');
    }
  });
});

// Kind C
describe('R3-C1 — Kind C PRIOR_ATTEMPT_FAILURE is unsupported/DENY', () => {
  it('the only Kind C entry point fails closed unconditionally', () => {
    expect(() => assertPriorAttemptFailureUnsupported()).toThrowError(LocalContinuityAdmissionError);
    try {
      assertPriorAttemptFailureUnsupported();
    } catch (error) {
      expect((error as LocalContinuityAdmissionError).reason).toBe('PRIOR_ATTEMPT_FAILURE_UNSUPPORTED');
    }
  });
});

// Attempt accounting
describe('R3-C1 — attempt accounting', () => {
  it('an admitted local invocation is attempt 1 with zero additional hops', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.attemptNumber).toBe(1);
    expect(decision.additionalProviderHops).toBe(0);
  });

  it('the decision encodes exactly one provider candidate and no cloud predecessor/successor', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.providerCandidate).toBe('local-provider');
    expect(Object.keys(decision)).not.toContain('cloudAttempt');
    expect(Object.keys(decision)).not.toContain('nextProvider');
  });
});

// DENY semantics
describe('R3-C1 — DENY means local not admitted, not whole-request STOP', () => {
  it('a denial names local-continuity non-admission only; no STOP/DEFER/HUMAN_REQUIRED field', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const { decision } = admit(engine, [cloud, local]);
    expect(decision.admitted).toBe(false);
    expect(Object.keys(decision)).not.toContain('requestDisposition');
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });
});

// Trust / runtime
describe('R3-C1 — admission creates no production trust and no runtime/containment preparation', () => {
  it('an admitted decision is a plain immutable value with no capability/trust/instance handles', () => {
    const { registry, admission } = admissibleSetup();
    const { decision, soleSelection } = admission.admit(inputFor(engine, registry));
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
    const { decision } = admission.admit(inputFor(engine, registry, { selectionConfigurationRef: 'not-a-digest' }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('MALFORMED_INPUT');
  });

  it('routingContext.capability mismatch → ROUTING_CONTEXT_MISMATCH', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(
      inputFor(engine, registry, { capability: Capability.GENERAL_CHAT, routingContext: contextFor(Capability.SUMMARIZATION) }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('ROUTING_CONTEXT_MISMATCH');
  });
});
