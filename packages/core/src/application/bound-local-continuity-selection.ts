import { TaskRunStatus, TaskStatus, type Capability } from '../domain';
import type { StorageProvider } from '../ports';
import { continuationRoutingContext } from './continuation-routing-context';
import { type LocalContinuityAdmissionDecision, type LocalContinuityEvidenceKind } from './local-continuity-admission';
import { LocalContinuityAdmissionCoordinator } from './local-continuity-admission-coordinator';
import { SYSTEM_MONOTONIC_CLOCK, type MonotonicClock } from './deadline-policy';
import type { SoleProviderSelection } from './continuation-prepared-containment';
import type { ProviderExecutionPlan } from './provider-execution-plan';
import type { ProviderRegistry } from './provider-registry';
import type { ProviderId, RoutingContext } from './provider-routing-contracts';
import type { RoutingPolicyEngine } from './routing-policy-engine';
import { routingContextDigest } from './routing-context-digest';

type Reads = { tasks: Pick<StorageProvider['tasks'], 'get'>;
  taskRuns: Pick<StorageProvider['taskRuns'], 'get' | 'listByTask'> };

/** Process-local admission bridge only. Never production trust or a runtime capability. */
export interface BoundLocalContinuitySelection {
  readonly providerId: ProviderId;
  readonly admission: LocalContinuityAdmissionDecision;
  readonly soleSelection: SoleProviderSelection;
  readonly configurationDigest: string;
  readonly taskRunId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly routingContextDigest: string;
  readonly capability: Capability;
  readonly continuityEvidenceKind: LocalContinuityEvidenceKind;
  readonly continuityEvidenceExpiresAtMonoMs?: number;
  readonly attemptNumber: 1;
  readonly additionalProviderHops: 0;
}

// Not exported, persisted, or reproducible from any field/hash. Each issuer is a separate scope.
const issued = new WeakMap<object, object>();

export class BoundLocalContinuityError extends Error {
  constructor(readonly reason: 'NOT_ISSUED' | 'INVALID_RUN' | 'NOT_FIRST_RUN' | 'WORKLOAD_MISMATCH'
    | 'ADMISSION_DENIED' | 'EXECUTION_MISMATCH' | 'CONTEXT_MISMATCH' | 'CONFIGURATION_MISMATCH'
    | 'PRIMARY_ONLY_VIOLATION' | 'INFRASTRUCTURE_FAILURE' | 'EVIDENCE_EXPIRED' | 'EVIDENCE_SHAPE_INVALID') {
    super(reason);
    this.name = 'BoundLocalContinuityError';
  }
}

function reject(reason: BoundLocalContinuityError['reason']): never {
  throw new BoundLocalContinuityError(reason);
}

/**
 * One canonical issuer. Dependencies are trusted composition, not request-supplied authority.
 * Only stored STARTED TaskRun identity and a candidate provider id enter issuance. The candidate is
 * rechecked by R3-C1; no caller admission, selection, workload, digest, or history assertion is accepted.
 * No writes, provider probes, execution, containment preparation, or lifecycle ownership.
 */
export class BoundLocalContinuitySelectionIssuer {
  constructor(
    private readonly storage: Reads,
    private readonly registry: ProviderRegistry,
    private readonly engine: RoutingPolicyEngine,
    private readonly coordinator: LocalContinuityAdmissionCoordinator = new LocalContinuityAdmissionCoordinator(storage, registry, engine),
    private readonly clock: MonotonicClock = SYSTEM_MONOTONIC_CLOCK,
  ) {
    if (!coordinator.usesClock(clock)) reject('EVIDENCE_SHAPE_INVALID');
  }

  async issue(taskRunId: string, localProviderId: ProviderId): Promise<BoundLocalContinuitySelection> {
    let facts;
    try {
      facts = await this.canonicalFacts(taskRunId);
    } catch (error) {
      if (error instanceof BoundLocalContinuityError) throw error;
      reject('INFRASTRUCTURE_FAILURE');
    }
    const configurationDigest = this.engine.staticEligibility(facts.context, this.registry.snapshot()).configurationDigest;
    const outcome = await this.coordinator.admit({ taskRunId, localProviderId });
    if (!outcome.admitted) {
      if (outcome.classification === 'INFRASTRUCTURE') reject('INFRASTRUCTURE_FAILURE');
      reject('ADMISSION_DENIED');
    }
    // No await between the coordinator's admitted outcome and this authority mint.
    const { decision, soleSelection } = outcome;
    if (!decision.admitted || !soleSelection || decision.providerCandidate !== localProviderId
      || decision.configurationRef !== configurationDigest
      || decision.attemptNumber !== 1 || decision.additionalProviderHops !== 0) reject('ADMISSION_DENIED');
    const evidenceKind = decision.evidenceKind;
    const expiry = outcome.continuityEvidenceExpiresAtMonoMs;
    if (evidenceKind === 'TRUSTED_CURRENT_UNAVAILABILITY') {
      if (!Number.isFinite(expiry) || expiry === undefined || expiry < 0) reject('EVIDENCE_SHAPE_INVALID');
      const now = this.clock.nowMs();
      if (!Number.isFinite(now) || now < 0 || now >= expiry) reject('EVIDENCE_EXPIRED');
    } else if (evidenceKind !== 'STATIC_INELIGIBILITY' || expiry !== undefined) reject('EVIDENCE_SHAPE_INVALID');
    const selection: BoundLocalContinuitySelection = Object.freeze({
      providerId: localProviderId, admission: decision, soleSelection, configurationDigest,
      taskRunId, executionId: taskRunId, taskId: facts.taskId,
      routingContextDigest: routingContextDigest(facts.context), capability: facts.context.capability,
      continuityEvidenceKind: evidenceKind,
      ...(expiry === undefined ? {} : { continuityEvidenceExpiresAtMonoMs: expiry }),
      attemptNumber: 1, additionalProviderHops: 0,
    });
    issued.set(selection, this);
    return selection;
  }

  /**
   * Existing continuation orchestration calls this before the future C2 preparation boundary.
   * Re-read canonical history while STARTED; compare current orchestration configuration and plan.
   * Successful return is validation only, never permission to invoke a provider in C2A.
   */
  async validate(
    selection: BoundLocalContinuitySelection,
    executionId: string,
    context: RoutingContext,
    plan: ProviderExecutionPlan,
    currentRegistry: ProviderRegistry,
    currentEngine: RoutingPolicyEngine,
  ): Promise<void> {
    if (!selection || issued.get(selection) !== this) reject('NOT_ISSUED');
    // Capture caller-owned plan/context projections before awaits.
    const digest = routingContextDigest(context);
    const expected = { executionId: plan.executionId, capability: plan.capability,
      configurationDigest: plan.configurationDigest, providerId: plan.primary.providerId,
      fallback: plan.operationalFallback, escalation: plan.semanticEscalation,
      validationProfile: plan.validationProfile };
    const currentConfiguration = currentEngine.staticEligibility(context, currentRegistry.snapshot()).configurationDigest;
    if (executionId !== selection.taskRunId || selection.executionId !== executionId
      || expected.executionId !== executionId) reject('EXECUTION_MISMATCH');
    if (selection.attemptNumber !== 1 || selection.additionalProviderHops !== 0
      || selection.admission.attemptNumber !== 1 || selection.admission.additionalProviderHops !== 0
      || expected.providerId !== selection.providerId || expected.fallback !== null || expected.escalation !== null) {
      reject('PRIMARY_ONLY_VIOLATION');
    }
    const facts = await this.canonicalFacts(selection.taskRunId);
    if (facts.taskId !== selection.taskId || facts.context.capability !== selection.capability
      || expected.capability !== selection.capability) reject('WORKLOAD_MISMATCH');
    if (digest !== selection.routingContextDigest || routingContextDigest(facts.context) !== digest
      || expected.validationProfile !== facts.context.validationProfile) reject('CONTEXT_MISMATCH');
    const canonicalConfiguration = this.engine.staticEligibility(facts.context, this.registry.snapshot()).configurationDigest;
    if (currentConfiguration !== selection.configurationDigest
      || canonicalConfiguration !== selection.configurationDigest
      || expected.configurationDigest !== selection.configurationDigest) reject('CONFIGURATION_MISMATCH');
    const expiry = selection.continuityEvidenceExpiresAtMonoMs;
    if (selection.continuityEvidenceKind !== selection.admission.evidenceKind) reject('EVIDENCE_SHAPE_INVALID');
    if (selection.continuityEvidenceKind === 'STATIC_INELIGIBILITY') {
      if (expiry !== undefined) reject('EVIDENCE_SHAPE_INVALID');
    } else if (selection.continuityEvidenceKind === 'TRUSTED_CURRENT_UNAVAILABILITY') {
      if (expiry === undefined || !Number.isFinite(expiry) || expiry < 0) reject('EVIDENCE_SHAPE_INVALID');
      const now = this.clock.nowMs();
      if (!Number.isFinite(now) || now < 0 || now >= expiry) reject('EVIDENCE_EXPIRED');
    } else reject('EVIDENCE_SHAPE_INVALID');
  }

  private async canonicalFacts(taskRunId: string): Promise<{ taskId: string; context: RoutingContext }> {
    if (typeof taskRunId !== 'string' || !taskRunId.trim()) reject('INVALID_RUN');
    const run = await this.storage.taskRuns.get(taskRunId);
    if (!run || run.id !== taskRunId || run.status !== TaskRunStatus.STARTED) reject('INVALID_RUN');
    // Snapshot identity before subsequent asynchronous reads; repository DTOs need not be immutable.
    const { taskId, capability, attempt } = run;
    if (attempt !== 1) reject('NOT_FIRST_RUN');
    const task = await this.storage.tasks.get(taskId);
    if (!task || task.id !== taskId || task.status !== TaskStatus.RUNNING
      || !task.intent || task.intent.capability !== capability) reject('WORKLOAD_MISMATCH');
    const context = continuationRoutingContext({ capability: task.intent.capability, intentType: task.intent.type });
    if (!context) reject('WORKLOAD_MISMATCH');
    const history = await this.storage.taskRuns.listByTask(taskId);
    const only = history[0];
    if (history.length !== 1 || !only || only.id !== taskRunId || only.taskId !== taskId
      || only.attempt !== 1) reject('NOT_FIRST_RUN');
    if (only.status !== TaskRunStatus.STARTED || only.capability !== capability) reject('INVALID_RUN');
    // The guarded-start exclusion stabilizes history while this run remains STARTED. Recheck after
    // history so observed terminalization also fails closed; this is not a new lock/lifecycle owner.
    const current = await this.storage.taskRuns.get(taskRunId);
    if (!current || current.id !== taskRunId || current.taskId !== taskId || current.attempt !== 1
      || current.status !== TaskRunStatus.STARTED || current.capability !== capability) reject('INVALID_RUN');
    return { taskId, context };
  }
}
