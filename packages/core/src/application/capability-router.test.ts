import { describe, expect, it } from 'vitest';
import { CapabilityRouter } from './capability-router';
import { AiProviderManager } from './ai-provider-manager';
import { AiFailureKind, Capability } from '../domain';
import { AiProviderError } from '../errors';
import type { AiCapabilityDescriptor } from '../ports';
import type { AiProvider } from '../ports';

const provider = (
  id: string,
  capabilities: AiCapabilityDescriptor[],
  available = true,
): AiProvider => ({
  id,
  capabilities,
  isAvailable: async () => available,
  execute: async () => ({ text: '' }),
});

describe('CapabilityRouter', () => {
  it('selects the highest-priority available provider for the capability', async () => {
    const a = provider('a', [{ capability: Capability.GENERAL_CHAT, priority: 50 }]);
    const b = provider('b', [{ capability: Capability.GENERAL_CHAT, priority: 100 }]);
    const router = new CapabilityRouter(new AiProviderManager([a, b]));
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('b');
  });

  it('skips unavailable providers even if higher priority', async () => {
    const a = provider('a', [{ capability: Capability.GENERAL_CHAT, priority: 100 }], false);
    const b = provider('b', [{ capability: Capability.GENERAL_CHAT, priority: 50 }], true);
    const router = new CapabilityRouter(new AiProviderManager([a, b]));
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('b');
  });

  it('throws when no available provider serves the capability', async () => {
    const a = provider('a', [{ capability: Capability.GENERAL_CHAT, priority: 100 }]);
    const router = new CapabilityRouter(new AiProviderManager([a]));
    await expect(router.select(Capability.CODE_IMPLEMENTATION)).rejects.toThrow();
  });

  it('re-probes a provider after its execution failed UNAVAILABLE instead of reusing the cached ready probe', async () => {
    let up = true;
    let probes = 0;
    const flaky: AiProvider = {
      id: 'local',
      capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 100 }],
      isAvailable: async () => {
        probes += 1;
        return up;
      },
      execute: async () => {
        throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'daemon stopped');
      },
    };
    const fallback = provider('claude', [{ capability: Capability.GENERAL_CHAT, priority: 50 }]);
    const router = new CapabilityRouter(new AiProviderManager([flaky, fallback], { availabilityTtlMs: 30_000 }));

    const first = await router.select(Capability.GENERAL_CHAT);
    expect(first.id).toBe('local');
    up = false;
    // still cached ready: selected again until an execution failure clears the entry
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('local');
    await expect(first.execute({ capability: Capability.GENERAL_CHAT, prompt: 'x' })).rejects.toThrow('daemon stopped');
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('claude');
    expect(probes).toBe(2);
  });

  it('keeps the cached probe when execution fails for another reason', async () => {
    let probes = 0;
    const p: AiProvider = {
      id: 'local',
      capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 100 }],
      isAvailable: async () => {
        probes += 1;
        return true;
      },
      execute: async () => {
        throw new AiProviderError(AiFailureKind.TIMEOUT, 'slow');
      },
    };
    const router = new CapabilityRouter(new AiProviderManager([p], { availabilityTtlMs: 30_000 }));
    const selected = await router.select(Capability.GENERAL_CHAT);
    await expect(selected.execute({ capability: Capability.GENERAL_CHAT, prompt: 'x' })).rejects.toThrow('slow');
    await router.select(Capability.GENERAL_CHAT);
    expect(probes).toBe(1);
  });
});
