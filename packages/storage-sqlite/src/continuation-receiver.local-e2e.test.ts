import { constrainedContinuation, constrainedEntry } from '../../core/src/application/continuation-execution-internal';
import { describe, expect, it, vi } from 'vitest';
import { AgentProfileRegistry, agentProfileId, ApprovalManager, ApprovalPolicy, Capability,
  ContinuationExecutionEntryService, ContinuationExecutionService, ContinuationReceiverExecutionService, ProviderDispatchCommitCoordinator,
  createWorkHandoff, ExecutionStatus, IntentType, RiskLevel, RiskPolicy, TaskManager, TaskRunStatus,
  TaskStatus, WorkHandoffContinuationService, WorkItemStatus } from '@quoky/core';
import type { ContinuationExecutionRequestContext, ContinuationReceiverInput, ContinuationReceiverOutcome, ExecutionPlan } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const ts = '2026-09-22T00:00:00.000Z';
describe('M3E-6K offline exact-run persistence with real 6J and fake receiver', () => {
  it.each(['SUCCEEDED', 'FAILED', 'THROW'] as const)('persists exact %s outcome without Task terminalization', async mode => {
    const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
    await storage.init();
    try {
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
      const receiver = { supportedCapabilities: Object.freeze([Capability.GENERAL_CHAT]), receive: vi.fn(async (_input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> => {
        if (mode === 'THROW') throw new Error('SENSITIVE_SENTINEL');
        return mode === 'SUCCEEDED' ? { disposition: 'SUCCEEDED', artifactIds: ['artifact-1'] }
          : { disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED' };
      }) };
      const execution = new ContinuationReceiverExecutionService(storage, profiles, continuation, tasks, receiver);
      const start = vi.spyOn(continuation, constrainedContinuation);
      const guarded = vi.spyOn(storage.taskRuns, 'guardedStart');
      const terminal = vi.spyOn(tasks, 'terminalizePreservingSecurityEvidence');
      const complete = vi.spyOn(tasks, 'completeRun');
      const fail = vi.spyOn(tasks, 'failRun');
      const lookup = vi.spyOn(storage.taskRuns, 'get');
      const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
        handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan };
      const result = await execution.executeExplicitContinuation(request);
      expect(start).toHaveBeenCalledTimes(1);
      expect(guarded).toHaveBeenCalledTimes(1);
      expect(receiver.receive).toHaveBeenCalledTimes(1);
      expect(lookup).not.toHaveBeenCalled();
      const started = await guarded.mock.results[0]!.value;
      expect(receiver.receive.mock.calls[0]![0].taskRun).toBe(started);
      if (mode === 'THROW') {
        expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
        if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
        expect(result.taskRun).toBe(started);
        expect(await storage.taskRuns.get(started.id)).toEqual(started);
        expect(complete).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
        expect(terminal).not.toHaveBeenCalled();
        await expect(execution.executeExplicitContinuation(request)).rejects.toMatchObject({ reason: 'UNRESOLVED_STARTED_RUN' });
        expect(receiver.receive).toHaveBeenCalledTimes(1);
        expect(await storage.taskRuns.listByTask(task.id)).toEqual([started]);
        return;
      }
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal.mock.calls[0]![0]).toBe(started.id);
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      if (result.disposition === 'DENY') throw new Error('expected terminal outcome');
      expect(result.taskRun).toMatchObject({ id: started.id, taskId: task.id, attempt: started.attempt,
        capability: started.capability, status: mode === 'SUCCEEDED' ? TaskRunStatus.SUCCEEDED : TaskRunStatus.FAILED });
      expect(await storage.taskRuns.get(started.id)).toEqual(result.taskRun); // test-only persistence verification
      expect((await storage.tasks.get(task.id))!.status).toBe(TaskStatus.RUNNING);
      expect(JSON.stringify(result)).not.toContain('SENSITIVE_SENTINEL');
      if (mode === 'SUCCEEDED') expect(result.taskRun.artifactIds).toEqual(['artifact-1']);
      else expect(result.taskRun.error).toBe('CONTINUATION_RECEIVER_FAILED');
    } finally { await storage.close(); }
  });

  it('B1/DURABILITY: contradictory FAILED + ACCEPTED audit cannot become durable terminal metadata', async () => {
    const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
    await storage.init();
    try {
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
      // A receiver claims definite FAILED while carrying ACCEPTED terminal evidence + a final Provider.
      // This is the exact previous review class: contradictory evidence must never be terminalized.
      const receiver = { supportedCapabilities: Object.freeze([Capability.GENERAL_CHAT]),
        receive: vi.fn(async (input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> => ({
          disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED',
          routingAudit: {
            schemaVersion: 'continuation-routing-audit-v1', executionId: input.taskRun.id, matchedPolicyId: 'policy-1',
            policyVersion: 'v1', configurationVersion: 'c1', policyDigest: null, configurationDigest: null,
            terminalStatus: 'ACCEPTED', terminalCode: null, attemptCount: 1, attemptCountKnown: true,
            attempts: [{ index: 1, path: 'PRIMARY', providerId: 'provider-1', outcome: 'VALIDATION_ACCEPTED',
              failureCode: null, validationDisposition: 'ACCEPT', validationReasonCodes: [],
              responseSha256: 'a'.repeat(64), byteCount: 128, durationMs: 12, dispatchEvidence: 'RETURNED' }],
            finalAcceptedProviderId: 'provider-1', dispatchEvidence: 'RETURNED',
            transitions: [{ sequence: 1, evidence: 'RETURNED', code: null }],
          },
        }) as unknown as ContinuationReceiverOutcome) };
      const execution = new ContinuationReceiverExecutionService(storage, profiles, continuation, tasks, receiver);
      const guarded = vi.spyOn(storage.taskRuns, 'guardedStart');
      const terminal = vi.spyOn(tasks, 'terminalizePreservingSecurityEvidence');
      const complete = vi.spyOn(tasks, 'completeRun');
      const fail = vi.spyOn(tasks, 'failRun');
      const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
        handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan };
      const result = await execution.executeExplicitContinuation(request);
      const started = await guarded.mock.results[0]!.value;
      expect(receiver.receive).toHaveBeenCalledTimes(1);
      // Contradictory evidence → ATTEMPT_UNRESOLVED, no terminalization, exact run remains STARTED.
      expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
      if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(result.routingAudit).toBeUndefined();
      const persisted = await storage.taskRuns.get(started.id);
      expect(persisted).toEqual(started);
      expect(persisted!.status).toBe(TaskRunStatus.STARTED);
      // The contradictory ACCEPTED audit and its provider identity must not appear in durable state.
      expect(JSON.stringify(persisted)).not.toContain('provider-1');
      expect(JSON.stringify(persisted)).not.toContain('ACCEPTED');
      expect(await storage.taskRuns.listByTask(task.id)).toEqual([started]); // no attempt 2
      // No second attempt is created; re-entry hits the unresolved started run guard.
      await expect(execution.executeExplicitContinuation(request)).rejects.toMatchObject({ reason: 'UNRESOLVED_STARTED_RUN' });
      expect(receiver.receive).toHaveBeenCalledTimes(1);
    } finally { await storage.close(); }
  });

  it('F1/DURABILITY: SUCCEEDED with an unaudited acceptedProviderId is not durably saved', async () => {
    const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
    await storage.init();
    try {
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
      // A receiver claims SUCCEEDED and a durable Provider identity WITHOUT any routing audit. A
      // Provider ID must be audit-backed; without bounded routing evidence 6K must not terminalize.
      const receiver = { supportedCapabilities: Object.freeze([Capability.GENERAL_CHAT]),
        receive: vi.fn(async (_input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> => ({
          disposition: 'SUCCEEDED', artifactIds: ['artifact-1'], acceptedProviderId: 'provider-unaudited',
        }) as unknown as ContinuationReceiverOutcome) };
      const execution = new ContinuationReceiverExecutionService(storage, profiles, continuation, tasks, receiver);
      const guarded = vi.spyOn(storage.taskRuns, 'guardedStart');
      const terminal = vi.spyOn(tasks, 'terminalizePreservingSecurityEvidence');
      const complete = vi.spyOn(tasks, 'completeRun');
      const fail = vi.spyOn(tasks, 'failRun');
      const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
        handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan };
      const result = await execution.executeExplicitContinuation(request);
      const started = await guarded.mock.results[0]!.value;
      expect(receiver.receive).toHaveBeenCalledTimes(1);
      expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
      if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      const persisted = await storage.taskRuns.get(started.id);
      expect(persisted).toEqual(started);
      expect(persisted!.status).toBe(TaskRunStatus.STARTED);
      // The unaudited Provider identity must never appear in durable state.
      expect(JSON.stringify(persisted)).not.toContain('provider-unaudited');
      expect(await storage.taskRuns.listByTask(task.id)).toEqual([started]); // no attempt 2
      await expect(execution.executeExplicitContinuation(request)).rejects.toMatchObject({ reason: 'UNRESOLVED_STARTED_RUN' });
      expect(receiver.receive).toHaveBeenCalledTimes(1);
    } finally { await storage.close(); }
  });
});
