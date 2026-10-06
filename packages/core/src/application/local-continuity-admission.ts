import { Capability } from '../domain';
import {
  ExecutionLocality,
  ProviderRegistrySnapshot,
  RoutingContext,
  RoutingConfigurationError,
  type StaticEligibilityProjection,
  type ProviderId,
} from './provider-routing-contracts';
import { RoutingPolicyEngine } from './routing-policy-engine';
import type { ProviderRegistry } from './provider-registry';
import {
  assertExactSoleProviderSelection,
  type SoleProviderSelection,
} from './continuation-prepared-containment';

/**
 * R3-C1 — Local Continuity Eligibility & Static Trusted Admission Contract.
 *
 * A PURE, runtime-INDEPENDENT admission decision. It answers exactly one question: is a request eligible
 * for a FUTURE contained local-continuity invocation? It NEVER prepares containment, issues a production
 * capability, starts a runtime, loads a model, runs Ollama, executes a Provider, or performs any network
 * action. Admission is not runtime preparation, not production trust, and not execution authorization.
 *
 * Ownership boundaries (ADR-0090 R3-C1 amendment + exact-HEAD review remediation):
 *  - Workload local-fallback policy is a deterministic, immutable, versioned policy owner (this module),
 *    not hard-coded in adapter code. Coding/architecture/document-comparison workloads are
 *    local-fallback-ineligible by default.
 *  - Kind A (DERIVED STATIC ADMINISTRATIVE UNAVAILABILITY) is limited to a CLOSED set of
 *    administrative/configuration conditions for the authoritative routing context and matched Stage2B
 *    policy: A1 no NETWORK/cloud Provider configured (where cloud routing is otherwise applicable), or A2
 *    every POLICY-COMPATIBLE cloud Provider is administratively disabled. It is derived via the
 *    Stage2B-owned read-only `RoutingPolicyEngine.staticEligibility(...)` projection, which separates
 *    POLICY-COMPATIBILITY (ignoring `enabled`) from ENABLED eligibility. It NEVER reads dynamic
 *    availability, `isAvailable()`, an availability snapshot, `availabilityClass`, an availability-derived
 *    exclusion, or any caller-supplied evidence/provider id. Kind A is NEVER a quality-floor, required
 *    capability, tool, routing-class, ranking, or LOCAL-locality routing outcome — those are NORMAL
 *    ROUTING and cause DENY (not admission). If the matched policy intentionally requires LOCAL locality,
 *    a LOCAL selection is ordinary routing and admission DENYs even when no cloud is configured.
 *  - Kind B (TRUSTED_CURRENT_UNAVAILABILITY) is evaluated here only as pure deterministic policy;
 *    the application coordinator alone combines it with issuer-validated evidence. Production without
 *    a trusted observation producer still DENYs.
 *  - Kind C (PRIOR_ATTEMPT_FAILURE) is UNSUPPORTED in R3-C1 → ALWAYS DENY (belongs to R3-C-Rz).
 *  - Static provider eligibility, capability floors, quality floors, ranking, and exact selection remain
 *    Stage2B responsibility. This module reuses the SAME `staticEligibility(...)` projection for both the
 *    cloud-path emptiness check and the local-provider eligibility check; it maintains no parallel
 *    eligibility rules and builds no second registry, ranking engine, retry orchestrator, or ExecutionPlan.
 *  - The admission is bound to the composite Stage2B configuration identity (registry + policy) —
 *    `RoutingPolicyEngine`'s `configurationDigest`, identical to `select(...)`. A registry OR policy change
 *    changes the identity and invalidates a prior admission.
 *
 * Normal routing stays normal routing: a cloud path excluded only by quality floor, only by required
 * capability, by locality policy choosing LOCAL, by ordinary single-eligible-provider outcomes, or by
 * ranking preference is NOT Kind A. Only an EMPTY statically-eligible NETWORK set (no configured cloud, or
 * every relevant cloud administratively disabled) yields Kind A.
 *
 * Attempt accounting: an admitted local invocation is exactly attempt 1 with zero additional provider
 * hops. There is no cloud attempt before it and no provider switch after it. The global constants
 * MAX_PROVIDER_ATTEMPTS=2 / MAX_ADDITIONAL_PROVIDER_HOPS=1 are unchanged and remain a separate Stage2B
 * concern; downstream enforcement is an R3-C2/R3-C-Rz integration responsibility, not claimed here.
 *
 * DENY semantics: DENY means LOCAL CONTINUITY NOT ADMITTED. It does NOT mean the whole request is
 * stopped. When a normal cloud path exists, admission DENYs and normal Stage2B routing remains available.
 */

export const LOCAL_CONTINUITY_ADMISSION_SCHEMA = 'local-continuity-admission-v1' as const;
export const LOCAL_CONTINUITY_WORKLOAD_POLICY_VERSION = 'r3c1-workload-local-fallback-v1' as const;

/** R3-C1 fixed attempt accounting for an admitted local-continuity invocation (declarative contract). */
export const R3C1_ATTEMPT_NUMBER = 1 as const;
export const R3C1_ADDITIONAL_PROVIDER_HOPS = 0 as const;

/**
 * Bounded, typed denial reasons. These are NOT `RoutingFailureCode` values and are deliberately distinct
 * from the Stage2B failure taxonomy: R3-C1 adds no new `RoutingFailureCode`. Each reason names why LOCAL
 * CONTINUITY was not admitted; none of them asserts that the entire request is stopped.
 */
export type LocalContinuityDenialReason =
  | 'WORKLOAD_LOCAL_FALLBACK_DISALLOWED'
  | 'NORMAL_CLOUD_PATH_STATICALLY_EXISTS'
  | 'CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY'
  | 'POLICY_REQUIRES_LOCAL_NORMAL_ROUTING'
  | 'NO_POLICY_MATCHED'
  | 'LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE'
  | 'LOCAL_SELECTION_NOT_SOLE'
  | 'ROUTING_CONTEXT_MISMATCH'
  | 'CONFIGURATION_IDENTITY_MISMATCH'
  | 'MALFORMED_INPUT';

/**
 * The CLOSED set of Kind A administrative/configuration conditions R3-C1 may recognize. Kind A is NEVER a
 * quality-floor / capability / tool / routing-class / locality routing outcome. Only these two hold:
 *  - A1 `NO_CLOUD_PROVIDER_CONFIGURED` — no NETWORK provider is configured at all (and the matched policy
 *    does not intentionally require LOCAL).
 *  - A2 `ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED` — one or more NETWORK providers are POLICY-COMPATIBLE
 *    (ignoring `enabled`), but every one of them is administratively disabled (`enabled === false`).
 */
export const KIND_A_ADMINISTRATIVE_CONDITIONS = [
  'NO_CLOUD_PROVIDER_CONFIGURED',
  'ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED',
] as const;
export type KindAAdministrativeCondition = typeof KIND_A_ADMINISTRATIVE_CONDITIONS[number];

/**
 * The kinds enumerated by the ADR-0090 evidence contract. Kind A is derived internally; Kind B requires
 * canonical coordinator evidence; Kind C remains unsupported. No kind is caller-supplied trust.
 */
export const LOCAL_CONTINUITY_EVIDENCE_KINDS = [
  'STATIC_INELIGIBILITY',
  'TRUSTED_CURRENT_UNAVAILABILITY',
  'PRIOR_ATTEMPT_FAILURE',
] as const;
export type LocalContinuityEvidenceKind = typeof LOCAL_CONTINUITY_EVIDENCE_KINDS[number];

/**
 * The DEFAULT workload local-fallback policy, keyed on the existing domain `Capability`. This is the
 * deterministic, immutable, versioned policy owner. `true` = a workload that MAY be considered for local
 * continuity (subject to every other gate); `false` = local-fallback-ineligible by default. Coding,
 * architecture, and document-analysis (document comparison) workloads are ineligible per ADR-0090 §4.
 *
 * R3-C1 accepts only the existing canonical `Capability` projection. It does NOT expand the taxonomy to
 * represent DEBUGGING / CODE_REFACTOR / SECURITY_REVIEW (that needs Architecture Review). Before
 * production wiring, the caller must be an authoritative deterministic workload-policy owner supplying a
 * canonical routing context — not arbitrary external input (see carry-forward). Caller-provided capability
 * is NOT a security authority here; it only selects a conservative default and must additionally pass the
 * Stage2B static-eligibility checks below.
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
  // ADR-0098 amendment: policy-sensitive chat is served only by providers that advertise it, never a local fallback.
  [Capability.POLICY_SENSITIVE_CHAT]: false,
  // ADR-0111 D4/D5: image turns never enter the routed seam; images reach only an IMAGE_UNDERSTANDING provider.
  [Capability.IMAGE_UNDERSTANDING]: false,
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
 * R3-C1 admission input. All fields are bounded application facts. Crucially there is NO caller-supplied
 * cloud provider id and NO caller-supplied "evidence object": the normal cloud path and its static
 * unavailability are derived INTERNALLY from the canonical routing context + registry + policy.
 */
export interface LocalContinuityAdmissionInput {
  /** The workload capability, from existing deterministic derivation. */
  readonly capability: Capability;
  /**
   * The canonical routing context used for the normal path. It drives the matched Stage2B policy and the
   * static cloud/local eligibility projection. `routingContext.capability` must equal `capability`.
   */
  readonly routingContext: RoutingContext;
  /** The candidate LOCAL provider id to consider for continuity (must be statically eligible + LOCAL). */
  readonly localProviderId: ProviderId;
  /**
   * The composite Stage2B configuration identity (registry + policy) under which the caller intends
   * selection to occur. MUST equal `RoutingPolicyEngine`'s `configurationDigest`; a mismatch denies. The
   * admission also re-derives and re-binds this internally, so a stale/registry-only digest cannot pass.
   */
  readonly selectionConfigurationRef: string;
}

/** Immutable, bounded admission decision. Admission != preparation != trust != execution authorization. */
export interface LocalContinuityAdmissionDecision {
  readonly schemaVersion: typeof LOCAL_CONTINUITY_ADMISSION_SCHEMA;
  readonly admitted: boolean;
  readonly denialReason?: LocalContinuityDenialReason;
  /** The sole selected local provider id, present only when admitted. */
  readonly providerCandidate?: ProviderId;
  /** The closed Kind A administrative/configuration condition that justified admission (only when admitted). */
  readonly kindACondition?: KindAAdministrativeCondition;
  /** Present only on canonical admitted decisions. */
  readonly evidenceKind?: LocalContinuityEvidenceKind;
  /** The composite (registry + policy) configuration identity binding derivation and selection. */
  readonly configurationRef: string;
  /** Fixed R3-C1 attempt accounting (declarative). */
  readonly attemptNumber: typeof R3C1_ATTEMPT_NUMBER;
  readonly additionalProviderHops: typeof R3C1_ADDITIONAL_PROVIDER_HOPS;
}

/** Bounded R3-C1 error carrying only a reason code — never host/runtime/provider detail. */
export class LocalContinuityAdmissionError extends Error {
  constructor(readonly reason: LocalContinuityDenialReason | 'DYNAMIC_EVIDENCE_UNSUPPORTED' | 'PRIOR_ATTEMPT_FAILURE_UNSUPPORTED') {
    super(reason);
    this.name = 'LocalContinuityAdmissionError';
  }
}

/**
 * This legacy direct assertion remains fail closed. The I1 coordinator is the only Kind B integration;
 * this function has NO argument and NO caller path that can make it admit — no
 * `freshness=CURRENT` label, no `trusted` string, no availability snapshot, no `isAvailable()` result, no
 * persisted/rehydrated value. It always throws. It is intentionally named as an "unsupported" assertion
 * so it can never be mistaken for an admitting API.
 */
export function assertTrustedCurrentUnavailabilityUnsupported(): never {
  throw new LocalContinuityAdmissionError('DYNAMIC_EVIDENCE_UNSUPPORTED');
}

/**
 * Kind C is unsupported in R3-C1. A prior cloud attempt implies post-dispatch history and belongs
 * exclusively to R3-C-Rz. This assertion fails closed unconditionally; there is no admitting path.
 */
export function assertPriorAttemptFailureUnsupported(): never {
  throw new LocalContinuityAdmissionError('PRIOR_ATTEMPT_FAILURE_UNSUPPORTED');
}

function isCompositeConfigRef(value: unknown): value is string {
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
 * The R3-C1 admission decision. Pure and runtime-independent. Composes: workload local-fallback policy →
 * canonical static cloud-path emptiness (Kind A, via Stage2B `staticEligibility`) → local provider
 * static eligibility under the SAME policy/configuration → exact PRIMARY_ONLY sole-selection handoff
 * (R3-B1). It performs ZERO containment/runtime preparation and creates ZERO production trust; on any
 * failure it denies.
 */
export class LocalContinuityAdmission {
  constructor(
    private readonly workloadPolicy: WorkloadLocalFallbackPolicy,
    private readonly routingEngine: RoutingPolicyEngine,
    private readonly registry: ProviderRegistry,
  ) {}

  /** Pure deterministic Kind B prerequisite check. Its result is never evidence or admission authority. */
  evaluateTrustedCurrentUnavailabilityPolicy(input: LocalContinuityAdmissionInput): {
    readonly allowed: boolean;
    readonly configurationRef: string;
    readonly providerCandidate?: ProviderId;
    readonly soleSelection?: SoleProviderSelection;
    readonly denialReason?: LocalContinuityDenialReason;
  } {
    const configRef = input.selectionConfigurationRef;
    if (!isCompositeConfigRef(configRef) || !input.routingContext || input.routingContext.capability !== input.capability
      || typeof input.localProviderId !== 'string' || !input.localProviderId) {
      return { allowed: false, configurationRef: configRef, denialReason: 'MALFORMED_INPUT' };
    }
    const projection = this.routingEngine.staticEligibility(input.routingContext, this.registry.snapshot());
    if (projection.configurationDigest !== configRef) {
      return { allowed: false, configurationRef: configRef, denialReason: 'CONFIGURATION_IDENTITY_MISMATCH' };
    }
    if (!this.workloadPolicy.localFallbackAllowed(input.capability)) {
      return { allowed: false, configurationRef: configRef, denialReason: 'WORKLOAD_LOCAL_FALLBACK_DISALLOWED' };
    }
    if (!projection.policyMatched) return { allowed: false, configurationRef: configRef, denialReason: 'NO_POLICY_MATCHED' };
    if (projection.policyRequiresLocalLocality) {
      return { allowed: false, configurationRef: configRef, denialReason: 'POLICY_REQUIRES_LOCAL_NORMAL_ROUTING' };
    }
    if (projection.eligibleNetworkProviderIds.length === 0) {
      return { allowed: false, configurationRef: configRef, denialReason: 'NORMAL_CLOUD_PATH_STATICALLY_EXISTS' };
    }
    if (projection.eligibleLocalProviderIds.length !== 1) {
      return { allowed: false, configurationRef: configRef, denialReason: 'LOCAL_SELECTION_NOT_SOLE' };
    }
    const soleSelection = this.selectLocal(input.localProviderId, projection);
    if (!soleSelection) {
      return { allowed: false, configurationRef: configRef, denialReason: 'LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE' };
    }
    return Object.freeze({ allowed: true, configurationRef: configRef,
      providerCandidate: input.localProviderId, soleSelection });
  }

  private selectLocal(localProviderId: ProviderId, projection: StaticEligibilityProjection): SoleProviderSelection | null {
    const descriptor = this.registry.get(localProviderId);
    if (!descriptor || descriptor.capabilities.executionLocality !== ExecutionLocality.LOCAL
      || !projection.eligibleLocalProviderIds.includes(localProviderId)) return null;
    try {
      return assertExactSoleProviderSelection({ eligibleProviderIds: [localProviderId],
        selectedProviderId: localProviderId, primaryOnly: true });
    } catch {
      return null;
    }
  }

  /**
   * Decide admission. Returns the decision plus (only when admitted) the `SoleProviderSelection` handoff
   * for the downstream R3-B1/containment slice.
   */
  admit(input: LocalContinuityAdmissionInput): {
    decision: LocalContinuityAdmissionDecision;
    soleSelection?: SoleProviderSelection;
  } {
    const configRef = typeof input.selectionConfigurationRef === 'string' ? input.selectionConfigurationRef : '';

    // 0. Structural input validation → MALFORMED_INPUT (fail closed).
    if (!isCompositeConfigRef(configRef)) {
      return { decision: deny('', 'MALFORMED_INPUT') };
    }
    if (
      typeof input.localProviderId !== 'string' ||
      input.localProviderId.length === 0 ||
      input.routingContext === null ||
      typeof input.routingContext !== 'object' ||
      input.routingContext.capability !== input.capability
    ) {
      return {
        decision: deny(
          configRef,
          input.routingContext && input.routingContext.capability !== input.capability
            ? 'ROUTING_CONTEXT_MISMATCH'
            : 'MALFORMED_INPUT',
        ),
      };
    }

    // The static-eligibility projection is availability-independent, so a default snapshot is fine; no
    // availability value can affect the result. This is NOT a fabricated AVAILABLE snapshot.
    let projection;
    try {
      const snapshot: ProviderRegistrySnapshot = this.registry.snapshot();
      projection = this.routingEngine.staticEligibility(input.routingContext, snapshot);
    } catch (error) {
      if (error instanceof RoutingConfigurationError) {
        return { decision: deny(configRef, 'ROUTING_CONTEXT_MISMATCH') };
      }
      throw error;
    }

    // 1. Composite configuration-identity binding (registry + policy). The caller's ref must equal the
    //    exact Stage2B composite identity used for selection; a registry-only or stale digest fails here.
    if (projection.configurationDigest !== configRef) {
      return { decision: deny(configRef, 'CONFIGURATION_IDENTITY_MISMATCH') };
    }

    // 2. Workload local-fallback policy: coding/architecture/document workloads deny immediately, with
    //    ZERO local selection and ZERO containment/runtime preparation.
    if (!this.workloadPolicy.localFallbackAllowed(input.capability)) {
      return { decision: deny(configRef, 'WORKLOAD_LOCAL_FALLBACK_DISALLOWED') };
    }

    // 3. A policy must match the context; otherwise there is no canonical normal path to reason about.
    if (!projection.policyMatched) {
      return { decision: deny(configRef, 'NO_POLICY_MATCHED') };
    }

    // 4. Kind A — the CLOSED administrative/configuration condition (B-A). Kind A is NEVER a quality/
    //    capability/tool/routing-class/locality routing outcome. We distinguish policy-compatibility from
    //    administrative disablement using the Stage2B projection.
    //
    //    Case 0 — the matched policy intentionally requires LOCAL locality: a LOCAL selection is ordinary
    //    routing, not continuity → DENY (even if no cloud is configured).
    if (projection.policyRequiresLocalLocality) {
      return { decision: deny(configRef, 'POLICY_REQUIRES_LOCAL_NORMAL_ROUTING') };
    }
    //    Case 4 — at least one enabled policy-compatible cloud exists → normal cloud path exists → DENY.
    if (projection.eligibleNetworkProviderIds.length > 0) {
      return { decision: deny(configRef, 'NORMAL_CLOUD_PATH_STATICALLY_EXISTS') };
    }
    let kindACondition: KindAAdministrativeCondition;
    if (projection.configuredNetworkProviderIds.length === 0) {
      //  Case 1 — no NETWORK provider configured at all → A1.
      kindACondition = 'NO_CLOUD_PROVIDER_CONFIGURED';
    } else if (projection.policyCompatibleNetworkProviderIdsIgnoringEnabled.length === 0) {
      //  Case 2 — clouds exist but NONE is policy-compatible (quality/capability/tool/routing-class/
      //  locality): ordinary policy incompatibility, NOT Kind A → DENY.
      return { decision: deny(configRef, 'CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY') };
    } else {
      //  Case 3 — policy-compatible clouds exist but ALL are administratively disabled (the only exclusion
      //  from eligibility is `enabled === false`, since eligibleNetworkProviderIds is empty here) → A2.
      kindACondition = 'ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED';
    }

    // 5. The LOCAL provider must be STATICALLY ELIGIBLE under the SAME policy/configuration (same capability
    //    + quality floor + LOCAL locality). We reuse the SAME projection rather than a parallel rule set.
    if (!this.registry.get(input.localProviderId)
      || !projection.eligibleLocalProviderIds.includes(input.localProviderId)) {
      return { decision: deny(configRef, 'LOCAL_PROVIDER_NOT_STATICALLY_ELIGIBLE') };
    }

    // 6. Exact PRIMARY_ONLY sole-selection handoff through the R3-B1 boundary. Exactly one eligible
    //    provider (the local one) and it is the selection. This mints a SoleProviderSelection via the
    //    existing R3-B1 exact-selection assertion (pre-existing public API; see docs) but performs NO
    //    containment preparation, model load, or execution.
    const soleSelection = this.selectLocal(input.localProviderId, projection);
    if (!soleSelection) {
      return { decision: deny(configRef, 'LOCAL_SELECTION_NOT_SOLE') };
    }

    const decision: LocalContinuityAdmissionDecision = Object.freeze({
      schemaVersion: LOCAL_CONTINUITY_ADMISSION_SCHEMA,
      admitted: true,
      providerCandidate: input.localProviderId,
      kindACondition,
      evidenceKind: 'STATIC_INELIGIBILITY',
      configurationRef: configRef,
      attemptNumber: R3C1_ATTEMPT_NUMBER,
      additionalProviderHops: R3C1_ADDITIONAL_PROVIDER_HOPS,
    });
    return { decision, soleSelection };
  }
}
