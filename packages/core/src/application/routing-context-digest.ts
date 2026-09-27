import { sha256Canonical } from './canonical-digest';
import type { RoutingContext } from './provider-routing-contracts';

/** ADR-0090 R33: exhaustive, ordered projection; no caller digest is authority. */
export function routingContextDigest(context: RoutingContext): string {
  return sha256Canonical('quoky:r3-c2:routing-context:v1', {
    capability: context.capability,
    requestType: context.requestType,
    intentType: context.intentType,
    semanticRisk: context.semanticRisk,
    latencyClass: context.latencyClass,
    toolUseRequirement: context.toolUseRequirement,
    authorityRequirement: context.authorityRequirement,
    continuityRequirement: context.continuityRequirement,
    expectedOutputSize: context.expectedOutputSize,
    validationProfile: context.validationProfile,
  });
}
