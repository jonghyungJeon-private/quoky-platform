import { describe, expect, it } from 'vitest';
import { Capability, RiskLevel } from '../domain';
import type { ApprovalRequest, ExecutionPlan, Id } from '../domain';
import type { Logger, StorageProvider } from '../ports';
import { ExecutionOrchestrator, ExecutionOutcomeStatus } from './execution-orchestrator';
import type { ExecutionRequest, PlanningRequest } from './execution-orchestrator';
import { ApprovalManager } from './approval-manager';
import { ApprovalPolicy } from './approval-policy';
import { RiskPolicy } from './risk-policy';

// Sprint 4c-Follow-up-2, Track A / ADR-0062 — A2 real-chain coverage (CA §5.3).
// The ConversationRuntime tests fake the orchestrator; this exercises the REAL ExecutionOrchestrator + REAL
// ApprovalManager (+ real ApprovalPolicy/RiskPolicy, and the real approvals `.save`/`.get` persistence) for a
// planningOnly CODE_IMPLEMENTATION request whose target is a NEW file that does not exist yet — the exact shape
// A2 now routes to planning/preview. It must reach AWAITING_APPROVAL WITHOUT running code-generation / workspace
// diff / patch / workspace-write / command (no mutation, no file read pre-approval). Planning is a deterministic
// stand-in mirroring the real single-step planner (HIGH risk → approval PENDING); everything downstream of
// routing — orchestrator pipeline selection + the approval gate + persistence — is the real code.

const logger: Logger = { info() {}, warn() {}, error() {} };

/** In-memory approvals repo — the only StorageProvider surface ApprovalManager touches. */
function makeStorage(): StorageProvider {
  const approvals = new Map<string, ApprovalRequest>();
  return {
    approvals: {
      async save(r: ApprovalRequest) {
        approvals.set(r.id, r);
        return r;
      },
      async get(id: Id) {
        return approvals.get(id) ?? null;
      },
    },
  } as unknown as StorageProvider;
}

describe('new-file planningOnly preview — real orchestrator + real ApprovalManager (A2 real-chain)', () => {
  it('reaches AWAITING_APPROVAL for a NEW-file target without any codegen/diff/patch/write/command', async () => {
    const calls = { plan: 0, codeGen: 0, workspaceDiff: 0, workspaceRead: 0, patch: 0, write: 0, command: 0 };
    const orchestrator = new ExecutionOrchestrator({
      planning: {
        async plan(req: PlanningRequest): Promise<ExecutionPlan> {
          calls.plan++;
          // Deterministic single-step HIGH-risk plan (mirrors the real Planner for a CODE_IMPLEMENTATION intent).
          return {
            id: 'plan-int-1',
            goal: req.goal,
            summary: req.goal,
            overallRisk: RiskLevel.HIGH,
            requiredResources: req.requiredResources ?? [],
          } as unknown as ExecutionPlan;
        },
      },
      codeGeneration: {
        async generate() {
          calls.codeGen++;
          throw new Error('codeGeneration must not run for planningOnly');
        },
        async getProposal() {
          return null;
        },
        async get() {
          return null;
        },
      },
      workspace: {
        async diff() {
          calls.workspaceDiff++;
          throw new Error('workspace.diff must not run for planningOnly');
        },
        async read() {
          calls.workspaceRead++;
          throw new Error('workspace.read must not run for planningOnly');
        },
      },
      approval: new ApprovalManager(makeStorage(), new ApprovalPolicy(new RiskPolicy())),
      patch: {
        async generate() {
          calls.patch++;
          throw new Error('patch must not run for planningOnly');
        },
      },
      workspaceWrite: {
        async apply() {
          calls.write++;
          throw new Error('workspaceWrite must not run for planningOnly');
        },
      },
      command: {
        async run() {
          calls.command++;
          throw new Error('command must not run for planningOnly');
        },
      },
      logger,
    });

    const request: ExecutionRequest = {
      goal: 'preview docs/uat/github-app-auth-smoke.md',
      instruction: 'preview docs/uat/github-app-auth-smoke.md',
      requiredCapabilities: [Capability.CODE_IMPLEMENTATION],
      requestedBy: 'u1',
      targetFiles: ['docs/uat/github-app-auth-smoke.md'], // a NEW file (does not exist)
      planningOnly: true,
    };

    const outcome = await orchestrator.run(request);

    expect(outcome.status).toBe(ExecutionOutcomeStatus.AWAITING_APPROVAL);
    expect(calls.plan).toBe(1); // real planning ran
    expect(calls.codeGen).toBe(0); // no pre-approval code generation / file read
    expect(calls.workspaceDiff).toBe(0);
    expect(calls.workspaceRead).toBe(0); // no pre-approval codegen context read (QA-012)
    expect(calls.patch).toBe(0);
    expect(calls.write).toBe(0); // no workspace mutation
    expect(calls.command).toBe(0);
    expect(outcome.refs.approvalRef?.id).toBeTruthy(); // a real PENDING approval was persisted
  });
});
