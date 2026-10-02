import { describe, expect, it } from 'vitest';
import {
  InvalidReminderError,
  InvalidReminderTransitionError,
  REMINDER_LIMITS,
  ReminderStatus,
  TERMINAL_REMINDER_STATUSES,
  applyFiringCompletion,
  cancelReminder,
  canTransitionReminder,
  claimReminder,
  createReminderDraft,
  isActiveReminderStatus,
  isTerminalReminderStatus,
  planFiringCompletion,
  skipMissedOccurrence,
  type Reminder,
  type ReminderSchedule,
} from './reminder';

const ORIGIN = { platform: 'discord', channelId: 'c1', userId: 'owner' };
const CREATED = '2026-10-02T05:00:00.000Z';
const FIRE = '2026-10-03T00:00:00.000Z';
const NEXT = '2026-10-04T00:00:00.000Z';
const AT = '2026-10-03T00:00:05.000Z';
const ONCE: ReminderSchedule = { type: 'ONCE', at: FIRE };
const DAILY: ReminderSchedule = { type: 'DAILY', time: { hour: 9, minute: 0 } };

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    ...createReminderDraft({
      id: 'r1',
      actorId: 'a1',
      kind: 'TEXT',
      body: '회의 준비',
      schedule: ONCE,
      timeZone: 'Asia/Seoul',
      origin: ORIGIN,
      firstFireAt: FIRE,
      createdAt: CREATED,
    }),
    displayNo: 1,
    ...overrides,
  };
}

function firing(overrides: Partial<Reminder> = {}): Reminder {
  return claimReminder(reminder(overrides), 'attempt-1', FIRE);
}

const ALL = Object.values(ReminderStatus);

describe('Reminder limits (ADR-0101)', () => {
  it('pins every bound', () => {
    expect(REMINDER_LIMITS).toEqual({
      maxBodyChars: 200,
      maxActivePerActor: 50,
      horizonDays: 366,
      minLeadMs: 60_000,
      maxRetries: 3,
      retryBackoffMinutes: [1, 5, 15],
      recurringCatchUpGraceMs: 3_600_000,
      lateLabelAfterMs: 120_000,
      maxDeliveriesPerTick: 10,
      maxDeliveredTextChars: 1_800,
    });
  });
});

describe('Reminder transition table (closed, ADR-0101 D4)', () => {
  const allowed: Record<ReminderStatus, ReminderStatus[]> = {
    [ReminderStatus.SCHEDULED]: [ReminderStatus.FIRING, ReminderStatus.CANCELED, ReminderStatus.SCHEDULED],
    [ReminderStatus.FIRING]: [
      ReminderStatus.COMPLETED,
      ReminderStatus.SCHEDULED,
      ReminderStatus.FAILED,
      ReminderStatus.DELIVERY_UNCERTAIN,
    ],
    [ReminderStatus.COMPLETED]: [],
    [ReminderStatus.CANCELED]: [],
    [ReminderStatus.FAILED]: [],
    [ReminderStatus.DELIVERY_UNCERTAIN]: [],
  };

  for (const from of ALL) {
    for (const to of ALL) {
      const expected = allowed[from].includes(to);
      it(`${from} -> ${to} is ${expected ? 'legal' : 'illegal'}`, () => {
        expect(canTransitionReminder(from, to)).toBe(expected);
      });
    }
  }

  it('terminal and active status sets', () => {
    expect([...TERMINAL_REMINDER_STATUSES].sort()).toEqual(
      [ReminderStatus.COMPLETED, ReminderStatus.CANCELED, ReminderStatus.FAILED, ReminderStatus.DELIVERY_UNCERTAIN].sort(),
    );
    for (const status of ALL) {
      expect(isTerminalReminderStatus(status)).toBe(TERMINAL_REMINDER_STATUSES.includes(status));
      expect(isActiveReminderStatus(status)).toBe(status === ReminderStatus.SCHEDULED || status === ReminderStatus.FIRING);
    }
  });
});

describe('createReminderDraft', () => {
  it('creates a SCHEDULED draft whose first occurrence is due at firstFireAt', () => {
    const { displayNo: _ignored, ...draft } = reminder();
    expect(draft).toEqual({
      id: 'r1',
      actorId: 'a1',
      status: ReminderStatus.SCHEDULED,
      kind: 'TEXT',
      body: '회의 준비',
      schedule: ONCE,
      timeZone: 'Asia/Seoul',
      origin: ORIGIN,
      occurrenceAt: FIRE,
      nextFireAt: FIRE,
      attempt: 0,
      createdAt: CREATED,
      updatedAt: CREATED,
    });
  });

  const base = {
    id: 'r1',
    actorId: 'a1',
    kind: 'TEXT' as const,
    timeZone: 'Asia/Seoul',
    origin: ORIGIN,
    firstFireAt: FIRE,
    createdAt: CREATED,
  };

  it.each([
    ['', ONCE, 'BODY_EMPTY'],
    ['   ', ONCE, 'BODY_EMPTY'],
    ['가'.repeat(201), ONCE, 'BODY_TOO_LONG'],
    ['x', { type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [] }, 'SCHEDULE_INVALID'],
    ['x', { type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [1, 1] }, 'SCHEDULE_INVALID'],
    ['x', { type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [7] }, 'SCHEDULE_INVALID'],
    ['x', { type: 'DAILY', time: { hour: 24, minute: 0 } }, 'SCHEDULE_INVALID'],
    ['x', { type: 'DAILY', time: { hour: 9, minute: 60 } }, 'SCHEDULE_INVALID'],
    ['x', { type: 'ONCE', at: 'tomorrow' }, 'SCHEDULE_INVALID'],
  ] as const)('refuses body %j / schedule %j with %s', (body, schedule, code) => {
    expect(() => createReminderDraft({ ...base, body, schedule: schedule as ReminderSchedule })).toThrow(
      new InvalidReminderError(code),
    );
  });

  it('counts the body in code points (200 emoji fit; 200 Hangul fit)', () => {
    expect(() => createReminderDraft({ ...base, body: '😀'.repeat(200), schedule: ONCE })).not.toThrow();
    expect(() => createReminderDraft({ ...base, body: '가'.repeat(200), schedule: ONCE })).not.toThrow();
    expect(() => createReminderDraft({ ...base, body: '😀'.repeat(201), schedule: ONCE })).toThrow(InvalidReminderError);
  });

  it('refuses an unparseable first fire time', () => {
    expect(() => createReminderDraft({ ...base, body: 'x', schedule: DAILY, firstFireAt: 'soon' })).toThrow(
      new InvalidReminderError('FIRE_TIME_INVALID'),
    );
  });
});

describe('claim, cancel and skip', () => {
  it('claimReminder: SCHEDULED → FIRING with the CAS attempt id', () => {
    const claimed = claimReminder(reminder(), 'attempt-1', AT);
    expect(claimed).toMatchObject({
      status: ReminderStatus.FIRING,
      firingAttemptId: 'attempt-1',
      firingStartedAt: AT,
      updatedAt: AT,
      occurrenceAt: FIRE,
    });
  });

  it.each(ALL.filter((s) => s !== ReminderStatus.SCHEDULED))('claimReminder from %s throws', (status) => {
    expect(() => claimReminder(reminder({ status }), 'a', AT)).toThrow(InvalidReminderTransitionError);
  });

  it('cancelReminder: SCHEDULED → CANCELED and clears the schedule pointers', () => {
    const canceled = cancelReminder(reminder(), AT);
    expect(canceled.status).toBe(ReminderStatus.CANCELED);
    expect(canceled.nextFireAt).toBeUndefined();
    expect(canceled.occurrenceAt).toBeUndefined();
    expect(canceled.updatedAt).toBe(AT);
  });

  it.each(ALL.filter((s) => s !== ReminderStatus.SCHEDULED))('cancelReminder from %s throws (FIRING is in flight)', (status) => {
    expect(() => cancelReminder(reminder({ status }), AT)).toThrow(InvalidReminderTransitionError);
  });

  it('skipMissedOccurrence: recurring SCHEDULED → SCHEDULED with SKIPPED_MISSED, never sent', () => {
    const skipped = skipMissedOccurrence(reminder({ schedule: DAILY }), {
      skippedOccurrenceAt: FIRE,
      nextOccurrenceAt: NEXT,
      at: AT,
    });
    expect(skipped).toMatchObject({
      status: ReminderStatus.SCHEDULED,
      occurrenceAt: NEXT,
      nextFireAt: NEXT,
      attempt: 0,
      lastOutcome: { outcome: 'SKIPPED_MISSED', occurrenceAt: FIRE, recordedAt: AT },
    });
  });

  it('skipMissedOccurrence refuses a ONCE reminder and a non-SCHEDULED one', () => {
    const input = { skippedOccurrenceAt: FIRE, nextOccurrenceAt: NEXT, at: AT };
    expect(() => skipMissedOccurrence(reminder(), input)).toThrow(InvalidReminderTransitionError);
    expect(() => skipMissedOccurrence(firing({ schedule: DAILY }), input)).toThrow(InvalidReminderTransitionError);
  });
});

describe('planFiringCompletion — ONCE (at most once per occurrence)', () => {
  it('SENT → COMPLETED', () => {
    expect(planFiringCompletion(firing(), { status: 'SENT', via: 'dm' }, { at: AT })).toEqual({
      status: ReminderStatus.COMPLETED,
      attempt: 0,
      lastOutcome: { outcome: 'SENT', occurrenceAt: FIRE, recordedAt: AT, via: 'dm' },
      updatedAt: AT,
    });
  });

  it.each([
    [0, 1, '2026-10-03T00:01:05.000Z'],
    [1, 2, '2026-10-03T00:05:05.000Z'],
    [2, 3, '2026-10-03T00:15:05.000Z'],
  ])('NOT_SENT{retryable} at attempt %i retries the same occurrence (attempt %i, +backoff)', (attempt, next, nextFireAt) => {
    expect(
      planFiringCompletion(firing({ attempt }), { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true }, { at: AT }),
    ).toEqual({ status: ReminderStatus.SCHEDULED, occurrenceAt: FIRE, nextFireAt, attempt: next, updatedAt: AT });
  });

  it('NOT_SENT{retryable} with retries exhausted → FAILED', () => {
    expect(
      planFiringCompletion(firing({ attempt: 3 }), { status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true }, { at: AT }),
    ).toEqual({
      status: ReminderStatus.FAILED,
      attempt: 3,
      lastOutcome: { outcome: 'FAILED', occurrenceAt: FIRE, recordedAt: AT, reason: 'NOT_CONNECTED' },
      updatedAt: AT,
    });
  });

  it('NOT_SENT{retryable: false} → FAILED without retry', () => {
    const c = planFiringCompletion(firing(), { status: 'NOT_SENT', reason: 'NOT_OWNER', retryable: false }, { at: AT });
    expect(c.status).toBe(ReminderStatus.FAILED);
    expect(c.lastOutcome?.reason).toBe('NOT_OWNER');
  });

  it.each(['TIMEOUT', 'NETWORK_ERROR', 'ABORTED', 'PLATFORM_ERROR', 'UNCLASSIFIED', 'INTERRUPTED'] as const)(
    'UNCERTAIN{%s} → terminal DELIVERY_UNCERTAIN, never retried',
    (reason) => {
      const c = planFiringCompletion(firing(), { status: 'UNCERTAIN', reason }, { at: AT });
      expect(c).toEqual({
        status: ReminderStatus.DELIVERY_UNCERTAIN,
        attempt: 0,
        lastOutcome: { outcome: 'DELIVERY_UNCERTAIN', occurrenceAt: FIRE, recordedAt: AT, reason },
        updatedAt: AT,
      });
      expect(c.nextFireAt).toBeUndefined();
    },
  );

  it('a ONCE reminder is never skipped', () => {
    expect(() =>
      planFiringCompletion(firing(), { status: 'SKIPPED_MISSED', skippedOccurrenceAt: FIRE }, { at: AT }),
    ).toThrow(InvalidReminderTransitionError);
  });

  it.each(ALL.filter((s) => s !== ReminderStatus.FIRING))('completion of a %s reminder throws', (status) => {
    expect(() => planFiringCompletion(reminder({ status }), { status: 'SENT', via: 'dm' }, { at: AT })).toThrow(
      InvalidReminderTransitionError,
    );
  });
});

describe('planFiringCompletion — recurring (never ends by delivery)', () => {
  const recurring = () => firing({ schedule: DAILY });

  it.each([
    [{ status: 'SENT', via: 'channel' } as const, { outcome: 'SENT', via: 'channel' }],
    [{ status: 'NOT_SENT', reason: 'MISSING_ACCESS', retryable: false } as const, { outcome: 'FAILED', reason: 'MISSING_ACCESS' }],
    [{ status: 'UNCERTAIN', reason: 'TIMEOUT' } as const, { outcome: 'DELIVERY_UNCERTAIN', reason: 'TIMEOUT' }],
  ])('%j → next occurrence, outcome recorded', (result, outcome) => {
    expect(planFiringCompletion(recurring(), result, { at: AT, nextOccurrenceAt: NEXT })).toEqual({
      status: ReminderStatus.SCHEDULED,
      occurrenceAt: NEXT,
      nextFireAt: NEXT,
      attempt: 0,
      lastOutcome: { occurrenceAt: FIRE, recordedAt: AT, ...outcome },
      updatedAt: AT,
    });
  });

  it('retryable NOT_SENT retries the same occurrence; exhausted advances with FAILED', () => {
    const retry = planFiringCompletion(recurring(), { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true }, { at: AT, nextOccurrenceAt: NEXT });
    expect(retry).toMatchObject({ status: ReminderStatus.SCHEDULED, occurrenceAt: FIRE, attempt: 1 });
    const exhausted = planFiringCompletion(
      firing({ schedule: DAILY, attempt: 3 }),
      { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true },
      { at: AT, nextOccurrenceAt: NEXT },
    );
    expect(exhausted).toMatchObject({ status: ReminderStatus.SCHEDULED, occurrenceAt: NEXT, attempt: 0, lastOutcome: { outcome: 'FAILED' } });
  });

  it('SKIPPED_MISSED advances and records the skipped occurrence', () => {
    expect(
      planFiringCompletion(recurring(), { status: 'SKIPPED_MISSED', skippedOccurrenceAt: FIRE }, { at: AT, nextOccurrenceAt: NEXT }),
    ).toMatchObject({ status: ReminderStatus.SCHEDULED, nextFireAt: NEXT, lastOutcome: { outcome: 'SKIPPED_MISSED', occurrenceAt: FIRE } });
  });

  it('requires a next occurrence later than the current one', () => {
    expect(() => planFiringCompletion(recurring(), { status: 'SENT', via: 'dm' }, { at: AT })).toThrow(InvalidReminderTransitionError);
    expect(() =>
      planFiringCompletion(recurring(), { status: 'SENT', via: 'dm' }, { at: AT, nextOccurrenceAt: FIRE }),
    ).toThrow(InvalidReminderTransitionError);
  });
});

describe('applyFiringCompletion (in-memory CAS)', () => {
  it('applies a terminal ONCE completion and clears firing and schedule pointers', () => {
    const r = firing();
    const done = applyFiringCompletion(r, 'attempt-1', planFiringCompletion(r, { status: 'SENT', via: 'dm' }, { at: AT }));
    expect(done.status).toBe(ReminderStatus.COMPLETED);
    expect(done.firingAttemptId).toBeUndefined();
    expect(done.firingStartedAt).toBeUndefined();
    expect(done.nextFireAt).toBeUndefined();
    expect(done.occurrenceAt).toBeUndefined();
    expect(done.lastOutcome).toEqual({ outcome: 'SENT', occurrenceAt: FIRE, recordedAt: AT, via: 'dm' });
  });

  it('a retry keeps the previous lastOutcome and the occurrence', () => {
    const r = firing({ schedule: DAILY, lastOutcome: { outcome: 'SENT', occurrenceAt: CREATED, recordedAt: CREATED } });
    const retried = applyFiringCompletion(
      r,
      'attempt-1',
      planFiringCompletion(r, { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true }, { at: AT, nextOccurrenceAt: NEXT }),
    );
    expect(retried).toMatchObject({
      status: ReminderStatus.SCHEDULED,
      occurrenceAt: FIRE,
      nextFireAt: '2026-10-03T00:01:05.000Z',
      attempt: 1,
      lastOutcome: { outcome: 'SENT', occurrenceAt: CREATED },
    });
    expect(retried.firingAttemptId).toBeUndefined();
  });

  it('refuses a stale attempt id, a non-FIRING reminder and COMPLETED for a recurring one', () => {
    const r = firing();
    const completion = planFiringCompletion(r, { status: 'SENT', via: 'dm' }, { at: AT });
    expect(() => applyFiringCompletion(r, 'attempt-2', completion)).toThrow(InvalidReminderTransitionError);
    expect(() => applyFiringCompletion(reminder(), 'attempt-1', completion)).toThrow(InvalidReminderTransitionError);
    expect(() => applyFiringCompletion(firing({ schedule: DAILY }), 'attempt-1', completion)).toThrow(InvalidReminderTransitionError);
    for (const status of TERMINAL_REMINDER_STATUSES) {
      expect(() => applyFiringCompletion({ ...r, status }, 'attempt-1', completion)).toThrow(InvalidReminderTransitionError);
    }
  });
});
