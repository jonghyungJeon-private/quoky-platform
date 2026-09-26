import { describe, expect, it } from 'vitest';
import {
  AgentProfileRegistry, ApprovalManager, ApprovalPolicy, Capability, ContinuationExecutionEntryService,
  ContinuationExecutionService, CONTINUATION_CONTAINMENT_AUDIT_SCHEMA, createWorkHandoff, ExecutionStatus,
  IntentType, RiskPolicy, RiskLevel, TaskManager, TaskRunStatus, TaskStatus, WorkHandoffContinuationService, WorkItemStatus, agentProfileId,
} from '@quoky/core';
import type { ContinuationContainmentAudit, ExecutionPlan, TaskRun } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const ts = '2026-09-26T00:00:00.000Z';
const HEX = (c: string) => c.repeat(64);

/** Build a real bound STARTED TaskRun using the canonical admission + guarded-start path (in-memory). */
async function boundStartedRun(storage: SqliteStorageProvider): Promise<{ tasks: TaskManager; run: TaskRun }> {
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
  const started = await continuation.startExplicitContinuation({ trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
    handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan });
  if (started.disposition !== 'ATTEMPT_STARTED') throw new Error(`expected ATTEMPT_STARTED, got ${started.disposition}`);
  return { tasks, run: started.taskRun };
}

function containmentAudit(runId: string, overrides: Partial<ContinuationContainmentAudit> = {}): ContinuationContainmentAudit {
  return {
    schemaVersion: CONTINUATION_CONTAINMENT_AUDIT_SCHEMA,
    binding: {
      executionId: runId, taskRunId: runId, containmentPolicyId: 'policy-1', containmentPolicyVersion: 'v1',
      containmentPolicyDigest: HEX('a'), containmentBindingDigest: HEX('b'), providerId: 'ollama-local',
      modelId: 'llama3:8b', modelDigest: HEX('c'), imageDigest: HEX('d'), runtimeFamily: 'NONE', runtimeVersion: 'v0',
      securityProfileDigest: HEX('e'), modelMountIdentityDigest: HEX('f'), verifierVersion: 'verifier-1',
      channelAResultDigest: HEX('0'), channelBResultDigest: HEX('1'), preflightDisposition: 'VERIFIED',
      modelIntegrityStatus: 'VERIFIED_AT_BIND',
    },
    ...overrides,
  } as ContinuationContainmentAudit;
}

async function withStorage<T>(fn: (s: SqliteStorageProvider) => Promise<T>): Promise<T> {
  const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
  await storage.init();
  try { return await fn(storage); } finally { await storage.close(); }
}

describe('R3-A containment evidence persistence (in-memory adapter)', () => {
  it('records binding when absent, is idempotent for identical, rejects a different binding', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const a = containmentAudit(run.id);
      const recorded = await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, a);
      expect(recorded.status).toBe(TaskRunStatus.STARTED);
      expect((recorded.metadata as Record<string, unknown>).containmentAudit).toBeTruthy();
      // idempotent
      await expect(storage.taskRuns.recordContainmentBindingIfAbsent(run.id, a)).resolves.toBeTruthy();
      // different digest → reject
      const b = containmentAudit(run.id, { binding: { ...a.binding, containmentBindingDigest: HEX('9') } });
      await expect(storage.taskRuns.recordContainmentBindingIfAbsent(run.id, b))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'BINDING_DIGEST_CONFLICT' });
    });
  });

  it('appends post-attempt evidence once; idempotent identical; rejects different; rejects when binding missing', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const post = containmentAudit(run.id, { postAttempt: { attemptBoundaryCrossed: true, postAttemptModelIntegrity: 'MATCHED', failureCode: null } });
      // binding missing → reject
      await expect(storage.taskRuns.recordContainmentPostEvidenceIfAbsent(run.id, post))
        .rejects.toMatchObject({ reason: 'BINDING_MISSING' });
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      await expect(storage.taskRuns.recordContainmentPostEvidenceIfAbsent(run.id, post)).resolves.toBeTruthy();
      await expect(storage.taskRuns.recordContainmentPostEvidenceIfAbsent(run.id, post)).resolves.toBeTruthy(); // idempotent
      const other = containmentAudit(run.id, { postAttempt: { attemptBoundaryCrossed: true, postAttemptModelIntegrity: 'MISMATCH', failureCode: 'MODEL_DIGEST_MISMATCH' } });
      await expect(storage.taskRuns.recordContainmentPostEvidenceIfAbsent(run.id, other))
        .rejects.toMatchObject({ reason: 'POST_ATTEMPT_CONFLICT' });
    });
  });

  it('rejects recording on a non-STARTED / missing run', async () => {
    await withStorage(async storage => {
      await expect(storage.taskRuns.recordContainmentBindingIfAbsent('missing', containmentAudit('missing')))
        .rejects.toMatchObject({ reason: 'RUN_NOT_FOUND' });
    });
  });

  it('A-1: generic save cannot remove or mutate containment evidence on a bound run', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const withBinding = await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      // remove evidence via generic save
      const stripped: TaskRun = { ...withBinding, metadata: {} };
      await expect(storage.taskRuns.save(stripped)).rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT' });
      // mutate binding digest via generic save
      const mutatedAudit = containmentAudit(run.id, { binding: { ...containmentAudit(run.id).binding, containmentBindingDigest: HEX('9') } });
      const mutated: TaskRun = { ...withBinding, metadata: { containmentAudit: mutatedAudit } };
      await expect(storage.taskRuns.save(mutated)).rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT' });
      // identical preservation via generic save is allowed
      await expect(storage.taskRuns.save(withBinding)).resolves.toBeTruthy();
    });
  });

  it('terminal merge preserves evidence for SUCCEEDED and FAILED; UNRESOLVED stays STARTED', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      // UNRESOLVED path: no terminalization → still STARTED with durable evidence
      const stillStarted = await storage.taskRuns.get(run.id);
      expect(stillStarted!.status).toBe(TaskRunStatus.STARTED);
      expect((stillStarted!.metadata as Record<string, unknown>).containmentAudit).toBeTruthy();
      // SUCCEEDED terminal merge from CURRENT row preserves containment + adds routingAudit metadata
      const succeeded = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'SUCCEEDED', finishedAt: ts, artifactIds: ['artifact-1'], metadata: { routingAudit: { note: 'x' } },
      });
      expect(succeeded.status).toBe(TaskRunStatus.SUCCEEDED);
      expect((succeeded.metadata as Record<string, unknown>).containmentAudit).toBeTruthy();
      expect((succeeded.metadata as Record<string, unknown>).routingAudit).toEqual({ note: 'x' });
      expect(succeeded.artifactIds).toEqual(['artifact-1']);
    });
  });

  it('FAILED terminal merge preserves containment evidence', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const failed = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'FAILED', finishedAt: ts, error: 'CONTINUATION_RECEIVER_FAILED', metadata: { routingAudit: { note: 'y' } },
      });
      expect(failed.status).toBe(TaskRunStatus.FAILED);
      expect((failed.metadata as Record<string, unknown>).containmentAudit).toBeTruthy();
      expect(failed.error).toBe('CONTINUATION_RECEIVER_FAILED');
    });
  });
});

/** Start an ORDINARY (unbound) STARTED TaskRun: a RUNNING Task with no continuation binding. */
async function ordinaryStartedRun(storage: SqliteStorageProvider): Promise<{ tasks: TaskManager; run: TaskRun }> {
  const tasks = new TaskManager(storage);
  const created = await tasks.createTask(
    { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'ordinary' },
    { platform: 'test', channelId: 'channel', userId: 'user' }, { actorId: 'actor', requestText: 'ordinary' });
  const running = await storage.tasks.save({ ...created, status: TaskStatus.RUNNING });
  const run = await storage.taskRuns.start(running, Capability.GENERAL_CHAT);
  return { tasks, run };
}

describe('R3-A remediation — B-1 generic save evidence ownership (bound run)', () => {
  it('bound STARTED: current no evidence, generic save adds binding → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const forged: TaskRun = { ...run, metadata: { containmentAudit: containmentAudit(run.id) } };
      await expect(storage.taskRuns.save(forged))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'MALFORMED_EVIDENCE' });
      // Evidence remains absent.
      expect((await storage.taskRuns.get(run.id))!.metadata?.containmentAudit).toBeUndefined();
    });
  });

  it('bound STARTED: current binding, generic save same binding → ALLOW', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const withBinding = await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      await expect(storage.taskRuns.save(withBinding)).resolves.toBeTruthy();
    });
  });

  it('bound STARTED: current binding, generic save removes binding → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const stripped: TaskRun = { ...run, metadata: {} };
      await expect(storage.taskRuns.save(stripped))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'EVIDENCE_REMOVED' });
    });
  });

  it('bound STARTED: current binding A, generic save binding B → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const withBinding = await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const b = containmentAudit(run.id, { binding: { ...containmentAudit(run.id).binding, containmentBindingDigest: HEX('9') } });
      const mutated: TaskRun = { ...withBinding, metadata: { containmentAudit: b } };
      await expect(storage.taskRuns.save(mutated))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'BINDING_DIGEST_CONFLICT' });
    });
  });
});

describe('R3-A remediation — terminal-state generic save (bound run)', () => {
  it('bound SUCCEEDED: current binding, generic save adds postAttempt → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const succeeded = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'SUCCEEDED', finishedAt: ts, artifactIds: ['artifact-1'],
      });
      expect(succeeded.status).toBe(TaskRunStatus.SUCCEEDED);
      // A generic save adding post-attempt evidence to the terminal row must be rejected.
      const withPost = containmentAudit(run.id, {
        postAttempt: { attemptBoundaryCrossed: true, postAttemptModelIntegrity: 'MATCHED', failureCode: null },
      });
      const mutated: TaskRun = { ...succeeded, metadata: { ...succeeded.metadata, containmentAudit: withPost } };
      await expect(storage.taskRuns.save(mutated))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'BINDING_DIGEST_CONFLICT' });
    });
  });

  it('bound FAILED: current binding, generic save removes/changes evidence → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const failed = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'FAILED', finishedAt: ts, error: 'CONTINUATION_RECEIVER_FAILED',
      });
      const removed: TaskRun = { ...failed, metadata: {} };
      await expect(storage.taskRuns.save(removed))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'EVIDENCE_REMOVED' });
      const changed: TaskRun = { ...failed, metadata: { ...failed.metadata,
        containmentAudit: containmentAudit(run.id, { binding: { ...containmentAudit(run.id).binding, containmentBindingDigest: HEX('9') } }) } };
      await expect(storage.taskRuns.save(changed))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'BINDING_DIGEST_CONFLICT' });
    });
  });
});

describe('R3-A remediation — B-2 terminalize never accepts caller-supplied evidence', () => {
  it('bound STARTED, no persisted evidence, caller metadata carries containmentAudit → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await expect(storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'SUCCEEDED', finishedAt: ts, metadata: { containmentAudit: containmentAudit(run.id) },
      })).rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'CALLER_SUPPLIED_EVIDENCE' });
      // The run stays STARTED with no forged evidence.
      const after = await storage.taskRuns.get(run.id);
      expect(after!.status).toBe(TaskRunStatus.STARTED);
      expect(after!.metadata?.containmentAudit).toBeUndefined();
    });
  });

  it('persisted evidence exists, caller metadata includes same containmentAudit → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      await expect(storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'SUCCEEDED', finishedAt: ts, metadata: { containmentAudit: containmentAudit(run.id) },
      })).rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'CALLER_SUPPLIED_EVIDENCE' });
    });
  });
});

describe('R3-A remediation — B-3 evidence operations require a continuation-bound run', () => {
  it('ordinary/unbound STARTED: all three semantic evidence ops → REJECT', async () => {
    await withStorage(async storage => {
      const { run } = await ordinaryStartedRun(storage);
      const audit = containmentAudit(run.id);
      await expect(storage.taskRuns.recordContainmentBindingIfAbsent(run.id, audit))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'RUN_NOT_CONTINUATION_BOUND' });
      await expect(storage.taskRuns.recordContainmentPostEvidenceIfAbsent(run.id, audit))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'RUN_NOT_CONTINUATION_BOUND' });
      await expect(storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, { terminalStatus: 'SUCCEEDED', finishedAt: ts }))
        .rejects.toMatchObject({ code: 'CONTAINMENT_EVIDENCE_CONFLICT', reason: 'RUN_NOT_CONTINUATION_BOUND' });
      // No containment audit was ever written to the ordinary run.
      expect((await storage.taskRuns.get(run.id))!.metadata?.containmentAudit).toBeUndefined();
    });
  });

  it('ordinary/unbound run still supports completeRun, failRun, and generic save', async () => {
    await withStorage(async storage => {
      const { tasks, run } = await ordinaryStartedRun(storage);
      // generic save on an unbound run (no evidence) is unrestricted
      await expect(storage.taskRuns.save({ ...run, artifactIds: ['a'] })).resolves.toMatchObject({ artifactIds: ['a'] });
      const completed = await tasks.completeRun(run, { artifactIds: ['artifact-1'] });
      expect(completed.status).toBe(TaskRunStatus.SUCCEEDED);
      expect(completed.artifactIds).toEqual(['artifact-1']);
    });
  });

  it('ordinary/unbound run supports failRun', async () => {
    await withStorage(async storage => {
      const { tasks, run } = await ordinaryStartedRun(storage);
      const failed = await tasks.failRun(run, 'boom');
      expect(failed.status).toBe(TaskRunStatus.FAILED);
      expect(failed.error).toBe('boom');
    });
  });
});

describe('R3-A remediation — terminal merge preserves unrelated metadata + exact evidence', () => {
  it('preserves foo + adds caller metadata + exact preserved containmentAudit + routingAudit', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const withBinding = await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const preserved = (withBinding.metadata as Record<string, unknown>).containmentAudit;
      // Seed unrelated persisted metadata (foo=bar) alongside the containment evidence via an identical-
      // evidence generic save (allowed): this proves unrelated metadata carried into the terminal row.
      await storage.taskRuns.save({ ...withBinding, metadata: { ...withBinding.metadata, foo: 'bar' } });
      const terminal = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'SUCCEEDED', finishedAt: ts, metadata: { another: 'value', routingAudit: { schemaVersion: 'continuation-routing-audit-v1' } },
      });
      const md = terminal.metadata as Record<string, unknown>;
      expect(md.foo).toBe('bar');
      expect(md.another).toBe('value');
      expect(md.containmentAudit).toEqual(preserved);
      expect(md.routingAudit).toEqual({ schemaVersion: 'continuation-routing-audit-v1' });
    });
  });
});

describe('R3-B3 Item 3 — continuation-bound STARTED generic terminalization guard (evidence-independent)', () => {
  it('bound STARTED with NO containment evidence: generic completeRun / failRun rejected', async () => {
    await withStorage(async storage => {
      const { tasks, run } = await boundStartedRun(storage);
      // No containment evidence attached; the run is a plain bound STARTED row.
      expect((await storage.taskRuns.get(run.id))!.metadata?.containmentAudit).toBeUndefined();
      await expect(tasks.completeRun(run, { artifactIds: ['a'] }))
        .rejects.toMatchObject({ code: 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH' });
      await expect(tasks.failRun(run, 'boom'))
        .rejects.toMatchObject({ code: 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH' });
      // Still STARTED — never generically terminalized.
      expect((await storage.taskRuns.get(run.id))!.status).toBe(TaskRunStatus.STARTED);
    });
  });

  it('bound STARTED WITH containment evidence: generic completeRun / failRun rejected', async () => {
    await withStorage(async storage => {
      const { tasks, run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      // With evidence present the R3-B2 evidence guard fires first (CONTINUATION_GUARD_REQUIRED); the
      // key invariant is that generic terminalization is rejected either way.
      await expect(tasks.completeRun(run, { artifactIds: ['a'] }))
        .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
      await expect(tasks.failRun(run, 'boom'))
        .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
      expect((await storage.taskRuns.get(run.id))!.status).toBe(TaskRunStatus.STARTED);
    });
  });

  it('bound STARTED: a DIRECT public generic terminal save is rejected (no-evidence and evidence cases)', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      // No evidence yet → the R3-B3 evidence-independent guard rejects.
      const terminal: TaskRun = { ...run, status: TaskRunStatus.SUCCEEDED, finishedAt: ts, artifactIds: ['a'] };
      await expect(storage.taskRuns.save(terminal))
        .rejects.toMatchObject({ code: 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH' });
      // With evidence present → the R3-B2 evidence guard rejects. Either way, rejected.
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      await expect(storage.taskRuns.save({ ...terminal, status: TaskRunStatus.FAILED, error: 'x' }))
        .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
    });
  });

  it('ordinary/unbound STARTED: generic completeRun / failRun semantics preserved', async () => {
    await withStorage(async storage => {
      const { tasks, run } = await ordinaryStartedRun(storage);
      const completed = await tasks.completeRun(run, { artifactIds: ['artifact-1'] });
      expect(completed.status).toBe(TaskRunStatus.SUCCEEDED);
      expect(completed.artifactIds).toEqual(['artifact-1']);
    });
  });

  it('ordinary/unbound STARTED: failRun still works', async () => {
    await withStorage(async storage => {
      const { tasks, run } = await ordinaryStartedRun(storage);
      const failed = await tasks.failRun(run, 'boom');
      expect(failed.status).toBe(TaskRunStatus.FAILED);
      expect(failed.error).toBe('boom');
    });
  });

  it('secure continuation terminalization still succeeds for a bound STARTED run', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      await storage.taskRuns.recordContainmentBindingIfAbsent(run.id, containmentAudit(run.id));
      const succeeded = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'SUCCEEDED', finishedAt: ts, artifactIds: ['artifact-1'],
      });
      expect(succeeded.status).toBe(TaskRunStatus.SUCCEEDED);
      expect((succeeded.metadata as Record<string, unknown>).containmentAudit).toBeTruthy();
    });
  });

  it('secure terminalization on a bound STARTED run with NO evidence also succeeds (evidence optional)', async () => {
    await withStorage(async storage => {
      const { run } = await boundStartedRun(storage);
      const failed = await storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
        terminalStatus: 'FAILED', finishedAt: ts, error: 'CONTINUATION_RECEIVER_FAILED',
      });
      expect(failed.status).toBe(TaskRunStatus.FAILED);
      expect(failed.error).toBe('CONTINUATION_RECEIVER_FAILED');
    });
  });
});
