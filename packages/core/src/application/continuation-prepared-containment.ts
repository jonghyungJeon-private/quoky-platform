import { containmentBindingDigest, VERIFIED_CONTAINMENT_BINDING_SCHEMA } from './containment-binding-digest';
export { VERIFIED_CONTAINMENT_BINDING_SCHEMA } from './containment-binding-digest';
import { createHash } from 'node:crypto';
import { CONTAINMENT_RUNTIME_FAMILIES, CONTINUATION_CONTAINMENT_AUDIT_SCHEMA,
  type ContainmentBindingEvidence, type ContinuationContainmentAudit } from '../ports/continuation-containment-audit';
import { snapshotContainmentAudit } from './continuation-containment-validation';

/**
 * R3-B1 — Verified Prepared Containment Contract (runtime-family-independent, offline).
 *
 * The smallest Application/domain contract that makes any FUTURE contained continuation execution
 * structurally depend on a verified `PreparedContainmentExecution`. It intentionally does NOT make real
 * contained execution reachable: there is no AiProvider, host executable, command, socket, endpoint,
 * container, VM, daemon, or network anywhere in this module. Verification is expressed through two
 * independent channel contracts; only a dual-channel agreement yields a `VerifiedContainmentBinding`,
 * and only that binding can construct a `PreparedContainmentExecution`.
 *
 * R3-B1 remediation (B-1/B-2/B-3): every security-bearing capability in this module is NON-FORGEABLE at
 * runtime, not merely by TypeScript shape. Issuance is gated by module-private `WeakSet` registries: an
 * object literal, spread copy, or reconstructed look-alike is rejected because it was never issued by
 * this module. Digests are recomputed and re-verified on acceptance (defense in depth). There is NO
 * public arbitrary execution-callback injection point; the only contained execution capability is a
 * module-issued deterministic fake bound to an exact containment instance.
 *
 * Identity distinction (ratified R3 Architecture v3, Gate 4): the Stage2B `providerBindingDigest` and the
 * R3 `containmentBindingDigest` are DISTINCT concepts and DISTINCT values. `providerBindingDigest` stays
 * opaque and is never recomputed here; `containmentBindingDigest` is independently derived and
 * domain-separated so it can never collide with a Stage2B provider binding digest even on overlapping
 * inputs.
 *
 * Digest convention reuses the repository's canonical `sha256(JSON.stringify(canonicalShape))` form
 * (see provider-binding-registry / routing-policy-engine), never an unrelated hashing scheme.
 */

export const CONTAINMENT_SECURITY_PROFILE_SCHEMA = 'containment-security-profile-v1' as const;
export const CONTAINMENT_INSTANCE_IDENTITY_SCHEMA = 'containment-instance-identity-v1' as const;
export const SOLE_PROVIDER_SELECTION_SCHEMA = 'sole-provider-selection-v1' as const;
export const CONTAINMENT_CANDIDATE_BINDING_SCHEMA = 'containment-candidate-binding-v1' as const;
export const CONTAINED_EXECUTION_CAPABILITY_SCHEMA = 'contained-execution-capability-v1' as const;
export const PREPARED_CONTAINMENT_EXECUTION_SCHEMA = 'prepared-containment-execution-v1' as const;
export const CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA = 'containment-verification-provenance-v1' as const;
export const PREPARED_CONTAINMENT_PROVENANCE_SCHEMA = 'prepared-containment-provenance-v1' as const;

/**
 * R3-B3 (Items 1/2/4) — durable, SERIALIZABLE production trust boundary.
 *
 * `TEST` is the only trust domain any code in this slice can legitimately produce: no real production
 * verification runtime, capability issuer, or attestation exists yet. `PRODUCTION` is reserved for a
 * future R3-C runtime issuer. Every production-trust requirement here FAILS CLOSED on the absence of
 * `PRODUCTION` provenance rather than fabricating authenticity. Trust is carried as durable serializable
 * fields (survives persistence/restart), NOT only via a process-local WeakSet — the WeakSets remain the
 * in-process non-forgeability mechanism (B-1/B-2), but the production-vs-test distinction is durable.
 */
export const CONTAINMENT_TRUST_DOMAINS = ['TEST', 'PRODUCTION'] as const;
export type ContainmentTrustDomain = typeof CONTAINMENT_TRUST_DOMAINS[number];

/** The kind of a contained execution capability. FAKE is test-only and is never production-eligible. */
export const CONTAINED_EXECUTION_CAPABILITY_KINDS = ['FAKE', 'PRODUCTION'] as const;
export type ContainedExecutionCapabilityKind = typeof CONTAINED_EXECUTION_CAPABILITY_KINDS[number];

/** Domain-separation tags so a containment digest can never equal a Stage2B provider binding digest. */
const CONTAINMENT_SECURITY_PROFILE_DIGEST_DOMAIN = 'quoky.r3.containment.security-profile.v1' as const;
const CONTAINMENT_INSTANCE_DIGEST_DOMAIN = 'quoky.r3.containment.instance.v1' as const;
const CONTAINMENT_PROVENANCE_DIGEST_DOMAIN = 'quoky.r3.containment.provenance.v1' as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPAQUE = /^[^\u0000-\u001f\u007f]{1,256}$/;

function isId(v: unknown): v is string { return typeof v === 'string' && ID.test(v); }
function isHex64(v: unknown): v is string { return typeof v === 'string' && HEX64.test(v); }
function isVersion(v: unknown): v is string { return typeof v === 'string' && VERSION.test(v); }
function isOpaque(v: unknown): v is string { return typeof v === 'string' && OPAQUE.test(v); }

function sha256Canonical(domain: string, shape: unknown): string {
  return createHash('sha256').update(JSON.stringify({ domain, shape })).digest('hex');
}

export type PreparedContainmentFailureCode =
  | 'CONTAINMENT_CONFIGURATION_INVALID'
  | 'CONTAINMENT_CANDIDATE_INVALID'
  | 'CONTAINMENT_CANDIDATE_NOT_ISSUED'
  | 'PROVIDER_SELECTION_NOT_ISSUED'
  | 'STATIC_ELIGIBILITY_NOT_SATISFIED'
  | 'PRIMARY_ONLY_VIOLATION'
  | 'PROVIDER_SELECTION_NOT_SOLE'
  | 'CHANNEL_A_UNVERIFIED'
  | 'CHANNEL_B_UNVERIFIED'
  | 'CHANNEL_DISAGREEMENT'
  | 'VERIFICATION_UNCERTAIN'
  | 'VERIFIED_BINDING_NOT_ISSUED'
  | 'CONTAINMENT_BINDING_DIGEST_MISMATCH'
  | 'EXECUTION_CAPABILITY_NOT_ISSUED'
  | 'EXECUTION_CAPABILITY_INSTANCE_MISMATCH'
  | 'EXACT_RUN_BINDING_MISMATCH'
  | 'CHANNEL_NOT_PRODUCTION_TRUSTED'
  | 'CHANNEL_PROVENANCE_NOT_INDEPENDENT'
  | 'CAPABILITY_NOT_PRODUCTION_ELIGIBLE'
  | 'PREPARED_PROVENANCE_NOT_PRODUCTION_TRUSTED'
  | 'PREPARED_PROVENANCE_INVALID'
  | 'SELF_DECLARED_PRODUCTION_TRUST_REJECTED'
  | 'PRODUCTION_TRUST_ANCHOR_UNAVAILABLE';

/** Bounded, fail-closed preparation error. Carries a code only — never host/runtime detail. */
export class PreparedContainmentError extends Error {
  constructor(readonly code: PreparedContainmentFailureCode) {
    super(code);
    this.name = 'PreparedContainmentError';
  }
}

/**
 * Bounded, immutable, runtime-INDEPENDENT containment security profile. It expresses the required
 * egress-denial posture as bounded tokens only; it encodes no Docker/OrbStack/VM/host specifics and no
 * command/socket/endpoint. `securityProfileDigest` is derived canonically and domain-separated.
 */
export interface ContainmentSecurityProfile {
  readonly schemaVersion: typeof CONTAINMENT_SECURITY_PROFILE_SCHEMA;
  readonly securityProfileId: string;
  readonly securityProfileVersion: string;
  readonly denyNonLoopbackIpv4: true;
  readonly denyNonLoopbackIpv6: true;
  readonly denyDns: true;
  readonly denyModelDownload: true;
  readonly securityProfileDigest: string;
}

const issuedProfiles = new WeakSet<ContainmentSecurityProfile>();
const issuedInstances = new WeakSet<ContainmentInstanceIdentity>();

export function createContainmentSecurityProfile(input: {
  securityProfileId: string;
  securityProfileVersion: string;
}): ContainmentSecurityProfile {
  if (!isId(input.securityProfileId) || !isVersion(input.securityProfileVersion)) {
    throw new PreparedContainmentError('CONTAINMENT_CONFIGURATION_INVALID');
  }
  const canonical = {
    schemaVersion: CONTAINMENT_SECURITY_PROFILE_SCHEMA,
    securityProfileId: input.securityProfileId,
    securityProfileVersion: input.securityProfileVersion,
    denyNonLoopbackIpv4: true as const,
    denyNonLoopbackIpv6: true as const,
    denyDns: true as const,
    denyModelDownload: true as const,
  };
  const profile = Object.freeze({
    ...canonical,
    securityProfileDigest: sha256Canonical(CONTAINMENT_SECURITY_PROFILE_DIGEST_DOMAIN, canonical),
  });
  issuedProfiles.add(profile);
  return profile;
}

/**
 * Opaque, immutable, runtime-INDEPENDENT containment instance identity. The digest is the only stable
 * identity handle; the raw runtime instance (container id, VM handle, OrbStack path, socket, PID) is
 * NEVER represented here. Any concrete adapter instance identity contributes to `instanceIdentityDigest`
 * without being surfaced.
 */
export interface ContainmentInstanceIdentity {
  readonly schemaVersion: typeof CONTAINMENT_INSTANCE_IDENTITY_SCHEMA;
  readonly instanceIdentityDigest: string;
}

/** Build an opaque instance identity from an already-opaque adapter-supplied identity token. */
export function createContainmentInstanceIdentity(opaqueInstanceToken: string): ContainmentInstanceIdentity {
  if (!isOpaque(opaqueInstanceToken)) {
    throw new PreparedContainmentError('CONTAINMENT_CONFIGURATION_INVALID');
  }
  const instance = Object.freeze({
    schemaVersion: CONTAINMENT_INSTANCE_IDENTITY_SCHEMA,
    instanceIdentityDigest: sha256Canonical(CONTAINMENT_INSTANCE_DIGEST_DOMAIN, { token: opaqueInstanceToken }),
  });
  issuedInstances.add(instance);
  return instance;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// B-2 — Non-forgeable exact sole Provider selection.
//
// `SoleProviderSelection` is an OPAQUE nominal capability: its concrete class is module-private and its
// instances are registered in a module-private WeakSet. Only `assertExactSoleProviderSelection` can mint
// one (after enforcing static eligibility + PRIMARY_ONLY + exact sole selection). An arbitrary object
// literal is not a member of the registry, so `createContainmentCandidateBinding` rejects it. The public
// type is an opaque brand; the selected providerId is read only through a module function, and the
// candidate derives its providerId FROM the selection — a caller can never substitute a different one.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Opaque, non-forgeable exact-sole-Provider selection. No public constructor; no readable fields. */
export interface SoleProviderSelection {
  readonly schemaVersion: typeof SOLE_PROVIDER_SELECTION_SCHEMA;
  /** Opaque brand — the real identity lives in module-private state, not in this surface. */
  readonly __brand: 'SoleProviderSelection';
}

class IssuedSoleProviderSelection implements SoleProviderSelection {
  readonly schemaVersion = SOLE_PROVIDER_SELECTION_SCHEMA;
  readonly __brand = 'SoleProviderSelection' as const;
  constructor(readonly providerId: string) {
    Object.freeze(this);
  }
}

const issuedSelections = new WeakSet<IssuedSoleProviderSelection>();

/** Recover the selected providerId ONLY from a genuinely issued selection; else fail closed. */
function selectedProviderIdOf(selection: SoleProviderSelection): string {
  if (!(selection instanceof IssuedSoleProviderSelection) || !issuedSelections.has(selection)) {
    throw new PreparedContainmentError('PROVIDER_SELECTION_NOT_ISSUED');
  }
  return selection.providerId;
}

/**
 * Static-eligibility seam expressing the MANDATORY ordering:
 *   static eligibility → PRIMARY_ONLY enforcement → exact sole Provider selection → containment
 *   preparation.
 * It does NOT duplicate Stage2B eligibility/ranking, does NOT fabricate an AVAILABLE Provider snapshot,
 * and does NOT use host `ollama --version` as availability evidence. It receives the already-decided
 * eligible-provider set (a trusted Application seam/fake in R3-B1) and enforces that exactly one provider
 * is eligible AND is the sole selection before any containment candidate may be prepared.
 */
export interface StaticEligibilityDecision {
  /** The eligible providers a prior (fake in R3-B1) static-eligibility pass produced. */
  readonly eligibleProviderIds: readonly string[];
  /** The sole selected provider. PRIMARY_ONLY requires this to be the ONLY eligible provider. */
  readonly selectedProviderId: string;
  /** Positive assertion from the caller's PRIMARY_ONLY enforcement (no fallback/escalation planned). */
  readonly primaryOnly: true;
}

/**
 * Assert the mandatory ordering; fail closed on any deviation. Returns an OPAQUE, non-forgeable
 * `SoleProviderSelection` (not a raw string) that is the ONLY key able to open candidate creation.
 */
export function assertExactSoleProviderSelection(decision: StaticEligibilityDecision): SoleProviderSelection {
  if (decision.primaryOnly !== true) throw new PreparedContainmentError('PRIMARY_ONLY_VIOLATION');
  const eligible = decision.eligibleProviderIds;
  if (!Array.isArray(eligible) || eligible.length === 0 || eligible.some((v) => !isId(v))) {
    throw new PreparedContainmentError('STATIC_ELIGIBILITY_NOT_SATISFIED');
  }
  if (new Set(eligible).size !== eligible.length) {
    throw new PreparedContainmentError('STATIC_ELIGIBILITY_NOT_SATISFIED');
  }
  // PRIMARY_ONLY: exactly one eligible provider, and it must be the selected one.
  if (eligible.length !== 1) throw new PreparedContainmentError('PRIMARY_ONLY_VIOLATION');
  if (!isId(decision.selectedProviderId) || eligible[0] !== decision.selectedProviderId) {
    throw new PreparedContainmentError('PROVIDER_SELECTION_NOT_SOLE');
  }
  const selection = new IssuedSoleProviderSelection(decision.selectedProviderId);
  issuedSelections.add(selection);
  return selection;
}

/** Existing R3-A slots; executionId === taskRunId is the canonical continuation attempt identity.
 * These bounded facts select no runtime. They are frozen before either verification channel runs. */
export type ContainmentExecutionContext = Readonly<Pick<ContainmentBindingEvidence,
  'executionId' | 'taskRunId' | 'containmentPolicyId' | 'containmentPolicyVersion'
  | 'containmentPolicyDigest' | 'runtimeFamily' | 'runtimeVersion' | 'modelMountIdentityDigest'>>;

/**
 * Pure candidate/binding input that preserves DISTINCT identities. `providerBindingDigest` is the
 * Stage2B provider binding digest (opaque here, never recomputed) and is deliberately kept separate from
 * every containment digest. `expectedModelId`/`expectedModelDigest` are the model identity the future
 * contained attempt must run; they are not resolved or executed here.
 *
 * B-2: the candidate is runtime-distinguishable from an arbitrary object literal (module-private
 * WeakSet registration) and its `providerId` is DERIVED from the issued `SoleProviderSelection` — never
 * a caller-supplied raw providerId.
 */
export interface ContainmentCandidateBinding {
  readonly executionContext: ContainmentExecutionContext;
  readonly schemaVersion: typeof CONTAINMENT_CANDIDATE_BINDING_SCHEMA;
  readonly providerId: string;
  /** Stage2B provider binding digest — DISTINCT from any containment digest. */
  readonly providerBindingDigest: string;
  readonly securityProfileId: string;
  readonly securityProfileDigest: string;
  readonly expectedModelId: string;
  readonly expectedModelDigest: string;
  readonly imageDigest: string;
  readonly instanceIdentityDigest: string;
}

const issuedCandidates = new WeakSet<ContainmentCandidateBinding>();

export function createContainmentCandidateBinding(input: {
  executionContext: ContainmentExecutionContext;
  /** The ONLY source of providerId — an issued exact sole selection. No raw providerId is accepted. */
  selection: SoleProviderSelection;
  providerBindingDigest: string;
  securityProfile: ContainmentSecurityProfile;
  expectedModelId: string;
  expectedModelDigest: string;
  imageDigest: string;
  instance: ContainmentInstanceIdentity;
}): ContainmentCandidateBinding {
  // B-2: providerId is derived from the issued selection; an unissued selection fails closed here.
  const providerId = selectedProviderIdOf(input.selection);
  const rawContext = input.executionContext;
  const contextKeys = ['executionId', 'taskRunId', 'containmentPolicyId', 'containmentPolicyVersion',
    'containmentPolicyDigest', 'runtimeFamily', 'runtimeVersion', 'modelMountIdentityDigest'] as const;
  if (!rawContext || typeof rawContext !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(rawContext))
    || Reflect.ownKeys(rawContext).length !== contextKeys.length) {
    throw new PreparedContainmentError('EXACT_RUN_BINDING_MISMATCH');
  }
  const values: Record<string, unknown> = {};
  for (const key of contextKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(rawContext, key);
    if (!descriptor || !('value' in descriptor)) throw new PreparedContainmentError('EXACT_RUN_BINDING_MISMATCH');
    values[key] = descriptor.value;
  }
  const c = values as unknown as ContainmentExecutionContext;
  if (!c || c.executionId !== c.taskRunId || !isId(c.taskRunId)
    || !isId(c.containmentPolicyId) || !isVersion(c.containmentPolicyVersion)
    || !isHex64(c.containmentPolicyDigest) || !isVersion(c.runtimeVersion)
    || !CONTAINMENT_RUNTIME_FAMILIES.includes(c.runtimeFamily)
    || !isHex64(c.modelMountIdentityDigest)) {
    throw new PreparedContainmentError('EXACT_RUN_BINDING_MISMATCH');
  }
  const executionContext = Object.freeze({ executionId: c.executionId, taskRunId: c.taskRunId,
    containmentPolicyId: c.containmentPolicyId, containmentPolicyVersion: c.containmentPolicyVersion,
    containmentPolicyDigest: c.containmentPolicyDigest, runtimeFamily: c.runtimeFamily,
    runtimeVersion: c.runtimeVersion, modelMountIdentityDigest: c.modelMountIdentityDigest });
  const profile = input.securityProfile;
  const instance = input.instance;
  if (
    !issuedProfiles.has(profile) || !issuedInstances.has(instance) ||
    profile?.schemaVersion !== CONTAINMENT_SECURITY_PROFILE_SCHEMA ||
    !isHex64(profile.securityProfileDigest) ||
    !isId(profile.securityProfileId) ||
    instance?.schemaVersion !== CONTAINMENT_INSTANCE_IDENTITY_SCHEMA ||
    !isHex64(instance.instanceIdentityDigest) ||
    !isHex64(input.providerBindingDigest) ||
    !isOpaque(input.expectedModelId) || !isHex64(input.expectedModelDigest) || !isHex64(input.imageDigest)
  ) {
    throw new PreparedContainmentError('CONTAINMENT_CANDIDATE_INVALID');
  }
  const candidate: ContainmentCandidateBinding = Object.freeze({
    schemaVersion: CONTAINMENT_CANDIDATE_BINDING_SCHEMA,
    executionContext,
    providerId,
    providerBindingDigest: input.providerBindingDigest,
    securityProfileId: profile.securityProfileId,
    securityProfileDigest: profile.securityProfileDigest,
    expectedModelId: input.expectedModelId,
    expectedModelDigest: input.expectedModelDigest,
    imageDigest: input.imageDigest,
    instanceIdentityDigest: instance.instanceIdentityDigest,
  });
  issuedCandidates.add(candidate);
  return candidate;
}

/**
 * The bounded fact-set both verification channels must independently agree on. Producing it does not
 * run anything: it is the exact identity tuple a verified binding will bind.
 */
export interface ContainmentVerificationSubject {
  readonly candidate: ContainmentCandidateBinding;
  readonly securityProfileDigest: string;
  readonly providerBindingDigest: string;
  readonly instanceIdentityDigest: string;
  readonly expectedModelDigest: string;
}

export type ContainmentChannelStatus = 'VERIFIED' | 'FAILED' | 'UNAVAILABLE' | 'UNCERTAIN';

/** Bounded per-channel result. `resultDigest` is present ONLY when status === 'VERIFIED'. */
export interface ContainmentChannelResult {
  readonly status: ContainmentChannelStatus;
  readonly verifierVersion: string;
  /**
   * R3-B3 (Item 1): durable, serializable production-trust facts. `trustDomain` distinguishes a test/fake
   * verification (`TEST`) from a future production-trusted one (`PRODUCTION`). `verifierProvenanceId` is a
   * durable verifier/attestation provenance identity; Channel A and Channel B must present DISTINCT
   * provenance identities (independence). No production issuer exists yet, so a legitimately-produced
   * result is always `TEST`; a `PRODUCTION` claim from arbitrary caller code cannot be honoured (there is
   * no production issuer to satisfy `requireProductionTrustedVerification`, which fails closed).
   */
  readonly trustDomain: ContainmentTrustDomain;
  readonly verifierProvenanceId: string;
  /** SHA-256 over the exact subject the channel verified; present only when VERIFIED. */
  readonly resultDigest?: string;
}

/**
 * Independent verification channel. Channel A = runtime/instance inspection; Channel B = in-instance
 * self-check (both fake in R3-B1). Each returns only a bounded result; neither exposes runtime detail.
 * The two implementations MUST be independent (different verifier identities/evidence sources).
 */
export interface ContainmentVerificationChannel {
  readonly channel: 'A' | 'B';
  verify(subject: ContainmentVerificationSubject): ContainmentChannelResult;
}

/**
 * R3-B3 (Item 4): durable, SERIALIZABLE prepared-evidence provenance. Its presence with
 * `trustDomain==='PRODUCTION'` is the ONLY thing that lets a future production path treat prepared
 * evidence as production-trusted — "canonical fields + correct hash" alone yields `TEST` provenance and
 * fails closed against a production-trust requirement. It carries the durable trust domain, the two
 * independent verifier provenance identities, and a domain-separated provenance digest over those facts.
 * It contains NO secret key, certificate, network attestation, or runtime-specific evidence.
 */
export interface VerifiedContainmentProvenance {
  readonly provenanceSchema: typeof CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA;
  readonly trustDomain: ContainmentTrustDomain;
  readonly channelAProvenanceId: string;
  readonly channelBProvenanceId: string;
  readonly provenanceDigest: string;
}

/**
 * The verified binding. It is issued ONLY by `prepareVerifiedContainmentBinding` after BOTH channels
 * independently VERIFIED the identical subject, AND is registered in a module-private WeakSet so it
 * cannot be forged. `containmentBindingDigest` is domain-separated and binds the security profile,
 * containment instance, Provider binding, model identity, both channel verifier identities + result
 * digests, and schema/version facts — DISTINCT from `providerBindingDigest`. R3-B3 additionally carries a
 * durable `provenance` record (Item 4) so integrity (correct hash) is separated from production trust.
 */
export interface VerifiedContainmentBinding {
  readonly executionContext: ContainmentExecutionContext;
  readonly schemaVersion: typeof VERIFIED_CONTAINMENT_BINDING_SCHEMA;
  readonly providerId: string;
  readonly providerBindingDigest: string;
  readonly securityProfileId: string;
  readonly securityProfileDigest: string;
  readonly instanceIdentityDigest: string;
  readonly expectedModelId: string;
  readonly expectedModelDigest: string;
  readonly imageDigest: string;
  readonly channelAVerifierVersion: string;
  readonly channelBVerifierVersion: string;
  readonly channelAResultDigest: string;
  readonly channelBResultDigest: string;
  /** R3-B3 (Item 4): durable serializable production-trust provenance. */
  readonly provenance: VerifiedContainmentProvenance;
  /** R3 containment binding digest. NEVER equal to providerBindingDigest. */
  readonly containmentBindingDigest: string;
}

const issuedVerifiedBindings = new WeakSet<VerifiedContainmentBinding>();

/**
 * Accept a binding as verified ONLY if (defense in depth):
 *  1. it was issued by this module (WeakSet membership) — literals/spread copies/reconstructions fail; AND
 *  2. its `containmentBindingDigest` still equals the recomputed digest over its canonical identity.
 */
function requireIssuedVerifiedBinding(binding: VerifiedContainmentBinding): void {
  if (binding?.schemaVersion !== VERIFIED_CONTAINMENT_BINDING_SCHEMA
    || !isHex64(binding.containmentBindingDigest)
    || !issuedVerifiedBindings.has(binding)) {
    throw new PreparedContainmentError('VERIFIED_BINDING_NOT_ISSUED');
  }
  const recomputed = containmentBindingDigest(binding);
  if (recomputed !== binding.containmentBindingDigest) {
    throw new PreparedContainmentError('CONTAINMENT_BINDING_DIGEST_MISMATCH');
  }
}

function channelResultDigest(subject: ContainmentVerificationSubject, channel: 'A' | 'B', verifierVersion: string): string {
  return sha256Canonical(`quoky.r3.containment.channel.${channel}.v1`, {
    verifierVersion,
    executionContext: subject.candidate.executionContext,
    providerId: subject.candidate.providerId,
    providerBindingDigest: subject.providerBindingDigest,
    securityProfileDigest: subject.securityProfileDigest,
    instanceIdentityDigest: subject.instanceIdentityDigest,
    expectedModelDigest: subject.expectedModelDigest,
    imageDigest: subject.candidate.imageDigest,
  });
}

interface VerifiedChannelFacts {
  readonly resultDigest: string;
  readonly trustDomain: ContainmentTrustDomain;
  readonly verifierProvenanceId: string;
  readonly verifierVersion: string;
}

function requireChannelVerified(
  result: ContainmentChannelResult,
  subject: ContainmentVerificationSubject,
  channel: 'A' | 'B',
): VerifiedChannelFacts {
  const unverified = channel === 'A' ? 'CHANNEL_A_UNVERIFIED' : 'CHANNEL_B_UNVERIFIED';
  if (result === null || typeof result !== 'object') throw new PreparedContainmentError(unverified);
  if (result.status === 'UNCERTAIN') throw new PreparedContainmentError('VERIFICATION_UNCERTAIN');
  if (result.status !== 'VERIFIED') throw new PreparedContainmentError(unverified);
  if (!isVersion(result.verifierVersion) || !isHex64(result.resultDigest ?? '')) {
    throw new PreparedContainmentError(unverified);
  }
  // R3-B3 (Item 1): durable trust facts must be well-formed. A malformed/absent trust domain or
  // provenance identity is not a verified result.
  if (!CONTAINMENT_TRUST_DOMAINS.includes(result.trustDomain) || !isId(result.verifierProvenanceId)) {
    throw new PreparedContainmentError(unverified);
  }
  // The channel must have verified the EXACT subject.
  if (result.resultDigest !== channelResultDigest(subject, channel, result.verifierVersion)) {
    throw new PreparedContainmentError('CHANNEL_DISAGREEMENT');
  }
  return {
    resultDigest: result.resultDigest,
    trustDomain: result.trustDomain,
    verifierProvenanceId: result.verifierProvenanceId,
    verifierVersion: result.verifierVersion,
  };
}

/**
 * Produce a `VerifiedContainmentBinding` only when the candidate was genuinely issued (B-2) AND BOTH
 * independent channels VERIFIED the identical subject. Missing, malformed, failed, unavailable,
 * mismatched, or uncertain verification fails closed (throws `PreparedContainmentError`) and NEVER issues
 * a binding. The issued binding is registered so it cannot later be forged (B-1).
 */
export function prepareVerifiedContainmentBinding(input: {
  candidate: ContainmentCandidateBinding;
  channelA: ContainmentVerificationChannel;
  channelB: ContainmentVerificationChannel;
}): VerifiedContainmentBinding {
  const { candidate, channelA, channelB } = input;
  // B-2: only a candidate this module issued may be prepared. Literals/spread copies are rejected here.
  if (candidate?.schemaVersion !== CONTAINMENT_CANDIDATE_BINDING_SCHEMA || !issuedCandidates.has(candidate)) {
    throw new PreparedContainmentError('CONTAINMENT_CANDIDATE_NOT_ISSUED');
  }
  if (channelA?.channel !== 'A' || channelB?.channel !== 'B') {
    throw new PreparedContainmentError('CHANNEL_DISAGREEMENT');
  }
  const subject: ContainmentVerificationSubject = Object.freeze({
    candidate,
    securityProfileDigest: candidate.securityProfileDigest,
    providerBindingDigest: candidate.providerBindingDigest,
    instanceIdentityDigest: candidate.instanceIdentityDigest,
    expectedModelDigest: candidate.expectedModelDigest,
  });
  // Independently invoke each channel. Both must VERIFY the exact same subject.
  const resultA = channelA.verify(subject);
  const resultB = channelB.verify(subject);
  const factsA = requireChannelVerified(resultA, subject, 'A');
  const factsB = requireChannelVerified(resultB, subject, 'B');
  const channelAResultDigest = factsA.resultDigest;
  const channelBResultDigest = factsB.resultDigest;
  // Independence: the two verifier identities AND their durable provenance identities must differ (a
  // single verifier/provenance cannot satisfy both channels — Item 1/§9-B).
  if (factsA.verifierVersion === factsB.verifierVersion) {
    throw new PreparedContainmentError('CHANNEL_DISAGREEMENT');
  }
  if (factsA.verifierProvenanceId === factsB.verifierProvenanceId) {
    throw new PreparedContainmentError('CHANNEL_PROVENANCE_NOT_INDEPENDENT');
  }
  // R3-B3 remediation (B-1): production trust is NEVER derived from channel-returned strings. There is no
  // production verifier issuer or trust anchor in R3-B3, so a channel that self-declares
  // `trustDomain === 'PRODUCTION'` is REJECTED (fail closed) rather than silently trusted or downgraded.
  // Every legitimately issuable binding is stamped TEST; a distinct provenance-id string is NOT itself a
  // trust anchor. A future, separately-authorized production issuer is the only thing that may ever mint
  // PRODUCTION provenance.
  if (factsA.trustDomain !== 'TEST' || factsB.trustDomain !== 'TEST') {
    throw new PreparedContainmentError('SELF_DECLARED_PRODUCTION_TRUST_REJECTED');
  }
  const trustDomain: ContainmentTrustDomain = 'TEST';
  const provenanceShape = {
    provenanceSchema: CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA,
    trustDomain,
    channelAProvenanceId: factsA.verifierProvenanceId,
    channelBProvenanceId: factsB.verifierProvenanceId,
  };
  const provenance: VerifiedContainmentProvenance = Object.freeze({
    ...provenanceShape,
    provenanceDigest: sha256Canonical(CONTAINMENT_PROVENANCE_DIGEST_DOMAIN, provenanceShape),
  });

  const bindingShape = {
    schemaVersion: VERIFIED_CONTAINMENT_BINDING_SCHEMA,
    executionContext: candidate.executionContext,
    providerId: candidate.providerId,
    providerBindingDigest: candidate.providerBindingDigest,
    securityProfileId: candidate.securityProfileId,
    securityProfileDigest: candidate.securityProfileDigest,
    instanceIdentityDigest: candidate.instanceIdentityDigest,
    expectedModelId: candidate.expectedModelId,
    expectedModelDigest: candidate.expectedModelDigest,
    imageDigest: candidate.imageDigest,
    channelAVerifierVersion: factsA.verifierVersion,
    channelBVerifierVersion: factsB.verifierVersion,
    channelAResultDigest,
    channelBResultDigest,
  };
  const binding: VerifiedContainmentBinding = Object.freeze({
    ...bindingShape,
    provenance,
    containmentBindingDigest: containmentBindingDigest(bindingShape),
  });
  issuedVerifiedBindings.add(binding);
  return binding;
}

/**
 * R3-B3 remediation (B-1/§3): production-trust requirement for prepared evidence. There is NO production
 * trust anchor or issuer in R3-B3, so this ALWAYS FAILS CLOSED for every currently-issuable binding.
 * A correct `containmentBindingDigest`, a recomputable `provenanceDigest`, a serialized
 * `trustDomain: 'PRODUCTION'`, or a spread/JSON-round-trip copy are NONE of them a production trust
 * anchor: knowledge of the canonical fields cannot manufacture production authenticity. Malformed input
 * still fails closed. Serializable provenance metadata is explicitly NOT authenticated production
 * provenance; a future, separately-authorized production issuer must supply the real anchor.
 */
export function requireProductionPreparedProvenance(binding: VerifiedContainmentBinding): void {
  // Reject anything that is not a genuinely module-issued, digest-consistent binding first (a bounded,
  // honest classification) — a spread/reconstructed/JSON-round-tripped copy is not WeakSet-registered.
  requireIssuedVerifiedBinding(binding);
  const p = binding.provenance;
  if (!p || p.provenanceSchema !== CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA
    || !CONTAINMENT_TRUST_DOMAINS.includes(p.trustDomain)
    || !isId(p.channelAProvenanceId) || !isId(p.channelBProvenanceId)
    || p.channelAProvenanceId === p.channelBProvenanceId || !isHex64(p.provenanceDigest)) {
    throw new PreparedContainmentError('PREPARED_PROVENANCE_INVALID');
  }
  // No production trust anchor exists in R3-B3. Even a well-formed, issued, TEST-provenance binding is
  // NOT production-trusted, and a `PRODUCTION` string can never be issued (see prepareVerifiedContainment
  // Binding). Fail closed unconditionally — production authenticity is deliberately deferred to a later
  // separately-authorized issuer.
  throw new PreparedContainmentError('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
}

/**
 * R3-B3 remediation (B-1/§2): production-trusted DUAL-channel verification requirement. There is NO
 * production verifier issuer or trust anchor in R3-B3, so this ALWAYS FAILS CLOSED for every currently
 * caller-constructible input. Self-declared `trustDomain: 'PRODUCTION'`, distinct provenance-id strings,
 * a caller-computed matching `resultDigest`, or any combination thereof are NEVER a trust anchor:
 * serialized/returned values alone can never make this succeed. It never inspects caller strings to
 * decide trust — it unconditionally rejects, because a production issuer that could satisfy it does not
 * exist and is deliberately deferred to a later, separately-authorized slice.
 */
export function requireProductionTrustedVerification(
  _resultA: ContainmentChannelResult,
  _resultB: ContainmentChannelResult,
): void {
  throw new PreparedContainmentError('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// B-3 — Contained execution capability is issued, not injected.
//
// There is NO public arbitrary execution-callback / AiProvider / command / socket / endpoint injection
// point. The only contained execution capability is a module-issued deterministic fake, registered in a
// module-private WeakSet and bound to an EXACT `instanceIdentityDigest`. Its `run` is closed over
// module-internal deterministic logic; a caller cannot supply the function body, so it can never wrap
// `hostProvider.execute(...)`. Production runtime capability issuance is deferred to a later slice.
// ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ContainedExecutionInput {
  /** Rendered provider-agnostic prompt text ONLY (no containment/runtime/security fields — those never
   * enter AiRequest). Provided by the future R3-C caller; opaque to this capability. */
  readonly prompt: string;
}

export interface ContainedExecutionResult {
  readonly text: string;
}

/**
 * Opaque contained execution capability. Non-forgeable: the concrete class is module-private and only a
 * module factory can mint + register one. It is bound to an exact containment instance identity digest,
 * and its `run` cannot be supplied by a caller.
 *
 * R3-B3 (Item 2): `capabilityKind` structurally separates a FAKE (test) capability from a future
 * PRODUCTION capability. A FAKE capability is NEVER production-eligible; `requireProductionContainedCapability`
 * rejects it. No production capability issuer exists in R3-B3, so nothing can currently be PRODUCTION.
 */
export interface ContainedExecutionCapability {
  readonly schemaVersion: typeof CONTAINED_EXECUTION_CAPABILITY_SCHEMA;
  readonly capabilityKind: ContainedExecutionCapabilityKind;
  readonly instanceIdentityDigest: string;
}

class IssuedContainedExecutionCapability implements ContainedExecutionCapability {
  readonly schemaVersion = CONTAINED_EXECUTION_CAPABILITY_SCHEMA;
  constructor(
    readonly capabilityKind: ContainedExecutionCapabilityKind,
    readonly instanceIdentityDigest: string,
    /** Module-internal deterministic run. Never caller-supplied; never a host handle. */
    readonly run: (binding: VerifiedContainmentBinding, input: ContainedExecutionInput) => Promise<ContainedExecutionResult>,
  ) {
    Object.freeze(this);
  }
}

const issuedCapabilities = new WeakSet<IssuedContainedExecutionCapability>();

/**
 * R3-B1 test-only deterministic fake contained execution capability. It accepts ONLY a bounded instance
 * identity — NO execution callback, AiProvider, executable, command, endpoint, socket, or generic host
 * function. Its `run` is fixed, deterministic, and closed over module-internal logic, so executing it can
 * never invoke a caller-injected host Provider. This is the intentionally narrow issuance surface for
 * R3-B1; a production runtime capability is a later authorized slice.
 */
export function createFakeContainedExecutionCapability(
  instance: ContainmentInstanceIdentity,
): ContainedExecutionCapability {
  if (instance?.schemaVersion !== CONTAINMENT_INSTANCE_IDENTITY_SCHEMA || !isHex64(instance.instanceIdentityDigest)) {
    throw new PreparedContainmentError('CONTAINMENT_CONFIGURATION_INVALID');
  }
  const capability = new IssuedContainedExecutionCapability(
    'FAKE',
    instance.instanceIdentityDigest,
    // Deterministic, side-effect-free fake. No network, provider, command, or host access.
    async (binding, input) =>
      Object.freeze({
        text: `contained-fake:${binding.containmentBindingDigest.slice(0, 12)}:${input.prompt}`,
      }),
  );
  issuedCapabilities.add(capability);
  return capability;
}

function requireIssuedCapability(capability: ContainedExecutionCapability): IssuedContainedExecutionCapability {
  if (!(capability instanceof IssuedContainedExecutionCapability) || !issuedCapabilities.has(capability)) {
    throw new PreparedContainmentError('EXECUTION_CAPABILITY_NOT_ISSUED');
  }
  return capability;
}

/**
 * R3-B3 (Item 2): production-eligibility requirement for a contained execution capability. It must be a
 * genuinely issued capability (non-forgeable) AND declare `capabilityKind==='PRODUCTION'`. A FAKE/test
 * capability is rejected. No production capability issuer exists in R3-B3, so this ALWAYS fails closed
 * today; it is the seam a future R3-C runtime issuer will satisfy WITHOUT changing R3-B1/B2 guarantees.
 */
export function requireProductionContainedCapability(capability: ContainedExecutionCapability): void {
  const issued = requireIssuedCapability(capability);
  if (issued.capabilityKind !== 'PRODUCTION') {
    throw new PreparedContainmentError('CAPABILITY_NOT_PRODUCTION_ELIGIBLE');
  }
}

const issuedPrepared = new WeakSet<PreparedContainmentExecution>();

/**
 * The ONLY future execution-facing contained capability holder. It encapsulates a genuinely issued
 * `VerifiedContainmentBinding` and a genuinely issued `ContainedExecutionCapability`, and exposes NO raw
 * AiProvider, host executable, command, socket, endpoint, or execution-callback injection point. It is
 * NOT wired into the production ContinuationReceiverExecutionService; production wiring, a real runtime,
 * and production capability issuance remain unauthorized. R3-B2 only projects its verified identity
 * into existing evidence for fake-only integration.
 */
export class PreparedContainmentExecution {
  readonly schemaVersion = PREPARED_CONTAINMENT_EXECUTION_SCHEMA;
  private readonly binding: VerifiedContainmentBinding;
  private readonly capability: IssuedContainedExecutionCapability;

  private constructor(binding: VerifiedContainmentBinding, capability: IssuedContainedExecutionCapability) {
    requireIssuedVerifiedBinding(binding);
    requireIssuedCapability(capability);
    if (capability.instanceIdentityDigest !== binding.instanceIdentityDigest) {
      throw new PreparedContainmentError('EXECUTION_CAPABILITY_INSTANCE_MISMATCH');
    }
    this.binding = binding;
    this.capability = capability;
    issuedPrepared.add(this);
    Object.freeze(this);
  }

  /**
   * Construct the capability holder. It REQUIRES a genuinely issued `VerifiedContainmentBinding` (B-1)
   * and a genuinely issued `ContainedExecutionCapability` (B-3) whose `instanceIdentityDigest` exactly
   * equals the binding's. No raw runner/AiProvider/host handle is accepted.
   */
  static fromVerifiedBinding(
    binding: VerifiedContainmentBinding,
    capability: ContainedExecutionCapability,
  ): PreparedContainmentExecution {
    requireIssuedVerifiedBinding(binding); // B-1: issued + digest recomputed/verified
    const issuedCapability = requireIssuedCapability(capability); // B-3: issued, not a forged object/callback
    if (issuedCapability.instanceIdentityDigest !== binding.instanceIdentityDigest) {
      throw new PreparedContainmentError('EXECUTION_CAPABILITY_INSTANCE_MISMATCH');
    }
    return new PreparedContainmentExecution(binding, issuedCapability);
  }

  /** Pure R3-B1 → R3-A projection. No evidence issuer/runtime is made production-reachable.
   * Both channel versions/results are retained; verifierVersion names this projection protocol.
   * The context was bound BEFORE verification, never supplied after preparation for rebinding. */
  containmentAudit(exactTaskRunId: string): ContinuationContainmentAudit {
    if (!issuedPrepared.has(this)) throw new PreparedContainmentError('VERIFIED_BINDING_NOT_ISSUED');
    requireIssuedVerifiedBinding(this.binding);
    const b = this.binding;
    if (b.executionContext.taskRunId !== exactTaskRunId) {
      throw new PreparedContainmentError('EXACT_RUN_BINDING_MISMATCH');
    }
    const audit = snapshotContainmentAudit({
      schemaVersion: CONTINUATION_CONTAINMENT_AUDIT_SCHEMA,
      binding: { ...b.executionContext, providerId: b.providerId,
        providerBindingDigest: b.providerBindingDigest, containmentBindingDigest: b.containmentBindingDigest,
        securityProfileId: b.securityProfileId, securityProfileDigest: b.securityProfileDigest,
        instanceIdentityDigest: b.instanceIdentityDigest, modelId: b.expectedModelId,
        modelDigest: b.expectedModelDigest, imageDigest: b.imageDigest,
        verifierVersion: 'prepared-containment-v1', channelAVerifierVersion: b.channelAVerifierVersion,
        channelBVerifierVersion: b.channelBVerifierVersion, channelAResultDigest: b.channelAResultDigest,
        channelBResultDigest: b.channelBResultDigest, preflightDisposition: 'VERIFIED',
        modelIntegrityStatus: 'VERIFIED_AT_BIND' },
    }, exactTaskRunId, exactTaskRunId);
    if (!audit) throw new PreparedContainmentError('CONTAINMENT_BINDING_DIGEST_MISMATCH');
    return audit;
  }

  /** Bounded, read-only view of the verified containment binding identity. No host escape hatch. */
  get containmentBindingDigest(): string {
    return this.binding.containmentBindingDigest;
  }

  bindingIdentity(): Readonly<Pick<VerifiedContainmentBinding,
    'providerId' | 'providerBindingDigest' | 'containmentBindingDigest' | 'securityProfileDigest'
    | 'instanceIdentityDigest' | 'expectedModelId' | 'expectedModelDigest'>> {
    return Object.freeze({
      providerId: this.binding.providerId,
      providerBindingDigest: this.binding.providerBindingDigest,
      containmentBindingDigest: this.binding.containmentBindingDigest,
      securityProfileDigest: this.binding.securityProfileDigest,
      instanceIdentityDigest: this.binding.instanceIdentityDigest,
      expectedModelId: this.binding.expectedModelId,
      expectedModelDigest: this.binding.expectedModelDigest,
    });
  }

  /**
   * Future contained execution entry (R3-B1: module-issued fake capability only). It passes ONLY the
   * verified binding and the bounded prompt to the issued capability's fixed `run`; there is no
   * caller-injected function, so it can never invoke a host Provider.
   */
  async execute(input: ContainedExecutionInput): Promise<ContainedExecutionResult> {
    if (!issuedPrepared.has(this)) throw new PreparedContainmentError('VERIFIED_BINDING_NOT_ISSUED');
    return this.capability.run(this.binding, input);
  }
}
