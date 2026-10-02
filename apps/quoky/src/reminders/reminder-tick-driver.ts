import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger, ReminderDispatchOptions, ReminderDispatchService } from '@quoky/core';

/**
 * Composition-root reminder tick (ADR-0101 D6, PRO-5).
 *
 * A bounded, local lifecycle — not a scheduler, workflow engine or agent loop: it only asks the Core
 * `ReminderDispatchService` to deliver owner-authored reminders that are due. Its whole reachable surface is that
 * service's `recoverInterrupted`/`dispatchDue`, a clock and a logger — no provider, connector, tool, Task or
 * runtime. Each tick claims at most `REMINDER_LIMITS.maxDeliveriesPerTick` (10) reminders (the service bound).
 *
 * - `start()` is a no-op when reminders are disabled (`QUOKY_REMINDERS_ENABLED=false`): no recovery, no timer.
 *   Otherwise it first runs startup recovery once (FIRING rows → `DELIVERY_UNCERTAIN`, never resent), then arms a
 *   non-overlapping, unref'd `setTimeout` chain: first tick after `initialDelayMs` (5 s), then every `periodMs`
 *   (15 s) measured from the END of the previous tick, so two ticks never overlap. A missed ONCE reminder is
 *   delivered late once and a recurring one is caught up within 60 minutes by the first tick (service policy).
 * - `main.ts` calls `start()` after `platform.start()` and `stop()` first on shutdown.
 * - `stop()` disarms the timer, tells the dispatcher not to START any further reminder of the current batch, and
 *   awaits the single in-flight delivery + its outcome write (bounded by `stopTimeoutMs` = send timeout + margin).
 *   It resolves `true` on a clean stop; `false` (state `STOP_FORCED`, no success log) when the bound elapsed, in
 *   which case an unrecorded in-flight reminder stays FIRING and the next startup marks it DELIVERY_UNCERTAIN.
 * - A tick error is logged (class only) and the chain continues; the process never crashes from a tick.
 */

export const REMINDER_TICK_INITIAL_DELAY_MS = 5_000;
export const REMINDER_TICK_PERIOD_MS = 15_000;
/** Per-send bound (Discord sends allow 20 s) plus a margin for the outcome write. */
export const REMINDER_TICK_STOP_TIMEOUT_MS = 25_000;

/** Injectable timer seam (tests use a manual fake). Handles are opaque. */
export interface ReminderTickTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const nodeTimers: ReminderTickTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ReminderTickDriverDeps {
  /** `QUOKY_REMINDERS_ENABLED`. When false the driver never starts. */
  readonly enabled: boolean;
  readonly dispatch: Pick<ReminderDispatchService, 'recoverInterrupted' | 'dispatchDue'>;
  readonly logger: Logger;
  /** Defaults to the shared Core clock. */
  readonly clock?: () => IsoTimestamp;
  /** Defaults to Node's timers (each handle unref'd so the tick never keeps the process alive). */
  readonly timers?: ReminderTickTimers;
  readonly initialDelayMs?: number;
  readonly periodMs?: number;
  readonly stopTimeoutMs?: number;
}

export type ReminderTickDriverState = 'IDLE' | 'DISABLED' | 'STARTING' | 'RUNNING' | 'STOPPED' | 'STOP_FORCED';

export class ReminderTickDriver {
  private stateValue: ReminderTickDriverState = 'IDLE';
  private timer: unknown = undefined;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private forced = false;
  private readonly clock: () => IsoTimestamp;
  private readonly timers: ReminderTickTimers;
  private readonly initialDelayMs: number;
  private readonly periodMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly deps: ReminderTickDriverDeps) {
    this.clock = deps.clock ?? sharedClock;
    this.timers = deps.timers ?? nodeTimers;
    this.initialDelayMs = deps.initialDelayMs ?? REMINDER_TICK_INITIAL_DELAY_MS;
    this.periodMs = deps.periodMs ?? REMINDER_TICK_PERIOD_MS;
    this.stopTimeoutMs = deps.stopTimeoutMs ?? REMINDER_TICK_STOP_TIMEOUT_MS;
  }

  get state(): ReminderTickDriverState {
    return this.stateValue;
  }

  /**
   * Recover, then arm the tick chain. Returns whether the chain is running. Idempotent: a second call (or a call
   * after `stop()`) changes nothing. Never throws.
   */
  async start(): Promise<boolean> {
    if (this.stateValue !== 'IDLE') return this.stateValue === 'RUNNING';
    if (!this.deps.enabled) {
      this.stateValue = 'DISABLED';
      this.deps.logger.info('reminder.tick.disabled');
      return false;
    }
    this.stateValue = 'STARTING';
    await this.track(this.recover());
    // `stop()` during recovery wins: nothing is armed.
    if (this.stateValue !== 'STARTING') return false;
    this.stateValue = 'RUNNING';
    this.arm(this.initialDelayMs);
    this.deps.logger.info('reminder.tick.started', { initialDelayMs: this.initialDelayMs, periodMs: this.periodMs });
    return true;
  }

  /**
   * Disarm the chain, stop new deliveries and wait (bounded) for the in-flight one. Resolves `true` when nothing is
   * left running, `false` when the bound elapsed (forced). Idempotent; never throws.
   */
  async stop(): Promise<boolean> {
    if (this.forced) return false;
    const wasActive = this.stateValue === 'STARTING' || this.stateValue === 'RUNNING';
    if (!this.forced) this.stateValue = 'STOPPED';
    this.stopping = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.inFlight;
    if (pending !== null) {
      const settled = await this.boundedWait(pending);
      if (!settled) {
        this.stateValue = 'STOP_FORCED';
        this.forced = true;
        this.deps.logger.warn('reminder.tick.stop_timeout', { stopTimeoutMs: this.stopTimeoutMs });
        return false;
      }
    }
    if (wasActive) this.deps.logger.info('reminder.tick.stopped');
    return true;
  }

  /** Resolves once no recovery or tick is in flight (test and shutdown observability only). */
  async idle(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }

  private arm(delayMs: number): void {
    if (this.stateValue !== 'RUNNING') return;
    const handle = this.timers.setTimeout(() => this.onTimer(), delayMs);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.timer = handle;
  }

  private onTimer(): void {
    this.timer = undefined;
    if (this.stateValue !== 'RUNNING') return;
    // Defensive: the chain re-arms only after a tick settles, so a tick is never in flight here.
    if (this.inFlight !== null) {
      this.arm(this.periodMs);
      return;
    }
    void this.track(this.tick()).then(() => this.arm(this.periodMs));
  }

  private async recover(): Promise<void> {
    try {
      await this.deps.dispatch.recoverInterrupted(this.clock());
    } catch (error) {
      this.logFailure('reminder.tick.recover_failed', error);
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.deps.dispatch.dispatchDue(this.clock(), { shouldContinue: () => !this.stopping });
    } catch (error) {
      this.logFailure('reminder.tick.failed', error);
    }
  }

  private track(work: Promise<void>): Promise<void> {
    const tracked = work.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private boundedWait(pending: Promise<void>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const handle = this.timers.setTimeout(() => resolve(false), this.stopTimeoutMs);
      (handle as { unref?: () => void } | null)?.unref?.();
      void pending.then(() => {
        this.timers.clearTimeout(handle);
        resolve(true);
      });
    });
  }

  private logFailure(message: string, error: unknown): void {
    // Failure class only: never a reminder body or the error's own message.
    this.deps.logger.error(message, { errorName: error instanceof Error ? error.name : 'unknown' });
  }
}
