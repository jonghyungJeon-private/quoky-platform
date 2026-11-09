import { describe, expect, it } from 'vitest';
import { AiProviderManager } from './ai-provider-manager';
import { CapabilityRouter } from './capability-router';
import { isRequiredLocalDispatchAllowed, selectRequiredLocalProvider } from './local-provider-dispatch';
import { Capability } from '../domain';
import { NoProviderAvailableError } from '../errors';
import type { AiExecutionLocality, AiProvider, ProviderSelectionPolicy, ProviderSelector } from '../ports';

/**
 * ADR-0124 Part L C5a (DECISIONS ADR-0124 section 17): `requiredLocality: 'LOCAL'` on the selection context. A `REMOTE`
 * provider is never probed, ranked, returned or dispatched to; an unready local provider makes no call; a provider whose
 * adapter declared it `REMOTE` (an Ollama cloud-served model) is refused; without the constraint nothing changes.
 */

interface Fake extends AiProvider {
  readonly probes: number;
  readonly calls: number;
}

function fake(id: string, locality: AiExecutionLocality | undefined, priority: number, ready = true): Fake {
  const state = { probes: 0, calls: 0 };
  return {
    id,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority }],
    ...(locality !== undefined ? { executionLocality: locality } : {}),
    isAvailable: async () => {
      state.probes += 1;
      return ready;
    },
    execute: async () => {
      state.calls += 1;
      return { text: 'x' };
    },
    get probes() {
      return state.probes;
    },
    get calls() {
      return state.calls;
    },
  };
}

const LOCAL = { requiredLocality: 'LOCAL' } as const;

describe('requiredLocality LOCAL on CapabilityRouter', () => {
  it('never returns a REMOTE provider, even at a higher priority, and never probes one', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const undeclared = fake('undeclared', undefined, 90);
    const local = fake('local', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([remote, undeclared, local]));
    expect((await router.select(Capability.SUMMARIZATION, LOCAL)).id).toBe('local');
    expect(remote.probes).toBe(0);
    expect(undeclared.probes).toBe(0);
  });

  it('with only REMOTE providers there is no provider (fail closed), and nothing is probed or called', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const router = new CapabilityRouter(new AiProviderManager([remote]));
    await expect(router.select(Capability.SUMMARIZATION, LOCAL)).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(remote.probes + remote.calls).toBe(0);
  });

  it('a policy that lists a REMOTE provider first still yields only a LOCAL one', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const local = fake('local', 'LOCAL', 10);
    const policy: ProviderSelectionPolicy = {
      preferenceFor: async () => ({ eligible: ['remote', 'local'], order: 'listed' }),
      isEligible: () => true,
    };
    const router = new CapabilityRouter(new AiProviderManager([remote, local]), policy);
    expect((await router.select(Capability.SUMMARIZATION, LOCAL)).id).toBe('local');
    expect((await router.select(Capability.SUMMARIZATION, {})).id).toBe('remote');
    expect(remote.probes).toBe(1);
  });

  it('constraint absent: selection is unchanged (the higher-priority REMOTE provider wins)', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const local = fake('local', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([remote, local]));
    expect((await router.select(Capability.SUMMARIZATION)).id).toBe('remote');
    expect((await router.select(Capability.SUMMARIZATION, {})).id).toBe('remote');
    expect((await router.select(Capability.SUMMARIZATION, { sessionId: 's' as never })).id).toBe('remote');
  });

  it('the dispatch-time check refuses a non-LOCAL provider under the constraint only', () => {
    const remote = fake('remote', 'REMOTE', 100);
    const local = fake('local', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([remote, local]));
    expect(router.isStillEligible(Capability.SUMMARIZATION, LOCAL, remote)).toBe(false);
    expect(router.isStillEligible(Capability.SUMMARIZATION, LOCAL, local)).toBe(true);
    expect(router.isStillEligible(Capability.SUMMARIZATION, {}, remote)).toBe(true);
  });
});

describe('selectRequiredLocalProvider / isRequiredLocalDispatchAllowed', () => {
  it('selects the ready LOCAL provider and allows its dispatch', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const local = fake('local', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([remote, local]));
    const picked = await selectRequiredLocalProvider(router, Capability.SUMMARIZATION, {});
    expect(picked.kind).toBe('selected');
    if (picked.kind !== 'selected') return;
    expect(picked.provider.id).toBe('local');
    expect(isRequiredLocalDispatchAllowed(router, Capability.SUMMARIZATION, {}, picked.provider)).toBe(true);
    expect(isRequiredLocalDispatchAllowed(router, Capability.SUMMARIZATION, {}, remote)).toBe(false);
  });

  it('an unready local provider is a typed not-ready: no call to it or to any REMOTE provider', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const local = fake('local', 'LOCAL', 10, false);
    const router = new CapabilityRouter(new AiProviderManager([remote, local]));
    expect(await selectRequiredLocalProvider(router, Capability.SUMMARIZATION, {})).toEqual({ kind: 'not-ready' });
    expect(local.calls + remote.calls + remote.probes).toBe(0);
  });

  it('a provider declared REMOTE by its adapter (a cloud-served model) or with no declaration is refused', async () => {
    for (const locality of ['REMOTE', undefined] as const) {
      const cloud = fake('ollama-cloud', locality, 100);
      const router = new CapabilityRouter(new AiProviderManager([cloud]));
      expect(await selectRequiredLocalProvider(router, Capability.SUMMARIZATION, {})).toEqual({ kind: 'not-ready' });
      expect(cloud.probes + cloud.calls).toBe(0);
    }
  });

  it('does not trust the port: a selector that returns a REMOTE provider is not-ready, and dispatch is refused', async () => {
    const remote = fake('remote', 'REMOTE', 100);
    const seen: unknown[] = [];
    const selector: ProviderSelector = {
      select: async (_capability, context) => {
        seen.push(context);
        return remote;
      },
    };
    expect(await selectRequiredLocalProvider(selector, Capability.SUMMARIZATION, { workText: true })).toEqual({ kind: 'not-ready' });
    expect(seen).toEqual([{ workText: true, requiredLocality: 'LOCAL' }]);
    expect(isRequiredLocalDispatchAllowed(selector, Capability.SUMMARIZATION, {}, remote)).toBe(false);
    expect(remote.calls).toBe(0);
  });

  it('a throwing selector or a throwing locality declaration fails closed', async () => {
    const selector: ProviderSelector = {
      select: async () => {
        throw new Error('down');
      },
    };
    expect(await selectRequiredLocalProvider(selector, Capability.SUMMARIZATION)).toEqual({ kind: 'not-ready' });
    const odd = { ...fake('odd', 'LOCAL', 1), get executionLocality(): AiExecutionLocality { throw new Error('x'); } } as AiProvider;
    const passing: ProviderSelector = { select: async () => odd };
    expect(await selectRequiredLocalProvider(passing, Capability.SUMMARIZATION)).toEqual({ kind: 'not-ready' });
  });

  it('a selector whose re-check says no (or throws) refuses dispatch to a LOCAL provider', () => {
    const local = fake('local', 'LOCAL', 10);
    const no: ProviderSelector = { select: async () => local, isStillEligible: () => false };
    const boom: ProviderSelector = {
      select: async () => local,
      isStillEligible: () => {
        throw new Error('x');
      },
    };
    const yes: ProviderSelector = { select: async () => local };
    expect(isRequiredLocalDispatchAllowed(no, Capability.SUMMARIZATION, {}, local)).toBe(false);
    expect(isRequiredLocalDispatchAllowed(boom, Capability.SUMMARIZATION, {}, local)).toBe(false);
    expect(isRequiredLocalDispatchAllowed(yes, Capability.SUMMARIZATION, {}, local)).toBe(true);
  });
});
