import { constrainedContinuation, constrainedEntry } from './continuation-execution-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { agentProfileId, Capability, ExecutionStatus, IntentType, RiskLevel, TaskRunStatus, ProviderDispatchState, TaskStatus, WorkItemStatus } from '../domain';
import type { ExecutionPlan, Task, TaskRun, WorkHandoff, WorkItem } from '../domain';
import type { ContinuationReceiverInput, ContinuationReceiverOutcome } from '../ports';
import { AgentProfileRegistry } from './agent-profile-registry';
import type { ContinuationExecutionResult } from './continuation-execution-service';
import type { ContinuationExecutionRequestContext } from './continuation-execution-product-policy';
import { ContinuationExecutionEntryError } from './continuation-execution-entry-service';
import { ContinuationReceiverExecutionService } from './continuation-receiver-execution-service';
import { WorkHandoffConsumptionError } from './work-handoff-consumption-service';

const ts = '2026-09-22T00:00:00.000Z';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const work: WorkItem = { id: 'work', actorId: 'actor', projectId: 'project', resourceRefs: [],
    status: WorkItemStatus.ACTIVE, origin: 'conversation', createdAt: ts, updatedAt: ts };
  const handoff: WorkHandoff = { id: 'handoff', workItemId: work.id, fromAgentProfileId: agentProfileId('source'),
    toAgentProfileId: agentProfileId('receiver-b'), objective: 'continue', resourceRefs: [], artifactIds: [],
    executionReceiptIds: [], createdAt: ts };
  const task: Task = { id: 'task', actorId: work.actorId, projectId: work.projectId, title: 'continue', description: 'continue',
    status: TaskStatus.PENDING, planId: 'plan', riskLevel: RiskLevel.LOW,
    intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'continue' },
    context: { platform: 'test', channelId: 'channel', userId: 'user' }, createdAt: ts, updatedAt: ts };
  const plan: ExecutionPlan = { id: 'plan', goal: 'continue', summary: 'continue', projectId: work.projectId,
    steps: [{ id: 'step', title: 'original', description: 'original', capability: Capability.GENERAL_CHAT, status: ExecutionStatus.PENDING }],
    requiredCapabilities: [Capability.GENERAL_CHAT], requiredResources: ['original'],
    estimatedChanges: { fileCount: 0, scope: 'none' }, expectedArtifacts: [],
    integrity: { kind: 'test', contractVersion: '1', digest: 'original' },
    overallRisk: RiskLevel.LOW, approvalRequired: false, status: ExecutionStatus.PENDING, createdAt: ts };
  const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
    handoffId: handoff.id, taskId: task.id, actorId: work.actorId, projectId: work.projectId, plan };
  const storage = {
    workHandoffs: { get: vi.fn(async (_id: string): Promise<WorkHandoff | null> => handoff) },
    workItems: { get: vi.fn(async (_id: string): Promise<WorkItem | null> => work) },
    tasks: { get: vi.fn(async (_id: string): Promise<Task | null> => task) },
  };
  const run: TaskRun = { id: 'exact-run-42', taskId: task.id, attempt: 42, status: TaskRunStatus.STARTED, dispatchState: ProviderDispatchState.PRE_DISPATCH,
    capability: Capability.GENERAL_CHAT, artifactIds: [], startedAt: ts };
  const profiles = new AgentProfileRegistry(['source', 'receiver', 'receiver-b'].map(id => ({ id: agentProfileId(id), displayName: id,
    role: id, purpose: id, instructions: id })));
  const continuation = { [constrainedContinuation]: vi.fn(async (_input: ContinuationExecutionRequestContext): Promise<Extract<ContinuationExecutionResult, { disposition: 'DENY' }> | ({ disposition: 'ATTEMPT_STARTED'; taskRun: TaskRun; boundTaskFacts: { capability: Capability; intentType: IntentType } })> =>
    ({ disposition: 'ATTEMPT_STARTED', taskRun: run, boundTaskFacts: { capability: run.capability, intentType: task.intent.type } })) };
  const tasks = {
    terminalizePreservingSecurityEvidence: vi.fn(async (_id: string, facts: {
      terminalStatus: TaskRunStatus.SUCCEEDED | TaskRunStatus.FAILED; artifactIds?: string[]; error?: string;
    }) => ({ ...run, ...facts, status: facts.terminalStatus })),
  };
  const receiver = { supportedCapabilities: Object.freeze([Capability.GENERAL_CHAT]), receive: vi.fn(async (_input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> =>
    ({ disposition: 'SUCCEEDED', artifactIds: ['artifact-1'] })) };
  const dispatchCommit = { commit: vi.fn(async () => ({ ...run, dispatchState: ProviderDispatchState.DISPATCH_COMMITTED })) };
  const execution = new ContinuationReceiverExecutionService(storage, profiles, continuation, tasks, receiver, dispatchCommit);
  return { work, handoff, task, plan, request, storage, run, profiles, continuation, tasks, receiver, dispatchCommit, execution };

}

describe('M3E-6K receiver seam and exact-run terminalization', () => {
  it('commits before receiver effect and blocks the effect on commit failure', async () => {
    const f = fixture();
    f.receiver.receive.mockImplementation(async () => {
      expect(f.dispatchCommit.commit).toHaveBeenCalledWith(f.run.id, f.run.id);
      return { disposition: 'SUCCEEDED', artifactIds: [] };
    });
    await f.execution.executeExplicitContinuation(f.request);
    expect(f.dispatchCommit.commit).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive).toHaveBeenCalledTimes(1);
    const failed = fixture();
    failed.dispatchCommit.commit.mockRejectedValue(new Error('write failed'));
    expect(await failed.execution.executeExplicitContinuation(failed.request)).toMatchObject({ disposition: 'ATTEMPT_UNRESOLVED' });
    expect(failed.receiver.receive).not.toHaveBeenCalled();
  });
  it.each(['SUCCEEDED', 'FAILED', 'THROW'] as const)('terminalizes the exact run once for %s', async mode => {
    const f = fixture();
    if (mode === 'FAILED') f.receiver.receive.mockResolvedValue({ disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED' });
    if (mode === 'THROW') f.receiver.receive.mockRejectedValue(new Error('SENSITIVE_SENTINEL secret path stack'));
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(f.continuation[constrainedContinuation]).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive).toHaveBeenCalledTimes(1);
    const input = f.receiver.receive.mock.calls[0]![0];
    expect(input.taskRun).toBe(f.run);
    expect(input.taskRun.capability).toBe(f.run.capability);
    expect(input.destinationAgentProfile).toBe(f.profiles.get(agentProfileId('receiver-b')));
    expect(input.handoff).toEqual(f.handoff);
    expect(Object.keys(input)).toEqual(['handoff', 'destinationAgentProfile', 'plan', 'taskRun', 'boundTaskFacts']);
    for (const value of [input, input.handoff, input.handoff.artifactIds, input.destinationAgentProfile,
      input.plan, input.plan.steps[0], input.taskRun, input.taskRun.artifactIds]) expect(Object.isFrozen(value)).toBe(true);
    if (result.disposition === 'DENY') throw new Error('expected terminal result');
    expect(result.taskRun).toMatchObject({ id: 'exact-run-42', taskId: f.run.taskId, attempt: 42, capability: f.run.capability });
    if (mode === 'SUCCEEDED') {
      expect(f.tasks.terminalizePreservingSecurityEvidence).toHaveBeenCalledTimes(1);
      expect(f.tasks.terminalizePreservingSecurityEvidence.mock.calls[0]![0]).toBe(f.run.id);
      expect(f.tasks.terminalizePreservingSecurityEvidence.mock.calls[0]![1]).toEqual({ terminalStatus: TaskRunStatus.SUCCEEDED, artifactIds: ['artifact-1'] });
      expect(result.disposition).toBe('ATTEMPT_SUCCEEDED');
      expect(result.taskRun).toBe(await f.tasks.terminalizePreservingSecurityEvidence.mock.results[0]!.value);
      expect(result.taskRun.status).toBe(TaskRunStatus.SUCCEEDED);
    } else if (mode === 'THROW') {
      expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
      expect(result.taskRun).toBe(f.run);
      expect(result.taskRun.status).toBe(TaskRunStatus.STARTED);
      expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('SENSITIVE_SENTINEL');
    } else {
      expect(f.tasks.terminalizePreservingSecurityEvidence).toHaveBeenCalledTimes(1);
      expect(f.tasks.terminalizePreservingSecurityEvidence.mock.calls[0]![0]).toBe(f.run.id);
      expect(f.tasks.terminalizePreservingSecurityEvidence.mock.calls[0]![1]).toEqual({ terminalStatus: TaskRunStatus.FAILED, error: 'CONTINUATION_RECEIVER_FAILED' });
      expect(result.disposition).toBe('ATTEMPT_FAILED');
      expect(result.taskRun).toBe(await f.tasks.terminalizePreservingSecurityEvidence.mock.results[0]!.value);
      expect(JSON.stringify(result)).not.toContain('SENSITIVE_SENTINEL');
      expect(result.taskRun.status).toBe(TaskRunStatus.FAILED);
    }
  });
  it.each([
    { disposition: 'DENY', stage: 'CONTEXT', reason: 'INVALID_REQUEST' },
    { disposition: 'DENY', stage: 'CANONICAL', reason: 'BINDING_MISMATCH' },
    { disposition: 'DENY', stage: 'PRODUCT_POLICY', reason: 'ACTOR_NOT_AUTHORIZED' },
    { disposition: 'DENY', stage: 'PREPARE', reason: 'HUMAN_WAIT_REQUIRED' },
  ] as const)('preserves 6J denial stage $stage without receiver or terminalization', async denial => {
    const f = fixture(); f.continuation[constrainedContinuation].mockResolvedValue(denial);
    expect(await f.execution.executeExplicitContinuation(f.request)).toBe(denial);
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
  });
  it.each(['taskRun', 'destinationAgentProfile', 'handoff', 'workItem', 'task', 'binding', 'receiverOutcome', 'providerId', 'approvalId'])
  ('rejects injected %s before starting', async key => {
    const f = fixture();
    expect(await f.execution.executeExplicitContinuation({ ...f.request, [key]: f.run }))
      .toMatchObject({ disposition: 'DENY', stage: 'CONTEXT' });
    expect(f.storage.workHandoffs.get).not.toHaveBeenCalled();
    expect(f.continuation[constrainedContinuation]).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
  });
  it.each(['missing handoff', 'invalid handoff', 'missing destination'])('preflights %s before start', async mode => {
    const f = fixture();
    if (mode === 'missing handoff') f.storage.workHandoffs.get.mockResolvedValue(null);
    if (mode === 'invalid handoff') f.storage.workHandoffs.get.mockResolvedValue({ ...f.handoff, objective: '' });
    if (mode === 'missing destination') f.storage.workHandoffs.get.mockResolvedValue({ ...f.handoff, toAgentProfileId: agentProfileId('unknown') });
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toBeInstanceOf(WorkHandoffConsumptionError);
    expect(f.continuation[constrainedContinuation]).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
  });
  it('unavailable receiver and NO_ACTION never start attempts', async () => {
    const f = fixture();
    const disabled = new ContinuationReceiverExecutionService(f.storage, f.profiles, f.continuation, f.tasks, undefined, f.dispatchCommit);
    expect(await disabled.executeExplicitContinuation(f.request)).toMatchObject({ disposition: 'DENY', reason: 'RECEIVER_UNAVAILABLE' });
    f.storage.workItems.get.mockResolvedValue({ ...f.work, status: WorkItemStatus.COMPLETED });
    expect(await f.execution.executeExplicitContinuation(f.request)).toMatchObject({ disposition: 'DENY', reason: 'WORK_ITEM_NOT_CONTINUABLE' });
    expect(f.continuation[constrainedContinuation]).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
  });
  it.each(['SUCCEEDED', 'FAILED'] as const)('propagates terminalization failure without fallback/retry for %s', async mode => {
    const f = fixture(); const error = new Error('storage failure');
    f.tasks.terminalizePreservingSecurityEvidence.mockRejectedValue(error);
    if (mode === 'FAILED') f.receiver.receive.mockResolvedValue({ disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED' });
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toBe(error);
    expect(f.receiver.receive).toHaveBeenCalledTimes(1);
    expect(f.tasks.terminalizePreservingSecurityEvidence).toHaveBeenCalledTimes(1);
    expect(f.run.status).toBe(TaskRunStatus.STARTED);
  });
  it('propagates typed 6J errors without receiver or failure save', async () => {
    const f = fixture(); const error = new ContinuationExecutionEntryError('UNRESOLVED_STARTED_RUN');
    f.continuation[constrainedContinuation].mockRejectedValue(error);
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toBe(error);
    expect(f.continuation[constrainedContinuation]).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
  });
  it('isolates original request mutations across preflight and uses the same semantic plan in 6J and receiver', async () => {
    const f = fixture(); let release!: (value: WorkHandoff) => void;
    f.storage.workHandoffs.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const before = JSON.parse(JSON.stringify(f.plan));
    const pending = f.execution.executeExplicitContinuation(f.request);
    f.plan.requiredCapabilities.push(Capability.CODE_IMPLEMENTATION);
    f.plan.steps[0]!.title = 'mutated'; f.plan.integrity!.digest = 'mutated'; f.plan.estimatedChanges.scope = 'broad';
    Object.assign(f.request, { taskId: 'other', actorId: 'other' });
    release(f.handoff); await pending;
    const passed = f.continuation[constrainedContinuation].mock.calls[0]![0];
    expect(passed.plan).toEqual(before);
    expect(f.receiver.receive.mock.calls[0]![0].plan).toBe(passed.plan);
    expect(passed.taskId).toBe('task');
  });
  it('fails malformed outcome closed, without persisting raw error or injected identity', async () => {
    const f = fixture();
    f.receiver.receive.mockResolvedValue({ disposition: 'UNKNOWN', error: 'SENSITIVE_SENTINEL', taskRun: { id: 'other' } } as unknown as ContinuationReceiverOutcome);
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
    if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
    expect(result.taskRun).toBe(f.run);
  });
  it('B1: contradictory FAILED + ACCEPTED audit maps to ATTEMPT_UNRESOLVED with the exact run STARTED', async () => {
    const f = fixture();
    // A receiver claiming definite FAILED while carrying ACCEPTED terminal evidence + a final Provider
    // is contradictory. 6K has no dispatch knowledge, so it must never terminalize this as FAILED.
    const contradictoryAudit = {
      schemaVersion: 'continuation-routing-audit-v1', executionId: 'exact-run-42', matchedPolicyId: 'policy-1',
      policyVersion: 'v1', configurationVersion: 'c1', policyDigest: null, configurationDigest: null,
      terminalStatus: 'ACCEPTED', terminalCode: null, attemptCount: 1, attemptCountKnown: true,
      attempts: [{ index: 1, path: 'PRIMARY', providerId: 'provider-1', outcome: 'VALIDATION_ACCEPTED',
        failureCode: null, validationDisposition: 'ACCEPT', validationReasonCodes: [],
        responseSha256: 'a'.repeat(64), byteCount: 128, durationMs: 12, dispatchEvidence: 'RETURNED' }],
      finalAcceptedProviderId: 'provider-1', dispatchEvidence: 'RETURNED',
      transitions: [{ sequence: 1, evidence: 'RETURNED', code: null }],
    };
    f.receiver.receive.mockResolvedValue({ disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED',
      routingAudit: contradictoryAudit } as unknown as ContinuationReceiverOutcome);
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
    if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
    expect(result.taskRun).toBe(f.run);
    expect(result.taskRun.status).toBe(TaskRunStatus.STARTED);
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
    // The rejected contradictory audit must not surface on the unresolved result at all.
    expect(result.routingAudit).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('provider-1');
  });
  it.each([
    ['empty', Object.freeze([] as Capability[])],
    ['duplicate', Object.freeze([Capability.GENERAL_CHAT, Capability.GENERAL_CHAT])],
    ['malformed', Object.freeze(['NOT_A_CAPABILITY'] as unknown as Capability[])],
  ])('§29 fails closed before start when the receiver support declaration is %s', async (_label, supported) => {
    const f = fixture();
    const receiver = { ...f.receiver, supportedCapabilities: supported };
    const execution = new ContinuationReceiverExecutionService(f.storage, f.profiles, f.continuation, f.tasks, receiver, f.dispatchCommit);
    expect(await execution.executeExplicitContinuation(f.request))
      .toMatchObject({ disposition: 'DENY', stage: 'RECEIVER_PREFLIGHT', reason: 'RECEIVER_UNAVAILABLE' });
    expect(f.continuation[constrainedContinuation]).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
  });
  it('F1: SUCCEEDED with an unaudited acceptedProviderId maps to ATTEMPT_UNRESOLVED, exact run STARTED', async () => {
    const f = fixture();
    // A receiver claims SUCCEEDED and a durable Provider identity but provides NO routing audit.
    // A Provider ID must be audit-backed; without bounded routing evidence the outcome is invalid,
    // so 6K must never terminalize it. The exact run stays STARTED; no complete/fail; no Provider leak.
    f.receiver.receive.mockResolvedValue({ disposition: 'SUCCEEDED', artifactIds: ['artifact-1'],
      acceptedProviderId: 'provider-1' } as unknown as ContinuationReceiverOutcome);
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
    if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
    expect(result.taskRun).toBe(f.run);
    expect(result.taskRun.status).toBe(TaskRunStatus.STARTED);
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
    expect(result.routingAudit).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('provider-1');
  });
  it('§12 boundTaskFacts capability mismatch with the started run fails closed to unresolved', async () => {
    const f = fixture();
    // The constrained 6J path returns facts whose capability disagrees with the exact started run.
    f.continuation[constrainedContinuation].mockResolvedValue({ disposition: 'ATTEMPT_STARTED', taskRun: f.run,
      boundTaskFacts: { capability: Capability.SUMMARIZATION, intentType: IntentType.CHAT } });
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
    if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
    expect(result.taskRun).toBe(f.run);
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.tasks.terminalizePreservingSecurityEvidence).not.toHaveBeenCalled();
  });
  it('keeps the port and orchestration provider agnostic with no post-start storage/run lookup', () => {
    const port = readFileSync(new URL('../ports/continuation-receiver.port.ts', import.meta.url), 'utf8');
    const service = readFileSync(new URL('./continuation-receiver-execution-service.ts', import.meta.url), 'utf8');
    for (const source of [port, service]) {
      expect(source).not.toMatch(/from ['"](?:@quoky\/|@nestjs\/|discord)/);
      expect(source).not.toMatch(/ClaudeCliProvider|CodexCliProvider|OllamaCliProvider|CapabilityRouter|AiProviderManager/);
    }
    expect(service).not.toMatch(/\.taskRuns\.|listByTask|\.guardedStart\(|\.startRun\(/);
  });
});
