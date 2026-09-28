import { describe, expect, it, vi } from 'vitest';
import {
  ContinuationReceiverExecutionService, classifyProviderSpawnFailed, AgentProfileRegistry, ApprovalManager, ApprovalPolicy, Capability, ContinuationExecutionEntryService,
  ContinuationExecutionService, createWorkHandoff, ExecutionStatus,
  IntentType, RiskPolicy, RiskLevel, TaskManager, TaskRunStatus, WorkHandoffContinuationService, WorkItemStatus, agentProfileId,
} from '@quoky/core';
import type { ContinuationContainmentAudit, ExecutionPlan, TaskRun } from '@quoky/core';
import { SqliteStorageProvider } from './index';
import { createHash } from 'node:crypto';
import { assertExactSoleProviderSelection, createContainmentSecurityProfile, createContainmentInstanceIdentity,
  createContainmentCandidateBinding, prepareVerifiedContainmentBinding, PreparedContainmentExecution,
  createFakeContainedExecutionCapability } from '../../core/src/application/continuation-prepared-containment';
import type { ContainmentVerificationChannel } from '../../core/src/application/continuation-prepared-containment';
import type { ContinuationReceiverInput, ContinuationReceiverOutcome, ContainmentPostAttemptEvidence } from '@quoky/core';

const ts = '2026-09-26T00:00:00.000Z';
const HEX = (c: string) => c.repeat(64);

/** Build a real bound STARTED TaskRun using the canonical admission + guarded-start path (in-memory). */
async function fixture(storage: SqliteStorageProvider) {
  await storage.workItems.save({ id: 'work', actorId: 'actor', projectId: 'project', status: WorkItemStatus.ACTIVE,
    origin: 'conversation', resourceRefs: [], createdAt: ts, updatedAt: ts });
  await storage.workHandoffs.insert(createWorkHandoff({ id: 'handoff', workItemId: 'work',
    fromAgentProfileId: agentProfileId('source'), toAgentProfileId: agentProfileId('receiver'), objective: 'continue',
    resourceRefs: [], artifactIds: [], executionReceiptIds: [], createdAt: ts }));
  const profiles = new AgentProfileRegistry(['source', 'receiver'].map(id => ({ id: agentProfileId(id), displayName: id, role: id, purpose: id, instructions: id })));
  const tasks = new TaskManager(storage);
  const approvals = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  let task = await tasks.createTask({ type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1,
    requiresWork: true, summary: 'continue' }, { platform: 'test', channelId: 'channel', userId: 'user' },
    { actorId: 'actor', projectId: 'project', requestText: 'continue' });
  const plan: ExecutionPlan = { id: 'plan', goal: 'continue', summary: 'continue', projectId: 'project', steps: [],
    requiredCapabilities: [Capability.GENERAL_CHAT], requiredResources: [], estimatedChanges: { fileCount: 0, scope: 'none' },
    approvalRequired: false, overallRisk: RiskLevel.LOW, expectedArtifacts: [], status: ExecutionStatus.PENDING, createdAt: ts };
  task = await storage.tasks.save({ ...task, planId: plan.id });
  const preparation = new WorkHandoffContinuationService(storage, profiles, storage.continuationBindings, { tasks, approvals });
  await preparation.admit('handoff', task.id);
  const entry = new ContinuationExecutionEntryService(storage, profiles, storage.continuationBindings, tasks);
  const continuation = new ContinuationExecutionService(storage, profiles, storage.continuationBindings, preparation, entry);
  const request = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST' as const,
    handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan };
  return { tasks, profiles, continuation, request };
}

function prepared(runId: string) {
  const instance = createContainmentInstanceIdentity('fake-instance');
  const candidate = createContainmentCandidateBinding({
    selection: assertExactSoleProviderSelection({ eligibleProviderIds: ['fake-provider'], selectedProviderId: 'fake-provider', primaryOnly: true }),
    providerBindingDigest: HEX('a'), securityProfile: createContainmentSecurityProfile({ securityProfileId: 'deny-egress', securityProfileVersion: 'v1' }),
    expectedModelId: 'fake-model', expectedModelDigest: HEX('b'), imageDigest: HEX('c'), instance,
    executionContext: { executionId: runId, taskRunId: runId, containmentPolicyId: 'policy', containmentPolicyVersion: 'v1',
      containmentPolicyDigest: HEX('d'), runtimeFamily: 'NONE', runtimeVersion: 'fake-v1', modelMountIdentityDigest: HEX('e') },
  });
  const channel = (channel: 'A' | 'B'): ContainmentVerificationChannel => ({ channel, verify: subject => {
    const verifierVersion = `fake-${channel}-v1`;
    const shape = { verifierVersion, executionContext: subject.candidate.executionContext,
      providerId: subject.candidate.providerId, providerBindingDigest: subject.providerBindingDigest,
      securityProfileDigest: subject.securityProfileDigest, instanceIdentityDigest: subject.instanceIdentityDigest,
      expectedModelDigest: subject.expectedModelDigest, imageDigest: subject.candidate.imageDigest };
    return { status: 'VERIFIED', verifierVersion, trustDomain: 'TEST', verifierProvenanceId: `fake-provenance-${channel}`,
      resultDigest: createHash('sha256').update(JSON.stringify({ domain: `quoky.r3.containment.channel.${channel}.v1`, shape })).digest('hex') };
  } });
  return PreparedContainmentExecution.fromVerifiedBinding(prepareVerifiedContainmentBinding({ candidate,
    channelA: channel('A'), channelB: channel('B') }), createFakeContainedExecutionCapability(instance));
}

describe('R3-B2 fake-only prepared containment → persisted evidence → receiver terminalization', () => {
  it.each([
    { name: 'success', outcome: 'SUCCEEDED', expected: 'ATTEMPT_SUCCEEDED' },
    { name: 'failure', outcome: 'FAILED', expected: 'ATTEMPT_FAILED' },
    { name: 'integrity mismatch overrides success', outcome: 'SUCCEEDED', expected: 'ATTEMPT_UNRESOLVED', integrity: 'MISMATCH' },
    { name: 'integrity mismatch overrides failure', outcome: 'FAILED', expected: 'ATTEMPT_UNRESOLVED', integrity: 'MISMATCH' },
    { name: 'containment failure overrides success', outcome: 'SUCCEEDED', expected: 'ATTEMPT_UNRESOLVED', failure: 'CONTAINMENT_FAILURE' },
    { name: 'containment failure overrides failure', outcome: 'FAILED', expected: 'ATTEMPT_UNRESOLVED', failure: 'CONTAINMENT_FAILURE' },
    { name: 'download overrides success', outcome: 'SUCCEEDED', expected: 'ATTEMPT_UNRESOLVED', failure: 'MODEL_DOWNLOAD_DETECTED' },
    { name: 'download overrides failure', outcome: 'FAILED', expected: 'ATTEMPT_UNRESOLVED', failure: 'MODEL_DOWNLOAD_DETECTED' },
    { name: 'spawn before attempt', phase: 'PRE_ATTEMPT', positive: false, expected: 'ATTEMPT_FAILED' },
    { name: 'spawn positive pre-attempt evidence', phase: 'ATTEMPT_STARTED', positive: true, expected: 'ATTEMPT_FAILED' },
    { name: 'spawn uncertain', phase: 'ATTEMPT_STARTED', positive: false, expected: 'ATTEMPT_UNRESOLVED' },
    { name: 'spawn post attempt', phase: 'POST_ATTEMPT', positive: true, expected: 'ATTEMPT_UNRESOLVED' },
  ] as const)('$name', async scenario => {
    const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
    await storage.init();
    try {
      const f = await fixture(storage);
      let audit!: ContinuationContainmentAudit;
      let stale!: TaskRun;
      const receiver = { supportedCapabilities: [Capability.GENERAL_CHAT],
        receive: async ({ taskRun }: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> => {
          stale = taskRun;
          const execution = prepared(taskRun.id);
          audit = execution.containmentAudit(taskRun.id);
          expect(() => execution.containmentAudit('another-attempt')).toThrow('EXACT_RUN_BINDING_MISMATCH');
          await expect(f.tasks.recordContainmentBindingIfAbsent(taskRun.id, prepared('another-attempt').containmentAudit('another-attempt')))
            .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT' });
          await f.tasks.recordContainmentBindingIfAbsent(taskRun.id, audit);
          if ('phase' in scenario) {
            const disposition = classifyProviderSpawnFailed(scenario.phase, scenario.positive);
            return disposition === 'FAILED' ? { disposition, error: 'CONTINUATION_RECEIVER_FAILED' } : { disposition };
          }
          expect((await execution.execute({ prompt: 'offline' })).text).toContain('contained-fake:');
          const postAttempt: ContainmentPostAttemptEvidence = { attemptBoundaryCrossed: true,
            postAttemptModelIntegrity: 'integrity' in scenario ? scenario.integrity : 'MATCHED',
            failureCode: 'failure' in scenario ? scenario.failure : null };
          audit = { ...audit, postAttempt };
          await f.tasks.recordContainmentPostEvidenceIfAbsent(taskRun.id, audit);
          return scenario.outcome === 'SUCCEEDED' ? { disposition: 'SUCCEEDED', artifactIds: ['fake-artifact'] }
            : { disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED' };
        } };
      const terminal = vi.spyOn(f.tasks, 'terminalizePreservingSecurityEvidence');
      const complete = vi.spyOn(f.tasks, 'completeRun');
      const fail = vi.spyOn(f.tasks, 'failRun');
      const service = new ContinuationReceiverExecutionService(storage, f.profiles, f.continuation, f.tasks, receiver);
      const result = await service.executeExplicitContinuation(f.request);
      expect(result.disposition).toBe(scenario.expected);
      expect(stale.metadata?.containmentAudit).toBeUndefined(); // newer persisted evidence did not exist on caller snapshot
      expect(complete).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
      const persisted = await storage.taskRuns.get(stale.id);
      expect(persisted!.metadata?.containmentAudit).toEqual(audit);
      expect(persisted!.status).toBe(scenario.expected === 'ATTEMPT_UNRESOLVED' ? TaskRunStatus.STARTED
        : scenario.expected === 'ATTEMPT_SUCCEEDED' ? TaskRunStatus.SUCCEEDED : TaskRunStatus.FAILED);
      expect(terminal).toHaveBeenCalledTimes('phase' in scenario && scenario.expected === 'ATTEMPT_UNRESOLVED' ? 0 : 1);
      if (terminal.mock.calls.length) {
        expect(terminal.mock.calls[0]![0]).toBe(stale.id);
        if (result.disposition !== 'DENY') expect(result.taskRun).toEqual(persisted);
      }
      expect(audit.binding.providerBindingDigest).not.toBe(audit.binding.containmentBindingDigest);
      expect(audit.binding).toMatchObject({ executionId: stale.id, taskRunId: stale.id, runtimeFamily: 'NONE',
        securityProfileId: 'deny-egress', channelAVerifierVersion: 'fake-A-v1', channelBVerifierVersion: 'fake-B-v1' });
    } finally { await storage.close(); }
  });
});

async function withBoundRun(fn: (storage: SqliteStorageProvider, tasks: TaskManager, run: TaskRun) => Promise<void>) {
  const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
  await storage.init();
  try {
    const f = await fixture(storage);
    const started = await f.continuation.startExplicitContinuation(f.request);
    if (started.disposition !== 'ATTEMPT_STARTED') throw new Error('Expected exact bound run');
    await fn(storage, f.tasks, started.taskRun);
  } finally { await storage.close(); }
}

describe('R3-B2 B-1 canonical digest enforcement at persistence', () => {
  it.each(['taskRunId', 'executionId', 'both'] as const)('rejects run-A evidence replay with rewritten %s', async field => {
    await withBoundRun(async (storageA, tasksA, runA) => {
      const auditA = prepared(runA.id).containmentAudit(runA.id);
      // Issued evidence persists for A, including a JSON round trip without issuance registry identity.
      await tasksA.recordContainmentBindingIfAbsent(runA.id, JSON.parse(JSON.stringify(auditA)));
      expect((await storageA.taskRuns.get(runA.id))!.metadata?.containmentAudit).toEqual(auditA);
      await withBoundRun(async (storageB, tasksB, runB) => {
        const binding = { ...auditA.binding,
          ...(field !== 'executionId' ? { taskRunId: runB.id } : {}),
          ...(field !== 'taskRunId' ? { executionId: runB.id } : {}) };
        await expect(tasksB.recordContainmentBindingIfAbsent(runB.id, { ...auditA, binding }))
          .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'MALFORMED_EVIDENCE' });
        expect((await storageB.taskRuns.get(runB.id))!.metadata?.containmentAudit).toBeUndefined();
        const auditB = prepared(runB.id).containmentAudit(runB.id);
        expect(auditB.binding.containmentBindingDigest).not.toBe(auditA.binding.containmentBindingDigest);
        await tasksB.recordContainmentBindingIfAbsent(runB.id, auditB);
        expect((await storageB.taskRuns.get(runB.id))!.metadata?.containmentAudit).toEqual(auditB);
      });
    });
  });

  it.each([
    ['containmentPolicyId', 'other-policy'], ['containmentPolicyVersion', 'v2'],
    ['containmentPolicyDigest', HEX('f')], ['runtimeFamily', 'VM_NO_NIC'],
    ['runtimeVersion', 'fake-v2'], ['modelMountIdentityDigest', HEX('f')],
    ['providerId', 'other-provider'], ['providerBindingDigest', HEX('f')],
    ['securityProfileId', 'other-profile'], ['securityProfileDigest', HEX('f')],
    ['instanceIdentityDigest', HEX('f')], ['modelId', 'other-model'], ['modelDigest', HEX('f')],
    ['imageDigest', HEX('f')], ['channelAVerifierVersion', 'other-A'], ['channelBVerifierVersion', 'other-B'],
    ['channelAResultDigest', HEX('f')], ['channelBResultDigest', HEX('f')],
  ] as const)('rejects changed %s with the original containment digest', async (field, value) => {
    await withBoundRun(async (storage, tasks, run) => {
      const audit = prepared(run.id).containmentAudit(run.id);
      await expect(tasks.recordContainmentBindingIfAbsent(run.id, {
        ...audit, binding: { ...audit.binding, [field]: value },
      })).rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'MALFORMED_EVIDENCE' });
      expect((await storage.taskRuns.get(run.id))!.metadata?.containmentAudit).toBeUndefined();
      // Reordering JSON properties does not change identity; unchanged canonical evidence still works.
      const reordered = { ...audit, binding: Object.fromEntries(Object.entries(audit.binding).reverse()) } as ContinuationContainmentAudit;
      await tasks.recordContainmentBindingIfAbsent(run.id, JSON.parse(JSON.stringify(reordered)));
      expect((await storage.taskRuns.get(run.id))!.metadata?.containmentAudit).toEqual(audit);
    });
  });
});

describe('R3-B2 B-2 secure terminalization cannot be bypassed by generic persistence', () => {
  it.each(['BOUND', 'MISMATCH', 'CONTAINMENT_FAILURE', 'MODEL_DOWNLOAD_DETECTED'] as const)
  ('blocks all generic terminal transitions for current %s evidence', async mode => {
    await withBoundRun(async (storage, tasks, stale) => {
      let audit = prepared(stale.id).containmentAudit(stale.id);
      await tasks.recordContainmentBindingIfAbsent(stale.id, audit);
      if (mode !== 'BOUND') {
        audit = { ...audit, postAttempt: { attemptBoundaryCrossed: true,
          postAttemptModelIntegrity: mode === 'MISMATCH' ? 'MISMATCH' : 'MATCHED',
          failureCode: mode === 'MISMATCH' ? null : mode } };
        await tasks.recordContainmentPostEvidenceIfAbsent(stale.id, audit);
        for (const terminalStatus of [TaskRunStatus.SUCCEEDED, TaskRunStatus.FAILED] as const) {
          expect((await tasks.terminalizePreservingSecurityEvidence(stale.id, { terminalStatus })).status).toBe(TaskRunStatus.STARTED);
        }
      }
      const current = (await storage.taskRuns.get(stale.id))!;
      // Both a current snapshot carrying identical evidence and a stale snapshot omitting it must fail.
      for (const snapshot of [current, stale]) {
        await expect(tasks.completeRun(snapshot, { artifactIds: [] }))
          .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
        await expect(tasks.failRun(snapshot, 'CONTINUATION_RECEIVER_FAILED'))
          .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
        await expect(storage.taskRuns.save({ ...snapshot, status: TaskRunStatus.CANCELED }))
          .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
      }
      // Current-row evidence remains authoritative even if caller also substitutes task ownership.
      await expect(storage.taskRuns.save({ ...stale, taskId: 'unbound-task', status: TaskRunStatus.SUCCEEDED }))
        .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
      expect(await storage.taskRuns.get(stale.id)).toEqual(current);
      expect(current.status).toBe(TaskRunStatus.STARTED);
      expect(current.metadata?.containmentAudit).toEqual(audit);
      if (mode === 'BOUND') {
        const terminal = await tasks.terminalizePreservingSecurityEvidence(stale.id, { terminalStatus: TaskRunStatus.SUCCEEDED });
        expect(terminal.status).toBe(TaskRunStatus.SUCCEEDED);
        expect(terminal.metadata?.containmentAudit).toEqual(audit);
      }
    });
  });

  it.each(['SUCCEEDED', 'FAILED'] as const)('R3-B3: rejects generic %s on continuation runs even without containment evidence', async status => {
    await withBoundRun(async (storage, tasks, run) => {
      // R3-B3 (Item 3): a continuation-bound STARTED run cannot be generically terminalized to
      // SUCCEEDED/FAILED even when no containment evidence has been attached. Secure path only.
      await expect(status === 'SUCCEEDED' ? tasks.completeRun(run, { artifactIds: [] })
        : tasks.failRun(run, 'CONTINUATION_RECEIVER_FAILED'))
        .rejects.toMatchObject({ code: 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH' });
      expect((await storage.taskRuns.get(run.id))!.status).toBe(TaskRunStatus.STARTED);
      // The secure path still terminalizes it (evidence optional).
      const terminal = await tasks.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: status === 'SUCCEEDED' ? TaskRunStatus.SUCCEEDED : TaskRunStatus.FAILED,
      });
      expect(terminal.status).toBe(status);
      expect(await storage.taskRuns.get(run.id)).toEqual(terminal);
    });
  });
});
