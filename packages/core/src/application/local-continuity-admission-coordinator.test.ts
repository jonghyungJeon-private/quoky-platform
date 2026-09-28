import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Capability, IntentType, RiskLevel, TaskRunStatus, ProviderDispatchState, TaskStatus, type Task, type TaskRun } from '../domain';
import { TrustedUnavailabilityObservationSource as Source, TrustedUnavailabilityReason as Reason } from '../ports';
import { BoundLocalContinuitySelectionIssuer } from './bound-local-continuity-selection';
import { continuationRoutingContext } from './continuation-routing-context';
import { LocalContinuityAdmissionCoordinator } from './local-continuity-admission-coordinator';
import { LocalContinuityAdmission, WorkloadLocalFallbackPolicy } from './local-continuity-admission';
import { TrustedCurrentUnavailabilityObservationIssuer } from './trusted-current-unavailability-observation';
import { routingContextDigest } from './routing-context-digest';
import {
  AvailabilityClass, ConcurrencyClass, ContextCapacity, CostTier, ExecutionLocality, LatencyTier,
  RankingDimension, ReliabilityTier, RoutingClass, SemanticRisk, SortDirection, SupportLevel,
  TerminalDecision, TimeoutClass, adapterId, policyId, providerId, type ProviderDescriptor,
  type RoutingPolicy,
} from './provider-routing-contracts';
import { ProviderRegistry } from './provider-registry';
import { RoutingPolicyEngine } from './routing-policy-engine';
import type { ProviderExecutionPlan } from './provider-execution-plan';

function descriptor(id: string, locality: ExecutionLocality, enabled = true): ProviderDescriptor {
  return { providerId: providerId(id), adapterId: adapterId('fixture'), modelId: `opaque-${id}`,
    capabilities: { supportedCapabilities: [Capability.GENERAL_CHAT], routingClasses: [RoutingClass.BALANCED],
      semanticReliability: ReliabilityTier.STANDARD, authorityReliability: ReliabilityTier.STANDARD,
      continuityReliability: ReliabilityTier.STANDARD, toolUse: SupportLevel.UNSUPPORTED,
      structuredOutput: SupportLevel.SUPPORTED, contextCapacity: ContextCapacity.MEDIUM,
      streaming: SupportLevel.UNSUPPORTED, executionLocality: locality },
    operationalProfile: { latencyTier: LatencyTier.BALANCED, timeoutClass: TimeoutClass.STANDARD,
      costTier: CostTier.LOW, concurrencyClass: ConcurrencyClass.LIMITED,
      availabilityClass: AvailabilityClass.LOCAL_STABLE }, enabled, profileVersion: 'v1' };
}
const policy: RoutingPolicy = { policyId: policyId('policy'), version: 'v1', precedence: 1,
  when: { semanticRisks: [SemanticRisk.STANDARD] }, eligibility: {},
  ranking: [{ dimension: RankingDimension.SEMANTIC_RELIABILITY, direction: SortDirection.DESCENDING }],
  terminal: TerminalDecision.NO_SELECTION };
const context = continuationRoutingContext({ capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT })!;
const stamp = '2026-09-28T00:00:00.000Z';

function fixture(clouds: readonly [string, boolean][] = [['a', true]], withIssuer = true) {
  const task: Task = { id: 'task', title: 'task', status: TaskStatus.RUNNING,
    intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1,
      requiresWork: true, summary: 'test' }, riskLevel: RiskLevel.LOW,
    context: { platform: 'test', channelId: 'channel', userId: 'user' }, createdAt: stamp, updatedAt: stamp };
  const run: TaskRun = { id: 'run', taskId: 'task', status: TaskRunStatus.STARTED, dispatchState: ProviderDispatchState.PRE_DISPATCH,
    capability: Capability.GENERAL_CHAT, attempt: 1, artifactIds: [], startedAt: stamp };
  const runs = [run];
  const storage = { tasks: { get: vi.fn(async () => task) }, taskRuns: {
    get: vi.fn(async (id: string) => runs.find(r => r.id === id) ?? null),
    listByTask: vi.fn(async () => runs),
  } };
  const registry = new ProviderRegistry('v1', [descriptor('local', ExecutionLocality.LOCAL),
    ...clouds.map(([id, enabled]) => descriptor(id, ExecutionLocality.NETWORK, enabled))]
    .map(d => ({ providerId: d.providerId, descriptor: d })));
  const engine = new RoutingPolicyEngine({ version: 'v1', policies: [policy] });
  let now = 100;
  const clock = { nowMs: vi.fn(() => now) };
  const observe = vi.fn(async () => { now += 100;
    return { observedAtMonoMs: now, reason: Reason.ENDPOINT_UNREACHABLE }; });
  const producer = { source: Source.TEST_FAKE, observe };
  const c2b = withIssuer ? new TrustedCurrentUnavailabilityObservationIssuer(storage, registry, engine, producer, clock) : undefined;
  const coordinator = new LocalContinuityAdmissionCoordinator(storage, registry, engine, c2b);
  const c2a = new BoundLocalContinuitySelectionIssuer(storage, registry, engine, coordinator, clock);
  const plan = { executionId: run.id, capability: Capability.GENERAL_CHAT,
    configurationDigest: engine.staticEligibility(context, registry.snapshot()).configurationDigest,
    primary: { providerId: providerId('local') }, operationalFallback: null, semanticEscalation: null,
    validationProfile: context.validationProfile } as ProviderExecutionPlan;
  return { task, run, runs, storage, registry, engine, clock, observe, producer, c2b, coordinator, c2a, plan,
    setNow: (value: number) => { now = value; }, now: () => now,
    admit: () => coordinator.admit({ taskRunId: 'run', localProviderId: providerId('local') }),
    issue: () => c2a.issue('run', providerId('local')) };
}

describe('R3-C2B-I1 canonical admission integration', () => {
  it('denies both kinds once dispatch is committed or historical state is unknown', async () => {
    for (const state of [ProviderDispatchState.DISPATCH_COMMITTED, ProviderDispatchState.LEGACY_UNKNOWN]) {
      for (const clouds of [[], [['a', true]] as [string, boolean][]]) {
        const f = fixture(clouds);
        f.run.dispatchState = state;
        expect((await f.admit()).admitted).toBe(false);
        await expect(f.issue()).rejects.toMatchObject({ reason: 'INVALID_RUN' });
      }
    }
  });

  it('rejects a minted Kind A or Kind B authority after dispatch commit', async () => {
    for (const clouds of [[], [['a', true]] as [string, boolean][]]) {
      const f = fixture(clouds);
      const selection = await f.issue();
      f.run.dispatchState = ProviderDispatchState.DISPATCH_COMMITTED;
      await expect(f.c2a.validate(selection, 'run', context, f.plan, f.registry, f.engine))
        .rejects.toMatchObject({ reason: 'INVALID_RUN' });
    }
  });
  it('keeps Kind A A1/A2 independent of a missing C2B issuer and without expiry', async () => {
    for (const clouds of [[], [['a', false]] as [string, boolean][]]) {
      const f = fixture(clouds, false);
      const selection = await f.issue();
      expect(selection.continuityEvidenceKind).toBe('STATIC_INELIGIBILITY');
      expect(selection).not.toHaveProperty('continuityEvidenceExpiresAtMonoMs');
      expect(selection.admission).toMatchObject({ admitted: true, evidenceKind: 'STATIC_INELIGIBILITY',
        kindACondition: clouds.length ? 'ALL_POLICY_COMPATIBLE_CLOUDS_DISABLED' : 'NO_CLOUD_PROVIDER_CONFIGURED' });
      await expect(f.c2a.validate(selection, 'run', context, f.plan, f.registry, f.engine)).resolves.toBeUndefined();
      f.setNow(100_000);
      await expect(f.c2a.validate(selection, 'run', context, f.plan, f.registry, f.engine)).resolves.toBeUndefined();
      expect(f.observe).not.toHaveBeenCalled();
    }
  });

  it('denies production Kind B when C2B is absent, while a pure candidate cannot mint', async () => {
    const f = fixture([['a', true]], false);
    const pure = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), f.engine, f.registry)
      .evaluateTrustedCurrentUnavailabilityPolicy({ capability: Capability.GENERAL_CHAT,
        routingContext: context, localProviderId: providerId('local'),
        selectionConfigurationRef: f.plan.configurationDigest });
    expect(pure).toMatchObject({ allowed: true, providerCandidate: 'local' });
    expect(await f.admit()).toEqual({ admitted: false, classification: 'C2B_UNAVAILABLE' });
    await expect(f.issue()).rejects.toMatchObject({ reason: 'ADMISSION_DENIED' });
    await expect(f.c2a.issue({ admitted: true, evidenceKind: 'TRUSTED_CURRENT_UNAVAILABILITY' } as unknown as string,
      providerId('local'))).rejects.toMatchObject({ reason: 'INVALID_RUN' });
    await expect(f.c2a.issue(pure as unknown as string, providerId('local')))
      .rejects.toMatchObject({ reason: 'INVALID_RUN' });
  });

  it('batch issues exactly canonical {a,b}, validates on the same issuer, and binds min expiry', async () => {
    const f = fixture([['a', true], ['b', true]]);
    const batch = await f.c2b!.issueCanonicalEligibleNetworkSet('run');
    expect(batch.map(a => a.providerId)).toEqual(['a', 'b']);
    expect(f.observe).toHaveBeenCalledTimes(2);
    const validation = await f.c2b!.validate([...batch].reverse(), 'run', 'task', context);
    expect(validation).toEqual({ status: 'VALIDATED', taskRunId: 'run',
      routingContextDigest: routingContextDigest(context), configurationDigest: f.plan.configurationDigest,
      expiresAtMonoMs: 5200 });
    expect(await f.c2b!.validate([batch[0]!], 'run', 'task', context))
      .toEqual({ status: 'INVALID', reason: 'MISSING_PROVIDER_AUTHORITY' });
    const other = new TrustedCurrentUnavailabilityObservationIssuer(f.storage, f.registry, f.engine, f.producer, f.clock);
    expect(await other.validate(batch, 'run', 'task', context)).toEqual({ status: 'INVALID', reason: 'WRONG_ISSUER' });
    const selection = await f.issue();
    expect(selection).toMatchObject({ continuityEvidenceKind: 'TRUSTED_CURRENT_UNAVAILABILITY',
      continuityEvidenceExpiresAtMonoMs: 5400 });
    expect(selection.admission).toMatchObject({ admitted: true,
      evidenceKind: 'TRUSTED_CURRENT_UNAVAILABILITY', configurationRef: f.plan.configurationDigest });
    expect(selection.admission).not.toHaveProperty('kindACondition');
    await expect(f.c2a.validate(selection, 'run', context, f.plan, f.registry, f.engine)).resolves.toBeUndefined();
    f.setNow(5400);
    await expect(f.c2a.validate(selection, 'run', context, f.plan, f.registry, f.engine))
      .rejects.toMatchObject({ reason: 'EVIDENCE_EXPIRED' });
    f.setNow(5401);
    await expect(f.c2a.validate(selection, 'run', context, f.plan, f.registry, f.engine))
      .rejects.toMatchObject({ reason: 'EVIDENCE_EXPIRED' });
  });

  it('denies mismatched validation metadata and producer failure with bounded classification', async () => {
    for (const field of ['taskRunId', 'routingContextDigest', 'configurationDigest'] as const) {
      const f = fixture();
      const real = f.c2b!.validate.bind(f.c2b!);
      vi.spyOn(f.c2b!, 'validate').mockImplementation(async (...args) => {
        const result = await real(...args);
        return result.status === 'VALIDATED' ? { ...result, [field]: 'wrong' } : result;
      });
      expect(await f.admit()).toEqual({ admitted: false, classification: 'C2B_INVALID' });
    }
    const failed = fixture();
    failed.observe.mockRejectedValueOnce(new Error('secret that must not escape'));
    expect(await failed.admit()).toEqual({ admitted: false, classification: 'C2B_UNAVAILABLE' });
    const infra = fixture(); infra.storage.tasks.get.mockRejectedValueOnce(new Error('secret infrastructure detail'));
    expect(await infra.admit()).toEqual({ admitted: false, classification: 'INFRASTRUCTURE' });
    const c2aInfra = fixture();
    c2aInfra.storage.tasks.get.mockRejectedValueOnce(new Error('secret infrastructure detail'));
    await expect(c2aInfra.issue()).rejects.toMatchObject({ reason: 'INFRASTRUCTURE_FAILURE' });
  });

  it('denies one failed cloud issuance, missing producer, and changed canonical configuration', async () => {
    const failed = fixture([['a', true], ['b', true]]);
    failed.observe.mockImplementationOnce(async () => ({ observedAtMonoMs: failed.now(), reason: Reason.ENDPOINT_UNREACHABLE }))
      .mockRejectedValueOnce(new Error('opaque producer failure'));
    expect(await failed.admit()).toEqual({ admitted: false, classification: 'C2B_UNAVAILABLE' });
    expect(failed.observe).toHaveBeenCalledTimes(2);
    const missing = fixture(); Object.assign(missing.c2b!, { producer: undefined });
    expect(await missing.admit()).toEqual({ admitted: false, classification: 'C2B_UNAVAILABLE' });
    const changed = fixture();
    const original = changed.c2b!.issueCanonicalEligibleNetworkSet.bind(changed.c2b!);
    vi.spyOn(changed.c2b!, 'issueCanonicalEligibleNetworkSet').mockImplementationOnce(async taskRunId => {
      const issued = await original(taskRunId);
      Object.assign(changed.c2b!, { engine: new RoutingPolicyEngine({ version: 'v2', policies: [policy] }) });
      return issued;
    });
    expect(await changed.admit()).toEqual({ admitted: false, classification: 'C2B_INVALID' });
  });

  it('rejects expiry on the final C2B clock read after canonical facts', async () => {
    const f = fixture(); const authority = await f.c2b!.issue('run', providerId('a'));
    f.clock.nowMs.mockReturnValueOnce(200).mockReturnValueOnce(200).mockReturnValueOnce(authority.expiresAtMonoMs);
    expect(await f.c2b!.validate([authority], 'run', 'task', context))
      .toEqual({ status: 'INVALID', reason: 'EXPIRED' });
  });

  it('denies invalid local candidates, first-run violations and expired observation without effects', async () => {
    const f = fixture();
    expect(await f.coordinator.admit({ taskRunId: 'run', localProviderId: providerId('a') }))
      .toEqual({ admitted: false, classification: 'POLICY' });
    expect(f.observe).not.toHaveBeenCalled();
    f.runs.unshift({ ...f.run, id: 'prior', status: TaskRunStatus.FAILED });
    expect(await f.admit()).toEqual({ admitted: false, classification: 'POLICY' });
    f.runs.shift();
    f.run.providerId = 'a';
    expect(await f.admit()).toEqual({ admitted: false, classification: 'POLICY' });
    f.run.providerId = undefined;
    vi.spyOn(f.c2b!, 'validate').mockResolvedValueOnce({ status: 'INVALID', reason: 'EXPIRED' });
    expect(await f.admit()).toEqual({ admitted: false, classification: 'C2B_INVALID' });
  });

  it('rejects ambiguous local eligibility in the pure policy and has no real effect path', () => {
    const f = fixture();
    const descriptors = [descriptor('local', ExecutionLocality.LOCAL),
      descriptor('local-2', ExecutionLocality.LOCAL), descriptor('a', ExecutionLocality.NETWORK)];
    const registry = new ProviderRegistry('v1', descriptors.map(d => ({ providerId: d.providerId, descriptor: d })));
    const engine = new RoutingPolicyEngine({ version: 'v1', policies: [policy] });
    const decision = new LocalContinuityAdmission(new WorkloadLocalFallbackPolicy(), engine, registry)
      .evaluateTrustedCurrentUnavailabilityPolicy({ capability: Capability.GENERAL_CHAT,
        routingContext: context, localProviderId: providerId('local'),
        selectionConfigurationRef: engine.staticEligibility(context, registry.snapshot()).configurationDigest });
    expect(decision).toMatchObject({ allowed: false, denialReason: 'LOCAL_SELECTION_NOT_SOLE' });
    for (const file of ['local-continuity-admission-coordinator.ts', 'trusted-current-unavailability-observation.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/\.isAvailable\s*\(|\.execute\s*\(|\bspawn\s*\(|\bfetch\s*\(|process\.env|prepareVerifiedContainmentBinding/);
    }
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('keeps coordinator input narrow and rechecks after admission before mint', () => {
    expect(LocalContinuityAdmissionCoordinator.prototype.admit.length).toBe(1);
    expect(BoundLocalContinuitySelectionIssuer.prototype.issue.length).toBe(2);
    const source = readFileSync(join(__dirname, 'bound-local-continuity-selection.ts'), 'utf8');
    expect(source).toMatch(/const outcome = await this\.coordinator\.admit\([\s\S]*?await this\.canonicalFacts\(taskRunId\)[\s\S]*?const selection:/);
  });

  it('rejects composition with different C2A and C2B monotonic clock instances', () => {
    const f = fixture();
    expect(() => new BoundLocalContinuitySelectionIssuer(f.storage, f.registry, f.engine,
      f.coordinator, { nowMs: () => f.now() })).toThrowError('EVIDENCE_SHAPE_INVALID');
  });
});
