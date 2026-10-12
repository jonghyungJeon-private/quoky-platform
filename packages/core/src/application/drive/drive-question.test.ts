import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMailQuestion } from '../mail/mail-question';
import { DRIVE_HELP_LINES } from './drive-turn-handler';
import { parseDriveQuestion } from './drive-question';

/** ADR-0120 D12: the natural-language selection corpus holds mail and Drive phrasings by design (not a routing corpus). */
const NL_SELECTION_CORPORA = new Set(['nl-intent.v1.json']);

describe('Drive grammar (ADR-0118 D4/D6/D7, DRV-1)', () => {
  it.each([
    '최근 문서',
    '최근 파일',
    '최근 문서 보여줘',
    '최근 파일 목록',
    '최근에 수정한 문서',
    '최근 수정된 파일 알려줘',
    '내가 최근에 편집한 문서 뭐 있어?',
    '드라이브 최근 파일',
    '드라이브에서 최근 문서 찾아줘',
    '최근 드라이브 문서 뭐 있어?',
    '구글 드라이브 최근 문서 보여줘',
    '요즘 수정한 스프레드시트',
    'recent documents',
    'recent drive files',
    'Show my recent docs',
    'list my recently modified files',
    'latest files in my drive',
    "what's new in my drive",
  ])('recent: %s', (text) => {
    expect(parseDriveQuestion(text)).toMatchObject({ kind: 'recent' });
  });

  it.each([
    ['드라이브에서 회의록 찾아줘', '회의록'],
    ['드라이브에서 회의록 문서 검색해줘', '회의록'],
    ['드라이브에서 회의록 파일 좀 찾아 주세요', '회의록'],
    ['드라이브에서 2026 예산 시트 찾아줘', '2026 예산'],
    ['드라이브에서 "분기 계획"이라는 문서 찾아줘', '분기 계획'],
    ['드라이브에서 계약서 이름의 파일 찾아줘', '계약서'],
    ['드라이브에서 회의록 문서 보여줘', '회의록'],
    ['내 드라이브에서 온보딩 찾아봐', '온보딩'],
    ['회의록 문서 드라이브에서 찾아줘', '회의록'],
    ['구글 드라이브 회의록 찾아줘', '회의록'],
    ['구글 드라이브에서 Q3 plan 검색', 'Q3 plan'],
    ['find budget in my drive', 'budget'],
    ['find the doc called Q3 plan in google drive', 'Q3 plan'],
    ['search my drive for onboarding checklist', 'onboarding checklist'],
    ['look for "release notes" in google drive', 'release notes'],
    // Review P3-2: the location, the owner and "newest first" are not part of the name.
    ['드라이브에 있는 예산 문서 찾아줘', '예산'],
    ['드라이브에서 내 이력서 찾아줘', '이력서'],
    ['드라이브에서 최근 회의록 찾아줘', '회의록'],
    ['find my resume in my drive', 'resume'],
  ])('name search: %s', (text, name) => {
    expect(parseDriveQuestion(text)).toEqual({ kind: 'search', name, language: /[가-힣]/.test(text) ? 'ko' : 'en' });
  });

  it.each([
    // A time word, a relative time, a pronoun or a topic is not a name: search is by file name only.
    '드라이브에서 어제 문서 찾아줘',
    '드라이브에서 오늘 파일 찾아줘',
    '드라이브에서 지난주에 문서 찾아줘',
    '드라이브에서 3일 전 문서 찾아줘',
    '드라이브에서 모든 문서 찾아줘',
    '드라이브에서 이 파일 찾아줘',
    '드라이브에서 회의 관련 문서 찾아줘',
    '드라이브에서 예산에 관한 문서 검색해줘',
    '드라이브에서 찾아줘',
    'find files about budget in my drive',
    'find yesterday in my drive',
    'search drive for everything',
    '11번 문서 요약해줘',
    '0번 문서 요약해줘',
    // Review P2-2: a time filter or a who-made-it phrase anywhere in the head is not a name.
    '드라이브에서 오늘 수정한 문서 찾아줘',
    '드라이브에서 어제 만든 회의록 찾아줘',
    '드라이브에서 지난주 회의록 찾아줘',
    '드라이브에서 3일 전 자료 찾아줘',
    '드라이브에서 내가 작성한 문서 찾아줘',
    '김철수가 공유한 문서 드라이브에서 찾아줘',
    'find report from last week in my drive',
    'find notes created yesterday in my drive',
    "find yesterday's notes in my drive",
  ])('usage line: %s', (text) => {
    expect(parseDriveQuestion(text)?.kind).toBe('usage');
  });

  it.each([
    ['1번 문서 요약해줘', { kind: 'index', index: 1 }, true],
    ['3번 문서 요약', { kind: 'index', index: 3 }, true],
    ['10번째 문서 내용 요약해 주세요', { kind: 'index', index: 10 }, true],
    ['문서 2번 요약해줘', { kind: 'index', index: 2 }, true],
    ['드라이브 3번 요약해줘', { kind: 'index', index: 3 }, true],
    ['2번 드라이브 파일 요약해줘', { kind: 'index', index: 2 }, true],
    ['두 번째 문서 요약해줘', { kind: 'index', index: 2 }, true],
    ['첫 번째 문서 요약', { kind: 'index', index: 1 }, true],
    ['이 드라이브 문서 요약해줘', { kind: 'this' }, true],
    ['이 문서 요약해줘', { kind: 'this' }, false],
    ['그 문서 요약', { kind: 'this' }, false],
    ['summarize document 3', { kind: 'index', index: 3 }, true],
    ['Summarize doc #1', { kind: 'index', index: 1 }, true],
    ['summarize drive file 2', { kind: 'index', index: 2 }, true],
    ['summarize this drive document', { kind: 'this' }, true],
    ['summarize this drive file', { kind: 'this' }, true],
    ['summarize this document', { kind: 'this' }, false],
  ])('summary request: %s', (text, target, explicit) => {
    expect(parseDriveQuestion(text)).toMatchObject({ kind: 'summarize', target, explicit });
  });

  it.each([
    '드라이브에서 회의록 삭제해줘',
    '드라이브 문서 공유해줘',
    '구글 드라이브 회의록 지워줘',
    '드라이브에 문서 만들어줘',
    '드라이브에서 회의록 이름 바꿔줘',
    '드라이브에서 예산 시트 권한 변경해줘',
    '회의록 드라이브에 올려줘',
    '이거 드라이브에 저장해줘',
    '3번 문서 공유해줘',
    '2번째 드라이브 파일 삭제해줘',
    '1번 문서 수정해줘',
    'share the budget doc in my drive',
    'upload this to my drive',
    'delete document 2',
    'rename drive file 3',
  ])('write request → fixed refusal: %s', (text) => {
    expect(parseDriveQuestion(text)?.kind).toBe('write-refused');
  });

  it.each([
    // Requests to write, explain or chat about a document, never a Drive read.
    '드라이브 사용법 알려줘',
    '드라이브에서 파일 찾는 법 알려줘',
    '드라이브에서 문서 공유하는 방법 알려줘',
    '드라이브 회의록 알려줘',
    '드라이브에서 회의록 내용 알려줘',
    '구글 드라이브 연동돼?',
    'how do I find files in my drive',
    'find me in drive',
    'find out how to share in my drive',
    // A car trip or a local disk is not the cloud drive.
    '드라이브 코스 찾아줘',
    '드라이브 갈래?',
    '드라이브 코스 수정해줘',
    '드라이브 회의록 찾아줘',
    'D 드라이브에서 파일 찾아줘',
    'USB 드라이브에 저장해줘',
    '외장 드라이브에서 사진 찾아줘',
    // A document or file with no drive word (a Confluence page, a code file, an attachment).
    '회의록 문서 찾아줘',
    '3번 파일 요약해줘',
    '이 파일 요약해줘',
    '그 파일 만들지 마',
    '파일 변경안 보여줘',
    '테스트 파일 만들어줘',
    'docs/x.md 파일을 만들어줘',
    'push 관련 문서 정리해줘',
    '문서 작성법 알려줘',
    '이 문서 요약해줘: 안녕하세요, 내일 회의는 10시입니다.',
    '드라이브에서 회의록 찾아줘: 지금',
    '할 일 추가: 드라이브에서 회의록 찾아줘',
    '최근 문서 요약해줘',
    '최근 문서 정리하는 법',
    '3번 요약해줘',
    'summarize file 3',
    // Review P2-3 / P3-1: a disk, a car or a bare "file" in English is not the cloud drive.
    'remove the usb stick from the drive',
    'move the car into drive',
    'find the bug in the drive',
    'find files in D drive',
    'copy the photos to my external drive',
    'summarize the file',
    'summarize this file',
    // CA review P2-3: a product question, an adnominal head and `on my drive` are chat, not a Drive search.
    '구글 드라이브 요금제 찾아줘',
    '구글 드라이브 대안 찾아줘',
    '구글 드라이브 가격 검색해줘',
    '드라이브에서 볼 영화 찾아줘',
    '드라이브에서 먹을 간식 찾아줘',
    '드라이브에서 들을 노래 찾아줘',
    'find a coffee shop on my drive',
    'find songs to play on my drive',
    '드라이브에서 볼만한 영화 찾아줘',
    '드라이브에서 갈만한 곳 찾아줘',
    '구글 드라이브 대체 서비스 찾아줘',
    '구글 드라이브 대체재 찾아줘',
  ])('not a Drive command (falls through): %s', (text) => {
    expect(parseDriveQuestion(text)).toBeNull();
  });

  it('still searches names that merely end in ㄹ or contain a product word later (CA review P2-3)', () => {
    for (const name of ['역할 분담표', '가을 운동회', '설 연휴 계획', '일 정리', '글 모음', '노을 사진', '물 관리']) {
      expect(parseDriveQuestion(`드라이브에서 ${name} 찾아줘`), name).toEqual({ kind: 'search', name, language: 'ko' });
    }
    expect(parseDriveQuestion('드라이브에서 서울 맛집 찾아줘')).toEqual({ kind: 'search', name: '서울 맛집', language: 'ko' });
    expect(parseDriveQuestion('드라이브에서 겨울 계획 찾아줘')).toEqual({ kind: 'search', name: '겨울 계획', language: 'ko' });
    expect(parseDriveQuestion('구글 드라이브 회의록 앱 찾아줘')).toEqual({ kind: 'search', name: '회의록 앱', language: 'ko' });
    expect(parseDriveQuestion('find budget in my drive')).toEqual({ kind: 'search', name: 'budget', language: 'en' });
  });

  it('steals no mail or calendar phrasing (pre-classify order must not depend on which connector is configured)', () => {
    const mail = [
      '안 읽은 메일', '오늘 온 메일', '메일 왔어?', '메일 확인해줘', '내 메일함에 뭐 왔어?', '김철수 메일 찾아줘',
      'GitHub에서 온 메일 보여줘', '1번 메일 요약해줘', '이 메일 요약해줘', '두 번째 메일 요약해줘', '3번 메일 삭제해줘',
      'unread emails', 'find emails from Alice', 'summarize email 4',
    ];
    const calendar = [
      '오늘 일정', '내일 일정 뭐야?', '이번 주 일정', '다음 회의 언제야?', 'Show my schedule for tomorrow', '오늘 뭐 있어?',
      '나 내일 바빠?', '캘린더 보여줘', '오늘 회의', 'Any meetings today?', '오늘 남은 일정 있어?', '일정 관리 팁 알려줘',
    ];
    for (const text of [...mail, ...calendar]) expect(parseDriveQuestion(text), text).toBeNull();
    // And the reverse: the mail grammar claims no Drive phrasing.
    for (const text of ['최근 문서', '드라이브에서 회의록 찾아줘', '1번 문서 요약해줘', 'recent documents', 'summarize document 1']) {
      expect(parseMailQuestion(text), text).toBeNull();
    }
  });

  it('every quoted help phrase is claimed by the grammar', () => {
    for (const line of DRIVE_HELP_LINES) expect(Array.from(line).length).toBeLessThanOrEqual(120);
    const quoted = [...(DRIVE_HELP_LINES[0] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    expect(quoted.length).toBe(3);
    for (const phrase of quoted) expect(parseDriveQuestion(phrase), phrase).not.toBeNull();
  });

  it('claims no golden corpus phrase (the routing corpus is unchanged with Drive configured)', () => {
    const dir = new URL('../golden/', import.meta.url);
    const claimed: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.v1.json') && name !== 'baseline.v1.json' && !NL_SELECTION_CORPORA.has(name))) {
      const suite = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { cases: Array<{ id: string; text?: string; userText?: string }> };
      for (const golden of suite.cases) {
        for (const text of [golden.text, golden.userText]) {
          if (typeof text === 'string' && parseDriveQuestion(text) !== null) claimed.push(`${golden.id}:${text}`);
        }
      }
    }
    expect(claimed).toEqual([]);
  });

  it('never claims an over-long message; total on empty and invisible-character input; linear on hostile owner text', () => {
    expect(parseDriveQuestion(`최근 문서${' '.repeat(400)}`)).toBeNull();
    expect(parseDriveQuestion('')).toBeNull();
    expect(parseDriveQuestion('최근​ 문서')).toMatchObject({ kind: 'recent' });
    const start = performance.now();
    for (const hostile of [
      `드라이브에서 ${'가 '.repeat(140)}찾아줘`,
      `드라이브에서 ${'문서 '.repeat(95)}찾아줘`,
      `${'드라이브에 '.repeat(50)}올려줘`,
      `find ${'in my drive '.repeat(24)}`,
      `share ${'a '.repeat(140)}in my drive`,
    ]) {
      parseDriveQuestion(hostile);
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});
