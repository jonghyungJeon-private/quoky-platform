import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CapabilityRouter } from './capability-router';
import { AiProviderManager } from './ai-provider-manager';
import { Capability } from '../domain';
import { NoProviderAvailableError } from '../errors';
import type {
  AiCapabilityDescriptor,
  AiProvider,
  ProviderPreference,
  ProviderSelectionContext,
  ProviderSelectionPolicy,
} from '../ports';

/**
 * ADR-0092 amendment (runtime switching): the router consults the owner's `ProviderSelectionPolicy` with the capability
 * and the request context, and applies its answer as DATA — eligibility by opaque key, then the listed order, then the
 * advertised priority. Readiness still decides availability. Without a policy, or with a `null` answer, selection is
 * exactly the legacy priority path.
 */

function fixture() {
  const probes = { calls: [] as string[] };
  const state = { local: true, cloudA: true, cloudB: true };
  const mk = (id: string, caps: AiCapabilityDescriptor[], key: keyof typeof state) => ({
    id,
    capabilities: caps,
    isAvailable: async () => {
      probes.calls.push(id);
      return state[key];
    },
    execute: async () => ({ text: id }),
  }) satisfies AiProvider;
  // Priorities as the real adapters advertise them: the local and the second cloud provider outrank the first for chat.
  const cloudA = mk('p-cloud-a', [
    { capability: Capability.GENERAL_CHAT, priority: 50 },
    { capability: Capability.CODE_IMPLEMENTATION, priority: 50 },
  ], 'cloudA');
  const local = mk('p-local', [
    { capability: Capability.GENERAL_CHAT, priority: 100 },
    { capability: Capability.CODE_IMPLEMENTATION, priority: 40 },
  ], 'local');
  const cloudB = mk('p-cloud-b', [{ capability: Capability.GENERAL_CHAT, priority: 100 }], 'cloudB');
  return { cloudA, local, cloudB, state, probes, all: [cloudA, local, cloudB] };
}

class FixedPolicy implements ProviderSelectionPolicy {
  readonly seen: Array<{ capability: Capability; context: ProviderSelectionContext }> = [];
  constructor(private readonly answer: (capability: Capability, context: ProviderSelectionContext) => ProviderPreference | null) {}
  async preferenceFor(capability: Capability, context: ProviderSelectionContext): Promise<ProviderPreference | null> {
    this.seen.push({ capability, context });
    return this.answer(capability, context);
  }
}

describe('CapabilityRouter with a ProviderSelectionPolicy (ADR-0092 amendment, runtime switching)', () => {
  it('a listed preference wins over advertised priority, and the context reaches the policy', async () => {
    const f = fixture();
    const policy = new FixedPolicy((_, context) => ({
      eligible: context.sessionId === 's-2' ? ['p-cloud-b', 'p-cloud-a'] : ['p-cloud-a'],
      order: 'listed',
    }));
    const router = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }), policy);
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('p-cloud-a');
    expect((await router.select(Capability.GENERAL_CHAT, { sessionId: 's-2' })).id).toBe('p-cloud-b');
    expect(policy.seen.map((entry) => entry.context)).toEqual([{}, { sessionId: 's-2' }]);
  });

  it('only eligible providers are probed; an unready first choice falls back to the next listed one', async () => {
    const f = fixture();
    f.state.cloudB = false;
    const router = new CapabilityRouter(
      new AiProviderManager(f.all, { availabilityTtlMs: 0 }),
      new FixedPolicy(() => ({ eligible: ['p-cloud-b', 'p-cloud-a'], order: 'listed' })),
    );
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('p-cloud-a');
    expect(f.probes.calls.sort()).toEqual(['p-cloud-a', 'p-cloud-b']);
  });

  it('a `priority` preference filters by key and keeps the advertised order among the eligible', async () => {
    const f = fixture();
    const router = new CapabilityRouter(
      new AiProviderManager(f.all, { availabilityTtlMs: 0 }),
      new FixedPolicy(() => ({ eligible: ['p-cloud-a', 'p-local'], order: 'priority' })),
    );
    expect((await router.select(Capability.CODE_IMPLEMENTATION)).id).toBe('p-cloud-a');
    f.state.cloudA = false;
    expect((await router.select(Capability.CODE_IMPLEMENTATION)).id).toBe('p-local');
  });

  it('an empty eligible list (e.g. images off) selects nothing, even when providers are ready', async () => {
    const f = fixture();
    const router = new CapabilityRouter(
      new AiProviderManager(f.all, { availabilityTtlMs: 0 }),
      new FixedPolicy(() => ({ eligible: [], order: 'listed' })),
    );
    await expect(router.select(Capability.GENERAL_CHAT)).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(f.probes.calls).toEqual([]);
  });

  it('a key that does not advertise the capability is never selected for it', async () => {
    const f = fixture();
    const router = new CapabilityRouter(
      new AiProviderManager(f.all, { availabilityTtlMs: 0 }),
      new FixedPolicy(() => ({ eligible: ['p-cloud-b'], order: 'listed' })),
    );
    await expect(router.select(Capability.CODE_IMPLEMENTATION)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('a `null` answer, and no policy at all, are the legacy priority path', async () => {
    const f = fixture();
    const withNull = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }), new FixedPolicy(() => null));
    const without = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }));
    // Priority 100 tie between p-local and p-cloud-b: registration order wins.
    expect((await withNull.select(Capability.GENERAL_CHAT)).id).toBe('p-local');
    expect((await without.select(Capability.GENERAL_CHAT)).id).toBe('p-local');
    expect((await withNull.select(Capability.CODE_IMPLEMENTATION)).id).toBe('p-cloud-a');
  });

  it('isStillEligible delegates to the policy synchronously and fails closed', async () => {
    const f = fixture();
    const live = { keys: ['p-cloud-b'] as string[] };
    const policy: ProviderSelectionPolicy = {
      preferenceFor: async () => ({ eligible: live.keys, order: 'listed' }),
      isEligible: (_capability, _context, key) => live.keys.includes(key),
    };
    const router = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }), policy);
    const chosen = await router.select(Capability.GENERAL_CHAT, { sessionId: 's', actorId: 'a' });
    expect(router.isStillEligible(Capability.GENERAL_CHAT, { sessionId: 's', actorId: 'a' }, chosen)).toBe(true);
    live.keys = [];
    expect(router.isStillEligible(Capability.GENERAL_CHAT, { sessionId: 's', actorId: 'a' }, chosen)).toBe(false);
    // Not advertising the capability is never eligible; a throwing policy is "no"; no check at all is "yes".
    expect(router.isStillEligible(Capability.CODE_IMPLEMENTATION, {}, chosen)).toBe(false);
    const throwing = new CapabilityRouter(new AiProviderManager(f.all), {
      preferenceFor: async () => null,
      isEligible: () => {
        throw new Error('x');
      },
    });
    expect(throwing.isStillEligible(Capability.GENERAL_CHAT, {}, f.local)).toBe(false);
    expect(new CapabilityRouter(new AiProviderManager(f.all)).isStillEligible(Capability.GENERAL_CHAT, {}, f.local)).toBe(true);
  });

  // ADR-0116 D3: the selection source travels with the resolved provider, from the same policy answer.
  it('resolve reports OWNER_SELECTED only for the provider carrying the policy\'s ownerSelectedKey', async () => {
    const f = fixture();
    const owner = new FixedPolicy(() => ({ eligible: ['p-cloud-b', 'p-cloud-a'], order: 'listed', ownerSelectedKey: 'p-cloud-b' }));
    const router = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }), owner);
    const chosen = await router.resolve(Capability.GENERAL_CHAT, { sessionId: 's', actorId: 'a' });
    expect(chosen.provider.id).toBe('p-cloud-b');
    expect(chosen.source).toBe('OWNER_SELECTED');
    // `select` is `resolve(...).provider`: same provider, same single policy read per call.
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('p-cloud-b');
    expect(owner.seen).toHaveLength(2);

    // The owner's choice is not ready: the selection-time fallback answers, and it is NOT an owner selection.
    f.state.cloudB = false;
    const fallback = await router.resolve(Capability.GENERAL_CHAT);
    expect(fallback.provider.id).toBe('p-cloud-a');
    expect(fallback.source).toBe('NOT_OWNER_SELECTED');
  });

  it('resolve reports NOT_OWNER_SELECTED without an ownerSelectedKey, with a null answer and without a policy', async () => {
    const f = fixture();
    const derived = new CapabilityRouter(
      new AiProviderManager(f.all, { availabilityTtlMs: 0 }),
      new FixedPolicy(() => ({ eligible: ['p-cloud-a'], order: 'listed' })),
    );
    expect(await derived.resolve(Capability.GENERAL_CHAT)).toMatchObject({ source: 'NOT_OWNER_SELECTED' });
    const nullAnswer = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }), new FixedPolicy(() => null));
    expect(await nullAnswer.resolve(Capability.GENERAL_CHAT)).toMatchObject({ source: 'NOT_OWNER_SELECTED' });
    const none = new CapabilityRouter(new AiProviderManager(f.all, { availabilityTtlMs: 0 }));
    expect(await none.resolve(Capability.GENERAL_CHAT)).toMatchObject({ source: 'NOT_OWNER_SELECTED' });
    // A key naming a provider that is not the resolved one (or not registered) never marks another provider.
    const stray = new CapabilityRouter(
      new AiProviderManager(f.all, { availabilityTtlMs: 0 }),
      new FixedPolicy(() => ({ eligible: ['p-cloud-a'], order: 'listed', ownerSelectedKey: 'p-unknown' })),
    );
    expect(await stray.resolve(Capability.GENERAL_CHAT)).toMatchObject({ source: 'NOT_OWNER_SELECTED' });
  });

  it('source scan: the router names no provider and reads `.id` only through the opaque selection key', () => {
    const source = readFileSync(new URL('./capability-router.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/claude|codex|ollama|anthropic|openai/iu);
    // Exactly one `.id` read, inside `selectionKeyOf`, and no comparison of anything with a string literal.
    expect(source.match(/\.id\b/gu)).toHaveLength(1);
    expect(source).toMatch(/function selectionKeyOf\(provider: AiProvider\): string \{\n\s+return provider\.id;\n\}/u);
    // ADR-0116 D3: the ONE permitted comparison is the resolved provider's key against the policy's own
    // `ownerSelectedKey` (opaque data on both sides, like `eligible.includes`); nothing else is compared with a key.
    const ownerComparison = 'ownerSelectedKey === selectionKeyOf(chosen)';
    expect(source.split(ownerComparison)).toHaveLength(2);
    expect(source.replace(ownerComparison, '')).not.toMatch(
      /selectionKeyOf\([^)]*\)\s*[!=]==|[!=]==\s*selectionKeyOf|\.id\s*[!=]==|[!=]==\s*\w+\.id\b/u,
    );
    // Every string literal in the code (comments stripped) is an import path, a member name or the preference order.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
    const literals = [...code.matchAll(/'([^'\n]*)'/gu)].map((match) => match[1]);
    expect(new Set(literals)).toEqual(
      new Set([
        '../errors', '../domain', '../ports', './ai-provider-manager', 'execute', 'listed', 'function',
        // ADR-0116 D3: the selection-source values.
        'OWNER_SELECTED', 'NOT_OWNER_SELECTED',
      ]),
    );
    const port = readFileSync(new URL('../ports/provider-selection-policy.port.ts', import.meta.url), 'utf8');
    expect(port).not.toMatch(/claude|codex|ollama|anthropic|openai/iu);
  });
});
