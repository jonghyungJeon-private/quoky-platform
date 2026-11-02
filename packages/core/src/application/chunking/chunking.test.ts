import { describe, expect, it } from 'vitest';
import { clipHeadAndTail } from '../attachment-context';
import {
  buildUntrustedDocumentReadout,
  prepareUntrustedBody,
} from '../untrusted-document-readout';
import { neutralizeLinks } from '../link-neutralizer';
import { blockRanges, graphemeRanges, sentenceRanges } from './boundaries';
import {
  Bm25Index,
  CodePointIndex,
  DEFAULT_WINDOW_BUDGET,
  PASSAGE_MAX_CODE_POINTS,
  PASSAGE_MAX_TOKENS,
  chunk,
  codePointLength,
  computeCoverage,
  estimateTokens,
  joinSections,
  lexicalTerms,
  packWindows,
  passageAuditView,
  renderCoverageLine,
  selectStratified,
  singleWindow,
  windowReadout,
} from './index';
import type { Passage, Window } from './index';

const META = { source: 'drive', title: '회의록', author: '', date: '' } as const;

/** A deterministic generator, so the property tests are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = ['계약서', '지급일은', '잔금', '프로젝트', 'budget', 'review', '확인했습니다', '일정이', '변경되었고', 'meeting', '담당자가', 'owner'];

function proseText(seed: number, sentences: number): string {
  const next = rng(seed);
  const paragraphs: string[] = [];
  let sentenceList: string[] = [];
  for (let at = 0; at < sentences; at += 1) {
    const words = Array.from({ length: 5 + Math.floor(next() * 8) }, () => WORDS[Math.floor(next() * WORDS.length)] as string);
    sentenceList.push(`${words.join(' ')}${next() < 0.5 ? '입니다.' : ' done.'}`);
    if (next() < 0.2) {
      paragraphs.push(sentenceList.join(' '));
      sentenceList = [];
    }
  }
  if (sentenceList.length > 0) paragraphs.push(sentenceList.join(' '));
  return prepareUntrustedBody(paragraphs.join('\n\n'));
}

function expectPartition(prepared: string, passages: readonly Passage[]): void {
  const length = codePointLength(prepared);
  expect(passages.length).toBeGreaterThan(0);
  let at = 0;
  passages.forEach((passage, order) => {
    expect(passage.ordinal).toBe(order);
    expect(passage.total).toBe(passages.length);
    expect(passage.span.start).toBe(at);
    expect(passage.span.end).toBeGreaterThan(passage.span.start);
    at = passage.span.end;
  });
  expect(at).toBe(length);
  const rebuilt = passages.map((passage) => new CodePointIndex(prepared).slice(passage.span.start, passage.span.end)).join('');
  expect(rebuilt).toBe(prepared);
}

function sheetSections(rows: number, sheets = 1): { text: string; sections: ReturnType<typeof joinSections>['sections'] } {
  const parts = Array.from({ length: sheets }, (_, sheet) => ({
    frame: `[Sheet ${sheet + 1}/${sheets}] "출장비${sheet}"`,
    kind: 'table' as const,
    body: ['항목 | 금액 | 비고', ...Array.from({ length: rows }, (_, row) => `출장 ${row + 1}회 | ${(row + 1) * 1000} | 승인`)].join('\n'),
  }));
  return joinSections(parts);
}

describe('token estimate (ADR-0124 3.1)', () => {
  it('weighs Hangul at 1.0, Latin letters and digits at 0.3, the rest at 0.5, rounded up', () => {
    expect(estimateTokens('가나다라마바사아자차')).toBe(10);
    expect(estimateTokens('abcdefghij')).toBe(3);
    expect(estimateTokens('  ,,')).toBe(2);
  });
});

describe('boundaries (goldens)', () => {
  it('ends Korean sentences at 다. 요. ? and !', () => {
    const text = '계약을 확인했습니다. 일정이 바뀌었어요. 언제인가요? 바로 하세요! 끝.';
    const parts = sentenceRanges(text, { start: 0, end: text.length }).map((range) => text.slice(range.start, range.end).trim());
    expect(parts).toEqual(['계약을 확인했습니다.', '일정이 바뀌었어요.', '언제인가요?', '바로 하세요!', '끝.']);
  });

  it('keeps a fenced code block whole and puts every heading on its own block', () => {
    const text = '# 제목\n본문 첫 줄\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n## ADR-0110 결정\n- 하나\n- 둘\n';
    const blocks = blockRanges(text, { start: 0, end: text.length });
    expect(blocks.map((block) => [block.kind, block.heading])).toEqual([
      ['prose', true],
      ['prose', false],
      ['code', false],
      ['prose', true],
      ['list', false],
    ]);
    expect(blocks.map((block) => text.slice(block.start, block.end)).join('')).toBe(text);
    const code = blocks[2];
    expect(text.slice(code?.start, code?.end)).toContain('const b = 2;');
  });

  it('splits only on grapheme boundaries', () => {
    const family = '👨‍👩‍👧‍👦';
    const text = family.repeat(40);
    const index = new CodePointIndex(text);
    const pieces = graphemeRanges(text, { start: 0, end: text.length }, { maxCodePoints: 10, maxTokens: Infinity }, index);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      const slice = text.slice(piece.start, piece.end);
      expect(slice.length % family.length).toBe(0);
      expect(index.countUnits(piece.start, piece.end)).toBeLessThanOrEqual(10);
    }
  });
});

describe('chunk', () => {
  it('returns nothing for an empty item and throws for a non-item', () => {
    expect(chunk('')).toEqual([]);
    expect(() => chunk('가나다', [{ frame: '', start: 0, end: 1 }])).toThrow(RangeError);
  });

  it('starts a passage at every Markdown heading and keeps an ADR section together', () => {
    const body = ['# 결정 기록', '', '## ADR-0110 캘린더 요약', '로컬 모델만 사용한다. 예외는 없다.', '', '## ADR-0111 첨부', '파일은 3,000자로 자른다.'].join('\n');
    const passages = chunk(body);
    expectPartition(body, passages);
    const index = new CodePointIndex(body);
    const starts = passages.map((passage) => index.slice(passage.span.start, passage.span.start + 3));
    // Consecutive headings stay with the first body; the next section starts a new passage.
    expect(starts).toEqual(['# 결', '## ']);
  });

  it('never splits a code block that fits and splits a huge one at line ends with a two-line overlap', () => {
    const small = ['설명 문단입니다.', '', '```ts', 'const a = 1;', 'const b = 2;', '```', '', '끝 문단입니다.'].join('\n');
    const smallPassages = chunk(small);
    expectPartition(small, smallPassages);
    expect(smallPassages.length).toBe(1);

    const lines = Array.from({ length: 160 }, (_, at) => `const value${at} = compute(${at});`);
    const huge = `\`\`\`ts\n${lines.join('\n')}\n\`\`\``;
    const passages = chunk(huge);
    expectPartition(huge, passages);
    const index = new CodePointIndex(huge);
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.kind).toBe('code');
      expect(passage.span.end - passage.span.start).toBeLessThanOrEqual(PASSAGE_MAX_CODE_POINTS);
    }
    const second = passages[1] as Passage;
    expect(second.overlap).toBeDefined();
    const overlapText = index.slice((second.overlap as { start: number }).start, (second.overlap as { end: number }).end);
    expect(overlapText.split('\n').filter((line) => line.length > 0).length).toBeLessThanOrEqual(2);
    // The overlap is the end of the previous passage.
    const first = passages[0] as Passage;
    expect(index.slice(first.span.start, first.span.end).trimEnd().endsWith(overlapText.trimEnd())).toBe(true);
  });

  it('cuts a long paragraph at sentence ends with a one-sentence overlap of at most 150 code points and 15%', () => {
    const text = prepareUntrustedBody(Array.from({ length: 80 }, (_, at) => `${at + 1}번째 항목의 잔금 지급일이 변경되었습니다.`).join(' '));
    const passages = chunk(text);
    expectPartition(text, passages);
    const index = new CodePointIndex(text);
    expect(passages.length).toBeGreaterThan(2);
    for (const passage of passages) {
      expect(passage.span.end - passage.span.start).toBeLessThanOrEqual(PASSAGE_MAX_CODE_POINTS);
      expect(passage.estTokens).toBeLessThanOrEqual(PASSAGE_MAX_TOKENS + 200);
      expect(index.slice(passage.span.start, passage.span.end).trimEnd().endsWith('.')).toBe(true);
      if (passage.overlap !== undefined) {
        const size = passage.overlap.end - passage.overlap.start;
        expect(size).toBeLessThanOrEqual(150);
        expect(size).toBeLessThanOrEqual(Math.floor(0.15 * (passage.span.end - passage.span.start)));
      }
    }
    expect(passages.some((passage) => passage.overlap !== undefined)).toBe(true);
  });

  it('cuts text with no boundary at all on grapheme boundaries (no lone surrogate, no split sequence)', () => {
    const text = '👩🏽‍💻'.repeat(900) + '한'.repeat(1500);
    const passages = chunk(text);
    expectPartition(text, passages);
    const index = new CodePointIndex(text);
    const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const total = [...graphemes.segment(text)].length;
    let counted = 0;
    for (const passage of passages) {
      const slice = index.slice(passage.span.start, passage.span.end);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(slice)).toBe(false);
      counted += [...graphemes.segment(slice)].length;
    }
    expect(counted).toBe(total);
  });

  it('keeps every passage inside one section and frames it', () => {
    const joined = joinSections([
      { frame: '[메시지 1/3]', body: '첫 메시지입니다. 일정을 알려 주세요.' },
      { frame: '[메시지 2/3]', body: '답장입니다.' },
      { frame: '[메시지 3/3]', body: '결정했습니다. 12월 15일로 합니다.' },
    ]);
    const passages = chunk(joined.text, joined.sections);
    expectPartition(joined.text, passages);
    expect(passages.map((passage) => passage.frame)).toEqual(['[메시지 1/3]', '[메시지 2/3]', '[메시지 3/3]']);
  });

  it('is deterministic and gives equal passages equal hashes', () => {
    const text = proseText(7, 60);
    expect(chunk(text)).toEqual(chunk(text));
    const twice = chunk('같은 문단입니다.\n\n같은 문단입니다.');
    expect(twice.length).toBe(1);
    const joined = joinSections([
      { frame: 'A', body: '같은 문단입니다.' },
      { frame: 'B', body: '같은 문단입니다.' },
    ]);
    const parts = chunk(joined.text, joined.sections);
    expect(parts[0]?.contentHash).toBe(parts[1]?.contentHash);
  });
});

describe('sheet rows', () => {
  it('repeats the header row in every window and keeps row numbers', () => {
    const { text, sections } = sheetSections(400, 2);
    const passages = chunk(text, sections);
    expectPartition(text, passages);
    const index = new CodePointIndex(text);
    const header = '항목 | 금액 | 비고';
    const tablePassages = passages.filter((passage) => passage.frame.includes('Sheet 1/2'));
    expect(tablePassages.length).toBeGreaterThan(3);
    expect(tablePassages[0]?.rows?.first).toBe(1);
    expect(tablePassages[0]?.rows?.headerSpan).toBeUndefined();
    for (const passage of tablePassages.slice(1)) {
      expect(passage.rows?.headerSpan).toBeDefined();
      const span = passage.rows?.headerSpan as { start: number; end: number };
      expect(index.slice(span.start, span.end).trim()).toBe(header);
    }
    for (let at = 1; at < tablePassages.length; at += 1) {
      expect(tablePassages[at]?.rows?.first).toBe((tablePassages[at - 1]?.rows?.last ?? 0) + 1);
    }
    // One passage from the middle, alone in its window: frame, then the header row, then its rows.
    const middle = tablePassages[Math.floor(tablePassages.length / 2)] as Passage;
    const [window] = packWindows(text, passages, [middle.ordinal]);
    const lines = (window as Window).text.split('\n');
    expect(lines[0]).toBe('[Sheet 1/2] "출장비0"');
    expect(lines[1]).toBe(header);
    expect(lines[2]).not.toBe(header);
  });

  it('numbers rows from the connector row of the section', () => {
    const joined = joinSections([{ frame: '[Sheet 1/1] "x"', kind: 'table', firstRow: 5, body: ['a | b', 'c | d', 'e | f'].join('\n') }]);
    const [passage] = chunk(joined.text, joined.sections);
    expect(passage?.rows).toEqual({ first: 5, last: 7 });
  });
});

describe('windows', () => {
  it('stay within 3,000 code points and pass isSummarizableDocumentReadout (properties over generated items)', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const prepared = proseText(seed, 30 + seed * 25);
      const passages = chunk(prepared);
      expectPartition(prepared, passages);
      for (const passage of passages) {
        expect(passage.span.end - passage.span.start).toBeLessThanOrEqual(PASSAGE_MAX_CODE_POINTS);
      }
      const next = rng(seed * 31);
      const selections = [passages.map((passage) => passage.ordinal), passages.filter(() => next() < 0.4).map((passage) => passage.ordinal)];
      for (const selected of selections) {
        const windows = packWindows(prepared, passages, selected);
        const covered = new Set(windows.flatMap((window) => window.ordinals));
        expect([...covered].sort((a, b) => a - b)).toEqual([...new Set(selected)].sort((a, b) => a - b));
        for (const window of windows) {
          expect(window.codePoints).toBeLessThanOrEqual(DEFAULT_WINDOW_BUDGET.maxCodePoints);
          expect(window.estTokens).toBeLessThanOrEqual(DEFAULT_WINDOW_BUDGET.maxEstTokens);
          expect(windowReadout(window, META, true)).toBeDefined();
        }
      }
    }
  });

  it('stay within the bound for sheets too, and for an adversarial single piece', () => {
    const { text, sections } = sheetSections(300, 3);
    const passages = chunk(text, sections);
    const windows = packWindows(text, passages, passages.map((passage) => passage.ordinal));
    expect(windows.length).toBeGreaterThan(3);
    for (const window of windows) {
      expect(window.codePoints).toBeLessThanOrEqual(3000);
      expect(windowReadout(window, META, true)).toBeDefined();
    }
    const tiny = packWindows('가'.repeat(900), chunk('가'.repeat(900)), [0], { maxCodePoints: 100, maxEstTokens: 50 });
    expect(tiny[0]?.codePoints).toBeLessThanOrEqual(100);
  });

  it('marks a skipped stretch and leaves adjacent passages unmarked', () => {
    const prepared = proseText(3, 120);
    const passages = chunk(prepared);
    expect(passages.length).toBeGreaterThan(5);
    const adjacent = packWindows(prepared, passages, [1, 2]);
    expect(adjacent[0]?.text).not.toContain('[...]');
    const gapped = packWindows(prepared, passages, [0, 4]);
    expect(gapped[0]?.text).toContain('\n[...]\n');
  });

  it('give an item that fits one window exactly today\'s output (clipHeadAndTail)', () => {
    for (const seed of [1, 2, 3]) {
      const prepared = proseText(seed, 14);
      expect(codePointLength(prepared)).toBeLessThanOrEqual(3000);
      const passages = chunk(prepared);
      const one = singleWindow(prepared, passages);
      expect(one?.text).toBe(clipHeadAndTail(prepared, 3000).text);
      expect(one?.text).toBe(prepared);
      expect(clipHeadAndTail(prepared, 3000).truncated).toBe(false);
    }
  });

  it('give a sectioned item that fits exactly the body today\'s readout builds', () => {
    const sheets = [
      { title: '예산', body: ['항목 | 금액', '출장비 | 1000', '교육비 | 2000'].join('\n') },
      { title: '일정', body: ['날짜 | 내용', '12/15 | 잔금 지급'].join('\n') },
    ];
    const built = buildUntrustedDocumentReadout({ source: 'drive', title: 't', author: '', date: '', body: '', sections: sheets });
    expect(built.ok).toBe(true);
    const joined = joinSections(
      sheets.map((sheet, order) => ({
        frame: `[Sheet ${order + 1}/${sheets.length}] ${JSON.stringify(sheet.title)}`,
        kind: 'table' as const,
        body: neutralizeLinks(prepareUntrustedBody(sheet.body), 'body'),
      })),
    );
    const passages = chunk(joined.text, joined.sections);
    const one = singleWindow(joined.text, passages);
    expect(one?.text).toBe(built.ok ? built.readout.body : '');
  });

  it('does not fit one window when the item is longer than 3,000 code points', () => {
    const prepared = proseText(4, 200);
    expect(singleWindow(prepared, chunk(prepared))).toBeUndefined();
  });
});

describe('stratified selection and coverage', () => {
  it('picks the first, the last and evenly spaced passages within the window cap, by position only', () => {
    const prepared = proseText(9, 400);
    const passages = chunk(prepared);
    expect(passages.length).toBeGreaterThan(20);
    const picks = selectStratified(prepared, passages, 6);
    expect(picks[0]).toBe(0);
    expect(picks[picks.length - 1]).toBe(passages.length - 1);
    expect([...picks].sort((a, b) => a - b)).toEqual(picks);
    expect(packWindows(prepared, passages, picks).length).toBeLessThanOrEqual(6);
    // Position only: the same item shape with different words picks the same ordinals.
    const other = chunk(prepared.replace(/잔금/g, '재고'));
    if (other.length === passages.length) expect(selectStratified(prepared.replace(/잔금/g, '재고'), other, 6).length).toBeGreaterThan(0);
  });

  it('renders the coverage line from counts only', () => {
    const prepared = proseText(5, 120);
    const passages = chunk(prepared);
    const partial = computeCoverage(passages, [0, 1, 2]);
    expect(renderCoverageLine(partial, 'ko')).toBe(`전체 ${passages.length}개 구간 중 3개를 읽고 답했어요`);
    expect(renderCoverageLine(partial, 'en')).toBe(`I read 3 of ${passages.length} parts before answering.`);
    const all = computeCoverage(passages, passages.map((passage) => passage.ordinal));
    expect(all.complete).toBe(true);
    expect(renderCoverageLine(all, 'ko')).toBe(`전체 ${passages.length}개 구간을 모두 읽고 답했어요`);
  });

  it('exposes only counts to an audit', () => {
    const passage = chunk('비밀이 아닌 문단입니다.', [{ frame: '[Sheet 1/1] "민감한 제목"', start: 0, end: 13 }])[0] as Passage;
    const view = passageAuditView(passage);
    expect(Object.keys(view).sort()).toEqual(['codePoints', 'estTokens', 'kind', 'ordinal', 'total']);
    expect(JSON.stringify(view)).not.toContain('민감한');
  });
});

describe('lexical ranking', () => {
  it('matches Korean through bigrams although particles differ', () => {
    expect(lexicalTerms('지급일은')).toEqual(['지급', '급일', '일은']);
    const index = new Bm25Index(['오늘 점심은 김밥입니다', '잔금 지급일이 12월 15일로 변경되었습니다', 'Weekly budget review notes']);
    expect(index.rank('지급일을 알려줘')[0]).toBe(1);
    expect(index.rank('budget')[0]).toBe(2);
  });

  it('scores 0 for no shared term and breaks ties by document order', () => {
    const index = new Bm25Index(['alpha beta', 'alpha beta', 'gamma']);
    expect(index.scores('zzz')).toEqual([0, 0, 0]);
    expect(index.rank('alpha')).toEqual([0, 1, 2]);
  });
});
