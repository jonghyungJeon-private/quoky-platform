import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import { SqliteContinuationBindingRepository } from './continuation-binding-repository';
import type { ContinuationBindingRepository } from '@quoky/core';
import type {
  Actor,
  ActorRepository,
  ApprovalRepository,
  ApprovalRequest,
  Artifact,
  ArtifactRepository,
  AgentProfileId,
  CodeGeneration,
  CodeGenerationRepository,
  CodeProposal,
  CodeProposalRepository,
  CommandExecution,
  CommandExecutionRepository,
  DurableMemoryQuery,
  ExecutionKind,
  ExecutionReceipt,
  ExecutionReceiptFailureClass,
  ExecutionReceiptOutcome,
  ExecutionReceiptRepository,
  Id,
  MemoryRecord,
  MemoryRepository,
  MemoryScope,
  MemoryType,
  PatchRepository,
  PatchSet,
  Project,
  ResourceRef,
  Repository,
  WorkspaceChange,
  WorkspaceChangeRepository,
  Session,
  SessionRepository,
  StorageProvider,
  Task,
  TaskRepository,
  TaskRun,
  TaskRunRepository,
  TerminalizePreservingSecurityEvidenceRequest,
  ContinuationContainmentAudit,
  GuardedTaskRunStartFacts,
  WorkItem,
  WorkItemRepository,
  WorkHandoff,
  WorkHandoffRepository,
} from '@quoky/core';
import { ApprovalStatus, GuardedTaskRunStartError, WorkItemStatus, Capability, TaskStatus, TaskRunStatus, newId, now, ResourceRef as DomainResourceRef, createWorkHandoff } from '@quoky/core';
import {
  ContainmentEvidenceConflictError,
  CONTAINMENT_AUDIT_METADATA_KEY,
  snapshotContainmentAudit,
  containmentEvidenceIdentical,
  bindingIdentical,
  postAttemptIdentical,
} from '@quoky/core';

/** ADR-0089: the SQLite lock wait is explicit adapter configuration, not an implicit driver default.
 * This preserves the previously effective better-sqlite3 default. It is a bounded wait inside a single
 * database call and is NOT Application retry. */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface SqliteConfig {
  /** Path to the SQLite database file, e.g. ./data/chunsik.db */
  dbPath: string;
  /** Explicit bounded lock wait in milliseconds; defaults to DEFAULT_SQLITE_BUSY_TIMEOUT_MS.
   * Storage-owned: no Core policy, no Application retry, no rescheduling. */
  busyTimeoutMs?: number;
}

/** Adapter-owned driver translation. Core never inspects driver codes, classes or messages. */
function isLockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/**
 * R3-A: project any durable containment audit stored under a TaskRun's metadata, anchored to the run's
 * own id (executionId === taskRunId === run.id for a continuation attempt). Returns null when absent or
 * malformed, so a malformed persisted blob is treated as "no evidence" for preservation comparison
 * rather than being trusted.
 */
function extractContainmentAudit(run: TaskRun): ContinuationContainmentAudit | null {
  const raw = run.metadata?.[CONTAINMENT_AUDIT_METADATA_KEY];
  if (raw === undefined) return null;
  return snapshotContainmentAudit(raw, run.id, run.id);
}

type Db = Database.Database;
type Row = { data: string };

interface ExecutionReceiptRow {
  id: string;
  execution_kind: string;
  source_id: string;
  execution_plan_id: string;
  authorization_kind: string;
  approval_id: string | null;
  outcome: string;
  failure_class: string | null;
  recorded_at: string;
}

interface WorkHandoffRow {
  data: string;
}

function mapExecutionReceipt(row: ExecutionReceiptRow): ExecutionReceipt {
  return {
    id: row.id,
    executionKind: row.execution_kind as ExecutionKind,
    sourceId: row.source_id,
    executionPlanId: row.execution_plan_id,
    authorization:
      row.authorization_kind === 'APPROVAL'
        ? { kind: 'APPROVAL', approvalId: row.approval_id! }
        : { kind: 'NOT_REQUIRED' },
    outcome: row.outcome as ExecutionReceiptOutcome,
    ...(row.failure_class
      ? { failureClass: row.failure_class as ExecutionReceiptFailureClass }
      : {}),
    recordedAt: row.recorded_at,
  };
}

/** A SQLite-backed JSON document store for one entity type (id + data). */
class JsonRepository<T extends { id: Id }> implements Repository<T> {
  constructor(
    protected readonly db: Db,
    protected readonly table: string,
  ) {}

  async get(id: Id): Promise<T | null> {
    const row = this.db.prepare(`SELECT data FROM ${this.table} WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  async save(entity: T): Promise<T> {
    this.db
      .prepare(
        `INSERT INTO ${this.table} (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(entity.id, JSON.stringify(entity));
    return entity;
  }

  async delete(id: Id): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
  }

  async list(): Promise<T[]> {
    const rows = this.db.prepare(`SELECT data FROM ${this.table}`).all() as Row[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }
}

class SqliteActorRepository extends JsonRepository<Actor> implements ActorRepository {
  override async save(actor: Actor): Promise<Actor> {
    const tx = this.db.transaction((a: Actor) => {
      this.db
        .prepare(
          `INSERT INTO actors (id, data) VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        )
        .run(a.id, JSON.stringify(a));
      this.db.prepare(`DELETE FROM actor_identities WHERE actor_id = ?`).run(a.id);
      const ins = this.db.prepare(
        `INSERT INTO actor_identities (platform, external_id, actor_id) VALUES (?, ?, ?)
         ON CONFLICT(platform, external_id) DO UPDATE SET actor_id = excluded.actor_id`,
      );
      for (const idn of a.identities) ins.run(idn.platform, idn.externalId, a.id);
    });
    tx(actor);
    return actor;
  }

  override async delete(id: Id): Promise<void> {
    this.db.prepare(`DELETE FROM actor_identities WHERE actor_id = ?`).run(id);
    await super.delete(id);
  }

  async findByExternalIdentity(platform: string, externalId: string): Promise<Actor | null> {
    const row = this.db
      .prepare(`SELECT actor_id FROM actor_identities WHERE platform = ? AND external_id = ?`)
      .get(platform, externalId) as { actor_id: string } | undefined;
    return row ? this.get(row.actor_id) : null;
  }
}

class SqliteSessionRepository extends JsonRepository<Session> implements SessionRepository {
  override async save(session: Session): Promise<Session> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, channel_id, thread_id, status, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id,
           thread_id = excluded.thread_id, status = excluded.status, data = excluded.data`,
      )
      .run(
        session.id,
        session.context.channelId,
        session.context.threadId ?? null,
        session.status,
        JSON.stringify(session),
      );
    return session;
  }

  async findActiveByContext(channelId: string, threadId?: string): Promise<Session | null> {
    const order = `ORDER BY json_extract(data, '$.lastActivityAt') DESC LIMIT 1`;
    const row = (
      threadId === undefined
        ? this.db
            .prepare(
              `SELECT data FROM sessions WHERE channel_id = ? AND thread_id IS NULL AND status = 'ACTIVE' ${order}`,
            )
            .get(channelId)
        : this.db
            .prepare(
              `SELECT data FROM sessions WHERE channel_id = ? AND thread_id = ? AND status = 'ACTIVE' ${order}`,
            )
            .get(channelId, threadId)
    ) as Row | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }
}

class SqliteTaskRepository extends JsonRepository<Task> implements TaskRepository {
  override async save(task: Task): Promise<Task> {
    this.db
      .prepare(
        `INSERT INTO tasks (id, channel_id, thread_id, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id,
           thread_id = excluded.thread_id, data = excluded.data`,
      )
      .run(task.id, task.context.channelId, task.context.threadId ?? null, JSON.stringify(task));
    return task;
  }

  async listByContext(channelId: string, threadId?: string): Promise<Task[]> {
    const rows = (
      threadId === undefined
        ? this.db.prepare(`SELECT data FROM tasks WHERE channel_id = ? AND thread_id IS NULL`).all(channelId)
        : this.db.prepare(`SELECT data FROM tasks WHERE channel_id = ? AND thread_id = ?`).all(channelId, threadId)
    ) as Row[];
    return rows.map((r) => JSON.parse(r.data) as Task);
  }
}

class SqliteTaskRunRepository extends JsonRepository<TaskRun> implements TaskRunRepository {
  private isBound(taskId: Id): boolean {
    return !!this.db.prepare('SELECT 1 FROM continuation_bindings WHERE task_id = ?').get(taskId);
  }

  /** Translate only recognized lock contention, before any successful commit, into the bounded typed
   * outcome. Unknown infrastructure failures keep existing repository conventions and are never swallowed.
   * The driver's bounded wait already elapsed inside the one call; nothing is retried here. */
  private noContention<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (isLockContention(error)) throw new GuardedTaskRunStartError('TASK_RUN_STORAGE_BUSY');
      throw error;
    }
  }

  async start(task: Task, capability: Capability): Promise<TaskRun> {
    return this.noContention(() => this.db.transaction(() => {
      if (this.isBound(task.id)) throw new GuardedTaskRunStartError('CONTINUATION_GUARD_REQUIRED');
      const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(task.id) as Row | undefined;
      if (!row || task.status !== TaskStatus.RUNNING || !Object.values(Capability).includes(capability)
        || !isDeepStrictEqual(JSON.parse(row.data), JSON.parse(JSON.stringify(task)))) {
        throw new Error('TASK_RUN_START_INVALID_OR_STALE_TASK');
      }
      return this.insertStarted(task.id, capability);
    }).immediate());
  }

  async guardedStart(expected: GuardedTaskRunStartFacts, capability: Capability): Promise<TaskRun> {
    return this.noContention(() => this.db.transaction(() => {
      const { handoff, binding, workItem, task, approval } = expected;
      // Fixed tables, bounded domain snapshots. No Approval/RiskPolicy or plan reconstruction in SQLite.
      for (const [table, value, code] of [
        ['work_handoffs', handoff, 'STALE_HANDOFF'],
        ['work_items', workItem, 'WORK_ITEM_NOT_CONTINUABLE'],
        ['tasks', task, 'TASK_NOT_EXECUTABLE'],
      ] as const) {
        const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(value.id) as Row | undefined;
        if (!row || !isDeepStrictEqual(JSON.parse(row.data), JSON.parse(JSON.stringify(value)))) {
          throw new GuardedTaskRunStartError(code);
        }
      }
      const bound = this.db.prepare('SELECT * FROM continuation_bindings WHERE handoff_id = ?')
        .get(handoff.id) as { handoff_id: string; task_id: string; recorded_at: string } | undefined;
      if (!bound || binding.handoffId !== handoff.id || binding.taskId !== task.id
        || bound.handoff_id !== binding.handoffId || bound.task_id !== binding.taskId
        || bound.recorded_at !== binding.recordedAt) throw new GuardedTaskRunStartError('BINDING_MISMATCH');
      if (handoff.workItemId !== workItem.id || workItem.status !== WorkItemStatus.ACTIVE) {
        throw new GuardedTaskRunStartError('WORK_ITEM_NOT_CONTINUABLE');
      }
      if (task.status !== TaskStatus.RUNNING || !workItem.actorId || task.actorId !== workItem.actorId
        || task.projectId !== workItem.projectId || !Object.values(Capability).includes(capability)
        || capability !== task.intent.capability) throw new GuardedTaskRunStartError('TASK_NOT_EXECUTABLE');
      if (!approval || !['NOT_REQUIRED', 'APPROVED'].includes(approval.kind)
        || task.planId !== approval.planRef?.id) throw new GuardedTaskRunStartError('APPROVAL_STALE');
      if (approval.kind === 'APPROVED') {
        const row = this.db.prepare('SELECT data FROM approvals WHERE id = ?').get(approval.request.id) as Row | undefined;
        const persisted = row ? JSON.parse(row.data) as ApprovalRequest : null;
        if (!persisted || persisted.id !== approval.request.id || persisted.status !== ApprovalStatus.APPROVED
          || !isDeepStrictEqual(persisted, JSON.parse(JSON.stringify(approval.request)))
          || !isDeepStrictEqual(persisted.executionPlanRef, JSON.parse(JSON.stringify(approval.planRef)))) {
          throw new GuardedTaskRunStartError('APPROVAL_STALE');
        }
      }
      // Status is the sole unresolved predicate. MAX(attempt) below is ordinal allocation only.
      if (this.db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? AND json_extract(data, '$.status') = ? LIMIT 1")
        .get(task.id, TaskRunStatus.STARTED)) throw new GuardedTaskRunStartError('UNRESOLVED_STARTED_RUN');
      return this.insertStarted(task.id, capability);
    }).immediate()); // The single commit is the linearization point; return only after it succeeds.
  }

  private insertStarted(taskId: Id, capability: Capability): TaskRun {
    const previous = this.db.prepare(
      "SELECT MAX(json_extract(data, '$.attempt')) AS attempt FROM task_runs WHERE task_id = ?",
    ).get(taskId) as { attempt: number | null };
    const attempt = (previous.attempt ?? 0) + 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('TASK_RUN_ATTEMPT_EXHAUSTED');
    const run: TaskRun = { id: newId(), taskId, attempt, status: TaskRunStatus.STARTED,
      capability, artifactIds: [], startedAt: now() };
    this.db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)')
      .run(run.id, run.taskId, JSON.stringify(run));
    return run;
  }

  override async save(run: TaskRun): Promise<TaskRun> {
    return this.noContention(() => this.db.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM task_runs WHERE id = ?').get(run.id) as Row | undefined;
      const persisted = existing ? JSON.parse(existing.data) as TaskRun : null;
      // R3-B2: a containment-evidence-bearing STARTED row may terminalize ONLY through the secure API.
      // Inspect the CURRENT row, not the caller's evidence/taskId; even a stale snapshot must not bypass
      // this. Presence is conservative: any non-STARTED generic transition is rejected when evidence is
      // attached (malformed evidence never grants generic terminal authority).
      if (persisted?.status === TaskRunStatus.STARTED && run.status !== TaskRunStatus.STARTED
        && Object.prototype.hasOwnProperty.call(persisted.metadata ?? {}, CONTAINMENT_AUDIT_METADATA_KEY)) {
        throw new GuardedTaskRunStartError('CONTINUATION_GUARD_REQUIRED');
      }
      // R3-B3 (Item 3): a CONTINUATION-BOUND STARTED row may terminalize to SUCCEEDED/FAILED ONLY through
      // the secure continuation terminalization path — regardless of whether containment evidence is
      // present yet. This closes the R3-B2 carry-forward gap where a bound STARTED run with no attached
      // evidence could still be generically terminalized. The decision is derived from the CURRENT
      // persisted row + the canonical continuation binding, never the caller snapshot. CANCELED is a
      // distinct cancellation lifecycle (not a success/failure terminalization) and keeps its existing
      // revival-guarded semantics; ordinary non-continuation runs are unaffected.
      if (persisted?.status === TaskRunStatus.STARTED
        && (run.status === TaskRunStatus.SUCCEEDED || run.status === TaskRunStatus.FAILED)
        && this.isBound(persisted.taskId)) {
        throw new GuardedTaskRunStartError('CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH');
      }
      if (this.isBound(run.taskId)) {
        // Block ALL novel rows (including terminal-shaped insertion), and terminal → STARTED revival.
        if (!existing || run.status === TaskRunStatus.STARTED
          && (JSON.parse(existing.data) as TaskRun).status !== TaskRunStatus.STARTED) {
          throw new GuardedTaskRunStartError('CONTINUATION_GUARD_REQUIRED');
        }
        // R3-A / B-1: a generic save on a bound run may ONLY carry forward the exact durable containment
        // evidence already present. It must never CREATE, remove, or mutate it — evidence creation and
        // mutation are reserved for the semantic CAS APIs (recordContainmentBinding/PostEvidenceIfAbsent).
        // Rule (§2/§3/§4): both absent → ALLOW; both present & identical → ALLOW; anything else → REJECT.
        // Compared inside this IMMEDIATE transaction against the current persisted row.
        const current = extractContainmentAudit(JSON.parse(existing!.data) as TaskRun);
        const incoming = extractContainmentAudit(run);
        if (!containmentEvidenceIdentical(current, incoming)) {
          const reason = current === null
            ? 'MALFORMED_EVIDENCE' // current absent + incoming present: generic save may not create evidence
            : incoming === null
              ? 'EVIDENCE_REMOVED'
              : 'BINDING_DIGEST_CONFLICT';
          throw new ContainmentEvidenceConflictError(reason);
        }
      }
      this.db.prepare(
        `INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, data = excluded.data`,
      ).run(run.id, run.taskId, JSON.stringify(run));
      return run;
    }).immediate());
  }

  /**
   * R3-A: atomic insert-once compare-and-set of immutable containment binding evidence on the exact
   * STARTED run. Inside one IMMEDIATE transaction: load current row → require STARTED → inspect existing
   * evidence → absent: write; identical containmentBindingDigest: idempotent; different: reject. Status
   * is never changed. Malformed incoming evidence, a missing run, or a non-STARTED run all fail closed.
   */
  async recordContainmentBindingIfAbsent(
    exactTaskRunId: Id,
    containmentAudit: ContinuationContainmentAudit,
  ): Promise<TaskRun> {
    return this.noContention(() => this.db.transaction(() => {
      const run = this.loadStartedRunOrThrow(exactTaskRunId);
      const projected = snapshotContainmentAudit(containmentAudit, exactTaskRunId, exactTaskRunId);
      if (!projected || projected.postAttempt !== undefined) {
        // Binding recording must carry a valid binding and MUST NOT carry post-attempt evidence.
        throw new ContainmentEvidenceConflictError('MALFORMED_EVIDENCE');
      }
      const current = extractContainmentAudit(run);
      if (current !== null) {
        if (!bindingIdentical(current.binding, projected.binding)) {
          throw new ContainmentEvidenceConflictError('BINDING_DIGEST_CONFLICT');
        }
        return run; // idempotent: identical binding already present
      }
      return this.writeContainmentAudit(run, projected);
    }).immediate());
  }

  /**
   * R3-A: append-once record of optional post-attempt evidence. The binding must already exist and be
   * identical; postAttempt absent → record; identical → idempotent; different → reject. Binding identity
   * is never changed.
   */
  async recordContainmentPostEvidenceIfAbsent(
    exactTaskRunId: Id,
    containmentAudit: ContinuationContainmentAudit,
  ): Promise<TaskRun> {
    return this.noContention(() => this.db.transaction(() => {
      const run = this.loadStartedRunOrThrow(exactTaskRunId);
      const projected = snapshotContainmentAudit(containmentAudit, exactTaskRunId, exactTaskRunId);
      if (!projected || projected.postAttempt === undefined) {
        throw new ContainmentEvidenceConflictError('MALFORMED_EVIDENCE');
      }
      const current = extractContainmentAudit(run);
      if (current === null) throw new ContainmentEvidenceConflictError('BINDING_MISSING');
      if (!bindingIdentical(current.binding, projected.binding)) {
        throw new ContainmentEvidenceConflictError('BINDING_DIGEST_CONFLICT');
      }
      if (current.postAttempt !== undefined) {
        if (!postAttemptIdentical(current.postAttempt, projected.postAttempt)) {
          throw new ContainmentEvidenceConflictError('POST_ATTEMPT_CONFLICT');
        }
        return run; // idempotent: identical post-attempt already present
      }
      return this.writeContainmentAudit(run, projected);
    }).immediate());
  }

  /**
   * R3-A current-row terminal merge. Terminalize the exact STARTED run from the CURRENT persisted row,
   * preserving any durable containment evidence and merging routing audit + terminal metadata atomically.
   */
  async terminalizePreservingSecurityEvidence(
    exactTaskRunId: Id,
    request: TerminalizePreservingSecurityEvidenceRequest,
  ): Promise<TaskRun> {
    return this.noContention(() => this.db.transaction(() => {
      const run = this.loadStartedRunOrThrow(exactTaskRunId);
      if (request.terminalStatus !== 'SUCCEEDED' && request.terminalStatus !== 'FAILED') {
        throw new ContainmentEvidenceConflictError('MALFORMED_EVIDENCE');
      }
      // R3-A / B-2: the caller may NEVER create or replace containment evidence through terminal metadata.
      // Reject any caller-supplied CONTAINMENT_AUDIT_METADATA_KEY (prefer reject over silent stripping so a
      // caller contract violation is surfaced, not hidden). The ONLY source of truth for containment
      // evidence is the CURRENT persisted row.
      if (request.metadata !== undefined
        && Object.prototype.hasOwnProperty.call(request.metadata, CONTAINMENT_AUDIT_METADATA_KEY)) {
        throw new ContainmentEvidenceConflictError('CALLER_SUPPLIED_EVIDENCE');
      }
      const preservedAudit = extractContainmentAudit(run); // durable evidence from the CURRENT row only
      // R3-B2: current durable post-attempt uncertainty vetoes either terminal request atomically.
      // Keep STARTED (the existing UNRESOLVED lifecycle); never manufacture a definite terminal state.
      if (preservedAudit?.postAttempt && (preservedAudit.postAttempt.postAttemptModelIntegrity === 'MISMATCH'
        || preservedAudit.postAttempt.failureCode !== null)) return run;
      const mergedMetadata: Record<string, unknown> = {
        ...(run.metadata ?? {}),
        ...(request.metadata ?? {}),
      };
      // Containment evidence from the current persisted row is always preserved, never overwritten by a
      // caller-supplied terminal metadata bag. Caller metadata was already rejected above if it carried it.
      if (preservedAudit !== null) mergedMetadata[CONTAINMENT_AUDIT_METADATA_KEY] = preservedAudit;
      else delete mergedMetadata[CONTAINMENT_AUDIT_METADATA_KEY];
      const terminal: TaskRun = {
        ...run,
        status: request.terminalStatus === 'SUCCEEDED' ? TaskRunStatus.SUCCEEDED : TaskRunStatus.FAILED,
        finishedAt: request.finishedAt,
        durationMs: Math.max(0, Date.parse(request.finishedAt) - Date.parse(run.startedAt)),
        ...(request.artifactIds ? { artifactIds: [...request.artifactIds] } : {}),
        ...(request.providerId ? { providerId: request.providerId } : {}),
        ...(request.error ? { error: request.error } : {}),
        ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
      };
      this.db.prepare(
        `INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, data = excluded.data`,
      ).run(terminal.id, terminal.taskId, JSON.stringify(terminal));
      return terminal;
    }).immediate());
  }

  /**
   * Load the exact run and require STARTED AND continuation-bound; fail closed with a bounded conflict
   * otherwise. R3-A / B-3: containment evidence is continuation-specific, so every semantic evidence
   * operation (binding CAS, post-attempt CAS, security-preserving terminalize) must reject an ordinary/
   * unbound TaskRun. The bound check uses the canonical continuation-binding source of truth (isBound over
   * the persisted run's own task_id) and runs INSIDE the caller's IMMEDIATE transaction, so there is no
   * check-outside-then-mutate race.
   */
  private loadStartedRunOrThrow(id: Id): TaskRun {
    const row = this.db.prepare('SELECT data FROM task_runs WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new ContainmentEvidenceConflictError('RUN_NOT_FOUND');
    const run = JSON.parse(row.data) as TaskRun;
    if (!this.isBound(run.taskId)) throw new ContainmentEvidenceConflictError('RUN_NOT_CONTINUATION_BOUND');
    if (run.status !== TaskRunStatus.STARTED) throw new ContainmentEvidenceConflictError('RUN_NOT_STARTED');
    return run;
  }

  /** Write the projected containment audit into the run's metadata, preserving STARTED and all else. */
  private writeContainmentAudit(run: TaskRun, audit: ContinuationContainmentAudit): TaskRun {
    const next: TaskRun = {
      ...run,
      metadata: { ...(run.metadata ?? {}), [CONTAINMENT_AUDIT_METADATA_KEY]: audit },
    };
    this.db.prepare(
      `INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, data = excluded.data`,
    ).run(next.id, next.taskId, JSON.stringify(next));
    return next;
  }

  /** ADR-0089 bound-run retention. The refusal is derived from the persisted run's own task_id and the
   * canonical binding inside one IMMEDIATE transaction; no caller flag, argument or status participates.
   * Re-parenting a persisted run to an unbound Task cannot evade this: the v11 `task_runs_immutable_start`
   * trigger rejects any task_id/attempt/startedAt/capability change on update. */
  override async delete(id: Id): Promise<void> {
    this.noContention(() => this.db.transaction(() => {
      const row = this.db.prepare('SELECT task_id FROM task_runs WHERE id = ?').get(id) as
        | { task_id: string }
        | undefined;
      if (!row) return; // Missing-id no-op semantics preserved.
      if (this.isBound(row.task_id)) {
        throw new GuardedTaskRunStartError('CONTINUATION_RUN_DELETE_FORBIDDEN');
      }
      this.db.prepare('DELETE FROM task_runs WHERE id = ?').run(id);
    }).immediate());
  }

  async listByTask(taskId: Id): Promise<TaskRun[]> {
    const rows = this.db
      .prepare(`SELECT data FROM task_runs WHERE task_id = ? ORDER BY json_extract(data, '$.attempt')`)
      .all(taskId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as TaskRun);
  }
}

class SqliteWorkItemRepository
  extends JsonRepository<WorkItem>
  implements WorkItemRepository
{
  override async get(id: Id): Promise<WorkItem | null> {
    const item = await super.get(id);
    return item ? hydrateWorkItem(item) : null;
  }

  override async save(item: WorkItem): Promise<WorkItem> {
    this.db
      .prepare(
        `INSERT INTO work_items (id, actor_id, project_id, status, origin, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET actor_id = excluded.actor_id,
           project_id = excluded.project_id, status = excluded.status,
           origin = excluded.origin, data = excluded.data`,
      )
      .run(
        item.id,
        item.actorId,
        item.projectId ?? null,
        item.status,
        item.origin,
        JSON.stringify(item),
      );
    return item;
  }

  override async list(): Promise<WorkItem[]> {
    return (await super.list()).map(hydrateWorkItem);
  }

  async listByActor(actorId: Id): Promise<WorkItem[]> {
    const rows = this.db
      .prepare(
        `SELECT data FROM work_items WHERE actor_id = ?
         ORDER BY json_extract(data, '$.createdAt'), id`,
      )
      .all(actorId) as Row[];
    return rows.map((row) => hydrateWorkItem(JSON.parse(row.data) as WorkItem));
  }

  async listByResource(resourceRef: ResourceRef): Promise<WorkItem[]> {
    const rows = this.db
      .prepare(
        `SELECT work_items.data FROM work_items, json_each(work_items.data, '$.resourceRefs') AS resource
         WHERE json_extract(resource.value, '$.source') = ?
           AND json_extract(resource.value, '$.externalId') = ?
         ORDER BY json_extract(work_items.data, '$.createdAt'), work_items.id`,
      )
      .all(resourceRef.source, resourceRef.externalId) as Row[];
    return rows.map((row) => hydrateWorkItem(JSON.parse(row.data) as WorkItem));
  }
}

function hydrateWorkItem(item: WorkItem): WorkItem {
  return {
    ...item,
    resourceRefs: item.resourceRefs.map(
      (ref: ResourceRef) => new DomainResourceRef({ source: ref.source, externalId: ref.externalId }),
    ),
  };
}

class SqliteArtifactRepository extends JsonRepository<Artifact> implements ArtifactRepository {
  override async save(artifact: Artifact): Promise<Artifact> {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, task_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, data = excluded.data`,
      )
      .run(artifact.id, artifact.taskId ?? null, JSON.stringify(artifact));
    return artifact;
  }

  async listByTask(taskId: Id): Promise<Artifact[]> {
    const rows = this.db.prepare(`SELECT data FROM artifacts WHERE task_id = ?`).all(taskId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as Artifact);
  }
}

class SqliteApprovalRepository
  extends JsonRepository<ApprovalRequest>
  implements ApprovalRepository
{
  override async save(request: ApprovalRequest): Promise<ApprovalRequest> {
    this.db
      .prepare(
        `INSERT INTO approvals (id, execution_plan_id, status, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET execution_plan_id = excluded.execution_plan_id,
           status = excluded.status, data = excluded.data`,
      )
      .run(request.id, request.executionPlanRef.id, request.status, JSON.stringify(request));
    return request;
  }

  async findByExecutionPlan(executionPlanId: Id): Promise<ApprovalRequest[]> {
    const rows = this.db
      .prepare(`SELECT data FROM approvals WHERE execution_plan_id = ?`)
      .all(executionPlanId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as ApprovalRequest);
  }
}

class SqlitePatchRepository extends JsonRepository<PatchSet> implements PatchRepository {
  override async save(set: PatchSet): Promise<PatchSet> {
    this.db
      .prepare(
        `INSERT INTO patches (id, execution_plan_id, status, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET execution_plan_id = excluded.execution_plan_id,
           status = excluded.status, data = excluded.data`,
      )
      .run(set.id, set.executionPlanRef.id, set.status, JSON.stringify(set));
    return set;
  }

  async findByExecutionPlan(executionPlanId: Id): Promise<PatchSet[]> {
    const rows = this.db
      .prepare(`SELECT data FROM patches WHERE execution_plan_id = ?`)
      .all(executionPlanId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as PatchSet);
  }
}

class SqliteWorkspaceChangeRepository
  extends JsonRepository<WorkspaceChange>
  implements WorkspaceChangeRepository
{
  override async save(change: WorkspaceChange): Promise<WorkspaceChange> {
    this.db
      .prepare(
        `INSERT INTO workspace_changes (id, patch_id, status, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET patch_id = excluded.patch_id,
           status = excluded.status, data = excluded.data`,
      )
      .run(change.id, change.patchRef.id, change.status, JSON.stringify(change));
    return change;
  }

  async findByPatchSet(patchSetId: Id): Promise<WorkspaceChange[]> {
    const rows = this.db
      .prepare(`SELECT data FROM workspace_changes WHERE patch_id = ?`)
      .all(patchSetId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as WorkspaceChange);
  }
}

class SqliteCommandExecutionRepository
  extends JsonRepository<CommandExecution>
  implements CommandExecutionRepository
{
  override async save(execution: CommandExecution): Promise<CommandExecution> {
    this.db
      .prepare(
        `INSERT INTO command_executions (id, execution_plan_id, workspace_change_id, status, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET execution_plan_id = excluded.execution_plan_id,
           workspace_change_id = excluded.workspace_change_id,
           status = excluded.status, data = excluded.data`,
      )
      .run(
        execution.id,
        execution.executionPlanRef.id,
        execution.workspaceChangeRef?.id ?? null,
        execution.status,
        JSON.stringify(execution),
      );
    return execution;
  }

  async findByExecutionPlan(executionPlanId: Id): Promise<CommandExecution[]> {
    const rows = this.db
      .prepare(`SELECT data FROM command_executions WHERE execution_plan_id = ?`)
      .all(executionPlanId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as CommandExecution);
  }

  async findByWorkspaceChange(workspaceChangeId: Id): Promise<CommandExecution[]> {
    const rows = this.db
      .prepare(`SELECT data FROM command_executions WHERE workspace_change_id = ?`)
      .all(workspaceChangeId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as CommandExecution);
  }
}

/** Dedicated immutable CAP-013 repository; no UPDATE, UPSERT, or DELETE path. */
export class SqliteExecutionReceiptRepository implements ExecutionReceiptRepository {
  constructor(private readonly db: Db) {}

  async insert(receipt: ExecutionReceipt): Promise<ExecutionReceipt> {
    this.db
      .prepare(
        `INSERT INTO execution_receipts (
           id, execution_kind, source_id, execution_plan_id, authorization_kind,
           approval_id, outcome, failure_class, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.id,
        receipt.executionKind,
        receipt.sourceId,
        receipt.executionPlanId,
        receipt.authorization.kind,
        receipt.authorization.kind === 'APPROVAL' ? receipt.authorization.approvalId : null,
        receipt.outcome,
        receipt.failureClass ?? null,
        receipt.recordedAt,
      );
    return receipt;
  }

  async get(id: Id): Promise<ExecutionReceipt | null> {
    const row = this.db.prepare(`SELECT * FROM execution_receipts WHERE id = ?`).get(id) as
      | ExecutionReceiptRow
      | undefined;
    return row ? mapExecutionReceipt(row) : null;
  }

  async findBySource(
    executionKind: ExecutionKind,
    sourceId: Id,
  ): Promise<ExecutionReceipt | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM execution_receipts WHERE execution_kind = ? AND source_id = ?`,
      )
      .get(executionKind, sourceId) as ExecutionReceiptRow | undefined;
    return row ? mapExecutionReceipt(row) : null;
  }

  async findByExecutionPlan(executionPlanId: Id): Promise<ExecutionReceipt[]> {
    const rows = this.db
      .prepare(`SELECT * FROM execution_receipts WHERE execution_plan_id = ? ORDER BY recorded_at, id`)
      .all(executionPlanId) as ExecutionReceiptRow[];
    return rows.map(mapExecutionReceipt);
  }
}

function mapWorkHandoff(row: WorkHandoffRow): WorkHandoff {
  return createWorkHandoff(JSON.parse(row.data) as WorkHandoff);
}

/** Dedicated immutable CAP-014 repository; no UPDATE, UPSERT, or DELETE path. */
export class SqliteWorkHandoffRepository implements WorkHandoffRepository {
  constructor(private readonly db: Db) {}

  async insert(handoff: WorkHandoff): Promise<WorkHandoff> {
    const immutable = createWorkHandoff(handoff);
    this.db
      .prepare(
        `INSERT INTO work_handoffs (
           id, work_item_id, from_agent_profile_id, to_agent_profile_id, created_at, data
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        immutable.id,
        immutable.workItemId,
        immutable.fromAgentProfileId,
        immutable.toAgentProfileId,
        immutable.createdAt,
        JSON.stringify(immutable),
      );
    return immutable;
  }

  async get(id: Id): Promise<WorkHandoff | null> {
    const row = this.db.prepare(`SELECT data FROM work_handoffs WHERE id = ?`).get(id) as
      | WorkHandoffRow
      | undefined;
    return row ? mapWorkHandoff(row) : null;
  }

  async listByWorkItem(workItemId: Id): Promise<WorkHandoff[]> {
    return this.listBy('work_item_id', workItemId);
  }

  async listByFromAgent(agentProfileId: AgentProfileId): Promise<WorkHandoff[]> {
    return this.listBy('from_agent_profile_id', agentProfileId);
  }

  async listByToAgent(agentProfileId: AgentProfileId): Promise<WorkHandoff[]> {
    return this.listBy('to_agent_profile_id', agentProfileId);
  }

  private async listBy(
    column: 'work_item_id' | 'from_agent_profile_id' | 'to_agent_profile_id',
    value: string,
  ): Promise<WorkHandoff[]> {
    const rows = this.db
      .prepare(`SELECT data FROM work_handoffs WHERE ${column} = ? ORDER BY created_at, id`)
      .all(value) as WorkHandoffRow[];
    return rows.map(mapWorkHandoff);
  }
}

class SqliteCodeGenerationRepository
  extends JsonRepository<CodeGeneration>
  implements CodeGenerationRepository
{
  override async save(generation: CodeGeneration): Promise<CodeGeneration> {
    this.db
      .prepare(
        `INSERT INTO code_generations (id, execution_plan_id, status, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET execution_plan_id = excluded.execution_plan_id,
           status = excluded.status, data = excluded.data`,
      )
      .run(generation.id, generation.executionPlanRef.id, generation.status, JSON.stringify(generation));
    return generation;
  }

  async findByExecutionPlan(executionPlanId: Id): Promise<CodeGeneration[]> {
    const rows = this.db
      .prepare(`SELECT data FROM code_generations WHERE execution_plan_id = ?`)
      .all(executionPlanId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as CodeGeneration);
  }
}

class SqliteCodeProposalRepository
  extends JsonRepository<CodeProposal>
  implements CodeProposalRepository
{
  override async save(proposal: CodeProposal): Promise<CodeProposal> {
    this.db
      .prepare(
        `INSERT INTO code_proposals (id, code_generation_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET code_generation_id = excluded.code_generation_id,
           data = excluded.data`,
      )
      .run(proposal.id, proposal.codeGenerationRef.id, JSON.stringify(proposal));
    return proposal;
  }

  async findByCodeGeneration(codeGenerationId: Id): Promise<CodeProposal[]> {
    const rows = this.db
      .prepare(`SELECT data FROM code_proposals WHERE code_generation_id = ?`)
      .all(codeGenerationId) as Row[];
    return rows.map((r) => JSON.parse(r.data) as CodeProposal);
  }
}

class SqliteMemoryRepository extends JsonRepository<MemoryRecord> implements MemoryRepository {
  override async save(record: MemoryRecord): Promise<MemoryRecord> {
    this.db
      .prepare(
        `INSERT INTO memories (id, session_id, project_id, channel_id, thread_id, type, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id,
           project_id = excluded.project_id, channel_id = excluded.channel_id,
           thread_id = excluded.thread_id, type = excluded.type, data = excluded.data`,
      )
      .run(
        record.id,
        record.scope.sessionId ?? null,
        record.scope.projectId ?? null,
        record.scope.channelId ?? null,
        record.scope.threadId ?? null,
        record.type,
        JSON.stringify(record),
      );
    return record;
  }

  async findByScope(scope: MemoryScope, type?: MemoryType): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scope.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(scope.sessionId);
    }
    if (scope.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(scope.projectId);
    }
    if (scope.channelId !== undefined) {
      clauses.push('channel_id = ?');
      params.push(scope.channelId);
    }
    if (scope.threadId !== undefined) {
      clauses.push('thread_id = ?');
      params.push(scope.threadId);
    }
    if (type !== undefined) {
      clauses.push('type = ?');
      params.push(type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // MemoryManager/ContextBuilder consume SHORT_TERM records in persistence order when
    // legacy rows share the same createdAt value. SQLite does not guarantee row order
    // without ORDER BY, so make the domain timestamp primary and insertion order the
    // deterministic tie-breaker. The JSON document remains the domain mapping source.
    const rows = this.db
      .prepare(
        `SELECT data FROM memories ${where}
         ORDER BY json_extract(data, '$.createdAt') ASC, rowid ASC`,
      )
      .all(...params) as Row[];
    return rows.map((r) => JSON.parse(r.data) as MemoryRecord);
  }

  async findDurableCandidates(query: DurableMemoryQuery): Promise<MemoryRecord[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new RangeError('DurableMemoryQuery.limit must be a positive integer');
    }

    const clauses = [`type = 'LONG_TERM'`];
    const params: unknown[] = [];
    const columnScopes: ReadonlyArray<[keyof MemoryScope, string]> = [
      ['sessionId', 'session_id'],
      ['projectId', 'project_id'],
      ['channelId', 'channel_id'],
      ['threadId', 'thread_id'],
    ];
    for (const [key, column] of columnScopes) {
      const value = query.scope[key];
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    for (const key of ['userId', 'taskId'] as const) {
      const value = query.scope[key];
      if (value !== undefined) {
        clauses.push(`json_extract(data, '$.scope.${key}') = ?`);
        params.push(value);
      }
    }
    if (query.excludeIds && query.excludeIds.length > 0) {
      clauses.push(`id NOT IN (${query.excludeIds.map(() => '?').join(', ')})`);
      params.push(...query.excludeIds);
    }
    if (query.excludeExpired) {
      clauses.push(
        `(json_type(data, '$.metadata.expiresAt') IS NULL OR datetime(json_extract(data, '$.metadata.expiresAt')) >= datetime('now'))`,
      );
    }
    if (query.excludeSuperseded) {
      clauses.push(`json_type(data, '$.metadata.supersededBy') IS NULL`);
    }

    params.push(query.limit);
    const rows = this.db
      .prepare(
        `SELECT data FROM memories WHERE ${clauses.join(' AND ')}
         ORDER BY json_extract(data, '$.updatedAt') DESC, id ASC LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map((row) => JSON.parse(row.data) as MemoryRecord);
  }
}

/**
 * StorageProvider over SQLite (better-sqlite3). All SQL stays in this package;
 * callers see only domain entities. Implemented: actors, sessions, tasks,
 * taskRuns, artifacts, memories, projects, approvals (CAP-004), patches (CAP-005),
 * workspaceChanges (CAP-006), commandExecutions (CAP-007), codeGenerations +
 * codeProposals (CAP-008), workItems (CAP-011), executionReceipts (CAP-013),
 * workHandoffs (CAP-014).
 */
export class SqliteStorageProvider implements StorageProvider {
  private db?: Db;

  // Built in init() once the connection exists.
  actors!: ActorRepository;
  sessions!: SessionRepository;
  tasks!: TaskRepository;
  taskRuns!: TaskRunRepository;
  /** Explicit opt-in port; not wired into Product runtime. */
  continuationBindings!: ContinuationBindingRepository;
  artifacts!: ArtifactRepository;
  memories!: MemoryRepository;
  projects!: Repository<Project>;
  workItems!: WorkItemRepository;
  approvals!: ApprovalRepository;
  patches!: PatchRepository;
  workspaceChanges!: WorkspaceChangeRepository;
  commandExecutions!: CommandExecutionRepository;
  executionReceipts!: ExecutionReceiptRepository;
  workHandoffs!: WorkHandoffRepository;
  codeGenerations!: CodeGenerationRepository;
  codeProposals!: CodeProposalRepository;

  constructor(private readonly config: SqliteConfig) {}

  async init(): Promise<void> {
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    // ADR-0089: the bounded lock wait is explicit adapter configuration, not an implicit driver default.
    const busyTimeoutMs = this.config.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error('SQLITE_BUSY_TIMEOUT_INVALID');
    }
    const db = new Database(this.config.dbPath, { timeout: busyTimeoutMs });
    db.pragma('journal_mode = WAL');
    // Schema is applied by a versioned, forward-only migration runner (ADR-0020).
    // Backward compatible: a legacy DB (user_version = 0) re-runs the idempotent
    // baseline and is stamped forward; no behavior or table change.
    runMigrations(db);

    this.db = db;
    this.actors = new SqliteActorRepository(db, 'actors');
    this.sessions = new SqliteSessionRepository(db, 'sessions');
    this.tasks = new SqliteTaskRepository(db, 'tasks');
    this.taskRuns = new SqliteTaskRunRepository(db, 'task_runs');
    this.continuationBindings = new SqliteContinuationBindingRepository(db);
    this.artifacts = new SqliteArtifactRepository(db, 'artifacts');
    this.memories = new SqliteMemoryRepository(db, 'memories');
    this.projects = new JsonRepository<Project>(db, 'projects');
    this.workItems = new SqliteWorkItemRepository(db, 'work_items');
    this.approvals = new SqliteApprovalRepository(db, 'approvals');
    this.patches = new SqlitePatchRepository(db, 'patches');
    this.workspaceChanges = new SqliteWorkspaceChangeRepository(db, 'workspace_changes');
    this.commandExecutions = new SqliteCommandExecutionRepository(db, 'command_executions');
    this.executionReceipts = new SqliteExecutionReceiptRepository(db);
    this.workHandoffs = new SqliteWorkHandoffRepository(db);
    this.codeGenerations = new SqliteCodeGenerationRepository(db, 'code_generations');
    this.codeProposals = new SqliteCodeProposalRepository(db, 'code_proposals');
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
