import { constrainedContinuation, constrainedEntry } from '../../../packages/core/src/application/continuation-execution-internal';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProfileRegistry, agentProfileId, AI_PROVIDERS, AiProviderManager, ApprovalManager,
  ApprovalPolicy, ApprovalStatus, Capability, CapabilityRouter, CONTINUATION_BINDING_REPOSITORY,
  CONTINUATION_RECEIVER, ContinuationExecutionEntryService, ContinuationExecutionService,
  ContinuationReceiverExecutionService, createWorkHandoff, executionPlanRef, ExecutionStatus, IntentType, RiskLevel,
  RiskPolicy, STORAGE_PROVIDER, TaskManager, TaskRunStatus, TaskStatus, WorkHandoffConsumptionError,
  WorkHandoffConsumptionFailureCode, WorkHandoffContinuationService, WorkItemStatus } from '@quoky/core';
import type { ContinuationExecutionRequestContext, ContinuationReceiverInput, ContinuationReceiverOutcome,
  ExecutionPlan } from '@quoky/core';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { loadConfig } from './config';
import { createAgentProfileRegistryProvider } from './agent-profile-registry-provider';
import { continuationLifecycleProvider } from './continuation-lifecycle-provider';
import { continuationExecutionEntryProvider, continuationExecutionProvider } from './continuation-execution-provider';
import { continuationReceiverExecutionProvider } from './continuation-receiver-execution-provider';

const ts = '2026-09-23T00:00:00.000Z';
const stores: SqliteStorageProvider[] = [];
const applications: INestApplicationContext[] = [];
afterEach(async () => {
  for (const application of applications.splice(0)) await application.close();
  for (const storage of stores.splice(0)) await storage.close();
  vi.restoreAllMocks();
});

/** Explicit allowlist of DI providers: no AppModule, transport, Provider adapter or runtime bootstrap. */
async function fixture(options: { mode?: 'SUCCEEDED' | 'FAILED' | 'THROW'; projectless?: boolean;
  capability?: Capability; highRisk?: boolean; unavailable?: boolean; missingProfile?: boolean } = {}) {
  const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
  await storage.init(); stores.push(storage);
  const projectId = options.projectless ? undefined : 'project';
  const capability = options.capability ?? Capability.GENERAL_CHAT;
  await storage.workItems.save({ id: 'work', actorId: 'actor', projectId, status: WorkItemStatus.ACTIVE,
    origin: 'conversation', resourceRefs: [], createdAt: ts, updatedAt: ts });
  const handoff = createWorkHandoff({ id: 'handoff', workItemId: 'work', fromAgentProfileId: agentProfileId('source'),
    toAgentProfileId: agentProfileId('receiver'), objective: 'continue', resourceRefs: [], artifactIds: [],
    executionReceiptIds: [], createdAt: ts });
  await storage.workHandoffs.insert(handoff);
  // Only explicit non-secret test config is read, never process.env or dotenv.
  const configured = loadConfig({ QUOKY_AGENT_PROFILES: JSON.stringify(
    (options.missingProfile ? ['source'] : ['source', 'receiver']).map(id =>
      ({ id, displayName: id, role: id, purpose: id, instructions: 'Persona only; no authority' }))),
  } as NodeJS.ProcessEnv).agentProfiles;
  const tasks = new TaskManager(storage);
  const approvals = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  const created = await tasks.createTask({ type: IntentType.CHAT, capability, confidence: 1,
    requiresWork: true, summary: 'continue' }, { platform: 'test', channelId: 'channel', userId: 'user' },
  { actorId: 'actor', projectId, requestText: 'continue' });
  const plan: ExecutionPlan = { id: 'plan', goal: 'continue', summary: 'continue', projectId, steps: [],
    requiredCapabilities: [capability], requiredResources: [], estimatedChanges: { fileCount: 0, scope: 'none' },
    approvalRequired: false, overallRisk: options.highRisk ? RiskLevel.HIGH : RiskLevel.LOW,
    expectedArtifacts: [], status: ExecutionStatus.PENDING, createdAt: ts };
  const task = await storage.tasks.save({ ...created, planId: plan.id });
  const receiver = { supportedCapabilities: Object.freeze([Capability.GENERAL_CHAT]), receive: vi.fn(async (_input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> => {
    if (options.mode === 'THROW') throw new Error('RAW_RECEIVER_SENTINEL');
    return options.mode === 'FAILED' ? { disposition: 'FAILED', error: 'CONTINUATION_RECEIVER_FAILED' }
      : { disposition: 'SUCCEEDED', artifactIds: ['artifact-1'] };
  }) };
  @Module({ providers: [continuationLifecycleProvider, continuationExecutionEntryProvider,
    continuationExecutionProvider, continuationReceiverExecutionProvider, createAgentProfileRegistryProvider(configured),
    { provide: STORAGE_PROVIDER, useValue: storage },
    { provide: CONTINUATION_BINDING_REPOSITORY, useValue: storage.continuationBindings },
    { provide: TaskManager, useValue: tasks }, { provide: ApprovalManager, useValue: approvals },
    { provide: CONTINUATION_RECEIVER, useValue: options.unavailable ? null : receiver },
  ] })
  class OfflineAcceptanceComposition {}
  const application = await NestFactory.createApplicationContext(OfflineAcceptanceComposition, { logger: false });
  applications.push(application);
  const lifecycle = application.get(WorkHandoffContinuationService);
  if (!options.missingProfile) await lifecycle.admit(handoff.id, task.id);
  const continuation = application.get(ContinuationExecutionService);
  const execution = application.get(ContinuationReceiverExecutionService);
  const profiles = application.get(AgentProfileRegistry);
  const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
    handoffId: handoff.id, taskId: task.id, actorId: 'actor', projectId, plan };
  const start = vi.spyOn(continuation, constrainedContinuation);
  const prepare = vi.spyOn(lifecycle, 'prepare');
  const entry = vi.spyOn(application.get(ContinuationExecutionEntryService), constrainedEntry);
  const guarded = vi.spyOn(storage.taskRuns, 'guardedStart');
  const transition = vi.spyOn(tasks, 'transition');
  const terminal = vi.spyOn(tasks, 'terminalizePreservingSecurityEvidence');
  const complete = vi.spyOn(tasks, 'completeRun');
  const fail = vi.spyOn(tasks, 'failRun');
  const acquireApproval = vi.spyOn(approvals, 'requestFor');
  return { storage, task, plan, receiver, application, lifecycle, continuation, execution, profiles, request,
    start, prepare, entry, guarded, transition, terminal, complete, fail, acquireApproval };
}

async function expectNoExecution(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.transition).not.toHaveBeenCalled();
  expect(f.entry).not.toHaveBeenCalled();
  expect(f.guarded).not.toHaveBeenCalled();
  expect(f.receiver.receive).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.fail).not.toHaveBeenCalled();
  expect(f.terminal).not.toHaveBeenCalled();
  expect(f.acquireApproval).not.toHaveBeenCalled();
  expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
  expect((await f.storage.tasks.get(f.task.id))!.status).toBe(TaskStatus.PENDING);
}

// Matrix mapping lives in DECISIONS.md; external persistence/conversation regressions are executed separately.
describe('M3E-6L isolated offline continuation activation acceptance', () => {
  it.each(['SUCCEEDED', 'FAILED', 'THROW'] as const)('full real chain terminalizes exact frozen run: %s', async mode => {
    const f = await fixture({ mode });
    const lookup = vi.spyOn(f.storage.taskRuns, 'get');
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.entry).toHaveBeenCalledTimes(1);
    expect(f.guarded).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled(); // no post-start rediscovery
    const started = await f.guarded.mock.results[0]!.value;
    const input = f.receiver.receive.mock.calls[0]![0];
    expect(input.taskRun).toBe(started);
    expect(Object.isFrozen(started)).toBe(true);
    expect(input.handoff.toAgentProfileId).toBe(agentProfileId('receiver'));
    expect(input.destinationAgentProfile).toBe(f.profiles.get(input.handoff.toAgentProfileId));
    expect(Object.isFrozen(input.destinationAgentProfile)).toBe(true);
    expect(Object.keys(input.destinationAgentProfile).sort()).toEqual(['displayName', 'id', 'instructions', 'purpose', 'role']);
    expect(input.plan).toEqual(f.plan);
    expect(input.plan).not.toBe(f.plan);
    expect(Object.isFrozen(input.plan)).toBe(true);
    // R1 deliberately replaces delivered throw→FAILED with throw→unresolved STARTED.
    if (mode === 'THROW') {
      expect(result.disposition).toBe('ATTEMPT_UNRESOLVED');
      if (result.disposition !== 'ATTEMPT_UNRESOLVED') throw new Error('expected unresolved');
      expect(result.taskRun).toBe(started);
      expect(await f.storage.taskRuns.get(started.id)).toEqual(started);
      expect(f.complete).not.toHaveBeenCalled(); expect(f.fail).not.toHaveBeenCalled();
      expect(f.terminal).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('RAW_RECEIVER_SENTINEL');
      await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toMatchObject({ reason: 'UNRESOLVED_STARTED_RUN' });
      expect(f.receiver.receive).toHaveBeenCalledTimes(1);
      expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([started]);
      return;
    }
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    const terminal = f.terminal;
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0]).toBe(started.id);
    const order = [f.start, f.prepare, f.entry, f.guarded, f.receiver.receive, terminal]
      .map(spy => spy.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result.disposition).toBe(mode === 'SUCCEEDED' ? 'ATTEMPT_SUCCEEDED' : 'ATTEMPT_FAILED');
    if (result.disposition === 'DENY') throw new Error('expected terminal outcome');
    expect(result.taskRun).toMatchObject({ id: started.id, taskId: f.task.id, attempt: 1,
      capability: Capability.GENERAL_CHAT, status: mode === 'SUCCEEDED' ? TaskRunStatus.SUCCEEDED : TaskRunStatus.FAILED });
    const persisted = await f.storage.taskRuns.get(started.id);
    expect(persisted).toEqual(result.taskRun);
    expect(JSON.stringify(persisted)).not.toContain('RAW_RECEIVER_SENTINEL');
    if (mode === 'SUCCEEDED') expect(persisted!.artifactIds).toEqual(['artifact-1']);
    else expect(persisted!.error).toBe('CONTINUATION_RECEIVER_FAILED');
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toHaveLength(1);
    expect((await f.storage.tasks.get(f.task.id))!.status).toBe(TaskStatus.RUNNING);
    expect(f.acquireApproval).not.toHaveBeenCalled();
    await expect(f.storage.taskRuns.delete(started.id)).rejects.toMatchObject({ code: 'CONTINUATION_RUN_DELETE_FORBIDDEN' });
    expect(await f.storage.taskRuns.get(started.id)).toEqual(persisted);
  });

  it.each(['actor', 'project'] as const)('fails closed on cross-%s authorization', async scope => {
    const f = await fixture();
    const request = { ...f.request, [scope === 'actor' ? 'actorId' : 'projectId']: 'other' };
    await expect(f.execution.executeExplicitContinuation(request)).resolves.toMatchObject({ disposition: 'DENY',
      stage: 'PRODUCT_POLICY', reason: scope === 'actor' ? 'ACTOR_NOT_AUTHORIZED' : 'PROJECT_NOT_AUTHORIZED' });
    await expectNoExecution(f);
  });

  it('accepts exact projectless scope but rejects adding a project', async () => {
    const f = await fixture({ projectless: true });
    await expect(f.execution.executeExplicitContinuation({ ...f.request, projectId: 'other' }))
      .resolves.toMatchObject({ disposition: 'DENY', reason: 'PROJECT_NOT_AUTHORIZED' });
    await expectNoExecution(f);
    await expect(f.execution.executeExplicitContinuation(f.request)).resolves.toMatchObject({ disposition: 'ATTEMPT_SUCCEEDED' });
  });

  it.each([Capability.CODE_IMPLEMENTATION, Capability.TEST_EXECUTION, Capability.EMBEDDING])(
    'profile config grants no unsupported capability: %s', async capability => {
      const f = await fixture({ capability });
      await expect(f.execution.executeExplicitContinuation(f.request)).resolves.toMatchObject({ disposition: 'DENY',
        reason: 'UNSUPPORTED_RECEIVER_CAPABILITY' });
      await expectNoExecution(f);
    });

  it('denies HIGH-risk human wait without acquiring approval', async () => {
    const f = await fixture({ highRisk: true });
    await expect(f.execution.executeExplicitContinuation(f.request)).resolves.toMatchObject({ disposition: 'DENY', reason: 'HUMAN_WAIT_REQUIRED' });
    await expectNoExecution(f);
  });

  it.each(['same', 'unrelated'] as const)('APPROVED %s-plan request grants no Family-A authority', async scope => {
    const f = await fixture({ highRisk: true });
    const approval = { id: 'existing-approval', executionPlanRef: executionPlanRef(scope === 'same' ? f.plan : { ...f.plan, id: 'other-plan' }),
      status: ApprovalStatus.APPROVED, riskLevel: RiskLevel.HIGH, reason: 'Other operation approval', requestedBy: 'actor',
      decision: true, decidedBy: 'actor', decidedAt: ts, createdAt: ts, updatedAt: ts };
    await f.storage.approvals.save(approval);
    expect((await f.storage.approvals.get(approval.id))!.status).toBe(ApprovalStatus.APPROVED);
    await expect(f.execution.executeExplicitContinuation(f.request)).resolves.toMatchObject({ disposition: 'DENY', reason: 'HUMAN_WAIT_REQUIRED' });
    await expect(f.execution.executeExplicitContinuation({ ...f.request, approvalId: approval.id } as ContinuationExecutionRequestContext))
      .resolves.toEqual({ disposition: 'DENY', stage: 'CONTEXT', reason: 'INVALID_REQUEST' });
    await expectNoExecution(f);
  });

  it.each([undefined, { id: 'plan' }])('lost live plan is not reconstructed from Task.planId/ref: %j', async plan => {
    const f = await fixture();
    expect((await f.storage.tasks.get(f.task.id))!.planId).toBe('plan');
    await expect(f.execution.executeExplicitContinuation({ ...f.request, plan } as ContinuationExecutionRequestContext))
      .resolves.toEqual({ disposition: 'DENY', stage: 'CONTEXT', reason: 'INVALID_REQUEST' });
    await expectNoExecution(f);
  });

  it('receiver unavailable denies before calling 6J or starting a run', async () => {
    const f = await fixture({ unavailable: true });
    await expect(f.execution.executeExplicitContinuation(f.request)).resolves.toEqual({ disposition: 'DENY',
      stage: 'RECEIVER_PREFLIGHT', reason: 'RECEIVER_UNAVAILABLE' });
    expect(f.start).not.toHaveBeenCalled();
    await expectNoExecution(f);
  });

  it('missing destination profile fails closed without fallback', async () => {
    const f = await fixture({ missingProfile: true });
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toEqual(
      new WorkHandoffConsumptionError(WorkHandoffConsumptionFailureCode.DESTINATION_AGENT_PROFILE_NOT_FOUND));
    expect(f.start).not.toHaveBeenCalled();
    await expectNoExecution(f);
  });

  it('pins pre-start BOUNDED_DENY | TYPED_ERROR without transport normalization', async () => {
    const f = await fixture();
    const invalid = { ...f.request, handoffId: ' handoff' };
    await expect(f.continuation.startExplicitContinuation(invalid)).resolves.toEqual({ disposition: 'DENY', stage: 'CONTEXT', reason: 'INVALID_REQUEST' });
    await expect(f.execution.executeExplicitContinuation(invalid)).rejects.toEqual(
      new WorkHandoffConsumptionError(WorkHandoffConsumptionFailureCode.INVALID_HANDOFF_ID));
    await expectNoExecution(f);
  });

  it('unresolved STARTED after simulated process death blocks redispatch and replacement', async () => {
    const f = await fixture();
    const started = await f.continuation.startExplicitContinuation(f.request);
    if (started.disposition !== 'ATTEMPT_STARTED') throw new Error('expected exact start');
    expect(await f.storage.taskRuns.get(started.taskRun.id)).toEqual(started.taskRun);
    expect(started.taskRun.status).toBe(TaskRunStatus.STARTED);
    // Stop before receiver/terminalization, then simulate a separate explicit call using the same DB.
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toMatchObject({ name: 'ContinuationExecutionEntryError', reason: 'UNRESOLVED_STARTED_RUN' });
    expect(f.guarded).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([started.taskRun]);
  });

  it('configuration, DI, provenance, ACTIVE and RUNNING do not trigger execution', async () => {
    const f = await fixture();
    expect(await f.storage.continuationBindings.get('handoff')).toMatchObject({ taskId: f.task.id });
    await expectNoExecution(f);
    await expect(f.execution.executeExplicitContinuation({ ...f.request, trigger: 'WORK_HANDOFF_CREATED' } as unknown as ContinuationExecutionRequestContext))
      .resolves.toMatchObject({ disposition: 'DENY', reason: 'UNSUPPORTED_TRIGGER' });
    await expectNoExecution(f);
    // Lifecycle preparation alone can make Task RUNNING but cannot dispatch the receiver.
    await f.lifecycle.prepare({ handoffId: 'handoff', taskId: f.task.id, plan: f.plan });
    expect((await f.storage.tasks.get(f.task.id))!.status).toBe(TaskStatus.RUNNING);
    expect(f.guarded).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
  });

  it('isolated DI has only fake receiver; production module and ordinary entrypoints remain unwired', async () => {
    const f = await fixture();
    expect(f.application.get(CONTINUATION_RECEIVER)).toBe(f.receiver);
    // ProviderSelector is a type-only port; its concrete CapabilityRouter is absent too.
    for (const token of [AI_PROVIDERS, AiProviderManager, CapabilityRouter]) {
      expect(() => f.application.get(token)).toThrow();
    }
    const app = readFileSync(new URL('./app.module.ts', import.meta.url), 'utf8');
    expect(app).not.toMatch(/CONTINUATION_RECEIVER|continuationReceiverExecutionProvider|ContinuationReceiverExecutionService/);
    const runtime = readFileSync(new URL('../../../packages/core/src/application/conversation-runtime.ts', import.meta.url), 'utf8');
    expect(runtime).not.toMatch(/Continuation(?:Receiver)?Execution|executeExplicitContinuation|startExplicitContinuation/);
    await expectNoExecution(f);
  });
});
