import { newId } from '../util/id';
import { requireIssuedContainmentInstanceForBinding, requireIssuedVerifiedBinding,
  type TrustIssuanceRecord, type VerifiedContainmentBinding } from './continuation-prepared-containment';
import { requireIssuedTestAttestationSetBinding, type TestAttestationSet } from './production-attestation-contracts';

/** 2B issues TEST binding records only. It has no real root and cannot confer PRODUCTION trust. */
type Issuance = Readonly<{ set: TestAttestationSet; binding: VerifiedContainmentBinding }>;
const issuedTrustRecords = new WeakMap<TrustIssuanceRecord, Issuance>();

export type TrustBindingFailureCode =
  | 'TRUST_ISSUANCE_NOT_ISSUED' | 'TRUST_ISSUANCE_SET_MISMATCH'
  | 'TRUST_ISSUANCE_BINDING_MISMATCH';

export class TrustBindingError extends Error {
  constructor(readonly code: TrustBindingFailureCode) {
    super(code);
    this.name = 'TrustBindingError';
  }
}

/** Internal TEST fixture issuer. No public barrel export and no production issuance branch. */
export function issueTestTrustIssuanceRecord(
  set: TestAttestationSet, binding: VerifiedContainmentBinding,
): TrustIssuanceRecord {
  requireIssuedTestAttestationSetBinding(set, binding);
  requireIssuedContainmentInstanceForBinding(binding, set.channelA.observed.instanceIdentityDigest);
  requireIssuedContainmentInstanceForBinding(binding, set.channelB.observed.instanceIdentityDigest);
  const challenge = set.challenge;
  const record: TrustIssuanceRecord = Object.freeze({
    schemaVersion: 'trust-issuance-record-v1', issuanceId: newId(), trustDomain: 'TEST',
    attestationSetId: set.attestationSetId,
    taskRunId: challenge.taskRunId, executionId: challenge.executionId,
    providerId: challenge.providerId, providerBindingDigest: challenge.providerBindingDigest,
    containmentBindingDigest: challenge.containmentBindingDigest,
  });
  issuedTrustRecords.set(record, Object.freeze({ set, binding }));
  return record;
}

/** Validate exact process-local record, set, and binding identities before using TEST plumbing. */
export function requireIssuedTrustIssuanceRecord(
  record: TrustIssuanceRecord, set: TestAttestationSet, binding: VerifiedContainmentBinding,
): void {
  requireIssuedVerifiedBinding(binding);
  if (!record || typeof record !== 'object' || !issuedTrustRecords.has(record)) {
    throw new TrustBindingError('TRUST_ISSUANCE_NOT_ISSUED');
  }
  const issued = issuedTrustRecords.get(record)!;
  if (issued.set !== set || record.attestationSetId !== set?.attestationSetId) {
    throw new TrustBindingError('TRUST_ISSUANCE_SET_MISMATCH');
  }
  if (issued.binding !== binding || record.containmentBindingDigest !== binding.containmentBindingDigest
    || record.taskRunId !== binding.executionContext.taskRunId
    || record.executionId !== binding.executionContext.executionId
    || record.providerId !== binding.providerId
    || record.providerBindingDigest !== binding.providerBindingDigest) {
    throw new TrustBindingError('TRUST_ISSUANCE_BINDING_MISMATCH');
  }
  requireIssuedTestAttestationSetBinding(set, binding);
  requireIssuedContainmentInstanceForBinding(binding, set.channelA.observed.instanceIdentityDigest);
  requireIssuedContainmentInstanceForBinding(binding, set.channelB.observed.instanceIdentityDigest);
}
