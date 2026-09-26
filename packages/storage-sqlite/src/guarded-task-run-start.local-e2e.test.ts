import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProfileRegistry, agentProfileId, ApprovalManager, ApprovalPolicy, ApprovalStatus, Capability,
  ContinuationExecutionEntryService, createWorkHandoff, ExecutionStatus, IntentType, RiskLevel, RiskPolicy,
  TaskManager, TaskRunStatus, TaskStatus, WorkHandoffContinuationService, WorkItemStatus } from '@quoky/core';
import type { ExecutionPlan, GuardedTaskRunStartFacts, Task, TaskRun, WorkItem } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const ts = '2026-09-22T00:00:00.000Z';
const stores: SqliteStorageProvider[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(withApproval = false) {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-guarded-start-')); dirs.push(dir);
  const dbPath = join(dir, 'test.db');
  const storage = new SqliteStorageProvider({ dbPath }); await storage.init(); stores.push(storage);
  const work: WorkItem = { id: 'work', actorId: 'actor', projectId: 'project', status: WorkItemStatus.ACTIVE,
    origin: 'conversation', resourceRefs: [], createdAt: ts, updatedAt: ts };
  await storage.workItems.save(work);
  const handoff = createWorkHandoff({ id: 'handoff', workItemId: work.id, fromAgentProfileId: agentProfileId('source'),
    toAgentProfileId: agentProfileId('receiver'), objective: 'continue', resourceRefs: [], artifactIds: [], executionReceiptIds: [], createdAt: ts });
  await storage.workHandoffs.insert(handoff);
  const profiles = new AgentProfileRegistry(['source', 'receiver'].map(id => ({ id: agentProfileId(id), displayName: id, role: id, purpose: id, instructions: id })));
  const tasks = new TaskManager(storage);
  const approvals = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  let task = await tasks.createTask({ type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1,
    requiresWork: true, summary: 'continue' }, { platform: 'test', channelId: 'channel', userId: 'user' },
  { actorId: work.actorId, projectId: work.projectId, requestText: 'continue' });
  const plan: ExecutionPlan = { id: 'plan', goal: 'continue', summary: 'continue', projectId: 'project', steps: [],
    requiredCapabilities: [Capability.GENERAL_CHAT], requiredResources: [], estimatedChanges: { fileCount: 1, scope: 'local' },
    approvalRequired: true, overallRisk: RiskLevel.HIGH, expectedArtifacts: [], status: ExecutionStatus.PENDING, createdAt: ts,
    integrity: { kind: 'test', contractVersion: '1', digest: 'exact-digest' } };
  if (withApproval) task = await storage.tasks.save({ ...task, planId: plan.id, riskLevel: RiskLevel.HIGH });
  const lifecycle = new WorkHandoffContinuationService(storage, profiles, storage.continuationBindings, { tasks, approvals });
  await lifecycle.admit(handoff.id, task.id);
  const input = { handoffId: handoff.id, taskId: task.id, ...(withApproval ? { plan } : {}) };
  const preparation = await lifecycle.prepare(input);
  let approvalId: string | undefined;
  if (withApproval) {
    if (preparation.disposition !== 'WAITING_FOR_APPROVAL' || !preparation.approvalId) throw new Error('expected wait');
    approvalId = preparation.approvalId;
    await approvals.decide(approvalId, { approvalId, approved: true, decidedBy: 'human', decidedAt: ts });
    await lifecycle.prepare({ ...input, approvalId });
  }
  task = (await storage.tasks.get(task.id))!;
  const binding = (await storage.continuationBindings.get(handoff.id))!;
  const expected: GuardedTaskRunStartFacts = { handoff, binding, workItem: work, task,
    approval: approvalId ? { kind: 'APPROVED', request: (await approvals.get(approvalId))!,
      planRef: { id: plan.id, goal: plan.goal, integrity: plan.integrity } } : { kind: 'NOT_REQUIRED' } };
  const entry = new ContinuationExecutionEntryService(storage, profiles, storage.continuationBindings, tasks);
  return { storage, dbPath, work, handoff, task, binding, expected, plan, approvalId,
    input: { ...input, ...(approvalId ? { approvalId } : {}) }, tasks, approvals, profiles, entry };
}
function raw(f: { dbPath: string }, action: (db: Database.Database) => void) {
  const db = new Database(f.dbPath);
  try { action(db); } finally { db.close(); }
}
function seedHistory(f: { dbPath: string }, run: TaskRun) {
  // Explicit raw fixture path: not an application/port authority claim.
  raw(f, db => db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)').run(run.id, run.taskId, JSON.stringify(run)));
}
function historical(task: Task, id: string, attempt: number, startedAt: string, status = TaskRunStatus.SUCCEEDED): TaskRun {
  return { id, taskId: task.id, attempt, status, capability: task.intent.capability, artifactIds: [], startedAt };
}

describe('ADR-0088 guarded atomic start — real SQLite', () => {
  it.each([false, true])('returns the exact inserted STARTED run; approval required=%s; no execution dependencies', async approved => {
    const f = await fixture(approved);
    const guarded = vi.spyOn(f.storage.taskRuns, 'guardedStart');
    const ordinary = vi.spyOn(f.storage.taskRuns, 'start');
    const save = vi.spyOn(f.storage.taskRuns, 'save');
    const transition = vi.spyOn(f.tasks, 'transition');
    const request = vi.spyOn(f.approvals, 'requestFor');
    const decide = vi.spyOn(f.approvals, 'decide');
    const run = await f.entry.start(f.input);
    expect(run).toBe(await guarded.mock.results[0]!.value);
    expect(run).toMatchObject({ taskId: f.task.id, attempt: 1, status: TaskRunStatus.STARTED });
    expect(await f.storage.taskRuns.get(run.id)).toEqual(run);
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([run]);
    expect(ordinary).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
    // Constructor has no Provider, receiver, Tool, Command or network seam. Success stops here.
    expect(Object.keys(f.entry)).toEqual(['storage', 'profiles', 'bindings', 'tasks']);
  });

  it.each(['handoff', 'binding', 'work-state', 'task-state', 'actor', 'project', 'approval-id', 'approval-status', 'plan-ref', 'integrity-ref'])
  ('atomically rejects stale %s with no insertion', async kind => {
    const f = await fixture(true);
    if (kind === 'handoff') raw(f, db => db.prepare('DELETE FROM work_handoffs WHERE id = ?').run(f.handoff.id));
    const expected = kind === 'binding' ? { ...f.expected, binding: { ...f.binding, taskId: 'other' } } : f.expected;
    if (kind === 'work-state') await f.storage.workItems.save({ ...f.work, status: WorkItemStatus.COMPLETED });
    if (kind === 'task-state') await f.tasks.transition(f.task, TaskStatus.COMPLETED);
    if (kind === 'actor') await f.storage.tasks.save({ ...f.task, actorId: 'other' });
    if (kind === 'project') await f.storage.workItems.save({ ...f.work, projectId: 'other' });
    if (f.expected.approval.kind !== 'APPROVED') throw new Error('expected approval');
    const approved = f.expected.approval.request;
    if (kind === 'approval-id') raw(f, db => db.prepare('DELETE FROM approvals WHERE id = ?').run(approved.id));
    if (kind === 'approval-status') await f.storage.approvals.save({ ...approved, status: ApprovalStatus.REJECTED });
    if (kind === 'plan-ref') await f.storage.approvals.save({ ...approved, executionPlanRef: { ...approved.executionPlanRef, goal: 'other' } });
    if (kind === 'integrity-ref') await f.storage.approvals.save({ ...approved,
      executionPlanRef: { ...approved.executionPlanRef, integrity: { ...approved.executionPlanRef.integrity!, digest: 'changed' } } });
    const code = kind === 'handoff' ? 'STALE_HANDOFF' : kind === 'binding' ? 'BINDING_MISMATCH'
      : ['work-state', 'project'].includes(kind) ? 'WORK_ITEM_NOT_CONTINUABLE'
      : ['task-state', 'actor'].includes(kind) ? 'TASK_NOT_EXECUTABLE' : 'APPROVAL_STALE';
    await expect(f.storage.taskRuns.guardedStart(expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({ code });
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
  });

  it('rejects a binding removed after evaluation', async () => {
    const f = await fixture();
    raw(f, db => db.prepare('DELETE FROM continuation_bindings WHERE handoff_id = ?').run(f.handoff.id));
    await expect(f.storage.taskRuns.guardedStart(f.expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it.each(['actor', 'project', 'status', 'capability'])('rejects mechanically inconsistent %s even with matching snapshots', async kind => {
    const f = await fixture();
    let task = { ...f.task };
    if (kind === 'actor') task.actorId = 'other';
    if (kind === 'project') task.projectId = 'other';
    if (kind === 'status') task.status = TaskStatus.PLANNING;
    await f.storage.tasks.save(task);
    await expect(f.storage.taskRuns.guardedStart({ ...f.expected, task },
      kind === 'capability' ? Capability.CODE_IMPLEMENTATION : Capability.GENERAL_CHAT)).rejects.toMatchObject({ code: 'TASK_NOT_EXECUTABLE' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it('checks exact expected ref against an APPROVED persisted request, not merely snapshot equality', async () => {
    const f = await fixture(true);
    if (f.expected.approval.kind !== 'APPROVED') throw new Error('expected approval');
    const expected = { ...f.expected, approval: { ...f.expected.approval,
      planRef: { ...f.expected.approval.planRef, integrity: { kind: 'test', contractVersion: '1', digest: 'other' } } } };
    await expect(f.storage.taskRuns.guardedStart(expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it('rejects an effect-time change after successful admission instead of accepting newer unevaluated facts', async () => {
    const f = await fixture(true);
    const original = f.storage.taskRuns.listByTask.bind(f.storage.taskRuns);
    vi.spyOn(f.storage.taskRuns, 'listByTask').mockImplementationOnce(async id => {
      // Admission already read/validated this Task. Update it before execution-entry reaches the guard.
      await f.storage.tasks.save({ ...f.task, riskLevel: RiskLevel.CRITICAL, description: 'changed after evaluation' });
      return original(id);
    });
    await expect(f.entry.start(f.input)).rejects.toMatchObject({ code: 'TASK_NOT_EXECUTABLE' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it('revalidates exact approval again after successful admission', async () => {
    const f = await fixture(true);
    const original = f.storage.taskRuns.guardedStart.bind(f.storage.taskRuns);
    vi.spyOn(f.storage.taskRuns, 'guardedStart').mockImplementationOnce(async (facts, capability) => {
      if (facts.approval.kind !== 'APPROVED') throw new Error('expected approval');
      await f.storage.approvals.save({ ...facts.approval.request, status: ApprovalStatus.REJECTED });
      return original(facts, capability);
    });
    await expect(f.entry.start(f.input)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it.each(['no-plan', 'wrong-approval', 'not-running', 'empty-registry'])('denies %s at fresh Application admission', async kind => {
    const f = await fixture(true);
    const guarded = vi.spyOn(f.storage.taskRuns, 'guardedStart');
    const input = { ...f.input };
    if (kind === 'no-plan') delete input.plan;
    if (kind === 'wrong-approval') input.approvalId = 'absent';
    if (kind === 'not-running') await f.storage.tasks.save({ ...f.task, status: TaskStatus.WAITING_APPROVAL });
    const entry = kind === 'empty-registry'
      ? new ContinuationExecutionEntryService(f.storage, new AgentProfileRegistry(), f.storage.continuationBindings, f.tasks) : f.entry;
    await expect(entry.start(input)).rejects.toHaveProperty('reason');
    expect(guarded).not.toHaveBeenCalled(); expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it('uses status alone for unresolved history, ignoring age and finishedAt', async () => {
    const f = await fixture();
    const unresolved = { ...historical(f.task, 'ambiguous', 4, '2000-01-01T00:00:00.000Z', TaskRunStatus.STARTED), finishedAt: ts };
    seedHistory(f, unresolved);
    await expect(f.storage.taskRuns.guardedStart(f.expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({ code: 'UNRESOLVED_STARTED_RUN' });
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([unresolved]);
  });
  it('allocates from history but returns the inserted identity without latest-run rediscovery', async () => {
    const f = await fixture();
    seedHistory(f, historical(f.task, 'newest-time', 2, '2099-01-01T00:00:00.000Z'));
    seedHistory(f, historical(f.task, 'highest-history', 19, '2000-01-01T00:00:00.000Z', TaskRunStatus.FAILED));
    const get = vi.spyOn(f.storage.taskRuns, 'get');
    const list = vi.spyOn(f.storage.taskRuns, 'listByTask');
    const run = await f.entry.start(f.input);
    expect(run.attempt).toBe(20); expect(run.id).not.toBe('highest-history'); expect(run.id).not.toBe('newest-time');
    expect(get).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledTimes(1); // only pre-start admission
    expect(await f.storage.taskRuns.get(run.id)).toEqual(run);
  });
  it('ordinary start cannot bypass a persisted binding, with no flag involved', async () => {
    const f = await fixture();
    await expect(f.tasks.startRun(f.task, Capability.GENERAL_CHAT)).rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it.each([TaskRunStatus.STARTED, TaskRunStatus.SUCCEEDED])('save rejects novel bound %s rows', async status => {
    const f = await fixture();
    await expect(f.storage.taskRuns.save(historical(f.task, 'bypass', 1, ts, status)))
      .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
    expect(await f.storage.taskRuns.list()).toEqual([]);
  });
  it.each(['complete', 'fail'] as const)('R3-B3: bound run rejects generic TaskManager.%sRun; secure path terminalizes', async mode => {
    const f = await fixture(); const run = await f.entry.start(f.input);
    // R3-B3 (Item 3): a continuation-bound STARTED run may NOT terminalize through generic
    // completeRun/failRun (with or without containment evidence). Only the secure path may.
    await expect(mode === 'complete' ? f.tasks.completeRun(run, { artifactIds: [] }) : f.tasks.failRun(run, 'test failure'))
      .rejects.toMatchObject({ code: 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH' });
    expect((await f.storage.taskRuns.get(run.id))!.status).toBe(TaskRunStatus.STARTED);
    // A direct generic terminal save is likewise rejected.
    await expect(f.storage.taskRuns.save({ ...run, status: TaskRunStatus.SUCCEEDED, finishedAt: run.startedAt }))
      .rejects.toMatchObject({ code: 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH' });
    // The secure continuation terminalization path succeeds and is the sole terminal path.
    const terminal = await f.tasks.terminalizePreservingSecurityEvidence(run.id, mode === 'complete'
      ? { terminalStatus: TaskRunStatus.SUCCEEDED, artifactIds: [] }
      : { terminalStatus: TaskRunStatus.FAILED, error: 'test failure' });
    expect(await f.storage.taskRuns.get(run.id)).toEqual(terminal);
    // A STARTED-revival generic save on the now-terminal row is still rejected.
    await expect(f.storage.taskRuns.save(run)).rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
    expect(await f.storage.taskRuns.get(run.id)).toEqual(terminal);
  });
  it('failed caller leaves the exact STARTED run ambiguous; no automatic replacement or recovery', async () => {
    const f = await fixture();
    const run = await f.entry.start(f.input);
    await expect(f.entry.start(f.input)).rejects.toMatchObject({ reason: 'UNRESOLVED_STARTED_RUN' });
    expect(await f.storage.taskRuns.list()).toEqual([run]);
  });

  it('6 simultaneous child processes produce exactly one STARTED winner using v11 without a new index', async () => {
    const f = await fixture(true);
    const worker = fileURLToPath(new URL('./test-support/guarded-start-worker.cjs', import.meta.url));
    const children = Array.from({ length: 6 }, () => fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    try {
      const finished = children.map(child => new Promise<{ run?: TaskRun; code?: string }>((resolve, reject) => {
        child.on('message', (message: { type: string; error?: string; run?: TaskRun; code?: string }) => {
          if (message.type === 'result') resolve(message);
          if (message.type === 'fatal') reject(new Error(message.error));
        });
        child.on('error', reject);
        child.on('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
      }));
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.on('message', (message: { type: string; error?: string }) => {
          if (message.type === 'ready') resolve();
          if (message.type === 'fatal') reject(new Error(message.error));
        });
        child.on('error', reject);
        child.on('exit', code => { if (code !== 0) reject(new Error(`worker init exit ${code}`)); });
        child.send({ type: 'init', dbPath: f.dbPath });
      })));
      // Barrier: no child starts until ALL independent connections are ready.
      for (const child of children) child.send({ type: 'start', expected: f.expected, capability: Capability.GENERAL_CHAT });
      const results = await Promise.all(finished);
      const winners = results.filter(result => result.run);
      expect(winners).toHaveLength(1);
      expect(results.filter(result => result.code === 'UNRESOLVED_STARTED_RUN')).toHaveLength(5);
      expect(await f.storage.taskRuns.list()).toEqual([winners[0]!.run]);
      raw(f, db => {
        expect(db.pragma('user_version', { simple: true })).toBe(11);
        expect((db.pragma('index_list(task_runs)') as { partial: number }[]).every(index => index.partial === 0)).toBe(true);
      });
    } finally {
      await Promise.all(children.map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve()); child.kill();
      })));
    }
  }, 30000);
});
