import { newId } from '../util/id';
import { now } from '../util/clock';
import { ApprovalStatus, RiskLevel, executionPlanRef } from '../domain';
import type { ApprovalDecision, ApprovalRequest, ExecutionPlan, ExecutionPlanRef, Id } from '../domain';
import type { StorageProvider } from '../ports';
import type { ApprovalPolicy } from './approval-policy';

/** The decision comment of an approval the owner withdrew after approving it, before execution (D12). */
export const APPROVAL_REVOKED_COMMENT = 'revoked-before-execution';

/**
 * CAP-004 Approval (ADR-0025). Owns the `ApprovalRequest` aggregate and is the
 * ONLY capability that mutates it. It REFERENCES an `ExecutionPlan` (read-only,
 * via `executionPlanRef`) and never mutates the plan — Aggregate Ownership Rule.
 * Persists through the StorageProvider `approvals` repository.
 */
export class ApprovalManager {
  constructor(
    private readonly storage: StorageProvider,
    private readonly policy: ApprovalPolicy,
  ) {}

  /**
   * Create an ApprovalRequest for a plan. If the policy says no approval is
   * needed, the request is created already APPROVED (auto, decided by 'system');
   * otherwise it is PENDING awaiting a human decision. The plan is read, never mutated.
   */
  async requestFor(plan: ExecutionPlan, requestedBy: string): Promise<ApprovalRequest> {
    const evaluation = this.policy.evaluate(plan, requestedBy);
    const ts = now();
    const auto = !evaluation.requiresApproval;
    const request: ApprovalRequest = {
      id: newId(),
      executionPlanRef: executionPlanRef(plan),
      status: auto ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING,
      riskLevel: evaluation.riskLevel,
      reason: evaluation.reason,
      requestedBy,
      ...(auto ? { decision: true, decidedBy: 'system', decidedAt: ts } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    return this.storage.approvals.save(request);
  }

  /** Record a human decision on a PENDING request (this aggregate is Approval-owned). */
  async decide(approvalId: Id, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const existing = await this.storage.approvals.get(approvalId);
    if (!existing) throw new Error(`approval not found: ${approvalId}`);
    if (existing.status !== ApprovalStatus.PENDING) {
      throw new Error(`approval ${approvalId} already decided (${existing.status})`);
    }
    const updated: ApprovalRequest = {
      ...existing,
      status: decision.approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
      decision: decision.approved,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      ...(decision.comment ? { comment: decision.comment } : {}),
      updatedAt: now(),
    };
    return this.storage.approvals.save(updated);
  }

  /**
   * Live QA session 3 (D12): the owner withdraws an APPROVED grant before anything ran (a post-approval "거절"/"취소" of a
   * one-time connector write). The request becomes REJECTED with the withdrawal recorded as its decision, so the audit
   * row matches the closed anchor and nothing can execute against it (the executor re-reads APPROVED before a send). Only
   * an APPROVED request may be revoked; anything else is refused unchanged.
   */
  async revoke(approvalId: Id, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const existing = await this.storage.approvals.get(approvalId);
    if (!existing) throw new Error(`approval not found: ${approvalId}`);
    if (existing.status !== ApprovalStatus.APPROVED || decision.approved) {
      throw new Error(`approval ${approvalId} cannot be revoked (${existing.status})`);
    }
    const updated: ApprovalRequest = {
      ...existing,
      status: ApprovalStatus.REJECTED,
      decision: false,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      comment: decision.comment ?? APPROVAL_REVOKED_COMMENT,
      updatedAt: now(),
    };
    return this.storage.approvals.save(updated);
  }

  async get(approvalId: Id): Promise<ApprovalRequest | null> {
    return this.storage.approvals.get(approvalId);
  }

  /**
   * Create a PENDING ApprovalRequest when there is no live ExecutionPlan to re-evaluate (ADR-0024: the
   * plan is in-memory only and does not survive past its originating turn) — e.g. a later, explicit
   * approval for a mutation step derived from an already-approved plan (Sprint 2s, ADR-0040). The risk
   * level is supplied directly by the caller, which already knows it must require approval; this
   * deliberately bypasses ApprovalPolicy's plan-based evaluation and NEVER auto-approves — it does not
   * replace requestFor(plan) for the normal planning-approval path.
   *
   * Because it bypasses policy evaluation it is narrowly constrained (CA Round 1 review): a non-empty
   * `reason` and `requestedBy` are required, and only HIGH/CRITICAL risk is accepted — a mutation-step
   * approval that isn't at least HIGH would be a caller error, not something to persist silently.
   */
  async requestForRisk(input: {
    executionPlanRef: ExecutionPlanRef;
    riskLevel: RiskLevel;
    reason: string;
    requestedBy: string;
  }): Promise<ApprovalRequest> {
    if (!input.reason.trim()) throw new Error('requestForRisk: a non-empty reason is required');
    if (!input.requestedBy.trim()) throw new Error('requestForRisk: a non-empty requestedBy is required');
    if (input.riskLevel !== RiskLevel.HIGH && input.riskLevel !== RiskLevel.CRITICAL) {
      throw new Error('requestForRisk: only HIGH/CRITICAL risk is accepted (it bypasses ApprovalPolicy)');
    }
    const ts = now();
    const request: ApprovalRequest = {
      id: newId(),
      executionPlanRef: input.executionPlanRef,
      status: ApprovalStatus.PENDING, // unconditional — this method never auto-approves
      riskLevel: input.riskLevel,
      reason: input.reason,
      requestedBy: input.requestedBy,
      createdAt: ts,
      updatedAt: ts,
    };
    return this.storage.approvals.save(request);
  }

  /** Whether a given ExecutionPlan currently has an APPROVED request. */
  async isApproved(executionPlanId: Id): Promise<boolean> {
    const requests = await this.storage.approvals.findByExecutionPlan(executionPlanId);
    return requests.some((r) => r.status === ApprovalStatus.APPROVED);
  }
}
