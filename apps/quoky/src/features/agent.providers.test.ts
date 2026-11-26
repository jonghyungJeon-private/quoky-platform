import { describe, expect, it } from 'vitest';
import { AGENT_WRITE_PROPOSAL_PORT, AgentModeError, AgentRunService, ConsentPendingStore, ConsentTurnGate, type Capability, type CapabilityRouter, type StorageProvider } from '@quoky/core';
import { AGENT_RUNS, CONSENT_TURN_GATE, SUMMARY_CONSENT_STORE, agentWriteProposalDep, createAgentProviders, createAgentReadPorts, type AgentFeatureConfig } from './agent.providers';

// ADR-0121 S2 wiring slice: the composition root builds the agent from the real collaborators. `off` and `shadow` are built as
// before (no read port, no M2 route); `active` (never reached from the environment while the release gate stands) gets the
// read ports and the existing router as M2's selector, but no `released` flag until P5, so the constructor refuses it. The read
// ports are empty until the adapter slice.

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const storage = { actors: { get: async () => null, save: async (actor: unknown) => actor } } as unknown as StorageProvider;

function build(mode: AgentFeatureConfig['agent']['mode'], router: CapabilityRouter): AgentRunService {
  const provider = createAgentProviders(() => ({ agent: { mode, summarySources: [] }, timeoutMs: 6_000, timeZone: 'Asia/Seoul' }), { logger: silent })[0] as {
    provide: symbol;
    useFactory: (router: CapabilityRouter, storage: StorageProvider) => AgentRunService;
  };
  expect(provider.provide).toBe(AGENT_RUNS);
  return provider.useFactory(router, storage);
}

describe('createAgentProviders (S2 wiring slice)', () => {
  const selects: unknown[] = [];
  const router = {
    select: async (capability: Capability, context?: unknown) => {
      selects.push([capability, context]);
      throw new Error('no provider');
    },
    isStillEligible: () => false,
  } as unknown as CapabilityRouter;

  it.each(['off', 'shadow'] as const)('%s is built as before: runActive is never available', async (mode) => {
    const service = build(mode, router);
    expect(service.mode).toBe(mode);
    expect(await service.runActive({ text: 'x', attachmentCount: 0, actor: { id: 'o', displayName: 'O', identities: [], createdAt: '2026-11-16T00:00:00.000Z' }, now: '2026-11-16T00:00:00.000Z', entries: [], direct: true }, async () => undefined)).toEqual({ kind: 'declined', reason: 'not-active' });
    expect(selects).toEqual([]);
  });

  it('active is composed with the read ports and the router as M2 selector but never released before P5: the constructor refuses it', () => {
    // Review round 1 item 5: the second layer behind the startup release gate. The composition never sets `released`, so even
    // an `active` config that got past `agent-config.ts` builds no service (AGENT_MODE_ACTIVE_UNWIRED).
    expect(() => build('active', router)).toThrow(expect.objectContaining({ code: 'AGENT_MODE_ACTIVE_UNWIRED' }));
    expect(() => new AgentRunService({ mode: 'active', router, actors: storage.actors, logger: silent, timeZone: 'Asia/Seoul' })).toThrow(AgentModeError);
  });

  it('the agent read ports are empty until the adapter slice (a budgeted HTTP client per port)', () => {
    expect(createAgentReadPorts()).toEqual({});
    expect(Object.isFrozen(createAgentReadPorts())).toBe(true);
  });
});

// ADR-0121 rule ① (CS-2): the shared pending store and the runtime gate exist only with QUOKY_SUMMARY_CONSENT=on.
describe('createAgentProviders: the rule-① consent composition (CS-2)', () => {
  const providers = (summaryConsent?: 'off' | 'on') =>
    createAgentProviders(() => ({ agent: { mode: 'off', summarySources: [] }, timeoutMs: 6_000, timeZone: 'Asia/Seoul', ...(summaryConsent !== undefined ? { summaryConsent } : {}) }), { logger: silent }) as unknown as Array<{
      provide: symbol;
      useFactory: (...args: unknown[]) => unknown;
      inject?: unknown[];
    }>;
  const find = (list: ReturnType<typeof providers>, token: symbol) => {
    const found = list.find((entry) => entry.provide === token);
    if (found === undefined) throw new Error('provider missing');
    return found;
  };

  it.each([undefined, 'off'] as const)('summaryConsent %s: no store and no gate (the runtime is byte-identical)', (mode) => {
    const list = providers(mode);
    expect(find(list, SUMMARY_CONSENT_STORE).useFactory()).toBeUndefined();
    expect(find(list, CONSENT_TURN_GATE).useFactory({}, undefined)).toBeUndefined();
  });

  it('on: one shared store, the gate over that store, and the kill switch voids the store and the service records', () => {
    const list = providers('on');
    const store = find(list, SUMMARY_CONSENT_STORE).useFactory() as ConsentPendingStore;
    expect(store).toBeInstanceOf(ConsentPendingStore);
    const voided: string[] = [];
    const agentRuns = { continueSummaryConsent: async () => ({ kind: 'declined', reason: 'x', text: 'y' }), voidAllSummaryConsents: () => voided.push('records') };
    const gate = find(list, CONSENT_TURN_GATE).useFactory(agentRuns, store) as ConsentTurnGate;
    expect(gate).toBeInstanceOf(ConsentTurnGate);
    gate.voidAll();
    expect(voided).toEqual(['records']);
    // The gate and the agent run service receive the same optional store token (one store, not two).
    expect(find(list, CONSENT_TURN_GATE).inject).toContainEqual({ token: SUMMARY_CONSENT_STORE, optional: true });
    expect(find(list, AGENT_RUNS).inject).toContainEqual({ token: SUMMARY_CONSENT_STORE, optional: true });
  });

  it('the agent service is built with or without the store as before (off mode builds neither readers nor the store)', () => {
    const list = providers('on');
    const store = find(list, SUMMARY_CONSENT_STORE).useFactory();
    const router = { select: async () => { throw new Error('no provider'); }, isStillEligible: () => false } as unknown as CapabilityRouter;
    const service = find(list, AGENT_RUNS).useFactory(router, storage, store) as AgentRunService;
    expect(service.mode).toBe('off');
  });

  it('the consent gate: the classifier switch follows QUOKY_CONSENT_ANSWER_CLASSIFIER (off, the default, builds none) and a call is charged to the run service', async () => {
    const make = (consentAnswerClassifier?: 'off' | 'on') =>
      createAgentProviders(() => ({ agent: { mode: 'off', summarySources: [] }, timeoutMs: 6_000, timeZone: 'Asia/Seoul', summaryConsent: 'on', ...(consentAnswerClassifier !== undefined ? { consentAnswerClassifier } : {}) }), { logger: silent }).find((p) => (p as { provide: symbol }).provide === CONSENT_TURN_GATE) as {
        useFactory: (runs: AgentRunService, store: ConsentPendingStore | undefined, router: CapabilityRouter) => ConsentTurnGate | undefined;
      };
    const charges: Array<[string, number]> = [];
    const runs = { continueSummaryConsent: async () => ({ kind: 'declined', reason: 'x', text: 'x' }), voidAllSummaryConsents: () => undefined, chargeClassifierCall: (id: string, at: number) => (charges.push([id, at]), true) } as unknown as AgentRunService;
    const router = { select: async () => { throw new Error('router must not be used with the switch off'); } } as unknown as CapabilityRouter;
    expect(make().useFactory(runs, undefined, router)).toBeUndefined();
    expect(make().useFactory(runs, new ConsentPendingStore(), router)).toBeInstanceOf(ConsentTurnGate);
    // With the switch on the gate's `chargeModelCall` reaches the run service's ledger: the stub provider is stronger-tier, same egress.
    const gate = make('on').useFactory(runs, new ConsentPendingStore(), { select: async () => ({ id: 'claude-cli', executionLocality: 'REMOTE', supportsStrongerIntentSelection: true, execute: async () => ({ text: '{"label":"yes"}' }) }) } as unknown as CapabilityRouter) as unknown as { deps: { chargeModelCall: (actor: { id: string }, atMs: number) => boolean; classifier: { mode: string } } };
    expect(gate.deps.classifier.mode).toBe('on');
    expect(gate.deps.chargeModelCall({ id: 'owner' }, 42)).toBe(true);
    expect(charges).toEqual([['owner', 42]]);
  });

  it('the run service learns the classifier switch (consentClassifierOn) only with QUOKY_CONSENT_ANSWER_CLASSIFIER=on', () => {
    const service = (consentAnswerClassifier?: 'off' | 'on') => {
      const provider = createAgentProviders(() => ({ agent: { mode: 'off', summarySources: [] }, timeoutMs: 6_000, timeZone: 'Asia/Seoul', ...(consentAnswerClassifier !== undefined ? { consentAnswerClassifier } : {}) }), { logger: silent })[0] as { useFactory: (router: CapabilityRouter, storage: StorageProvider) => AgentRunService };
      return provider.useFactory({} as CapabilityRouter, storage) as unknown as { deps: { consentClassifierOn?: boolean } };
    };
    expect(service().deps.consentClassifierOn).toBeUndefined();
    expect(service('off').deps.consentClassifierOn).toBeUndefined();
    expect(service('on').deps.consentClassifierOn).toBe(true);
  });
});

// ADR-0121 amendment A7 (A7-S4a): the proposal port reaches the agent service only with EVERY switch on; the defaults hand it nothing.
describe('agentWriteProposalDep (A7-S4a, dormant)', () => {
  const port = { openCardOf: async () => undefined, propose: async () => ({ kind: 'refused', reason: 'unavailable' }) } as unknown as Parameters<typeof agentWriteProposalDep>[1];
  const base = (over: Partial<AgentFeatureConfig> = {}): AgentFeatureConfig => ({ agent: { mode: 'active', summarySources: [] }, timeoutMs: 6_000, timeZone: 'Asia/Seoul', ...over });
  const on = { mode: 'active' as const, targets: ['jira-comment'] };

  it('is built only for agent mode active, proposals active, jira-comment switched on and a bound port', () => {
    expect(agentWriteProposalDep(base({ writeProposals: on }), port)).toEqual({ port, targets: ['jira-comment'], sha256Hex: expect.any(Function) });
    expect(agentWriteProposalDep(base(), port)).toBeUndefined();
    expect(agentWriteProposalDep(base({ writeProposals: { mode: 'off', targets: ['jira-comment'] } }), port)).toBeUndefined();
    expect(agentWriteProposalDep(base({ writeProposals: { mode: 'shadow', targets: ['jira-comment'] } }), port)).toBeUndefined();
    expect(agentWriteProposalDep(base({ writeProposals: { mode: 'active', targets: [] } }), port)).toBeUndefined();
    expect(agentWriteProposalDep(base({ writeProposals: { mode: 'active', targets: ['slack-post', 'calendar-description'] } }), port)).toBeUndefined();
    expect(agentWriteProposalDep(base({ writeProposals: on }), null)).toBeUndefined();
    expect(agentWriteProposalDep(base({ writeProposals: on }), undefined)).toBeUndefined();
    expect(agentWriteProposalDep(base({ agent: { mode: 'shadow', summarySources: [] }, writeProposals: on }), port)).toBeUndefined();
  });

  it('the port provider is null without a connector-write flow and a service with one; the service gets it only through the dep', () => {
    const provider = createAgentProviders(() => base({ agent: { mode: 'off', summarySources: [] } }), { logger: silent }).find((entry) => (entry as { provide: symbol }).provide === AGENT_WRITE_PROPOSAL_PORT) as { useFactory: (storage: unknown, flow: unknown) => unknown };
    expect(provider.useFactory({}, null)).toBeNull();
    expect(provider.useFactory({ sessions: {}, actors: {} }, { supports: () => true })).toMatchObject({ propose: expect.any(Function), openCardOf: expect.any(Function) });
  });
});
