import { createHash } from 'node:crypto';
import type { AiProvider } from '../ports';
import { BoundLocalContinuitySelectionIssuer, type BoundLocalContinuitySelection } from './bound-local-continuity-selection';
import { continuationRoutingContext } from './continuation-routing-context';
import { routingContextDigest } from './routing-context-digest';
import { assertExactSoleProviderSelection } from './continuation-prepared-containment';
import * as containment from './continuation-prepared-containment';
import { ContinuationProviderRoutingService } from './continuation-provider-routing-service';
import { ProviderBindingRegistry } from './provider-binding-registry';
import { DeadlineClass, ProviderExecutionPlanner, type ProviderExecutionPlan } from './provider-execution-plan';
import { ProviderRoutingGateway } from './provider-routing-gateway';
import { createDefaultValidationProfileRegistry } from './validation-profile-registry';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capability, IntentType, RiskLevel, TaskStatus, TaskRunStatus, type Task, type TaskRun } from '../domain';
import {
  ProviderAvailability,
  AuthorityRequirement,
  AvailabilityClass,
  ConcurrencyClass,
  ContextCapacity,
  CostTier,
  ExecutionLocality,
  LatencyClass,
  LatencyTier,
  OutputSizeClass,
  ProviderDescriptor,
  RankingDimension,
  ReliabilityTier,
  Requirement,
  RoutingClass,
  RoutingContext,
  RoutingPolicy,
  RoutingRequestType,
  SemanticRisk,
  SortDirection,
  SupportLevel,
  TerminalDecision,
  TimeoutClass,
  adapterId,
  policyId,
  providerId,
  validationProfileId,
} from './provider-routing-contracts';
import { ProviderRegistry } from './provider-registry';
import { RoutingPolicyEngine } from './routing-policy-engine';
import { LocalContinuityAdmission } from './local-continuity-admission';

interface DescriptorOptions {
  locality?: ExecutionLocality;
  semantic?: ReliabilityTier;
  context?: ContextCapacity;
  enabled?: boolean;
  capabilities?: readonly Capability[];
  availabilityClass?: AvailabilityClass;
  toolUse?: SupportLevel;
  routingClass?: RoutingClass;
}

function descriptor(id: string, options: DescriptorOptions = {}): ProviderDescriptor {
  return {
    providerId: providerId(id),
    adapterId: adapterId('fixture-adapter'),
    modelId: `opaque-${id}`,
    capabilities: {
      supportedCapabilities: options.capabilities ?? [Capability.GENERAL_CHAT],
      routingClasses: [options.routingClass ?? RoutingClass.BALANCED],
      semanticReliability: options.semantic ?? ReliabilityTier.STANDARD,
      authorityReliability: ReliabilityTier.STANDARD,
      continuityReliability: ReliabilityTier.STANDARD,
      toolUse: options.toolUse ?? SupportLevel.UNSUPPORTED,
      structuredOutput: SupportLevel.SUPPORTED,
      contextCapacity: options.context ?? ContextCapacity.MEDIUM,
      streaming: SupportLevel.UNSUPPORTED,
      executionLocality: options.locality ?? ExecutionLocality.LOCAL,
    },
    operationalProfile: {
      latencyTier: LatencyTier.BALANCED,
      timeoutClass: TimeoutClass.STANDARD,
      costTier: CostTier.LOW,
      concurrencyClass: ConcurrencyClass.LIMITED,
      availabilityClass: options.availabilityClass ?? AvailabilityClass.LOCAL_STABLE,
    },
    enabled: options.enabled ?? true,
    profileVersion: 'profile-v1',
  };
}

function registryOf(values: readonly ProviderDescriptor[]): ProviderRegistry {
  return new ProviderRegistry(
    'registry-v1',
    values.map((value) => ({ providerId: value.providerId, descriptor: value })),
  );
}

const BASE_POLICY: RoutingPolicy = {
  policyId: policyId('balanced-v1'),
  version: '1.0.0',
  precedence: 10,
  when: { semanticRisks: [SemanticRisk.STANDARD, SemanticRisk.UNKNOWN] },
  eligibility: {},
  ranking: [
    { dimension: RankingDimension.SEMANTIC_RELIABILITY, direction: SortDirection.DESCENDING },
    { dimension: RankingDimension.LATENCY_TIER, direction: SortDirection.ASCENDING },
  ],
  terminal: TerminalDecision.NO_SELECTION,
};

const engineWith = (policies: readonly RoutingPolicy[] = [BASE_POLICY], version = 'policy-set-v1') =>
  new RoutingPolicyEngine({ version, policies });


const facts = { capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT };
const context = continuationRoutingContext(facts)!;
const ts = '2026-09-28T00:00:00.000Z';
function fixture() {
  const task: Task = { id: 'task', status: TaskStatus.RUNNING, title: 'continue',
    intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'continue' },
    riskLevel: RiskLevel.LOW, context: { platform: 'test', channelId: 'channel', userId: 'user' }, createdAt: ts, updatedAt: ts };
  const run: TaskRun = { id: 'run', taskId: task.id, status: TaskRunStatus.STARTED, attempt: 1,
    capability: Capability.GENERAL_CHAT, artifactIds: [], startedAt: ts };
  const runs = [run];
  const storage = { tasks: { get: vi.fn(async () => task) }, taskRuns: {
    get: vi.fn(async (id: string) => runs.find(r => r.id === id) ?? null),
    listByTask: vi.fn(async () => runs),
  } };
  const registry = registryOf([descriptor('local')]);
  const engine = engineWith();
  const issuer = new BoundLocalContinuitySelectionIssuer(storage, registry, engine);
  const provider: AiProvider = { id: 'local', capabilities: [], isAvailable: vi.fn(async () => true),
    execute: vi.fn(async () => ({ text: 'must not execute' })) };
  const bindings = [{ providerId: providerId('local'), adapterId: adapterId('fixture-adapter'),
    modelId: 'opaque-local', bindingVersion: 'v1', provider }];
  const validationProfiles = createDefaultValidationProfileRegistry();
  // Offline fixture availability only: C2A itself never probes or fabricates availability.
  const snapshot = registry.snapshot({ local: ProviderAvailability.AVAILABLE });
  const decision = engine.select(context, snapshot);
  const plan = new ProviderExecutionPlanner().create(decision, snapshot,
    new ProviderBindingRegistry(snapshot, bindings), validationProfiles,
    { capability: facts.capability, validationProfile: context.validationProfile, deadlineClass: DeadlineClass.STANDARD, executionId: run.id });
  const validate = (selection: BoundLocalContinuitySelection, overrides: Partial<ProviderExecutionPlan> = {}) =>
    issuer.validate(selection, run.id, context, { ...plan, ...overrides }, registry, engine);
  const service = new ContinuationProviderRoutingService({ providerRegistry: registry, policyEngine: engine,
    bindings, validationProfiles, configurationVersion: 'audit-v1', configurationDigest: 'a'.repeat(64), localContinuityIssuer: issuer });
  return { task, run, runs, storage, registry, engine, issuer, provider, plan, validate, service };
}

afterEach(() => vi.restoreAllMocks());

describe('R3-C2A bound authority', () => {
  it('issues only from canonical STARTED facts and actual R3-C1 admission, with no writes/preparation/trust', async () => {
    const f = fixture();
    const admit = vi.spyOn(LocalContinuityAdmission.prototype, 'admit');
    const prepare = vi.spyOn(containment, 'prepareVerifiedContainmentBinding');
    const candidate = vi.spyOn(containment, 'createContainmentCandidateBinding');
    const selection = await f.issuer.issue('run', providerId('local'));
    expect(selection.admission).toBe(admit.mock.results[0]!.value.decision);
    expect(selection.soleSelection).toBe(admit.mock.results[0]!.value.soleSelection);
    expect(selection).toMatchObject({ executionId: 'run', taskRunId: 'run', taskId: 'task',
      capability: Capability.GENERAL_CHAT, providerId: 'local', attemptNumber: 1, additionalProviderHops: 0,
      configurationDigest: f.plan.configurationDigest, routingContextDigest: routingContextDigest(context) });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.admission)).toBe(true);
    await expect(f.validate(selection)).resolves.toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(candidate).not.toHaveBeenCalled();
    expect(selection).not.toHaveProperty('provenance');
    expect(selection).not.toHaveProperty('capabilityIssuer');
    expect(f.provider.isAvailable).not.toHaveBeenCalled();
    expect(f.provider.execute).not.toHaveBeenCalled();
  });

  it('rejects admission literals, bare selections, spread/JSON copies and prototype lookalikes', async () => {
    const f = fixture();
    const selection = await f.issuer.issue('run', providerId('local'));
    const bare = assertExactSoleProviderSelection({ eligibleProviderIds: ['local'], selectedProviderId: 'local', primaryOnly: true });
    for (const forged of [{ admitted: true }, selection.admission, bare, { ...selection },
      JSON.parse(JSON.stringify(selection)), Object.create(selection)]) {
      await expect(f.validate(forged as BoundLocalContinuitySelection)).rejects.toMatchObject({ reason: 'NOT_ISSUED' });
    }
    await expect(f.issuer.issue({ admitted: true } as unknown as string, providerId('local'))).rejects.toMatchObject({ reason: 'INVALID_RUN' });
  });

  it('rejects authority from another issuance context even with identical stored/configuration facts', async () => {
    const f = fixture();
    const other = new BoundLocalContinuitySelectionIssuer(f.storage, f.registry, f.engine);
    const selection = await other.issue('run', providerId('local'));
    await expect(f.validate(selection)).rejects.toMatchObject({ reason: 'NOT_ISSUED' });
  });

  it('rejects missing/not-STARTED run before admission and rejects a non-admitted candidate', async () => {
    const f = fixture();
    const admit = vi.spyOn(LocalContinuityAdmission.prototype, 'admit');
    await expect(f.issuer.issue('absent', providerId('local'))).rejects.toMatchObject({ reason: 'INVALID_RUN' });
    f.run.status = TaskRunStatus.FAILED;
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'INVALID_RUN' });
    expect(admit).not.toHaveBeenCalled();
    f.run.status = TaskRunStatus.STARTED;
    await expect(f.issuer.issue('run', providerId('wrong'))).rejects.toMatchObject({ reason: 'ADMISSION_DENIED' });
  });

  it.each([TaskRunStatus.FAILED, TaskRunStatus.SUCCEEDED])('rejects prior %s history, including malformed attempt=1', async status => {
    for (const attempt of [1, 2]) {
      const f = fixture();
      f.runs.unshift({ ...f.run, id: 'prior', status });
      f.run.attempt = attempt;
      await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
    }
  });

  it('rejects ordinal 2 even if malformed history has only current run; rejects empty/duplicate history', async () => {
    const f = fixture();
    f.run.attempt = 2;
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
    f.run.attempt = 1;
    f.storage.taskRuns.listByTask.mockResolvedValueOnce([]).mockResolvedValueOnce([f.run, f.run]);
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
  });

  it('checks history while STARTED and rejects terminalization during the read', async () => {
    const f = fixture();
    f.storage.taskRuns.listByTask.mockImplementation(async () => {
      expect(f.run.status).toBe(TaskRunStatus.STARTED);
      const snapshot = [{ ...f.run }];
      f.run.status = TaskRunStatus.SUCCEEDED;
      return snapshot;
    });
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'INVALID_RUN' });
  });

  it('rechecks stored history and status on consumption', async () => {
    const f = fixture();
    const selection = await f.issuer.issue('run', providerId('local'));
    f.runs.push({ ...f.run, id: 'prior', status: TaskRunStatus.FAILED });
    await expect(f.validate(selection)).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
    f.runs.pop();
    f.run.status = TaskRunStatus.SUCCEEDED;
    await expect(f.validate(selection)).rejects.toMatchObject({ reason: 'INVALID_RUN' });
  });

  it('rejects wrong execution, wrong plan run, and replay across runs of the same Task', async () => {
    const f = fixture();
    const selection = await f.issuer.issue('run', providerId('local'));
    await expect(f.issuer.validate(selection, 'other', context, f.plan, f.registry, f.engine))
      .rejects.toMatchObject({ reason: 'EXECUTION_MISMATCH' });
    await expect(f.validate(selection, { executionId: 'other' })).rejects.toMatchObject({ reason: 'EXECUTION_MISMATCH' });
    f.run.status = TaskRunStatus.SUCCEEDED;
    f.runs.push({ ...f.run, id: 'run2', attempt: 2, status: TaskRunStatus.STARTED });
    await expect(f.issuer.validate(selection, 'run2', context, { ...f.plan, executionId: 'run2' }, f.registry, f.engine))
      .rejects.toMatchObject({ reason: 'EXECUTION_MISMATCH' });
  });

  it.each(['primary', 'operationalFallback', 'semanticEscalation'] as const)('rejects altered plan %s', async field => {
    const f = fixture();
    const selection = await f.issuer.issue('run', providerId('local'));
    await expect(f.validate(selection, { [field]: { ...f.plan.primary, providerId: providerId('other') } }))
      .rejects.toMatchObject({ reason: 'PRIMARY_ONLY_VIOLATION' });
  });

  it.each(['attemptNumber', 'additionalProviderHops'] as const)('defensively rejects noncanonical R3-C1 %s', async field => {
    const f = fixture();
    const original = LocalContinuityAdmission.prototype.admit;
    vi.spyOn(LocalContinuityAdmission.prototype, 'admit').mockImplementation(function (this: LocalContinuityAdmission, input) {
      const result = original.call(this, input);
      return { ...result, decision: { ...result.decision, [field]: 2 } };
    });
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'ADMISSION_DENIED' });
  });

  it('rejects configuration mismatch and registry/policy replacement at consumption', async () => {
    const f = fixture();
    const selection = await f.issuer.issue('run', providerId('local'));
    await expect(f.validate(selection, { configurationDigest: 'a'.repeat(64) }))
      .rejects.toMatchObject({ reason: 'CONFIGURATION_MISMATCH' });
    for (const [registry, engine] of [[registryOf([descriptor('local', { enabled: false })]), f.engine],
      [f.registry, engineWith([BASE_POLICY], 'policy-v2')]] as const) {
      await expect(f.issuer.validate(selection, 'run', context, f.plan, registry, engine))
        .rejects.toMatchObject({ reason: 'CONFIGURATION_MISMATCH' });
    }
  });

  it('does not permit caller relabeling, unsupported workloads, or inconsistent stored capability', async () => {
    const f = fixture();
    f.task.intent.capability = Capability.CODE_IMPLEMENTATION;
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'WORKLOAD_MISMATCH' });
    f.run.capability = Capability.CODE_IMPLEMENTATION;
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'WORKLOAD_MISMATCH' });
    f.run.capability = f.task.intent.capability = Capability.SUMMARIZATION;
    await expect(f.issuer.issue('run', providerId('local'))).rejects.toMatchObject({ reason: 'WORKLOAD_MISMATCH' });
    f.run.capability = f.task.intent.capability = Capability.GENERAL_CHAT;
    const selection = await f.issuer.issue('run', providerId('local'));
    f.task.intent.capability = Capability.CODE_IMPLEMENTATION;
    const result = await f.service.execute({ executionId: 'run', facts,
      request: { capability: Capability.GENERAL_CHAT, prompt: 'relabel' }, localContinuity: { selection, plan: f.plan } });
    expect(result.audit.attemptCount).toBe(0);
    expect(f.provider.isAvailable).not.toHaveBeenCalled();
  });

  it.each(['valid', 'forged', 'bare', 'wrong-provider', 'fallback', 'escalation', 'wrong-run'])('orchestration %s is zero probe/dispatch/preparation and never switches provider', async scenario => {
    const f = fixture();
    const gateway = vi.spyOn(ProviderRoutingGateway.prototype, 'execute');
    const validate = vi.spyOn(f.issuer, 'validate');
    let selection = await f.issuer.issue('run', providerId('local'));
    let plan = f.plan;
    if (scenario === 'forged') selection = { ...selection };
    if (scenario === 'bare') selection = selection.soleSelection as unknown as BoundLocalContinuitySelection;
    if (scenario === 'wrong-provider') plan = { ...plan, primary: { ...plan.primary, providerId: providerId('other') } };
    if (scenario === 'fallback') plan = { ...plan, operationalFallback: plan.primary };
    if (scenario === 'escalation') plan = { ...plan, semanticEscalation: plan.primary };
    const result = await f.service.execute({ executionId: scenario === 'wrong-run' ? 'other' : 'run', facts,
      request: { capability: Capability.GENERAL_CHAT, prompt: 'continue' }, localContinuity: { selection, plan } });
    expect(validate).toHaveBeenCalledTimes(1);
    if (scenario === 'valid') await expect(validate.mock.results[0]!.value).resolves.toBeUndefined();
    else await expect(validate.mock.results[0]!.value).rejects.toBeDefined();
    expect(result.audit).toMatchObject({ terminalStatus: 'PRE_DISPATCH_FAILED', dispatchEvidence: 'NOT_DISPATCHED', attemptCount: 0, attempts: [] });
    expect(f.provider.isAvailable).not.toHaveBeenCalled();
    expect(f.provider.execute).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });
});

describe('RoutingContextDigest R33', () => {
  it('uses exact domain and canonical ten-field order independent of input insertion order', () => {
    const shape = { capability: context.capability, requestType: context.requestType, intentType: context.intentType,
      semanticRisk: context.semanticRisk, latencyClass: context.latencyClass, toolUseRequirement: context.toolUseRequirement,
      authorityRequirement: context.authorityRequirement, continuityRequirement: context.continuityRequirement,
      expectedOutputSize: context.expectedOutputSize, validationProfile: context.validationProfile };
    const expected = createHash('sha256').update(JSON.stringify({ domain: 'quoky:r3-c2:routing-context:v1', shape })).digest('hex');
    expect(routingContextDigest(context)).toBe(expected);
    expect(routingContextDigest(Object.fromEntries(Object.entries(context).reverse()) as unknown as RoutingContext)).toBe(expected);
  });

  it.each([
    ['capability', Capability.SUMMARIZATION], ['requestType', RoutingRequestType.CONVERSATIONAL],
    ['intentType', IntentType.PROJECT_ANALYSIS], ['semanticRisk', SemanticRisk.UNKNOWN],
    ['latencyClass', LatencyClass.INTERACTIVE], ['toolUseRequirement', Requirement.REQUIRED],
    ['authorityRequirement', AuthorityRequirement.REQUIRED], ['continuityRequirement', Requirement.REQUIRED],
    ['expectedOutputSize', OutputSizeClass.SMALL], ['validationProfile', validationProfileId('general-chat-v1')],
  ])('binds changed %s and rejects its replay', async (field, value) => {
    const f = fixture();
    const selection = await f.issuer.issue('run', providerId('local'));
    const changed = { ...context, [field]: value } as RoutingContext;
    expect(routingContextDigest(changed)).not.toBe(selection.routingContextDigest);
    await expect(f.issuer.validate(selection, 'run', changed, f.plan, f.registry, f.engine)).rejects.toBeDefined();
  });
});
