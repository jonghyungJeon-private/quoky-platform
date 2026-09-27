import { createHash } from 'node:crypto';
import { Capability, IntentType } from '../domain';
import {
  AuthorityRequirement,
  ContextCapacity,
  CostTier,
  EligibilityRule,
  ExecutionLocality,
  LatencyClass,
  LatencyTier,
  OutputSizeClass,
  PolicyId,
  ProviderAvailability,
  ProviderDescriptor,
  ProviderId,
  ProviderRegistrySnapshot,
  ProviderSelectionDecision,
  RankingDimension,
  RankingRule,
  ReliabilityTier,
  Requirement,
  RoutingClass,
  RoutingConfigurationError,
  RoutingContext,
  RoutingPolicy,
  RoutingPolicyConfiguration,
  RoutingPredicate,
  RoutingReasonCode,
  RoutingRequestType,
  SemanticRisk,
  SortDirection,
  StaticEligibilityProjection,
  SupportLevel,
  TerminalDecision,
  isRoutingIdentifier,
} from './provider-routing-contracts';

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const enumSet = <T extends string>(value: Record<string, T>): ReadonlySet<string> => new Set(Object.values(value));
const CAPABILITIES = enumSet(Capability);
const INTENT_TYPES = enumSet(IntentType);
const REQUEST_TYPES = enumSet(RoutingRequestType);
const SEMANTIC_RISKS = enumSet(SemanticRisk);
const LATENCY_CLASSES = enumSet(LatencyClass);
const REQUIREMENTS = enumSet(Requirement);
const AUTHORITY_REQUIREMENTS = enumSet(AuthorityRequirement);
const OUTPUT_SIZES = enumSet(OutputSizeClass);
const ROUTING_CLASSES = enumSet(RoutingClass);
const RELIABILITY_TIERS = enumSet(ReliabilityTier);
const CONTEXT_CAPACITIES = enumSet(ContextCapacity);
const EXECUTION_LOCALITIES = enumSet(ExecutionLocality);
const RANKING_DIMENSIONS = enumSet(RankingDimension);
const SORT_DIRECTIONS = enumSet(SortDirection);
const TERMINAL_DECISIONS = enumSet(TerminalDecision);

const RELIABILITY_ORDER: Readonly<Record<ReliabilityTier, number>> = {
  [ReliabilityTier.UNPROVEN]: 0,
  [ReliabilityTier.LOW]: 1,
  [ReliabilityTier.STANDARD]: 2,
  [ReliabilityTier.HIGH]: 3,
};
const CONTEXT_ORDER: Readonly<Record<ContextCapacity, number>> = {
  [ContextCapacity.SMALL]: 0,
  [ContextCapacity.MEDIUM]: 1,
  [ContextCapacity.LARGE]: 2,
};
const LATENCY_ORDER: Readonly<Record<LatencyTier, number>> = {
  [LatencyTier.FAST]: 0,
  [LatencyTier.BALANCED]: 1,
  [LatencyTier.SLOW]: 2,
  [LatencyTier.UNKNOWN]: 3,
};
const COST_ORDER: Readonly<Record<CostTier, number>> = {
  [CostTier.LOW]: 0,
  [CostTier.STANDARD]: 1,
  [CostTier.HIGH]: 2,
  [CostTier.UNKNOWN]: 3,
};

function assertVersion(value: string, field: string): void {
  if (!VERSION.test(value)) throw new RoutingConfigurationError(`Invalid ${field}`);
}

function assertEnum(value: string, allowed: ReadonlySet<string>, field: string): void {
  if (!allowed.has(value)) throw new RoutingConfigurationError(`Invalid ${field}: ${value}`);
}

function validateOptionalArray<T extends string>(
  values: readonly T[] | undefined,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  if (values === undefined) return;
  if (values.length === 0) throw new RoutingConfigurationError(`${field} must not be empty`);
  values.forEach((value) => assertEnum(value, allowed, field));
  if (new Set(values).size !== values.length) throw new RoutingConfigurationError(`${field} has duplicates`);
}

function validatePredicate(predicate: RoutingPredicate): void {
  validateOptionalArray(predicate.capabilities, CAPABILITIES, 'predicate.capabilities');
  validateOptionalArray(predicate.requestTypes, REQUEST_TYPES, 'predicate.requestTypes');
  validateOptionalArray(predicate.intentTypes, INTENT_TYPES, 'predicate.intentTypes');
  validateOptionalArray(predicate.semanticRisks, SEMANTIC_RISKS, 'predicate.semanticRisks');
  validateOptionalArray(predicate.latencyClasses, LATENCY_CLASSES, 'predicate.latencyClasses');
  validateOptionalArray(predicate.toolUseRequirements, REQUIREMENTS, 'predicate.toolUseRequirements');
  validateOptionalArray(predicate.authorityRequirements, AUTHORITY_REQUIREMENTS, 'predicate.authorityRequirements');
  validateOptionalArray(predicate.continuityRequirements, REQUIREMENTS, 'predicate.continuityRequirements');
  validateOptionalArray(predicate.outputSizes, OUTPUT_SIZES, 'predicate.outputSizes');
  if (predicate.validationProfiles !== undefined) {
    if (predicate.validationProfiles.length === 0) {
      throw new RoutingConfigurationError('predicate.validationProfiles must not be empty');
    }
    if (new Set(predicate.validationProfiles).size !== predicate.validationProfiles.length) {
      throw new RoutingConfigurationError('predicate.validationProfiles has duplicates');
    }
    if (predicate.validationProfiles.some((value) => !isRoutingIdentifier(value))) {
      throw new RoutingConfigurationError('Invalid predicate.validationProfiles');
    }
  }
}

function validateEligibility(rule: EligibilityRule): void {
  validateOptionalArray(rule.requiredRoutingClasses, ROUTING_CLASSES, 'requiredRoutingClasses');
  validateOptionalArray(rule.excludedRoutingClasses, ROUTING_CLASSES, 'excludedRoutingClasses');
  if (rule.minimumSemanticReliability) {
    assertEnum(rule.minimumSemanticReliability, RELIABILITY_TIERS, 'minimumSemanticReliability');
  }
  if (rule.minimumAuthorityReliability) {
    assertEnum(rule.minimumAuthorityReliability, RELIABILITY_TIERS, 'minimumAuthorityReliability');
  }
  if (rule.minimumContinuityReliability) {
    assertEnum(rule.minimumContinuityReliability, RELIABILITY_TIERS, 'minimumContinuityReliability');
  }
  if (rule.minimumContextCapacity) {
    assertEnum(rule.minimumContextCapacity, CONTEXT_CAPACITIES, 'minimumContextCapacity');
  }
  if (rule.executionLocality) {
    assertEnum(rule.executionLocality, EXECUTION_LOCALITIES, 'executionLocality');
  }
  if (rule.requiresToolUse !== undefined && typeof rule.requiresToolUse !== 'boolean') {
    throw new RoutingConfigurationError('Invalid requiresToolUse');
  }
  if (rule.requiresStructuredOutput !== undefined && typeof rule.requiresStructuredOutput !== 'boolean') {
    throw new RoutingConfigurationError('Invalid requiresStructuredOutput');
  }
  const required = rule.requiredRoutingClasses ?? [];
  const excluded = new Set(rule.excludedRoutingClasses ?? []);
  if (required.length > 0 && required.every((routingClass) => excluded.has(routingClass))) {
    throw new RoutingConfigurationError('Eligibility requires only excluded routing classes');
  }
}

function validateRanking(ranking: readonly RankingRule[]): void {
  if (ranking.length === 0) throw new RoutingConfigurationError('ranking must not be empty');
  ranking.forEach((rule) => {
    assertEnum(rule.dimension, RANKING_DIMENSIONS, 'ranking.dimension');
    assertEnum(rule.direction, SORT_DIRECTIONS, 'ranking.direction');
    if (rule.dimension === RankingDimension.ROUTING_CLASS) {
      validateOptionalArray(rule.routingClassPreference, ROUTING_CLASSES, 'routingClassPreference');
      if (rule.routingClassPreference === undefined) {
        throw new RoutingConfigurationError('ROUTING_CLASS ranking requires routingClassPreference');
      }
      if (rule.direction !== SortDirection.ASCENDING) {
        throw new RoutingConfigurationError('ROUTING_CLASS preference must use ASCENDING order');
      }
    } else if (rule.routingClassPreference !== undefined) {
      throw new RoutingConfigurationError('routingClassPreference is only valid for ROUTING_CLASS ranking');
    }
  });
  if (new Set(ranking.map((rule) => rule.dimension)).size !== ranking.length) {
    throw new RoutingConfigurationError('ranking dimensions must be unique');
  }
}

function freezePolicy(policy: RoutingPolicy): RoutingPolicy {
  assertVersion(policy.version, 'policy.version');
  if (!Number.isSafeInteger(policy.precedence) || policy.precedence < 0 || policy.precedence > 10_000) {
    throw new RoutingConfigurationError('Invalid policy.precedence');
  }
  validatePredicate(policy.when);
  validateEligibility(policy.eligibility);
  validateRanking(policy.ranking);
  assertEnum(policy.terminal, TERMINAL_DECISIONS, 'terminal');
  const frozenArray = <T>(value: readonly T[] | undefined): readonly T[] | undefined =>
    value === undefined ? undefined : Object.freeze([...value]);
  const when = Object.freeze({
    ...policy.when,
    capabilities: frozenArray(policy.when.capabilities),
    requestTypes: frozenArray(policy.when.requestTypes),
    intentTypes: frozenArray(policy.when.intentTypes),
    semanticRisks: frozenArray(policy.when.semanticRisks),
    latencyClasses: frozenArray(policy.when.latencyClasses),
    toolUseRequirements: frozenArray(policy.when.toolUseRequirements),
    authorityRequirements: frozenArray(policy.when.authorityRequirements),
    continuityRequirements: frozenArray(policy.when.continuityRequirements),
    outputSizes: frozenArray(policy.when.outputSizes),
    validationProfiles: frozenArray(policy.when.validationProfiles),
  });
  const eligibility = Object.freeze({
    ...policy.eligibility,
    requiredRoutingClasses: frozenArray(policy.eligibility.requiredRoutingClasses),
    excludedRoutingClasses: frozenArray(policy.eligibility.excludedRoutingClasses),
  });
  return Object.freeze({
    ...policy,
    when,
    eligibility,
    ranking: Object.freeze(
      policy.ranking.map((rule) =>
        Object.freeze({
          ...rule,
          ...(rule.routingClassPreference
            ? { routingClassPreference: Object.freeze([...rule.routingClassPreference]) }
            : {}),
        }),
      ),
    ),
  });
}

function canonicalPolicy(policy: RoutingPolicy): unknown {
  const sorted = <T extends string>(value: readonly T[] | undefined): readonly T[] | null =>
    value ? [...value].sort() : null;
  return {
    policyId: policy.policyId,
    version: policy.version,
    precedence: policy.precedence,
    when: {
      capabilities: sorted(policy.when.capabilities),
      requestTypes: sorted(policy.when.requestTypes),
      intentTypes: sorted(policy.when.intentTypes),
      semanticRisks: sorted(policy.when.semanticRisks),
      latencyClasses: sorted(policy.when.latencyClasses),
      toolUseRequirements: sorted(policy.when.toolUseRequirements),
      authorityRequirements: sorted(policy.when.authorityRequirements),
      continuityRequirements: sorted(policy.when.continuityRequirements),
      outputSizes: sorted(policy.when.outputSizes),
      validationProfiles: sorted(policy.when.validationProfiles),
    },
    eligibility: {
      requiredRoutingClasses: sorted(policy.eligibility.requiredRoutingClasses),
      excludedRoutingClasses: sorted(policy.eligibility.excludedRoutingClasses),
      minimumSemanticReliability: policy.eligibility.minimumSemanticReliability ?? null,
      minimumAuthorityReliability: policy.eligibility.minimumAuthorityReliability ?? null,
      minimumContinuityReliability: policy.eligibility.minimumContinuityReliability ?? null,
      requiresToolUse: policy.eligibility.requiresToolUse ?? null,
      requiresStructuredOutput: policy.eligibility.requiresStructuredOutput ?? null,
      minimumContextCapacity: policy.eligibility.minimumContextCapacity ?? null,
      executionLocality: policy.eligibility.executionLocality ?? null,
    },
    ranking: policy.ranking.map((rule) => ({
      dimension: rule.dimension,
      direction: rule.direction,
      routingClassPreference: rule.routingClassPreference ? [...rule.routingClassPreference] : null,
    })),
    terminal: policy.terminal,
  };
}

function matches<T>(allowed: readonly T[] | undefined, actual: T): boolean {
  return allowed === undefined || allowed.includes(actual);
}

function matchesPredicate(predicate: RoutingPredicate, context: RoutingContext): boolean {
  return (
    matches(predicate.capabilities, context.capability) &&
    matches(predicate.requestTypes, context.requestType) &&
    matches(predicate.intentTypes, context.intentType) &&
    matches(predicate.semanticRisks, context.semanticRisk) &&
    matches(predicate.latencyClasses, context.latencyClass) &&
    matches(predicate.toolUseRequirements, context.toolUseRequirement) &&
    matches(predicate.authorityRequirements, context.authorityRequirement) &&
    matches(predicate.continuityRequirements, context.continuityRequirement) &&
    matches(predicate.outputSizes, context.expectedOutputSize) &&
    matches(predicate.validationProfiles, context.validationProfile)
  );
}

function atLeast(actual: ReliabilityTier, minimum: ReliabilityTier | undefined): boolean {
  return minimum === undefined || RELIABILITY_ORDER[actual] >= RELIABILITY_ORDER[minimum];
}

function eligible(descriptor: ProviderDescriptor, context: RoutingContext, rule: EligibilityRule): boolean {
  const capabilities = descriptor.capabilities;
  if (!descriptor.enabled || !capabilities.supportedCapabilities.includes(context.capability)) return false;
  if (context.toolUseRequirement === Requirement.REQUIRED && capabilities.toolUse !== SupportLevel.SUPPORTED) {
    return false;
  }
  if (rule.requiresToolUse === true && capabilities.toolUse !== SupportLevel.SUPPORTED) return false;
  if (rule.requiresStructuredOutput === true && capabilities.structuredOutput !== SupportLevel.SUPPORTED) {
    return false;
  }
  if (rule.executionLocality !== undefined && capabilities.executionLocality !== rule.executionLocality) {
    return false;
  }
  if (
    rule.minimumContextCapacity !== undefined &&
    CONTEXT_ORDER[capabilities.contextCapacity] < CONTEXT_ORDER[rule.minimumContextCapacity]
  ) {
    return false;
  }
  if (!atLeast(capabilities.semanticReliability, rule.minimumSemanticReliability)) return false;
  if (!atLeast(capabilities.authorityReliability, rule.minimumAuthorityReliability)) return false;
  if (!atLeast(capabilities.continuityReliability, rule.minimumContinuityReliability)) return false;
  const classes = capabilities.routingClasses;
  if (rule.requiredRoutingClasses && !rule.requiredRoutingClasses.some((value) => classes.includes(value))) {
    return false;
  }
  if (rule.excludedRoutingClasses?.some((value) => classes.includes(value))) return false;
  return true;
}

function compareNumber(a: number, b: number, direction: SortDirection): number {
  return direction === SortDirection.ASCENDING ? a - b : b - a;
}

function classRank(descriptor: ProviderDescriptor, preference: readonly RoutingClass[]): number {
  const indexes = descriptor.capabilities.routingClasses.map((value) => preference.indexOf(value));
  const eligibleIndexes = indexes.filter((index) => index >= 0);
  return eligibleIndexes.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...eligibleIndexes);
}

function compareByRule(a: ProviderDescriptor, b: ProviderDescriptor, rule: RankingRule): number {
  switch (rule.dimension) {
    case RankingDimension.ROUTING_CLASS:
      return compareNumber(
        classRank(a, rule.routingClassPreference ?? []),
        classRank(b, rule.routingClassPreference ?? []),
        rule.direction,
      );
    case RankingDimension.SEMANTIC_RELIABILITY:
      return compareNumber(
        RELIABILITY_ORDER[a.capabilities.semanticReliability],
        RELIABILITY_ORDER[b.capabilities.semanticReliability],
        rule.direction,
      );
    case RankingDimension.AUTHORITY_RELIABILITY:
      return compareNumber(
        RELIABILITY_ORDER[a.capabilities.authorityReliability],
        RELIABILITY_ORDER[b.capabilities.authorityReliability],
        rule.direction,
      );
    case RankingDimension.CONTINUITY_RELIABILITY:
      return compareNumber(
        RELIABILITY_ORDER[a.capabilities.continuityReliability],
        RELIABILITY_ORDER[b.capabilities.continuityReliability],
        rule.direction,
      );
    case RankingDimension.LATENCY_TIER:
      return compareNumber(
        LATENCY_ORDER[a.operationalProfile.latencyTier],
        LATENCY_ORDER[b.operationalProfile.latencyTier],
        rule.direction,
      );
    case RankingDimension.COST_TIER:
      return compareNumber(
        COST_ORDER[a.operationalProfile.costTier],
        COST_ORDER[b.operationalProfile.costTier],
        rule.direction,
      );
  }
}

function validateContext(context: RoutingContext): void {
  assertEnum(context.capability, CAPABILITIES, 'context.capability');
  assertEnum(context.intentType, INTENT_TYPES, 'context.intentType');
  assertEnum(context.requestType, REQUEST_TYPES, 'context.requestType');
  assertEnum(context.semanticRisk, SEMANTIC_RISKS, 'context.semanticRisk');
  assertEnum(context.latencyClass, LATENCY_CLASSES, 'context.latencyClass');
  assertEnum(context.toolUseRequirement, REQUIREMENTS, 'context.toolUseRequirement');
  assertEnum(context.authorityRequirement, AUTHORITY_REQUIREMENTS, 'context.authorityRequirement');
  assertEnum(context.continuityRequirement, REQUIREMENTS, 'context.continuityRequirement');
  assertEnum(context.expectedOutputSize, OUTPUT_SIZES, 'context.expectedOutputSize');
  if (!isRoutingIdentifier(context.validationProfile)) {
    throw new RoutingConfigurationError('Invalid validationProfile');
  }
}

export class RoutingPolicyEngine {
  private readonly policies: readonly RoutingPolicy[];
  readonly policyVersion: string;
  readonly policyDigest: string;

  constructor(configuration: RoutingPolicyConfiguration) {
    assertVersion(configuration.version, 'policyConfiguration.version');
    if (configuration.policies.length === 0) {
      throw new RoutingConfigurationError('Routing policy configuration must not be empty');
    }
    const ids = new Set<string>();
    const policies = configuration.policies.map((policy) => {
      if (!isRoutingIdentifier(policy.policyId)) throw new RoutingConfigurationError('Invalid policyId');
      if (ids.has(policy.policyId)) throw new RoutingConfigurationError(`Duplicate policyId: ${policy.policyId}`);
      ids.add(policy.policyId);
      return freezePolicy(policy);
    });
    policies.sort((a, b) => b.precedence - a.precedence || a.policyId.localeCompare(b.policyId));
    this.policyVersion = configuration.version;
    this.policies = Object.freeze(policies);
    this.policyDigest = sha256Canonical({
      version: configuration.version,
      policies: [...policies].sort((a, b) => a.policyId.localeCompare(b.policyId)).map(canonicalPolicy),
    });
    Object.freeze(this);
  }

  select(context: RoutingContext, registry: ProviderRegistrySnapshot): ProviderSelectionDecision {
    validateContext(context);
    const configurationDigest = this.compositeConfigurationDigest(registry);
    const policy = this.policies.find((candidate) => matchesPredicate(candidate.when, context));
    if (!policy) {
      return this.decision(null, [], null, RoutingReasonCode.POLICY_NOT_MATCHED, registry, configurationDigest);
    }

    const candidates = registry.providers
      .filter((entry) => entry.availability === ProviderAvailability.AVAILABLE)
      .map((entry) => entry.descriptor)
      .filter((descriptor) => eligible(descriptor, context, policy.eligibility));

    candidates.sort((a, b) => {
      for (const rule of policy.ranking) {
        const compared = compareByRule(a, b, rule);
        if (compared !== 0) return compared;
      }
      return a.providerId.localeCompare(b.providerId);
    });
    const eligibleProviderIds = candidates.map((candidate) => candidate.providerId);
    if (eligibleProviderIds.length === 0) {
      return this.decision(
        null,
        [],
        policy.policyId,
        RoutingReasonCode.NO_ELIGIBLE_PROVIDER,
        registry,
        configurationDigest,
      );
    }
    return this.decision(
      eligibleProviderIds[0] as ProviderId,
      eligibleProviderIds,
      policy.policyId,
      RoutingReasonCode.SELECTED,
      registry,
      configurationDigest,
    );
  }

  /**
   * Read-only STATIC eligibility projection for a routing context. It evaluates the SAME policy predicate
   * and the SAME `eligible(...)` static rules as `select`, but over ALL configured descriptors regardless
   * of dynamic availability — the availability field is NEVER read here. It does not rank/select, build an
   * ExecutionPlan, invoke a Provider, or mutate anything. The `configurationDigest` is the identical
   * composite (registry + policy) identity `select` returns, so an admission bound to this digest is bound
   * to the exact selection configuration.
   */
  staticEligibility(context: RoutingContext, registry: ProviderRegistrySnapshot): StaticEligibilityProjection {
    validateContext(context);
    const configurationDigest = this.compositeConfigurationDigest(registry);
    const base = {
      policyVersion: this.policyVersion,
      registryVersion: registry.version,
      registryConfigurationDigest: registry.configurationDigest,
      policyConfigurationDigest: this.policyDigest,
      configurationDigest,
    } as const;
    const policy = this.policies.find((candidate) => matchesPredicate(candidate.when, context));
    if (!policy) {
      return Object.freeze({
        policyMatched: false,
        matchedPolicyId: null,
        eligibleProviderIds: Object.freeze([]),
        eligibleNetworkProviderIds: Object.freeze([]),
        eligibleLocalProviderIds: Object.freeze([]),
        ...base,
      });
    }
    // Evaluate static eligibility over ALL descriptors — availability is intentionally never consulted.
    const eligibleDescriptors = registry.providers
      .map((entry) => entry.descriptor)
      .filter((descriptor) => eligible(descriptor, context, policy.eligibility))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
    const idsFor = (locality: ExecutionLocality): readonly ProviderId[] =>
      Object.freeze(
        eligibleDescriptors
          .filter((descriptor) => descriptor.capabilities.executionLocality === locality)
          .map((descriptor) => descriptor.providerId),
      );
    return Object.freeze({
      policyMatched: true,
      matchedPolicyId: policy.policyId,
      eligibleProviderIds: Object.freeze(eligibleDescriptors.map((descriptor) => descriptor.providerId)),
      eligibleNetworkProviderIds: idsFor(ExecutionLocality.NETWORK),
      eligibleLocalProviderIds: idsFor(ExecutionLocality.LOCAL),
      ...base,
    });
  }

  private compositeConfigurationDigest(registry: ProviderRegistrySnapshot): string {
    return sha256Canonical({
      registryDigest: registry.configurationDigest,
      policyDigest: this.policyDigest,
    });
  }

  private decision(
    selectedProviderId: ProviderId | null,
    eligibleProviderIds: readonly ProviderId[],
    matchedPolicyId: PolicyId | null,
    reasonCode: RoutingReasonCode,
    registry: ProviderRegistrySnapshot,
    configurationDigest: string,
  ): ProviderSelectionDecision {
    return Object.freeze({
      selectedProviderId,
      eligibleProviderIds: Object.freeze([...eligibleProviderIds]),
      matchedPolicyId,
      reasonCode,
      policyVersion: this.policyVersion,
      registryVersion: registry.version,
      registryConfigurationDigest: registry.configurationDigest,
      policyConfigurationDigest: this.policyDigest,
      configurationDigest,
    });
  }
}
