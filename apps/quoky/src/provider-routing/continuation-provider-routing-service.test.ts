import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORITY_SENSITIVE,
  Capability,
  ContinuationProviderRoutingService,
  GENERAL_CHAT,
  IntentType,
  ProviderExecutionPlanner,
  ProviderRoutingGateway,
  RuntimeResponseValidator,
  ValidationProfileRegistry,
  RoutingRequestType,
  createDefaultValidationProfileRegistry,
} from '@quoky/core';
import type {
  AiExecutionResult,
  AiProvider,
  AiRequest,
  ProviderExecutionPlan,
  RoutingContext,
} from '@quoky/core';
import { snapshotReceiverOutcome } from '../../../../packages/core/src/application/continuation-receiver-validation';
import { AiProviderError } from '../../../../packages/core/src/errors';
import { AiFailureKind } from '../../../../packages/core/src/domain';
import {
  BALANCED_PROVIDER_ID,
  OLLAMA_ADAPTER_ID,
  ProviderCandidateRole,
  SEMANTIC_PROVIDER_ID,
  buildProductionProviderRoutingConfiguration,
} from './production-provider-routing-config';
import type { ProductionProviderDefinition } from './production-provider-routing-config';

/** Fake AiProvider: offline only. Never spawns; controllable availability + response. */
class FakeProvider implements AiProvider {
  readonly capabilities = [];
  availabilityCalls = 0;
  executionCalls = 0;
  lastRequest?: AiRequest;
  constructor(
    readonly id: string,
    private readonly behaviour: {
      available?: boolean;
      response?: string;
      throwKind?: AiFailureKind;
    } = {},
  ) {}
  async isAvailable(): Promise<boolean> {
    this.availabilityCalls += 1;
    return this.behaviour.available ?? true;
  }
  async execute(_request: AiRequest): Promise<AiExecutionResult> {
    this.executionCalls += 1;
    this.lastRequest = _request;
    if (this.behaviour.throwKind) throw new AiProviderError(this.behaviour.throwKind, 'fake failure');
    return { text: this.behaviour.response ?? 'A concise continuation answer.' };
  }
}

function config(behaviour: {
  balanced?: ConstructorParameters<typeof FakeProvider>[1];
  semantic?: ConstructorParameters<typeof FakeProvider>[1];
} = {}, reverse = false) {
  const balanced = new FakeProvider(BALANCED_PROVIDER_ID, behaviour.balanced);
  const semantic = new FakeProvider(SEMANTIC_PROVIDER_ID, behaviour.semantic);
  const definitions: readonly [ProductionProviderDefinition, ProductionProviderDefinition] = [
    {
      providerId: BALANCED_PROVIDER_ID,
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'llama3.1:8b',
      candidateRole: ProviderCandidateRole.BALANCED_PRIMARY,
      provider: balanced,
    },
    {
      providerId: SEMANTIC_PROVIDER_ID,
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'granite3.3:8b',
      candidateRole: ProviderCandidateRole.SEMANTIC_CANDIDATE,
      provider: semantic,
    },
  ];
  return { built: buildProductionProviderRoutingConfiguration(reverse ? [...definitions].reverse() : definitions), balanced, semantic };
}

function service(built: ReturnType<typeof config>['built'], planner?: ProviderExecutionPlanner, clock?: { nowMs(): number },
  dispatchCommit: { commit(taskRunId: string, executionId: string): Promise<never> } = { async commit() { return {} as never; } }) {
  return new ContinuationProviderRoutingService({
    providerRegistry: built.providerRegistry,
    policyEngine: built.policyEngine,
    bindings: built.executableBindings,
    validationProfiles: built.validationProfiles,
    configurationVersion: built.version,
    configurationDigest: built.configurationDigest,
    dispatchCommit,
    ...(planner ? { planner } : {}),
    ...(clock ? { clock } : {}),
  });
}

const facts = { capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT };
const request = (): AiRequest => ({ capability: Capability.GENERAL_CHAT, prompt: '# System\nYou are Quoky.\n\n# Task\nAnswer.' });
const executionId = 'task-run-1';

describe('ContinuationProviderRoutingService (R2)', () => {
  it('commits after PRIMARY_ONLY planning and before the ordinary Provider effect', async () => {
    const { built, balanced } = config();
    let committed = false;
    const commit = vi.fn(async (runId: string, exactId: string) => {
      expect(runId).toBe(exactId);
      committed = true;
      return {} as never;
    });
    const original = balanced.execute.bind(balanced);
    vi.spyOn(balanced, 'execute').mockImplementation(async request => {
      expect(committed).toBe(true);
      return original(request);
    });
    const result = await service(built, undefined, undefined, { commit }).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('ACCEPTED');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(balanced.executionCalls).toBe(1);
  });

  it('does not invoke the ordinary Provider after a failed dispatch commit', async () => {
    const { built, balanced, semantic } = config();
    const commit = vi.fn(async () => { throw new Error('storage unavailable'); });
    const result = await service(built, undefined, undefined, { commit }).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('FAILED');
    expect(result.audit.dispatchEvidence).toBe('NOT_DISPATCHED');
    expect(balanced.executionCalls + semantic.executionCalls).toBe(0);
  });
  it('resolves AUTHORITY_SENSITIVE at construction; missing profile fails closed (§10)', () => {
    const { built } = config();
    expect(() => service(built)).not.toThrow();
    const registryWithoutAuthority = new ValidationProfileRegistry(
      createDefaultValidationProfileRegistry().all().filter((p) => p.profileId !== AUTHORITY_SENSITIVE),
    );
    const gateway = vi.spyOn(ProviderRoutingGateway.prototype, 'execute');
    try {
      expect(() => service({ ...built, validationProfiles: registryWithoutAuthority })).toThrow('Unknown validation profile');
      expect(gateway).not.toHaveBeenCalled();
    } finally { gateway.mockRestore(); }
  });

  it('accepts a validated Provider return → ACCEPTED with exact-run executionId (§23/§26)', async () => {
    const { built, balanced, semantic } = config();
    const result = await service(built).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('ACCEPTED');
    expect(result.output?.text).toContain('continuation answer');
    expect(result.audit.executionId).toBe(executionId);
    expect(result.audit.terminalStatus).toBe('ACCEPTED');
    expect(result.audit.dispatchEvidence).toBe('RETURNED');
    expect(result.audit.attemptCountKnown).toBe(true);
    expect(result.audit.attemptCount).toBe(1);
    expect(result.audit.finalAcceptedProviderId).toBe(BALANCED_PROVIDER_ID);
    expect(result.acceptedProviderId).toBe(BALANCED_PROVIDER_ID);
    expect(result.audit.matchedPolicyId).toBe('stage2b-continuation-general-chat-v1');
    // Primary-only: only the BALANCED provider is ever executed.
    expect(balanced.executionCalls).toBe(1);
    expect(semantic.executionCalls).toBe(0);
  });

  it('is PRIMARY-ONLY: audit path attempts are all PRIMARY and never escalate', async () => {
    const { built } = config();
    const result = await service(built).execute({ facts, request: request(), executionId });
    expect(result.audit.attempts.every((attempt) => attempt.path === 'PRIMARY')).toBe(true);
  });

  it('enforces primary-only in code: a planner yielding a fallback → PRE_DISPATCH_FAILED, 0 executions (§9)', async () => {
    const { built, balanced, semantic } = config();
    // Force a plan that carries an operationalFallback to prove code-level rejection.
    const forcingPlanner: ProviderExecutionPlanner = {
      create(...args: Parameters<ProviderExecutionPlanner['create']>): ProviderExecutionPlan {
        const plan = new ProviderExecutionPlanner().create(...args);
        return Object.freeze({
          ...plan,
          operationalFallback: Object.freeze({
            purpose: plan.primary.purpose === 'PRIMARY' ? ('FALLBACK' as never) : plan.primary.purpose,
            providerId: SEMANTIC_PROVIDER_ID,
            bindingIdentity: plan.primary.bindingIdentity,
          }),
        }) as ProviderExecutionPlan;
      },
    } as ProviderExecutionPlanner;
    const result = await service(built, forcingPlanner).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('FAILED');
    expect(result.audit.terminalStatus).toBe('PRE_DISPATCH_FAILED');
    expect(result.audit.terminalCode).toBe('PRE_DISPATCH_FAILED');
    expect(result.audit.dispatchEvidence).toBe('NOT_DISPATCHED');
    expect(result.audit.attemptCount).toBe(0);
    expect(balanced.executionCalls).toBe(0);
    expect(semantic.executionCalls).toBe(0);
  });

  it('unsupported facts (capability/intent) → definite pre-dispatch FAILED (§8)', async () => {
    const { built } = config();
    const svc = service(built);
    const bad = await svc.execute({
      facts: { capability: Capability.CODE_IMPLEMENTATION, intentType: IntentType.CHAT },
      request: { capability: Capability.CODE_IMPLEMENTATION, prompt: 'x' },
      executionId,
    });
    expect(bad.disposition).toBe('FAILED');
    expect(bad.audit.terminalStatus).toBe('PRE_DISPATCH_FAILED');
    expect(bad.audit.dispatchEvidence).toBe('NOT_DISPATCHED');
  });

  it('no eligible provider (all unavailable) → definite pre-dispatch FAILED', async () => {
    const { built, balanced } = config({ balanced: { available: false }, semantic: { available: false } });
    const result = await service(built).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('FAILED');
    expect(result.audit.terminalStatus).toBe('PRE_DISPATCH_FAILED');
    expect(result.audit.terminalCode).toBe('NO_ELIGIBLE_PROVIDER');
    expect(balanced.executionCalls).toBe(0);
  });

  it('post-dispatch TIMEOUT → UNRESOLVED (dispatched, uncertain) (§23)', async () => {
    const { built } = config({ balanced: { throwKind: AiFailureKind.TIMEOUT } });
    const result = await service(built).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('UNRESOLVED');
    expect(result.audit.dispatchEvidence).toBe('DISPATCHED');
    expect(result.audit.executionId).toBe(executionId);
  });

  it('post-dispatch EXECUTION_FAILED → UNRESOLVED (§23)', async () => {
    const { built } = config({ balanced: { throwKind: AiFailureKind.EXECUTION_FAILED } });
    const result = await service(built).execute({ facts, request: request(), executionId });
    expect(result.disposition).toBe('UNRESOLVED');
    expect(result.audit.dispatchEvidence).toBe('DISPATCHED');
  });

  it('validation rejection after a return → FAILED (§23)', async () => {
    // A response that exactly echoes the prompt triggers PROMPT_LEAK → REJECT (safety) → FAILED.
    const leaky = '# System\nYou are Quoky.\n\n# Task\nAnswer.';
    const { built } = config({ balanced: { response: leaky } });
    const req: AiRequest = { capability: Capability.GENERAL_CHAT, prompt: leaky };
    const result = await service(built).execute({ facts, request: req, executionId });
    expect(result.disposition).toBe('FAILED');
    expect(result.audit.dispatchEvidence).toBe('RETURNED');
    expect(result.audit.terminalStatus).not.toBe('ACCEPTED');
    expect(result.audit.finalAcceptedProviderId).toBeNull();
  });

  it('builds a routing context with WORK request type and AUTHORITY_SENSITIVE profile (§8)', () => {
    // Policy separation: the continuation (WORK) context matches ONLY the continuation policy, and the
    // conversation (CONVERSATIONAL) context matches ONLY the chat policy.
    const { built } = config();
    const snapshot = built.providerRegistry.snapshot({
      [BALANCED_PROVIDER_ID]: 'AVAILABLE' as never,
      [SEMANTIC_PROVIDER_ID]: 'AVAILABLE' as never,
    });
    const continuationContext: RoutingContext = {
      capability: Capability.GENERAL_CHAT,
      requestType: RoutingRequestType.WORK,
      intentType: IntentType.CHAT,
      semanticRisk: 'STANDARD' as never,
      latencyClass: 'BALANCED' as never,
      toolUseRequirement: 'NOT_REQUIRED' as never,
      authorityRequirement: 'NOT_REQUIRED' as never,
      continuityRequirement: 'NOT_REQUIRED' as never,
      expectedOutputSize: 'MEDIUM' as never,
      validationProfile: AUTHORITY_SENSITIVE,
    };
    const conversationContext: RoutingContext = {
      ...continuationContext,
      requestType: RoutingRequestType.CONVERSATIONAL,
      validationProfile: GENERAL_CHAT,
    };
    expect(built.policyEngine.select(continuationContext, snapshot).matchedPolicyId).toBe(
      'stage2b-continuation-general-chat-v1',
    );
    expect(built.policyEngine.select(conversationContext, snapshot).matchedPolicyId).toBe(
      'stage2b-general-chat-v1',
    );
  });

  it('configuration digest is deterministic and binds both validation profiles (§11)', () => {
    const first = config().built.configurationDigest;
    const second = config().built.configurationDigest;
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('R2 remediation regressions', () => {
  it('Provider executes once then a Gateway clock escape becomes UNRESOLVED / UNKNOWN', async () => {
    const { built, balanced } = config();
    const clock = { nowMs: () => {
      if (balanced.executionCalls > 0) throw new Error('post-provider clock failure');
      return 0;
    } };
    const result = await service(built, undefined, clock).execute({ facts, request: request(), executionId });
    expect(balanced.executionCalls).toBe(1);
    expect(result.disposition).toBe('UNRESOLVED');
    expect(snapshotReceiverOutcome({ disposition: 'UNRESOLVED', reason: 'EXECUTION_UNCERTAIN',
      routingAudit: result.audit }, executionId)).not.toBeNull();
    expect(result.audit).toMatchObject({
      terminalStatus: 'EXECUTION_FAILED', terminalCode: null, dispatchEvidence: 'UNKNOWN',
      attemptCountKnown: false, attemptCount: null, attempts: [],
    });
  });

  it('semantic escalation alone rejects before Gateway invocation', async () => {
    const { built, balanced } = config();
    const planner = { create(...args: Parameters<ProviderExecutionPlanner['create']>) {
      const plan = new ProviderExecutionPlanner().create(...args);
      return { ...plan, operationalFallback: null, semanticEscalation: plan.primary };
    } } as ProviderExecutionPlanner;
    const gateway = vi.spyOn(ProviderRoutingGateway.prototype, 'execute');
    try {
      const result = await service(built, planner).execute({ facts, request: request(), executionId });
      expect(result.audit.terminalStatus).toBe('PRE_DISPATCH_FAILED');
      expect(gateway).not.toHaveBeenCalled();
      expect(balanced.executionCalls).toBe(0);
    } finally { gateway.mockRestore(); }
  });

  it('registration insertion order does not change the production digest', () => {
    expect(config({}, true).built.configurationDigest).toBe(config().built.configurationDigest);
  });

  it('three validator-only entries reach the real validator but never Provider contextFiles', async () => {
    const corpus = ['Private directive number one with sufficient length.',
      'Private directive number two with sufficient length.',
      'Private directive number three with sufficient length.'];
    const { built, balanced } = config({ balanced: { response: corpus.join('\n') } });
    const validator = vi.spyOn(RuntimeResponseValidator.prototype, 'validate');
    try {
      const result = await service(built).execute({
        facts, request: request(), executionId, validationFacts: { contextCorpus: corpus },
      });
      expect(balanced.executionCalls).toBe(1);
      expect(balanced.lastRequest?.contextFiles).toBeUndefined();
      expect(balanced.lastRequest?.prompt).not.toContain(corpus[0]);
      expect(validator).toHaveBeenCalledWith(expect.objectContaining({ contextCorpus: corpus }));
      expect(result.disposition).toBe('FAILED');
      expect(result.audit.attempts[0]?.validationReasonCodes).toContain('MULTI_ENTRY_ECHO');
    } finally { validator.mockRestore(); }
  });
});
