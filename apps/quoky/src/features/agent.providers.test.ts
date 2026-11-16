import { describe, expect, it } from 'vitest';
import { AgentModeError, AgentRunService, type Capability, type CapabilityRouter, type StorageProvider } from '@quoky/core';
import { AGENT_RUNS, createAgentProviders, createAgentReadPorts, type AgentFeatureConfig } from './agent.providers';

// ADR-0121 S2 wiring slice: the composition root builds the agent from the real collaborators. `off` and `shadow` are built as
// before (no read port, no M2 route); `active` (never reached from the environment while the release gate stands) gets the
// read ports and the existing router as M2's selector. The read ports are empty until the adapter slice.

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const storage = { actors: { get: async () => null, save: async (actor: unknown) => actor } } as unknown as StorageProvider;

function build(mode: AgentFeatureConfig['agent']['mode'], router: CapabilityRouter): AgentRunService {
  const provider = createAgentProviders(() => ({ agent: { mode }, timeoutMs: 6_000, timeZone: 'Asia/Seoul' }), { logger: silent })[0] as {
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

  it('active is built with the read ports and the router as M2 selector (the constructor refuses it otherwise)', () => {
    const service = build('active', router);
    expect(service.mode).toBe('active');
    expect(() => new AgentRunService({ mode: 'active', router, actors: storage.actors, logger: silent, timeZone: 'Asia/Seoul' })).toThrow(AgentModeError);
  });

  it('the agent read ports are empty until the adapter slice (a budgeted HTTP client per port)', () => {
    expect(createAgentReadPorts()).toEqual({});
    expect(Object.isFrozen(createAgentReadPorts())).toBe(true);
  });
});
