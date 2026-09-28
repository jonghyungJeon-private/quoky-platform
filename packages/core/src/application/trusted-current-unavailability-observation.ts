import { ProviderDispatchState, TaskRunStatus, TaskStatus, type Capability } from '../domain';
import {
  TrustedUnavailabilityObservationSource,
  TrustedUnavailabilityReason,
  type CurrentUnavailabilityObservationProducer,
  type StorageProvider,
} from '../ports';
import { continuationRoutingContext } from './continuation-routing-context';
import { SYSTEM_MONOTONIC_CLOCK, type MonotonicClock } from './deadline-policy';
import type { ProviderRegistry } from './provider-registry';
import type { ProviderId, RoutingContext, StaticEligibilityProjection } from './provider-routing-contracts';
import type { RoutingPolicyEngine } from './routing-policy-engine';
import { routingContextDigest } from './routing-context-digest';
import { requireIssuedProductionObservationProducer } from './canonical-provider-reachability-observation';
import type { ProviderBindingRegistry } from './provider-binding-registry';

export const MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS = 5_000;
export const MAX_OBSERVATION_TO_ISSUANCE_DELAY_MS = 1_000;

export type TrustedCurrentUnavailabilityInvalidReason =
  | 'NOT_ISSUED' | 'WRONG_ISSUER' | 'NOT_YET_VALID' | 'EXPIRED' | 'TIME_INVALID'
  | 'PROVIDER_SET_MISMATCH' | 'MISSING_PROVIDER_AUTHORITY' | 'EXTRA_PROVIDER_AUTHORITY'
  | 'DUPLICATE_PROVIDER_AUTHORITY' | 'EXECUTION_MISMATCH' | 'TASK_MISMATCH'
  | 'ROUTING_CONTEXT_MISMATCH' | 'CONFIGURATION_MISMATCH' | 'WORKLOAD_MISMATCH'
  | 'NOT_FIRST_RUN' | 'SOURCE_NOT_ALLOWED';

export type TrustedCurrentUnavailabilityValidationResult =
  | Readonly<{ status: 'VALIDATED'; taskRunId: string; routingContextDigest: string;
    configurationDigest: string; expiresAtMonoMs: number }>
  | Readonly<{ status: 'INVALID'; reason: TrustedCurrentUnavailabilityInvalidReason }>;

export interface TrustedCurrentUnavailabilityObservation {
  readonly providerId: ProviderId;
  readonly taskId: string;
  readonly executionId: string;
  readonly taskRunId: string;
  readonly capability: Capability;
  readonly routingContextDigest: string;
  readonly configurationDigest: string;
  readonly observedAtMonoMs: number;
  readonly validFromMonoMs: number;
  readonly expiresAtMonoMs: number;
  readonly source: TrustedUnavailabilityObservationSource;
  readonly reason: TrustedUnavailabilityReason;
}

const issued = new WeakMap<object, TrustedCurrentUnavailabilityObservationIssuer>();
const invalid = (reason: TrustedCurrentUnavailabilityInvalidReason): TrustedCurrentUnavailabilityValidationResult =>
  Object.freeze({ status: 'INVALID', reason });

export class TrustedCurrentUnavailabilityError extends Error {
  constructor(readonly reason: TrustedCurrentUnavailabilityInvalidReason) {
    super(reason);
    this.name = 'TrustedCurrentUnavailabilityError';
  }
}

/** A producer failure has no caller-visible raw error text. Storage failures remain distinguishable. */
export class TrustedCurrentUnavailabilityProducerError extends Error {
  constructor() {
    super('OBSERVATION_PRODUCER_FAILED');
    this.name = 'TrustedCurrentUnavailabilityProducerError';
  }
}

function fail(reason: TrustedCurrentUnavailabilityInvalidReason): never {
  throw new TrustedCurrentUnavailabilityError(reason);
}

function safeTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function timingReason(authority: TrustedCurrentUnavailabilityObservation, now: number):
  TrustedCurrentUnavailabilityInvalidReason | null {
  const { observedAtMonoMs: observed, validFromMonoMs: from, expiresAtMonoMs: until } = authority;
  if (![observed, from, until, now].every(safeTime) || until <= from || from < observed
    || until - from > MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS
    || from - observed > MAX_OBSERVATION_TO_ISSUANCE_DELAY_MS) return 'TIME_INVALID';
  if (now < from) return 'NOT_YET_VALID';
  if (now >= until) return 'EXPIRED';
  return null;
}

type Reads = { tasks: Pick<StorageProvider['tasks'], 'get'>;
  taskRuns: Pick<StorageProvider['taskRuns'], 'get' | 'listByTask'> };
type Facts = { taskId: string; context: RoutingContext; capability: Capability };

/** Network-free C2B evidence issuer/validator. Issuance validity begins at issuedAt, not observedAt. */
export class TrustedCurrentUnavailabilityObservationIssuer {
  private lastObservedMonoMs: number | null = null;

  constructor(
    private readonly storage: Reads,
    private readonly registry: ProviderRegistry,
    private readonly engine: RoutingPolicyEngine,
    private readonly producer: CurrentUnavailabilityObservationProducer,
    private readonly clock: MonotonicClock = SYSTEM_MONOTONIC_CLOCK,
    private readonly productionBindings?: ProviderBindingRegistry,
  ) {}

  /** Composition check only; the clock itself remains issuer-owned. */
  usesClock(clock: MonotonicClock): boolean { return this.clock === clock; }

  async issueCanonicalEligibleNetworkSet(taskRunId: string): Promise<readonly TrustedCurrentUnavailabilityObservation[]> {
    const facts = await this.canonicalFacts(taskRunId);
    const projection = this.engine.staticEligibility(facts.context, this.registry.snapshot());
    if (!this.kindBApplicable(projection)) fail('PROVIDER_SET_MISMATCH');
    const authorities: TrustedCurrentUnavailabilityObservation[] = [];
    for (const providerId of projection.eligibleNetworkProviderIds) {
      authorities.push(await this.issue(taskRunId, providerId));
    }
    return Object.freeze(authorities);
  }

  async issue(taskRunId: string, providerId: ProviderId): Promise<TrustedCurrentUnavailabilityObservation> {
    const facts = await this.canonicalFacts(taskRunId);
    const projection = this.engine.staticEligibility(facts.context, this.registry.snapshot());
    if (!this.kindBApplicable(projection) || !projection.eligibleNetworkProviderIds.includes(providerId)) {
      fail('PROVIDER_SET_MISMATCH');
    }
    this.requireSource();
    const before = this.readClock();
    let observation;
    try {
      observation = await this.producer.observe(Object.freeze({
        providerId, taskId: facts.taskId, executionId: taskRunId, capability: facts.capability,
        routingContextDigest: routingContextDigest(facts.context), configurationDigest: projection.configurationDigest,
      }));
    } catch {
      throw new TrustedCurrentUnavailabilityProducerError();
    }
    const after = this.readClock();
    this.requireSource();
    if (!observation || !safeTime(observation.observedAtMonoMs)
      || observation.observedAtMonoMs < before || observation.observedAtMonoMs > after) fail('TIME_INVALID');
    if (!Object.values(TrustedUnavailabilityReason).includes(observation.reason)) fail('SOURCE_NOT_ALLOWED');
    if (this.producer.source === TrustedUnavailabilityObservationSource.CANONICAL_PROVIDER_REACHABILITY_PROBE
      && observation.reason === TrustedUnavailabilityReason.ENDPOINT_UNREACHABLE) fail('SOURCE_NOT_ALLOWED');
    // Observation is asynchronous. A run that terminalized during it cannot receive new authority.
    const currentFacts = await this.canonicalFacts(taskRunId);
    if (currentFacts.taskId !== facts.taskId || routingContextDigest(currentFacts.context) !== routingContextDigest(facts.context)) {
      fail('ROUTING_CONTEXT_MISMATCH');
    }
    const issuedAt = this.readClock();
    const authority: TrustedCurrentUnavailabilityObservation = Object.freeze({
      providerId, taskId: facts.taskId, executionId: taskRunId, taskRunId, capability: facts.capability,
      routingContextDigest: routingContextDigest(facts.context), configurationDigest: projection.configurationDigest,
      observedAtMonoMs: observation.observedAtMonoMs, validFromMonoMs: issuedAt,
      expiresAtMonoMs: issuedAt + MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS,
      source: this.producer.source, reason: observation.reason,
    });
    if (timingReason(authority, issuedAt)) fail('TIME_INVALID');
    issued.set(authority, this);
    return authority;
  }

  async validate(
    authorities: readonly TrustedCurrentUnavailabilityObservation[],
    executionId: string,
    taskId: string,
    context: RoutingContext,
  ): Promise<TrustedCurrentUnavailabilityValidationResult> {
    try {
      // A clock read is mandatory on every validation, even when the authority set is empty.
      this.readClock();
      const facts = await this.canonicalFacts(executionId);
      if (taskId !== facts.taskId) return invalid('TASK_MISMATCH');
      if (context.capability !== facts.capability) return invalid('WORKLOAD_MISMATCH');
      if (routingContextDigest(context) !== routingContextDigest(facts.context)) {
        return invalid('ROUTING_CONTEXT_MISMATCH');
      }
      const canonical = this.engine.staticEligibility(facts.context, this.registry.snapshot());
      const now = this.readClock();
      const seen = new Set<ProviderId>();
      for (const authority of authorities) {
        if (!authority || typeof authority !== 'object' || !issued.has(authority)) return invalid('NOT_ISSUED');
        if (issued.get(authority) !== this) return invalid('WRONG_ISSUER');
        this.requireSource();
        if (authority.source !== this.producer.source) return invalid('SOURCE_NOT_ALLOWED');
        if (authority.source === TrustedUnavailabilityObservationSource.CANONICAL_PROVIDER_REACHABILITY_PROBE
          && authority.reason === TrustedUnavailabilityReason.ENDPOINT_UNREACHABLE) return invalid('SOURCE_NOT_ALLOWED');
        if (authority.executionId !== executionId || authority.taskRunId !== executionId) {
          return invalid('EXECUTION_MISMATCH');
        }
        if (authority.taskId !== taskId) return invalid('TASK_MISMATCH');
        if (authority.capability !== facts.capability) return invalid('WORKLOAD_MISMATCH');
        if (authority.routingContextDigest !== routingContextDigest(facts.context)) {
          return invalid('ROUTING_CONTEXT_MISMATCH');
        }
        if (authority.configurationDigest !== canonical.configurationDigest) return invalid('CONFIGURATION_MISMATCH');
        const time = timingReason(authority, now);
        if (time) return invalid(time);
        if (seen.has(authority.providerId)) return invalid('DUPLICATE_PROVIDER_AUTHORITY');
        seen.add(authority.providerId);
        if (!canonical.eligibleNetworkProviderIds.includes(authority.providerId)) {
          return invalid('EXTRA_PROVIDER_AUTHORITY');
        }
      }
      if (!this.kindBApplicable(canonical)) return invalid('PROVIDER_SET_MISMATCH');
      if (seen.size < canonical.eligibleNetworkProviderIds.length) return invalid('MISSING_PROVIDER_AUTHORITY');
      if (seen.size !== canonical.eligibleNetworkProviderIds.length) return invalid('PROVIDER_SET_MISMATCH');
      // Final security read occurs after all asynchronous canonical facts. Nothing awaits after it.
      const finalNow = this.readClock();
      const expiresAtMonoMs = Math.min(...authorities.map(authority => authority.expiresAtMonoMs));
      if (finalNow >= expiresAtMonoMs) return invalid('EXPIRED');
      return Object.freeze({ status: 'VALIDATED', taskRunId: executionId,
        routingContextDigest: routingContextDigest(facts.context),
        configurationDigest: canonical.configurationDigest,
        expiresAtMonoMs });
    } catch (error) {
      if (error instanceof TrustedCurrentUnavailabilityError) return invalid(error.reason);
      throw error;
    }
  }

  private kindBApplicable(projection: StaticEligibilityProjection): boolean {
    return projection.policyMatched && !projection.policyRequiresLocalLocality
      && projection.eligibleNetworkProviderIds.length > 0;
  }

  private requireSource(): void {
    if (!this.producer) fail('SOURCE_NOT_ALLOWED');
    if (this.producer.source === TrustedUnavailabilityObservationSource.TEST_FAKE) return;
    if (this.producer.source !== TrustedUnavailabilityObservationSource.CANONICAL_PROVIDER_REACHABILITY_PROBE
      || !this.productionBindings || !this.productionBindings.matchesSnapshot(this.registry.snapshot())) {
      fail('SOURCE_NOT_ALLOWED');
    }
    try {
      requireIssuedProductionObservationProducer(this.producer, this.clock, this.productionBindings);
    } catch {
      fail('SOURCE_NOT_ALLOWED');
    }
  }

  private readClock(): number {
    const now = this.clock.nowMs();
    if (!safeTime(now) || (this.lastObservedMonoMs !== null && now < this.lastObservedMonoMs)) fail('TIME_INVALID');
    this.lastObservedMonoMs = now;
    return now;
  }

  private async canonicalFacts(taskRunId: string): Promise<Facts> {
    if (typeof taskRunId !== 'string' || !taskRunId.trim()) fail('EXECUTION_MISMATCH');
    const run = await this.storage.taskRuns.get(taskRunId);
    if (!run || run.id !== taskRunId || run.status !== TaskRunStatus.STARTED
      || run.dispatchState !== ProviderDispatchState.PRE_DISPATCH) fail('EXECUTION_MISMATCH');
    const { taskId, capability, attempt } = run;
    if (attempt !== 1) fail('NOT_FIRST_RUN');
    if (run.providerId) fail('NOT_FIRST_RUN');
    const task = await this.storage.tasks.get(taskId);
    if (!task || task.id !== taskId || task.status !== TaskStatus.RUNNING || !task.intent
      || task.intent.capability !== capability) fail('WORKLOAD_MISMATCH');
    const context = continuationRoutingContext({ capability: task.intent.capability, intentType: task.intent.type });
    if (!context) fail('WORKLOAD_MISMATCH');
    const history = await this.storage.taskRuns.listByTask(taskId);
    const only = history[0];
    if (history.length !== 1 || !only || only.id !== taskRunId || only.taskId !== taskId
      || only.attempt !== 1) fail('NOT_FIRST_RUN');
    if (only.status !== TaskRunStatus.STARTED || only.capability !== capability
      || only.dispatchState !== ProviderDispatchState.PRE_DISPATCH) fail('EXECUTION_MISMATCH');
    const current = await this.storage.taskRuns.get(taskRunId);
    if (!current || current.id !== taskRunId || current.taskId !== taskId || current.attempt !== 1
      || current.status !== TaskRunStatus.STARTED || current.capability !== capability
      || current.dispatchState !== ProviderDispatchState.PRE_DISPATCH) fail('EXECUTION_MISMATCH');
    if (current.providerId) fail('NOT_FIRST_RUN');
    return { taskId, context, capability };
  }
}
