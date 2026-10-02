import { describe, expect, it } from 'vitest';
import { REMINDER_LIMITS, ReminderStatus, type Reminder, type ReminderSchedule } from '../../domain';
import type { ReminderClarifyReason } from './reminder-grammar';
import { ReminderReplyComposer, reminderRepeatLabel } from './reminder-reply-composer';

const ZONE = 'Asia/Seoul';
const NOW = '2026-10-02T03:00:00.000Z';
const composer = new ReminderReplyComposer();

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    actorId: 'a1',
    displayNo: 4,
    status: ReminderStatus.SCHEDULED,
    kind: 'TEXT',
    body: '회의 준비',
    schedule: { type: 'ONCE', at: '2026-10-03T00:00:00.000Z' },
    timeZone: ZONE,
    origin: { platform: 'discord', channelId: 'c', userId: 'owner' },
    occurrenceAt: '2026-10-03T00:00:00.000Z',
    nextFireAt: '2026-10-03T00:00:00.000Z',
    attempt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const ALL_REASONS: ReminderClarifyReason[] = [
  'PAST_TIME',
  'INVALID_DATE',
  'INVALID_TIME',
  'NONEXISTENT_TIME',
  'TOO_FAR',
  'TOO_SOON',
  'UNSUPPORTED_RECURRENCE',
  'MISSING_TIME',
  'AMBIGUOUS_TIME',
  'EMPTY_BODY',
  'BODY_TOO_LONG',
  'INVALID_REMINDER_NUMBER',
  'BULK_CANCEL_UNSUPPORTED',
];

describe('ReminderReplyComposer.created', () => {
  it('matches the documented confirmation for a one-time reminder', () => {
    expect(composer.created(reminder(), NOW)).toBe(
      "10월 3일(토) 오전 9:00에 '회의 준비' 알려드릴게요. (#4 · 취소: '알림 4 취소')",
    );
  });

  it('shows the year only when it differs from the current year', () => {
    const next = reminder({
      schedule: { type: 'ONCE', at: '2027-01-05T06:00:00.000Z' },
      nextFireAt: '2027-01-05T06:00:00.000Z',
    });
    expect(composer.created(next, NOW)).toContain('2027년 1월 5일(화) 오후 3:00에');
  });

  it('describes weekly and weekday recurrences', () => {
    const weekly = reminder({
      schedule: { type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [3, 1] },
      nextFireAt: '2026-10-05T00:00:00.000Z',
    });
    expect(composer.created(weekly, NOW)).toContain('매주 월·수 오전 9:00에');
    const weekdays = reminder({
      schedule: { type: 'WEEKLY', time: { hour: 18, minute: 0 }, weekdays: [5, 4, 3, 2, 1] },
      nextFireAt: '2026-10-02T09:00:00.000Z',
    });
    expect(composer.created(weekdays, NOW)).toContain('평일 오후 6:00에');
    expect(composer.created(weekdays, NOW)).toContain('첫 알림은 10월 2일(금) 오후 6:00이에요.');
  });
});

describe('ReminderReplyComposer clarify', () => {
  it.each(ALL_REASONS)('has copy with an example or a concrete next step for %s', (reason) => {
    const text = composer.clarify(reason);
    expect(text.length).toBeGreaterThan(10);
    expect(text).toMatch(/예:|\d+일|\d+자|최소 1분|확인/);
  });

  it('has a distinct reply per reason', () => {
    expect(new Set(ALL_REASONS.map((r) => composer.clarify(r))).size).toBe(ALL_REASONS.length);
  });
});

describe('ReminderReplyComposer.list', () => {
  it('lists number, local time, repeat label and body, marking firing rows and the last outcome', () => {
    const text = composer.list(
      [
        reminder({ displayNo: 1 }),
        reminder({
          displayNo: 2,
          schedule: { type: 'DAILY', time: { hour: 8, minute: 0 } },
          status: ReminderStatus.FIRING,
          lastOutcome: { outcome: 'SKIPPED_MISSED', occurrenceAt: NOW, recordedAt: NOW },
        }),
        reminder({ displayNo: 3, kind: 'BRIEF', body: '오늘 할 일' }),
      ],
      NOW,
    );
    expect(text).toBe(
      [
        '예정된 알림 3건',
        '#1 10월 3일(토) 오전 9:00 [1회] 회의 준비',
        '#2 10월 3일(토) 오전 9:00 [매일] 회의 준비 · 전달 중 · 지난 알림: 시간이 지나 건너뜀',
        '#3 10월 3일(토) 오전 9:00 [1회] 오늘의 브리핑(DM)',
      ].join('\n'),
    );
  });

  it('stays within one message when the owner has the maximum number of long reminders', () => {
    const many = Array.from({ length: REMINDER_LIMITS.maxActivePerActor }, (_, i) =>
      reminder({ displayNo: i + 1, body: '가'.repeat(REMINDER_LIMITS.maxBodyChars) }),
    );
    const text = composer.list(many, NOW);
    expect(Array.from(text).length).toBeLessThanOrEqual(1_800);
    expect(text).toMatch(/외 \d+건은 생략했어요\./);
    expect(text.startsWith(`예정된 알림 ${many.length}건`)).toBe(true);
  });
});

describe('ReminderReplyComposer cancel and refusal copy', () => {
  it('composes the cancel results', () => {
    expect(composer.canceled(reminder())).toBe("알림 #4 취소했어요: '회의 준비'");
    expect(composer.cancelNotFound(9)).toContain('#9');
    expect(composer.cancelInFlight(4)).toContain('전달 중');
    for (const status of [
      ReminderStatus.COMPLETED,
      ReminderStatus.CANCELED,
      ReminderStatus.FAILED,
      ReminderStatus.DELIVERY_UNCERTAIN,
    ]) {
      expect(composer.cancelAlreadyFinal(reminder({ status }))).toContain('#4');
    }
    expect(composer.cancelAlreadyFinal(reminder({ status: ReminderStatus.DELIVERY_UNCERTAIN }))).toContain('다시 보내지 않아요');
  });

  it('states the limit and the fixed refusals', () => {
    expect(composer.limitReached(50)).toContain('50건');
    expect(composer.disabled()).toContain('알림 기능이 꺼져 있어요');
    expect(composer.credentialRefused()).toContain('저장하지 않았어요');
    expect(composer.storageFailure()).toContain('다시 시도');
  });
});

describe('ReminderReplyComposer.delivery', () => {
  const base = { displayNo: 4, body: '회의 준비', occurrenceAt: '2026-10-03T00:00:00.000Z', timeZone: ZONE };

  it('composes the plain notification without an emoji', () => {
    expect(composer.delivery({ ...base, late: false })).toBe('알림 #4: 회의 준비');
  });

  it('adds the original time on the late variant', () => {
    expect(composer.delivery({ ...base, late: true })).toBe('알림 #4: 회의 준비 (예정 10/3 09:00, 늦게 전달)');
  });

  it('never exceeds the delivered-text bound and keeps the late note', () => {
    const text = composer.delivery({ ...base, body: '가'.repeat(5_000), late: true });
    expect(Array.from(text).length).toBeLessThanOrEqual(REMINDER_LIMITS.maxDeliveredTextChars);
    expect(text.endsWith('(예정 10/3 09:00, 늦게 전달)')).toBe(true);
  });

  it('has a fallback-DM note', () => {
    expect(composer.fallbackDmNote()).toContain('DM');
  });
});

describe('ReminderReplyComposer emoji policy', () => {
  it('contains no emoji in any reminder copy', () => {
    const texts = [
      composer.created(reminder(), NOW),
      ...ALL_REASONS.map((r) => composer.clarify(r)),
      composer.list([reminder()], NOW),
      composer.list([], NOW),
      composer.canceled(reminder()),
      composer.cancelNotFound(1),
      composer.cancelInFlight(1),
      composer.limitReached(50),
      composer.disabled(),
      composer.credentialRefused(),
      composer.storageFailure(),
      composer.delivery({ displayNo: 1, body: '본문', occurrenceAt: NOW, late: true, timeZone: ZONE }),
      composer.fallbackDmNote(),
      composer.brief({ now: NOW, timeZone: ZONE, reminders: [], workItems: [] }),
    ];
    for (const text of texts) expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('reminderRepeatLabel', () => {
  it.each([
    [{ type: 'ONCE', at: NOW }, '1회'],
    [{ type: 'DAILY', time: { hour: 8, minute: 0 } }, '매일'],
    [{ type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [0, 6] }, '매주 일·토'],
    [{ type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [1, 2, 3, 4, 5] }, '평일'],
  ] as Array<[ReminderSchedule, string]>)('%j', (schedule, label) => {
    expect(reminderRepeatLabel(schedule)).toBe(label);
  });
});
