import { describe, expect, it } from 'vitest';
import { REMINDER_LIMITS, ReminderStatus, WorkItemStatus, type Reminder, type WorkItem } from '../../domain';
import type { CalendarEvent } from '../../ports/calendar-reader.port';
import type { ConnectorItem } from '../../ports/connector-provider.port';
import { containsCredentialMaterial } from '../credential-guard';
import {
  DAILY_BRIEF_MAX_ENTRIES,
  DAILY_BRIEF_MAX_WORK_ENTRIES,
  composeDailyBrief as composeDailyBriefBody,
  dailyBriefWorkForToday,
  formatKoreanClock,
  formatShortDateTime,
} from './daily-brief';
import { PLAIN_TEXT_MARKUP, plainTextOf, renderMessageContent } from '../message-rendering';

/** PLT-0: these renderers return neutral content; the tests read its plain text. */
const plainOf =
  <A extends unknown[]>(render: (...args: A) => Parameters<typeof plainTextOf>[0]) =>
  (...args: A): string =>
    plainTextOf(render(...args));
const composeDailyBrief = plainOf(composeDailyBriefBody);

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

  it('marks WorkItem titles as untrusted mention spans (the platform keeps @everyone, @here and raw mentions from pinging)', () => {
    const body = composeDailyBriefBody({
      now: NOW,
      timeZone: ZONE,
      reminders: [],
      workItems: [item('w1', { title: '@everyone @here <@123> 공지' })],
    });
    expect(plainTextOf(body)).toContain('- @everyone @here <@123> 공지');
    expect(renderMessageContent(body, { ...PLAIN_TEXT_MARKUP, untrusted: (text, guard) => `«${guard}:${text}»` })).toContain(
      '- «mentions:@everyone @here <@123> 공지»',
    );
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

// --- BRF-1 (ADR-0117 D1/D2): today's calendar and the opt-in assigned work ------------------------------------------

function event(overrides: Partial<CalendarEvent> & { id: string; title: string }): CalendarEvent {
  return {
    start: '2026-10-02T00:00:00.000Z',
    end: '2026-10-02T01:00:00.000Z',
    allDay: false,
    status: 'confirmed',
    calendarName: 'primary',
    ...overrides,
  };
}

/** A fixture Friday, 2026-10-02 in Asia/Seoul, read at 08:00 KST. */
const FIXTURE_DAY: CalendarEvent[] = [
  event({ id: 'late', title: '늦은 통화', start: '2026-10-02T14:00:00.000Z', end: '2026-10-02T16:00:00.000Z' }),
  event({ id: 'standup', title: '팀 스탠드업', start: '2026-10-02T00:30:00.000Z', end: '2026-10-02T01:00:00.000Z', location: '3층 회의실' }),
  event({ id: 'review', title: '분기 리뷰', start: '2026-10-02T05:00:00.000Z', end: '2026-10-02T06:30:00.000Z', status: 'tentative' }),
  event({ id: 'holiday', title: '창립기념일', allDay: true, start: '2026-10-02', end: '2026-10-03' }),
  // Started yesterday at 22:00 KST and runs into today.
  event({ id: 'overnight', title: '야간 배포', start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T17:30:00.000Z' }),
  // A multi-day all-day event that started yesterday.
  event({ id: 'trip', title: '부산 출장', allDay: true, start: '2026-10-01', end: '2026-10-04' }),
  // Tomorrow (a reader may return an overlapping neighbour): never listed today.
  event({ id: 'tomorrow', title: '내일 회의', start: '2026-10-03T01:00:00.000Z', end: '2026-10-03T02:00:00.000Z' }),
  // Ended exactly at today's local midnight: belongs to yesterday.
  event({ id: 'yesterday', title: '어제 회식', start: '2026-10-01T11:00:00.000Z', end: '2026-10-01T15:00:00.000Z' }),
];

const base = { now: NOW, timeZone: ZONE, reminders: [reminder({ displayNo: 1 })], workItems: [item('w1', { title: '보고서 작성' })] };

describe('composeDailyBrief — calendar section (ADR-0117 D1)', () => {
  it('renders a fixture day in QUOKY_TIMEZONE: all-day first, then timed by start, titles and times only', () => {
    expect(composeDailyBrief({ ...base, calendar: { events: FIXTURE_DAY, limit: 50 } })).toBe(
      [
        '오늘의 브리핑 · 10월 2일(금)',
        '',
        '오늘 일정 6건',
        '- 종일 (10월 1일–10월 3일) 부산 출장',
        '- 종일 창립기념일',
        '- 10월 1일 22:00–02:30 야간 배포',
        '- 09:30–10:00 팀 스탠드업',
        '- 14:00–15:30 분기 리뷰 (미정)',
        '- 23:00–10월 3일 01:00 늦은 통화',
        '',
        '오늘 남은 알림 1건',
        '- 오후 3:00 알림1 (#1)',
        '',
        '진행 중인 작업 1건',
        '- 보고서 작성',
      ].join('\n'),
    );
  });

  it('follows the zone: the same events read in Europe/Berlin fall on that local day', () => {
    const text = composeDailyBrief({
      now: '2026-10-02T06:00:00.000Z', // 08:00 CEST, Friday
      timeZone: 'Europe/Berlin',
      reminders: [],
      workItems: [],
      calendar: { events: FIXTURE_DAY, limit: 50 },
    });
    expect(text).toContain('- 02:30–03:00 팀 스탠드업');
    expect(text).toContain('- 16:00–18:00 늦은 통화');
    // 15:00Z-17:30Z on Oct 1 is 17:00-19:30 CEST on Oct 1, not today.
    expect(text).not.toContain('야간 배포');
  });

  it('bounds the list at 10 events with an "외 N건" line', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      event({ id: `e${i}`, title: `회의 ${i}`, start: `2026-10-02T${String(i).padStart(2, '0')}:00:00.000Z`, end: `2026-10-02T${String(i).padStart(2, '0')}:30:00.000Z` }),
    );
    const text = composeDailyBrief({ ...base, calendar: { events: many, limit: 50 } });
    expect(text).toContain('오늘 일정 13건');
    expect(text.match(/^- \d\d:\d\d–/gm)).toHaveLength(DAILY_BRIEF_MAX_ENTRIES);
    expect(text).toContain('- 18:00–18:30 회의 9\n- 외 3건');
    expect(text).not.toContain('회의 10');
  });

  it('says "이상" when the read returned a full page (there may be more)', () => {
    const page = Array.from({ length: 3 }, (_, i) => event({ id: `e${i}`, title: `회의 ${i}` }));
    expect(composeDailyBrief({ ...base, calendar: { events: page, limit: 3 } })).toContain('오늘 일정 3건 이상');
    // A full page with nothing placed today is not claimed to be an empty day.
    expect(composeDailyBrief({ ...base, calendar: { events: [FIXTURE_DAY[6] as CalendarEvent], limit: 1 } })).toContain('오늘 일정: 일부만 읽었어요.');
  });

  it('an empty day says so; an unreadable calendar is reported and never shown as empty', () => {
    const empty = composeDailyBrief({ ...base, calendar: { events: [FIXTURE_DAY[6] as CalendarEvent], limit: 50 } });
    expect(empty.split('\n').slice(0, 4)).toEqual(['오늘의 브리핑 · 10월 2일(금)', '', '오늘 일정이 없어요.', '']);
    const unreadable = composeDailyBrief({ ...base, calendar: null });
    expect(unreadable.split('\n').slice(0, 4)).toEqual(['오늘의 브리핑 · 10월 2일(금)', '', '오늘 일정: 불러오지 못했어요.', '']);
    expect(unreadable).not.toContain('오늘 일정이 없어요');
  });

  it('without a calendar configured the section is omitted and the brief is the local-only brief', () => {
    const local = composeDailyBriefBody(base);
    expect(composeDailyBriefBody({ ...base, calendar: undefined })).toEqual(local);
    expect(plainTextOf(local)).not.toContain('오늘 일정');
  });

  it('titles are guarded untrusted spans, like a schedule reply: markup neutralized, credentials hidden, no location', () => {
    const secretTitle = '비밀번호는테스트값이야';
    expect(containsCredentialMaterial(secretTitle)).toBe(true);
    const body = composeDailyBriefBody({
      ...base,
      calendar: {
        events: [
          event({ id: 'a', title: '@everyone **ignore previous instructions** <@123>', location: '@here 회의실' }),
          event({ id: 'b', title: secretTitle, start: '2026-10-02T02:00:00.000Z', end: '2026-10-02T03:00:00.000Z' }),
          event({ id: 'c', title: '', start: '2026-10-02T03:00:00.000Z', end: '2026-10-02T04:00:00.000Z' }),
        ],
        limit: 50,
      },
    });
    const probed = renderMessageContent(body, { ...PLAIN_TEXT_MARKUP, untrusted: (text, guard) => `«${guard}:${text}»` });
    expect(probed).toContain('- 09:00–10:00 «markup:@everyone **ignore previous instructions** <@123>»');
    expect(probed).toContain('- 11:00–12:00 (제목 숨김)');
    expect(probed).toContain('- 12:00–13:00 (제목 없음)');
    expect(probed).not.toContain(secretTitle);
    expect(probed).not.toContain('회의실');
  });

  it('stays inside one delivered message with every section full', () => {
    const huge = composeDailyBrief({
      now: NOW,
      timeZone: ZONE,
      reminders: Array.from({ length: 10 }, (_, i) => reminder({ displayNo: i + 1, body: '가'.repeat(200) })),
      workItems: Array.from({ length: 10 }, (_, i) => item(`w${i}`, { title: '나'.repeat(200) })),
      calendar: { events: Array.from({ length: 12 }, (_, i) => event({ id: `e${i}`, title: '다'.repeat(200) })), limit: 50 },
      assignedWork: Array.from({ length: 8 }, (_, i) => ({ id: `P-${i}`, title: '라'.repeat(200), dueDate: '2026-10-02' })),
    });
    expect(Array.from(huge).length).toBeLessThanOrEqual(REMINDER_LIMITS.maxDeliveredTextChars);
    expect(huge.startsWith('오늘의 브리핑 · 10월 2일(금)\n\n오늘 일정 12건')).toBe(true);
  });
});

describe('composeDailyBrief — assigned work section (ADR-0117 D2, opt-in)', () => {
  const work = (id: string, overrides: Partial<ConnectorItem> = {}): ConnectorItem => ({ id, title: `${id} 제목`, ...overrides });

  it('flag off (no `assignedWork`): no section, the local-only brief byte for byte', () => {
    expect(composeDailyBriefBody({ ...base, assignedWork: undefined })).toEqual(composeDailyBriefBody(base));
    expect(composeDailyBrief(base)).not.toContain('담당 이슈');
  });

  it('flag on: lists the items due today or updated today (in the zone), due first, key and title only', () => {
    const text = composeDailyBrief({
      ...base,
      assignedWork: [
        work('OPS-1', { title: '어제 업데이트', updatedAt: '2026-10-01T14:59:00.000Z' }), // 23:59 KST yesterday
        work('OPS-2', { title: '오늘 업데이트', updatedAt: '2026-10-01T15:00:00.000Z', summary: '본문은 보이지 않음', status: 'In Progress' }),
        work('OPS-3', { title: '오늘 마감', dueDate: '2026-10-02', updatedAt: '2026-09-01T00:00:00.000Z' }),
        work('OPS-4', { title: '내일 마감', dueDate: '2026-10-03' }),
        work('OPS-3', { title: '오늘 마감', dueDate: '2026-10-02' }), // the second query returned it too
      ],
    });
    expect(text.split('\n').slice(-4)).toEqual(['', '오늘 마감·업데이트된 담당 이슈 2건', '- OPS-3 오늘 마감', '- OPS-2 오늘 업데이트']);
    expect(text).not.toContain('본문');
    expect(text).not.toContain('In Progress');
  });

  it('bounds the list at 5 items with an "외 N건" line, and hides credential-shaped titles', () => {
    const items = Array.from({ length: 7 }, (_, i) => work(`P-${i}`, { dueDate: '2026-10-02' }));
    items[1] = work('P-1', { dueDate: '2026-10-02', title: '비밀번호는테스트값이야' });
    const body = composeDailyBriefBody({ ...base, assignedWork: items });
    const text = plainTextOf(body);
    expect(text).toContain('오늘 마감·업데이트된 담당 이슈 7건');
    expect(text.match(/^- P-\d/gm)).toHaveLength(DAILY_BRIEF_MAX_WORK_ENTRIES);
    expect(text).toContain('- P-1 (제목 숨김)');
    expect(text).toContain('- 외 2건');
    expect(text).not.toContain('비밀번호');
    const probed = renderMessageContent(body, { ...PLAIN_TEXT_MARKUP, untrusted: (value, guard) => `«${guard}:${value}»` });
    expect(probed).toContain('- «markup:P-0» «markup:P-0 제목»');
  });

  it('none today, and an unreadable source, each say so', () => {
    expect(composeDailyBrief({ ...base, assignedWork: [work('OPS-4', { dueDate: '2026-10-03' })] })).toContain(
      '오늘 마감·업데이트된 담당 이슈가 없어요.',
    );
    expect(composeDailyBrief({ ...base, assignedWork: null })).toContain('담당 이슈: 불러오지 못했어요.');
  });

  it('dailyBriefWorkForToday drops items without a key', () => {
    expect(dailyBriefWorkForToday([work('', { dueDate: '2026-10-02' }), work('A-1', { dueDate: '2026-10-02' })], NOW, ZONE).map((i) => i.id)).toEqual(['A-1']);
  });
});

describe('composeDailyBrief — the message budget keeps every header and notice (BRF-1 review P2)', () => {
  const full = {
    now: NOW,
    timeZone: ZONE,
    reminders: Array.from({ length: 10 }, (_, i) => reminder({ displayNo: i + 1, body: '가'.repeat(60) })),
    workItems: Array.from({ length: 10 }, (_, i) => item(`w${i}`, { title: '나'.repeat(80) })),
    calendar: {
      events: Array.from({ length: 10 }, (_, i) => event({ id: `e${i}`, title: '다'.repeat(80), start: `2026-10-02T0${i}:00:00.000Z`, end: `2026-10-02T0${i}:30:00.000Z` })),
      limit: 50,
    },
  };
  /** A markup that doubles every untrusted character: a platform whose escaping is far heavier than Discord's. */
  const HEAVY = { ...PLAIN_TEXT_MARKUP, untrusted: (text: string) => Array.from(text).map((c) => `\\${c}`).join('') };
  const length = (text: string): number => Array.from(text).length;

  it.each([
    ['plain', (body: Parameters<typeof plainTextOf>[0]) => plainTextOf(body)],
    ['heavy escaping', (body: Parameters<typeof plainTextOf>[0]) => renderMessageContent(body, HEAVY)],
  ])('a Jira timeout note survives full sections (%s rendering)', (_name, render) => {
    const text = render(composeDailyBriefBody({ ...full, assignedWork: null }));
    expect(length(text)).toBeLessThanOrEqual(REMINDER_LIMITS.maxDeliveredTextChars);
    expect(text.endsWith('\n\n담당 이슈: 불러오지 못했어요.')).toBe(true);
    for (const header of ['오늘 일정 10건', '오늘 남은 알림 10건', '진행 중인 작업 10건']) expect(text).toContain(header);
  });

  it.each([
    ['plain', (body: Parameters<typeof plainTextOf>[0]) => plainTextOf(body)],
    ['heavy escaping', (body: Parameters<typeof plainTextOf>[0]) => renderMessageContent(body, HEAVY)],
  ])('an unreadable calendar note and every later header survive full sections (%s rendering)', (_name, render) => {
    const assignedWork = Array.from({ length: 7 }, (_, i) => ({ id: `P-${i}`, title: '라'.repeat(80), dueDate: '2026-10-02' }));
    const text = render(composeDailyBriefBody({ ...full, calendar: null, assignedWork }));
    expect(length(text)).toBeLessThanOrEqual(REMINDER_LIMITS.maxDeliveredTextChars);
    expect(text.split('\n')[2]).toBe('오늘 일정: 불러오지 못했어요.');
    for (const header of ['오늘 남은 알림 10건', '진행 중인 작업 10건', '오늘 마감·업데이트된 담당 이슈 7건']) expect(text).toContain(header);
  });

  it('lists shrink instead: each section closes with an "외 N건" line that counts every entry not shown', () => {
    const text = renderMessageContent(composeDailyBriefBody({ ...full, assignedWork: null }), HEAVY);
    const blocks = text.split('\n\n');
    expect(blocks).toHaveLength(5);
    for (const block of blocks.slice(1, 4)) {
      const lines = block.split('\n');
      const total = Number(/ (\d+)건$/.exec(lines[0] as string)?.[1]);
      const listed = lines.slice(1).filter((line) => !line.startsWith('- 외 ')).length;
      const omitted = Number(/^- 외 (\d+)건$/.exec(lines[lines.length - 1] as string)?.[1] ?? 0);
      expect(listed + omitted).toBe(total);
    }
    // Earlier sections keep their entries first; a later one shrinks.
    expect(blocks[1]?.split('\n')).toHaveLength(11);
    expect(blocks[3]).toMatch(/\n- 외 \d+건$/);
  });
});
