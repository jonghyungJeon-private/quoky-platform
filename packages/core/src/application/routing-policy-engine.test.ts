import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  ProviderAvailability,
  ProviderDescriptor,
  RankingDimension,
  ReliabilityTier,
  Requirement,
  RoutingClass,
  RoutingConfigurationError,
  RoutingContext,
  RoutingPolicy,
  RoutingReasonCode,
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

interface DescriptorOptions {
  routingClass?: RoutingClass;
  semantic?: ReliabilityTier;
  authority?: ReliabilityTier;
  continuity?: ReliabilityTier;
  latency?: LatencyTier;
  cost?: CostTier;
  locality?: ExecutionLocality;
  toolUse?: SupportLevel;
  structured?: SupportLevel;
  context?: ContextCapacity;
  enabled?: boolean;
  capabilities?: readonly Capability[];
  modelId?: string;
}

function descriptor(id: string, options: DescriptorOptions = {}): ProviderDescriptor {
  return {
    providerId: providerId(id),
    adapterId: adapterId('fixture-adapter'),
    modelId: options.modelId ?? `opaque-${id}`,
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
      latencyTier: options.latency ?? LatencyTier.BALANCED,
      timeoutClass: TimeoutClass.STANDARD,
      costTier: options.cost ?? CostTier.LOW,
      concurrencyClass: ConcurrencyClass.LIMITED,
      availabilityClass: AvailabilityClass.LOCAL_STABLE,
    },
    enabled: options.enabled ?? true,
    profileVersion: 'profile-v1',
  };
}

function registry(values: readonly ProviderDescriptor[], availability: ProviderAvailability = ProviderAvailability.AVAILABLE) {
  const instance = new ProviderRegistry(
    'registry-v1',
    values.map((value) => ({ providerId: value.providerId, descriptor: value })),
  );
  return instance.snapshot(
    Object.fromEntries(values.map((value) => [value.providerId, availability])) as Record<
      string,
      ProviderAvailability
    >,
  );
}

const BASE_CONTEXT: RoutingContext = {
  capability: Capability.GENERAL_CHAT,
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

const BASE_POLICY: RoutingPolicy = {
  policyId: policyId('balanced-v1'),
  version: '1.0.0',
  precedence: 10,
  when: { semanticRisks: [SemanticRisk.STANDARD, SemanticRisk.UNKNOWN] },
  eligibility: {},
  ranking: [
    {
      dimension: RankingDimension.ROUTING_CLASS,
      direction: SortDirection.ASCENDING,
      routingClassPreference: [
        RoutingClass.BALANCED,
        RoutingClass.SEMANTIC_HIGH,
        RoutingClass.LATENCY_RESTRICTED,
        RoutingClass.DEPRIORITIZED,
      ],
    },
    { dimension: RankingDimension.SEMANTIC_RELIABILITY, direction: SortDirection.DESCENDING },
    { dimension: RankingDimension.LATENCY_TIER, direction: SortDirection.ASCENDING },
    { dimension: RankingDimension.COST_TIER, direction: SortDirection.ASCENDING },
  ],
  terminal: TerminalDecision.NO_SELECTION,
};

const engine = (policies: readonly RoutingPolicy[] = [BASE_POLICY]) =>
  new RoutingPolicyEngine({ version: 'policy-set-v1', policies });

describe('RoutingContext contract', () => {
  it('is bounded and represents UNKNOWN explicitly without raw or provider-specific fields', () => {
    const context: RoutingContext = {
      ...BASE_CONTEXT,
      semanticRisk: SemanticRisk.UNKNOWN,
      latencyClass: LatencyClass.UNKNOWN,
      toolUseRequirement: Requirement.UNKNOWN,
      authorityRequirement: AuthorityRequirement.UNKNOWN,
      expectedOutputSize: OutputSizeClass.UNKNOWN,
    };
    expect(Object.keys(context).sort()).toEqual(
      [
        'authorityRequirement',
        'capability',
        'continuityRequirement',
        'expectedOutputSize',
        'intentType',
        'latencyClass',
        'requestType',
        'semanticRisk',
        'toolUseRequirement',
        'validationProfile',
      ].sort(),
    );
    expect(JSON.stringify(context)).not.toMatch(/prompt|transcript|providerId|modelId|credential|reasoning/);
  });
});

describe('RoutingPolicyEngine configuration', () => {
  it('rejects duplicate policy ids, invalid versions/enums, empty ranking, and impossible eligibility', () => {
    expect(() => engine([BASE_POLICY, { ...BASE_POLICY }])).toThrow(/Duplicate policyId/);
    expect(() => new RoutingPolicyEngine({ version: '', policies: [BASE_POLICY] })).toThrow(/version/);
    expect(() => engine([{ ...BASE_POLICY, terminal: 'CONTINUE' as TerminalDecision }])).toThrow(/terminal/);
    expect(() => engine([{ ...BASE_POLICY, ranking: [] }])).toThrow(/ranking/);
    expect(() =>
      engine([
        {
          ...BASE_POLICY,
          ranking: [
            {
              dimension: RankingDimension.ROUTING_CLASS,
              direction: SortDirection.DESCENDING,
              routingClassPreference: [RoutingClass.BALANCED],
            },
          ],
        },
      ]),
    ).toThrow(/ASCENDING/);
    expect(() =>
      engine([
        {
          ...BASE_POLICY,
          eligibility: {
            requiredRoutingClasses: [RoutingClass.BALANCED],
            excludedRoutingClasses: [RoutingClass.BALANCED],
          },
        },
      ]),
    ).toThrow(/excluded routing classes/);
  });

  it('normalizes policy order and unordered predicate arrays for a deterministic digest', () => {
    const semantic: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('semantic-v1'),
      precedence: 20,
      when: { semanticRisks: [SemanticRisk.HIGH, SemanticRisk.LOW] },
    };
    const reorderedSemantic: RoutingPolicy = {
      ...semantic,
      when: { semanticRisks: [SemanticRisk.LOW, SemanticRisk.HIGH] },
    };
    expect(engine([BASE_POLICY, semantic]).policyDigest).toBe(engine([reorderedSemantic, BASE_POLICY]).policyDigest);
  });

  it('locks the canonical policy digest test vector', () => {
    expect(engine().policyDigest).toBe('6029e06c23c1745fce49e7fd726a353d173e7a50b2c9457e1262707c051ecdf8');
    expect(engine([{ ...BASE_POLICY, precedence: 11 }]).policyDigest).not.toBe(engine().policyDigest);
  });
});

describe('RoutingPolicyEngine eligibility and ranking', () => {
  it('selects the balanced class and explains the decision with bounded identity', () => {
    const snapshot = registry([
      descriptor('semantic', { routingClass: RoutingClass.SEMANTIC_HIGH, semantic: ReliabilityTier.HIGH }),
      descriptor('balanced', { routingClass: RoutingClass.BALANCED }),
    ]);
    const decision = engine().select(BASE_CONTEXT, snapshot);
    expect(decision).toMatchObject({
      selectedProviderId: 'balanced',
      eligibleProviderIds: ['balanced', 'semantic'],
      matchedPolicyId: 'balanced-v1',
      reasonCode: RoutingReasonCode.SELECTED,
      policyVersion: 'policy-set-v1',
      registryVersion: 'registry-v1',
    });
    expect(decision.registryConfigurationDigest).toBe(snapshot.configurationDigest);
    expect(decision.policyConfigurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(decision)).not.toEqual(
      expect.arrayContaining(['reasoning', 'executionResult', 'latency', 'rawError', 'attemptAudit', 'response']),
    );
  });

  it('locks the combined registry/policy configuration digest test vector', () => {
    const decision = engine().select(BASE_CONTEXT, registry([descriptor('provider-a')]));
    expect(decision.configurationDigest).toBe(
      '6fd35d080ef5240e5d78f44f15a1c71e33ecf5aaaa247c52654c7106b3d1ae16',
    );
  });

  it('supports semantic-high and latency-restricted paths through traits, not model ids', () => {
    const semanticPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('semantic-v1'),
      precedence: 100,
      when: { semanticRisks: [SemanticRisk.HIGH] },
      eligibility: {
        requiredRoutingClasses: [RoutingClass.SEMANTIC_HIGH],
        minimumSemanticReliability: ReliabilityTier.HIGH,
      },
    };
    const latencyPolicy: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('latency-v1'),
      precedence: 90,
      when: { semanticRisks: [SemanticRisk.LOW], latencyClasses: [LatencyClass.INTERACTIVE] },
      eligibility: { requiredRoutingClasses: [RoutingClass.LATENCY_RESTRICTED] },
      ranking: [{ dimension: RankingDimension.LATENCY_TIER, direction: SortDirection.ASCENDING }],
    };
    const snapshot = registry([
      descriptor('balanced', { routingClass: RoutingClass.BALANCED, modelId: 'opaque-alpha' }),
      descriptor('semantic', {
        routingClass: RoutingClass.SEMANTIC_HIGH,
        semantic: ReliabilityTier.HIGH,
        modelId: 'opaque-beta',
      }),
      descriptor('latency', {
        routingClass: RoutingClass.LATENCY_RESTRICTED,
        latency: LatencyTier.FAST,
        modelId: 'opaque-gamma',
      }),
    ]);
    const configured = engine([semanticPolicy, latencyPolicy, BASE_POLICY]);
    expect(configured.select({ ...BASE_CONTEXT, semanticRisk: SemanticRisk.HIGH }, snapshot).selectedProviderId).toBe(
      'semantic',
    );
    expect(
      configured.select(
        { ...BASE_CONTEXT, semanticRisk: SemanticRisk.LOW, latencyClass: LatencyClass.INTERACTIVE },
        snapshot,
      ).selectedProviderId,
    ).toBe('latency');
  });

  it('excludes disabled, unavailable, and unsupported providers before ranking', () => {
    const values = [
      descriptor('disabled', { enabled: false, semantic: ReliabilityTier.HIGH }),
      descriptor('unsupported', { capabilities: [Capability.SUMMARIZATION], semantic: ReliabilityTier.HIGH }),
      descriptor('available'),
      descriptor('unavailable', { semantic: ReliabilityTier.HIGH }),
    ];
    const instance = new ProviderRegistry(
      'registry-v1',
      values.map((value) => ({ providerId: value.providerId, descriptor: value })),
    );
    const snapshot = instance.snapshot({
      disabled: ProviderAvailability.AVAILABLE,
      unsupported: ProviderAvailability.AVAILABLE,
      available: ProviderAvailability.AVAILABLE,
      unavailable: ProviderAvailability.UNAVAILABLE,
    });
    const decision = engine().select(BASE_CONTEXT, snapshot);
    expect(decision.eligibleProviderIds).toEqual(['available']);
  });

  it.each([
    ['tool requirement', { toolUseRequirement: Requirement.REQUIRED }, { toolUse: SupportLevel.UNSUPPORTED }],
    ['locality', {}, { locality: ExecutionLocality.NETWORK }],
    ['structured output', {}, { structured: SupportLevel.UNSUPPORTED }],
    ['context capacity', {}, { context: ContextCapacity.SMALL }],
  ] as const)('applies %s eligibility before ranking', (_name, contextPatch, descriptorOptions) => {
    const rulePatch =
      _name === 'locality'
        ? { executionLocality: ExecutionLocality.LOCAL }
        : _name === 'structured output'
          ? { requiresStructuredOutput: true }
          : _name === 'context capacity'
            ? { minimumContextCapacity: ContextCapacity.MEDIUM }
            : {};
    const configured = engine([{ ...BASE_POLICY, eligibility: rulePatch }]);
    const decision = configured.select(
      { ...BASE_CONTEXT, ...contextPatch },
      registry([descriptor('ineligible', descriptorOptions), descriptor('eligible', { toolUse: SupportLevel.SUPPORTED })]),
    );
    expect(decision.eligibleProviderIds).not.toContain('ineligible');
  });

  it('applies routing-class exclusion before ranking', () => {
    const configured = engine([
      { ...BASE_POLICY, eligibility: { excludedRoutingClasses: [RoutingClass.DEPRIORITIZED] } },
    ]);
    const decision = configured.select(
      BASE_CONTEXT,
      registry([
        descriptor('excluded', { routingClass: RoutingClass.DEPRIORITIZED, semantic: ReliabilityTier.HIGH }),
        descriptor('balanced'),
      ]),
    );
    expect(decision.eligibleProviderIds).toEqual(['balanced']);
  });

  it('uses stable providerId tie-break independent of registration order', () => {
    const first = engine().select(BASE_CONTEXT, registry([descriptor('zeta'), descriptor('alpha')]));
    const second = engine().select(BASE_CONTEXT, registry([descriptor('alpha'), descriptor('zeta')]));
    expect(first.selectedProviderId).toBe('alpha');
    expect(second).toEqual(first);
  });

  it('does not use opaque model identity in ranking', () => {
    const first = engine().select(
      BASE_CONTEXT,
      registry([descriptor('alpha', { modelId: 'opaque-z' }), descriptor('beta', { modelId: 'opaque-a' })]),
    );
    const second = engine().select(
      BASE_CONTEXT,
      registry([descriptor('alpha', { modelId: 'opaque-a' }), descriptor('beta', { modelId: 'opaque-z' })]),
    );
    expect(first.selectedProviderId).toBe('alpha');
    expect(second.selectedProviderId).toBe('alpha');
  });

  it('returns explicit terminal decisions for no eligible provider and no matched policy', () => {
    const noneEligible = engine().select(
      BASE_CONTEXT,
      registry([descriptor('disabled', { enabled: false })]),
    );
    expect(noneEligible).toMatchObject({
      selectedProviderId: null,
      eligibleProviderIds: [],
      matchedPolicyId: 'balanced-v1',
      reasonCode: RoutingReasonCode.NO_ELIGIBLE_PROVIDER,
    });
    const noPolicy = engine().select(
      { ...BASE_CONTEXT, semanticRisk: SemanticRisk.LOW },
      registry([descriptor('balanced')]),
    );
    expect(noPolicy).toMatchObject({
      selectedProviderId: null,
      eligibleProviderIds: [],
      matchedPolicyId: null,
      reasonCode: RoutingReasonCode.POLICY_NOT_MATCHED,
    });
  });

  it('returns no eligible provider when a matched policy requires an unsupported routing class', () => {
    const configured = engine([
      { ...BASE_POLICY, eligibility: { requiredRoutingClasses: [RoutingClass.SEMANTIC_HIGH] } },
    ]);
    expect(configured.select(BASE_CONTEXT, registry([descriptor('balanced')]))).toMatchObject({
      selectedProviderId: null,
      eligibleProviderIds: [],
      matchedPolicyId: 'balanced-v1',
      reasonCode: RoutingReasonCode.NO_ELIGIBLE_PROVIDER,
    });
  });

  it('routes explicit UNKNOWN signals through a policy that admits UNKNOWN', () => {
    const context: RoutingContext = {
      ...BASE_CONTEXT,
      semanticRisk: SemanticRisk.UNKNOWN,
      latencyClass: LatencyClass.UNKNOWN,
      toolUseRequirement: Requirement.UNKNOWN,
      authorityRequirement: AuthorityRequirement.UNKNOWN,
      continuityRequirement: Requirement.UNKNOWN,
      expectedOutputSize: OutputSizeClass.UNKNOWN,
    };
    expect(engine().select(context, registry([descriptor('balanced')])).selectedProviderId).toBe('balanced');
  });

  it('returns the identical decision for identical inputs', () => {
    const snapshot = registry([descriptor('balanced'), descriptor('semantic', { semantic: ReliabilityTier.HIGH })]);
    const configured = engine();
    expect(configured.select(BASE_CONTEXT, snapshot)).toEqual(configured.select(BASE_CONTEXT, snapshot));
  });

  it('rejects invalid runtime context enum values', () => {
    expect(() =>
      engine().select(
        { ...BASE_CONTEXT, semanticRisk: 'EXTREME' as SemanticRisk },
        registry([descriptor('balanced')]),
      ),
    ).toThrow(/context.semanticRisk/);
  });
});

describe('Slice 1 boundaries', () => {
  it('contains no concrete provider/model implementation, invocation, or Stage 2A evidence import', () => {
    const files = [
      'provider-routing-contracts.ts',
      'provider-registry.ts',
      'routing-policy-engine.ts',
    ].map((file) => readFileSync(join(__dirname, file), 'utf8'));
    const source = files.join('\n');
    expect(source).not.toMatch(/ollama|llama3|granite|mistral|@quoky\/ai-cli/i);
    expect(source).not.toMatch(/provider-semantic|golden.corpus|benchmark.*evidence/i);
    expect(source).not.toContain('.execute(');
    expect(source).not.toMatch(/conversation-runtime|code-generation-manager/i);
  });
});

describe('RoutingPolicyEngine.staticEligibility — read-only static projection (availability-independent)', () => {
  it('returns eligible providers partitioned by locality without consulting availability', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-a', { locality: ExecutionLocality.LOCAL });
    // Mark EVERYTHING UNAVAILABLE: static eligibility must ignore this entirely.
    const snapshot = registry([cloud, local], ProviderAvailability.UNAVAILABLE);
    const projection = engine().staticEligibility(BASE_CONTEXT, snapshot);
    expect(projection.policyMatched).toBe(true);
    expect([...projection.eligibleProviderIds].sort()).toEqual(['cloud-a', 'local-a']);
    expect(projection.eligibleNetworkProviderIds).toEqual(['cloud-a']);
    expect(projection.eligibleLocalProviderIds).toEqual(['local-a']);
  });

  it('produces the SAME result regardless of the availability snapshot value', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const local = descriptor('local-a', { locality: ExecutionLocality.LOCAL });
    const available = engine().staticEligibility(BASE_CONTEXT, registry([cloud, local], ProviderAvailability.AVAILABLE));
    const unavailable = engine().staticEligibility(BASE_CONTEXT, registry([cloud, local], ProviderAvailability.UNAVAILABLE));
    const unknown = engine().staticEligibility(BASE_CONTEXT, registry([cloud, local], ProviderAvailability.UNKNOWN));
    expect(available.eligibleNetworkProviderIds).toEqual(unavailable.eligibleNetworkProviderIds);
    expect(available.eligibleNetworkProviderIds).toEqual(unknown.eligibleNetworkProviderIds);
    expect(available.eligibleLocalProviderIds).toEqual(unavailable.eligibleLocalProviderIds);
  });

  it('administratively disabled providers are excluded from the static set', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK, enabled: false });
    const local = descriptor('local-a', { locality: ExecutionLocality.LOCAL });
    const projection = engine().staticEligibility(BASE_CONTEXT, registry([cloud, local]));
    expect(projection.eligibleNetworkProviderIds).toEqual([]);
    expect(projection.eligibleLocalProviderIds).toEqual(['local-a']);
  });

  it('respects the policy quality floor (capability/quality/locality distinctions remain canonical)', () => {
    const highFloor: RoutingPolicy = {
      ...BASE_POLICY,
      policyId: policyId('high-floor-v1'),
      eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH },
    };
    const strongCloud = descriptor('cloud-strong', { locality: ExecutionLocality.NETWORK, semantic: ReliabilityTier.HIGH });
    const weakCloud = descriptor('cloud-weak', { locality: ExecutionLocality.NETWORK, semantic: ReliabilityTier.STANDARD });
    const projection = engine([highFloor]).staticEligibility(BASE_CONTEXT, registry([strongCloud, weakCloud]));
    expect(projection.eligibleNetworkProviderIds).toEqual(['cloud-strong']);
  });

  it('returns the SAME composite configurationDigest that select() returns', () => {
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const snapshot = registry([cloud]);
    const eng = engine();
    const projection = eng.staticEligibility(BASE_CONTEXT, snapshot);
    const decision = eng.select(BASE_CONTEXT, snapshot);
    expect(projection.configurationDigest).toBe(decision.configurationDigest);
  });

  it('reports no policy match without throwing when no policy applies', () => {
    const noMatch: RoutingPolicy = { ...BASE_POLICY, when: { capabilities: [Capability.EMBEDDING] } };
    const cloud = descriptor('cloud-a', { locality: ExecutionLocality.NETWORK });
    const projection = engine([noMatch]).staticEligibility(BASE_CONTEXT, registry([cloud]));
    expect(projection.policyMatched).toBe(false);
    expect(projection.eligibleNetworkProviderIds).toEqual([]);
  });

  it('does not rank, select, build an ExecutionPlan, or invoke a Provider', () => {
    const source = readFileSync(join(__dirname, 'routing-policy-engine.ts'), 'utf8');
    // The staticEligibility method body must not sort by ranking rules or call compareByRule.
    const method = source.slice(source.indexOf('staticEligibility('), source.indexOf('private compositeConfigurationDigest'));
    expect(method).not.toContain('compareByRule');
    expect(method).not.toContain('.execute(');
    expect(method).not.toContain('ExecutionPlan');
  });
});
