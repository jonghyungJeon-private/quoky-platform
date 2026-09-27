import { Capability, IntentType } from '../domain';
import { AuthorityRequirement, LatencyClass, OutputSizeClass, Requirement, RoutingRequestType, SemanticRisk, type RoutingContext } from './provider-routing-contracts';
import { AUTHORITY_SENSITIVE } from './validation-profile-registry';

/** Fixed R2 continuation routing facts. capability/intentType are asserted against bound Task facts. */
export interface ContinuationRoutingFacts {
  readonly capability: Capability;
  readonly intentType: IntentType;
}

const REQUIRED_CAPABILITY = Capability.GENERAL_CHAT;
const REQUIRED_INTENT = IntentType.CHAT;

/** Fixed continuation routing context (§8). No caller-supplied overrides. */
export function continuationRoutingContext(facts: ContinuationRoutingFacts): RoutingContext | null {
  if (facts.capability !== REQUIRED_CAPABILITY || facts.intentType !== REQUIRED_INTENT) return null;
  return Object.freeze({
    capability: Capability.GENERAL_CHAT,
    requestType: RoutingRequestType.WORK,
    intentType: IntentType.CHAT,
    semanticRisk: SemanticRisk.STANDARD,
    latencyClass: LatencyClass.BALANCED,
    toolUseRequirement: Requirement.NOT_REQUIRED,
    authorityRequirement: AuthorityRequirement.NOT_REQUIRED,
    continuityRequirement: Requirement.NOT_REQUIRED,
    expectedOutputSize: OutputSizeClass.MEDIUM,
    validationProfile: AUTHORITY_SENSITIVE,
  });
}
