import type { Capability, IntentType } from '../domain';

declare const providerIdBrand: unique symbol;
declare const adapterIdBrand: unique symbol;
declare const policyIdBrand: unique symbol;
declare const validationProfileIdBrand: unique symbol;

export type ProviderId = string & { readonly [providerIdBrand]: true };
export type AdapterId = string & { readonly [adapterIdBrand]: true };
export type PolicyId = string & { readonly [policyIdBrand]: true };
export type ValidationProfileId = string & { readonly [validationProfileIdBrand]: true };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const isRoutingIdentifier = (value: string): boolean => IDENTIFIER.test(value);

function brandedIdentifier<T extends string>(value: string, label: string): T {
  if (!isRoutingIdentifier(value)) throw new RoutingConfigurationError(`Invalid ${label}`);
  return value as T;
}

export const providerId = (value: string): ProviderId => brandedIdentifier(value, 'providerId');
export const adapterId = (value: string): AdapterId => brandedIdentifier(value, 'adapterId');
export const policyId = (value: string): PolicyId => brandedIdentifier(value, 'policyId');
export const validationProfileId = (value: string): ValidationProfileId =>
  brandedIdentifier(value, 'validationProfileId');

export enum RoutingRequestType {
  CONVERSATIONAL = 'CONVERSATIONAL',
  WORK = 'WORK',
  CODE_GENERATION = 'CODE_GENERATION',
  UNKNOWN = 'UNKNOWN',
}

export enum SemanticRisk {
  LOW = 'LOW',
  STANDARD = 'STANDARD',
  HIGH = 'HIGH',
  UNKNOWN = 'UNKNOWN',
}

export enum LatencyClass {
  INTERACTIVE = 'INTERACTIVE',
  BALANCED = 'BALANCED',
  BATCH = 'BATCH',
  UNKNOWN = 'UNKNOWN',
}

export enum Requirement {
  REQUIRED = 'REQUIRED',
  NOT_REQUIRED = 'NOT_REQUIRED',
  UNKNOWN = 'UNKNOWN',
}

export enum AuthorityRequirement {
  REQUIRED = 'REQUIRED',
  NOT_REQUIRED = 'NOT_REQUIRED',
  UNKNOWN = 'UNKNOWN',
}

export enum OutputSizeClass {
  SMALL = 'SMALL',
  MEDIUM = 'MEDIUM',
  LARGE = 'LARGE',
  UNKNOWN = 'UNKNOWN',
}

export enum ReliabilityTier {
  UNPROVEN = 'UNPROVEN',
  LOW = 'LOW',
  STANDARD = 'STANDARD',
  HIGH = 'HIGH',
}

export enum SupportLevel {
  UNSUPPORTED = 'UNSUPPORTED',
  SUPPORTED = 'SUPPORTED',
}

export enum ContextCapacity {
  SMALL = 'SMALL',
  MEDIUM = 'MEDIUM',
  LARGE = 'LARGE',
}

export enum ExecutionLocality {
  LOCAL = 'LOCAL',
  NETWORK = 'NETWORK',
}

export enum RoutingClass {
  BALANCED = 'BALANCED',
  SEMANTIC_HIGH = 'SEMANTIC_HIGH',
  LATENCY_RESTRICTED = 'LATENCY_RESTRICTED',
  DEPRIORITIZED = 'DEPRIORITIZED',
}

export enum LatencyTier {
  FAST = 'FAST',
  BALANCED = 'BALANCED',
  SLOW = 'SLOW',
  UNKNOWN = 'UNKNOWN',
}

export enum TimeoutClass {
  SHORT = 'SHORT',
  STANDARD = 'STANDARD',
  LONG = 'LONG',
}

export enum CostTier {
  LOW = 'LOW',
  STANDARD = 'STANDARD',
  HIGH = 'HIGH',
  UNKNOWN = 'UNKNOWN',
}

export enum ConcurrencyClass {
  SINGLE = 'SINGLE',
  LIMITED = 'LIMITED',
  SCALABLE = 'SCALABLE',
  UNKNOWN = 'UNKNOWN',
}

export enum AvailabilityClass {
  LOCAL_STABLE = 'LOCAL_STABLE',
  LOCAL_OPTIONAL = 'LOCAL_OPTIONAL',
  NETWORK_DEPENDENT = 'NETWORK_DEPENDENT',
  UNKNOWN = 'UNKNOWN',
}

export enum ProviderAvailability {
  AVAILABLE = 'AVAILABLE',
  UNAVAILABLE = 'UNAVAILABLE',
  UNKNOWN = 'UNKNOWN',
}

export enum RankingDimension {
  ROUTING_CLASS = 'ROUTING_CLASS',
  SEMANTIC_RELIABILITY = 'SEMANTIC_RELIABILITY',
  AUTHORITY_RELIABILITY = 'AUTHORITY_RELIABILITY',
  CONTINUITY_RELIABILITY = 'CONTINUITY_RELIABILITY',
  LATENCY_TIER = 'LATENCY_TIER',
  COST_TIER = 'COST_TIER',
}

export enum SortDirection {
  ASCENDING = 'ASCENDING',
  DESCENDING = 'DESCENDING',
}

export enum TerminalDecision {
  NO_SELECTION = 'NO_SELECTION',
}

export enum RoutingReasonCode {
  SELECTED = 'SELECTED',
  POLICY_NOT_MATCHED = 'POLICY_NOT_MATCHED',
  NO_ELIGIBLE_PROVIDER = 'NO_ELIGIBLE_PROVIDER',
}

export interface RoutingContext {
  capability: Capability;
  requestType: RoutingRequestType;
  intentType: IntentType;
  semanticRisk: SemanticRisk;
  latencyClass: LatencyClass;
  toolUseRequirement: Requirement;
  authorityRequirement: AuthorityRequirement;
  continuityRequirement: Requirement;
  expectedOutputSize: OutputSizeClass;
  validationProfile: ValidationProfileId;
}

export interface ProviderCapabilities {
  supportedCapabilities: readonly Capability[];
  routingClasses: readonly RoutingClass[];
  semanticReliability: ReliabilityTier;
  authorityReliability: ReliabilityTier;
  continuityReliability: ReliabilityTier;
  toolUse: SupportLevel;
  structuredOutput: SupportLevel;
  contextCapacity: ContextCapacity;
  streaming: SupportLevel;
  executionLocality: ExecutionLocality;
}

export interface ProviderOperationalProfile {
  latencyTier: LatencyTier;
  timeoutClass: TimeoutClass;
  costTier: CostTier;
  concurrencyClass: ConcurrencyClass;
  availabilityClass: AvailabilityClass;
}

export interface ProviderDescriptor {
  providerId: ProviderId;
  adapterId: AdapterId;
  /** Opaque audit/configuration value. Policy logic must never interpret it. */
  modelId: string;
  capabilities: ProviderCapabilities;
  operationalProfile: ProviderOperationalProfile;
  enabled: boolean;
  profileVersion: string;
  evidenceBindingDigest?: string;
}

/** The redundant id is deliberate: registry construction validates binding identity. */
export interface ProviderRegistration {
  providerId: ProviderId;
  descriptor: ProviderDescriptor;
}

export interface RegisteredProviderSnapshot {
  descriptor: ProviderDescriptor;
  availability: ProviderAvailability;
}

export interface ProviderRegistrySnapshot {
  version: string;
  configurationDigest: string;
  providers: readonly RegisteredProviderSnapshot[];
}

export interface RoutingPredicate {
  capabilities?: readonly Capability[];
  requestTypes?: readonly RoutingRequestType[];
  intentTypes?: readonly IntentType[];
  semanticRisks?: readonly SemanticRisk[];
  latencyClasses?: readonly LatencyClass[];
  toolUseRequirements?: readonly Requirement[];
  authorityRequirements?: readonly AuthorityRequirement[];
  continuityRequirements?: readonly Requirement[];
  outputSizes?: readonly OutputSizeClass[];
  validationProfiles?: readonly ValidationProfileId[];
}

export interface EligibilityRule {
  requiredRoutingClasses?: readonly RoutingClass[];
  excludedRoutingClasses?: readonly RoutingClass[];
  minimumSemanticReliability?: ReliabilityTier;
  minimumAuthorityReliability?: ReliabilityTier;
  minimumContinuityReliability?: ReliabilityTier;
  requiresToolUse?: boolean;
  requiresStructuredOutput?: boolean;
  minimumContextCapacity?: ContextCapacity;
  executionLocality?: ExecutionLocality;
}

export interface RankingRule {
  dimension: RankingDimension;
  direction: SortDirection;
  /** Required only for ROUTING_CLASS; first entry is most preferred. */
  routingClassPreference?: readonly RoutingClass[];
}

export interface RoutingPolicy {
  policyId: PolicyId;
  version: string;
  precedence: number;
  when: RoutingPredicate;
  eligibility: EligibilityRule;
  ranking: readonly RankingRule[];
  terminal: TerminalDecision;
}

export interface RoutingPolicyConfiguration {
  version: string;
  policies: readonly RoutingPolicy[];
}

export interface ProviderSelectionDecision {
  selectedProviderId: ProviderId | null;
  eligibleProviderIds: readonly ProviderId[];
  matchedPolicyId: PolicyId | null;
  reasonCode: RoutingReasonCode;
  policyVersion: string;
  registryVersion: string;
  registryConfigurationDigest: string;
  policyConfigurationDigest: string;
  configurationDigest: string;
}

/**
 * Read-only STATIC eligibility projection: which configured Providers are eligible for a routing context
 * under the matched policy, evaluated from CANONICAL STATIC FACTS ONLY (registry configuration + policy
 * eligibility rules + the `enabled` flag). It DELIBERATELY ignores dynamic availability: no
 * `ProviderAvailability`, no availability snapshot, no `isAvailable()`, no `availabilityClass` outage
 * interpretation. It does not rank, select, build an ExecutionPlan, invoke a Provider, or mutate the
 * registry. `configurationDigest` is the SAME composite (registry + policy) identity used by `select`.
 */
export interface StaticEligibilityProjection {
  /** Whether a policy matched the context at all. */
  readonly policyMatched: boolean;
  readonly matchedPolicyId: PolicyId | null;
  /** All statically eligible providers (any locality), unranked, sorted by id. */
  readonly eligibleProviderIds: readonly ProviderId[];
  /** Statically eligible NETWORK-locality (cloud) providers, unranked, sorted by id. */
  readonly eligibleNetworkProviderIds: readonly ProviderId[];
  /** Statically eligible LOCAL-locality providers, unranked, sorted by id. */
  readonly eligibleLocalProviderIds: readonly ProviderId[];
  readonly policyVersion: string;
  readonly registryVersion: string;
  readonly registryConfigurationDigest: string;
  readonly policyConfigurationDigest: string;
  /** Composite (registry + policy) configuration identity — identical to `select`'s digest. */
  readonly configurationDigest: string;
}

export class RoutingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingConfigurationError';
  }
}
