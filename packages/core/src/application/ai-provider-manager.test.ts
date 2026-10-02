import { describe, expect, it } from 'vitest';
import { Capability } from '../domain';
import type { AiProvider } from '../ports';
import { AiProviderManager } from './ai-provider-manager';

class FakeProvider implements AiProvider {
  probeCount = 0;
  constructor(
    readonly id: string,
    readonly capabilities: AiProvider['capabilities'],
    public availability: boolean | Error = true,
  ) {}
  async isAvailable(): Promise<boolean> {
    this.probeCount += 1;
    if (this.availability instanceof Error) throw this.availability;
    return this.availability;
  }
  async execute(): Promise<never> {
    throw new Error('not used');
  }
}

/** Manual clock returning ISO timestamps, like the shared `now()` utility. */
function manualClock(startMs = Date.parse('2026-10-02T00:00:00.000Z')) {
  let ms = startMs;
  return {
    clock: () => new Date(ms).toISOString(),
    advance: (by: number) => { ms += by; },
  };
}

const chat = [{ capability: Capability.GENERAL_CHAT, priority: 50 }] as const;
const code = [{ capability: Capability.CODE_IMPLEMENTATION, priority: 50 }] as const;

describe('AiProviderManager availability cache', () => {
  it('does not re-probe within the TTL and re-probes once it elapses', async () => {
    const time = manualClock();
    const provider = new FakeProvider('p1', chat);
    const manager = new AiProviderManager([provider], { clock: time.clock });

    await manager.available();
    time.advance(29_999);
    await manager.available();
    await manager.availableFor(Capability.GENERAL_CHAT);
    expect(provider.probeCount).toBe(1);

    time.advance(1);
    await manager.available();
    expect(provider.probeCount).toBe(2);
  });

  it('serves the cached answer (including unavailability) until expiry, then reflects the change', async () => {
    const time = manualClock();
    const provider = new FakeProvider('p1', chat, false);
    const manager = new AiProviderManager([provider], { clock: time.clock });

    expect(await manager.available()).toEqual([]);
    provider.availability = true;
    time.advance(10_000);
    expect(await manager.available()).toEqual([]); // still cached
    time.advance(20_000);
    expect(await manager.available()).toEqual([provider]);
  });

  it('caches per provider and treats a throwing probe as unavailable (also cached)', async () => {
    const time = manualClock();
    const ok = new FakeProvider('ok', chat);
    const broken = new FakeProvider('broken', code, new Error('not implemented'));
    const manager = new AiProviderManager([ok, broken], { clock: time.clock });

    expect(await manager.available()).toEqual([ok]);
    expect(await manager.availableFor(Capability.CODE_IMPLEMENTATION)).toEqual([]);
    expect([ok.probeCount, broken.probeCount]).toEqual([1, 1]);
  });

  it('shares an in-flight probe between concurrent callers', async () => {
    const provider = new FakeProvider('p1', chat);
    const manager = new AiProviderManager([provider], { clock: manualClock().clock });
    await Promise.all([manager.available(), manager.available(), manager.availableFor(Capability.GENERAL_CHAT)]);
    expect(provider.probeCount).toBe(1);
  });

  it('honours a custom TTL and ttl 0 disables caching', async () => {
    const time = manualClock();
    const short = new FakeProvider('short', chat);
    const none = new FakeProvider('none', chat);
    const shortManager = new AiProviderManager([short], { clock: time.clock, availabilityTtlMs: 1_000 });
    const noCache = new AiProviderManager([none], { clock: time.clock, availabilityTtlMs: 0 });

    await shortManager.available();
    time.advance(1_000);
    await shortManager.available();
    await noCache.available();
    await noCache.available();
    expect([short.probeCount, none.probeCount]).toEqual([2, 2]);
  });

  it('defaults to the shared clock when none is injected', async () => {
    const provider = new FakeProvider('p1', chat);
    const manager = new AiProviderManager([provider]);
    await manager.available();
    await manager.available();
    expect(provider.probeCount).toBe(1);
  });
});
