export * from './risk-policy';
export * from './ai-failure';
export * from './actor-manager';
export * from './session-manager';
export * from './project-manager';
export * from './project-analyzer';
export * from './ai-provider-manager';
export * from './capability-router';
export * from './intent-classifier';
export * from './planner';
export * from './context-builder';
export * from './prompt-composer';
export * from './continuation-prompt';
export * from './prompt-renderer';
export * from './task-manager';
export * from './provider-dispatch-commit-coordinator';
export * from './local-continuity-consumption-coordinator';
export * from './memory-manager';
export * from './memory-retriever';
export * from './memory-writer';
export * from './artifact-manager';
export * from './workspace-manager';
export * from './git-manager';
export * from './push-target';
export * from './repository-identity-resolver';
export * from './repository-hosting-manager';
export * from './deterministic-planner';
export * from './planning-manager';
export * from './approval-policy';
export * from './approval-manager';
export * from './patch-manager';
export * from './workspace-write-manager';
export * from './command-execution-manager';
export * from './execution-receipt-manager';
export * from './code-proposal-parser';
export * from './code-generation-manager';
export * from './code-generation-context';
export * from './connector-manager';
export * from './work-surface-query';
export * from './work-manager';
export * from './response-composer';
export * from './safe-error';
export * from './preview-delivery';
export * from './orchestrator';
export * from './execution-orchestrator';
export * from './intent-resolver';
export * from './target-scope';
export * from './secret-file-name';
export * from './conversation-runtime';
export * from './stateless-approval-flow';
export * from './stateless-scope-clarification-flow';
export * from './stateless-apply-preview-flow';
export * from './provider-routing-contracts';
export * from './provider-registry';
export * from './routing-policy-engine';
export * from './provider-execution-plan';
export * from './provider-binding-registry';
export * from './provider-routing-gateway';
export * from './routing-execution-state';
export * from './routing-failure-classifier';
export * from './deadline-policy';
export * from './runtime-response-validation-contracts';
export * from './validation-profile-registry';
export * from './runtime-response-validator';
export * from './runtime-provider-routing-service';
export * from './continuation-provider-routing-service';
// R3-B1 (G3A-1): EXPLICIT named exports only — the wildcard previously leaked the test-only
// `createFakeContainedExecutionCapability` through the production @quoky/core barrel. That factory is
// test infrastructure and is DELIBERATELY excluded here; focused R3-B1 tests import it directly from the
// relative module. Every legitimate production-facing R3-B1 contract/function is re-exported below.
export {
  CONTAINMENT_SECURITY_PROFILE_SCHEMA,
  CONTAINMENT_INSTANCE_IDENTITY_SCHEMA,
  SOLE_PROVIDER_SELECTION_SCHEMA,
  CONTAINMENT_CANDIDATE_BINDING_SCHEMA,
  VERIFIED_CONTAINMENT_BINDING_SCHEMA,
  CONTAINED_EXECUTION_CAPABILITY_SCHEMA,
  PREPARED_CONTAINMENT_EXECUTION_SCHEMA,
  CONTAINMENT_VERIFICATION_PROVENANCE_SCHEMA,
  PREPARED_CONTAINMENT_PROVENANCE_SCHEMA,
  CONTAINMENT_TRUST_DOMAINS,
  CONTAINMENT_VERIFIER_ROLES,
  CONTAINED_EXECUTION_CAPABILITY_KINDS,
  PreparedContainmentError,
  createContainmentSecurityProfile,
  createContainmentInstanceIdentity,
  assertExactSoleProviderSelection,
  createContainmentCandidateBinding,
  prepareVerifiedContainmentBinding,
  requireProductionTrustedVerification,
  createUnavailableProductionContainmentVerifier,
  issueProductionContainedExecutionCapability,
  requireProductionContainedCapability,
  requireProductionPreparedProvenance,
  PreparedContainmentExecution,
} from './continuation-prepared-containment';
export type {
  PreparedContainmentFailureCode,
  ContainmentTrustDomain,
  ContainmentVerifierRole,
  ProductionContainedCapabilityContract,
  TrustIssuanceRecord,
  ContainedExecutionCapabilityKind,
  ContainmentSecurityProfile,
  ContainmentInstanceIdentity,
  SoleProviderSelection,
  StaticEligibilityDecision,
  ContainmentExecutionContext,
  ContainmentCandidateBinding,
  ContainmentVerificationSubject,
  ContainmentChannelStatus,
  ContainmentChannelResult,
  ContainmentVerificationChannel,
  VerifiedContainmentProvenance,
  VerifiedContainmentBinding,
  ContainedExecutionInput,
  ContainedExecutionResult,
  ContainedExecutionCapability,
} from './continuation-prepared-containment';
export {
  PRODUCTION_ATTESTATION_CHALLENGE_SCHEMA,
  PRODUCTION_ATTESTATION_EVIDENCE_SCHEMA,
  MAX_PRODUCTION_ATTESTATION_ROUND_TRIP_MS,
  MAX_PRODUCTION_ATTESTATION_VALIDITY_MS,
  TEST_ATTESTATION_SOURCE_KINDS,
  AttestationContractError,
  issueProductionAttestationChallenge,
  attestationSetIdFor,
} from './production-attestation-contracts';
export type {
  ProductionAttestationChallenge,
  AttestationObservedFacts,
  TestAttestationSourceKind,
  TestAttestationEvidence,
  AttestationContractFailureCode,
} from './production-attestation-contracts';
export * from './continuation-containment-validation';
export * from './containment-failure-classifier';
export * from './local-continuity-admission';
export * from './tool-manager';
export * from './agent-profile-registry';
export * from './work-handoff-manager';
export * from './proactive-work-service';
export * from './proactive-delegation-service';
export * from './work-handoff-consumption-service';
export * from './work-handoff-continuation-service';
export * from './continuation-live-plan-proof';
export * from './continuation-execution-admission-service';
export * from './continuation-execution-entry-service';
export * from './continuation-execution-product-policy';
export * from './continuation-execution-service';
export * from './continuation-receiver-execution-service';

export * from './bound-local-continuity-selection';
export * from './local-continuity-admission-coordinator';
export * from './trusted-current-unavailability-observation';
export * from './canonical-provider-reachability-observation';
export { routingContextDigest } from './routing-context-digest';
// ADR-0111 D3: adapters run the same ADR-0097 credential guard on inbound text attachments.
export { containsCredentialFileContent, containsCredentialMaterial } from './credential-guard';
// Personal v2 track sub-barrels (ADR-0096 D8). Each track exports its modules from its own sub-barrel only.
export * from './credential-override';
export * from './chat-policy';
export * from './feedback';
export * from './recall';
export * from './code-work';
export * from './work-chat';
export * from './reminders';
// Personal v3 sub-barrels (ADR-0104 D4 help intent, LLM-1).
export * from './help-intent';
// ADR-0106 memory management commands (MEM-1).
export * from './memory-commands';
// ADR-0110 calendar schedule questions (CAL-2).
export * from './calendar';
