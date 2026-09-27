import { sha256Canonical } from './canonical-digest';
import type { ContainmentBindingEvidence } from '../ports/continuation-containment-audit';

export const VERIFIED_CONTAINMENT_BINDING_SCHEMA = 'verified-containment-binding-v1' as const;
const CONTAINMENT_BINDING_DIGEST_DOMAIN = 'quoky.r3.containment.binding.v1' as const;

type BindingFacts = Pick<Required<ContainmentBindingEvidence>,
  'providerId' | 'providerBindingDigest' | 'securityProfileId' | 'securityProfileDigest'
  | 'instanceIdentityDigest' | 'imageDigest' | 'channelAVerifierVersion' | 'channelBVerifierVersion'
  | 'channelAResultDigest' | 'channelBResultDigest'> & {
  readonly executionContext: Pick<ContainmentBindingEvidence,
    'executionId' | 'taskRunId' | 'containmentPolicyId' | 'containmentPolicyVersion'
    | 'containmentPolicyDigest' | 'runtimeFamily' | 'runtimeVersion' | 'modelMountIdentityDigest'>;
  readonly expectedModelId: string;
  readonly expectedModelDigest: string;
};

/** Single internal canonical construction for issuance AND persisted prepared-evidence validation.
 * Keep the existing v1 domain, schema, field order and identity set. Explicit context projection makes
 * JSON property order of deserialized inputs irrelevant. This verifies identity, NOT runtime provenance.
 * Call only with issued facts or freshly validated own-data-descriptor snapshots. */
export function containmentBindingDigest(binding: BindingFacts): string {
  const c = binding.executionContext;
  const shape = {
    schemaVersion: VERIFIED_CONTAINMENT_BINDING_SCHEMA,
    executionContext: {
      executionId: c.executionId, taskRunId: c.taskRunId,
      containmentPolicyId: c.containmentPolicyId, containmentPolicyVersion: c.containmentPolicyVersion,
      containmentPolicyDigest: c.containmentPolicyDigest, runtimeFamily: c.runtimeFamily,
      runtimeVersion: c.runtimeVersion, modelMountIdentityDigest: c.modelMountIdentityDigest,
    },
    providerId: binding.providerId,
    providerBindingDigest: binding.providerBindingDigest,
    securityProfileId: binding.securityProfileId,
    securityProfileDigest: binding.securityProfileDigest,
    instanceIdentityDigest: binding.instanceIdentityDigest,
    expectedModelId: binding.expectedModelId,
    expectedModelDigest: binding.expectedModelDigest,
    imageDigest: binding.imageDigest,
    channelAVerifierVersion: binding.channelAVerifierVersion,
    channelBVerifierVersion: binding.channelBVerifierVersion,
    channelAResultDigest: binding.channelAResultDigest,
    channelBResultDigest: binding.channelBResultDigest,
  };
  return sha256Canonical(CONTAINMENT_BINDING_DIGEST_DOMAIN, shape);
}
