import { Capability } from '../domain';
import {
  ProviderAvailability,
  ProviderRegistrySnapshot,
  ReliabilityTier,
  ContextCapacity,
  SupportLevel,
  ExecutionLocality,
  RoutingContext,
  RoutingReasonCode,
  RoutingConfigurationError,
  type ProviderDescriptor,
  type ProviderId,
} from './provider-routing-contracts';
import { RoutingPolicyEngine } from './routing-policy-engine';
import type { ProviderRegistry } from './provider-registry';
import {
  assertExactSoleProviderSelection,
  type SoleProviderSelection,
  type StaticEligibilityDecision,
} from './continuation-prepared-containment';

/**
 * R3-C1 — Local Continuity Eligibility & Static Trusted Admission Contract.
 *
 * A PURE, runtime-INDEPENDENT admission decision. It answers exactly one question: is a request eligible
 * for a FUTURE contained local-continuity invocation? It NEVER prepares containment, issues a production
 * capability, starts a runtime, loads a model, runs Ollama, executes a Provider, or performs any network
 * action. Admission is not runtime preparation, not production trust, and not execution authorization.
 *
 * Ownership boundaries (ADR-0090 R3-C1 amendment):
 *  - Workload local-fallback policy is a deterministic, immutable, versioned policy owner (this module),
 *    not hard-coded in adapter code. Coding/architecture/document-comparison workloads are
 *    local-fallback-ineligible by default.
 *  - Kind A (DERIVED STATIC OPERATIONAL UNAVAILABILITY) is derived INTERNALLY from the canonical provider
 *    registry/configuration. It is NEVER a caller-supplied evidence object, and it NEVER uses the
 *    availability snapshot, `isAvailable()`, `availabilityClass`, or a quality-floor exclusion.
 *  - Kind B (TRUSTED_CURRENT_UNAVAILABILITY) has no trusted issuer in R3-C1 → ALWAYS DENY (fail closed).
 *  - Kind C (PRIOR_ATTEMPT_FAILURE) is UNSUPPORTED in R3-C1 → ALWAYS DENY (belongs to R3-C-Rz).
 *  - Static provider eligibility, capability floors, quality floors, ranking, and exact selection remain
 *    Stage2B responsibility (RoutingPolicyEngine + ProviderRegistry). This module adds an admission
 *    decision BEFORE local selection and hands off through the R3-B1 `assertExactSoleProviderSelection`
 *    boundary; it does not duplicate the registry, the ranking engine, or any retry orchestrator.
 *  - The admission is bound to the SAME immutable configuration identity used for selection
 *    (`ProviderRegistry.configurationDigest`); a config change between derivation and selection denies.
 *
 * Attempt accounting: an admitted local invocation is exactly attempt 1 with zero additional provider
 * hops. There is no cloud attempt before it and no provider switch after it. The global constants
 * MAX_PROVIDER_ATTEMPTS=2 / MAX_ADDITIONAL_PROVIDER_HOPS=1 are unchanged and remain a separate Stage2B
 * concern; this module introduces no nested retry accounting.
 *
 * DENY semantics: DENY means LOCAL CONTINUITY NOT ADMITTED. It does NOT mean the whole request is
 * stopped. Whether the surrounding orchestration STOPs/DEFERs is decided elsewhere by existing ADR-0090
 * policy only when no normal eligible execution path exists.
 */

export const LOCAL_CONTINUITY_ADMISSION_SCHEMA = 'local-continuity-admission-v1' as const;
export const LOCAL_CONTINUITY_WORKLOAD_POLICY_VERSION = 'r3c1-workload-local-fallback-v1' as const;

/** R3-C1 fixed attempt accounting for an admitted local-continuity invocation. */
export const R3C1_ATTEMPT_NUMBER = 1 as const;
export const R3C1_ADDITIONAL_PROVIDER_HOPS = 0 as const;

/**
 * Bounded, typed denial reasons. These are NOT `RoutingFailureCode` values and are deliberately distinct
 * from the Stage2B failure taxonomy: R3-C1 adds no new `RoutingFailureCode`. Each reason names why LOCAL
 * CONTINUITY was not admitted; none of them asserts that the entire request is stopped.
 */
export type LocalContinuityDenialReason =
  | 'WORKLOAD_LOCAL_FALLBACK_DISALLOWED'
  | 'NO_DERIVED_STATIC_UNAVAILABILITY'
  | 'CALLER_SUPPLIED_EVIDENCE_REJECTED'
  | 'DYNAMIC_EVIDENCE_UNSUPPORTED'
  | 'PRIOR_ATTEMPT_FAILURE_UNSUPPORTED'
  | 'LOCAL_PROVIDER_NOT_CONFIGURED'
  | 'LOCAL_PROVIDER_MISSING_CAPABILITY'
  | 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR'
  | 'LOCAL_SELECTION_NOT_SOLE'
  | 'PROVIDER_IDENTITY_MISMATCH'
  | 'ROUTING_CONTEXT_MISMATCH'
  | 'CONFIGURATION_IDENTITY_MISMATCH'
  | 'MALFORMED_INPUT';

/**
 * The kinds enumerated by the ADR-0090 evidence contract SHAPE. Only Kind A is derivable and admissible
 * in R3-C1. Kinds B and C exist for future compatibility but have NO caller-accessible admitting path.
 */
export const LOCAL_CONTINUITY_EVIDENCE_KINDS = [
  'STATIC_INELIGIBILITY',
  'TRUSTED_CURRENT_UNAVAILABILITY',
  'PRIOR_ATTEMPT_FAILURE',
] as const;
export type LocalContinuityEvidenceKind = typeof LOCAL_CONTINUITY_EVIDENCE_KINDS[number];

/**
 * The CLOSED set of canonical static operational-unavailability facts R3-C1 may derive. This set is
 * fixed by architecture; new members require Architecture Review, not convenience. Each fact is about the
 * NORMAL (cloud) provider that would otherwise serve the request, established from canonical config only.
 *  - A1 PROVIDER_NOT_CONFIGURED — the required cloud provider id is absent from the canonical registry.
 *  - A2 PROVIDER_ADMINISTRATIVELY_DISABLED — the descriptor exists but `enabled === false` in config.
 *  - A3 REQUIRED_PROVIDER_CONFIGURATION_ABSENT — a required cloud provider id declared by policy input is
 *    not present in the canonical registry (a required-configuration gap; distinct from A1 which is about
 *    the specific normal provider). A1/A3 may coincide; the derivation records each satisfied member.
 */
export const KIND_A_STATIC_FACTS = [
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_ADMINISTRATIVELY_DISABLED',
  'REQUIRED_PROVIDER_CONFIGURATION_ABSENT',
] as const;
export type KindAStaticFact = typeof KIND_A_STATIC_FACTS[number];

/**
 * The DEFAULT workload local-fallback policy, keyed on the existing domain `Capability`. This is the
 * deterministic, immutable, versioned policy owner. `true` = a workload that MAY be considered for local
 * continuity (subject to every other gate); `false` = local-fallback-ineligible by default. Coding,
 * architecture, and document-analysis (document comparison) workloads are ineligible per ADR-0090 §4.
 * A workspace/workload override may only STRENGTHEN this (never enable local coding); such overrides are
 * out of R3-C1 scope and not implemented here.
 */
const DEFAULT_LOCAL_FALLBACK_BY_CAPABILITY: Readonly<Record<Capability, boolean>> = Object.freeze({
  [Capability.GENERAL_CHAT]: true,
  [Capability.SUMMARIZATION]: true,
  [Capability.READONLY_LOOKUP]: true,
  [Capability.PROJECT_ANALYSIS]: true,
  // Disallowed by default (ADR-0090 §4): coding/review/architecture and document comparison.
  [Capability.CODE_IMPLEMENTATION]: false,
  [Capability.CODE_REVIEW]: false,
  [Capability.ARCHITECTURE_PLANNING]: false,
  [Capability.DOCUMENT_ANALYSIS]: false,
  [Capability.TEST_EXECUTION]: false,
  [Capability.EMBEDDING]: false,
});

/**
 * Deterministic workload local-fallback policy owner. Pure, immutable, versioned. It does NOT depend on
 * any classifier engine, Ollaya, or provider; the existing deterministic capability derivation supplies
 * the `Capability`.
 */
export class WorkloadLocalFallbackPolicy {
  readonly version = LOCAL_CONTINUITY_WORKLOAD_POLICY_VERSION;

  /** Deterministic: is this workload local-fallback-eligible by ratified default policy? */
  localFallbackAllowed(capability: Capability): boolean {
    return DEFAULT_LOCAL_FALLBACK_BY_CAPABILITY[capability] === true;
  }
}

/**
 * Immutable required capability floor the LOCAL provider must INDEPENDENTLY satisfy. This mirrors the
 * Stage2B eligibility inputs the normal path would enforce; it is expressed as an `EligibilityRule`-shaped
 * minimum, reused through `RoutingPolicyEngine`. R3-C1 never lowers a floor to obtain fallback.
 */
export interface LocalContinuityQualityFloor {
  readonly minimumSemanticReliability?: ReliabilityTier;
  readonly minimumAuthorityReliability?: ReliabilityTier;
  readonly minimumContinuityReliability?: ReliabilityTier;
  readonly minimumContextCapacity?: ContextCapacity;
  readonly requiresToolUse?: boolean;
  readonly requiresStructuredOutput?: boolean;
}

/**
 * R3-C1 admission input. All fields are bounded application facts. Crucially there is NO caller-supplied
 * "evidence object": static unavailability is DERIVED internally (see `deriveKindAStaticFacts`).
 */
export interface LocalContinuityAdmissionInput {
  /** The workload capability, from existing deterministic derivation. */
  readonly capability: Capability;
  /** The canonical routing context used for the normal path (drives Stage2B selection + validation). */
  readonly routingContext: RoutingContext;
  /** Required capabilities the LOCAL provider must independently support (must include `capability`). */
  readonly requiredCapabilities: readonly Capability[];
  /** Quality floor the LOCAL provider must independently satisfy. */
  readonly qualityFloor: LocalContinuityQualityFloor;
  /**
   * The NORMAL (cloud) provider id that would otherwise serve this request. Kind A is derived about this
   * provider from canonical config. Optional: when the normal provider id is not even declared, A1/A3 are
   * evaluated from `requiredCloudProviderIds`.
   */
  readonly normalCloudProviderId?: ProviderId;
  /** Cloud provider ids that policy input requires to be configured for the normal path (for A3). */
  readonly requiredCloudProviderIds?: readonly ProviderId[];
  /** The candidate LOCAL provider id (execution locality LOCAL) to consider for continuity. */
  readonly localProviderId: ProviderId;
  /**
   * The immutable configuration identity under which Kind A was intended to be derived and under which
   * selection must occur. MUST equal the registry's `configurationDigest`; a mismatch denies.
   */
  readonly selectionConfigurationRef: string;
}

/** The derived static facts and the config identity they were derived under. */
export interface DerivedStaticOperationalFacts {
  readonly kind: 'STATIC_INELIGIBILITY';
  /** Non-empty when at least one closed Kind A fact holds about the normal cloud path. */
  readonly satisfiedFacts: readonly KindAStaticFact[];
  /** The registry configuration digest these facts were derived under. */
  readonly configurationRef: string;
}

/** Immutable, bounded admission decision. Admission != preparation != trust != execution authorization. */
export interface LocalContinuityAdmissionDecision {
  readonly schemaVersion: typeof LOCAL_CONTINUITY_ADMISSION_SCHEMA;
  readonly admitted: boolean;
  readonly denialReason?: LocalContinuityDenialReason;
  /** The sole selected local provider id, present only when admitted. */
  readonly providerCandidate?: ProviderId;
  /** The immutable configuration identity binding derivation and selection. */
  readonly configurationRef: string;
  /** Fixed R3-C1 attempt accounting. */
  readonly attemptNumber: typeof R3C1_ATTEMPT_NUMBER;
  readonly additionalProviderHops: typeof R3C1_ADDITIONAL_PROVIDER_HOPS;
}

function isPlainConfigRef(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function deny(configurationRef: string, denialReason: LocalContinuityDenialReason): LocalContinuityAdmissionDecision {
  return Object.freeze({
    schemaVersion: LOCAL_CONTINUITY_ADMISSION_SCHEMA,
    admitted: false,
    denialReason,
    configurationRef,
    attemptNumber: R3C1_ATTEMPT_NUMBER,
    additionalProviderHops: R3C1_ADDITIONAL_PROVIDER_HOPS,
  });
}

/**
 * Kind B is contract-defined but has NO trusted issuer in R3-C1. This function exists so the fail-closed
 * behavior is explicit and testable: EVERY caller input maps to DENY. There is no argument — no
 * `freshness=CURRENT` label, no `trusted` string, no availability snapshot, no `isAvailable()` result, no
 * persisted/rehydrated value — that can make it admit.
 */
export function admitTrustedCurrentUnavailability(): never {
  throw new LocalContinuityAdmissionError('DYNAMIC_EVIDENCE_UNSUPPORTED');
}

/**
 * Kind C is unsupported in R3-C1. A prior cloud attempt implies post-dispatch history and belongs
 * exclusively to R3-C-Rz. This function fails closed unconditionally; there is no admitting path.
 */
export function admitPriorAttemptFailure(): never {
  throw new LocalContinuityAdmissionError('PRIOR_ATTEMPT_FAILURE_UNSUPPORTED');
}

/** Bounded R3-C1 error carrying only a denial reason code — never host/runtime/provider detail. */
export class LocalContinuityAdmissionError extends Error {
  constructor(readonly reason: LocalContinuityDenialReason) {
    super(reason);
    this.name = 'LocalContinuityAdmissionError';
  }
}

/**
 * Derive the CLOSED set of Kind A static operational-unavailability facts INTERNALLY from the canonical
 * provider registry. This is the ONLY way Kind A can be produced in R3-C1: there is no caller-supplied
 * evidence object parameter. It never consults the availability snapshot, `availabilityClass`, or any
 * quality-floor exclusion — only canonical configuration presence and the administrative `enabled` flag.
 *
 * Returns `null` when NO closed static fact holds (i.e., the normal cloud path is not statically
 * unavailable by configuration), which denies local continuity.
 */
export function deriveKindAStaticFacts(
  registry: ProviderRegistry,
  input: {
    readonly normalCloudProviderId?: ProviderId;
    readonly requiredCloudProviderIds?: readonly ProviderId[];
    readonly selectionConfigurationRef: string;
  },
): DerivedStaticOperationalFacts | null {
  // Config identity binding: derive only under the exact configuration used for selection.
  if (!isPlainConfigRef(input.selectionConfigurationRef)) return null;
  if (registry.configurationDigest !== input.selectionConfigurationRef) return null;

  const facts: KindAStaticFact[] = [];

  // A1 / A2 — about the specific normal cloud provider, if one is named.
  if (input.normalCloudProviderId !== undefined) {
    const descriptor = registry.get(input.normalCloudProviderId);
    if (descriptor === undefined) {
      facts.push('PROVIDER_NOT_CONFIGURED');
    } else if (descriptor.enabled === false) {
      facts.push('PROVIDER_ADMINISTRATIVELY_DISABLED');
    }
  }

  // A3 — a required cloud provider declared by policy input is absent from canonical config.
  const required = input.requiredCloudProviderIds ?? [];
  const anyRequiredAbsent = required.some((id) => registry.get(id) === undefined);
  if (anyRequiredAbsent) {
    facts.push('REQUIRED_PROVIDER_CONFIGURATION_ABSENT');
  }

  if (facts.length === 0) return null;
  return Object.freeze({
    kind: 'STATIC_INELIGIBILITY',
    satisfiedFacts: Object.freeze([...new Set(facts)]),
    configurationRef: registry.configurationDigest,
  });
}

/**
 * The R3-C1 admission decision. Pure and runtime-independent. Composes: workload local-fallback policy →
 * derived Kind A static facts (internal, config-bound) → Stage2B static eligibility for the LOCAL
 * provider under the SAME quality floor → exact PRIMARY_ONLY sole selection handoff (R3-B1). It performs
 * ZERO containment/runtime preparation and creates ZERO production trust; on any failure it denies.
 *
 * The `soleSelection` output is produced ONLY on admission by minting a `SoleProviderSelection` through
 * the existing R3-B1 `assertExactSoleProviderSelection` boundary with a single eligible provider (the
 * local provider) — i.e., exactly one provider, one selection, one plan, one binding downstream.
 */
export class LocalContinuityAdmission {
  constructor(
    private readonly workloadPolicy: WorkloadLocalFallbackPolicy,
    private readonly routingEngine: RoutingPolicyEngine,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * Decide admission. Returns the decision plus (only when admitted) the non-forgeable
   * `SoleProviderSelection` handoff for the downstream R3-B1/containment slice.
   */
  admit(input: LocalContinuityAdmissionInput): {
    decision: LocalContinuityAdmissionDecision;
    soleSelection?: SoleProviderSelection;
  } {
    const configRef = typeof input.selectionConfigurationRef === 'string' ? input.selectionConfigurationRef : '';

    // 0. Structural input validation → MALFORMED_INPUT (fail closed).
    if (!isPlainConfigRef(configRef)) {
      return { decision: deny('', 'MALFORMED_INPUT') };
    }
    if (
      typeof input.localProviderId !== 'string' ||
      input.localProviderId.length === 0 ||
      !Array.isArray(input.requiredCapabilities) ||
      input.requiredCapabilities.length === 0 ||
      input.routingContext === null ||
      typeof input.routingContext !== 'object'
    ) {
      return { decision: deny(configRef, 'MALFORMED_INPUT') };
    }

    // 1. Config identity binding: admission is bound to the SAME immutable configuration as selection.
    if (this.registry.configurationDigest !== configRef) {
      return { decision: deny(configRef, 'CONFIGURATION_IDENTITY_MISMATCH') };
    }

    // 2. routingContext.capability must match the workload capability under decision.
    if (input.routingContext.capability !== input.capability) {
      return { decision: deny(configRef, 'ROUTING_CONTEXT_MISMATCH') };
    }
    // The required capability set must include the workload capability.
    if (!input.requiredCapabilities.includes(input.capability)) {
      return { decision: deny(configRef, 'LOCAL_PROVIDER_MISSING_CAPABILITY') };
    }

    // 3. Workload local-fallback policy: coding/architecture/document workloads deny immediately, with
    //    ZERO local provider selection and ZERO containment/runtime preparation.
    if (!this.workloadPolicy.localFallbackAllowed(input.capability)) {
      return { decision: deny(configRef, 'WORKLOAD_LOCAL_FALLBACK_DISALLOWED') };
    }

    // 4. Kind A derivation (internal, config-bound). No caller-supplied evidence object exists here; Kind
    //    B and Kind C have no admitting path (see admit* functions). If no closed static fact holds, deny.
    const staticFacts = deriveKindAStaticFacts(this.registry, {
      normalCloudProviderId: input.normalCloudProviderId,
      requiredCloudProviderIds: input.requiredCloudProviderIds,
      selectionConfigurationRef: configRef,
    });
    if (staticFacts === null) {
      return { decision: deny(configRef, 'NO_DERIVED_STATIC_UNAVAILABILITY') };
    }

    // 5. The LOCAL provider must be configured and be a LOCAL-locality provider.
    const localDescriptor = this.registry.get(input.localProviderId);
    if (localDescriptor === undefined) {
      return { decision: deny(configRef, 'LOCAL_PROVIDER_NOT_CONFIGURED') };
    }
    if (localDescriptor.capabilities.executionLocality !== ExecutionLocality.LOCAL) {
      return { decision: deny(configRef, 'LOCAL_PROVIDER_NOT_CONFIGURED') };
    }

    // 6. The LOCAL provider must INDEPENDENTLY satisfy the required capability + quality floor, reusing
    //    Stage2B eligibility semantics (no second ranking engine). We run the engine over a snapshot in
    //    which ONLY the local provider is marked AVAILABLE, and enforce a LOCAL-locality eligibility rule
    //    carrying the required quality floor. If the engine does not select exactly the local provider as
    //    the sole eligible candidate, deny.
    const capabilityOk = this.localProviderSatisfies(localDescriptor, input);
    if (!capabilityOk.ok) {
      return { decision: deny(configRef, capabilityOk.reason) };
    }

    // 7. Exact PRIMARY_ONLY sole selection handoff through the R3-B1 boundary. Exactly one eligible
    //    provider (the local one) and it is the selection. This mints a non-forgeable SoleProviderSelection
    //    but performs NO containment preparation, model load, or execution.
    const staticEligibility: StaticEligibilityDecision = {
      eligibleProviderIds: [input.localProviderId],
      selectedProviderId: input.localProviderId,
      primaryOnly: true,
    };
    let soleSelection: SoleProviderSelection;
    try {
      soleSelection = assertExactSoleProviderSelection(staticEligibility);
    } catch {
      return { decision: deny(configRef, 'LOCAL_SELECTION_NOT_SOLE') };
    }

    const decision: LocalContinuityAdmissionDecision = Object.freeze({
      schemaVersion: LOCAL_CONTINUITY_ADMISSION_SCHEMA,
      admitted: true,
      providerCandidate: input.localProviderId,
      configurationRef: configRef,
      attemptNumber: R3C1_ATTEMPT_NUMBER,
      additionalProviderHops: R3C1_ADDITIONAL_PROVIDER_HOPS,
    });
    return { decision, soleSelection };
  }

  /**
   * Reuse Stage2B eligibility (`RoutingPolicyEngine`) to confirm the LOCAL provider independently meets
   * the required capability + quality floor under the same configuration. We do this by building a
   * snapshot in which only the local provider is AVAILABLE and a routing context/policy that enforces the
   * caller's quality floor and LOCAL locality. This does NOT create a second registry or ranking engine —
   * it uses the injected engine and registry.
   */
  private localProviderSatisfies(
    localDescriptor: ProviderDescriptor,
    input: LocalContinuityAdmissionInput,
  ): { ok: true } | { ok: false; reason: LocalContinuityDenialReason } {
    // The local descriptor must support every required capability (independent capability check).
    for (const required of input.requiredCapabilities) {
      if (!localDescriptor.capabilities.supportedCapabilities.includes(required)) {
        return { ok: false, reason: 'LOCAL_PROVIDER_MISSING_CAPABILITY' };
      }
    }
    // Independent quality-floor check (same minima the normal path would enforce; never lowered).
    const floor = input.qualityFloor;
    const caps = localDescriptor.capabilities;
    if (!atLeastReliability(caps.semanticReliability, floor.minimumSemanticReliability)) {
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }
    if (!atLeastReliability(caps.authorityReliability, floor.minimumAuthorityReliability)) {
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }
    if (!atLeastReliability(caps.continuityReliability, floor.minimumContinuityReliability)) {
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }
    if (!atLeastContext(caps.contextCapacity, floor.minimumContextCapacity)) {
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }
    if (floor.requiresToolUse === true && caps.toolUse !== SupportLevel.SUPPORTED) {
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }
    if (floor.requiresStructuredOutput === true && caps.structuredOutput !== SupportLevel.SUPPORTED) {
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }

    // Confirm through the injected Stage2B engine that, with ONLY the local provider AVAILABLE, the local
    // provider is the sole selected candidate for this routing context. This reuses Stage2B ranking and
    // eligibility rather than reimplementing selection; it fabricates no cloud AVAILABLE snapshot.
    let selection;
    try {
      const snapshot: ProviderRegistrySnapshot = this.registry.snapshot({
        [input.localProviderId]: ProviderAvailability.AVAILABLE,
      });
      selection = this.routingEngine.select(input.routingContext, snapshot);
    } catch (error) {
      if (error instanceof RoutingConfigurationError) {
        return { ok: false, reason: 'ROUTING_CONTEXT_MISMATCH' };
      }
      throw error;
    }
    if (
      selection.reasonCode !== RoutingReasonCode.SELECTED ||
      selection.selectedProviderId !== input.localProviderId ||
      selection.eligibleProviderIds.length !== 1 ||
      selection.eligibleProviderIds[0] !== input.localProviderId
    ) {
      // Local provider is not the sole eligible candidate under Stage2B for this context/floor.
      return { ok: false, reason: 'LOCAL_PROVIDER_BELOW_QUALITY_FLOOR' };
    }
    return { ok: true };
  }
}

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

function atLeastReliability(actual: ReliabilityTier, minimum: ReliabilityTier | undefined): boolean {
  return minimum === undefined || RELIABILITY_ORDER[actual] >= RELIABILITY_ORDER[minimum];
}
function atLeastContext(actual: ContextCapacity, minimum: ContextCapacity | undefined): boolean {
  return minimum === undefined || CONTEXT_ORDER[actual] >= CONTEXT_ORDER[minimum];
}
