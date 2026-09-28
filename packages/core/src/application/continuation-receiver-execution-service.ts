import { constrainedContinuation, snapshotReceiverConstraint } from './continuation-execution-internal';
import { snapshotReceiverOutcome } from './continuation-receiver-validation';
import { Capability, IntentType, TaskRunStatus } from '../domain';
import type { ContinuationRoutingAudit } from '../ports';
import { createWorkHandoff } from '../domain';
import type { TaskRun } from '../domain';
import type { ContinuationReceiver, ContinuationReceiverOutcome, StorageProvider } from '../ports';
import type { AgentProfileRegistry } from './agent-profile-registry';
import { createContinuationExecutionRequestContext, hasOnlyContinuationRequestFields } from './continuation-execution-product-policy';
import type { ContinuationExecutionRequestContext } from './continuation-execution-product-policy';
import type { ContinuationExecutionResult, ContinuationExecutionService } from './continuation-execution-service';
import type { TaskManager } from './task-manager';
import { WorkHandoffConsumptionService } from './work-handoff-consumption-service';
import { WorkHandoffConsumptionError, WorkHandoffConsumptionFailureCode } from './work-handoff-consumption-service';

export type ContinuationReceiverExecutionResult =
  | Extract<ContinuationExecutionResult, { disposition: 'DENY' }>
  | Readonly<{ disposition: 'DENY'; stage: 'RECEIVER_PREFLIGHT'; reason: 'RECEIVER_UNAVAILABLE' }>
  | Readonly<{ disposition: 'ATTEMPT_SUCCEEDED' | 'ATTEMPT_FAILED'; taskRun: TaskRun }>
  | Readonly<{ disposition: 'ATTEMPT_UNRESOLVED'; taskRun: TaskRun; routingAudit?: ContinuationRoutingAudit }>;

/** Freeze in place to retain exact started-run identity, including any nested audit metadata. */
function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeValue(child, seen);
    Object.freeze(value);
  }
  return value;
}

/**
 * ADR-0089 / M3E-6K. Same invocation only: preflight → real 6J start → receiver → TaskManager.
 * No direct admission/start/save, lookup after start, Provider, retry or production receiver binding.
 * Pre-start typed errors retain their meaning. A process crash may leave STARTED unresolved;
 * no exactly-once external effects, auto-recovery, replacement attempt or redispatch is claimed.
 */
export class ContinuationReceiverExecutionService {
  constructor(
    private readonly storage: {
      workHandoffs: Pick<StorageProvider['workHandoffs'], 'get'>;
      workItems: Pick<StorageProvider['workItems'], 'get'>;
    },
    private readonly profiles: AgentProfileRegistry,
    private readonly continuation: Pick<ContinuationExecutionService, typeof constrainedContinuation>,
    private readonly tasks: Pick<TaskManager, 'terminalizePreservingSecurityEvidence'>,
    private readonly receiver: ContinuationReceiver | undefined,
  ) {}

  async executeExplicitContinuation(input: ContinuationExecutionRequestContext): Promise<ContinuationReceiverExecutionResult> {
    let request: ContinuationExecutionRequestContext;
    try {
      if (!hasOnlyContinuationRequestFields(input)) throw new Error('Invalid request');
      request = createContinuationExecutionRequestContext(input);
    } catch {
      return Object.freeze({ disposition: 'DENY', stage: 'CONTEXT', reason: 'INVALID_REQUEST' });
    }
    const receiver = this.receiver;
    if (!receiver || typeof receiver.receive !== 'function') {
      return Object.freeze({ disposition: 'DENY', stage: 'RECEIVER_PREFLIGHT', reason: 'RECEIVER_UNAVAILABLE' });
    }
    let constraint;
    try { constraint = snapshotReceiverConstraint(receiver.supportedCapabilities); }
    catch { return Object.freeze({ disposition: 'DENY', stage: 'RECEIVER_PREFLIGHT', reason: 'RECEIVER_UNAVAILABLE' }); }
    // Consumption validates exactly the immutable handoff retained for receiver context, without a
    // second handoff lookup. Its canonical lifecycle/profile checks stay with the existing owner.
    let handoff: ReturnType<typeof createWorkHandoff> | undefined;
    const consumed = await new WorkHandoffConsumptionService({
      workItems: this.storage.workItems,
      workHandoffs: { get: async id => {
        const loaded = await this.storage.workHandoffs.get(id);
        if (!loaded) return null;
        try { handoff = createWorkHandoff(loaded); }
        catch { throw new WorkHandoffConsumptionError(WorkHandoffConsumptionFailureCode.INVALID_HANDOFF); }
        return loaded;
      } },
    }, this.profiles).evaluate(request.handoffId);
    if (consumed.disposition !== 'CONTINUE') {
      return Object.freeze({ disposition: 'DENY', stage: 'CANONICAL', reason: 'WORK_ITEM_NOT_CONTINUABLE' });
    }
    if (!handoff) throw new WorkHandoffConsumptionError(WorkHandoffConsumptionFailureCode.HANDOFF_NOT_FOUND);
    const destinationAgentProfile = this.profiles.get(handoff.toAgentProfileId);
    const started = await this.continuation[constrainedContinuation](request, constraint);
    if (started.disposition === 'DENY') return started;
    const startedRun = started.taskRun;
    const unresolved = (routingAudit?: ContinuationRoutingAudit): ContinuationReceiverExecutionResult =>
      Object.freeze({ disposition: 'ATTEMPT_UNRESOLVED', taskRun: startedRun, ...(routingAudit ? { routingAudit } : {}) });
    const facts = started.boundTaskFacts;
    if (!facts || facts.capability !== startedRun.capability || !Object.values(Capability).includes(facts.capability)
      || !Object.values(IntentType).includes(facts.intentType) || !constraint.supportedCapabilities.includes(facts.capability)) {
      return unresolved();
    }
    let outcome: ContinuationReceiverOutcome | null;
    try {
      const input = Object.freeze({ handoff, destinationAgentProfile, plan: request.plan,
        taskRun: freezeValue(startedRun), boundTaskFacts: Object.freeze({ ...facts }) });
      outcome = snapshotReceiverOutcome(await receiver.receive(input), startedRun.id);
    } catch {
      // R1 amendment: 6K cannot know dispatch phase. Every receiver escape is uncertainty.
      return unresolved();
    }
    if (!outcome) return unresolved();
    if (outcome.disposition === 'UNRESOLVED') return unresolved(outcome.routingAudit);
    const metadata = outcome.routingAudit ? { routingAudit: outcome.routingAudit } : undefined;
    // All runs admitted here are continuation-bound: use current-row merge even when the stale
    // started snapshot predates containment evidence. Ordinary TaskManager callers are unchanged.
    // Keep persistence outside the receiver catch: no fallback save or retry after terminalization errors.
    if (outcome.disposition === 'SUCCEEDED') {
      const taskRun = await this.tasks.terminalizePreservingSecurityEvidence(startedRun.id, { terminalStatus: TaskRunStatus.SUCCEEDED, artifactIds: [...outcome.artifactIds],
        ...(outcome.acceptedProviderId ? { providerId: outcome.acceptedProviderId } : {}), ...(metadata ? { metadata } : {}) });
      return Object.freeze({ disposition: taskRun.status === TaskRunStatus.STARTED ? 'ATTEMPT_UNRESOLVED' : 'ATTEMPT_SUCCEEDED', taskRun });
    }
    const taskRun = await this.tasks.terminalizePreservingSecurityEvidence(startedRun.id, { terminalStatus: TaskRunStatus.FAILED, error: outcome.error, ...(metadata ? { metadata } : {}) });
    return Object.freeze({ disposition: taskRun.status === TaskRunStatus.STARTED ? 'ATTEMPT_UNRESOLVED' : 'ATTEMPT_FAILED', taskRun });
  }
}
