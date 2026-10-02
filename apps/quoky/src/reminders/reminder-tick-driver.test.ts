import { describe, expect, it } from 'vitest';
import type { Logger, LogFields, ReminderDispatchSummary, ReminderRecoverySummary } from '@quoky/core';
import {
  REMINDER_TICK_INITIAL_DELAY_MS,
  REMINDER_TICK_PERIOD_MS,
  ReminderTickDriver,
  type ReminderTickTimers,
} from './reminder-tick-driver';

const T0 = Date.parse('2026-10-02T03:00:00.000Z');

/** A manual timer queue: nothing fires until the test says so; `now()` advances with each fired timer. */
class ManualTimers implements ReminderTickTimers {
  private nextId = 1;
  private clockMs = T0;
  readonly pending = new Map<number, { callback: () => void; dueAt: number; ms: number; unrefed: boolean }>();
  readonly scheduled: number[] = [];

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    const entry = { callback, dueAt: this.clockMs + ms, ms, unrefed: false };
    this.pending.set(id, entry);
    this.scheduled.push(ms);
    return { id, unref: () => { entry.unrefed = true; } };
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete((handle as { id: number }).id);
  }

  now = (): string => new Date(this.clockMs).toISOString();

  /** Fire the earliest pending timer, advancing the clock to it. */
  fireNext(): boolean {
    const next = [...this.pending.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
    if (next === undefined) return false;
    this.pending.delete(next[0]);
    this.clockMs = Math.max(this.clockMs, next[1].dueAt);
    next[1].callback();
    return true;
  }

  /** Pending timers with this delay (tick timers vs the stop-wait timer). */
  pendingWith(ms: number): number {
    return [...this.pending.values()].filter((entry) => entry.ms === ms).length;
  }
}

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.entries.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.entries.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.entries.push({ level: 'error', message, fields }); }
  messages(): string[] { return this.entries.map((entry) => entry.message); }
}

const emptyDispatch: ReminderDispatchSummary = {
  claimed: 0, delivered: 0, deliveredLate: 0, viaDm: 0, viaChannel: 0, retried: 0, failed: 0, uncertain: 0,
  skippedMissed: 0, staleCompletions: 0, errors: 0,
};
const emptyRecovery: ReminderRecoverySummary = { recovered: 0, staleCompletions: 0, errors: 0 };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A dispatch fake that records the order and time of calls; `dispatchDue` can be held open to prove no overlap. */
function fakeDispatch() {
  const calls: Array<{ op: 'recover' | 'dispatch'; at: string }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let hold: Promise<void> | null = null;
  let failNext: Error | null = null;
  return {
    calls,
    maxConcurrent: () => maxConcurrent,
    holdNextTick(gate: Promise<void>) { hold = gate; },
    failNextTick(error: Error) { failNext = error; },
    dispatch: {
      async recoverInterrupted(at: string) {
        calls.push({ op: 'recover' as const, at });
        return emptyRecovery;
      },
      async dispatchDue(at: string) {
        calls.push({ op: 'dispatch' as const, at });
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          if (hold) { const gate = hold; hold = null; await gate; }
          if (failNext) { const error = failNext; failNext = null; throw error; }
          return emptyDispatch;
        } finally {
          concurrent -= 1;
        }
      },
    },
  };
}

function setup(options: { enabled?: boolean } = {}) {
  const timers = new ManualTimers();
  const logger = new RecordingLogger();
  const fake = fakeDispatch();
  const driver = new ReminderTickDriver({
    enabled: options.enabled ?? true,
    dispatch: fake.dispatch,
    logger,
    clock: timers.now,
    timers,
  });
  return { timers, logger, fake, driver };
}

async function fireTick(timers: ManualTimers, driver: ReminderTickDriver): Promise<void> {
  expect(timers.fireNext()).toBe(true);
  await driver.idle();
  // Let the post-tick re-arm continuation run.
  await Promise.resolve();
}

describe('ReminderTickDriver disabled', () => {
  it('never starts when reminders are disabled: no recovery, no dispatch, no timer', async () => {
    const { driver, fake, timers, logger } = setup({ enabled: false });

    expect(await driver.start()).toBe(false);
    expect(await driver.start()).toBe(false);

    expect(driver.state).toBe('DISABLED');
    expect(fake.calls).toEqual([]);
    expect(timers.pending.size).toBe(0);
    expect(logger.messages()).toEqual(['reminder.tick.disabled']);
    await driver.stop();
    expect(timers.pending.size).toBe(0);
  });
});

describe('ReminderTickDriver lifecycle', () => {
  it('recovers first, then ticks after 5 s and every 15 s, with unref\'d timers', async () => {
    const { driver, fake, timers } = setup();

    expect(await driver.start()).toBe(true);
    expect(driver.state).toBe('RUNNING');
    expect(fake.calls).toEqual([{ op: 'recover', at: '2026-10-02T03:00:00.000Z' }]);
    expect(timers.scheduled).toEqual([REMINDER_TICK_INITIAL_DELAY_MS]);
    expect([...timers.pending.values()].every((entry) => entry.unrefed)).toBe(true);

    await fireTick(timers, driver);
    await fireTick(timers, driver);
    await fireTick(timers, driver);

    expect(fake.calls.map((call) => call.op)).toEqual(['recover', 'dispatch', 'dispatch', 'dispatch']);
    expect(fake.calls.map((call) => call.at)).toEqual([
      '2026-10-02T03:00:00.000Z',
      '2026-10-02T03:00:05.000Z',
      '2026-10-02T03:00:20.000Z',
      '2026-10-02T03:00:35.000Z',
    ]);
    expect(timers.scheduled).toEqual([
      REMINDER_TICK_INITIAL_DELAY_MS, REMINDER_TICK_PERIOD_MS, REMINDER_TICK_PERIOD_MS, REMINDER_TICK_PERIOD_MS,
    ]);
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()].every((entry) => entry.unrefed)).toBe(true);
    await driver.stop();
  });

  it('start is idempotent: a second start neither recovers again nor arms a second chain', async () => {
    const { driver, fake, timers } = setup();
    expect(await driver.start()).toBe(true);
    expect(await driver.start()).toBe(true);
    expect(fake.calls.filter((call) => call.op === 'recover')).toHaveLength(1);
    expect(timers.pending.size).toBe(1);
    await driver.stop();
  });

  it('never overlaps ticks: the next tick is armed only after the previous one settles', async () => {
    const { driver, fake, timers } = setup();
    await driver.start();
    const gate = deferred();
    fake.holdNextTick(gate.promise);

    expect(timers.fireNext()).toBe(true);
    await Promise.resolve();
    // The slow tick is in flight; no further tick timer is armed, so nothing can start a second one.
    expect(timers.pendingWith(REMINDER_TICK_PERIOD_MS)).toBe(0);
    expect(timers.fireNext()).toBe(false);

    gate.resolve();
    await driver.idle();
    await Promise.resolve();
    expect(timers.pendingWith(REMINDER_TICK_PERIOD_MS)).toBe(1);
    await fireTick(timers, driver);

    expect(fake.maxConcurrent()).toBe(1);
    expect(fake.calls.filter((call) => call.op === 'dispatch')).toHaveLength(2);
    await driver.stop();
  });

  it('logs a tick error by class only and keeps ticking', async () => {
    const { driver, fake, timers, logger } = setup();
    await driver.start();
    fake.failNextTick(new RangeError('db exploded: 비밀본문'));

    await fireTick(timers, driver);
    await fireTick(timers, driver);

    expect(fake.calls.filter((call) => call.op === 'dispatch')).toHaveLength(2);
    expect(logger.entries).toContainEqual({
      level: 'error', message: 'reminder.tick.failed', fields: { errorName: 'RangeError' },
    });
    expect(JSON.stringify(logger.entries)).not.toContain('비밀본문');
    expect(driver.state).toBe('RUNNING');
    await driver.stop();
  });

  it('a recovery error is logged and the chain still starts', async () => {
    const timers = new ManualTimers();
    const logger = new RecordingLogger();
    let dispatched = 0;
    const driver = new ReminderTickDriver({
      enabled: true,
      logger,
      clock: timers.now,
      timers,
      dispatch: {
        async recoverInterrupted() { throw new Error('listFiring failed'); },
        async dispatchDue() { dispatched += 1; return emptyDispatch; },
      },
    });

    expect(await driver.start()).toBe(true);
    await fireTick(timers, driver);

    expect(dispatched).toBe(1);
    expect(logger.entries).toContainEqual({
      level: 'error', message: 'reminder.tick.recover_failed', fields: { errorName: 'Error' },
    });
    await driver.stop();
  });

  it('stop disarms the timer and awaits the in-flight tick; nothing ticks afterwards', async () => {
    const { driver, fake, timers } = setup();
    await driver.start();
    const gate = deferred();
    fake.holdNextTick(gate.promise);
    expect(timers.fireNext()).toBe(true);
    await Promise.resolve();

    let stopped = false;
    const stopping = driver.stop().then(() => { stopped = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(driver.state).toBe('STOPPED');
    // The post-tick re-arm sees STOPPED: no tick timer is left.
    await Promise.resolve();
    expect(timers.pendingWith(REMINDER_TICK_PERIOD_MS)).toBe(0);
    expect(timers.pendingWith(REMINDER_TICK_INITIAL_DELAY_MS)).toBe(0);
    expect(fake.calls.filter((call) => call.op === 'dispatch')).toHaveLength(1);
    expect(await driver.start()).toBe(false);
    expect(fake.calls.filter((call) => call.op === 'recover')).toHaveLength(1);
  });

  it('stop before the first tick fires leaves nothing armed', async () => {
    const { driver, fake, timers, logger } = setup();
    await driver.start();
    await driver.stop();
    expect(timers.pending.size).toBe(0);
    expect(fake.calls.map((call) => call.op)).toEqual(['recover']);
    expect(logger.messages()).toContain('reminder.tick.stopped');
  });

  it('a stop during startup recovery wins: no tick chain is armed', async () => {
    const timers = new ManualTimers();
    const gate = deferred();
    let dispatched = 0;
    const driver = new ReminderTickDriver({
      enabled: true,
      logger: new RecordingLogger(),
      clock: timers.now,
      timers,
      dispatch: {
        async recoverInterrupted() { await gate.promise; return emptyRecovery; },
        async dispatchDue() { dispatched += 1; return emptyDispatch; },
      },
    });

    const starting = driver.start();
    const stopping = driver.stop();
    gate.resolve();

    expect(await starting).toBe(false);
    await stopping;
    expect(driver.state).toBe('STOPPED');
    expect(timers.pendingWith(REMINDER_TICK_INITIAL_DELAY_MS)).toBe(0);
    expect(dispatched).toBe(0);
  });

  it('stop gives up waiting after the bound and warns, so shutdown cannot hang on a stuck tick', async () => {
    const timers = new ManualTimers();
    const logger = new RecordingLogger();
    const never = new Promise<ReminderDispatchSummary>(() => undefined);
    const driver = new ReminderTickDriver({
      enabled: true,
      logger,
      clock: timers.now,
      timers,
      stopTimeoutMs: 1_000,
      dispatch: {
        async recoverInterrupted() { return emptyRecovery; },
        dispatchDue: () => never,
      },
    });
    await driver.start();
    expect(timers.fireNext()).toBe(true);
    await Promise.resolve();

    const stopping = driver.stop();
    await Promise.resolve();
    expect(timers.pendingWith(1_000)).toBe(1);
    expect(timers.fireNext()).toBe(true);
    await stopping;

    expect(logger.entries).toContainEqual({
      level: 'warn', message: 'reminder.tick.stop_timeout', fields: { stopTimeoutMs: 1_000 },
    });
  });
});

describe('ReminderTickDriver cooperative stop (at-most-once)', () => {
  /** A batch of `n` reminders delivered sequentially with controllable sends; honours `shouldContinue`. */
  function batchDispatch(n: number) {
    const started: number[] = [];
    const recorded: number[] = [];
    const gates: Array<ReturnType<typeof deferred>> = Array.from({ length: n }, () => deferred());
    const outcomeGate = deferred();
    let holdOutcome = false;
    return {
      started,
      recorded,
      gates,
      outcomeGate,
      holdOutcomeWrite() { holdOutcome = true; },
      dispatch: {
        async recoverInterrupted() { return emptyRecovery; },
        async dispatchDue(_at: string, options?: { shouldContinue?: () => boolean }) {
          for (let i = 0; i < n; i += 1) {
            if (options?.shouldContinue && !options.shouldContinue()) break;
            started.push(i);
            await gates[i]?.promise; // the send
            if (holdOutcome) await outcomeGate.promise; // the outcome write
            recorded.push(i);
          }
          return emptyDispatch;
        },
      },
    };
  }

  function build(batch: ReturnType<typeof batchDispatch>, stopTimeoutMs = 1_000) {
    const timers = new ManualTimers();
    const logger = new RecordingLogger();
    const driver = new ReminderTickDriver({
      enabled: true, logger, clock: timers.now, timers, stopTimeoutMs, dispatch: batch.dispatch,
    });
    return { timers, logger, driver };
  }

  it('stop during a batch starts no further send, waits for the active one and its outcome, then resolves clean', async () => {
    const batch = batchDispatch(3);
    const { timers, driver, logger } = build(batch);
    await driver.start();
    expect(timers.fireNext()).toBe(true);
    await Promise.resolve();
    expect(batch.started).toEqual([0]);

    let result: boolean | undefined;
    const stopping = driver.stop().then((r) => { result = r; });
    await Promise.resolve();
    await Promise.resolve();
    expect(result).toBeUndefined();

    batch.gates[0]?.resolve();
    await stopping;

    expect(result).toBe(true);
    expect(batch.recorded).toEqual([0]); // outcome recorded before stop() resolved
    expect(batch.started).toEqual([0]); // reminders 1 and 2 never started
    expect(driver.state).toBe('STOPPED');
    expect(logger.messages()).toContain('reminder.tick.stopped');
  });

  it('stop with a hung send is bounded, reported as forced, and records nothing (reminder stays FIRING)', async () => {
    const batch = batchDispatch(2);
    const { timers, driver, logger } = build(batch);
    await driver.start();
    expect(timers.fireNext()).toBe(true);
    await Promise.resolve();

    const stopping = driver.stop();
    await Promise.resolve();
    expect(timers.pendingWith(1_000)).toBe(1);
    expect(timers.fireNext()).toBe(true);

    expect(await stopping).toBe(false);
    expect(driver.state).toBe('STOP_FORCED');
    expect(batch.recorded).toEqual([]);
    expect(batch.started).toEqual([0]);
    expect(logger.messages()).toContain('reminder.tick.stop_timeout');
    expect(logger.messages()).not.toContain('reminder.tick.stopped');
    expect(await driver.stop()).toBe(false);
    expect(driver.state).toBe('STOP_FORCED');
  });

  it('stop waits for a slow outcome write after the send completed', async () => {
    const batch = batchDispatch(2);
    batch.holdOutcomeWrite();
    const { timers, driver } = build(batch);
    await driver.start();
    expect(timers.fireNext()).toBe(true);
    await Promise.resolve();

    let done = false;
    const stopping = driver.stop().then((r) => { done = r; });
    batch.gates[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(batch.recorded).toEqual([]);

    batch.outcomeGate.resolve();
    await stopping;
    expect(done).toBe(true);
    expect(batch.recorded).toEqual([0]);
    expect(batch.started).toEqual([0]);
  });
});
