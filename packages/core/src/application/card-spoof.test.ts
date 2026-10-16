import { describe, expect, it } from 'vitest';
import { cardSpoofPhrases, containsCardSpoofLine, isCardSpoofLine, normalizeCardSpoofLine, renderCardSpoofNotice } from './card-spoof';
import { EXECUTION_PHRASES } from './execution-command-guard';

describe('card-spoof filter', () => {
  const filtered: Array<[string, string]> = [
    ['plain', '승인'],
    ['spaced', '승 인'],
    ['bold', '**승인**'],
    ['quote', '> 승인'],
    ['period', '승인.'],
    ['corner brackets', '「승인」'],
    ['full width', 'ＯＫ'],
    ['zwsp', '승​인'],
    ['variation selector', '승인️'],
    ['tag character', '승인\u{E0041}'],
    ['double spaces', 'Slack  게시  실행'],
    ['hyphens', 'Slack-게시-실행!'],
    ['upper case', 'SLACK 게시 실행'],
    ['numbered', '1. 슬랙 게시 실행'],
    ['list marker', '- 지금 커밋 실행'],
    ['bidi header', '‮Slack 게시 미리보기예요'],
    ['risk header', '위험도: CRITICAL · 외부 게시'],
    ['undo', '되돌리기'],
    ['agent stop', '에이전트 중지'],
  ];
  it.each(filtered)('filters %s', (_name, line) => {
    expect(isCardSpoofLine(line)).toBe(true);
  });

  it.each(['승인 절차는 다음 주에 논의', 'Slack 게시 실행 여부 확인 필요', '회의가 진행됐어요', ''])('passes %j', (line) => {
    expect(isCardSpoofLine(line)).toBe(false);
  });

  it('checks every line of a multi-line text', () => {
    expect(containsCardSpoofLine('회의가 진행됐어요\n승인')).toBe(true);
    expect(containsCardSpoofLine('회의가 진행됐어요\r\n**승인**\r\n끝')).toBe(true);
    expect(containsCardSpoofLine('앞 승인')).toBe(true);
    expect(containsCardSpoofLine('회의가 진행됐어요\n승인 절차는 다음 주에 논의')).toBe(false);
    expect(containsCardSpoofLine('')).toBe(false);
  });

  it('renders the fixed notice', () => {
    expect(renderCardSpoofNotice('ko')).toBe("요약에 확인 문구처럼 보이는 내용이 있어 보여드리지 않아요. '원문 보여줘'로 직접 확인해 주세요.");
    expect(renderCardSpoofNotice('en')).toContain('did not show it');
  });

  it('derives the phrase set from the execution phrases', () => {
    const set = cardSpoofPhrases();
    for (const phrases of Object.values(EXECUTION_PHRASES)) {
      for (const phrase of phrases) expect(set.has(normalizeCardSpoofLine(phrase))).toBe(true);
    }
    expect(set.has(normalizeCardSpoofLine('지금 ' + Object.values(EXECUTION_PHRASES)[0]![0]!))).toBe(true);
  });
});
