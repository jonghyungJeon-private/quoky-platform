import { Capability, RiskLevel } from '../domain';
import type { Intent } from '../domain';

/**
 * Deterministic risk policy. This is configuration/policy, not AI cognition,
 * so it is implemented in v1. The Planner/Orchestrator consult it to decide
 * whether the approval gate applies.
 *
 *   LOW      chat, summary, explanation, document analysis, read-only lookup
 *   MEDIUM   local test execution, local file gen
 *   HIGH     code implementation (ADR-0035 — precursor to mutation), git commit/push/PR,
 *            Jira/Slack/Confluence write (not in v1)
 *   CRITICAL deploy, DB migration, destructive shell, force push, secret access
 */
export class RiskPolicy {
  /** Baseline risk implied by a capability (before per-operation escalation). */
  private static readonly CAPABILITY_RISK: Record<Capability, RiskLevel> = {
    [Capability.GENERAL_CHAT]: RiskLevel.LOW,
    [Capability.POLICY_SENSITIVE_CHAT]: RiskLevel.LOW,
    [Capability.SUMMARIZATION]: RiskLevel.LOW,
    [Capability.DOCUMENT_ANALYSIS]: RiskLevel.LOW,
    [Capability.READONLY_LOOKUP]: RiskLevel.LOW,
    [Capability.PROJECT_ANALYSIS]: RiskLevel.LOW,
    [Capability.EMBEDDING]: RiskLevel.LOW,
    // ADR-0111: reading an attached image is read-only analysis.
    [Capability.IMAGE_UNDERSTANDING]: RiskLevel.LOW,
    [Capability.ARCHITECTURE_PLANNING]: RiskLevel.LOW,
    [Capability.CODE_REVIEW]: RiskLevel.LOW,
    // HIGH by default (ADR-0035): even a suggest-only or planning-stage code-change request is a
    // precursor to mutation — this is the policy lever that forces the Approval gate to halt.
    [Capability.CODE_IMPLEMENTATION]: RiskLevel.HIGH,
    [Capability.TEST_EXECUTION]: RiskLevel.MEDIUM,
  };

  /** Command patterns that escalate risk regardless of capability. */
  private static readonly CRITICAL_PATTERNS: RegExp[] = [
    /\brm\s+-rf?\b/,
    /\bgit\s+push\b.*(--force|-f)\b/,
    /\bgit\s+push\s+--force/,
    /\bdrop\s+(table|database)\b/i,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /:\(\)\s*\{.*\};:/, // fork bomb
  ];
  private static readonly HIGH_PATTERNS: RegExp[] = [
    /\bgit\s+commit\b/,
    /\bgit\s+push\b/,
    /\bgh\s+pr\s+create\b/,
    /\bnpm\s+publish\b/,
    /\bdeploy\b/,
  ];

  assessIntent(intent: Intent): RiskLevel {
    return RiskPolicy.CAPABILITY_RISK[intent.capability];
  }

  assessCapability(capability: Capability): RiskLevel {
    return RiskPolicy.CAPABILITY_RISK[capability];
  }

  /**
   * Assess a concrete shell command. Local commands default to MEDIUM; known
   * external-impact / destructive patterns escalate to HIGH / CRITICAL.
   */
  assessCommand(command: string): RiskLevel {
    if (RiskPolicy.CRITICAL_PATTERNS.some((p) => p.test(command))) return RiskLevel.CRITICAL;
    if (RiskPolicy.HIGH_PATTERNS.some((p) => p.test(command))) return RiskLevel.HIGH;
    return RiskLevel.MEDIUM;
  }

  /** HIGH and CRITICAL require explicit human approval before running. */
  requiresApproval(level: RiskLevel): boolean {
    return level === RiskLevel.HIGH || level === RiskLevel.CRITICAL;
  }

  /** Pick the most severe of several risk levels. */
  max(...levels: RiskLevel[]): RiskLevel {
    const order = [RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL];
    return levels.reduce((acc, l) => (order.indexOf(l) > order.indexOf(acc) ? l : acc), RiskLevel.LOW);
  }
}
