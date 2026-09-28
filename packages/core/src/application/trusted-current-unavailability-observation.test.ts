import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Capability, IntentType, RiskLevel, TaskRunStatus, TaskStatus, type Task, type TaskRun } from '../domain';
import { TrustedUnavailabilityObservationSource as Source, TrustedUnavailabilityReason as Reason } from '../ports';
import type { CurrentUnavailabilityObservationProducer } from '../ports';
import { continuationRoutingContext } from './continuation-routing-context';
import { assertTrustedCurrentUnavailabilityUnsupported } from './local-continuity-admission';
import {
  TrustedCurrentUnavailabilityObservationIssuer as Issuer,
  MAX_OBSERVATION_TO_ISSUANCE_DELAY_MS,
  MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS,
  type TrustedCurrentUnavailabilityObservation,
} from './trusted-current-unavailability-observation';
import {
  AvailabilityClass, ConcurrencyClass, ContextCapacity, CostTier, ExecutionLocality,
  LatencyTier, RankingDimension, ReliabilityTier, RoutingClass, SemanticRisk, SortDirection, SupportLevel,
  TerminalDecision, TimeoutClass, adapterId, policyId, providerId,
  type ProviderDescriptor, type RoutingPolicy,
} from './provider-routing-contracts';
import { ProviderRegistry } from './provider-registry';
import { RoutingPolicyEngine } from './routing-policy-engine';
import { routingContextDigest } from './routing-context-digest';

function descriptor(id: string, enabled = true, locality = ExecutionLocality.NETWORK,
  semantic = ReliabilityTier.STANDARD): ProviderDescriptor {
  return { providerId: providerId(id), adapterId: adapterId('fixture'), modelId: `opaque-${id}`,
    capabilities: { supportedCapabilities: [Capability.GENERAL_CHAT], routingClasses: [RoutingClass.BALANCED],
      semanticReliability: semantic, authorityReliability: ReliabilityTier.STANDARD,
      continuityReliability: ReliabilityTier.STANDARD, toolUse: SupportLevel.UNSUPPORTED,
      structuredOutput: SupportLevel.SUPPORTED, contextCapacity: ContextCapacity.MEDIUM,
      streaming: SupportLevel.UNSUPPORTED, executionLocality: locality },
    operationalProfile: { latencyTier: LatencyTier.BALANCED, timeoutClass: TimeoutClass.STANDARD,
      costTier: CostTier.LOW, concurrencyClass: ConcurrencyClass.LIMITED,
      availabilityClass: AvailabilityClass.LOCAL_STABLE }, enabled, profileVersion: 'v1' };
}
const registry = (...descriptors: ProviderDescriptor[]) => new ProviderRegistry('v1',
  descriptors.map(d => ({ providerId: d.providerId, descriptor: d })));
const basePolicy: RoutingPolicy = { policyId: policyId('policy'), version: 'v1', precedence: 1,
  when: { semanticRisks: [SemanticRisk.STANDARD] }, eligibility: {},
  ranking: [{ dimension: RankingDimension.SEMANTIC_RELIABILITY, direction: SortDirection.DESCENDING }],
  terminal: TerminalDecision.NO_SELECTION };
const engine = (policy: RoutingPolicy = basePolicy) => new RoutingPolicyEngine({ version: 'v1', policies: [policy] });
const context = continuationRoutingContext({ capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT })!;
const stamp = '2026-09-28T00:00:00.000Z';

function fixture(descriptors: ProviderDescriptor[] = [descriptor('a')], policy = basePolicy) {
  const task: Task = { id: 'task', title: 'task', status: TaskStatus.RUNNING,
    intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1,
      requiresWork: true, summary: 'test' }, riskLevel: RiskLevel.LOW,
    context: { platform: 'test', channelId: 'channel', userId: 'user' }, createdAt: stamp, updatedAt: stamp };
  const run: TaskRun = { id: 'run', taskId: 'task', status: TaskRunStatus.STARTED,
    capability: Capability.GENERAL_CHAT, attempt: 1, artifactIds: [], startedAt: stamp };
  const runs = [run];
  const storage = { tasks: { get: vi.fn(async () => task) }, taskRuns: {
    get: vi.fn(async (id: string) => runs.find(r => r.id === id) ?? null),
    listByTask: vi.fn(async () => runs),
  } };
  let now = 100;
  let observedAt = 100;
  const clock = { nowMs: vi.fn(() => now) };
  const producer: CurrentUnavailabilityObservationProducer = {
    source: Source.TEST_FAKE,
    observe: vi.fn(async () => ({ observedAtMonoMs: observedAt, reason: Reason.ENDPOINT_UNREACHABLE })),
  };
  const providerRegistry = registry(...descriptors);
  const policyEngine = engine(policy);
  const issuer = new Issuer(storage, providerRegistry, policyEngine, producer, clock);
  const issue = (id = 'a') => issuer.issue('run', providerId(id));
  const validate = (authorities: readonly TrustedCurrentUnavailabilityObservation[],
    currentRegistry = providerRegistry, currentEngine = policyEngine) =>
    issuer.validate(authorities, 'run', 'task', context, currentRegistry, currentEngine);
  return { task, run, runs, storage, clock, producer, providerRegistry, policyEngine, issuer,
    issue, validate, setNow: (value: number) => { now = value; },
    setObserved: (value: number) => { observedAt = value; } };
}

describe('R3-C2B-1 trusted observation authority', () => {
  it('mints immutable issuer-local evidence from canonical facts and producer only', async () => {
    const f = fixture();
    const a = await f.issue();
    expect(a).toMatchObject({ providerId: 'a', taskId: 'task', taskRunId: 'run', executionId: 'run',
      capability: Capability.GENERAL_CHAT, routingContextDigest: routingContextDigest(context),
      configurationDigest: f.policyEngine.staticEligibility(context, f.providerRegistry.snapshot()).configurationDigest,
      source: Source.TEST_FAKE, reason: Reason.ENDPOINT_UNREACHABLE, observedAtMonoMs: 100,
      validFromMonoMs: 100, expiresAtMonoMs: 5100 });
    expect(Object.isFrozen(a)).toBe(true);
    expect(f.producer.observe).toHaveBeenCalledWith(Object.freeze({ providerId: 'a', taskId: 'task',
      executionId: 'run', capability: Capability.GENERAL_CHAT,
      routingContextDigest: routingContextDigest(context), configurationDigest: a.configurationDigest }));
    expect(await f.validate([a])).toEqual({ status: 'VALIDATED' });
    expect(f.clock.nowMs).toHaveBeenCalledTimes(5);
    expect(Issuer.prototype.issue.length).toBe(2);
  });

  it('rejects structural, spread, JSON and cross-issuer authority', async () => {
    const f = fixture(); const a = await f.issue();
    for (const copy of [{ ...a }, JSON.parse(JSON.stringify(a)), Object.create(a)]) {
      expect(await f.validate([copy as TrustedCurrentUnavailabilityObservation])).toEqual({ status: 'INVALID', reason: 'NOT_ISSUED' });
    }
    const other = new Issuer(f.storage, f.providerRegistry, f.policyEngine, f.producer, f.clock);
    expect(await other.validate([a], 'run', 'task', context)).toEqual({ status: 'INVALID', reason: 'WRONG_ISSUER' });
  });

  it('rejects reserved production source before invoking it', async () => {
    const f = fixture();
    const reserved = { source: Source.CANONICAL_PROVIDER_REACHABILITY_PROBE,
      observe: vi.fn(async () => ({ observedAtMonoMs: 100, reason: Reason.ENDPOINT_UNREACHABLE })) };
    const issuer = new Issuer(f.storage, f.providerRegistry, f.policyEngine, reserved, f.clock);
    await expect(issuer.issue('run', providerId('a'))).rejects.toMatchObject({ reason: 'SOURCE_NOT_ALLOWED' });
    expect(reserved.observe).not.toHaveBeenCalled();
  });

  it('bounds producer timestamps with issuer before/after reads', async () => {
    for (const observed of [99, 101, NaN, Infinity, -1]) {
      const f = fixture(); f.setObserved(observed);
      await expect(f.issue()).rejects.toMatchObject({ reason: 'TIME_INVALID' });
    }
    const f = fixture(); f.setObserved(100);
    expect(await f.issue()).toMatchObject({ observedAtMonoMs: 100 });
  });

  it('enforces inclusive start, exclusive expiry and never refreshes expiry', async () => {
    const f = fixture(); const a = await f.issue();
    f.setNow(99); expect(await f.validate([a])).toEqual({ status: 'INVALID', reason: 'TIME_INVALID' });
    // A fresh issuer tests not-yet-valid without a backward clock.
    const g = fixture();
    const b = await g.issue();
    g.setNow(100); expect(await g.validate([b])).toEqual({ status: 'VALIDATED' });
    g.setNow(5099); expect(await g.validate([b])).toEqual({ status: 'VALIDATED' });
    g.setNow(5100); expect(await g.validate([b])).toEqual({ status: 'INVALID', reason: 'EXPIRED' });
    g.setNow(5200); expect(await g.validate([b])).toEqual({ status: 'INVALID', reason: 'EXPIRED' });
    expect(b.expiresAtMonoMs).toBe(5100);
    expect(MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS).toBe(5000);
    expect(MAX_OBSERVATION_TO_ISSUANCE_DELAY_MS).toBe(1000);
  });

  it('rejects delayed, backward and non-finite clocks at issuance and validation', async () => {
    const f = fixture();
    f.clock.nowMs.mockReturnValueOnce(100).mockReturnValueOnce(1101).mockReturnValueOnce(1101);
    await expect(f.issue()).rejects.toMatchObject({ reason: 'TIME_INVALID' });
    const g = fixture(); const a = await g.issue();
    g.setNow(NaN); expect(await g.validate([a])).toEqual({ status: 'INVALID', reason: 'TIME_INVALID' });
    const h = fixture(); await h.issue(); h.setNow(99);
    await expect(h.issue()).rejects.toMatchObject({ reason: 'TIME_INVALID' });
  });

  it('does not mint if the TaskRun terminalizes during asynchronous observation', async () => {
    const f = fixture();
    vi.mocked(f.producer.observe).mockImplementationOnce(async () => {
      f.run.status = TaskRunStatus.SUCCEEDED;
      return { observedAtMonoMs: 100, reason: Reason.ENDPOINT_UNREACHABLE };
    });
    await expect(f.issue()).rejects.toMatchObject({ reason: 'EXECUTION_MISMATCH' });
  });

  it('requires exact enabled compatible NETWORK set with no missing, extra or duplicate authority', async () => {
    const f = fixture([descriptor('a'), descriptor('b'), descriptor('disabled', false),
      descriptor('local', true, ExecutionLocality.LOCAL)]);
    const a = await f.issue('a'); const b = await f.issue('b');
    expect(await f.validate([a])).toEqual({ status: 'INVALID', reason: 'MISSING_PROVIDER_AUTHORITY' });
    expect(await f.validate([a, b])).toEqual({ status: 'VALIDATED' });
    expect(await f.validate([a, a, b])).toEqual({ status: 'INVALID', reason: 'DUPLICATE_PROVIDER_AUTHORITY' });
    await expect(f.issue('disabled')).rejects.toMatchObject({ reason: 'PROVIDER_SET_MISMATCH' });
    const expanded = registry(descriptor('a'), descriptor('b'), descriptor('ghost'));
    expect(await f.validate([a, b], expanded)).toEqual({ status: 'INVALID', reason: 'CONFIGURATION_MISMATCH' });
    const g = fixture([descriptor('a'), descriptor('b'), descriptor('ghost')]);
    const ghost = await g.issue('ghost');
    expect(await g.validate([ghost])).toEqual({ status: 'INVALID', reason: 'MISSING_PROVIDER_AUTHORITY' });
    expect(await f.validate([a, b, ghost])).toEqual({ status: 'INVALID', reason: 'WRONG_ISSUER' });
  });

  it('excludes incompatible clouds and rejects policy/config changes', async () => {
    const strict = { ...basePolicy, eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH } } as RoutingPolicy;
    const f = fixture([descriptor('a', true, ExecutionLocality.NETWORK, ReliabilityTier.HIGH),
      descriptor('b', true, ExecutionLocality.NETWORK, ReliabilityTier.STANDARD)], strict);
    const a = await f.issue();
    expect(await f.validate([a])).toEqual({ status: 'VALIDATED' });
    await expect(f.issue('b')).rejects.toMatchObject({ reason: 'PROVIDER_SET_MISMATCH' });
    expect(await f.validate([a], f.providerRegistry, engine({ ...strict, version: 'v2' }))).toEqual({
      status: 'INVALID', reason: 'CONFIGURATION_MISMATCH' });
  });

  it('rejects empty sets for no policy, local-only, A1, A2 and incompatibility', async () => {
    const cases = [
      fixture([descriptor('local', true, ExecutionLocality.LOCAL)], basePolicy),
      fixture([descriptor('a', false)]),
      fixture([descriptor('a')], { ...basePolicy, when: { semanticRisks: [SemanticRisk.HIGH] } }),
      fixture([descriptor('a')], { ...basePolicy, eligibility: { executionLocality: ExecutionLocality.LOCAL } }),
      fixture([descriptor('a')], { ...basePolicy, eligibility: { minimumSemanticReliability: ReliabilityTier.HIGH } }),
    ];
    for (const f of cases) {
      expect(await f.validate([])).toEqual({ status: 'INVALID', reason: 'PROVIDER_SET_MISMATCH' });
      await expect(f.issue()).rejects.toMatchObject({ reason: 'PROVIDER_SET_MISMATCH' });
    }
  });

  it('binds task, execution, context, workload and first-run canonical history', async () => {
    const f = fixture(); const a = await f.issue();
    expect(await f.issuer.validate([a], 'run', 'other', context)).toEqual({ status: 'INVALID', reason: 'TASK_MISMATCH' });
    expect(await f.issuer.validate([a], 'other', 'task', context)).toEqual({ status: 'INVALID', reason: 'EXECUTION_MISMATCH' });
    expect(await f.issuer.validate([a], 'run', 'task', { ...context, latencyClass: 'FAST' } as typeof context))
      .toEqual({ status: 'INVALID', reason: 'ROUTING_CONTEXT_MISMATCH' });
    f.run.attempt = 2; expect(await f.validate([a])).toEqual({ status: 'INVALID', reason: 'NOT_FIRST_RUN' });
    f.run.attempt = 1; f.run.status = TaskRunStatus.FAILED;
    expect(await f.validate([a])).toEqual({ status: 'INVALID', reason: 'EXECUTION_MISMATCH' });
    f.run.status = TaskRunStatus.STARTED; f.task.intent!.capability = Capability.CODE_IMPLEMENTATION;
    expect(await f.validate([a])).toEqual({ status: 'INVALID', reason: 'WORKLOAD_MISMATCH' });
  });

  it('rejects prior FAILED or SUCCEEDED runs', async () => {
    for (const status of [TaskRunStatus.FAILED, TaskRunStatus.SUCCEEDED]) {
      const f = fixture(); f.runs.unshift({ ...f.run, id: 'prior', status });
      await expect(f.issue()).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
    }
  });

  it('has no provider, process, network, secret, containment or production fake wiring', async () => {
    const f = fixture(); const a = await f.issue();
    expect(await f.validate([a])).toEqual({ status: 'VALIDATED' });
    expect(() => assertTrustedCurrentUnavailabilityUnsupported()).toThrow();
    const implementation = readFileSync(join(__dirname, 'trusted-current-unavailability-observation.ts'), 'utf8');
    expect(implementation).not.toMatch(/\.isAvailable\s*\(|\.execute\s*\(|\bspawn\s*\(|\bfetch\s*\(|process\.env|prepareVerifiedContainmentBinding/);
    const root = join(__dirname, '../../../../apps/quoky/src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)] : []);
    for (const file of files(root)) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/TrustedCurrentUnavailabilityObservationIssuer|TEST_FAKE/);
    }
  });
});
