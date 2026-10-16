// ADR-0123 D6 / ADR-0121 D8: the traffic ledger (a hard call budget) and the rate cap (<= 1 call/s sustained, 4 concurrent)
// for the selector calls of the experiment. No call is made here; the runner asks the gate before each one.

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MIN_INTERVAL_MS = 1000;

export class BudgetExceededError extends Error {
  constructor(readonly budget: number) {
    super(`traffic ledger budget of ${budget} selector calls is exhausted`);
  }
}

/** Counts calls against a fixed budget; `reserve` throws instead of going over. */
export class TrafficLedger {
  private used = 0;
  constructor(readonly budget: number) {
    if (!Number.isInteger(budget) || budget < 0) throw new Error('budget must be a non-negative integer');
  }
  reserve(count = 1): void {
    if (this.used + count > this.budget) throw new BudgetExceededError(this.budget);
    this.used += count;
  }
  get calls(): number {
    return this.used;
  }
  get remaining(): number {
    return this.budget - this.used;
  }
}

export interface RateGateOptions {
  readonly maxConcurrent?: number;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Admission gate: a call starts only when fewer than `maxConcurrent` are in flight and at least `minIntervalMs` has passed
 * since the previous start (so the sustained rate is at most one call per interval). `acquire` resolves to a release function.
 */
export class RateGate {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private inFlight = 0;
  private lastStart: number | undefined;
  private readonly waiters: Array<() => void> = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RateGateOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (this.maxConcurrent < 1 || this.maxConcurrent > DEFAULT_MAX_CONCURRENT) throw new Error('maxConcurrent must be 1..4');
    if (this.minIntervalMs < DEFAULT_MIN_INTERVAL_MS) throw new Error('the rate cap cannot be raised above 1 call/s');
  }

  /** Callers are admitted strictly in arrival order. */
  acquire(): Promise<() => void> {
    const admitted = this.chain.then(async () => {
      while (this.inFlight >= this.maxConcurrent) await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.lastStart !== undefined) {
        const wait = this.lastStart + this.minIntervalMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastStart = this.now();
      this.inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        this.waiters.shift()?.();
      };
    });
    this.chain = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  }
}
