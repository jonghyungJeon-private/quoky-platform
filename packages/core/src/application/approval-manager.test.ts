import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_REVOKED_COMMENT, ApprovalManager } from './approval-manager';
import { ApprovalPolicy } from './approval-policy';
import { RiskPolicy } from './risk-policy';
import { ApprovalStatus, ExecutionStatus, RiskLevel } from '../domain';
import type { ApprovalRequest, ExecutionPlan } from '../domain';
import type { ApprovalRepository, StorageProvider } from '../ports';

/** In-memory approvals repo + a StorageProvider exposing only it. */
function fakeStorage(): StorageProvider {
  const rows = new Map<string, ApprovalRequest>();
  const approvals: ApprovalRepository = {
    async get(id) {
      return rows.get(id) ?? null;
    },
    async save(entity) {
      rows.set(entity.id, entity);
      return entity;
    },
    async delete(id) {
      rows.delete(id);
    },
    async list() {
      return [...rows.values()];
    },
    async findByExecutionPlan(executionPlanId) {
      return [...rows.values()].filter((r) => r.executionPlanRef.id === executionPlanId);
    },
  };
  return { approvals } as unknown as StorageProvider;
}

function plan(overallRisk: RiskLevel, id = 'plan-1'): ExecutionPlan {
  return {
    id,
    goal: 'do the thing',
    summary: 's',
    steps: [],
    requiredCapabilities: [],
    requiredResources: [],
    estimatedChanges: { fileCount: 0, scope: 'none' },
    approvalRequired: overallRisk === RiskLevel.HIGH || overallRisk === RiskLevel.CRITICAL,
    overallRisk,
    expectedArtifacts: [],
    status: ExecutionStatus.PENDING,
    createdAt: '2026-06-29T00:00:00.000Z',
  };
}

function manager(): ApprovalManager {
  return new ApprovalManager(fakeStorage(), new ApprovalPolicy(new RiskPolicy()));
}

describe('ApprovalManager (CAP-004, ADR-0025)', () => {
  it('requestFor a HIGH-risk plan creates a PENDING request referencing the plan', async () => {
    const req = await manager().requestFor(plan(RiskLevel.HIGH), 'alice');
    expect(req.status).toBe(ApprovalStatus.PENDING);
    expect(req.executionPlanRef).toEqual({ id: 'plan-1', goal: 'do the thing' });
    expect(req.requestedBy).toBe('alice');
    expect(req.decision).toBeUndefined();
  });

  it('requestFor a LOW-risk plan is auto-approved by the system', async () => {
    const req = await manager().requestFor(plan(RiskLevel.LOW), 'alice');
    expect(req.status).toBe(ApprovalStatus.APPROVED);
    expect(req.decision).toBe(true);
    expect(req.decidedBy).toBe('system');
  });

  it('decide() approves/rejects a PENDING request and records the decision', async () => {
    const mgr = manager();
    const req = await mgr.requestFor(plan(RiskLevel.HIGH), 'alice');
    const decided = await mgr.decide(req.id, {
      approvalId: req.id,
      approved: true,
      decidedBy: 'bob',
      decidedAt: '2026-06-29T01:00:00.000Z',
      comment: 'ok',
    });
    expect(decided.status).toBe(ApprovalStatus.APPROVED);
    expect(decided.decision).toBe(true);
    expect(decided.decidedBy).toBe('bob');
    expect(decided.comment).toBe('ok');
    expect(await mgr.isApproved('plan-1')).toBe(true);
  });

  it('decide() throws when the request is missing or already decided', async () => {
    const mgr = manager();
    await expect(
      mgr.decide('nope', { approvalId: 'nope', approved: true, decidedBy: 'x', decidedAt: 't' }),
    ).rejects.toThrow(/not found/);
    const req = await mgr.requestFor(plan(RiskLevel.HIGH), 'a');
    await mgr.decide(req.id, { approvalId: req.id, approved: false, decidedBy: 'b', decidedAt: 't' });
    await expect(
      mgr.decide(req.id, { approvalId: req.id, approved: true, decidedBy: 'c', decidedAt: 't' }),
    ).rejects.toThrow(/already decided/);
  });

  it('NEVER mutates the ExecutionPlan (aggregate ownership)', async () => {
    const p = Object.freeze(plan(RiskLevel.HIGH)); // throws on any write attempt
    const snapshot = JSON.stringify(p);
    await manager().requestFor(p, 'alice');
    expect(JSON.stringify(p)).toBe(snapshot); // plan unchanged
  });
});

// ── Sprint 2s — Explicit Preview Apply Approval (ADR-0040) ─────────────────────────────────────────

describe('ApprovalManager.requestForRisk (Sprint 2s, ADR-0040)', () => {
  it('creates a PENDING request with the given executionPlanRef/riskLevel/reason/requestedBy', async () => {
    const req = await manager().requestForRisk({
      executionPlanRef: { id: 'plan-1', goal: 'do the thing' },
      riskLevel: RiskLevel.HIGH,
      reason: 'Apply AI code proposal prop-1 from generation gen-1 to foo.ts',
      requestedBy: 'alice',
    });
    expect(req.status).toBe(ApprovalStatus.PENDING);
    expect(req.riskLevel).toBe(RiskLevel.HIGH);
    expect(req.executionPlanRef).toEqual({ id: 'plan-1', goal: 'do the thing' });
    expect(req.reason).toBe('Apply AI code proposal prop-1 from generation gen-1 to foo.ts');
    expect(req.requestedBy).toBe('alice');
    expect(req.decision).toBeUndefined(); // never auto-approved
  });

  it('never calls ApprovalPolicy.evaluate — there is no live ExecutionPlan to re-evaluate', async () => {
    const policy = new ApprovalPolicy(new RiskPolicy());
    const evaluateSpy = vi.spyOn(policy, 'evaluate');
    const mgr = new ApprovalManager(fakeStorage(), policy);
    await mgr.requestForRisk({
      executionPlanRef: { id: 'plan-1', goal: 'g' },
      riskLevel: RiskLevel.HIGH,
      reason: 'r',
      requestedBy: 'alice',
    });
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('requestFor behavior remains unchanged (regression)', async () => {
    const req = await manager().requestFor(plan(RiskLevel.HIGH), 'alice');
    expect(req.status).toBe(ApprovalStatus.PENDING);
    expect(req.executionPlanRef).toEqual({ id: 'plan-1', goal: 'do the thing' });
  });

  it('throws and does not save when reason is blank (CA Round 1)', async () => {
    const storage = fakeStorage();
    const saveSpy = vi.spyOn(storage.approvals, 'save');
    const mgr = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
    await expect(
      mgr.requestForRisk({ executionPlanRef: { id: 'plan-1', goal: 'g' }, riskLevel: RiskLevel.HIGH, reason: '   ', requestedBy: 'alice' }),
    ).rejects.toThrow(/reason/);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('throws and does not save when requestedBy is blank (CA Round 1)', async () => {
    const storage = fakeStorage();
    const saveSpy = vi.spyOn(storage.approvals, 'save');
    const mgr = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
    await expect(
      mgr.requestForRisk({ executionPlanRef: { id: 'plan-1', goal: 'g' }, riskLevel: RiskLevel.HIGH, reason: 'r', requestedBy: '  ' }),
    ).rejects.toThrow(/requestedBy/);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('throws and does not save for a non-HIGH/CRITICAL risk (CA Round 1 — bypasses policy, so must be narrow)', async () => {
    const storage = fakeStorage();
    const saveSpy = vi.spyOn(storage.approvals, 'save');
    const mgr = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
    await expect(
      mgr.requestForRisk({ executionPlanRef: { id: 'plan-1', goal: 'g' }, riskLevel: RiskLevel.MEDIUM, reason: 'r', requestedBy: 'alice' }),
    ).rejects.toThrow(/HIGH\/CRITICAL/);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('accepts CRITICAL risk as well as HIGH', async () => {
    const req = await manager().requestForRisk({
      executionPlanRef: { id: 'plan-1', goal: 'g' },
      riskLevel: RiskLevel.CRITICAL,
      reason: 'r',
      requestedBy: 'alice',
    });
    expect(req.status).toBe(ApprovalStatus.PENDING);
    expect(req.riskLevel).toBe(RiskLevel.CRITICAL);
  });
});

describe('ApprovalManager.revoke (live QA session 3, D12)', () => {
  const decision = (approved: boolean, comment?: string) => ({
    approvalId: 'x',
    approved,
    decidedBy: 'owner',
    decidedAt: '2026-10-08T00:01:00.000Z',
    ...(comment ? { comment } : {}),
  });

  it('withdraws an APPROVED request: REJECTED, decision false, the revocation recorded', async () => {
    const m = manager();
    const req = await m.requestForRisk({ executionPlanRef: { id: 'p', goal: 'g' }, riskLevel: RiskLevel.CRITICAL, reason: 'r', requestedBy: 'owner' });
    await m.decide(req.id, decision(true));
    const revoked = await m.revoke(req.id, decision(false));
    expect(revoked).toMatchObject({ status: ApprovalStatus.REJECTED, decision: false, decidedBy: 'owner', comment: APPROVAL_REVOKED_COMMENT });
    expect(await m.isApproved('p')).toBe(false);
  });

  it('refuses a PENDING or REJECTED request and an "approve" revocation, leaving it unchanged', async () => {
    const m = manager();
    const req = await m.requestForRisk({ executionPlanRef: { id: 'p', goal: 'g' }, riskLevel: RiskLevel.HIGH, reason: 'r', requestedBy: 'owner' });
    await expect(m.revoke(req.id, decision(false))).rejects.toThrow(/cannot be revoked/);
    await m.decide(req.id, decision(true));
    await expect(m.revoke(req.id, decision(true))).rejects.toThrow(/cannot be revoked/);
    expect((await m.get(req.id))?.status).toBe(ApprovalStatus.APPROVED);
    await m.revoke(req.id, decision(false));
    await expect(m.revoke(req.id, decision(false))).rejects.toThrow(/cannot be revoked/);
    await expect(m.revoke('missing', decision(false))).rejects.toThrow(/not found/);
  });
});
