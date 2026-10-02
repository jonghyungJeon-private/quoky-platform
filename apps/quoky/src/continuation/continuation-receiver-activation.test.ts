import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactKind,
  AgentProfileRegistry,
  CONTINUATION_PROMPT_BOUNDS,
  Capability,
  IntentType,
  PromptComposer,
  PromptRenderer,
  agentProfileId,
  createWorkHandoff,
} from '@quoky/core';
import type {
  Artifact,
  ContinuationReceiverInput,
  ExecutionPlan,
  TaskRun,
} from '@quoky/core';
import { OllamaCliProvider } from '@quoky/ai-cli';
import type { CliRunner, CliRunResult } from '@quoky/ai-cli';
import { snapshotReceiverOutcome } from '../../../../packages/core/src/application/continuation-receiver-validation';
import {
  ContinuationReceiverActivationError,
  ContinuationReceiverActivationErrorCode,
  createProductionContinuationReceiverActivation,
  createTestContinuationReceiverActivation,
  parseContinuationReceiverMode,
  minimalContinuationPromptBytes,
} from './continuation-receiver-activation';
import type { ContinuationContainment } from './continuation-receiver-activation';
import {
  BALANCED_PROVIDER_ID,
  OLLAMA_ADAPTER_ID,
  ProviderCandidateRole,
  SEMANTIC_PROVIDER_ID,
  buildProductionProviderRoutingConfiguration,
} from '../provider-routing/production-provider-routing-config';
import type { ProductionProviderDefinition } from '../provider-routing/production-provider-routing-config';

const ts = '2026-09-26T00:00:00.000Z';
const executionId = 'task-run-1';

describe('parseContinuationReceiverMode (§31)', () => {
  it('missing and exact "disabled" both map to disabled', () => {
    expect(parseContinuationReceiverMode(undefined)).toBe('disabled');
    expect(parseContinuationReceiverMode('disabled')).toBe('disabled');
  });
  it('accepts only the exact "general-chat-v1" token', () => {
    expect(parseContinuationReceiverMode('general-chat-v1')).toBe('general-chat-v1');
  });
  it.each(['', ' ', ' disabled ', 'DISABLED', 'General-Chat-v1', 'true', '1', 'yes', 'enabled', 'on'])(
    'rejects malformed/boolean-ish value %j with the typed code',
    (raw) => {
      expect(() => parseContinuationReceiverMode(raw)).toThrow('CONTINUATION_RECEIVER_INVALID_MODE');
    },
  );
});

describe('createProductionContinuationReceiverActivation (§32/§33/§34)', () => {
  const ollama = { ollamaBin: '/approved/ollama' };
  const verifiedContainment: ContinuationContainment = { verify: () => ({ status: 'verified' }) };

  it('disabled → binding absent (undefined)', () => {
    expect(createProductionContinuationReceiverActivation({ mode: 'disabled', ollama })).toBeUndefined();
  });

  it('general-chat-v1 without containment → startup fail-closed (§33)', () => {
    expect(() =>
      createProductionContinuationReceiverActivation({ mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } }, ollama }),
    ).toThrow(ContinuationReceiverActivationError);
    try {
      createProductionContinuationReceiverActivation({ mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } }, ollama });
    } catch (error) {
      expect((error as ContinuationReceiverActivationError).code).toBe(
        ContinuationReceiverActivationErrorCode.CONTAINMENT_UNAVAILABLE,
      );
    }
  });

  it('general-chat-v1 with unverified containment → fail-closed', () => {
    expect(() =>
      createProductionContinuationReceiverActivation({
        mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } },
        ollama,
        containment: { verify: () => ({ status: 'unverified' }) },
        artifactManager: { create: async () => ({} as Artifact) },
      }),
    ).toThrow('CONTINUATION_RECEIVER_CONTAINMENT_UNVERIFIED');
  });

  it('general-chat-v1 with verified containment but missing artifact dependency → fail-closed', () => {
    expect(() =>
      createProductionContinuationReceiverActivation({
        mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } },
        ollama,
        containment: verifiedContainment,
      }),
    ).toThrow('CONTINUATION_RECEIVER_DEPENDENCY_MISSING');
  });

  it('general-chat-v1 with a verified fake containment + fakes → composes a receiver (§34)', () => {
    const receiver = createProductionContinuationReceiverActivation({
      mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } },
      ollama,
      containment: verifiedContainment,
      artifactManager: { create: async (i) => ({ id: 'a1', kind: i.kind, title: i.title, createdAt: ts }) },
      destinationAgentProfiles: [receiverInput().destinationAgentProfile],
      createConfiguration: () => buildFakeConfiguration(),
    });
    expect(receiver).toBeDefined();
    expect(receiver?.supportedCapabilities).toEqual([Capability.GENERAL_CHAT]);
  });

  it('issues and passes the C2C local bundle from the named activation seam', async () => {
    const selection = { taskRunId: executionId, executionId, providerId: BALANCED_PROVIDER_ID } as never;
    const issuer = { issue: vi.fn(async () => selection), validate: vi.fn(async () => undefined) };
    const prepare = vi.fn(() => ({ plan: {} as never, preparedExecution: {} as never }));
    const dispatchCommit = { commit: vi.fn(async () => ({} as never)) };
    const receiver = createTestContinuationReceiverActivation({
      mode: 'general-chat-v1', ollama,
      containment: verifiedContainment, dispatchCommit,
      artifactManager: { create: async (i) => ({ id: 'a1', kind: i.kind, title: i.title, createdAt: ts }) },
      destinationAgentProfiles: [receiverInput().destinationAgentProfile],
      createConfiguration: () => buildFakeConfiguration(),
      localContinuity: { issuer: issuer as never, providerId: BALANCED_PROVIDER_ID, prepare },
    });
    expect(receiver).toBeDefined();
    expect((await receiver!.receive(receiverInput())).disposition).toBe('FAILED');
    expect(issuer.issue).toHaveBeenCalledWith(executionId, BALANCED_PROVIDER_ID);
    expect(prepare).toHaveBeenCalledWith(selection);
    expect(issuer.validate).toHaveBeenCalledTimes(1);
    expect(dispatchCommit.commit).not.toHaveBeenCalled();
  });

  it('rejects the test-only local effect seam in production composition', () => {
    const prepare = vi.fn(() => ({} as never));
    expect(() => createProductionContinuationReceiverActivation({
      mode: 'general-chat-v1', ollama,
      localContinuity: { issuer: {} as never, providerId: BALANCED_PROVIDER_ID, prepare },
    } as never)).toThrow(ContinuationReceiverActivationErrorCode.TEST_LOCAL_CONTINUITY_FORBIDDEN);
    expect(prepare).not.toHaveBeenCalled();
  });
});

/** Fake offline provider: never spawns; controllable output. */
class FakeProvider {
  readonly id: string;
  readonly capabilities = [];
  constructor(id: string, private readonly response = 'A concise continuation answer.') {
    this.id = id;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async execute(): Promise<{ text: string }> {
    return { text: this.response };
  }
}

function buildFakeConfiguration() {
  const definitions: readonly [ProductionProviderDefinition, ProductionProviderDefinition] = [
    {
      providerId: BALANCED_PROVIDER_ID,
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'llama3.1:8b',
      candidateRole: ProviderCandidateRole.BALANCED_PRIMARY,
      provider: new FakeProvider(BALANCED_PROVIDER_ID) as never,
    },
    {
      providerId: SEMANTIC_PROVIDER_ID,
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'granite3.3:8b',
      candidateRole: ProviderCandidateRole.SEMANTIC_CANDIDATE,
      provider: new FakeProvider(SEMANTIC_PROVIDER_ID) as never,
    },
  ];
  return buildProductionProviderRoutingConfiguration(definitions);
}

function receiverInput(): ContinuationReceiverInput {
  const handoff = createWorkHandoff({
    id: 'handoff',
    workItemId: 'work',
    fromAgentProfileId: agentProfileId('source'),
    toAgentProfileId: agentProfileId('receiver'),
    objective: 'Summarize project status for the team.',
    resourceRefs: [],
    artifactIds: [],
    executionReceiptIds: [],
    createdAt: ts,
  });
  const plan: ExecutionPlan = {
    id: 'plan',
    goal: 'Status summary',
    summary: 'summary',
    steps: [],
    requiredCapabilities: [Capability.GENERAL_CHAT],
    requiredResources: [],
    estimatedChanges: { fileCount: 0, scope: 'none' },
    approvalRequired: false,
    overallRisk: 'LOW' as ExecutionPlan['overallRisk'],
    expectedArtifacts: [],
    status: 'PENDING' as ExecutionPlan['status'],
    createdAt: ts,
  };
  const taskRun: TaskRun = {
    id: executionId,
    taskId: 'task-1',
    attempt: 1,
    status: 'STARTED' as TaskRun['status'],
    capability: Capability.GENERAL_CHAT,
    artifactIds: [],
    startedAt: ts,
  };
  return {
    handoff,
    destinationAgentProfile: {
      id: agentProfileId('receiver'),
      displayName: 'Receiver',
      role: 'Assistant',
      purpose: 'Continue work',
      instructions: 'Persona only.',
    },
    plan,
    taskRun,
    boundTaskFacts: { capability: Capability.GENERAL_CHAT, intentType: IntentType.CHAT },
  } as ContinuationReceiverInput;
}

describe('offline activation factory composition (offline, fake runner) — no conversation reframe (§16/§36)', () => {
  it('drives the real Ollama adapter with a fake CliRunner and is NOT reframed', async () => {
    const captured: { input: string }[] = [];
    const runner: CliRunner = async (_bin, args, options): Promise<CliRunResult> => {
      captured.push({ input: options.input });
      // Availability now requires the configured model to be listed by `ollama list`.
      if (args[0] === 'list') {
        return {
          code: 0,
          stdout: 'NAME  ID  SIZE  MODIFIED\nllama3.1:8b  a1  4.7 GB  now\ngranite3.3:8b  b2  4.9 GB  now',
          stderr: '',
          timedOut: false,
        };
      }
      return { code: 0, stdout: 'A concise continuation answer.', stderr: '', timedOut: false };
    };
    // Build a production config whose BALANCED provider is a real OllamaCliProvider with a FAKE runner.
    const definitions: readonly [ProductionProviderDefinition, ProductionProviderDefinition] = [
      {
        providerId: BALANCED_PROVIDER_ID,
        adapterId: OLLAMA_ADAPTER_ID,
        modelId: 'llama3.1:8b',
        candidateRole: ProviderCandidateRole.BALANCED_PRIMARY,
        provider: new OllamaCliProvider({ model: 'llama3.1:8b', providerId: BALANCED_PROVIDER_ID, runner }),
      },
      {
        providerId: SEMANTIC_PROVIDER_ID,
        adapterId: OLLAMA_ADAPTER_ID,
        modelId: 'granite3.3:8b',
        candidateRole: ProviderCandidateRole.SEMANTIC_CANDIDATE,
        provider: new OllamaCliProvider({ model: 'granite3.3:8b', providerId: SEMANTIC_PROVIDER_ID, runner }),
      },
    ];
    const configuration = buildProductionProviderRoutingConfiguration(definitions);
    const create = vi.fn(async (i: { kind: ArtifactKind; title: string; content?: string; taskId?: string; taskRunId?: string }): Promise<Artifact> => ({
      id: 'platform-artifact-1',
      kind: i.kind,
      title: i.title,
      createdAt: ts,
      ...(i.content !== undefined ? { content: i.content } : {}),
    }));
    const receiver = createProductionContinuationReceiverActivation({
      mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } },
      ollama: { ollamaBin: '/approved/ollama' },
      containment: { verify: () => ({ status: 'verified' }) },
      promptComposer: new PromptComposer(),
      promptRenderer: new PromptRenderer(),
      artifactManager: { create } as never,
      destinationAgentProfiles: [receiverInput().destinationAgentProfile],
      createConfiguration: () => configuration,
    });
    expect(receiver).toBeDefined();

    const outcome = await receiver!.receive(receiverInput());
    expect(outcome.disposition).toBe('SUCCEEDED');
    // R1 accepts the produced outcome and audit.
    expect(snapshotReceiverOutcome(outcome, executionId)).not.toBeNull();
    // Exactly one prompt was dispatched to execute() (the rest are `ollama list` availability
    // probes with empty stdin). That single prompt was NOT reframed as a conversation turn.
    const dispatched = captured.filter((entry) => entry.input.length > 0);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.input).not.toContain('User (current active turn):');
    expect(dispatched[0]!.input).not.toContain('Previous conversation (history only');
    expect(dispatched[0]!.input).not.toContain('## 3. Conversation transcript');
    expect(dispatched[0]!.input).toContain('Continuation request');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('activation profile feasibility', () => {
  function activate(instructions: string) {
    const profile = { ...receiverInput().destinationAgentProfile, instructions };
    // Prove the input is valid under unchanged AgentProfile character rules.
    const profiles = new AgentProfileRegistry([profile]).list();
    const createConfiguration = vi.fn(() => buildFakeConfiguration());
    const run = () => createProductionContinuationReceiverActivation({
      mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } }, ollama: { ollamaBin: '/unused' },
      containment: { verify: () => ({ status: 'verified' }) },
      artifactManager: { create: async () => ({} as Artifact) },
      destinationAgentProfiles: profiles, createConfiguration,
    });
    return { profile, run, createConfiguration };
  }
  it('requires a destination profile snapshot even with other offline dependencies present', () => {
    expect(() => createProductionContinuationReceiverActivation({
      mode: 'general-chat-v1', dispatchCommit: { async commit() { return {} as never; } }, ollama: { ollamaBin: '/unused' },
      containment: { verify: () => ({ status: 'verified' }) },
      artifactManager: { create: async () => ({} as Artifact) },
    })).toThrow('CONTINUATION_RECEIVER_DEPENDENCY_MISSING');
  });
  it('accepts any legal profile identity in the synthetic feasibility envelope', () => {
    expect(minimalContinuationPromptBytes({
      ...receiverInput().destinationAgentProfile, id: agentProfileId('source'),
    })).toBeLessThan(CONTINUATION_PROMPT_BOUNDS.maxRenderedPromptBytes);
  });
  it('allows an ASCII profile within budget with fake containment', () => {
    expect(activate('a'.repeat(16384)).run()).toBeDefined();
  });
  it('rejects a valid Korean profile before configuration/routing, without truncation', () => {
    const test = activate('가'.repeat(16384));
    expect(test.run).toThrow('CONTINUATION_RECEIVER_PROFILE_PROMPT_INFEASIBLE');
    expect(test.createConfiguration).not.toHaveBeenCalled();
    expect(test.profile.instructions).toBe('가'.repeat(16384));
  });
  it('allows a minimal rendered prompt exactly one byte under the limit', () => {
    const base = activate('x').profile;
    const remaining = CONTINUATION_PROMPT_BOUNDS.maxRenderedPromptBytes
      - minimalContinuationPromptBytes(base);
    const extra = remaining - 1;
    const test = activate('x' + '가'.repeat(Math.floor(extra / 3)) + 'a'.repeat(extra % 3));
    expect(minimalContinuationPromptBytes(test.profile)).toBe(
      CONTINUATION_PROMPT_BOUNDS.maxRenderedPromptBytes - 1,
    );
    expect(test.run()).toBeDefined();
  });
});
