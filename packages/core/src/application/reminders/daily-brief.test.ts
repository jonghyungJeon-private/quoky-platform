import { describe, expect, it } from 'vitest';
import { REMINDER_LIMITS, ReminderStatus, WorkItemStatus, type Reminder, type WorkItem } from '../../domain';
import { DAILY_BRIEF_MAX_ENTRIES, composeDailyBrief, formatKoreanClock, formatShortDateTime } from './daily-brief';

const ZONE = 'Asia/Seoul';
// 2026-10-02 08:00 KST (Friday).
const NOW = '2026-10-01T23:00:00.000Z';

function reminder(overrides: Partial<Reminder> & { displayNo: number }): Reminder {
  return {
    id: `r${overrides.displayNo}`,
    actorId: 'a1',
    status: ReminderStatus.SCHEDULED,
    kind: 'TEXT',
    body: `알림${overrides.displayNo}`,
    schedule: { type: 'ONCE', at: '2026-10-02T06:00:00.000Z' },
    timeZone: ZONE,
    origin: { platform: 'discord', channelId: 'c', userId: 'owner' },
    occurrenceAt: '2026-10-02T06:00:00.000Z',
    nextFireAt: '2026-10-02T06:00:00.000Z',
    attempt: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    actorId: 'a1',
    resourceRefs: [],
    status: WorkItemStatus.ACTIVE,
    origin: 'conversation',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatKoreanClock / formatShortDateTime', () => {
  it.each([
    [0, 0, '오전 12:00'],
    [9, 5, '오전 9:05'],
    [12, 0, '오후 12:00'],
    [15, 30, '오후 3:30'],
    [23, 59, '오후 11:59'],
  ])('%i:%i', (h, m, expected) => expect(formatKoreanClock(h, m)).toBe(expected));

  it('formats a compact local date-time', () => {
    expect(formatShortDateTime('2026-10-02T00:00:00.000Z', ZONE)).toBe('10/2 09:00');
  });
});

describe('composeDailyBrief', () => {
  it("lists only today's pending TEXT reminders in time order, and ACTIVE WorkItems", () => {
    const text = composeDailyBrief({
      now: NOW,
      timeZone: ZONE,
      reminders: [
        reminder({ displayNo: 3, body: '늦은 일정', nextFireAt: '2026-10-02T09:00:00.000Z' }),
        reminder({ displayNo: 2, body: '이른 일정', nextFireAt: '2026-10-02T01:00:00.000Z' }),
        reminder({ displayNo: 4, body: '내일 일정', nextFireAt: '2026-10-03T00:00:00.000Z' }),
        reminder({ displayNo: 5, kind: 'BRIEF', body: '브리핑' }),
        reminder({ displayNo: 6, status: ReminderStatus.FIRING, body: '전달중' }),
        reminder({ displayNo: 7, status: ReminderStatus.CANCELED, body: '취소됨' }),
      ],
      workItems: [
        item('w-b', { title: '두번째 작업', createdAt: '2026-09-02T00:00:00.000Z' }),
        item('w-a', { title: '첫번째 작업' }),
        item('w-c', { title: '완료', status: WorkItemStatus.COMPLETED }),
        item('w-d', { title: '취소', status: WorkItemStatus.CANCELED }),
        item('abcdef1234567890', { createdAt: '2026-09-03T00:00:00.000Z' }),
      ],
    });
    expect(text).toBe(
      [
        '오늘의 브리핑 · 10월 2일(금)',
        '',
        '오늘 남은 알림 2건',
        '- 오전 10:00 이른 일정 (#2)',
        '- 오후 6:00 늦은 일정 (#3)',
        '',
        '진행 중인 작업 3건',
        '- 첫번째 작업',
        '- 두번째 작업',
        '- 제목 없는 작업 (abcdef12)',
      ].join('\n'),
    );
  });

  it('says so when there is nothing, and when a source could not be read', () => {
    expect(composeDailyBrief({ now: NOW, timeZone: ZONE, reminders: [], workItems: [] })).toBe(
      ['오늘의 브리핑 · 10월 2일(금)', '', '오늘 남은 알림이 없어요.', '', '진행 중인 작업이 없어요.'].join('\n'),
    );
    const degraded = composeDailyBrief({ now: NOW, timeZone: ZONE, reminders: null, workItems: null });
    expect(degraded).toContain('남은 알림: 불러오지 못했어요.');
    expect(degraded).toContain('진행 중인 작업: 불러오지 못했어요.');
  });

  it('bounds the entries per section and summarizes the rest', () => {
    const many = Array.from({ length: 14 }, (_, i) => reminder({ displayNo: i + 1 }));
    const items = Array.from({ length: 13 }, (_, i) => item(`w${i}`, { title: `작업${i}` }));
    const text = composeDailyBrief({ now: NOW, timeZone: ZONE, reminders: many, workItems: items });
    expect(text).toContain('오늘 남은 알림 14건');
    expect(text).toContain('진행 중인 작업 13건');
    expect(text.match(/^- 오/gm)).toHaveLength(DAILY_BRIEF_MAX_ENTRIES);
    expect(text).toContain('- 외 4건');
    expect(text).toContain('- 외 3건');
  });

  it('neutralizes @everyone, @here and raw mentions in WorkItem titles', () => {
    const text = composeDailyBrief({
      now: NOW,
      timeZone: ZONE,
      reminders: [],
      workItems: [item('w1', { title: '@everyone @here <@123> 공지' })],
    });
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('@here');
    expect(text).not.toContain('<@');
    expect(text.replace(/​/g, '')).toContain('@everyone @here <@123> 공지');
  });

  it('marks a late brief in the header and never exceeds one delivered message', () => {
    const late = composeDailyBrief({
      now: '2026-10-02T02:00:00.000Z',
      timeZone: ZONE,
      reminders: [],
      workItems: [],
      occurrenceAt: NOW,
      late: true,
    });
    expect(late.split('\n')[0]).toBe('오늘의 브리핑 · 10월 2일(금) (예정 10/2 08:00, 늦게 전달)');

    const huge = composeDailyBrief({
      now: NOW,
      timeZone: ZONE,
      reminders: Array.from({ length: 10 }, (_, i) => reminder({ displayNo: i + 1, body: '가'.repeat(200) })),
      workItems: Array.from({ length: 10 }, (_, i) => item(`w${i}`, { title: '나'.repeat(200) })),
    });
    expect(Array.from(huge).length).toBeLessThanOrEqual(REMINDER_LIMITS.maxDeliveredTextChars);
  });
});
