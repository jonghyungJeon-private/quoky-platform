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
}

function descriptor(id: string, options: DescriptorOptions = {}): ProviderDescriptor {
  return {
    providerId: providerId(id),
    adapterId: adapterId('fixture-adapter'),
    modelId: `opaque-${id}`,
    capabilities: {
      supportedCapabilities: options.capabilities ?? [Capability.GENERAL_CHAT],
      routingClasses: [RoutingClass.BALANCED],
      semanticReliability: options.semantic ?? ReliabilityTier.STANDARD,
      authorityReliability: ReliabilityTier.STANDARD,
      continuityReliability: ReliabilityTier.STANDARD,
      toolUse: SupportLevel.UNSUPPORTED,
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

/** Registry with NO NETWORK provider configured + an eligible LOCAL provider → Kind A holds. */
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

// A. Workload policy
describe('R3-C1 A — workload local-fallback policy', () => {
  it('admits an eligible workload (GENERAL_CHAT) when a canonical cloud path is absent', () => {
    const { registry, admission } = admissibleSetup();
    const { decision, soleSelection } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(true);
    expect(decision.providerCandidate).toBe('local-provider');
    expect(soleSelection).toBeDefined();
  });

  it.each([
    Capability.CODE_IMPLEMENTATION,
    Capability.CODE_REVIEW,
    Capability.ARCHITECTURE_PLANNING,
    Capability.DOCUMENT_ANALYSIS,
  ])('denies local-fallback-ineligible workload %s with zero selection', (capability) => {
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

// B-1 / B-2 — canonical cloud-path static unavailability (Claude probes P1/P2/P3)
describe('R3-C1 B-1/B-2 — Kind A = empty canonical static NETWORK path (not caller-named providers)', () => {
  it('the public input has no caller-controlled cloud provider id fields', () => {
    const { registry } = admissibleSetup();
    const input = inputFor(engine, registry) as Record<string, unknown>;
    expect(input.normalCloudProviderId).toBeUndefined();
    expect(input.requiredCloudProviderIds).toBeUndefined();
  });

  it('P1: healthy eligible cloud-a + caller names a ghost cloud (excess prop) → NOT admitted', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const forged = { ...inputFor(engine, registry), normalCloudProviderId: 'ghost-cloud' } as LocalContinuityAdmissionInput;
    const { decision } = admission.admit(forged);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('P2: healthy eligible cloud-a + caller adds requiredCloudProviderIds=[ghost-2] → NOT admitted', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const forged = { ...inputFor(engine, registry), requiredCloudProviderIds: ['ghost-2'] } as LocalContinuityAdmissionInput;
    const { decision } = admission.admit(forged);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('P3: healthy eligible cloud-a + unrelated disabled old-cloud → DENY local continuity', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: true });
    const oldCloud = descriptor('old-cloud', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, oldCloud, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('zero statically eligible canonical NETWORK providers → Kind A may hold (admit)', () => {
    const { registry, admission } = admissibleSetup(); // only a LOCAL provider configured
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(true);
  });

  it('one statically eligible NETWORK provider → no Kind A (deny)', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('multiple clouds, at least one statically eligible → no Kind A (deny)', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false });
    const cloudB = descriptor('cloud-b', { locality: ExecutionLocality.NETWORK, enabled: true });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, cloudB, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('all relevant canonical NETWORK providers administratively disabled → Kind A may hold (admit)', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false });
    const cloudB = descriptor('cloud-b', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, cloudB, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(true);
  });
});

// Normal routing stays normal routing
describe('R3-C1 — normal routing facts are NOT Kind A', () => {
  it('cloud excluded only by quality floor is NOT Kind A (normal cloud path still exists statically)', () => {
    // Policy requires HIGH semantic; cloud-a is STANDARD so it is quality-excluded at selection time, but
    // Kind A must not treat that as unavailability. To isolate: cloud-a remains statically INELIGIBLE only
    // by the floor, so it is not in the NETWORK set — but a quality-floor failure must not itself admit.
    const floorPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const floorEngine = engineWith([floorPolicy]);
    // cloud-a STANDARD (fails floor), local also STANDARD (fails floor) → local not eligible → deny by
    // local eligibility, NOT admitted via a "cloud quality failure = Kind A" path.
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, semantic: ReliabilityTier.STANDARD });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, semantic: ReliabilityTier.STANDARD });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), floorEngine, registry);
    const { decision } = admission.admit(inputFor(floorEngine, registry));
    // Cloud-a is not statically eligible (floor), so NETWORK set is empty (Kind A would hold), BUT the
    // local provider ALSO fails the same floor → must DENY on local eligibility, never admit on a cloud
    // quality failure. This proves quality-floor exclusion does not convert into a local-continuity grant.
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE');
  });

  it('local must independently satisfy the same floor: HIGH-floor cloud empty + HIGH local → admit', () => {
    const floorPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const floorEngine = engineWith([floorPolicy]);
    // No NETWORK provider configured at all → Kind A; local is HIGH → passes the same floor → admit.
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, semantic: ReliabilityTier.HIGH });
    const registry = registryOf([local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), floorEngine, registry);
    const { decision } = admission.admit(inputFor(floorEngine, registry));
    expect(decision.admitted).toBe(true);
  });

  it('availabilityClass=NETWORK_DEPENDENT on an enabled eligible cloud does NOT create Kind A', () => {
    const cloudA = descriptor('cloud-a', {
      locality: ExecutionLocality.NETWORK,
      availabilityClass: AvailabilityClass.NETWORK_DEPENDENT,
    });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });
});

// B-3 — composite configuration binding (Claude probe P7)
describe('R3-C1 B-3 — composite (registry + policy) configuration identity binding', () => {
  it('admits when selectionConfigurationRef equals the composite Stage2B configuration digest', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry, { selectionConfigurationRef: compositeDigest(engine, registry) }));
    expect(decision.admitted).toBe(true);
  });

  it('P7: same registry + different routing policy → different composite identity → old ref rejected', () => {
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([local]);
    const engineP1 = engineWith([BASE_POLICY], 'policy-set-v1');
    const engineP2 = engineWith(
      [{ ...BASE_POLICY, policyId: policyId('balanced-v2'), version: '2.0.0' }],
      'policy-set-v2',
    );
    const refUnderP1 = compositeDigest(engineP1, registry);
    const refUnderP2 = compositeDigest(engineP2, registry);
    expect(refUnderP1).not.toBe(refUnderP2); // policy change alters the composite identity

    // Admission runs under engineP2 but the caller presents the stale ref derived under engineP1.
    const admissionP2 = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engineP2, registry);
    const { decision } = admissionP2.admit(inputFor(engineP2, registry, { selectionConfigurationRef: refUnderP1 }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CONFIGURATION_IDENTITY_MISMATCH');
  });

  it('a registry-only style digest (wrong composite) is rejected', () => {
    const { registry, admission } = admissibleSetup();
    // The bare registry configurationDigest is NOT the composite; it must be rejected.
    const { decision } = admission.admit(inputFor(engine, registry, { selectionConfigurationRef: registry.configurationDigest }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CONFIGURATION_IDENTITY_MISMATCH');
  });

  it('a mismatched arbitrary digest is rejected', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry, { selectionConfigurationRef: 'a'.repeat(64) }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('CONFIGURATION_IDENTITY_MISMATCH');
  });
});

// Local provider eligibility (reuses the SAME static projection)
describe('R3-C1 — local provider must be statically eligible under the same policy/config', () => {
  it('denies when the local candidate is missing a required capability under the policy', () => {
    // Policy predicate requires SUMMARIZATION capability; local supports only GENERAL_CHAT.
    const capPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('summarize-v1'),
      when: { capabilities: [Capability.SUMMARIZATION] },
    };
    const capEngine = engineWith([capPolicy]);
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL, capabilities: [Capability.GENERAL_CHAT] });
    const registry = registryOf([local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), capEngine, registry);
    const { decision } = admission.admit(
      inputFor(capEngine, registry, { capability: Capability.SUMMARIZATION, routingContext: contextFor(Capability.SUMMARIZATION) }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE');
  });

  it('denies a NETWORK-locality "local" provider (not a local provider)', () => {
    const notLocal = descriptor('local-provider', { locality: ExecutionLocality.NETWORK });
    const registry = registryOf([notLocal]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    // With only a NETWORK provider, the cloud path exists statically → deny on cloud path first.
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });

  it('denies when the named local provider is not configured', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry, { localProviderId: providerId('missing-local') }));
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE');
  });
});

// E. Kind B
describe('R3-C1 E — Kind B TRUSTED_CURRENT_UNAVAILABILITY is always DENY (no issuer)', () => {
  it('the only Kind B entry point fails closed unconditionally', () => {
    expect(() => assertTrustedCurrentUnavailabilityUnsupported()).toThrowError(LocalContinuityAdmissionError);
    try {
      assertTrustedCurrentUnavailabilityUnsupported();
    } catch (error) {
      expect((error as LocalContinuityAdmissionError).reason).toBe('DYNAMIC_EVIDENCE_UNSUPPORTED');
    }
  });

  it('no caller path admits via a CURRENT/trusted/isAvailable label when a cloud path exists', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const forged = {
      ...inputFor(engine, registry),
      freshness: 'CURRENT',
      trusted: true,
      isAvailable: false,
    } as LocalContinuityAdmissionInput;
    const { decision } = admission.admit(forged);
    expect(decision.admitted).toBe(false);
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });
});

// F. Kind C
describe('R3-C1 F — Kind C PRIOR_ATTEMPT_FAILURE is unsupported/DENY', () => {
  it('the only Kind C entry point fails closed unconditionally', () => {
    expect(() => assertPriorAttemptFailureUnsupported()).toThrowError(LocalContinuityAdmissionError);
    try {
      assertPriorAttemptFailureUnsupported();
    } catch (error) {
      expect((error as LocalContinuityAdmissionError).reason).toBe('PRIOR_ATTEMPT_FAILURE_UNSUPPORTED');
    }
  });
});

// G. Attempt accounting
describe('R3-C1 G — attempt accounting', () => {
  it('an admitted local invocation is attempt 1 with zero additional hops', () => {
    const { registry, admission } = admissibleSetup();
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(true);
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

// H. DENY semantics
describe('R3-C1 H — DENY means local not admitted, not whole-request STOP', () => {
  it('a denial names local-continuity non-admission only; it is not a request STOP/DEFER/HUMAN_REQUIRED', () => {
    const cloudA = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-provider', { locality: ExecutionLocality.LOCAL });
    const registry = registryOf([cloudA, local]);
    const admission = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry);
    const { decision } = admission.admit(inputFor(engine, registry));
    expect(decision.admitted).toBe(false);
    expect(Object.keys(decision)).not.toContain('requestDisposition');
    expect(decision.denialReason).toBe('NORMAL_CLOUD_PATH_STATICALLY_EXISTS');
  });
});

// I. Trust / runtime
describe('R3-C1 I — admission creates no production trust and no runtime/containment preparation', () => {
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
