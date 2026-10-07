import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Capability,
  IntentType,
  LatencyClass,
  OutputSizeClass,
  ProviderAvailability,
  RankingDimension,
  Requirement,
  RoutingClass,
  RoutingReasonCode,
  RoutingRequestType,
  SemanticRisk,
  SortDirection,
  AuthorityRequirement,
  AUTHORITY_SENSITIVE,
  adapterId,
  providerId,
} from '@quoky/core';
import type { AiExecutionResult, AiProvider, AiRequest, RoutingContext } from '@quoky/core';
import { OllamaCliProvider } from '@quoky/ai-cli';
import {
  BALANCED_PROVIDER_ID,
  OLLAMA_ADAPTER_ID,
  PRODUCTION_ROUTING_CONFIGURATION_VERSION,
  PROVIDER_PROFILE_VERSION,
  ProviderCandidateRole,
  SEMANTIC_PROVIDER_ID,
  buildProductionProviderRoutingConfiguration,
  createProductionProviderRoutingConfiguration,
  createStage2AProviderProvenance,
} from './production-provider-routing-config';
import type { ProductionProviderDefinition } from './production-provider-routing-config';

class StaticProvider implements AiProvider {
  readonly capabilities = [];
  availabilityCalls = 0;
  executionCalls = 0;

  constructor(readonly id: string) {}

  async isAvailable(): Promise<boolean> {
    this.availabilityCalls += 1;
    return true;
  }

  async execute(_request: AiRequest): Promise<AiExecutionResult> {
    this.executionCalls += 1;
    return { text: 'unused' };
  }
}

function definitions(): readonly [ProductionProviderDefinition, ProductionProviderDefinition] {
  return [
    {
      providerId: BALANCED_PROVIDER_ID,
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'llama3.1:8b',
      candidateRole: ProviderCandidateRole.BALANCED_PRIMARY,
      provider: new StaticProvider(BALANCED_PROVIDER_ID),
    },
    {
      providerId: SEMANTIC_PROVIDER_ID,
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'granite3.3:8b',
      candidateRole: ProviderCandidateRole.SEMANTIC_CANDIDATE,
      provider: new StaticProvider(SEMANTIC_PROVIDER_ID),
    },
  ];
}

const context = (capability: Capability): RoutingContext => ({
  capability,
  requestType: RoutingRequestType.CONVERSATIONAL,
  intentType: IntentType.CHAT,
  semanticRisk: SemanticRisk.STANDARD,
  latencyClass: LatencyClass.BALANCED,
  toolUseRequirement: Requirement.NOT_REQUIRED,
  authorityRequirement: AuthorityRequirement.NOT_REQUIRED,
  continuityRequirement: Requirement.UNKNOWN,
  expectedOutputSize: OutputSizeClass.MEDIUM,
  validationProfile: 'GENERAL_CHAT' as RoutingContext['validationProfile'],
});

describe('Stage 2B Slice 5B-1 production Provider routing configuration', () => {
  it('keeps legacy Ollama identity and supports an explicit instance identity', () => {
    expect(new OllamaCliProvider().id).toBe('ollama-cli');
    expect(
      new OllamaCliProvider({
        model: 'llama3.1:8b',
        providerId: BALANCED_PROVIDER_ID,
      }).id,
    ).toBe(BALANCED_PROVIDER_ID);
  });

  it('constructs exactly the two approved model instances without probing or executing them', () => {
    const source = definitions();
    const configuration = buildProductionProviderRoutingConfiguration(source);

    expect(configuration.version).toBe(PRODUCTION_ROUTING_CONFIGURATION_VERSION);
    expect(configuration.providerDescriptors.map((item) => item.providerId)).toEqual([
      SEMANTIC_PROVIDER_ID,
      BALANCED_PROVIDER_ID,
    ]);
    expect(configuration.executableBindings).toHaveLength(2);
    expect(configuration.providerDescriptors.map((item) => item.modelId).sort()).toEqual([
      'granite3.3:8b',
      'llama3.1:8b',
    ]);
    expect(
      configuration.providerDescriptors.some((item) =>
        ['claude-cli', 'codex-cli', 'llama3.2:3b', 'mistral:7b'].includes(item.providerId),
      ),
    ).toBe(false);
    expect(source.every((item) => (item.provider as StaticProvider).availabilityCalls === 0)).toBe(true);
    expect(source.every((item) => (item.provider as StaticProvider).executionCalls === 0)).toBe(true);
  });

  it('fails fast on duplicate ids and descriptor/binding/executable identity mismatch', () => {
    const [balanced, semantic] = definitions();
    expect(() =>
      buildProductionProviderRoutingConfiguration([
        balanced,
        { ...semantic, providerId: balanced.providerId },
      ]),
    ).toThrow(/Duplicate production providerId/);
    expect(() =>
      buildProductionProviderRoutingConfiguration([
        { ...balanced, modelId: 'granite3.3:8b' },
        semantic,
      ]),
    ).toThrow(/identity\/model binding mismatch/);
    expect(() =>
      buildProductionProviderRoutingConfiguration([
        { ...balanced, provider: new StaticProvider('ollama-cli') },
        semantic,
      ]),
    ).toThrow(/Executable Provider binding mismatch/);
  });

  it('uses only GENERAL_CHAT and the approved deterministic ranking dimensions', () => {
    const configuration = buildProductionProviderRoutingConfiguration(definitions());
    const policy = configuration.routingPolicy.policies[0];
    expect(policy?.when.capabilities).toEqual([Capability.GENERAL_CHAT]);
    expect(policy?.when.validationProfiles).toEqual(['GENERAL_CHAT']);
    expect(policy?.ranking).toEqual([
      {
        dimension: RankingDimension.ROUTING_CLASS,
        direction: SortDirection.ASCENDING,
        routingClassPreference: [RoutingClass.BALANCED, RoutingClass.SEMANTIC_HIGH],
      },
      {
        dimension: RankingDimension.SEMANTIC_RELIABILITY,
        direction: SortDirection.DESCENDING,
      },
    ]);

    const available = {
      [BALANCED_PROVIDER_ID]: ProviderAvailability.AVAILABLE,
      [SEMANTIC_PROVIDER_ID]: ProviderAvailability.AVAILABLE,
    };
    const snapshot = configuration.providerRegistry.snapshot(available);
    expect(configuration.policyEngine.select(context(Capability.GENERAL_CHAT), snapshot)).toMatchObject({
      selectedProviderId: BALANCED_PROVIDER_ID,
      reasonCode: RoutingReasonCode.SELECTED,
    });
    expect(configuration.policyEngine.select(context(Capability.SUMMARIZATION), snapshot)).toMatchObject({
      selectedProviderId: null,
      reasonCode: RoutingReasonCode.POLICY_NOT_MATCHED,
    });
  });

  it('R2 §7/§6: chat policy is CONVERSATIONAL-only and a WORK/CHAT continuation matches only the continuation policy', () => {
    const configuration = buildProductionProviderRoutingConfiguration(definitions());
    const available = {
      [BALANCED_PROVIDER_ID]: ProviderAvailability.AVAILABLE,
      [SEMANTIC_PROVIDER_ID]: ProviderAvailability.AVAILABLE,
    };
    const snapshot = configuration.providerRegistry.snapshot(available);
    // Chat policy is still policies[0] and hardened to require CONVERSATIONAL.
    expect(configuration.routingPolicy.policies[0]?.policyId).toBe('stage2b-general-chat-v1');
    expect(configuration.routingPolicy.policies[0]?.when.requestTypes).toEqual([RoutingRequestType.CONVERSATIONAL]);
    const continuationPolicy = configuration.routingPolicy.policies.find(
      (candidate) => candidate.policyId === 'stage2b-continuation-general-chat-v1',
    );
    expect(continuationPolicy?.when.requestTypes).toEqual([RoutingRequestType.WORK]);
    expect(continuationPolicy?.when.intentTypes).toEqual([IntentType.CHAT]);
    expect(continuationPolicy?.when.validationProfiles).toEqual([AUTHORITY_SENSITIVE]);
    expect(continuationPolicy?.eligibility.requiredRoutingClasses).toEqual([RoutingClass.BALANCED]);

    // Ordinary ConversationRuntime GENERAL_CHAT (CONVERSATIONAL) → chat policy, selects the balanced primary.
    const conversation = context(Capability.GENERAL_CHAT);
    expect(configuration.policyEngine.select(conversation, snapshot)).toMatchObject({
      matchedPolicyId: 'stage2b-general-chat-v1',
      selectedProviderId: BALANCED_PROVIDER_ID,
      reasonCode: RoutingReasonCode.SELECTED,
    });

    // Continuation WORK/CHAT/AUTHORITY_SENSITIVE → continuation policy only; the single BALANCED
    // eligible provider yields a primary-only decision (no fallback candidate).
    const continuation: RoutingContext = {
      ...conversation,
      requestType: RoutingRequestType.WORK,
      validationProfile: AUTHORITY_SENSITIVE as RoutingContext['validationProfile'],
    };
    const continuationDecision = configuration.policyEngine.select(continuation, snapshot);
    expect(continuationDecision.matchedPolicyId).toBe('stage2b-continuation-general-chat-v1');
    expect(continuationDecision.reasonCode).toBe(RoutingReasonCode.SELECTED);
    expect(continuationDecision.eligibleProviderIds).toEqual([BALANCED_PROVIDER_ID]);

    // A WORK GENERAL_CHAT with the GENERAL_CHAT profile matches NEITHER policy (separation by predicate).
    const mismatched: RoutingContext = { ...conversation, requestType: RoutingRequestType.WORK };
    expect(configuration.policyEngine.select(mismatched, snapshot).reasonCode).toBe(
      RoutingReasonCode.POLICY_NOT_MATCHED,
    );
  });

  it('uses conservative equal operational profiles and the approved bounded reliability profiles', () => {
    const configuration = buildProductionProviderRoutingConfiguration(definitions());
    const balanced = configuration.providerRegistry.get(BALANCED_PROVIDER_ID);
    const semantic = configuration.providerRegistry.get(SEMANTIC_PROVIDER_ID);
    expect(balanced?.profileVersion).toBe(PROVIDER_PROFILE_VERSION);
    expect(balanced?.capabilities.routingClasses).toEqual([RoutingClass.BALANCED]);
    expect(semantic?.capabilities.routingClasses).toEqual([RoutingClass.SEMANTIC_HIGH]);
    expect(balanced?.operationalProfile).toEqual(semantic?.operationalProfile);
  });

  it('produces deterministic, scoped provenance digests', () => {
    const first = createStage2AProviderProvenance(definitions()[0]);
    const repeated = createStage2AProviderProvenance(definitions()[0]);
    const modelChanged = createStage2AProviderProvenance({
      providerId: providerId('ollama-cli:llama3.2:3b'),
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: 'llama3.2:3b',
      candidateRole: ProviderCandidateRole.BALANCED_PRIMARY,
    });
    const providerChanged = createStage2AProviderProvenance({
      ...definitions()[0],
      providerId: providerId('alternate-instance'),
    });
    const roleChanged = createStage2AProviderProvenance({
      ...definitions()[0],
      candidateRole: ProviderCandidateRole.SEMANTIC_CANDIDATE,
    });
    const adapterChanged = createStage2AProviderProvenance({
      ...definitions()[0],
      adapterId: adapterId('alternate-ollama'),
    });

    expect(first).toEqual(repeated);
    expect(first.evidenceBindingDigest).toBe(
      '516bbd3c9e16fc8ee14a43aea48fb3723ac7b64ce948d0d452550c9bc5bb3151',
    );
    expect(providerChanged.evidenceBindingDigest).not.toBe(first.evidenceBindingDigest);
    expect(modelChanged.evidenceBindingDigest).not.toBe(first.evidenceBindingDigest);
    expect(roleChanged.evidenceBindingDigest).not.toBe(first.evidenceBindingDigest);
    expect(adapterChanged.evidenceBindingDigest).not.toBe(first.evidenceBindingDigest);
    expect(first.evidenceBindingDigest).not.toBe(first.payload.goldenCorpusDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload)).toBe(true);
  });

  it('excludes executable path and availability from provenance and configuration identity', () => {
    const first = createProductionProviderRoutingConfiguration({ ollamaBin: '/approved/a/ollama' });
    const second = createProductionProviderRoutingConfiguration({ ollamaBin: '/approved/b/ollama' });
    expect(second.providerProvenance).toEqual(first.providerProvenance);
    expect(second.configurationDigest).toBe(first.configurationDigest);
  });

  it('returns frozen configuration declarations', () => {
    const configuration = buildProductionProviderRoutingConfiguration(definitions());
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.providerDescriptors)).toBe(true);
    expect(configuration.providerDescriptors.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(configuration.executableBindings)).toBe(true);
    expect(configuration.executableBindings.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(configuration.routingPolicy)).toBe(true);
    expect(Object.isFrozen(configuration.routingPolicy.policies)).toBe(true);
    expect(Object.isFrozen(configuration.routingPolicy.policies[0]?.ranking)).toBe(true);
    expect(Object.isFrozen(configuration.providerProvenance)).toBe(true);
  });

  it('keeps legacy providers while allowing only the approved optional Runtime collaborator composition', () => {
    const appModule = readFileSync(resolve(__dirname, '../app.module.ts'), 'utf8');
    const productionSource = readFileSync(
      resolve(__dirname, 'production-provider-routing-config.ts'),
      'utf8',
    );
    expect(appModule).toContain('createProductionRuntimeProviderRoutingActivation');
    expect(appModule).toContain('runtimeProviderRouting,');
    expect(appModule).not.toMatch(/\.execute\s*\(/);
    expect(appModule).not.toContain('ProviderRoutingGateway');
    // ADR-0092 amendment (2026-10-07): the chat providers moved into chat-provider-composition.ts. Since the runtime
    // switch amendment every chat provider that can run on this host is registered through the provider catalog, and
    // the owner's selection is the router's ProviderSelectionPolicy (data only).
    const chatComposition = readFileSync(resolve(__dirname, '../chat-provider-composition.ts'), 'utf8');
    expect(appModule).toContain('const providerCatalog = new ProviderCatalog({');
    expect(appModule).toContain('useFactory: (): AiProvider[] => providerCatalog.providers');
    expect(appModule).toContain('new CapabilityRouter(manager, selection)');
    expect(chatComposition).toContain('new ClaudeCliProvider(ai.claudeBin, { model: ai.claudeModel })');
    expect(chatComposition).toContain('new OllamaCliProvider({ bin: ai.ollamaBin, model: ai.ollamaModel })');
    expect(chatComposition).toContain('new CodexCliProvider(ai.codexBin, ');
    expect(chatComposition).not.toMatch(/\.execute\s*\(/);
    expect(productionSource).not.toContain('@quoky/provider-routing-validation');
  });
});
