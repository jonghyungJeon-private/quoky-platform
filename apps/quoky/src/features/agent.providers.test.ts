import { describe, expect, it } from 'vitest';
import { AgentModeError, AgentRunService, ConsentPendingStore, ConsentTurnGate, type Capability, type CapabilityRouter, type StorageProvider } from '@quoky/core';
import { AGENT_RUNS, CONSENT_TURN_GATE, SUMMARY_CONSENT_STORE, createAgentProviders, createAgentReadPorts, type AgentFeatureConfig } from './agent.providers';

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

  it('the consent gate: the classifier switch follows QUOKY_CONSENT_ANSWER_CLASSIFIER (off, the default, builds none) and every call is charged to the run service', () => {
    const providers = createAgentProviders(() => ({ agent: { mode: 'off', summarySources: [] }, timeoutMs: 6_000, timeZone: 'Asia/Seoul', summaryConsent: 'on' }), { logger: silent });
    const gateProvider = providers.find((p) => (p as { provide: symbol }).provide === CONSENT_TURN_GATE) as { useFactory: (runs: AgentRunService, store: ConsentPendingStore | undefined, router: CapabilityRouter) => ConsentTurnGate | undefined };
    const runs = { continueSummaryConsent: async () => ({ kind: 'declined', reason: 'x', text: 'x' }), voidAllSummaryConsents: () => undefined, chargeClassifierCall: () => true } as unknown as AgentRunService;
    const router = { select: async () => { throw new Error('router must not be used with the switch off'); } } as unknown as CapabilityRouter;
    expect(gateProvider.useFactory(runs, undefined, router)).toBeUndefined();
    expect(gateProvider.useFactory(runs, new ConsentPendingStore(), router)).toBeInstanceOf(ConsentTurnGate);
  });
});
