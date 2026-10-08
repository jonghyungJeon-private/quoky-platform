import type { Capability, IsoTimestamp } from '../domain';
import type { AiProvider, Logger } from '../ports';
import { now } from '../util/clock';

/** Availability probes shell out to CLIs, so results are reused for this long. */
export const DEFAULT_AVAILABILITY_TTL_MS = 30_000;
/**
 * Upper bound for the re-probe interval of a provider that keeps answering "not ready". The interval starts at the TTL
 * and doubles per consecutive "not ready" answer up to this cap, so a provider whose daemon comes up later (an Ollama
 * app that starts after the service at login) is picked up within this long, without a restart.
 */
export const DEFAULT_NOT_READY_BACKOFF_CAP_MS = 120_000;
/**
 * How long a routing decision waits for the re-probe of a "not ready" provider before it answers with the cached
 * "not ready" and lets the probe finish in the background. A fast probe (the daemon is up again) is used at once; a slow
 * one (a CLI waiting for a daemon that is down) never stalls a turn by more than this.
 */
export const DEFAULT_NOT_READY_REPROBE_GRACE_MS = 500;

export interface AiProviderManagerOptions {
  /** How long a probe result is reused. `0` disables caching. */
  availabilityTtlMs?: number;
  /** Cap for the backed-off re-probe interval of a provider that keeps answering "not ready". */
  notReadyBackoffCapMs?: number;
  /** How long a routing decision waits for a "not ready" provider's re-probe (see the default). */
  notReadyReprobeGraceMs?: number;
  clock?: () => IsoTimestamp;
  /** Receives one `provider became ready` line when a provider that answered "not ready" answers ready. */
  logger?: Logger;
}

interface ProbeEntry {
  settled: boolean;
  checkedAtMs: number;
  result: Promise<boolean>;
  /** The settled answer (set together with `settled`). */
  ready?: boolean;
}

/** Longest exponent used for the backoff (the cap bounds the interval long before this). */
const MAX_BACKOFF_DOUBLINGS = 16;

const NO_OP_LOGGER: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Holds the SET of AiProviders injected by the composition root and answers
 * availability/capability questions. It does NOT know the concrete classes —
 * it only sees the AiProvider interface, so the fallback policy stays
 * data-driven (priorities advertised by providers), never hardcoded here.
 *
 * Readiness is re-probed lazily at selection time: a ready answer is reused for the TTL, a "not ready" answer for a
 * backed-off interval (TTL, doubling, capped). The re-probe of a "not ready" provider waits at most a short grace and
 * otherwise finishes in the background, so a daemon that is down costs a turn nothing beyond that grace, and a daemon
 * that comes up later is picked up without a restart.
 */
export class AiProviderManager {
  private readonly ttlMs: number;
  private readonly backoffCapMs: number;
  private readonly graceMs: number;
  private readonly clock: () => IsoTimestamp;
  private readonly logger: Logger;
  private readonly probes = new Map<AiProvider, ProbeEntry>();
  /** Background re-probes of "not ready" providers (single-flight per provider). */
  private readonly refreshes = new Map<AiProvider, Promise<boolean>>();
  /** Consecutive "not ready" answers per provider; drives the backoff. */
  private readonly notReadyStreak = new Map<AiProvider, number>();
  /** The last settled answer per provider; survives {@link invalidate} so a later transition is still logged once. */
  private readonly lastKnown = new Map<AiProvider, boolean>();

  constructor(
    private readonly providers: readonly AiProvider[],
    options: AiProviderManagerOptions = {},
  ) {
    this.ttlMs = options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
    this.backoffCapMs = Math.max(this.ttlMs, options.notReadyBackoffCapMs ?? DEFAULT_NOT_READY_BACKOFF_CAP_MS);
    this.graceMs = Math.max(0, options.notReadyReprobeGraceMs ?? DEFAULT_NOT_READY_REPROBE_GRACE_MS);
    this.clock = options.clock ?? now;
    this.logger = options.logger ?? NO_OP_LOGGER;
  }

  all(): readonly AiProvider[] {
    return this.providers;
  }

  /** Providers that currently pass their health/auth probe (cached; see the class comment). */
  async available(): Promise<AiProvider[]> {
    return this.readyAmong(this.providers);
  }

  /**
   * Available providers that advertise support for a capability. Only those providers are probed, so selecting one
   * capability never waits on another capability's (possibly slow) probe.
   */
  async availableFor(capability: Capability): Promise<AiProvider[]> {
    return this.readyAmong(this.providers.filter((p) => p.capabilities.some((c) => c.capability === capability)));
  }

  /**
   * The given providers that currently pass their probe (cached), in the given order. Only these are
   * probed, so a provider the selection policy made ineligible spawns nothing (ADR-0092 amendment, runtime switching).
   */
  async readyAmong(providers: readonly AiProvider[]): Promise<AiProvider[]> {
    const checks = await Promise.all(providers.map(async (p) => ({ p, ok: await this.cachedProbe(p) })));
    return checks.filter((c) => c.ok).map((c) => c.p);
  }

  /** Whether one provider currently passes its probe (cached); read-only status displays use it. */
  isReady(provider: AiProvider): Promise<boolean> {
    return this.cachedProbe(provider);
  }

  /**
   * Forget a provider's cached probe so the next routing decision re-probes it. Called after an execution
   * failed with UNAVAILABLE, so a daemon that stopped after a positive probe is not selected for the rest
   * of the TTL (ADR-0092: no execution-time fallback, selection-time readiness only).
   */
  invalidate(provider: AiProvider): void {
    this.probes.delete(provider);
  }

  private nowMs(): number {
    return Date.parse(this.clock());
  }

  /** The re-probe interval for a provider whose last answer was "not ready": TTL, doubling per answer, capped. */
  private notReadyIntervalMs(p: AiProvider): number {
    const streak = Math.max(1, this.notReadyStreak.get(p) ?? 1);
    const doublings = Math.min(streak - 1, MAX_BACKOFF_DOUBLINGS);
    return Math.min(this.ttlMs * 2 ** doublings, this.backoffCapMs);
  }

  /** In-flight probes are shared too, so concurrent routing does not spawn duplicate CLIs. */
  private cachedProbe(p: AiProvider): Promise<boolean> {
    const startedAtMs = this.nowMs();
    const cached = this.probes.get(p);
    if (cached !== undefined && !cached.settled) return cached.result;
    if (cached !== undefined && this.ttlMs > 0) {
      const ageMs = startedAtMs - cached.checkedAtMs;
      if (cached.ready === true) {
        if (ageMs < this.ttlMs) return cached.result;
      } else {
        if (ageMs < this.notReadyIntervalMs(p)) return cached.result;
        return this.reprobeNotReady(p);
      }
    }
    const entry: ProbeEntry = {
      settled: false,
      checkedAtMs: startedAtMs,
      result: this.safeProbe(p).then((ok) => {
        entry.settled = true;
        entry.ready = ok;
        entry.checkedAtMs = this.nowMs();
        this.record(p, ok);
        return ok;
      }),
    };
    this.probes.set(p, entry);
    return entry.result;
  }

  /**
   * Re-probe a provider whose cached answer is "not ready" without letting a slow probe stall routing: the caller waits
   * at most the grace, then gets the cached "not ready" while the probe finishes in the background and updates the
   * cache for the next decision.
   */
  private reprobeNotReady(p: AiProvider): Promise<boolean> {
    let refresh = this.refreshes.get(p);
    if (refresh === undefined) {
      const pending = this.safeProbe(p).then((ok) => {
        this.probes.set(p, { settled: true, ready: ok, checkedAtMs: this.nowMs(), result: Promise.resolve(ok) });
        this.refreshes.delete(p);
        this.record(p, ok);
        return ok;
      });
      this.refreshes.set(p, pending);
      refresh = pending;
    }
    if (this.graceMs === 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.graceMs);
      timer.unref?.();
      void refresh.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  private record(p: AiProvider, ok: boolean): void {
    const previous = this.lastKnown.get(p);
    this.lastKnown.set(p, ok);
    this.notReadyStreak.set(p, ok ? 0 : (this.notReadyStreak.get(p) ?? 0) + 1);
    if (ok && previous === false) {
      this.logger.info('provider became ready', { provider: p.id });
    }
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
