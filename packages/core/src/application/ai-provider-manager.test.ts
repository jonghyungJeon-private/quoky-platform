import { describe, expect, it } from 'vitest';
import { Capability } from '../domain';
import { ProviderProbeIndeterminateError } from '../errors';
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
  /** Detach the oldest pending probe so it can be settled later, out of order. */
  takePending(): (ok: boolean) => void {
    const resolve = this.pending.shift();
    if (resolve === undefined) throw new Error('no pending probe');
    return resolve;
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
    expect(lines).toEqual([
      { message: 'provider became ready', fields: { provider: 'ollama-embed' } },
      { message: 'provider became unavailable', fields: { provider: 'ollama-embed', reason: 'NOT_READY' } },
      { message: 'provider became ready', fields: { provider: 'ollama-embed' } },
    ]);
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
    manager.invalidate(provider); // recorded "not ready" (execution UNAVAILABLE), then the re-probe agrees: streak 2
    expect(await manager.available()).toEqual([]);
    provider.availability = true;
    time.advance(60_000);
    expect(await manager.available()).toEqual([provider]);
    expect(lines).toEqual([
      { message: 'provider became unavailable', fields: { provider: 'ollama', reason: 'EXECUTION_UNAVAILABLE' } },
      { message: 'provider became ready', fields: { provider: 'ollama' } },
    ]);
  });
  it('a background refresh that lands after an invalidation never overwrites the newer answer', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new SlowProvider('ollama', chat);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger, notReadyReprobeGraceMs: 1 });

    // cache "not ready"
    const startup = manager.available();
    provider.settle(false);
    expect(await startup).toEqual([]);

    // the backoff window elapses: a background refresh starts and stays in flight
    time.advance(30_000);
    expect(await manager.available()).toEqual([]);
    expect(provider.probeCount).toBe(2);
    const staleRefresh = provider.takePending();

    // an execution failed UNAVAILABLE: invalidate; the next decision starts a fresh probe, which answers "not ready"
    manager.invalidate(provider);
    const newer = manager.available();
    expect(provider.probeCount).toBe(3);
    provider.settle(false);
    expect(await newer).toEqual([]);

    // the old refresh finally answers "ready": discarded, nothing is cached as ready and nothing is logged
    staleRefresh(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await manager.available()).toEqual([]);
    expect(provider.probeCount).toBe(3); // the newer "not ready" is still within its backoff window
    expect(lines).toEqual([]);
  });

  it('a blocking probe in flight across an invalidation is discarded; its callers read the current answer', async () => {
    const time = manualClock();
    const provider = new SlowProvider('ollama', chat);
    const manager = new AiProviderManager([provider], { clock: time.clock });

    const inFlight = manager.available();
    manager.invalidate(provider);
    const fresh = manager.available();
    expect(provider.probeCount).toBe(2);
    const [stale, current] = [provider.takePending(), provider.takePending()];
    current(false);
    expect(await fresh).toEqual([]);
    stale(true);
    expect(await inFlight).toEqual([]);
    expect(await manager.available()).toEqual([]);
    expect(provider.probeCount).toBe(2);
  });

  it('never runs overlapping probes for one provider without an invalidation', async () => {
    const time = manualClock();
    const provider = new SlowProvider('ollama', chat);
    const manager = new AiProviderManager([provider], { clock: time.clock, notReadyReprobeGraceMs: 1 });

    // blocking probe: concurrent decisions share it
    const first = Promise.all([manager.available(), manager.availableFor(Capability.GENERAL_CHAT), manager.isReady(provider)]);
    expect(provider.probeCount).toBe(1);
    provider.settle(false);
    await first;

    // background refresh: decisions during it (even after further time passes) share it
    time.advance(30_000);
    await manager.available();
    time.advance(30_000);
    await manager.available();
    await manager.isReady(provider);
    expect(provider.probeCount).toBe(2);
    provider.settle(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await manager.available()).toEqual([provider]);
    expect(provider.probeCount).toBe(2);
  });
});

describe('AiProviderManager definitive vs indeterminate probes (live QA D16)', () => {
  /** A provider whose probe can be made to time out (indeterminate) instead of answering. */
  class TimingOutProvider extends FakeProvider {
    timesOut = false;
    override async isAvailable(): Promise<boolean> {
      if (this.timesOut) {
        this.probeCount += 1;
        throw new ProviderProbeIndeterminateError('probe timed out');
      }
      return super.isAvailable();
    }
  }
  const embedding = [{ capability: Capability.EMBEDDING, priority: 100 }] as const;

  it('a timed-out probe of a ready provider keeps it ready: no "not ready", no log, no backoff', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new TimingOutProvider('ollama-embed-cli', embedding, true);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger });
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([provider]);

    provider.timesOut = true; // a loaded host: `ollama list` exceeds its bound
    time.advance(30_000);
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([provider]);
    expect(await manager.isReady(provider)).toBe(true);
    expect(provider.probeCount).toBe(2);
    // The kept answer is re-checked after the normal TTL, not after a not-ready backoff.
    time.advance(29_999);
    await manager.availableFor(Capability.EMBEDDING);
    expect(provider.probeCount).toBe(2);
    time.advance(1);
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([provider]);
    expect(provider.probeCount).toBe(3);
    expect(lines).toEqual([]);

    // The first definitive "not ready" is logged once, with its reason.
    provider.timesOut = false;
    provider.availability = false;
    time.advance(30_000);
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([]);
    expect(lines).toEqual([
      { message: 'provider became unavailable', fields: { provider: 'ollama-embed-cli', reason: 'NOT_READY' } },
    ]);
  });

  it('a timed-out re-probe of a not-ready provider keeps it not ready without growing the backoff', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new TimingOutProvider('ollama', chat, false);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger });
    await manager.available(); // definitive "not ready", streak 1 -> next after 30 s
    provider.timesOut = true;
    time.advance(30_000);
    expect(await manager.available()).toEqual([]);
    expect(provider.probeCount).toBe(2);
    // Still streak 1: the next re-probe is 30 s later (a recorded "not ready" would have doubled it to 60 s).
    provider.timesOut = false;
    provider.availability = true;
    time.advance(30_000);
    expect(await manager.available()).toEqual([provider]);
    expect(provider.probeCount).toBe(3);
    expect(lines.map((line) => line.message)).toEqual(['provider became ready']);
  });

  it('a timed-out first probe reads "not ready" for that decision but is not cached', async () => {
    const time = manualClock();
    const provider = new TimingOutProvider('ollama', chat, true);
    provider.timesOut = true;
    const manager = new AiProviderManager([provider], { clock: time.clock });
    expect(await manager.available()).toEqual([]);
    provider.timesOut = false;
    expect(await manager.available()).toEqual([provider]); // probed again at once: nothing was cached
    expect(provider.probeCount).toBe(2);
  });

  it('a probe in flight across an invalidation hands its callers the fresh answer, not a "not ready"', async () => {
    const time = manualClock();
    const provider = new SlowProvider('ollama-embed-cli', embedding);
    const manager = new AiProviderManager([provider], { clock: time.clock });
    const inFlight = manager.availableFor(Capability.EMBEDDING);
    manager.invalidate(provider);
    const [stale] = [provider.takePending()];
    stale(true); // discarded: the caller follows the current generation's probe
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider.probeCount).toBe(2);
    provider.settle(true);
    expect(await inFlight).toEqual([provider]);
  });

  it('after an execution failed UNAVAILABLE, a timed-out probe keeps "not ready" (never the earlier ready), with backoff', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new TimingOutProvider('ollama-embed-cli', embedding, true);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger });
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([provider]);

    manager.invalidate(provider); // the router saw execute() fail UNAVAILABLE
    provider.timesOut = true;
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([]);
    expect(await manager.isReady(provider)).toBe(false);
    expect(provider.probeCount).toBe(2);
    // The "not ready" answer is backed off like any other (no re-probe before the interval).
    time.advance(29_999);
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([]);
    expect(provider.probeCount).toBe(2);
    // A definitive ready probe brings it back.
    provider.timesOut = false;
    time.advance(60_001);
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([provider]);
    expect(lines).toEqual([
      { message: 'provider became unavailable', fields: { provider: 'ollama-embed-cli', reason: 'EXECUTION_UNAVAILABLE' } },
      { message: 'provider became ready', fields: { provider: 'ollama-embed-cli' } },
    ]);
  });

  it('a throwing probe (not indeterminate) is a definitive "not ready" with reason PROBE_FAILED', async () => {
    const time = manualClock();
    const { logger, lines } = recordingLogger();
    const provider = new FakeProvider('codex', chat, true);
    const manager = new AiProviderManager([provider], { clock: time.clock, logger });
    await manager.available();
    provider.availability = new Error('spawn ENOENT');
    time.advance(30_000);
    expect(await manager.available()).toEqual([]);
    expect(lines).toEqual([{ message: 'provider became unavailable', fields: { provider: 'codex', reason: 'PROBE_FAILED' } }]);
  });

  it('invalidating one provider never touches another provider\'s cached answer', async () => {
    const time = manualClock();
    const chatProvider = new FakeProvider('codex', chat, true);
    const embed = new FakeProvider('ollama-embed-cli', embedding, true);
    const manager = new AiProviderManager([chatProvider, embed], { clock: time.clock });
    await manager.available();
    manager.invalidate(chatProvider);
    embed.availability = false; // would read "not ready" if it were re-probed
    expect(await manager.availableFor(Capability.EMBEDDING)).toEqual([embed]);
    expect(embed.probeCount).toBe(1);
    expect(chatProvider.probeCount).toBe(1);
    await manager.availableFor(Capability.GENERAL_CHAT);
    expect(chatProvider.probeCount).toBe(2);
  });
});
