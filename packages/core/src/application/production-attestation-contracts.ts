import { newId } from '../util/id';
import { sha256Canonical } from './canonical-digest';
import { SYSTEM_MONOTONIC_CLOCK, type MonotonicClock } from './deadline-policy';
import { CONTAINMENT_VERIFIER_ROLES, requireIssuedVerifiedBinding,
  type ContainmentVerifierRole, type VerifiedContainmentBinding } from './continuation-prepared-containment';

/** R3-B3-2A contracts only. Nothing here verifies a real runtime or issues production trust. */
export const PRODUCTION_ATTESTATION_CHALLENGE_SCHEMA = 'production-attestation-challenge-v1' as const;
export const PRODUCTION_ATTESTATION_EVIDENCE_SCHEMA = 'production-attestation-evidence-v1' as const;
export const TEST_ATTESTATION_SET_SCHEMA = 'test-attestation-set-v1' as const;
export const MAX_PRODUCTION_ATTESTATION_ROUND_TRIP_MS = 'CALIBRATION_REQUIRED' as const;
export const MAX_PRODUCTION_ATTESTATION_VALIDITY_MS = 'CALIBRATION_REQUIRED' as const;

/** Closed source kinds: no production source is implemented or issuable in 2A. */
export const TEST_ATTESTATION_SOURCE_KINDS = Object.freeze({
  A: 'TEST_SIMULATED_EXTERNAL_INSPECTION',
  B: 'TEST_SIMULATED_IN_INSTANCE_SELF_CHECK',
} as const);
export type TestAttestationSourceKind = typeof TEST_ATTESTATION_SOURCE_KINDS[keyof typeof TEST_ATTESTATION_SOURCE_KINDS];

/** Closed role/domain/source policy. Echoing expected facts is deterministic TEST validation only. */
export const TEST_ATTESTATION_SOURCE_POLICY = Object.freeze({
  [TEST_ATTESTATION_SOURCE_KINDS.A]: Object.freeze({
    allowedRole: CONTAINMENT_VERIFIER_ROLES.A, trustDomain: 'TEST',
    validationRule: 'DETERMINISTIC_EXPECTED_FACT_ECHO', testOnly: true,
  }),
  [TEST_ATTESTATION_SOURCE_KINDS.B]: Object.freeze({
    allowedRole: CONTAINMENT_VERIFIER_ROLES.B, trustDomain: 'TEST',
    validationRule: 'DETERMINISTIC_EXPECTED_FACT_ECHO', testOnly: true,
  }),
} as const);

export type AttestationContractFailureCode =
  | 'CHALLENGE_NOT_ISSUED' | 'CHALLENGE_ALREADY_USED' | 'CHALLENGE_MISMATCH'
  | 'ATTESTATION_SET_MISMATCH' | 'CHANNEL_ROLE_MISMATCH' | 'EVIDENCE_SOURCE_KIND_MISMATCH'
  | 'TASKRUN_EXECUTION_MISMATCH' | 'PROVIDER_BINDING_MISMATCH' | 'CONTAINMENT_BINDING_MISMATCH'
  | 'ATTESTATION_STALE' | 'VERIFICATION_UNCERTAIN' | 'EVIDENCE_FACT_MISMATCH'
  | 'EVIDENCE_INTEGRITY_INVALID' | 'SIGNER_PROVENANCE_NOT_DISTINCT'
  | 'ATTESTATION_CONFIGURATION_INVALID' | 'ATTESTATION_SET_NOT_ISSUED';

export class AttestationContractError extends Error {
  constructor(readonly code: AttestationContractFailureCode) {
    super(code);
    this.name = 'AttestationContractError';
  }
}

export interface ProductionAttestationChallenge {
  readonly schemaVersion: typeof PRODUCTION_ATTESTATION_CHALLENGE_SCHEMA;
  readonly challengeId: string;
  readonly nonce: string;
  readonly taskRunId: string;
  readonly executionId: string;
  /** Routing/binding authority facts, never independently observed runtime facts. */
  readonly providerId: string;
  readonly providerBindingDigest: string;
  readonly containmentBindingDigest: string;
  readonly issuedAtLocalMonoMs: number;
}

/** These are simulated measurements in 2A, not independently observed production facts. */
export interface AttestationObservedFacts {
  readonly instanceIdentityDigest: string;
  readonly imageDigest: string;
  readonly runtimeFamily: string;
  readonly runtimeVersion: string;
  readonly modelDigest: string;
  readonly modelMountIdentityDigest: string;
  readonly securityProfileDigest: string;
  readonly containmentPolicyDigest: string;
  readonly egressIsolationDigest: string;
}

export interface TestAttestationEvidence {
  readonly schemaVersion: typeof PRODUCTION_ATTESTATION_EVIDENCE_SCHEMA;
  readonly trustDomain: 'TEST';
  readonly challengeId: string;
  readonly nonce: string;
  readonly attestationSetId: string;
  readonly verifierRole: ContainmentVerifierRole;
  readonly evidenceSourceKind: TestAttestationSourceKind;
  readonly taskRunId: string;
  readonly executionId: string;
  readonly providerId: string;
  readonly providerBindingDigest: string;
  readonly containmentBindingDigest: string;
  readonly observed: AttestationObservedFacts;
  readonly signerProvenanceId: string;
  readonly verifierProvenanceId: string;
  /** Deterministic TEST integrity identity; not a live signature or trust root. */
  readonly verificationIdentityDigest: string;
  /** External source time is audit metadata only; it never participates in Quoky freshness. */
  readonly sourceTimestampMs?: number;
}

export interface TestAttestationSet {
  readonly schemaVersion: typeof TEST_ATTESTATION_SET_SCHEMA;
  readonly trustDomain: 'TEST';
  readonly challenge: ProductionAttestationChallenge;
  readonly attestationSetId: string;
  readonly channelA: TestAttestationEvidence;
  readonly channelB: TestAttestationEvidence;
  readonly verifiedReceiptLocalMonoMs: number;
  readonly expiresAtLocalMonoMs: number;
}

type ChallengeRecord = {
  readonly binding: VerifiedContainmentBinding;
  readonly clock: MonotonicClock;
  readonly expectedEgressIsolationDigest: string;
  readonly beforeMono: number;
  claimed: boolean;
};
const issuedChallenges = new WeakMap<ProductionAttestationChallenge, ChallengeRecord>();
const issuedSets = new WeakMap<TestAttestationSet, MonotonicClock>();
const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

function hasBoundedDataKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) return false;
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))
      && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

const EVIDENCE_KEYS = ['schemaVersion', 'trustDomain', 'challengeId', 'nonce', 'attestationSetId',
  'verifierRole', 'evidenceSourceKind', 'taskRunId', 'executionId', 'providerId', 'providerBindingDigest',
  'containmentBindingDigest', 'observed', 'signerProvenanceId', 'verifierProvenanceId',
  'verificationIdentityDigest'] as const;
const OBSERVED_KEYS = ['instanceIdentityDigest', 'imageDigest', 'runtimeFamily', 'runtimeVersion',
  'modelDigest', 'modelMountIdentityDigest', 'securityProfileDigest', 'containmentPolicyDigest',
  'egressIsolationDigest'] as const;

function recordFor(challenge: ProductionAttestationChallenge): ChallengeRecord {
  if (!challenge || typeof challenge !== 'object' || !issuedChallenges.has(challenge)) {
    throw new AttestationContractError('CHALLENGE_NOT_ISSUED');
  }
  return issuedChallenges.get(challenge)!;
}

/** Issue against an exact in-process verified binding using Quoky's own monotonic clock and shared ID utility. */
export function issueProductionAttestationChallenge(input: Readonly<{
  binding: VerifiedContainmentBinding;
  expectedEgressIsolationDigest: string;
  clock?: MonotonicClock;
}>): ProductionAttestationChallenge {
  requireIssuedVerifiedBinding(input.binding);
  const b = input.binding;
  const beforeMono = (input.clock ?? SYSTEM_MONOTONIC_CLOCK).nowMs();
  if (!finiteNonnegative(beforeMono) || !HEX64.test(input.expectedEgressIsolationDigest)) {
    throw new AttestationContractError('ATTESTATION_CONFIGURATION_INVALID');
  }
  if (b.executionContext.taskRunId !== b.executionContext.executionId) {
    throw new AttestationContractError('TASKRUN_EXECUTION_MISMATCH');
  }
  const challenge = Object.freeze({
    schemaVersion: PRODUCTION_ATTESTATION_CHALLENGE_SCHEMA,
    challengeId: newId(), nonce: newId(),
    taskRunId: b.executionContext.taskRunId, executionId: b.executionContext.executionId,
    providerId: b.providerId, providerBindingDigest: b.providerBindingDigest,
    containmentBindingDigest: b.containmentBindingDigest, issuedAtLocalMonoMs: beforeMono,
  });
  issuedChallenges.set(challenge, { binding: b, clock: input.clock ?? SYSTEM_MONOTONIC_CLOCK,
    expectedEgressIsolationDigest: input.expectedEgressIsolationDigest, beforeMono, claimed: false });
  return challenge;
}

/** Deterministic identity over the exact challenge and binding subject; authenticity stays in the WeakMap. */
export function attestationSetIdFor(challenge: ProductionAttestationChallenge): string {
  recordFor(challenge);
  return sha256Canonical('quoky.r3.production-attestation-set.v1', {
    challengeId: challenge.challengeId, nonce: challenge.nonce,
    taskRunId: challenge.taskRunId, executionId: challenge.executionId,
    providerId: challenge.providerId, providerBindingDigest: challenge.providerBindingDigest,
    containmentBindingDigest: challenge.containmentBindingDigest,
  });
}

function expectedObservedFacts(record: ChallengeRecord): AttestationObservedFacts {
  const b = record.binding;
  return Object.freeze({
    instanceIdentityDigest: b.instanceIdentityDigest, imageDigest: b.imageDigest,
    runtimeFamily: b.executionContext.runtimeFamily, runtimeVersion: b.executionContext.runtimeVersion,
    modelDigest: b.expectedModelDigest, modelMountIdentityDigest: b.executionContext.modelMountIdentityDigest,
    securityProfileDigest: b.securityProfileDigest,
    containmentPolicyDigest: b.executionContext.containmentPolicyDigest,
    egressIsolationDigest: record.expectedEgressIsolationDigest,
  });
}

function evidenceShape(e: Omit<TestAttestationEvidence, 'verificationIdentityDigest'>) {
  return { schemaVersion: e.schemaVersion, trustDomain: e.trustDomain,
    challengeId: e.challengeId, nonce: e.nonce, attestationSetId: e.attestationSetId,
    verifierRole: e.verifierRole, evidenceSourceKind: e.evidenceSourceKind,
    taskRunId: e.taskRunId, executionId: e.executionId, providerId: e.providerId,
    providerBindingDigest: e.providerBindingDigest, containmentBindingDigest: e.containmentBindingDigest,
    observed: e.observed, signerProvenanceId: e.signerProvenanceId,
    verifierProvenanceId: e.verifierProvenanceId,
    ...(e.sourceTimestampMs === undefined ? {} : { sourceTimestampMs: e.sourceTimestampMs }),
  };
}

/** Internal deterministic TEST fixture. Workload use cannot make Channel A production-eligible. */
export function createSimulatedAttestationEvidence(input: Readonly<{
  challenge: ProductionAttestationChallenge;
  channel: 'A' | 'B';
  signerProvenanceId: string;
  verifierProvenanceId: string;
  sourceTimestampMs?: number;
}>): TestAttestationEvidence {
  const record = recordFor(input.challenge);
  if ((input.channel !== 'A' && input.channel !== 'B') || !ID.test(input.signerProvenanceId)
    || !ID.test(input.verifierProvenanceId)
    || (input.sourceTimestampMs !== undefined && !Number.isFinite(input.sourceTimestampMs))) {
    throw new AttestationContractError('ATTESTATION_CONFIGURATION_INVALID');
  }
  const c = input.challenge;
  const shape = evidenceShape({ schemaVersion: PRODUCTION_ATTESTATION_EVIDENCE_SCHEMA,
    trustDomain: 'TEST', challengeId: c.challengeId, nonce: c.nonce,
    attestationSetId: attestationSetIdFor(c), verifierRole: CONTAINMENT_VERIFIER_ROLES[input.channel],
    evidenceSourceKind: TEST_ATTESTATION_SOURCE_KINDS[input.channel],
    taskRunId: c.taskRunId, executionId: c.executionId, providerId: c.providerId,
    providerBindingDigest: c.providerBindingDigest, containmentBindingDigest: c.containmentBindingDigest,
    observed: expectedObservedFacts(record), signerProvenanceId: input.signerProvenanceId,
    verifierProvenanceId: input.verifierProvenanceId,
    ...(input.sourceTimestampMs === undefined ? {} : { sourceTimestampMs: input.sourceTimestampMs }),
  });
  return Object.freeze({ ...shape,
    verificationIdentityDigest: sha256Canonical('quoky.r3.test-attestation-evidence.v1', shape) });
}

function validateEvidence(
  evidence: TestAttestationEvidence, channel: 'A' | 'B', challenge: ProductionAttestationChallenge,
  record: ChallengeRecord, setId: string,
): void {
  if (!hasBoundedDataKeys(evidence, EVIDENCE_KEYS, ['sourceTimestampMs'])) {
    throw new AttestationContractError('EVIDENCE_INTEGRITY_INVALID');
  }
  if (evidence.schemaVersion !== PRODUCTION_ATTESTATION_EVIDENCE_SCHEMA
    || evidence.trustDomain !== 'TEST') throw new AttestationContractError('VERIFICATION_UNCERTAIN');
  if (!hasBoundedDataKeys(evidence.observed, OBSERVED_KEYS)) {
    throw new AttestationContractError('EVIDENCE_INTEGRITY_INVALID');
  }
  if (evidence.verifierRole !== CONTAINMENT_VERIFIER_ROLES[channel]) {
    throw new AttestationContractError('CHANNEL_ROLE_MISMATCH');
  }
  const sourcePolicy = TEST_ATTESTATION_SOURCE_POLICY[evidence.evidenceSourceKind as TestAttestationSourceKind];
  if (!sourcePolicy || evidence.evidenceSourceKind !== TEST_ATTESTATION_SOURCE_KINDS[channel]
    || sourcePolicy.allowedRole !== evidence.verifierRole || sourcePolicy.trustDomain !== evidence.trustDomain
    || sourcePolicy.testOnly !== true) {
    throw new AttestationContractError('EVIDENCE_SOURCE_KIND_MISMATCH');
  }
  if (evidence.challengeId !== challenge.challengeId || evidence.nonce !== challenge.nonce) {
    throw new AttestationContractError('CHALLENGE_MISMATCH');
  }
  if (evidence.attestationSetId !== setId) throw new AttestationContractError('ATTESTATION_SET_MISMATCH');
  if (evidence.taskRunId !== challenge.taskRunId || evidence.executionId !== challenge.executionId
    || evidence.taskRunId !== evidence.executionId) {
    throw new AttestationContractError('TASKRUN_EXECUTION_MISMATCH');
  }
  if (evidence.providerId !== challenge.providerId
    || evidence.providerBindingDigest !== challenge.providerBindingDigest) {
    throw new AttestationContractError('PROVIDER_BINDING_MISMATCH');
  }
  if (evidence.containmentBindingDigest !== challenge.containmentBindingDigest) {
    throw new AttestationContractError('CONTAINMENT_BINDING_MISMATCH');
  }
  const expected = expectedObservedFacts(record);
  if (!evidence.observed || Object.keys(expected).some(key =>
    evidence.observed[key as keyof AttestationObservedFacts] !== expected[key as keyof AttestationObservedFacts])) {
    throw new AttestationContractError('EVIDENCE_FACT_MISMATCH');
  }
  if (!ID.test(evidence.signerProvenanceId) || !ID.test(evidence.verifierProvenanceId)
    || (evidence.sourceTimestampMs !== undefined && !Number.isFinite(evidence.sourceTimestampMs))
    || !HEX64.test(evidence.verificationIdentityDigest)
    || evidence.verificationIdentityDigest !== sha256Canonical('quoky.r3.test-attestation-evidence.v1', evidenceShape(evidence))) {
    throw new AttestationContractError('EVIDENCE_INTEGRITY_INVALID');
  }
}

/** TEST-only formation. Bounds are fixture inputs, never production policy or a production trust decision. */
export function formTestAttestationSet(input: Readonly<{
  challenge: ProductionAttestationChallenge;
  channelA: TestAttestationEvidence;
  channelB: TestAttestationEvidence;
  testRoundTripBoundMs: number;
  testValidityBoundMs: number;
}>): TestAttestationSet {
  const record = recordFor(input.challenge);
  if (record.claimed) throw new AttestationContractError('CHALLENGE_ALREADY_USED');
  if (!Number.isFinite(input.testRoundTripBoundMs) || input.testRoundTripBoundMs <= 0
    || !Number.isFinite(input.testValidityBoundMs) || input.testValidityBoundMs <= 0) {
    throw new AttestationContractError('ATTESTATION_CONFIGURATION_INVALID');
  }
  const setId = attestationSetIdFor(input.challenge);
  validateEvidence(input.channelA, 'A', input.challenge, record, setId);
  validateEvidence(input.channelB, 'B', input.challenge, record, setId);
  if (input.channelA.signerProvenanceId === input.channelB.signerProvenanceId
    || input.channelA.verifierProvenanceId === input.channelB.verifierProvenanceId) {
    throw new AttestationContractError('SIGNER_PROVENANCE_NOT_DISTINCT');
  }
  const afterMono = record.clock.nowMs();
  if (!finiteNonnegative(afterMono) || afterMono < record.beforeMono
    || afterMono - record.beforeMono > input.testRoundTripBoundMs) {
    throw new AttestationContractError('ATTESTATION_STALE');
  }
  const expiresAt = afterMono + input.testValidityBoundMs;
  if (!Number.isFinite(expiresAt)) throw new AttestationContractError('ATTESTATION_CONFIGURATION_INVALID');
  record.claimed = true;
  const set = Object.freeze({ schemaVersion: TEST_ATTESTATION_SET_SCHEMA, trustDomain: 'TEST' as const,
    challenge: input.challenge, attestationSetId: setId,
    channelA: input.channelA, channelB: input.channelB,
    verifiedReceiptLocalMonoMs: afterMono, expiresAtLocalMonoMs: expiresAt });
  issuedSets.set(set, record.clock);
  return set;
}

/** Quoky-local post-receipt currentness, separate from request round-trip freshness. */
export function requireCurrentTestAttestationSet(set: TestAttestationSet): void {
  if (!set || typeof set !== 'object' || !issuedSets.has(set)) {
    throw new AttestationContractError('ATTESTATION_SET_NOT_ISSUED');
  }
  const now = issuedSets.get(set)!.nowMs();
  if (!finiteNonnegative(now) || now < set.verifiedReceiptLocalMonoMs || now >= set.expiresAtLocalMonoMs) {
    throw new AttestationContractError('ATTESTATION_STALE');
  }
}
