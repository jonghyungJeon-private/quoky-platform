import { TaskRunStatus, TaskStatus } from '../domain';
import type { StorageProvider } from '../ports';
import { continuationRoutingContext } from './continuation-routing-context';
import type { SoleProviderSelection } from './continuation-prepared-containment';
import type { MonotonicClock } from './deadline-policy';
import {
  LOCAL_CONTINUITY_ADMISSION_SCHEMA, R3C1_ADDITIONAL_PROVIDER_HOPS, R3C1_ATTEMPT_NUMBER,
  LocalContinuityAdmission, WorkloadLocalFallbackPolicy, type LocalContinuityAdmissionDecision,
} from './local-continuity-admission';
import type { ProviderRegistry } from './provider-registry';
import type { ProviderId } from './provider-routing-contracts';
import type { RoutingPolicyEngine } from './routing-policy-engine';
import { routingContextDigest } from './routing-context-digest';
import {
  TrustedCurrentUnavailabilityError, TrustedCurrentUnavailabilityProducerError,
  type TrustedCurrentUnavailabilityObservationIssuer,
} from './trusted-current-unavailability-observation';

type Reads = { tasks: Pick<StorageProvider['tasks'], 'get'>;
  taskRuns: Pick<StorageProvider['taskRuns'], 'get' | 'listByTask'> };

export type LocalContinuityCoordinatorOutcome =
  | Readonly<{ admitted: true; decision: LocalContinuityAdmissionDecision;
    soleSelection: SoleProviderSelection; continuityEvidenceExpiresAtMonoMs?: number }>
  | Readonly<{ admitted: false; classification: 'POLICY' | 'C2B_UNAVAILABLE' | 'C2B_INVALID' | 'INFRASTRUCTURE' }>;

const deny = (classification: Extract<LocalContinuityCoordinatorOutcome, { admitted: false }>['classification']):
  LocalContinuityCoordinatorOutcome => Object.freeze({ admitted: false, classification });

/** Canonical application admission entry. No caller evidence, provider set, or admission result enters it. */
export class LocalContinuityAdmissionCoordinator {
  constructor(
    private readonly storage: Reads,
    private readonly registry: ProviderRegistry,
    private readonly engine: RoutingPolicyEngine,
    private readonly c2bIssuer?: TrustedCurrentUnavailabilityObservationIssuer,
  ) {}

  usesClock(clock: MonotonicClock): boolean { return !this.c2bIssuer || this.c2bIssuer.usesClock(clock); }

  async admit(input: Readonly<{ taskRunId: string; localProviderId: ProviderId }>): Promise<LocalContinuityCoordinatorOutcome> {
    let facts;
    try {
      const run = await this.storage.taskRuns.get(input.taskRunId);
      if (!run || run.id !== input.taskRunId || run.status !== TaskRunStatus.STARTED) return deny('POLICY');
      if (run.attempt !== 1) return deny('POLICY');
      const task = await this.storage.tasks.get(run.taskId);
      if (!task || task.id !== run.taskId || task.status !== TaskStatus.RUNNING
        || !task.intent || task.intent.capability !== run.capability) return deny('POLICY');
      const context = continuationRoutingContext({ capability: task.intent.capability, intentType: task.intent.type });
      if (!context) return deny('POLICY');
      const history = await this.storage.taskRuns.listByTask(task.id);
      if (history.length !== 1 || history[0]?.id !== run.id || history[0]?.status !== TaskRunStatus.STARTED
        || history[0]?.attempt !== 1) return deny('POLICY');
      const current = await this.storage.taskRuns.get(run.id);
      if (!current || current.status !== TaskRunStatus.STARTED || current.id !== run.id
        || current.taskId !== task.id || current.attempt !== 1 || current.capability !== run.capability) return deny('POLICY');
      const configurationDigest = this.engine.staticEligibility(context, this.registry.snapshot()).configurationDigest;
      facts = { taskId: task.id, context, configurationDigest, capability: task.intent.capability,
        priorProviderAttempt: Boolean(run.providerId || current.providerId) };
    } catch {
      return deny('INFRASTRUCTURE');
    }
    const policy = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), this.engine, this.registry);
    const policyInput = { capability: facts.capability, routingContext: facts.context,
      localProviderId: input.localProviderId, selectionConfigurationRef: facts.configurationDigest };
    let kindA;
    try {
      kindA = policy.admit(policyInput);
    } catch {
      return deny('INFRASTRUCTURE');
    }
    if (kindA.decision.admitted && kindA.soleSelection) {
      return Object.freeze({ admitted: true, decision: kindA.decision, soleSelection: kindA.soleSelection });
    }
    if (kindA.decision.denialReason !== 'NORMAL_CLOUD_PATH_STATICALLY_EXISTS') return deny('POLICY');
    if (facts.priorProviderAttempt) return deny('POLICY');
    // Deterministic preflight avoids observation work for an invalid local candidate.
    try {
      if (!policy.evaluateTrustedCurrentUnavailabilityPolicy(policyInput).allowed) return deny('POLICY');
    } catch {
      return deny('INFRASTRUCTURE');
    }
    if (!this.c2bIssuer) return deny('C2B_UNAVAILABLE');
    let validated;
    try {
      const authorities = await this.c2bIssuer.issueCanonicalEligibleNetworkSet(input.taskRunId);
      validated = await this.c2bIssuer.validate(authorities, input.taskRunId, facts.taskId, facts.context);
    } catch (error) {
      if (error instanceof TrustedCurrentUnavailabilityError || error instanceof TrustedCurrentUnavailabilityProducerError) {
        return deny('C2B_UNAVAILABLE');
      }
      return deny('INFRASTRUCTURE');
    }
    if (validated.status !== 'VALIDATED') return deny('C2B_INVALID');
    if (validated.taskRunId !== input.taskRunId
      || validated.routingContextDigest !== routingContextDigest(facts.context)
      || validated.configurationDigest !== facts.configurationDigest) return deny('C2B_INVALID');
    let candidate;
    try {
      candidate = policy.evaluateTrustedCurrentUnavailabilityPolicy(policyInput);
    } catch {
      return deny('INFRASTRUCTURE');
    }
    if (!candidate.allowed || !candidate.soleSelection || candidate.providerCandidate !== input.localProviderId
      || candidate.configurationRef !== validated.configurationDigest) return deny('POLICY');
    const decision: LocalContinuityAdmissionDecision = Object.freeze({
      schemaVersion: LOCAL_CONTINUITY_ADMISSION_SCHEMA, admitted: true,
      providerCandidate: input.localProviderId, evidenceKind: 'TRUSTED_CURRENT_UNAVAILABILITY',
      configurationRef: validated.configurationDigest, attemptNumber: R3C1_ATTEMPT_NUMBER,
      additionalProviderHops: R3C1_ADDITIONAL_PROVIDER_HOPS,
    });
    return Object.freeze({ admitted: true, decision, soleSelection: candidate.soleSelection,
      continuityEvidenceExpiresAtMonoMs: validated.expiresAtMonoMs });
  }
}
