import type { Capability, IsoTimestamp } from '../domain';
import type { AiProvider } from '../ports';
import { now } from '../util/clock';

/** Availability probes shell out to CLIs, so results are reused for this long. */
export const DEFAULT_AVAILABILITY_TTL_MS = 30_000;

export interface AiProviderManagerOptions {
  /** How long a probe result is reused. `0` disables caching. */
  availabilityTtlMs?: number;
  clock?: () => IsoTimestamp;
}

interface ProbeEntry {
  settled: boolean;
  checkedAtMs: number;
  result: Promise<boolean>;
}

/**
 * Holds the SET of AiProviders injected by the composition root and answers
 * availability/capability questions. It does NOT know the concrete classes —
 * it only sees the AiProvider interface, so the fallback policy stays
 * data-driven (priorities advertised by providers), never hardcoded here.
 */
export class AiProviderManager {
  private readonly ttlMs: number;
  private readonly clock: () => IsoTimestamp;
  private readonly probes = new Map<AiProvider, ProbeEntry>();

  constructor(
    private readonly providers: readonly AiProvider[],
    options: AiProviderManagerOptions = {},
  ) {
    this.ttlMs = options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
    this.clock = options.clock ?? now;
  }

  all(): readonly AiProvider[] {
    return this.providers;
  }

  /** Providers that currently pass their health/auth probe (cached for the TTL). */
  async available(): Promise<AiProvider[]> {
    const checks = await Promise.all(
      this.providers.map(async (p) => ({ p, ok: await this.cachedProbe(p) })),
    );
    return checks.filter((c) => c.ok).map((c) => c.p);
  }

  /** Available providers that advertise support for a capability. */
  async availableFor(capability: Capability): Promise<AiProvider[]> {
    const available = await this.available();
    return available.filter((p) => p.capabilities.some((c) => c.capability === capability));
  }

  private nowMs(): number {
    return Date.parse(this.clock());
  }

  /** In-flight probes are shared too, so concurrent routing does not spawn duplicate CLIs. */
  private cachedProbe(p: AiProvider): Promise<boolean> {
    const startedAtMs = this.nowMs();
    const cached = this.probes.get(p);
    if (
      cached &&
      (!cached.settled || (this.ttlMs > 0 && startedAtMs - cached.checkedAtMs < this.ttlMs))
    ) {
      return cached.result;
    }
    const entry: ProbeEntry = {
      settled: false,
      checkedAtMs: startedAtMs,
      result: this.safeProbe(p).then((ok) => {
        entry.settled = true;
        entry.checkedAtMs = this.nowMs();
        return ok;
      }),
    };
    this.probes.set(p, entry);
    return entry.result;
  }

  private async safeProbe(p: AiProvider): Promise<boolean> {
    try {
      return await p.isAvailable();
    } catch {
      // A throwing probe is treated as unavailable rather than crashing routing.
      return false;
    }
  }
}
