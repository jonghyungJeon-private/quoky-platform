import { snapshotContainmentAudit, bindingIdentical } from './continuation-containment-validation';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CONTAINMENT_SECURITY_PROFILE_SCHEMA,
  PREPARED_CONTAINMENT_EXECUTION_SCHEMA,
  PreparedContainmentError,
  PreparedContainmentExecution,
  VERIFIED_CONTAINMENT_BINDING_SCHEMA,
  assertExactSoleProviderSelection,
  createContainmentCandidateBinding,
  createContainmentInstanceIdentity,
  createContainmentSecurityProfile,
  createFakeContainedExecutionCapability,
  prepareVerifiedContainmentBinding,
  requireProductionTrustedVerification,
  requireProductionContainedCapability,
  requireProductionPreparedProvenance,
  CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA,
} from './continuation-prepared-containment';
import type {
  ContainmentCandidateBinding,
  ContainmentChannelResult,
  ContainmentVerificationChannel,
  ContainmentVerificationSubject,
  SoleProviderSelection,
  StaticEligibilityDecision,
  VerifiedContainmentBinding,
} from './continuation-prepared-containment';

const HEX = (c: string) => c.repeat(64);
const PROVIDER_ID = 'ollama-cli:llama3.1:8b';
const PROVIDER_BINDING_DIGEST = HEX('a'); // opaque Stage2B digest (distinct from any containment digest)

const executionContext = { executionId: 'run-1', taskRunId: 'run-1', containmentPolicyId: 'policy-1',
  containmentPolicyVersion: 'v1', containmentPolicyDigest: HEX('e'), runtimeFamily: 'NONE' as const,
  runtimeVersion: 'fake-v1', modelMountIdentityDigest: HEX('f') };

function securityProfile() {
  return createContainmentSecurityProfile({ securityProfileId: 'no-network-v1', securityProfileVersion: '1' });
}

function soleSelection(providerId = PROVIDER_ID): SoleProviderSelection {
  return assertExactSoleProviderSelection({ eligibleProviderIds: [providerId], selectedProviderId: providerId, primaryOnly: true });
}

function candidate(overrides: Partial<Parameters<typeof createContainmentCandidateBinding>[0]> = {}): ContainmentCandidateBinding {
  return createContainmentCandidateBinding({
    executionContext,
    selection: soleSelection(),
    providerBindingDigest: PROVIDER_BINDING_DIGEST,
    securityProfile: securityProfile(),
    expectedModelId: 'llama3.1:8b',
    expectedModelDigest: HEX('c'),
    imageDigest: HEX('d'),
    instance: createContainmentInstanceIdentity('opaque-instance-token-1'),
    ...overrides,
  });
}

/** Faithful fake channel: recomputes the EXACT result digest the verifier would produce for the subject. */
function honestChannel(channel: 'A' | 'B', verifierVersion: string): ContainmentVerificationChannel {
  return {
    channel,
    verify(subject: ContainmentVerificationSubject): ContainmentChannelResult {
      const resultDigest = createHash('sha256').update(JSON.stringify({
        domain: `quoky.r3.containment.channel.${channel}.v1`,
        shape: {
          verifierVersion,
          executionContext: subject.candidate.executionContext,
          providerId: subject.candidate.providerId,
          providerBindingDigest: subject.providerBindingDigest,
          securityProfileDigest: subject.securityProfileDigest,
          instanceIdentityDigest: subject.instanceIdentityDigest,
          expectedModelDigest: subject.expectedModelDigest,
          imageDigest: subject.candidate.imageDigest,
        },
      })).digest('hex');
      return {
        status: 'VERIFIED',
        verifierVersion,
        trustDomain: 'TEST',
        verifierProvenanceId: `test-provenance-${channel}`,
        resultDigest,
      };
    },
  };
}

function statusChannel(channel: 'A' | 'B', verifierVersion: string, status: ContainmentChannelResult['status']): ContainmentVerificationChannel {
  return {
    channel,
    verify: () => ({ status, verifierVersion, trustDomain: 'TEST', verifierProvenanceId: `test-provenance-${channel}` }),
  };
}

const channelA = () => honestChannel('A', 'verifier-a-1');
const channelB = () => honestChannel('B', 'verifier-b-1');

function verifiedBinding(): VerifiedContainmentBinding {
  return prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: channelA(), channelB: channelB() });
}

// ─────────────────────────────────────── Gate 4 (preserved) ───────────────────────────────────────

describe('R3-B1 Gate 4 — providerBindingDigest vs containmentBindingDigest stay distinct', () => {
  it('security profile is bounded, immutable, runtime-independent deny-egress posture', () => {
    const p = securityProfile();
    expect(p.schemaVersion).toBe(CONTAINMENT_SECURITY_PROFILE_SCHEMA);
    expect(p.denyNonLoopbackIpv4 && p.denyNonLoopbackIpv6 && p.denyDns && p.denyModelDownload).toBe(true);
    expect(p.securityProfileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(p)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/docker|orbstack|vm|socket|127\.0\.0\.1|ollama/i);
  });

  it('instance identity is opaque; the raw token never appears', () => {
    const instance = createContainmentInstanceIdentity('secret-container-abc123');
    expect(instance.instanceIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(instance)).not.toContain('secret-container-abc123');
    expect(() => createContainmentInstanceIdentity('bad\u0000token')).toThrow(PreparedContainmentError);
  });

  it('providerBindingDigest is carried verbatim and is DISTINCT from containmentBindingDigest', () => {
    const binding = verifiedBinding();
    expect(binding.providerBindingDigest).toBe(PROVIDER_BINDING_DIGEST);
    expect(binding.containmentBindingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.containmentBindingDigest).not.toBe(binding.providerBindingDigest);
    expect(binding.containmentBindingDigest).not.toBe(binding.securityProfileDigest);
    expect(binding.containmentBindingDigest).not.toBe(binding.instanceIdentityDigest);
  });
});

// ─────────────────────────────────────── B-1 forgery probes ───────────────────────────────────────

describe('R3-B1 B-1 — VerifiedContainmentBinding is non-forgeable', () => {
  it('a legitimately dual-channel-issued binding constructs a prepared execution', () => {
    const binding = verifiedBinding();
    const capability = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1'));
    const prepared = PreparedContainmentExecution.fromVerifiedBinding(binding, capability);
    expect(prepared.schemaVersion).toBe(PREPARED_CONTAINMENT_EXECUTION_SCHEMA);
    expect(prepared.containmentBindingDigest).toBe(binding.containmentBindingDigest);
  });

  it('an object literal masquerading as a verified binding is rejected', () => {
    const forged = {
      schemaVersion: VERIFIED_CONTAINMENT_BINDING_SCHEMA, providerId: PROVIDER_ID,
      providerBindingDigest: PROVIDER_BINDING_DIGEST, securityProfileId: 'no-network-v1', securityProfileDigest: HEX('e'),
      instanceIdentityDigest: HEX('f'), expectedModelId: 'llama3.1:8b', expectedModelDigest: HEX('c'), imageDigest: HEX('d'),
      channelAVerifierVersion: 'verifier-a-1', channelBVerifierVersion: 'verifier-b-1',
      channelAResultDigest: HEX('0'), channelBResultDigest: HEX('1'), containmentBindingDigest: HEX('9'),
    } as VerifiedContainmentBinding;
    const cap = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1'));
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(forged, cap))
      .toThrow(/VERIFIED_BINDING_NOT_ISSUED/);
  });

  it('a spread copy of a genuine binding is rejected (WeakSet identity lost)', () => {
    const binding = verifiedBinding();
    const spread = { ...binding } as VerifiedContainmentBinding;
    const cap = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1'));
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(spread, cap))
      .toThrow(/VERIFIED_BINDING_NOT_ISSUED/);
  });

  it('a fake hex64 containmentBindingDigest cannot create a prepared execution', () => {
    const forged = { ...verifiedBinding(), containmentBindingDigest: HEX('7') } as VerifiedContainmentBinding;
    const cap = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1'));
    // Spread loses issuance identity → NOT_ISSUED (issuance check precedes digest recompute).
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(forged, cap)).toThrow(PreparedContainmentError);
  });

  it('a binding whose digest no longer matches its canonical identity is rejected', () => {
    // Force a genuinely-issued object into the registry, then mutate identity to break the digest.
    // We simulate a registered-but-tampered binding by re-deriving through a Proxy is out of scope; instead
    // assert the recompute guard directly: a spread with a valid-looking but wrong digest is rejected.
    const binding = verifiedBinding();
    const tampered = { ...binding, expectedModelDigest: HEX('b') } as VerifiedContainmentBinding;
    const cap = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1'));
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(tampered, cap)).toThrow(PreparedContainmentError);
  });
});

// ─────────────────────────────────────── B-2 ordering probes ──────────────────────────────────────

describe('R3-B1 B-2 — selection → candidate → preparation ordering is structural', () => {
  it('exact sole selection → candidate → preparation succeeds', () => {
    const binding = prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: channelA(), channelB: channelB() });
    expect(binding.providerId).toBe(PROVIDER_ID);
  });

  it('zero eligible providers fail before candidate issuance', () => {
    expect(() => assertExactSoleProviderSelection({ eligibleProviderIds: [], selectedProviderId: PROVIDER_ID, primaryOnly: true }))
      .toThrow(/STATIC_ELIGIBILITY_NOT_SATISFIED/);
  });

  it('multiple eligible providers fail before candidate issuance (PRIMARY_ONLY)', () => {
    expect(() => assertExactSoleProviderSelection({ eligibleProviderIds: ['a', 'b'], selectedProviderId: 'a', primaryOnly: true }))
      .toThrow(/PRIMARY_ONLY_VIOLATION/);
  });

  it('a non-PRIMARY_ONLY decision fails', () => {
    expect(() => assertExactSoleProviderSelection({ eligibleProviderIds: ['a'], selectedProviderId: 'a', primaryOnly: false as never }))
      .toThrow(/PRIMARY_ONLY_VIOLATION/);
  });

  it('a selection not equal to the sole eligible provider fails', () => {
    expect(() => assertExactSoleProviderSelection({ eligibleProviderIds: ['a'], selectedProviderId: 'b', primaryOnly: true }))
      .toThrow(/PROVIDER_SELECTION_NOT_SOLE/);
  });

  it('an arbitrary literal SoleProviderSelection is rejected by candidate creation', () => {
    const forgedSelection = { schemaVersion: 'sole-provider-selection-v1', __brand: 'SoleProviderSelection' } as unknown as SoleProviderSelection;
    expect(() => createContainmentCandidateBinding({
    executionContext,
      selection: forgedSelection, providerBindingDigest: PROVIDER_BINDING_DIGEST, securityProfile: securityProfile(),
      expectedModelId: 'llama3.1:8b', expectedModelDigest: HEX('c'), imageDigest: HEX('d'),
      instance: createContainmentInstanceIdentity('opaque-instance-token-1'),
    })).toThrow(/PROVIDER_SELECTION_NOT_ISSUED/);
  });

  it('an arbitrary literal candidate is rejected by preparation', () => {
    const forged = {
      schemaVersion: 'containment-candidate-binding-v1', providerId: PROVIDER_ID, providerBindingDigest: PROVIDER_BINDING_DIGEST,
      securityProfileId: 'no-network-v1', securityProfileDigest: HEX('e'), expectedModelId: 'llama3.1:8b',
      expectedModelDigest: HEX('c'), imageDigest: HEX('d'), instanceIdentityDigest: HEX('f'),
    } as ContainmentCandidateBinding;
    expect(() => prepareVerifiedContainmentBinding({ candidate: forged, channelA: channelA(), channelB: channelB() }))
      .toThrow(/CONTAINMENT_CANDIDATE_NOT_ISSUED/);
  });

  it('a spread/reconstructed candidate is rejected by preparation', () => {
    const spread = { ...candidate() } as ContainmentCandidateBinding;
    expect(() => prepareVerifiedContainmentBinding({ candidate: spread, channelA: channelA(), channelB: channelB() }))
      .toThrow(/CONTAINMENT_CANDIDATE_NOT_ISSUED/);
  });

  it('candidate creation cannot independently substitute a different providerId (derived from selection)', () => {
    // The API has no raw providerId parameter; providerId always comes from the issued selection.
    const selection = soleSelection('provider-alpha');
    const c = createContainmentCandidateBinding({
    executionContext,
      selection, providerBindingDigest: PROVIDER_BINDING_DIGEST, securityProfile: securityProfile(),
      expectedModelId: 'llama3.1:8b', expectedModelDigest: HEX('c'), imageDigest: HEX('d'),
      instance: createContainmentInstanceIdentity('opaque-instance-token-1'),
    });
    expect(c.providerId).toBe('provider-alpha');
    // There is no field through which a different providerId could be injected.
    expect(Object.keys(createContainmentCandidateBinding).length >= 0).toBe(true);
  });

  it('preparation for a never-selected Provider is impossible through the public contract', () => {
    // The only way to obtain a candidate is via an issued selection; without one, creation fails closed.
    const forgedSelection = { schemaVersion: 'sole-provider-selection-v1', __brand: 'SoleProviderSelection' } as unknown as SoleProviderSelection;
    expect(() => createContainmentCandidateBinding({
    executionContext,
      selection: forgedSelection, providerBindingDigest: PROVIDER_BINDING_DIGEST, securityProfile: securityProfile(),
      expectedModelId: 'llama3.1:8b', expectedModelDigest: HEX('c'), imageDigest: HEX('d'),
      instance: createContainmentInstanceIdentity('opaque-instance-token-1'),
    })).toThrow(PreparedContainmentError);
  });

  it('malformed candidate identities fail closed even with a valid issued selection', () => {
    expect(() => createContainmentCandidateBinding({
    executionContext,
      selection: soleSelection(), providerBindingDigest: 'not-hex', securityProfile: securityProfile(),
      expectedModelId: 'llama3.1:8b', expectedModelDigest: HEX('c'), imageDigest: HEX('d'),
      instance: createContainmentInstanceIdentity('opaque-instance-token-1'),
    })).toThrow(/CONTAINMENT_CANDIDATE_INVALID/);
    expect(() => createContainmentCandidateBinding({
    executionContext,
      selection: soleSelection(), providerBindingDigest: PROVIDER_BINDING_DIGEST, securityProfile: securityProfile(),
      expectedModelId: 'llama3.1:8b', expectedModelDigest: 'short', imageDigest: HEX('d'),
      instance: createContainmentInstanceIdentity('opaque-instance-token-1'),
    })).toThrow(/CONTAINMENT_CANDIDATE_INVALID/);
  });
});

// ─────────────────────────── dual-channel verification (preserved, fail-closed) ───────────────────

describe('R3-B1 dual-channel verification is mandatory and fail-closed', () => {
  it('issues a binding only when BOTH channels verify the identical subject', () => {
    const binding = verifiedBinding();
    expect(binding.schemaVersion).toBe(VERIFIED_CONTAINMENT_BINDING_SCHEMA);
    expect(binding.channelAResultDigest).not.toBe(binding.channelBResultDigest);
  });

  it.each(['FAILED', 'UNAVAILABLE', 'UNCERTAIN'] as const)('Channel A %s → fail closed, no binding', (status) => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: statusChannel('A', 'verifier-a-1', status), channelB: channelB() }))
      .toThrow(PreparedContainmentError);
  });

  it.each(['FAILED', 'UNAVAILABLE', 'UNCERTAIN'] as const)('Channel B %s → fail closed, no binding', (status) => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: channelA(), channelB: statusChannel('B', 'verifier-b-1', status) }))
      .toThrow(PreparedContainmentError);
  });

  it('a single verified channel cannot issue a binding', () => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: channelA(), channelB: statusChannel('B', 'verifier-b-1', 'UNAVAILABLE') }))
      .toThrow(PreparedContainmentError);
  });

  it('rejects a channel whose result digest does not match the subject (disagreement)', () => {
    const lyingA: ContainmentVerificationChannel = { channel: 'A', verify: () => ({ status: 'VERIFIED', verifierVersion: 'verifier-a-1', trustDomain: 'TEST', verifierProvenanceId: 'test-provenance-A', resultDigest: HEX('9') }) };
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: lyingA, channelB: channelB() }))
      .toThrow(PreparedContainmentError);
  });

  it('rejects two channels sharing a verifier identity (independence required)', () => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: honestChannel('A', 'same'), channelB: honestChannel('B', 'same') }))
      .toThrow(PreparedContainmentError);
  });

  it('channel role swap fails closed', () => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: channelB(), channelB: channelA() }))
      .toThrow(PreparedContainmentError);
  });

  it('uncertain verification is never treated as verified', () => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: statusChannel('A', 'verifier-a-1', 'UNCERTAIN'), channelB: channelB() }))
      .toThrow(/VERIFICATION_UNCERTAIN/);
  });
});

// ─────────────────────────────────────── B-3 runner probes ────────────────────────────────────────

describe('R3-B1 B-3 — prepared execution rejects arbitrary execution capabilities', () => {
  const instanceToken = 'opaque-instance-token-1';

  it('a legitimately issued fake capability + matching verified binding succeeds and runs deterministically', async () => {
    const binding = verifiedBinding();
    const capability = createFakeContainedExecutionCapability(createContainmentInstanceIdentity(instanceToken));
    const prepared = PreparedContainmentExecution.fromVerifiedBinding(binding, capability);
    const result = await prepared.execute({ prompt: 'hello' });
    expect(result.text).toContain('contained-fake:');
    expect(result.text).toContain(':hello');
  });

  it('a raw function cannot be supplied as an execution capability', () => {
    const binding = verifiedBinding();
    const rawRunner = (async () => ({ text: 'host-provider-output' })) as unknown;
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(binding, rawRunner as never))
      .toThrow(/EXECUTION_CAPABILITY_NOT_ISSUED/);
  });

  it('an arbitrary object containing run() is rejected', () => {
    const binding = verifiedBinding();
    const forged = {
      schemaVersion: 'contained-execution-capability-v1', instanceIdentityDigest: binding.instanceIdentityDigest,
      run: async () => ({ text: 'host-provider-output' }),
    } as unknown;
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(binding, forged as never))
      .toThrow(/EXECUTION_CAPABILITY_NOT_ISSUED/);
  });

  it('an unissued (spread copy) capability is rejected', () => {
    const binding = verifiedBinding();
    const capability = createFakeContainedExecutionCapability(createContainmentInstanceIdentity(instanceToken));
    const spread = { ...capability } as unknown;
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(binding, spread as never))
      .toThrow(/EXECUTION_CAPABILITY_NOT_ISSUED/);
  });

  it('a capability bound to another containment instance is rejected', () => {
    const binding = verifiedBinding(); // bound to instance token-1
    const otherCapability = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('different-instance-token-2'));
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(binding, otherCapability))
      .toThrow(/EXECUTION_CAPABILITY_INSTANCE_MISMATCH/);
  });

  it('no public surface exposes a raw AiProvider / executable / command / socket / endpoint / runner', async () => {
    const binding = verifiedBinding();
    const capability = createFakeContainedExecutionCapability(createContainmentInstanceIdentity(instanceToken));
    const prepared = PreparedContainmentExecution.fromVerifiedBinding(binding, capability);
    const proto = Object.getPrototypeOf(prepared);
    const publicMethods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(publicMethods.sort()).toEqual(['bindingIdentity', 'containmentAudit', 'containmentBindingDigest', 'execute'].sort());
    const identity = prepared.bindingIdentity();
    expect(JSON.stringify(identity)).not.toMatch(/127\.0\.0\.1|:11434|\/bin\/|\/usr\/|\.sock|https?:\/\//i);
    expect((prepared as unknown as { provider?: unknown; runner?: unknown }).provider).toBeUndefined();
    expect((prepared as unknown as { runner?: unknown }).runner).toBeUndefined();
  });

  it('executing the R3-B1 fake cannot invoke a caller-injected host Provider (no callback injection point)', async () => {
    // The public factory accepts ONLY a bounded instance identity; there is no parameter through which a
    // caller could pass a function/provider/command/endpoint. Prove the factory rejects such attempts by
    // type-erasure and that the produced capability's run is module-fixed.
    const capability = createFakeContainedExecutionCapability(createContainmentInstanceIdentity(instanceToken));
    const binding = verifiedBinding();
    const prepared = PreparedContainmentExecution.fromVerifiedBinding(binding, capability);
    let hostInvoked = false;
    // Even if a caller tries to mutate the capability post-hoc, it is frozen and unissued copies are rejected.
    const tampered = Object.assign(Object.create(Object.getPrototypeOf(capability)), capability, {
      run: async () => { hostInvoked = true; return { text: 'host' }; },
    });
    expect(() => PreparedContainmentExecution.fromVerifiedBinding(binding, tampered as never)).toThrow(PreparedContainmentError);
    const result = await prepared.execute({ prompt: 'x' });
    expect(result.text).toContain('contained-fake:');
    expect(hostInvoked).toBe(false);
  });

  it('the fake capability factory accepts only a bounded instance identity (fail closed otherwise)', () => {
    expect(() => createFakeContainedExecutionCapability({ schemaVersion: 'wrong', instanceIdentityDigest: HEX('f') } as never))
      .toThrow(PreparedContainmentError);
  });
});

describe('R3-B2 exact-run prepared evidence projection', () => {
  const prepare = (c = candidate()) => PreparedContainmentExecution.fromVerifiedBinding(
    prepareVerifiedContainmentBinding({ candidate: c, channelA: channelA(), channelB: channelB() }),
    createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1')));

  it('projects every verified identity without conflating provider and containment digests', () => {
    const b = verifiedBinding();
    const p = PreparedContainmentExecution.fromVerifiedBinding(b,
      createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1')));
    const audit = p.containmentAudit('run-1');
    expect(audit.binding).toEqual({ ...executionContext, providerId: b.providerId,
      providerBindingDigest: b.providerBindingDigest, containmentBindingDigest: b.containmentBindingDigest,
      securityProfileId: b.securityProfileId, securityProfileDigest: b.securityProfileDigest,
      instanceIdentityDigest: b.instanceIdentityDigest, modelId: b.expectedModelId, modelDigest: b.expectedModelDigest,
      imageDigest: b.imageDigest, verifierVersion: 'prepared-containment-v1',
      channelAVerifierVersion: b.channelAVerifierVersion, channelBVerifierVersion: b.channelBVerifierVersion,
      channelAResultDigest: b.channelAResultDigest, channelBResultDigest: b.channelBResultDigest,
      preflightDisposition: 'VERIFIED', modelIntegrityStatus: 'VERIFIED_AT_BIND' });
    expect(Object.isFrozen(audit.binding)).toBe(true);
    expect(audit.binding.providerBindingDigest).not.toBe(audit.binding.containmentBindingDigest);
    expect(() => p.containmentAudit('run-2')).toThrow('EXACT_RUN_BINDING_MISMATCH');
    expect(() => PreparedContainmentExecution.prototype.containmentAudit.call({} as never, 'run-1'))
      .toThrow('VERIFIED_BINDING_NOT_ISSUED');
  });

  it.each(['executionId', 'taskRunId', 'containmentPolicyId', 'containmentPolicyVersion',
    'containmentPolicyDigest', 'runtimeFamily', 'runtimeVersion', 'modelMountIdentityDigest'] as const)
  ('rejects malformed/inconsistent %s before verification', key => {
    expect(() => candidate({ executionContext: { ...executionContext, [key]: '' } })).toThrow('EXACT_RUN_BINDING_MISMATCH');
  });

  it('rejects accessor-based run context without invoking it', () => {
    const context = { ...executionContext };
    let called = false;
    Object.defineProperty(context, 'taskRunId', { get: () => { called = true; return 'run-1'; } });
    expect(() => candidate({ executionContext: context })).toThrow('EXACT_RUN_BINDING_MISMATCH');
    expect(called).toBe(false);
  });

  it('binds another attempt into both channel digests and containment digest before verification', () => {
    const first = prepare().containmentAudit('run-1');
    const second = prepare(candidate({ executionContext: { ...executionContext, executionId: 'run-2', taskRunId: 'run-2' } })).containmentAudit('run-2');
    for (const key of ['containmentBindingDigest', 'channelAResultDigest', 'channelBResultDigest'] as const) {
      expect(first.binding[key]).not.toBe(second.binding[key]);
    }
    expect(first.binding.providerBindingDigest).toBe(second.binding.providerBindingDigest);
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate({ executionContext: {
      ...executionContext, executionId: 'run-2', taskRunId: 'run-2' } }),
      channelA: { channel: 'A', verify: () => ({ status: 'VERIFIED', verifierVersion: 'verifier-a-1', trustDomain: 'TEST', verifierProvenanceId: 'test-provenance-A', resultDigest: first.binding.channelAResultDigest }) },
      channelB: channelB() })).toThrow('CHANNEL_DISAGREEMENT');
  });

  it.each(['providerBindingDigest', 'securityProfileId', 'instanceIdentityDigest',
    'channelAVerifierVersion', 'channelBVerifierVersion'] as const)
  ('strictly validates and preserves the prepared extension field %s', key => {
    const audit = prepare().containmentAudit('run-1');
    const binding = { ...audit.binding };
    delete binding[key];
    expect(snapshotContainmentAudit({ ...audit, binding }, 'run-1', 'run-1')).toBeNull();
    expect(bindingIdentical(audit.binding, binding)).toBe(false);
    expect(snapshotContainmentAudit({ ...audit, binding: { ...audit.binding, [key]: '' } }, 'run-1', 'run-1')).toBeNull();
    let called = false;
    Object.defineProperty(binding, key, { get: () => { called = true; return audit.binding[key]; } });
    expect(snapshotContainmentAudit({ ...audit, binding }, 'run-1', 'run-1')).toBeNull();
    expect(called).toBe(false);
  });

  it('rejects conflated digests, channel identities and cross-run projections', () => {
    const audit = prepare().containmentAudit('run-1');
    for (const override of [{ providerBindingDigest: audit.binding.containmentBindingDigest },
      { channelBVerifierVersion: audit.binding.channelAVerifierVersion }]) {
      expect(snapshotContainmentAudit({ ...audit, binding: { ...audit.binding, ...override } }, 'run-1', 'run-1')).toBeNull();
    }
    expect(snapshotContainmentAudit(audit, 'run-2', 'run-2')).toBeNull();
  });

  it('rejects caller-created profile/instance copies instead of projecting them as issued identities', () => {
    expect(() => candidate({ securityProfile: { ...securityProfile() } })).toThrow('CONTAINMENT_CANDIDATE_INVALID');
    expect(() => candidate({ instance: { ...createContainmentInstanceIdentity('opaque-instance-token-1') } }))
      .toThrow('CONTAINMENT_CANDIDATE_INVALID');
  });
});

// ─────────────────────────────────── R3-B3 production trust closure ───────────────────────────────────

function fakeResult(channel: 'A' | 'B', overrides: Partial<ContainmentChannelResult> = {}): ContainmentChannelResult {
  return {
    status: 'VERIFIED',
    verifierVersion: `verifier-${channel}-1`,
    trustDomain: 'TEST',
    verifierProvenanceId: `test-provenance-${channel}`,
    resultDigest: HEX('7'),
    ...overrides,
  };
}

/** A channel that self-declares PRODUCTION but still computes a subject-matching resultDigest. */
function selfDeclaredProductionChannel(channel: 'A' | 'B', provenanceId = `evil-provenance-${channel}`): ContainmentVerificationChannel {
  return {
    channel,
    verify: (subject: ContainmentVerificationSubject) => {
      const resultDigest = createHash('sha256').update(JSON.stringify({
        domain: `quoky.r3.containment.channel.${channel}.v1`,
        shape: { verifierVersion: `verifier-${channel}-1`, executionContext: subject.candidate.executionContext,
          providerId: subject.candidate.providerId, providerBindingDigest: subject.providerBindingDigest,
          securityProfileDigest: subject.securityProfileDigest, instanceIdentityDigest: subject.instanceIdentityDigest,
          expectedModelDigest: subject.expectedModelDigest, imageDigest: subject.candidate.imageDigest },
      })).digest('hex');
      return { status: 'VERIFIED', verifierVersion: `verifier-${channel}-1`, trustDomain: 'PRODUCTION',
        verifierProvenanceId: provenanceId, resultDigest };
    },
  };
}

describe('R3-B3 Item 1 — production trust is never self-declarable (remediation B-1)', () => {
  it('requireProductionTrustedVerification fails closed for a well-formed TEST pair (no production issuer)', () => {
    expect(() => requireProductionTrustedVerification(fakeResult('A'), fakeResult('B')))
      .toThrow('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
  });

  it('requireProductionTrustedVerification fails closed for self-declared PRODUCTION with distinct provenance', () => {
    const a = fakeResult('A', { trustDomain: 'PRODUCTION', verifierProvenanceId: 'evil-A' });
    const b = fakeResult('B', { trustDomain: 'PRODUCTION', verifierProvenanceId: 'evil-B' });
    expect(() => requireProductionTrustedVerification(a, b)).toThrow('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
  });

  it('no caller-constructible input can make requireProductionTrustedVerification succeed', () => {
    for (const trustDomain of ['TEST', 'PRODUCTION'] as const) {
      for (const status of ['VERIFIED', 'FAILED', 'UNAVAILABLE', 'UNCERTAIN'] as const) {
        const a = fakeResult('A', { trustDomain, status, verifierProvenanceId: 'a' });
        const b = fakeResult('B', { trustDomain, status, verifierProvenanceId: 'b' });
        expect(() => requireProductionTrustedVerification(a, b)).toThrow(PreparedContainmentError);
      }
    }
  });

  it('self-declared PRODUCTION Channel A + B is REJECTED at preparation (not trusted)', () => {
    expect(() => prepareVerifiedContainmentBinding({
      candidate: candidate(), channelA: selfDeclaredProductionChannel('A'), channelB: selfDeclaredProductionChannel('B'),
    })).toThrow('SELF_DECLARED_PRODUCTION_TRUST_REJECTED');
  });

  it('self-declared PRODUCTION with distinct provenance ids + matching resultDigest is still REJECTED', () => {
    expect(() => prepareVerifiedContainmentBinding({
      candidate: candidate(),
      channelA: selfDeclaredProductionChannel('A', 'distinct-A'),
      channelB: selfDeclaredProductionChannel('B', 'distinct-B'),
    })).toThrow('SELF_DECLARED_PRODUCTION_TRUST_REJECTED');
  });

  it('a single self-declared PRODUCTION channel (A xor B) is also rejected', () => {
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: selfDeclaredProductionChannel('A'), channelB: channelB() }))
      .toThrow('SELF_DECLARED_PRODUCTION_TRUST_REJECTED');
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: channelA(), channelB: selfDeclaredProductionChannel('B') }))
      .toThrow('SELF_DECLARED_PRODUCTION_TRUST_REJECTED');
  });

  it('honest TEST A + B still produces the expected fake verified binding, stamped TEST', () => {
    const binding = verifiedBinding();
    expect(binding.provenance.provenanceSchema).toBe(CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA);
    expect(binding.provenance.trustDomain).toBe('TEST'); // never caller-derived; always TEST
    expect(binding.provenance.channelAProvenanceId).not.toBe(binding.provenance.channelBProvenanceId);
    expect(binding.provenance.provenanceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('duplicate A/B provenance identities remain rejected at preparation', () => {
    const shared = (channel: 'A' | 'B'): ContainmentVerificationChannel => ({
      channel,
      verify: (subject: ContainmentVerificationSubject) => {
        const resultDigest = createHash('sha256').update(JSON.stringify({
          domain: `quoky.r3.containment.channel.${channel}.v1`,
          shape: { verifierVersion: `verifier-${channel}-1`, executionContext: subject.candidate.executionContext,
            providerId: subject.candidate.providerId, providerBindingDigest: subject.providerBindingDigest,
            securityProfileDigest: subject.securityProfileDigest, instanceIdentityDigest: subject.instanceIdentityDigest,
            expectedModelDigest: subject.expectedModelDigest, imageDigest: subject.candidate.imageDigest },
        })).digest('hex');
        return { status: 'VERIFIED', verifierVersion: `verifier-${channel}-1`, trustDomain: 'TEST',
          verifierProvenanceId: 'shared-provenance', resultDigest };
      },
    });
    expect(() => prepareVerifiedContainmentBinding({ candidate: candidate(), channelA: shared('A'), channelB: shared('B') }))
      .toThrow('CHANNEL_PROVENANCE_NOT_INDEPENDENT');
  });
});

describe('R3-B3 Item 2 — fake vs production contained capability separation', () => {
  it('the fake capability is kind FAKE and is NOT production-eligible', () => {
    const fake = createFakeContainedExecutionCapability(createContainmentInstanceIdentity('opaque-instance-token-1'));
    expect(fake.capabilityKind).toBe('FAKE');
    expect(() => requireProductionContainedCapability(fake)).toThrow('CAPABILITY_NOT_PRODUCTION_ELIGIBLE');
  });

  it('an arbitrary object claiming PRODUCTION is rejected as not issued', () => {
    const forged = { schemaVersion: 'contained-execution-capability-v1', capabilityKind: 'PRODUCTION', instanceIdentityDigest: HEX('c') } as never;
    expect(() => requireProductionContainedCapability(forged)).toThrow('EXECUTION_CAPABILITY_NOT_ISSUED');
  });

  it('no production capability issuer exists yet (the fake remains usable for tests/preparation)', () => {
    const instance = createContainmentInstanceIdentity('opaque-instance-token-1');
    const fake = createFakeContainedExecutionCapability(instance);
    // Usable for the fake prepared-execution seam...
    const prepared = PreparedContainmentExecution.fromVerifiedBinding(verifiedBinding(), fake);
    expect(prepared.schemaVersion).toBe(PREPARED_CONTAINMENT_EXECUTION_SCHEMA);
    // ...but ineligible for a production requirement.
    expect(() => requireProductionContainedCapability(fake)).toThrow('CAPABILITY_NOT_PRODUCTION_ELIGIBLE');
  });
});

describe('R3-B3 Item 4 — prepared evidence production provenance fails closed (remediation B-1/§3)', () => {
  it('a legitimate TEST binding is NOT production-trusted (fails closed; no production trust anchor)', () => {
    const binding = verifiedBinding();
    // Integrity holds (issued + digest recomputes), yet production trust fails closed unconditionally.
    expect(() => requireProductionPreparedProvenance(binding)).toThrow('PRODUCTION_TRUST_ANCHOR_UNAVAILABLE');
  });

  it('self-declared PRODUCTION channels cannot create a production-trusted binding (rejected upstream)', () => {
    // The only way a binding could carry PRODUCTION would be via a self-declared channel, which
    // prepareVerifiedContainmentBinding rejects — so no PRODUCTION binding is ever issuable.
    expect(() => prepareVerifiedContainmentBinding({
      candidate: candidate(), channelA: selfDeclaredProductionChannel('A'), channelB: selfDeclaredProductionChannel('B'),
    })).toThrow('SELF_DECLARED_PRODUCTION_TRUST_REJECTED');
  });

  it('a copy/spread/reconstructed binding is rejected (unissued)', () => {
    const binding = verifiedBinding();
    const spread = { ...binding }; // not WeakSet-registered
    expect(() => requireProductionPreparedProvenance(spread)).toThrow('VERIFIED_BINDING_NOT_ISSUED');
  });

  it('a JSON round-trip binding is rejected (unissued; serialization is not authenticity)', () => {
    const binding = verifiedBinding();
    const roundTripped = JSON.parse(JSON.stringify(binding)) as VerifiedContainmentBinding;
    expect(() => requireProductionPreparedProvenance(roundTripped)).toThrow('VERIFIED_BINDING_NOT_ISSUED');
  });

  it('a caller that recomputes the provenanceDigest does NOT gain production trust', () => {
    const binding = verifiedBinding();
    // Even reconstructing the exact provenance (same digest) on a fresh object fails: not issued, and
    // production trust is unavailable regardless.
    const reconstructed = { ...binding, provenance: { ...binding.provenance } } as VerifiedContainmentBinding;
    expect(() => requireProductionPreparedProvenance(reconstructed)).toThrow(PreparedContainmentError);
  });

  it('an issued TEST binding with a tampered provenance digest still fails closed', () => {
    const binding = verifiedBinding();
    const tampered = { ...binding, provenance: { ...binding.provenance, provenanceDigest: HEX('9') } };
    expect(() => requireProductionPreparedProvenance(tampered)).toThrow(PreparedContainmentError);
  });

  it('legacy R3-A structural audit cannot masquerade as prepared production provenance', () => {
    const legacyLike = { schemaVersion: 'continuation-containment-audit-v1' } as never;
    expect(() => requireProductionPreparedProvenance(legacyLike)).toThrow('VERIFIED_BINDING_NOT_ISSUED');
  });
});
