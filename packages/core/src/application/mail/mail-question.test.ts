import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAIL_HELP_LINES } from './mail-turn-handler';
import { parseMailQuestion } from './mail-question';

/** ADR-0120 D12: the natural-language selection corpus holds mail and Drive phrasings by design (not a routing corpus). */
// Selection corpora: the model selector decides their phrases (A6 corpora: nl-action.*, agent-redteam.*), not the grammar.
const NL_SELECTION_CORPORA = new Set(['nl-intent.v1.json', 'nl-action.v1.json', 'nl-action.exec-time.v1.json', 'nl-action.unmapped.v1.json', 'nl-action.r2.v1.json', 'agent-redteam.v1.json', 'agent-redteam.a6-unmapped.v1.json']);

describe('mail grammar (ADR-0118 D4/D6/D7)', () => {
  it.each([
    ['안 읽은 메일', { unread: true, today: false }],
    ['안읽은 메일', { unread: true, today: false }],
    ['안 읽은 메일 있어?', { unread: true, today: false }],
    ['안 읽은 메일 보여줘', { unread: true, today: false }],
    ['안 읽은 메일 몇 개야?', { unread: true, today: false }],
    ['읽지 않은 메일 알려줘', { unread: true, today: false }],
    ['안 읽은 이메일 확인해줘', { unread: true, today: false }],
    ['새 메일 왔어?', { unread: true, today: false }],
    ['메일 왔어?', { unread: true, today: false }],
    ['메일 확인해줘', { unread: true, today: false }],
    ['내 메일 확인해줘', { unread: true, today: false }],
    ['내 메일함에 뭐 왔어?', { unread: true, today: false }],
    ['오늘 온 메일', { unread: false, today: true }],
    ['오늘 받은 메일 보여줘', { unread: false, today: true }],
    ['오늘 들어온 메일 있어?', { unread: false, today: true }],
    ['오늘 메일 뭐 왔어?', { unread: false, today: true }],
    ['오늘 온 메일 찾아줘', { unread: false, today: true }],
    ['오늘 안 읽은 메일', { unread: true, today: true }],
    ['unread emails', { unread: true, today: false }],
    ['Show my unread emails', { unread: true, today: false }],
    ['Did I get any emails?', { unread: true, today: false }],
    ['emails today', { unread: false, today: true }],
    ["today's emails", { unread: false, today: true }],
  ])('lists: %s', (text, expected) => {
    expect(parseMailQuestion(text)).toMatchObject({ kind: 'list', ...expected });
    expect(parseMailQuestion(text)).not.toHaveProperty('from');
  });

  it.each([
    ['김철수 메일 찾아줘', '김철수', false, false],
    ['김철수님 메일 찾아줘', '김철수', false, false],
    ['김철수가 보낸 메일 찾아줘', '김철수', false, false],
    ['김철수한테서 온 메일 찾아줘', '김철수', false, false],
    ['인사팀에서 온 메일 검색해줘', '인사팀', false, false],
    ['GitHub에서 온 메일 보여줘', 'GitHub', false, false],
    ['김철수가 보낸 메일 보여줘', '김철수', false, false],
    ['김철수님 메일 알려줘', '김철수', false, false],
    ['김철수한테서 온 메일 보여줘', '김철수', false, false],
    ['사과 메일 찾아줘', '사과', false, false],
    ['kim@example.com 메일 찾아줘', 'kim@example.com', false, false],
    ['"Acme Billing" 메일 찾아줘', 'Acme Billing', false, false],
    ['오늘 김철수가 보낸 메일 찾아줘', '김철수', true, false],
    ['김철수가 보낸 안 읽은 메일 찾아줘', '김철수', false, true],
    ['find emails from Alice', 'Alice', false, false],
    ['search for mail from billing@example.com', 'billing@example.com', false, false],
  ])('sender search: %s', (text, from, today, unread) => {
    expect(parseMailQuestion(text)).toEqual({ kind: 'list', from, today, unread, language: /[가-힣]/.test(text) ? 'ko' : 'en' });
  });

  it.each([
    '이 메일 찾아줘',
    '내 메일 찾아줘',
    '어제 메일 찾아줘',
    '모든 메일 찾아줘',
    '중요한 메일 찾아줘',
    // Re-review item 4: a relative time, a recipient (wrong direction) or a topic is not a sender.
    '3일 전 메일 찾아줘',
    '김철수에게 보낸 메일 찾아줘',
    '팀장님한테 보낸 메일 찾아줘',
    '김철수에게 보낸 메일 보여줘',
    '회의 관련 메일 찾아줘',
    '계약 관련된 메일 검색해줘',
    '예산에 관한 메일 찾아줘',
  ])(
    'a pronoun or time word is not a sender: %s → usage',
    (text) => {
      expect(parseMailQuestion(text)?.kind).toBe('usage');
    },
  );

  it.each([
    ['이 메일 요약해줘', { kind: 'this' }],
    ['이 메일 요약', { kind: 'this' }],
    ['그 메일 내용 요약해 줘', { kind: 'this' }],
    ['3번 메일 요약해줘', { kind: 'index', index: 3 }],
    ['3번 메일 요약', { kind: 'index', index: 3 }],
    ['10번째 메일 요약해주세요', { kind: 'index', index: 10 }],
    ['메일 2번 요약해줘', { kind: 'index', index: 2 }],
    ['두 번째 메일 요약해줘', { kind: 'index', index: 2 }],
    ['첫 번째 메일 요약', { kind: 'index', index: 1 }],
    ['summarize this email', { kind: 'this' }],
    ['Summarize email 4', { kind: 'index', index: 4 }],
    ['summarize email #1', { kind: 'index', index: 1 }],
  ])('summary request: %s', (text, target) => {
    expect(parseMailQuestion(text)).toMatchObject({ kind: 'summarize', target });
  });

  it('a list number outside 1..10 is the usage line', () => {
    expect(parseMailQuestion('11번 메일 요약해줘')?.kind).toBe('usage');
    expect(parseMailQuestion('0번 메일 요약해줘')?.kind).toBe('usage');
  });

  it.each([
    '메일 보내줘',
    '김철수에게 메일 보내줘',
    '팀장님께 이메일 전송해줘',
    '3번 메일 삭제해줘',
    '이 메일 보관해줘',
    '메일 전달해줘',
    '안 읽은 메일 다 읽음으로 표시해줘',
    '읽음으로 표시해줘',
    '답장 보내줘',
    '2번 메일에 답장 보내줘',
    'send an email to Bob',
    'delete this email',
    'archive the mail',
  ])('write request → fixed refusal: %s', (text) => {
    expect(parseMailQuestion(text)?.kind).toBe('write-refused');
  });

  it.each([
    // Review P2-2: writing or explaining requests, time words with particles, second person, "from me".
    '사과 메일 알려줘',
    '정중한 거절 메일 보여줘',
    '비즈니스 메일 알려줘',
    '회의 요청 메일 보여줘',
    '영어 메일 좀 보여줘',
    '첨부파일 있는 메일 보여줘',
    '지난 주에 온 메일 찾아줘',
    '이번주에 온 메일 보여줘',
    '작년에 받은 메일 찾아줘',
    '네 메일 보여줘',
    'find emails from me please',
    'find emails from me',
    // Re-review item 4: a relative time with a particle falls through like the other time words.
    '3일 전에 온 메일 찾아줘',
    '2주 전에 받은 메일 찾아줘',
    '6개월 전부터 온 메일 찾아줘',
    '메일 쓰는 법 알려줘',
    '메일 초안 써줘',
    '이 메일 확인해줘',
    '메일함이 뭐야?',
    '이 내용 메일로 보내줘',
    '"메일 보내줘"라는 문장을 영어로 번역해줘',
    'Check my email regex',
    'How do I send an email with an attachment?',
    '이 메일 요약해줘: 안녕하세요, 내일 회의는 10시입니다.',
    '이 메일 문구 다듬어줘',
    '오늘 일정',
    '안 읽은 메일 요약 기능 있어?',
    '할 일 추가: 김철수 메일 찾아줘',
    '3번 요약해줘',
  ])('not a mail command (falls through): %s', (text) => {
    expect(parseMailQuestion(text)).toBeNull();
  });

  it('every quoted help phrase is claimed by the grammar', () => {
    for (const line of MAIL_HELP_LINES) expect(Array.from(line).length).toBeLessThanOrEqual(120);
    const quoted = [...(MAIL_HELP_LINES[0] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    expect(quoted.length).toBe(4);
    for (const phrase of quoted) expect(parseMailQuestion(phrase), phrase).not.toBeNull();
  });

  it('claims no golden corpus phrase except the mailbox questions that switch with Gmail configured (QUAL-7 style)', () => {
    const dir = new URL('../golden/', import.meta.url);
    const claimed: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.v1.json') && name !== 'baseline.v1.json' && !NL_SELECTION_CORPORA.has(name))) {
      const suite = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { cases: Array<{ id: string; text?: string; userText?: string }> };
      for (const golden of suite.cases) {
        for (const text of [golden.text, golden.userText]) {
          if (typeof text === 'string' && parseMailQuestion(text) !== null) claimed.push(`${golden.id}:${text}`);
        }
      }
    }
    expect(claimed.sort()).toEqual(
      [
        'intent-155:내 메일함에 뭐 왔어?',
        'intent-156:새 메일 왔어?',
        'intent-172:메일 왔어?',
        'intent-173:메일 확인해줘',
        'intent-176:Did I get any emails?',
        'route-186:내 메일 확인해줘',
      ].sort(),
    );
  });

  it('never claims an over-long message; a line break counts as a space; total on empty and invisible-character input', () => {
    expect(parseMailQuestion(`안 읽은 메일${' '.repeat(400)}`)).toBeNull();
    expect(parseMailQuestion('안 읽은 메일\n보여줘')).not.toBeNull(); // whitespace runs collapse to one space
    expect(parseMailQuestion('')).toBeNull();
    expect(parseMailQuestion('안​ 읽은 메일')).toMatchObject({ kind: 'list', unread: true });
  });
});

describe('GML-2 thread and reply-pick forms (ADR-0118 amendment of 2026-10-12)', () => {
  it.each([
    ['이 스레드 요약해줘', { kind: 'this' }, true],
    ['이 스레드 전체 요약해줘', { kind: 'this' }, true],
    ['이 메일 스레드 요약해줘', { kind: 'this' }, false],
    ['그 메일의 스레드 요약해 줘', { kind: 'this' }, false],
    ['3번 메일 스레드 요약해줘', { kind: 'index', index: 3 }, false],
    ['3번 메일 스레드 전체 요약해줘', { kind: 'index', index: 3 }, false],
    ['3번 스레드 요약', { kind: 'index', index: 3 }, true],
    ['메일 2번 스레드 요약해줘', { kind: 'index', index: 2 }, false],
    ['두 번째 메일 스레드 요약해줘', { kind: 'index', index: 2 }, false],
    ['summarize this thread', { kind: 'this' }, true],
    ['summarize this email thread', { kind: 'this' }, false],
    ['summarize email thread 4', { kind: 'index', index: 4 }, false],
    ['summarize the thread of email 2', { kind: 'index', index: 2 }, false],
  ] as const)('%s → a thread summary', (text, target, unnamed) => {
    const parsed = parseMailQuestion(text);
    expect(parsed).toMatchObject({ kind: 'summarize', target, scope: 'thread' });
    expect((parsed as { unnamed?: true }).unnamed === true).toBe(unnamed);
  });

  it('the GML-1 forms are unchanged (no scope); an out-of-range thread number is the usage line; writes stay refused', () => {
    expect(parseMailQuestion('1번 메일 요약해줘')).toEqual({ kind: 'summarize', target: { kind: 'index', index: 1 }, language: 'ko' });
    expect(parseMailQuestion('이 메일 요약해줘')).toEqual({ kind: 'summarize', target: { kind: 'this' }, language: 'ko' });
    expect(parseMailQuestion('11번 메일 스레드 요약해줘')).toMatchObject({ kind: 'usage' });
    expect(parseMailQuestion('11번 스레드 요약해줘')).toBeNull();
    expect(parseMailQuestion('3번 메일 삭제해줘')).toMatchObject({ kind: 'write-refused' });
    expect(parseMailQuestion('이 스레드에 답장 보내줘')).toBeNull();
    expect(parseMailQuestion('스레드가 뭐야?')).toBeNull();
    expect(parseMailQuestion('What is the difference between a process and a thread?')).toBeNull();
  });

  it.each([
    ['2번 요약해줘', { kind: 'index', index: 2 }, undefined],
    ['2번만 요약', { kind: 'index', index: 2 }, undefined],
    ['두 번째 요약해줘', { kind: 'index', index: 2 }, undefined],
    ['요약해줘', { kind: 'this' }, undefined],
    ['이거 요약해 줘', { kind: 'this' }, undefined],
    ['스레드 요약해줘', { kind: 'this' }, 'thread'],
    ['2번 스레드 요약', { kind: 'index', index: 2 }, 'thread'],
    ['summarize 3', { kind: 'index', index: 3 }, undefined],
    ['summarize this', { kind: 'this' }, undefined],
    ['summarize the thread', { kind: 'this' }, 'thread'],
  ] as const)('reply-bound only: %s', (text, target, scope) => {
    // Without the reply only a thread form that names a number or a determiner is claimed (`2번 스레드 요약`); the rest
    // are not mail commands at all.
    const unbound = parseMailQuestion(text);
    if (scope === 'thread') expect(unbound === null || (unbound.kind === 'summarize' && unbound.scope === 'thread')).toBe(true);
    else expect(unbound).toBeNull();
    const bound = parseMailQuestion(text, { replyBound: true });
    expect(bound).toMatchObject({ kind: 'summarize', target, unnamed: true, ...(scope !== undefined ? { scope } : {}) });
  });

  it('a reply-bound message that is not a pick is not claimed (chat stays chat)', () => {
    for (const text of ['고마워', '이거 무슨 뜻이야?', '요약 말고 번역해줘', '2번이 제일 급해 보이네']) {
      expect(parseMailQuestion(text, { replyBound: true }), text).toBeNull();
    }
    expect(parseMailQuestion('12번 요약해줘', { replyBound: true })).toMatchObject({ kind: 'usage' });
  });
});
