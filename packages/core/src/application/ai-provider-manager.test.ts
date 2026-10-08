import { describe, expect, it } from 'vitest';
import { Capability } from '../domain';
import type { AiProvider, LogFields, Logger } from '../ports';
import { AiProviderManager, DEFAULT_NOT_READY_BACKOFF_CAP_MS } from './ai-provider-manager';

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
  it('probes only the providers that advertise the requested capability', async () => {
    const chatProvider = new FakeProvider('chat', chat);
    const codeProvider = new FakeProvider('code', code);
    const manager = new AiProviderManager([chatProvider, codeProvider], { clock: manualClock().clock });

    expect(await manager.availableFor(Capability.CODE_IMPLEMENTATION)).toEqual([codeProvider]);
    expect([chatProvider.probeCount, codeProvider.probeCount]).toEqual([0, 1]);
  });
});

function recordingLogger(): { logger: Logger; lines: Array<{ message: string; fields?: LogFields }> } {
  const lines: Array<{ message: string; fields?: LogFields }> = [];
  const push = (message: string, fields?: LogFields) => {
    lines.push(fields === undefined ? { message } : { message, fields });
  };
  return { logger: { info: push, warn: push, error: push }, lines };
}

/** A provider whose probe stays pending until `settle` is called. */
class SlowProvider implements AiProvider {
  probeCount = 0;
  private pending: Array<(ok: boolean) => void> = [];
  constructor(
    readonly id: string,
    readonly capabilities: AiProvider['capabilities'],
  ) {}
  isAvailable(): Promise<boolean> {
    this.probeCount += 1;
    return new Promise((resolve) => this.pending.push(resolve));
  }
  settle(ok: boolean): void {
    for (const resolve of this.pending.splice(0)) resolve(ok);
  }
  async execute(): Promise<never> {
    throw new Error('not used');
  }
}

describe('AiProviderManager readiness after a not-ready start (no restart)', () => {
  it('re-probes a not-ready provider with a doubling interval up to the cap', async () => {
    const time = manualClock();
    const provider = new FakeProvider('ollama', chat, false);
    const manager = new AiProviderManager([provider], { clock: time.clock });

    await manager.available(); // t=0, streak 1 -> next after 30 s
    const probeTimes: number[] = [];
    for (let t = 1_000; t <= 600_000; t += 1_000) {
      time.advance(1_000);
      const before = provider.probeCount;
      await manager.available();
      if (provider.probeCount > before) probeTimes.push(t);
    }
    // 30 s, then +60 s, +120 s, then capped at 120 s
    expect(probeTimes.slice(0, 6)).toEqual([30_000, 90_000, 210_000, 330_000, 450_000, 570_000]);
    expect(DEFAULT_NOT_READY_BACKOFF_CAP_MS).toBe(120_000);
  });

  it('becomes ready once the daemon is up, logs the transition once and resets the backoff', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new FakeProvider('ollama-embed', chat, false);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger });

    expect(await manager.available()).toEqual([]);
    time.advance(30_000);
    expect(await manager.available()).toEqual([]); // streak 2 -> next after 60 s
    provider.availability = true;
    time.advance(59_999);
    expect(await manager.available()).toEqual([]); // still within the backed-off interval
    time.advance(1);
    expect(await manager.available()).toEqual([provider]);
    expect(lines).toEqual([{ message: 'provider became ready', fields: { provider: 'ollama-embed' } }]);

    // Staying ready (TTL re-probes) logs nothing more; a later drop restarts the backoff at the TTL.
    time.advance(30_000);
    await manager.available();
    provider.availability = false;
    time.advance(30_000);
    expect(await manager.available()).toEqual([]);
    provider.availability = true;
    time.advance(30_000);
    expect(await manager.available()).toEqual([provider]);
    expect(lines.map((line) => line.message)).toEqual(['provider became ready', 'provider became ready']);
  });

  it('does not log a provider that is ready from the start', async () => {
    const { logger, lines } = recordingLogger();
    const manager = new AiProviderManager([new FakeProvider('claude', chat)], { clock: manualClock().clock, logger });
    await manager.available();
    expect(lines).toEqual([]);
  });

  it('a slow re-probe of a not-ready provider costs a turn at most the grace, then lands in the background', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new SlowProvider('ollama', chat);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger, notReadyReprobeGraceMs: 5 });

    const startup = manager.available();
    provider.settle(false);
    expect(await startup).toEqual([]);

    time.advance(30_000);
    // The daemon is still starting: the re-probe hangs. Routing answers "not ready" after the grace.
    expect(await manager.available()).toEqual([]);
    expect(await manager.availableFor(Capability.GENERAL_CHAT)).toEqual([]);
    expect(provider.probeCount).toBe(2); // single-flight: the second decision shares the background probe

    provider.settle(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await manager.available()).toEqual([provider]);
    expect(provider.probeCount).toBe(2);
    expect(lines.map((line) => line.message)).toEqual(['provider became ready']);
  });

  it('uses a fast re-probe answer at once', async () => {
    const time = manualClock();
    const provider = new FakeProvider('ollama', chat, false);
    const manager = new AiProviderManager([provider], { clock: time.clock, notReadyReprobeGraceMs: 60_000 });
    await manager.available();
    provider.availability = true;
    time.advance(30_000);
    expect(await manager.available()).toEqual([provider]);
  });

  it('logs the transition after an invalidated ready provider comes back', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new FakeProvider('ollama', chat, true);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger });
    await manager.available();
    provider.availability = false;
    manager.invalidate(provider);
    expect(await manager.available()).toEqual([]);
    provider.availability = true;
    time.advance(30_000);
    expect(await manager.available()).toEqual([provider]);
    expect(lines.map((line) => line.message)).toEqual(['provider became ready']);
  });
});
