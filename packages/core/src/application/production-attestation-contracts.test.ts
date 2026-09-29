import { describe, expect, it } from 'vitest';
import { assertExactSoleProviderSelection, createContainmentCandidateBinding,
  createContainmentInstanceIdentity, createContainmentSecurityProfile,
  createSimulatedContainmentVerifier, prepareVerifiedContainmentBinding,
  requireProductionPreparedProvenance, requireProductionTrustedVerification } from './continuation-prepared-containment';
import type { VerifiedContainmentBinding } from './continuation-prepared-containment';
import { AttestationContractError, MAX_PRODUCTION_ATTESTATION_ROUND_TRIP_MS,
  MAX_PRODUCTION_ATTESTATION_VALIDITY_MS, TEST_ATTESTATION_SOURCE_KINDS,
  attestationSetIdFor, createSimulatedAttestationEvidence, formTestAttestationSet,
  issueProductionAttestationChallenge, requireCurrentTestAttestationSet } from './production-attestation-contracts';
import type { ProductionAttestationChallenge } from './production-attestation-contracts';

const HEX = (digit: string) => digit.repeat(64);

function binding(): VerifiedContainmentBinding {
  const candidate = createContainmentCandidateBinding({
    executionContext: { executionId: 'run-1', taskRunId: 'run-1', containmentPolicyId: 'policy-1',
      containmentPolicyVersion: 'v1', containmentPolicyDigest: HEX('1'), runtimeFamily: 'NONE',
      runtimeVersion: 'fake-v1', modelMountIdentityDigest: HEX('2') },
    selection: assertExactSoleProviderSelection({ eligibleProviderIds: ['test-provider'],
      selectedProviderId: 'test-provider', primaryOnly: true }),
    providerBindingDigest: HEX('3'), securityProfile: createContainmentSecurityProfile({
      securityProfileId: 'deny-egress', securityProfileVersion: 'v1' }),
    expectedModelId: 'model', expectedModelDigest: HEX('4'), imageDigest: HEX('5'),
    instance: createContainmentInstanceIdentity('test-instance'),
  });
  return prepareVerifiedContainmentBinding({ candidate,
    channelA: createSimulatedContainmentVerifier('A', 'sim-a-v1', 'sim-a'),
    channelB: createSimulatedContainmentVerifier('B', 'sim-b-v1', 'sim-b') });
}

function fixture() {
  let now = 100;
  const clock = { nowMs: () => now };
  const b = binding();
  const challenge = issueProductionAttestationChallenge({ binding: b,
    expectedEgressIsolationDigest: HEX('6'), clock });
  const a = createSimulatedAttestationEvidence({ challenge, channel: 'A',
    signerProvenanceId: 'signer-a', verifierProvenanceId: 'verifier-a' });
  const c = createSimulatedAttestationEvidence({ challenge, channel: 'B',
    signerProvenanceId: 'signer-b', verifierProvenanceId: 'verifier-b' });
  const form = (channelA = a, channelB = c) => formTestAttestationSet({ challenge, channelA, channelB,
    testRoundTripBoundMs: 20, testValidityBoundMs: 30 });
  return { binding: b, challenge, a, b: c, form, setNow: (value: number) => { now = value; }, clock };
}

describe('R3-B3-2A process-local challenge and TEST attestation contracts', () => {
  it('issues a challenge against an issued binding using Quoky-local time and shared IDs', () => {
    const f = fixture();
    expect(f.challenge.challengeId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.challenge.nonce).not.toBe(f.challenge.challengeId);
    expect(f.challenge.issuedAtLocalMonoMs).toBe(100);
    expect(f.challenge.taskRunId).toBe(f.binding.executionContext.taskRunId);
    expect(f.challenge.providerBindingDigest).toBe(f.binding.providerBindingDigest);
    expect(f.challenge.containmentBindingDigest).toBe(f.binding.containmentBindingDigest);
    expect(Object.isFrozen(f.challenge)).toBe(true);
    expect(attestationSetIdFor(f.challenge)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects structural and JSON-reconstructed challenges and bindings', () => {
    const f = fixture();
    for (const copy of [{ ...f.challenge }, JSON.parse(JSON.stringify(f.challenge))]) {
      expect(() => attestationSetIdFor(copy as ProductionAttestationChallenge))
        .toThrow('CHALLENGE_NOT_ISSUED');
      expect(() => formTestAttestationSet({ challenge: copy as ProductionAttestationChallenge,
        channelA: f.a, channelB: f.b, testRoundTripBoundMs: 20, testValidityBoundMs: 30 }))
        .toThrow('CHALLENGE_NOT_ISSUED');
    }
    expect(() => issueProductionAttestationChallenge({ binding: { ...f.binding },
      expectedEgressIsolationDigest: HEX('6'), clock: f.clock })).toThrow('VERIFIED_BINDING_NOT_ISSUED');
  });

  it('forms exactly one TEST set and rejects reuse, including a second evidence pair', () => {
    const f = fixture();
    f.setNow(110);
    const set = f.form();
    expect(set.trustDomain).toBe('TEST');
    expect(set.attestationSetId).toBe(attestationSetIdFor(f.challenge));
    expect(set.verifiedReceiptLocalMonoMs).toBe(110);
    expect(set.expiresAtLocalMonoMs).toBe(140);
    expect(() => f.form()).toThrow('CHALLENGE_ALREADY_USED');
    expect(() => requireCurrentTestAttestationSet({ ...set })).toThrow('ATTESTATION_SET_NOT_ISSUED');
    expect(() => requireCurrentTestAttestationSet(JSON.parse(JSON.stringify(set)))).toThrow('ATTESTATION_SET_NOT_ISSUED');
  });

  it('rejects cross-challenge pairing, including a separately issued same-run challenge', () => {
    const f = fixture();
    const other = issueProductionAttestationChallenge({ binding: f.binding,
      expectedEgressIsolationDigest: HEX('6'), clock: f.clock });
    const otherB = createSimulatedAttestationEvidence({ challenge: other, channel: 'B',
      signerProvenanceId: 'signer-b2', verifierProvenanceId: 'verifier-b2' });
    expect(attestationSetIdFor(other)).not.toBe(attestationSetIdFor(f.challenge));
    expect(() => f.form(f.a, otherB)).toThrow('CHALLENGE_MISMATCH');
  });

  it.each([
    ['attestationSetId', 'ATTESTATION_SET_MISMATCH', HEX('a')],
    ['taskRunId', 'TASKRUN_EXECUTION_MISMATCH', 'run-other'],
    ['executionId', 'TASKRUN_EXECUTION_MISMATCH', 'run-other'],
    ['providerBindingDigest', 'PROVIDER_BINDING_MISMATCH', HEX('b')],
    ['providerId', 'PROVIDER_BINDING_MISMATCH', 'other-provider'],
    ['containmentBindingDigest', 'CONTAINMENT_BINDING_MISMATCH', HEX('c')],
  ] as const)('rejects %s mismatch with %s', (field, code, value) => {
    const f = fixture();
    expect(() => f.form(f.a, { ...f.b, [field]: value })).toThrow(code);
  });

  it('rejects role swaps, source-kind swaps, arbitrary kinds, and self-declared PRODUCTION', () => {
    const f = fixture();
    expect(() => f.form(f.b, f.a)).toThrow('CHANNEL_ROLE_MISMATCH');
    expect(() => f.form({ ...f.a, evidenceSourceKind: TEST_ATTESTATION_SOURCE_KINDS.B })).toThrow('EVIDENCE_SOURCE_KIND_MISMATCH');
    expect(() => f.form({ ...f.a, evidenceSourceKind: 'CALLER_DEFINED' } as never)).toThrow('EVIDENCE_SOURCE_KIND_MISMATCH');
    expect(() => f.form({ ...f.a, trustDomain: 'PRODUCTION' } as never)).toThrow('VERIFICATION_UNCERTAIN');
    expect(f.a.trustDomain).toBe('TEST');
    expect(f.b.trustDomain).toBe('TEST');
    expect(f.a.evidenceSourceKind).toBe('TEST_SIMULATED_EXTERNAL_INSPECTION');
    expect(f.b.evidenceSourceKind).toBe('TEST_SIMULATED_IN_INSTANCE_SELF_CHECK');
  });

  it('rejects mismatched simulated measurements and altered TEST integrity', () => {
    const f = fixture();
    expect(() => f.form({ ...f.a, observed: { ...f.a.observed, imageDigest: HEX('e') } })).toThrow('EVIDENCE_FACT_MISMATCH');
    expect(() => f.form({ ...f.a, verificationIdentityDigest: HEX('e') })).toThrow('EVIDENCE_INTEGRITY_INVALID');
    expect(() => f.form({ ...f.a, signerProvenanceId: f.b.signerProvenanceId })).toThrow('EVIDENCE_INTEGRITY_INVALID');
    expect(() => f.form({ ...f.a, arbitraryPayload: 'not bounded' } as never)).toThrow('EVIDENCE_INTEGRITY_INVALID');
    expect(() => f.form({ ...f.a, observed: { ...f.a.observed, extra: 'not bounded' } } as never))
      .toThrow('EVIDENCE_INTEGRITY_INVALID');
  });

  it('invalid evidence does not claim a challenge; distinct signer labels remain necessary', () => {
    const f = fixture();
    expect(() => f.form({ ...f.a, providerBindingDigest: HEX('e') })).toThrow('PROVIDER_BINDING_MISMATCH');
    const sameSignerB = createSimulatedAttestationEvidence({ challenge: f.challenge, channel: 'B',
      signerProvenanceId: f.a.signerProvenanceId, verifierProvenanceId: 'verifier-b' });
    expect(() => f.form(f.a, sameSignerB)).toThrow('SIGNER_PROVENANCE_NOT_DISTINCT');
    expect(f.form().trustDomain).toBe('TEST');
  });

  it('uses only the local round-trip clock and ignores source timestamps for freshness', () => {
    const f = fixture();
    const a = createSimulatedAttestationEvidence({ challenge: f.challenge, channel: 'A',
      signerProvenanceId: 'signer-a', verifierProvenanceId: 'verifier-a', sourceTimestampMs: -9_000_000 });
    const b = createSimulatedAttestationEvidence({ challenge: f.challenge, channel: 'B',
      signerProvenanceId: 'signer-b', verifierProvenanceId: 'verifier-b', sourceTimestampMs: 9_000_000 });
    f.setNow(119);
    expect(f.form(a, b).verifiedReceiptLocalMonoMs).toBe(119);
    const late = fixture();
    late.setNow(121);
    expect(() => late.form()).toThrow('ATTESTATION_STALE');
  });

  it('separates post-receipt validity from challenge round-trip freshness', () => {
    const f = fixture();
    f.setNow(110);
    const set = f.form();
    f.setNow(139);
    expect(() => requireCurrentTestAttestationSet(set)).not.toThrow();
    f.setNow(140);
    expect(() => requireCurrentTestAttestationSet(set)).toThrow('ATTESTATION_STALE');
    expect(MAX_PRODUCTION_ATTESTATION_ROUND_TRIP_MS).toBe('CALIBRATION_REQUIRED');
    expect(MAX_PRODUCTION_ATTESTATION_VALIDITY_MS).toBe('CALIBRATION_REQUIRED');
  });

  it('cannot turn simulated A+B or an issued challenge into production trust', () => {
    const f = fixture();
    const set = f.form();
    expect(set.trustDomain).toBe('TEST');
    expect(() => requireProductionTrustedVerification(f.a as never, f.b as never))
      .toThrow('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
    expect(() => requireProductionPreparedProvenance(f.binding))
      .toThrow('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
    expect(AttestationContractError).toBeDefined();
  });
});
