import { describe, expect, it } from 'vitest';
import { parseReminderMessage, parseReminderWhen } from './reminder-grammar';

// ADR-0120 amendment A6 (NLA-3): the `when` span is parsed by the ADR-0101 grammar itself, so its schedule equals the
// anchored grammar's for the same time words.

const NOW = '2026-10-14T03:00:00.000Z'; // Wed 12:00 Asia/Seoul
const opts = { now: NOW, timeZone: 'Asia/Seoul' };

describe('parseReminderWhen', () => {
  it.each([
    ['내일 9시', '내일 9시에 물 마시기 알려줘'],
    ['내일 오전 9시', '내일 오전 9시에 물 마시기 알려줘'],
    ['30분 뒤', '30분 뒤에 물 마시기 알려줘'],
    ['매일 아침 8시', '매일 아침 8시에 약 먹기 알려줘'],
    ['매주 월요일 오전 10시', '매주 월요일 오전 10시에 회의 알려줘'],
    ['모레 오후 2시', '모레 오후 2시에 치과 알려줘'],
    ['내일 9시에', '내일 9시에 물 마시기 알려줘'],
  ])('%s schedules exactly as the anchored grammar does', (when, sentence) => {
    const parsed = parseReminderWhen(when, opts);
    const anchored = parseReminderMessage(sentence, opts);
    expect(parsed.kind).toBe('time');
    expect(anchored.kind).toBe('CREATE');
    if (parsed.kind === 'time' && anchored.kind === 'CREATE') {
      expect(parsed.schedule).toEqual(anchored.schedule);
      expect(parsed.firstFireAt).toBe(anchored.firstFireAt);
    }
  });

  it('clarifies what is not a time, a past time or two times; never guesses', () => {
    expect(parseReminderWhen('회의', opts)).toMatchObject({ kind: 'clarify' });
    expect(parseReminderWhen('', opts)).toMatchObject({ kind: 'clarify', reason: 'MISSING_TIME' });
    expect(parseReminderWhen('오늘 오전 9시', opts)).toMatchObject({ kind: 'clarify', reason: 'PAST_TIME' });
    expect(parseReminderWhen('내일 9시 회의', opts)).toMatchObject({ kind: 'clarify' });
  });

  it('reads an event-relative span with BRF-2', () => {
    expect(parseReminderWhen('회의 10분 전', opts)).toMatchObject({ kind: 'event', offsetMinutes: 10 });
  });
});
