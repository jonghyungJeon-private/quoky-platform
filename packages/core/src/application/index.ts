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
  CONTAINED_EXECUTION_CAPABILITY_KINDS,
  PreparedContainmentError,
  createContainmentSecurityProfile,
  createContainmentInstanceIdentity,
  assertExactSoleProviderSelection,
  createContainmentCandidateBinding,
  prepareVerifiedContainmentBinding,
  requireProductionTrustedVerification,
  requireProductionContainedCapability,
  requireProductionPreparedProvenance,
  PreparedContainmentExecution,
} from './continuation-prepared-containment';
export type {
  PreparedContainmentFailureCode,
  ContainmentTrustDomain,
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
export * from './continuation-containment-validation';
export * from './containment-failure-classifier';
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
