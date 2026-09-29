import { PreparedContainmentExecution } from './continuation-prepared-containment';
import type { ContainedExecutionInput, ContainedExecutionResult } from './continuation-prepared-containment';
import type { BoundLocalContinuitySelection, BoundLocalContinuitySelectionIssuer } from './bound-local-continuity-selection';
import type { ProviderExecutionPlan } from './provider-execution-plan';
import type { ProviderBindingRegistry } from './provider-binding-registry';
import type { ProviderRegistry } from './provider-registry';
import type { RoutingContext } from './provider-routing-contracts';
import type { RoutingPolicyEngine } from './routing-policy-engine';
import type { MonotonicClock } from './deadline-policy';
import type { ProviderDispatchCommitCoordinator } from './provider-dispatch-commit-coordinator';

export class LocalContinuityConsumptionError extends Error {
  constructor(readonly reason: 'BINDING_MISMATCH' | 'CONTAINMENT_MISMATCH' | 'EVIDENCE_EXPIRED') {
    super(reason);
    this.name = 'LocalContinuityConsumptionError';
  }
}

/** C2C-1: validates one authentic authority and executes exactly one issued FAKE contained effect. */
export class LocalContinuityConsumptionCoordinator {
  constructor(
    private readonly issuer: Pick<BoundLocalContinuitySelectionIssuer, 'validate'>,
    private readonly registry: ProviderRegistry,
    private readonly engine: RoutingPolicyEngine,
    private readonly bindings: ProviderBindingRegistry,
    private readonly clock: MonotonicClock,
    private readonly dispatchCommit: Pick<ProviderDispatchCommitCoordinator, 'commit'>,
  ) {}

  async consume(input: Readonly<{
    authority: BoundLocalContinuitySelection;
    preparedExecution: PreparedContainmentExecution;
    plan: ProviderExecutionPlan;
    context: RoutingContext;
    routingExecutionId: string;
    effectInput: ContainedExecutionInput;
  }>): Promise<Readonly<{ disposition: 'ACCEPTED'; output: ContainedExecutionResult }
    | { disposition: 'EFFECT_UNRESOLVED' }>> {
    const { authority, preparedExecution, plan, context, effectInput } = input;
    await this.issuer.validate(authority, input.routingExecutionId, context, plan, this.registry, this.engine);

    // Synchronous final checks use the same frozen binding source as continuation routing.
    PreparedContainmentExecution.requireCapabilityKind(preparedExecution, 'FAKE');
    const canonical = this.bindings.get(authority.providerId);
    const identity = preparedExecution.bindingIdentity();
    if (!canonical || identity.providerId !== authority.providerId
      || identity.providerBindingDigest !== canonical.identity.bindingDigest) {
      throw new LocalContinuityConsumptionError('BINDING_MISMATCH');
    }
    const audit = preparedExecution.containmentAudit(authority.taskRunId);
    const binding = audit.binding;
    if (authority.executionId !== authority.taskRunId
      || binding.executionId !== authority.taskRunId || binding.taskRunId !== authority.taskRunId
      || binding.providerId !== identity.providerId
      || binding.providerBindingDigest !== identity.providerBindingDigest
      || binding.containmentBindingDigest !== identity.containmentBindingDigest
      || binding.securityProfileDigest !== identity.securityProfileDigest
      || binding.instanceIdentityDigest !== identity.instanceIdentityDigest) {
      throw new LocalContinuityConsumptionError('CONTAINMENT_MISMATCH');
    }
    if (authority.continuityEvidenceKind === 'TRUSTED_CURRENT_UNAVAILABILITY') {
      const expiry = authority.continuityEvidenceExpiresAtMonoMs;
      const now = this.clock.nowMs();
      if (expiry === undefined || !Number.isFinite(expiry) || !Number.isFinite(now)
        || now < 0 || now >= expiry) throw new LocalContinuityConsumptionError('EVIDENCE_EXPIRED');
    } else if (authority.continuityEvidenceKind !== 'STATIC_INELIGIBILITY'
      || authority.continuityEvidenceExpiresAtMonoMs !== undefined) {
      throw new LocalContinuityConsumptionError('EVIDENCE_EXPIRED');
    }
    // No intervening await. The guarded CAS is the sole consumption linearization point.
    const gate = await preparedExecution.commitTestDispatch(authority.taskRunId, this.dispatchCommit);
    try {
      return Object.freeze({ disposition: 'ACCEPTED', output: await preparedExecution.execute(effectInput, gate) });
    } catch {
      // The marker remains committed; no normal retry or fallback follows an uncertain effect.
      return Object.freeze({ disposition: 'EFFECT_UNRESOLVED' });
    }
  }
}
