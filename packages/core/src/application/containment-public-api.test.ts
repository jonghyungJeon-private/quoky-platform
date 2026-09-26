import { describe, expect, it } from 'vitest';
import * as core from '@quoky/core';

/**
 * R3-B1 G3A-1 remediation: the deterministic fake contained-execution capability is TEST INFRASTRUCTURE
 * and MUST NOT be reachable through the production `@quoky/core` public API. This asserts against the
 * EFFECTIVE public API surface (the resolved barrel namespace object), not TypeScript declarations or
 * source text — `@quoky/core` resolves to the package barrel (packages/core/src/index.ts) in tests, the
 * same barrel chain production consumers use. The `.` is the only package export; there is no test/
 * internal subpath, and this remediation adds none.
 */
describe('@quoky/core public API surface — R3-B1 fake must not leak (G3A-1)', () => {
  it('does NOT expose createFakeContainedExecutionCapability on the public barrel', () => {
    const surface = core as unknown as Record<string, unknown>;
    expect(surface.createFakeContainedExecutionCapability).toBeUndefined();
    // Belt-and-suspenders: the exact symbol name must not appear as any own key on the public namespace.
    expect(Object.keys(surface)).not.toContain('createFakeContainedExecutionCapability');
    // No accidentally-renamed alias for the fake factory is present either.
    const fakeAliases = Object.keys(surface).filter((k) => /fakeContainedExecution/i.test(k));
    expect(fakeAliases).toEqual([]);
  });

  it('DOES preserve the legitimate production-facing R3-B1 contracts required by future integration', () => {
    const surface = core as unknown as Record<string, unknown>;
    // Runtime (value/function/class) exports must remain reachable.
    for (const name of [
      'CONTAINMENT_SECURITY_PROFILE_SCHEMA',
      'CONTAINMENT_INSTANCE_IDENTITY_SCHEMA',
      'SOLE_PROVIDER_SELECTION_SCHEMA',
      'CONTAINMENT_CANDIDATE_BINDING_SCHEMA',
      'VERIFIED_CONTAINMENT_BINDING_SCHEMA',
      'CONTAINED_EXECUTION_CAPABILITY_SCHEMA',
      'PREPARED_CONTAINMENT_EXECUTION_SCHEMA',
      'PreparedContainmentError',
      'createContainmentSecurityProfile',
      'createContainmentInstanceIdentity',
      'assertExactSoleProviderSelection',
      'createContainmentCandidateBinding',
      'prepareVerifiedContainmentBinding',
      'PreparedContainmentExecution',
    ]) {
      expect(surface[name], `missing production export: ${name}`).toBeDefined();
    }
    // R3-B3 production trust helpers must be reachable through the public barrel.
    for (const name of [
      'requireProductionTrustedVerification',
      'requireProductionContainedCapability',
      'requireProductionPreparedProvenance',
      'CONTAINMENT_TRUST_DOMAINS',
      'CONTAINED_EXECUTION_CAPABILITY_KINDS',
      'CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA',
    ]) {
      expect(surface[name], `missing R3-B3 production export: ${name}`).toBeDefined();
    }
    // Sanity: the preserved production contracts are functionally usable through the public barrel.
    expect(typeof surface.createContainmentSecurityProfile).toBe('function');
    expect(typeof surface.prepareVerifiedContainmentBinding).toBe('function');
    expect(typeof surface.PreparedContainmentExecution).toBe('function'); // class constructor
  });

  it('the contained-execution capability can only be minted inside the module, not via the public API', () => {
    const surface = core as unknown as Record<string, unknown>;
    // There is no public factory to mint a ContainedExecutionCapability through @quoky/core, so
    // PreparedContainmentExecution.fromVerifiedBinding cannot be satisfied with a public-surface object.
    expect(surface.createFakeContainedExecutionCapability).toBeUndefined();
    expect(surface.IssuedContainedExecutionCapability).toBeUndefined(); // module-private class never exported
  });
});
