import { describe, expect, it } from 'vitest';
import { CALENDAR_EXPRESSED } from '../calendar/calendar-question';
import { containsGroundingWord, leavesUnexpressedContent, slotSwallowsClause, unexpressedContentWords } from './grammar-residual';
import { canonicalNlKeyword } from './keyword-canonical';

// ADR-0120 follow-up 2: a Class B listing grammar answers only a message it can express entirely.
describe('unexpressedContentWords', () => {
  it('names the qualifier a grammar cannot carry', () => {
    expect(unexpressedContentWords('이번 주 정기회의 일정 있어?', CALENDAR_EXPRESSED)).toEqual(['정기']);
    expect(unexpressedContentWords('내일 스크럼 몇 시야', CALENDAR_EXPRESSED)).toEqual(['스크럼']);
    expect(unexpressedContentWords('오늘 위클리카 관련 일정', CALENDAR_EXPRESSED)).toEqual(['위클리카', '관련']);
    expect(unexpressedContentWords('이번 주 회의 중에 오후 거만', CALENDAR_EXPRESSED)).toEqual(['중에', '오후', '거만']);
    expect(unexpressedContentWords('do I have a dentist appointment tomorrow?', CALENDAR_EXPRESSED)).toEqual(['dentist']);
  });

  it('leaves nothing for what the grammar expresses (particles, endings, interrogatives and request verbs are closed classes)', () => {
    for (const text of ['오늘 일정 알려줘', '내일 일정 뭐 있어?', '이번 주는?', '나 내일 바빠?', '오늘 남은 회의 몇 개야?', "What's my next meeting?", 'am I free tomorrow?', '내일 오후 3시에 뭐 있어?', '내일 일정 다시 알려줘']) {
      expect(leavesUnexpressedContent(text, CALENDAR_EXPRESSED), text).toBe(false);
    }
  });

  it('does not count a part of the day as expressed outside a clock time (A5 made it the typed partOfDay arg)', () => {
    expect(unexpressedContentWords('내일 오후 일정 알려줘', CALENDAR_EXPRESSED)).toEqual(['오후']);
    expect(unexpressedContentWords('다음 주 수요일 오후에 뭐 있어', CALENDAR_EXPRESSED)).toEqual(['오후에']);
    expect(unexpressedContentWords("what's on this afternoon", CALENDAR_EXPRESSED)).toEqual(['afternoon']);
    expect(unexpressedContentWords('내일 오후 3시 반에 뭐 있어', CALENDAR_EXPRESSED)).toEqual([]);
  });

  it('treats ordinary polite, honorific and interrogative endings as grammar, not content (suffix morphology, no phrase list)', () => {
    for (const text of [
      '내일 일정 알려주실래요?',
      '오늘 일정이 있습니까?',
      '이번 주 일정 보여주시겠어요',
      '내일 일정 확인해 주세요',
      '내일 일정 알려드릴까요',
      '내일 일정 알려주시겠습니까',
      '오늘 회의 몇 시입니까',
      '오늘 일정 어떻게 되나요',
      '내일 일정 뭐예요',
    ]) {
      expect(unexpressedContentWords(text, CALENDAR_EXPRESSED), text).toEqual([]);
    }
    // A real qualifier is still content next to a polite ending.
    expect(unexpressedContentWords('이번 주 정기회의 일정 알려주실래요?', CALENDAR_EXPRESSED)).toEqual(['정기']);
  });

  it('adds no phrase: with an empty vocabulary every non-grammatical word counts, and function words never do', () => {
    expect(unexpressedContentWords('보여줘 좀 있어요', [])).toEqual([]);
    expect(unexpressedContentWords('weekly standup', [])).toEqual(['weekly', 'standup']);
    expect(unexpressedContentWords('x 7 "스크럼"', [])).toEqual(['스크럼']);
  });
});

describe('containsGroundingWord (a word of a typed arg the grammar does not carry)', () => {
  it('matches Latin words whole and Korean words inside a token', () => {
    expect(containsGroundingWord('weekly sync', ['week'])).toBe(false);
    expect(containsGroundingWord('this week', ['week'])).toBe(true);
    expect(containsGroundingWord('In Progress items', ['in progress'])).toBe(true);
    expect(containsGroundingWord('다음 주 수요일 오후에 뭐 있어', ['오후'])).toBe(true);
    expect(containsGroundingWord('진행중인 이슈', ['진행'])).toBe(true);
    expect(containsGroundingWord('내일 일정', ['오후', '저녁'])).toBe(false);
  });
});

describe('slotSwallowsClause (a free-text slot the catalog keyword rule would cut)', () => {
  it('is false for a slot that is already the canonical keyword, true when it swallowed a clause', () => {
    for (const slot of ['배포', '온보딩', 'DB 설계', '위클리카', '지난주 배포']) expect(slotSwallowsClause(slot, canonicalNlKeyword), slot).toBe(false);
    for (const slot of ['배포 얘기 나온 거', '결제 관련 내용', '온보딩 문서', '배포 관련']) expect(slotSwallowsClause(slot, canonicalNlKeyword), slot).toBe(true);
  });
});
