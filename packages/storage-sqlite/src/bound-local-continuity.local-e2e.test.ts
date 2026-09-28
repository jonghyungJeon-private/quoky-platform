import {
  AvailabilityClass,
  ConcurrencyClass,
  ContextCapacity,
  CostTier,
  ExecutionLocality,
  LatencyTier,
  ProviderDescriptor,
  RankingDimension,
  ReliabilityTier,
  RoutingClass,
  RoutingPolicy,
  SemanticRisk,
  SortDirection,
  SupportLevel,
  TerminalDecision,
  TimeoutClass,
  adapterId,
  policyId,
  providerId,
} from '@quoky/core';
import { ProviderRegistry } from '@quoky/core';
import { RoutingPolicyEngine } from '@quoky/core';

import { BoundLocalContinuitySelectionIssuer } from '@quoky/core';

import { describe, expect, it, vi } from 'vitest';
import { AgentProfileRegistry, agentProfileId, ApprovalManager, ApprovalPolicy, Capability,
  ContinuationExecutionEntryService, ContinuationExecutionService,
  createWorkHandoff, ExecutionStatus, IntentType, RiskLevel, RiskPolicy, TaskManager, TaskRunStatus,
  WorkHandoffContinuationService, WorkItemStatus } from '@quoky/core';
import type { ContinuationExecutionRequestContext, ExecutionPlan } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const ts = '2026-09-22T00:00:00.000Z';

/** Real continuation lifecycle with disposable in-memory SQLite; no receiver/provider dispatch. */
async function harness() {
  const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
  await storage.init();
  await storage.workItems.save({ id: 'work', actorId: 'actor', projectId: 'project', status: WorkItemStatus.ACTIVE,
    origin: 'conversation', resourceRefs: [], createdAt: ts, updatedAt: ts });
  await storage.workHandoffs.insert(createWorkHandoff({ id: 'handoff', workItemId: 'work',
    fromAgentProfileId: agentProfileId('source'), toAgentProfileId: agentProfileId('receiver'), objective: 'continue',
    resourceRefs: [], artifactIds: [], executionReceiptIds: [], createdAt: ts }));
  const profiles = new AgentProfileRegistry(['source', 'receiver'].map(id => ({ id: agentProfileId(id), displayName: id,
    role: id, purpose: id, instructions: id })));
  const tasks = new TaskManager(storage);
  const approvals = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  let task = await tasks.createTask({ type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1,
    requiresWork: true, summary: 'continue' }, { platform: 'test', channelId: 'channel', userId: 'user' },
  { actorId: 'actor', projectId: 'project', requestText: 'continue' });
  const plan: ExecutionPlan = { id: 'plan', goal: 'continue', summary: 'continue', projectId: 'project', steps: [],
    requiredCapabilities: [Capability.GENERAL_CHAT], requiredResources: [], estimatedChanges: { fileCount: 0, scope: 'none' },
    approvalRequired: false, overallRisk: RiskLevel.LOW,
    expectedArtifacts: [], status: ExecutionStatus.PENDING, createdAt: ts };
  task = await storage.tasks.save({ ...task, planId: plan.id });
  const preparation = new WorkHandoffContinuationService(storage, profiles, storage.continuationBindings, { tasks, approvals });
  await preparation.admit('handoff', task.id);
  const entry = new ContinuationExecutionEntryService(storage, profiles, storage.continuationBindings, tasks);
  const continuation = new ContinuationExecutionService(storage, profiles, storage.continuationBindings, preparation, entry);
  const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
    handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan };
  const guarded = vi.spyOn(storage.taskRuns, 'guardedStart');
  return { storage, task, continuation, request, guarded };
}

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


describe('R3-C2A realistic first continuation (NB-R2 / NB-R3)', () => {
  it('fresh canonical Task → prepare → admission → guarded start → first-run authority; concurrent start denied', async () => {
    const f = await harness();
    try {
      expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
      const started = await f.continuation.startExplicitContinuation(f.request);
      expect(started.disposition).toBe('ATTEMPT_STARTED');
      if (started.disposition !== 'ATTEMPT_STARTED') throw new Error('expected STARTED');
      const run = started.taskRun;
      expect(run).toMatchObject({ status: TaskRunStatus.STARTED, attempt: 1, taskId: f.task.id });
      const registry = registryOf([descriptor('local')]);
      const issuer = new BoundLocalContinuitySelectionIssuer(f.storage, registry, engineWith());
      const list = f.storage.taskRuns.listByTask.bind(f.storage.taskRuns);
      const history = vi.spyOn(f.storage.taskRuns, 'listByTask').mockImplementation(async id => {
        expect((await f.storage.taskRuns.get(run.id))?.status).toBe(TaskRunStatus.STARTED);
        // Exercise the real effect-time storage guard during C2A's history read (not a fake boolean).
        const [expected, capability] = f.guarded.mock.calls[0]!;
        await expect(f.storage.taskRuns.guardedStart(expected, capability))
          .rejects.toMatchObject({ code: 'UNRESOLVED_STARTED_RUN' });
        return list(id);
      });
      const selection = await issuer.issue(run.id, providerId('local'));
      expect(selection).toMatchObject({ taskRunId: run.id, executionId: run.id, capability: Capability.GENERAL_CHAT,
        attemptNumber: 1, additionalProviderHops: 0 });
      // C2A and the canonical admission coordinator independently verify first-run history.
      expect(history).toHaveBeenCalledTimes(2);
      history.mockRestore();
      expect(await list(f.task.id)).toEqual([run]);
      // Issuance itself does not mutate the database beyond the normal fixture/start lifecycle.
      expect(await f.storage.taskRuns.get(run.id)).toEqual(run);
      expect(await f.storage.tasks.get(f.task.id)).toMatchObject({ intent: { capability: Capability.GENERAL_CHAT } });
    } finally { await f.storage.close(); }
  });

  it.each([TaskRunStatus.FAILED, TaskRunStatus.SUCCEEDED])('real prior %s run permits generic rerun but never C2A authority', async status => {
    const f = await harness();
    try {
      const first = await f.continuation.startExplicitContinuation(f.request);
      if (first.disposition !== 'ATTEMPT_STARTED') throw new Error('expected STARTED');
      await f.storage.taskRuns.terminalizePreservingSecurityEvidence(first.taskRun.id, { terminalStatus: status, finishedAt: ts });
      const second = await f.continuation.startExplicitContinuation(f.request);
      if (second.disposition !== 'ATTEMPT_STARTED') throw new Error('expected rerun');
      expect(second.taskRun.attempt).toBe(2);
      const issuer = new BoundLocalContinuitySelectionIssuer(f.storage, registryOf([descriptor('local')]), engineWith());
      await expect(issuer.issue(second.taskRun.id, providerId('local'))).rejects.toMatchObject({ reason: 'NOT_FIRST_RUN' });
      expect(await f.storage.taskRuns.listByTask(f.task.id)).toHaveLength(2);
    } finally { await f.storage.close(); }
  });
});
