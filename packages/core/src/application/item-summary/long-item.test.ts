import { describe, expect, it } from 'vitest';
import { LONG_ITEM_PROGRESS_NOTICE_AFTER_MS, preparedLongItemBody, renderLongItemProgressNotice, sheetLongItemText } from './long-item';

// ADR-0124 Part L C5a-2: the handler-side preparation of a long item and the clause-PN copy.
describe('long item preparation', () => {
  it('a body is prepared exactly as today\'s builder prepares it (normalized, links neutralized)', () => {
    expect(preparedLongItemBody('첫 줄   \r\n\r\n\r\n\r\n둘째 줄')).toBe('첫 줄\n\n둘째 줄');
    expect(preparedLongItemBody('see https://example.com/x')).not.toContain('example.com');
  });

  it('sheets become `[Sheet i/n] "title"` table sections that tile the text', () => {
    const sheets = sheetLongItemText([
      { title: '예산', body: '항목,금액\n가,1\n나,2' },
      { title: '일정', body: '' },
    ]);
    expect(sheets?.sections.map((section) => [section.frame, section.kind])).toEqual([
      ['[Sheet 1/2] "예산"', 'table'],
      ['[Sheet 2/2] "일정"', 'table'],
    ]);
    expect(sheets?.prepared).toBe('항목,금액\n가,1\n나,2\n\n(empty)');
    expect(sheets?.dropped).toBe(false);
    expect(sheetLongItemText([])).toBeUndefined();
    expect(sheetLongItemText([{ title: 'x', body: '' }])).toBeUndefined();
  });

  it('the progress notice is fixed Core copy with the window count only, after 8 s', () => {
    expect(LONG_ITEM_PROGRESS_NOTICE_AFTER_MS).toBe(8_000);
    expect(renderLongItemProgressNotice(6, 'ko')).toBe('긴 문서라 이 기기에서 6개 구간으로 나눠 읽고 있어요. 조금만 기다려 주세요.');
    expect(renderLongItemProgressNotice(3, 'en')).toBe('This is a long item, so I am reading it in 3 parts on this device. It will take a moment.');
    expect(renderLongItemProgressNotice(Number.NaN, 'ko')).toContain('1개 구간');
  });
});
