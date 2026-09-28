import type { BoundLocalContinuitySelection, BoundLocalContinuitySelectionIssuer } from './bound-local-continuity-selection';
import type { PreparedContainmentExecution } from './continuation-prepared-containment';
import type { ProviderDispatchCommitCoordinator } from './provider-dispatch-commit-coordinator';
import { LocalContinuityConsumptionCoordinator } from './local-continuity-consumption-coordinator';
import { createHash } from 'node:crypto';
import type { ProviderExecutionPlan } from './provider-execution-plan';
import { continuationRoutingContext, type ContinuationRoutingFacts } from './continuation-routing-context';
export type { ContinuationRoutingFacts } from './continuation-routing-context';
import { Capability } from '../domain';
import type { AiRequest } from '../ports';
import type {
  ContinuationDispatchEvidence,
  ContinuationRoutingAttempt,
  ContinuationRoutingAudit,
  ContinuationRoutingCode,
  ContinuationRoutingStatus,
  ContinuationValidationReason,
} from '../ports';
import {
  DEFAULT_PROVIDER_DEADLINE_POLICY,
  SYSTEM_MONOTONIC_CLOCK,
  type MonotonicClock,
  type ProviderDeadlinePolicy,
} from './deadline-policy';
import {
  type ExecutableProviderBinding,
  ProviderBindingRegistry,
} from './provider-binding-registry';
import { DeadlineClass, ProviderExecutionPlanError, ProviderExecutionPlanner } from './provider-execution-plan';
import { ProviderRegistry } from './provider-registry';
import {
  ProviderAttemptOutcome,
  ProviderGatewayTerminalStatus,
  ProviderRoutingGateway,
  type ProviderAttemptAudit,
  type ProviderGatewayResult,
  type ProviderRoutingValidationFacts,
} from './provider-routing-gateway';
import {
  ProviderAvailability,
  type ProviderId,
  type ProviderSelectionDecision,
  RoutingReasonCode,
} from './provider-routing-contracts';
import { RoutingPolicyEngine } from './routing-policy-engine';
import {
  type BoundedProviderOutput,
  RoutingFailureCode,
  ValidationDisposition,
} from './runtime-response-validation-contracts';
import { AUTHORITY_SENSITIVE, type ValidationProfileRegistry } from './validation-profile-registry';

/**
 * R2 ContinuationProviderRoutingService (§4/§5, ADR-0089). A Core Application SIBLING of
 * RuntimeProviderRoutingService — NOT a wrapper/import dependency on it, and NOT a CapabilityRouter
 * or direct AiProvider caller. It reuses the existing Stage2B primitives (ProviderRegistry,
 * ProviderBindingRegistry, RoutingPolicyEngine, ProviderExecutionPlanner, ProviderRoutingGateway,
 * ValidationProfileRegistry, deadline policy) and owns ONLY continuation-specific orchestration:
 * fixed WORK/CHAT/AUTHORITY_SENSITIVE routing facts, primary-only enforcement, and mapping Stage2B
 * routing evidence into the bounded ContinuationRoutingAudit port DTO.
 *
 * It never assumes handoff objective == currentUserTurn and inherits no ConversationRuntime semantics.
 */

export interface ContinuationProviderRoutingRequest {
  /** C2C-1 test-only contained consumption; no generic gateway effect. */
  readonly localContinuity?: Readonly<{ selection: BoundLocalContinuitySelection; plan: ProviderExecutionPlan;
    preparedExecution: PreparedContainmentExecution }>;
  readonly facts: ContinuationRoutingFacts;
  readonly request: AiRequest;
  readonly validationFacts?: ProviderRoutingValidationFacts;
  /** Exact TaskRun identity. ContinuationRoutingAudit.executionId MUST equal this (§26). */
  readonly executionId: string;
}

/** Ratified disposition class derived from per-attempt/dispatch evidence, not final status alone (§23). */
export type ContinuationRoutingDisposition = 'ACCEPTED' | 'FAILED' | 'UNRESOLVED';

export interface ContinuationProviderRoutingResult {
  readonly disposition: ContinuationRoutingDisposition;
  /** Present only for an accepted, validated Gateway output. */
  readonly output?: BoundedProviderOutput;
  /** Present only for an accepted output; equals audit.finalAcceptedProviderId. */
  readonly acceptedProviderId?: string;
  readonly audit: ContinuationRoutingAudit;
}

export interface ContinuationProviderRouting {
  execute(input: ContinuationProviderRoutingRequest): Promise<ContinuationProviderRoutingResult>;
}

export interface ContinuationProviderRoutingConfiguration {
  readonly localContinuityIssuer?: BoundLocalContinuitySelectionIssuer;
  readonly dispatchCommit?: Pick<ProviderDispatchCommitCoordinator, 'commit'>;
  readonly providerRegistry: ProviderRegistry;
  readonly policyEngine: RoutingPolicyEngine;
  readonly bindings: readonly ExecutableProviderBinding[];
  readonly validationProfiles: ValidationProfileRegistry;
  readonly configurationVersion: string;
  readonly configurationDigest: string;
  readonly planner?: ProviderExecutionPlanner;
  readonly deadlinePolicy?: ProviderDeadlinePolicy;
  readonly clock?: MonotonicClock;
}

const HEX64 = /^[a-f0-9]{64}$/;

const GATEWAY_TO_CONTINUATION_STATUS: Readonly<Record<ProviderGatewayTerminalStatus, ContinuationRoutingStatus>> =
  Object.freeze({
    [ProviderGatewayTerminalStatus.ACCEPTED]: 'ACCEPTED',
    [ProviderGatewayTerminalStatus.REJECTED]: 'REJECTED',
    [ProviderGatewayTerminalStatus.HUMAN_REVIEW_REQUIRED]: 'HUMAN_REVIEW_REQUIRED',
    [ProviderGatewayTerminalStatus.EXECUTION_FAILED]: 'EXECUTION_FAILED',
    [ProviderGatewayTerminalStatus.SAFETY_BLOCKED]: 'SAFETY_BLOCKED',
    [ProviderGatewayTerminalStatus.CONFIGURATION_FAILED]: 'CONFIGURATION_FAILED',
  });

const ROUTING_CODES = new Set<string>([
  'ROUTING_CONFIGURATION_MISMATCH', 'BINDING_MISMATCH', 'PROVIDER_BINDING_NOT_FOUND', 'PROVIDER_DISABLED',
  'UNKNOWN_VALIDATION_PROFILE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_TIMEOUT',
  'PROVIDER_EXECUTION_FAILED', 'PROVIDER_SPAWN_FAILED', 'EMPTY_OUTPUT', 'OUTPUT_LIMIT_VIOLATION',
  'STRUCTURAL_VALIDATION_FAILED', 'SEMANTIC_VALIDATION_FAILED', 'SEMANTIC_VALIDATION_UNRESOLVED',
  'STRUCTURAL_VALIDATION_UNRESOLVED', 'DEADLINE_EXHAUSTED', 'PROMPT_LEAK', 'MULTI_ENTRY_ECHO',
  'SECRET_EXPOSURE_RISK', 'CONTAINMENT_FAILURE', 'MODEL_DOWNLOAD_DETECTED', 'VALIDATOR_INTERNAL_FAILURE',
  'INVALID_PROVIDER_BINDING', 'DUPLICATE_PROVIDER_BINDING', 'UNKNOWN_PROVIDER_BINDING', 'PROVIDER_BINDING_MISMATCH',
]);

/** Only surface a bounded ContinuationRoutingCode; never leak an unmapped/foreign code (fail closed to null). */
function toContinuationCode(code: string | null): ContinuationRoutingCode | null {
  if (code === null) return null;
  return ROUTING_CODES.has(code) ? (code as ContinuationRoutingCode) : null;
}

const VALIDATION_REASONS = new Set<string>([
  'EMPTY_OUTPUT', 'OUTPUT_LIMIT_VIOLATION', 'PROMPT_LEAK', 'MULTI_ENTRY_ECHO', 'SECRET_EXPOSURE_RISK',
  'RECENCY_GROUNDING_VIOLATION', 'AUTHORITY_SCOPE_VIOLATION', 'VALIDATOR_INTERNAL_FAILURE',
]);

function toValidationReasons(codes: readonly string[]): readonly ContinuationValidationReason[] {
  const seen = new Set<string>();
  const out: ContinuationValidationReason[] = [];
  for (const code of codes) {
    if (VALIDATION_REASONS.has(code) && !seen.has(code)) {
      seen.add(code);
      out.push(code as ContinuationValidationReason);
    }
  }
  return Object.freeze(out);
}

function toDisposition(disposition: ValidationDisposition | null): 'ACCEPT' | 'ESCALATE' | 'REJECT' | null {
  if (disposition === ValidationDisposition.ACCEPT) return 'ACCEPT';
  if (disposition === ValidationDisposition.ESCALATE) return 'ESCALATE';
  if (disposition === ValidationDisposition.REJECT) return 'REJECT';
  return null;
}

type Transition = Readonly<{ sequence: number; evidence: ContinuationDispatchEvidence; code: ContinuationRoutingCode | null }>;

/**
 * Deterministic, offline-ready sibling of the Runtime seam. Owns neither prompt authorship,
 * persistence, response wording, adapter construction, nor startup activation.
 */
export class ContinuationProviderRoutingService implements ContinuationProviderRouting {
  private readonly localConsumption?: LocalContinuityConsumptionCoordinator;
  private readonly dispatchCommit?: Pick<ProviderDispatchCommitCoordinator, 'commit'>;
  private readonly providerRegistry: ProviderRegistry;
  private readonly policyEngine: RoutingPolicyEngine;
  private readonly bindings: readonly ExecutableProviderBinding[];
  private readonly validationProfiles: ValidationProfileRegistry;
  private readonly configurationVersion: string;
  private readonly configurationDigest: string;
  private readonly planner: ProviderExecutionPlanner;
  private readonly deadlinePolicy: ProviderDeadlinePolicy;
  private readonly clock: MonotonicClock;

  constructor(configuration: ContinuationProviderRoutingConfiguration) {
    this.dispatchCommit = configuration.dispatchCommit;
    this.providerRegistry = configuration.providerRegistry;
    this.policyEngine = configuration.policyEngine;
    this.bindings = Object.freeze(configuration.bindings.map((binding) => Object.freeze({ ...binding })));
    this.validationProfiles = configuration.validationProfiles;
    this.configurationVersion = configuration.configurationVersion;
    this.configurationDigest = configuration.configurationDigest;
    this.planner = configuration.planner ?? new ProviderExecutionPlanner();
    this.deadlinePolicy = configuration.deadlinePolicy ?? DEFAULT_PROVIDER_DEADLINE_POLICY;
    this.clock = configuration.clock ?? SYSTEM_MONOTONIC_CLOCK;

    // Construction validation only (descriptor/binding/profile). No availability probe, no execution.
    new ProviderBindingRegistry(configuration.providerRegistry.snapshot(), this.bindings);
    if (configuration.localContinuityIssuer && configuration.dispatchCommit) {
      this.localConsumption = new LocalContinuityConsumptionCoordinator(
        configuration.localContinuityIssuer, configuration.providerRegistry, configuration.policyEngine,
        new ProviderBindingRegistry(configuration.providerRegistry.snapshot(), this.bindings),
        this.clock, configuration.dispatchCommit,
      );
    }
    // AUTHORITY_SENSITIVE must be resolvable at construction; missing profile fails closed (§10).
    configuration.validationProfiles.resolve(AUTHORITY_SENSITIVE);
  }

  async execute(input: ContinuationProviderRoutingRequest): Promise<ContinuationProviderRoutingResult> {
    const routingContext = continuationRoutingContext(input.facts);
    if (routingContext === null || input.request.capability !== Capability.GENERAL_CHAT) {
      return this.preDispatchFailed(input.executionId, null, 'ROUTING_CONFIGURATION_MISMATCH');
    }

    let decision: ProviderSelectionDecision | null = null;
    let gatewayInvoked = false;
    try {
      if (input.localContinuity !== undefined) {
        if (!this.localConsumption) {
          return this.preDispatchFailed(input.executionId, null, 'PRE_DISPATCH_FAILED');
        }
        const consumed = await this.localConsumption.consume({
          authority: input.localContinuity.selection,
          preparedExecution: input.localContinuity.preparedExecution,
          plan: input.localContinuity.plan,
          context: routingContext,
          routingExecutionId: input.executionId,
          effectInput: { prompt: input.request.prompt },
        });
        // consume returns only after a successful dispatch commit. Preserve uncertainty if audit mapping fails.
        gatewayInvoked = true;
        return this.mapLocalResult(input.executionId, input.localContinuity.selection.providerId, consumed);
      }
      const availabilityEntries = await Promise.all(
        this.bindings.map(async (binding): Promise<readonly [ProviderId, ProviderAvailability]> => {
          let available = false;
          try {
            available = (await binding.provider.isAvailable()) === true;
          } catch {
            available = false;
          }
          return Object.freeze([
            binding.providerId,
            available ? ProviderAvailability.AVAILABLE : ProviderAvailability.UNAVAILABLE,
          ] as const);
        }),
      );
      const availability = Object.freeze(Object.fromEntries(availabilityEntries));
      const snapshot = this.providerRegistry.snapshot(availability);
      const bindingRegistry = new ProviderBindingRegistry(snapshot, this.bindings);
      decision = this.policyEngine.select(routingContext, snapshot);

      if (decision.reasonCode === RoutingReasonCode.POLICY_NOT_MATCHED) {
        return this.preDispatchFailed(input.executionId, decision, 'POLICY_NOT_MATCHED');
      }
      if (decision.reasonCode === RoutingReasonCode.NO_ELIGIBLE_PROVIDER) {
        return this.preDispatchFailed(input.executionId, decision, 'NO_ELIGIBLE_PROVIDER');
      }

      const plan = this.planner.create(decision, snapshot, bindingRegistry, this.validationProfiles, {
        capability: Capability.GENERAL_CHAT,
        validationProfile: AUTHORITY_SENSITIVE,
        deadlineClass: DeadlineClass.STANDARD,
        executionId: input.executionId,
      });

      // §9 PRIMARY-ONLY enforced in code: any planned fallback/escalation is a pre-dispatch failure
      // and the Gateway is NEVER invoked (0 executions). Not reliant on today's provider inventory.
      if (plan.operationalFallback !== null || plan.semanticEscalation !== null) {
        return this.preDispatchFailed(input.executionId, decision, 'PRE_DISPATCH_FAILED');
      }

      if (!this.dispatchCommit) return this.preDispatchFailed(input.executionId, decision, 'PRE_DISPATCH_FAILED');

      const gateway = new ProviderRoutingGateway(
        bindingRegistry,
        this.validationProfiles,
        this.deadlinePolicy,
        this.clock,
      );
      await this.dispatchCommit.commit(input.executionId, input.executionId);
      gatewayInvoked = true;
      const result = await gateway.execute(plan, input.request, input.validationFacts ?? {});
      return this.mapGatewayResult(input.executionId, decision, result);
    } catch (error) {
      // Crossing the invocation boundary means dispatch can no longer be disproved.
      if (gatewayInvoked) {
        return Object.freeze({
          disposition: 'UNRESOLVED',
          audit: this.buildAudit({
            executionId: input.executionId, decision, terminalStatus: 'EXECUTION_FAILED',
            terminalCode: null, attemptCount: null, attemptCountKnown: false, attempts: [],
            finalAcceptedProviderId: null, dispatchEvidence: 'UNKNOWN',
            transitions: [Object.freeze({ sequence: 1, evidence: 'UNKNOWN', code: null })],
          }),
        });
      }
      const code: ContinuationRoutingCode = error instanceof ProviderExecutionPlanError
        ? toContinuationCode(error.code) ?? 'PRE_DISPATCH_FAILED'
        : 'PRE_DISPATCH_FAILED';
      return this.preDispatchFailed(input.executionId, decision, code);
    }
  }

  private mapLocalResult(
    executionId: string,
    providerId: string,
    result: Awaited<ReturnType<LocalContinuityConsumptionCoordinator['consume']>>,
  ): ContinuationProviderRoutingResult {
    if (result.disposition === 'EFFECT_UNRESOLVED') {
      return Object.freeze({ disposition: 'UNRESOLVED', audit: this.buildAudit({
        executionId, decision: null, terminalStatus: 'UNKNOWN', terminalCode: null,
        attemptCount: 1, attemptCountKnown: true,
        attempts: [Object.freeze({ index: 1, path: 'PRIMARY', providerId, outcome: 'UNKNOWN',
          failureCode: null, validationDisposition: null, validationReasonCodes: [],
          responseSha256: null, byteCount: null, durationMs: 0, dispatchEvidence: 'UNKNOWN' })],
        finalAcceptedProviderId: null, dispatchEvidence: 'UNKNOWN',
        transitions: [Object.freeze({ sequence: 1, evidence: 'DISPATCHED', code: null }),
          Object.freeze({ sequence: 2, evidence: 'UNKNOWN', code: null })],
      }) });
    }
    const text = result.output.text;
    const responseSha256 = createHash('sha256').update(text).digest('hex');
    const byteCount = Buffer.byteLength(text);
    const audit = this.buildAudit({
      executionId, decision: null, terminalStatus: 'ACCEPTED', terminalCode: null,
      attemptCount: 1, attemptCountKnown: true,
      attempts: [Object.freeze({ index: 1, path: 'PRIMARY', providerId, outcome: 'VALIDATION_ACCEPTED',
        failureCode: null, validationDisposition: 'ACCEPT', validationReasonCodes: [],
        responseSha256, byteCount, durationMs: 0, dispatchEvidence: 'RETURNED' })],
      finalAcceptedProviderId: providerId, dispatchEvidence: 'RETURNED',
      transitions: [Object.freeze({ sequence: 1, evidence: 'DISPATCHED', code: null }),
        Object.freeze({ sequence: 2, evidence: 'RETURNED', code: null })],
    });
    return Object.freeze({ disposition: 'ACCEPTED', output: Object.freeze({ text, artifacts: [],
      responseSha256, byteCount }), acceptedProviderId: providerId, audit });
  }

  /** DEFINITE pre-dispatch failure → FAILED. NOT_DISPATCHED, attemptCount 0, no attempts (§23). */
  private preDispatchFailed(
    executionId: string,
    decision: ProviderSelectionDecision | null,
    code: ContinuationRoutingCode,
  ): ContinuationProviderRoutingResult {
    const audit = this.buildAudit({
      executionId,
      decision,
      terminalStatus: 'PRE_DISPATCH_FAILED',
      terminalCode: code,
      attemptCount: 0,
      attemptCountKnown: true,
      attempts: [],
      finalAcceptedProviderId: null,
      dispatchEvidence: 'NOT_DISPATCHED',
      transitions: [Object.freeze({ sequence: 1, evidence: 'NOT_DISPATCHED', code })],
    });
    return Object.freeze({ disposition: 'FAILED', audit });
  }

  private mapGatewayResult(
    executionId: string,
    decision: ProviderSelectionDecision,
    result: ProviderGatewayResult,
  ): ContinuationProviderRoutingResult {
    const gatewayAudit = result.audit;
    const attempts = gatewayAudit.attempts.map((attempt, index) => this.mapAttempt(attempt, index));
    const dispatched = attempts.length > 0;
    const returnedAttempt = attempts.some((attempt) => attempt.dispatchEvidence === 'RETURNED');

    if (result.status === ProviderGatewayTerminalStatus.ACCEPTED && result.output !== undefined
      && gatewayAudit.finalProviderId !== null) {
      const last = attempts[attempts.length - 1];
      if (last && last.outcome === 'VALIDATION_ACCEPTED' && last.providerId === gatewayAudit.finalProviderId) {
        const audit = this.buildAudit({
          executionId,
          decision,
          terminalStatus: 'ACCEPTED',
          terminalCode: null,
          attemptCount: attempts.length as 0 | 1 | 2,
          attemptCountKnown: true,
          attempts,
          finalAcceptedProviderId: gatewayAudit.finalProviderId,
          dispatchEvidence: 'RETURNED',
          transitions: this.transitionsFor(attempts, 'RETURNED', null),
        });
        return Object.freeze({
          disposition: 'ACCEPTED',
          output: result.output,
          acceptedProviderId: gatewayAudit.finalProviderId,
          audit,
        });
      }
    }

    const terminalStatus = GATEWAY_TO_CONTINUATION_STATUS[result.status];
    const terminalCode = toContinuationCode(result.failureCode);

    // §23 DISPATCHED + TERMINATION UNCERTAIN → UNRESOLVED. Post-dispatch timeout / execution failure /
    // unavailability without proof of no side effect: a Provider was invoked but termination is
    // uncertain. Detect via operational post-dispatch codes on a dispatched attempt.
    if (dispatched && this.isPostDispatchUncertain(result.failureCode)) {
      const audit = this.buildAudit({
        executionId,
        decision,
        terminalStatus: 'EXECUTION_FAILED',
        terminalCode,
        attemptCount: attempts.length as 0 | 1 | 2,
        attemptCountKnown: true,
        attempts,
        finalAcceptedProviderId: null,
        dispatchEvidence: 'DISPATCHED',
        transitions: this.transitionsFor(attempts, 'DISPATCHED', terminalCode),
      });
      return Object.freeze({ disposition: 'UNRESOLVED', audit });
    }

    // PROVIDER RETURNED + TERMINAL VALIDATION EVIDENCE → FAILED (rejection / safety / limit after return).
    // Also any other definite terminal failure with a dispatched-but-not-uncertain attempt → FAILED.
    const dispatchEvidence: ContinuationDispatchEvidence = returnedAttempt
      ? 'RETURNED'
      : dispatched
        ? 'DISPATCHED'
        : 'NOT_DISPATCHED';
    const audit = this.buildAudit({
      executionId,
      decision,
      terminalStatus,
      terminalCode,
      attemptCount: attempts.length as 0 | 1 | 2,
      attemptCountKnown: true,
      attempts,
      finalAcceptedProviderId: null,
      dispatchEvidence,
      transitions: this.transitionsFor(attempts, dispatchEvidence, terminalCode),
    });
    return Object.freeze({ disposition: 'FAILED', audit });
  }

  /** Post-dispatch operational codes that make termination uncertain (no proof of no side effect).
   *
   * R3-A failure-mapping amendment: once an attempt has been DISPATCHED (the Provider attempt boundary
   * is crossed), a bounded CONTAINMENT_FAILURE or a post-attempt MODEL_DOWNLOAD_DETECTED can no longer be
   * treated as a definite FAILED — the execution/enforcement state is unknown, so it maps to UNRESOLVED.
   * These codes remain definite ONLY pre-dispatch (attemptCount 0 / NOT_DISPATCHED), which this method
   * never sees because callers gate it behind `dispatched`. */
  private isPostDispatchUncertain(code: string | null): boolean {
    return (
      code === RoutingFailureCode.PROVIDER_TIMEOUT ||
      code === RoutingFailureCode.PROVIDER_EXECUTION_FAILED ||
      code === RoutingFailureCode.PROVIDER_UNAVAILABLE ||
      code === RoutingFailureCode.PROVIDER_SPAWN_FAILED ||
      code === RoutingFailureCode.DEADLINE_EXHAUSTED ||
      code === RoutingFailureCode.CONTAINMENT_FAILURE ||
      code === RoutingFailureCode.MODEL_DOWNLOAD_DETECTED
    );
  }

  private mapAttempt(attempt: ProviderAttemptAudit, index: number): ContinuationRoutingAttempt {
    const outcome: ContinuationRoutingAttempt['outcome'] =
      attempt.outcome === ProviderAttemptOutcome.PROVIDER_FAILED
        ? 'PROVIDER_FAILED'
        : attempt.outcome === ProviderAttemptOutcome.VALIDATION_ACCEPTED
          ? 'VALIDATION_ACCEPTED'
          : 'VALIDATION_REJECTED';
    const dispatchEvidence: ContinuationDispatchEvidence =
      attempt.outcome === ProviderAttemptOutcome.PROVIDER_FAILED ? 'DISPATCHED' : 'RETURNED';
    return Object.freeze({
      index: (index + 1) as 1 | 2,
      path: 'PRIMARY',
      providerId: attempt.providerId,
      outcome,
      failureCode: toContinuationCode(attempt.failureCode),
      validationDisposition: toDisposition(attempt.validationDisposition),
      validationReasonCodes: toValidationReasons(attempt.validationReasonCodes),
      responseSha256: attempt.responseSha256,
      byteCount: attempt.responseByteCount,
      durationMs: attempt.durationMs,
      dispatchEvidence,
    });
  }

  private transitionsFor(
    attempts: readonly ContinuationRoutingAttempt[],
    finalEvidence: ContinuationDispatchEvidence,
    finalCode: ContinuationRoutingCode | null,
  ): readonly Transition[] {
    const transitions: { sequence: number; evidence: ContinuationDispatchEvidence; code: ContinuationRoutingCode | null }[] = [];
    let sequence = 1;
    for (const attempt of attempts) {
      transitions.push({ sequence: sequence++, evidence: 'DISPATCHED', code: null });
      if (attempt.dispatchEvidence === 'RETURNED') {
        transitions.push({ sequence: sequence++, evidence: 'RETURNED', code: attempt.failureCode });
      }
    }
    if (transitions.length === 0) {
      transitions.push({ sequence: sequence++, evidence: finalEvidence, code: finalCode });
    }
    // Cap at 7 (audit bound); keep the most recent transitions and renumber sequentially.
    const capped = transitions.slice(-7).map((transition, index) =>
      Object.freeze({ ...transition, sequence: index + 1 }));
    return Object.freeze(capped);
  }

  private buildAudit(fields: {
    executionId: string;
    decision: ProviderSelectionDecision | null;
    terminalStatus: ContinuationRoutingStatus;
    terminalCode: ContinuationRoutingCode | null;
    attemptCount: 0 | 1 | 2 | null;
    attemptCountKnown: boolean;
    attempts: readonly ContinuationRoutingAttempt[];
    finalAcceptedProviderId: string | null;
    dispatchEvidence: ContinuationDispatchEvidence;
    transitions: readonly Transition[];
  }): ContinuationRoutingAudit {
    const decision = fields.decision;
    const policyDigest = decision && HEX64.test(decision.policyConfigurationDigest)
      ? decision.policyConfigurationDigest
      : null;
    return Object.freeze({
      schemaVersion: 'continuation-routing-audit-v1',
      executionId: fields.executionId,
      matchedPolicyId: decision?.matchedPolicyId ?? null,
      policyVersion: decision?.policyVersion ?? null,
      configurationVersion: this.configurationVersion,
      policyDigest,
      configurationDigest: HEX64.test(this.configurationDigest) ? this.configurationDigest : null,
      terminalStatus: fields.terminalStatus,
      terminalCode: fields.terminalCode,
      attemptCount: fields.attemptCount,
      attemptCountKnown: fields.attemptCountKnown,
      attempts: Object.freeze([...fields.attempts]),
      finalAcceptedProviderId: fields.finalAcceptedProviderId,
      dispatchEvidence: fields.dispatchEvidence,
      transitions: Object.freeze([...fields.transitions]),
    });
  }
}
