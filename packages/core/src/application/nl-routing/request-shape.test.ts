import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, NL_ACTION_WORDS, containsNlTimeExpression, nlActionInputRefusal, nlActionWordGrounded } from './action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { nlRequestVeto } from './request-shape';
import { prepareSelectionInput } from './selection-input';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 A6-D3a amendment 1 (owner-approved direction 2026-10-16, Proposed): the structural vetoes of a LOCAL_WRITE.
// The selector picks the entry; Core needs no request verb, and only grammar (questions, negation, retraction, reported
// speech, hypotheticals, statements, first-person volition) turns the turn into chat. Pure.

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const offered = new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const));
const ctx = (text: string): NlValidationContext => {
  const prepared = prepareSelectionInput(text);
  if ('skip' in prepared) throw new Error(`skipped: ${prepared.skip}`);
  return { offered, groundingText: prepared.groundingText, now: '2026-10-14T03:00:00.000Z', timeZone: 'Asia/Seoul', actions: true };
};
const veto = (text: string, entryWords: readonly string[] = []) => nlRequestVeto(text, entryWords, NL_ACTION_WORDS);

describe('A6-D3a amendment 1: each veto class, Korean and English', () => {
  const classes: Record<string, readonly string[]> = {
    question: ['2번 완료하는 법', '2번 완료 처리는 어떻게 해?', '2번 언제 끝나?', '2번 완료할 수 있어?', '2번 취소할까', '2번 취소할지 모르겠어', '2번 끝났냐', 'how do I cancel a reminder?', 'how to add a todo', 'what is reminder 2?', 'is 2 done?'],
    negation: ['2번 완료하지 마', '2번 취소 안 해도 돼', '2번 취소 필요 없어', '2번 완료해줘 ㄴㄴ', '2번 완료해줘 아냐', '2번 완료해줘. 아직 실행하지는 마', "don't cancel 2", 'do not mark it done', 'not now, mark 2 complete', 'never remind me about 3'],
    retraction: ['2번 완료해줘 취소', '할 일에 추가 ㄱㄱ 취소', '2번 취소 그만해', '2번 완료해줘. 방금 요청 철회할게'],
    reported: ['팀장님이 할 일에 추가하래', '김 대리가 2번 완료하라고 했어', '2번 완료해 달래', '2번 완료하자고 했었지', '2번 완료해줘 했더니 이상해', '2번 취소한다더라', 'my boss told me to add it', 'Kim asked me to cancel 2'],
    conditional: ['그거 완료되면 알려줘', '비 오면 우산 알려줘', '만약 늦으면 2번 취소해줘', 'if it rains, remind me at 9', 'cancel 2 unless Kim calls'],
    statement: ['1번 완료했어', '알림 만들어 뒀어', '방금 거 끝냈어', '2번 완료해 줘서 고마워', '추가 질문 있어', '할 일 제목은', 'I already finished that', '2 is done', 'the undo button is missing'],
    volition: ['할 일 하나 추가할게.', '2번은 제가 할게요', '내가 2번 완료할래', '2번 취소하려고', '2번 완료해야지', '2번 완료해야 해', '2번 추가할 거야', "I'll add it myself", 'let me cancel 2'],
    example: ['예를 들어 2번 완료해줘', '예컨대 할 일에 추가', 'for example, cancel 2'],
  };
  for (const [name, texts] of Object.entries(classes)) {
    it(`${name}`, () => {
      for (const text of texts) expect(veto(text), text).toBe(name);
    });
  }

  it('requests in plain, polite, nominal, terse and colon forms are not vetoed (no verb list decides)', () => {
    for (const text of [
      '2번 완료해줘', '2번 완료해줄래?', '그거 취소해 줄 수 있어?', '2번 완료', '2번도 완료 처리 부탁드립니다', '1번 할일 체크해줘', '3번 완룐 처리해줘',
      '3일 뒤 오전 9시에 리마인더', '오늘 밤 10시에 알림:', 'todo 추가:', '투두에 "" 추가 ㄱㄱ', '알림 설정: 모레 아침 8시',
      '3번 끝났어 완료로 바꿔줘', '필요 없어 취소해줘', '아니 방금 거 되돌려줘', '1번 말고 2번 완료해줘', '해야 할 일에 올려줘', '취소 취소',
      'please complete 2', 'can you cancel 2?', 'reminder 12 cancel', "it's done, mark it complete", '까먹지 않게 적어둬',
    ]) expect(veto(text), text).toBeUndefined();
  });

  it('a negated clause that names the entry\'s own action vetoes; another clause\'s negation is a reason', () => {
    expect(veto('완료하지 말고 2번 취소해줘', ['취소'])).toBeUndefined();
    expect(veto('완료하지 말고 2번 취소해줘', ['완료'])).toBe('negation');
    expect(veto('알림 지우지 말고 그냥 둬', ['지우'])).toBe('negation');
  });
});

describe('A6-D3a amendment 1: the frame excludes the content spans; spans stay grounded verbatim', () => {
  const add = (text: string, title: string) => validateSelection({ entryId: 'todo.add', args: { title } }, ctx(text));
  const remind = (text: string, body: string, when: string) => validateSelection({ entryId: 'reminder.create', args: { body, when } }, ctx(text));

  it('a negation, question or past form inside the owner\'s content is content', () => {
    expect(add("할 일에 '야식 먹지 않기' 추가해줘", '야식 먹지 않기').ok).toBe(true);
    expect(add('할 일 추가: 로그인 왜 느린지 조사', '로그인 왜 느린지 조사').ok).toBe(true);
    expect(remind('오늘 밤 10시에 알림: 가스 밸브 잠그지 마', '가스 밸브 잠그지 마', '오늘 밤 10시').ok).toBe(true);
  });

  it('an undelimited span at the end of the message cannot swallow the negation or question of the request', () => {
    expect(add('할 일에 우유 추가하지 마', '우유 추가하지 마')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    expect(add('할 일에 우유 사기?', '우유 사기')).toMatchObject({ ok: false, reason: 'not-request', arg: 'question' });
  });

  it('titles and bodies come only from the message text', () => {
    expect(add('todo 추가: 프린터 토너 주문', '프린터 토너 주문하기')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'title' });
    expect(remind('3일 뒤 오전 9시에 월세 이체 리마인더', '월세 송금', '3일 뒤 오전 9시')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'body' });
    expect(remind('3일 뒤 오전 9시에 월세 이체 리마인더', '월세 이체', '3일 뒤 오전 9시')).toMatchObject({ ok: true, value: { args: { body: '월세 이체', when: '3일 뒤 오전 9시' } } });
  });

  it('a frame with nothing but references or nothing but content expresses no action', () => {
    expect(validateSelection({ entryId: 'todo.complete', args: { ref: '#2' } }, ctx('2번도'))).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(validateSelection({ entryId: 'reminder.cancel', args: { ref: '#13' } }, ctx('13번 알림'))).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(remind('내일 9시 우유', '우유', '내일 9시')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(add("할 일 제목은 '보고서 마감'", '보고서 마감')).toMatchObject({ ok: false, reason: 'not-request', arg: 'statement' });
  });
});

describe('A6-D3a amendment 1, review round (CA P1/P2, Codex P2)', () => {
  const v = (entryId: string, args: Record<string, string>, text: string, extra: Partial<NlValidationContext> = {}) => validateSelection({ entryId, args }, { ...ctx(text), ...extra });

  it('CA P1: a span never hides a veto unless a quote pair or a colon form to the end encloses it', () => {
    expect(v('todo.complete', { match: '회의 준비' }, '회의 준비 완료하지 마 진짜로')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    expect(v('todo.complete', { match: '회의 준비 완료하지 마' }, '회의 준비 완료하지 마 진짜로')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    expect(v('todo.add', { title: '우유 사기 추가하지 마' }, '할 일에 우유 사기 추가하지 마, 그냥 메모야')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    // A span running past a closing quote has an unpaired quote: refused.
    expect(v('todo.add', { title: "우유' 사기 추가하지 마" }, "할 일에 '우유' 사기 추가하지 마")).toMatchObject({ ok: false, reason: 'invalid-arg', arg: 'title' });
    expect(v('todo.add', { title: '우유' }, "할 일에 '우유' 사기 추가하지 마")).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    // The span's own negated action always counts, enclosed or not (here the quoted command is also reported speech).
    expect(v('todo.add', { title: '우유 사기 추가하지 마' }, "할 일에 '우유 사기 추가하지 마' 추가해줘")).toMatchObject({ ok: false, reason: 'not-request' });
    expect(v('todo.add', { title: '우유 사기 추가 안 함' }, '할 일 추가: 우유 사기 추가 안 함')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    // Enclosed content stays content; an apostrophe between letters is no quote.
    expect(v('todo.add', { title: '야식 먹지 않기' }, "할 일에 '야식 먹지 않기' 추가해줘").ok).toBe(true);
    expect(v('reminder.create', { body: '가스 밸브 잠그지 마', when: '오늘 밤 10시' }, '오늘 밤 10시에 알림: 가스 밸브 잠그지 마').ok).toBe(true);
    expect(v('todo.add', { title: "Kim's report" }, "add Kim's report to my todos").ok).toBe(true);
    // A title's own inner nouns never veto ("라면"), a span that runs to the end swallows nothing ("…하는 법 알려줘").
    expect(v('reminder.create', { body: '라면 불 끄기', when: '5분 뒤' }, '5분 뒤에 라면 불 끄기 알려줘').ok).toBe(true);
    expect(v('todo.add', { title: '추가하는 법 알려줘' }, '할 일 추가하는 법 알려줘')).toMatchObject({ ok: false, reason: 'not-request', arg: 'question' });
  });

  it('CA P1: a plain declarative -다 is a statement; action.undo needs its undo word and no recipient', () => {
    for (const text of ['피곤하다', '되돌리기 기능 좋다', '커피 마시고 싶다']) expect(v('action.undo', {}, text).ok, text).toBe(false);
    expect(v('action.undo', {}, '되돌리기 기능 좋다')).toMatchObject({ reason: 'not-request', arg: 'statement' });
    expect(v('action.undo', {}, 'undo would be nice')).toMatchObject({ reason: 'not-request', arg: 'wish' });
    expect(v('action.undo', {}, '친구한테 책 돌려줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(v('action.undo', {}, '고마워')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    for (const text of ['되돌려줘', '방금 거 원래대로', '취소 취소', '2번 완료합시다'.replace('2번 완료', '되돌리기 ')]) expect(v('action.undo', {}, text).ok, text).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 완료 부탁드립니다').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 완료한다')).toMatchObject({ reason: 'not-request', arg: 'statement' });
  });

  it('CA P2: hearsay, relay, whole-message quotes and quoted commands, wishes and hedges, deferred timing', () => {
    const cases: Array<[string, string, Record<string, string>, string]> = [
      ['민수가 2번 완료한대', 'todo.complete', { ref: '#2' }, 'reported'],
      ['2번 취소했대요', 'todo.cancel', { ref: '#2' }, 'reported'],
      ['민수 말로는 3번 취소할 거래', 'todo.cancel', { ref: '#3' }, 'reported'],
      ['팀장님한테 2번 끝났다고 전해줘', 'todo.complete', { ref: '#2' }, 'reported'],
      ['김 대리한테 3번 취소하라고 전해줘', 'todo.cancel', { ref: '#3' }, 'reported'],
      ['"2번 완료해줘"', 'todo.complete', { ref: '#2' }, 'reported'],
      ['이 문장 영어로 바꿔줘 "1번 완료 처리해줘"', 'todo.complete', { ref: '#1' }, 'reported'],
      ['이 문장 영어로 바꿔줘 "1번 완료 처리해줘"', 'todo.add', { title: '1번 완료 처리해줘' }, 'reported'],
      ['2번 완료하고 싶다', 'todo.complete', { ref: '#2' }, 'wish'],
      ['3번 알림 꺼지길 바래', 'reminder.cancel', { ref: '#3' }, 'wish'],
      ['2번 취소 희망', 'todo.cancel', { ref: '#2' }, 'wish'],
      ['should I cancel 2', 'todo.cancel', { ref: '#2' }, 'wish'],
      ['maybe complete 2', 'todo.complete', { ref: '#2' }, 'wish'],
      ['회의 끝나고 2번 완료해줘', 'todo.complete', { ref: '#2' }, 'deferred'],
      ['점심 먹은 뒤에 2번 완료해줘', 'todo.complete', { ref: '#2' }, 'deferred'],
      ['나중에 3번 취소해줘', 'todo.cancel', { ref: '#3' }, 'deferred'],
      ['after the meeting, cancel 2', 'todo.cancel', { ref: '#2' }, 'deferred'],
    ];
    for (const [text, entryId, args, veto] of cases) expect(v(entryId, args, text), text).toMatchObject({ ok: false, reason: 'not-request', arg: veto });
    // A reminder's own time words are its time, not a deferral; a reason clause with 나중에 is no deferral either.
    expect(v('reminder.create', { body: '서류 제출', when: '이따 3시' }, '이따 3시에 서류 제출 알려줘').ok).toBe(true);
    expect(v('todo.add', { title: '치과 예약 전화하기' }, '나중에 까먹지 않게 할 일에 치과 예약 전화하기 적어둬').ok).toBe(true);
  });

  it('Codex P2 (round 2): a quoted title holding an action noun is content; a quoted request is still reported', () => {
    expect(v('todo.add', { title: '보고서 추가 검토' }, "할 일에 '보고서 추가 검토' 추가해줘").ok).toBe(true);
    expect(v('todo.add', { title: '작업 완료 보고' }, '할 일에 "작업 완료 보고" 넣어줘').ok).toBe(true);
    expect(v('todo.add', { title: '1번 완료 처리해줘' }, "할 일에 '1번 완료 처리해줘' 추가해줘")).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(v('todo.add', { title: '그 메일 지워' }, '할 일에 "그 메일 지워" 추가해')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(v('todo.complete', { ref: '#1' }, '이 문장 영어로 바꿔줘 "1번 완료 처리해줘"')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(v('todo.complete', { ref: '#2' }, '"2번 완료해줘"')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(v('todo.cancel', { ref: '#3' }, '이거 번역해줘 "please cancel 3"')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
  });

  it('CA P2: Hangul speaker labels are refused by the input guard like "Kim: …"', () => {
    for (const text of ['팀장님: 2번 완료해줘', '[김대리] 할 일에 보고서 정리 추가해줘', '팀장님 왈 3번 취소해줘', 'Kim: 2번 완료해줘']) {
      const prepared = prepareSelectionInput(text);
      expect('skip' in prepared ? 'skip' : nlActionInputRefusal(text, prepared.groundingText), text).toBe('not-plain');
    }
    for (const text of ['알림 설정: 모레 아침 8시 이사 업체 전화', 'todo 추가: 프린터 토너 주문', '[긴급] 보고서 쓰기 할 일에 추가해줘']) {
      const prepared = prepareSelectionInput(text);
      expect('skip' in prepared ? 'skip' : nlActionInputRefusal(text, prepared.groundingText), text).toBeUndefined();
    }
  });

  it('Codex P2: a request then a bare retraction; a polite -나요; a statement then an acknowledgement', () => {
    expect(v('todo.cancel', { ref: '#2' }, '2번 취소해줘. 취소')).toMatchObject({ reason: 'not-request', arg: 'retraction' });
    expect(v('action.undo', {}, '취소 취소').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 완료해 줄 수 있나요?').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 완료해 주실래요').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 완료했어 고마워')).toMatchObject({ reason: 'not-request', arg: 'statement' });
    expect(v('todo.complete', { ref: '#2' }, '2번 끝났어 완료로 바꿔줘').ok).toBe(true);
  });

  it('the R5a seam: nlActionWordGrounded keeps its signature; requestFrame strips the caller\'s phrases first', () => {
    expect(nlActionWordGrounded('2번 완료해줘', ['완료'])).toBe(true);
    expect(nlActionWordGrounded('2번 완료하지 마', ['완료'])).toBe(false);
    expect(nlActionWordGrounded('2번 체크해줘', ['완료'])).toBe(false);
    // An origin phrase with a past form ("내가 보냈던 거" → a statement would not fire, but "아까 말했잖아" would) is stripped.
    const text = '아까 보냈다더라 그거 완료해줘';
    expect(v('todo.complete', { ref: 'this' }, text)).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(v('todo.complete', { ref: 'this' }, text, { requestFrame: (prose) => prose.replace('아까 보냈다더라', ' ') }).ok).toBe(true);
  });
});

describe('A6-D3a amendment 1, review round 3 (CA over-blocks and gaps, Codex P2)', () => {
  const v = (entryId: string, args: Record<string, string>, text: string) => validateSelection({ entryId, args }, ctx(text));

  it('over-blocks fixed: these requests execute', () => {
    const executes: Array<[string, string, Record<string, string>]> = [
      // CA 3: a veto word inside the title or the reminder text
      ['할 일에 라면 추가해줘', 'todo.add', { title: '라면' }],
      ['내일 12시에 냉면 알려줘', 'reminder.create', { body: '냉면', when: '내일 12시' }],
      ['할 일에 희망퇴직 추가해줘', 'todo.add', { title: '희망퇴직' }],
      ['희망퇴직 서류 제출 할 일에 추가해줘', 'todo.add', { title: '희망퇴직 서류 제출' }],
      ['퇴근 후 장보기 할 일에 추가해줘', 'todo.add', { title: '퇴근 후 장보기' }],
      ['할 일에 퇴근 후 장보기 추가해줘', 'todo.add', { title: '퇴근 후 장보기' }],
      ['점심 먹은 후 약 먹기 1시에 알려줘', 'reminder.create', { body: '점심 먹은 후 약 먹기', when: '1시' }],
      ['내일 9시에 비 오면 우산 챙기기 알려줘', 'reminder.create', { body: '비 오면 우산 챙기기', when: '내일 9시' }],
      ['이따가 5시에 빨래 알려줘', 'reminder.create', { body: '빨래', when: '5시' }],
      // CA 4: the negation belongs to the content verb
      ['할 일에 야식 먹지 않기 추가해줘', 'todo.add', { title: '야식 먹지 않기' }],
      ['야식 먹지 않기 할 일에 추가해줘', 'todo.add', { title: '야식 먹지 않기' }],
      // CA 5: content that ends the message after the request verb
      ['할 일 추가해줘 운동 끝나고 샤워하기', 'todo.add', { title: '운동 끝나고 샤워하기' }],
      ['remind me at 5pm to stretch after lunch', 'reminder.create', { body: 'stretch after lunch', when: 'at 5pm' }],
      ['remind me tomorrow at 9am that the report is due', 'reminder.create', { body: 'the report is due', when: 'tomorrow at 9am' }],
      // CA 6: "-라고 해줘" to Quoky, English reason clauses, Korean first-person reason clauses
      ['내일 9시에 약 먹으라고 해줘', 'reminder.create', { body: '약 먹으라고', when: '내일 9시' }],
      ['please add milk, I need it', 'todo.add', { title: 'milk' }],
      ['complete 2, I finished it', 'todo.complete', { ref: '#2' }],
      ['할 일에 은행 다녀오기 추가해줘, 내가 자꾸 까먹어서', 'todo.add', { title: '은행 다녀오기' }],
      ['내가 자꾸 까먹으니까 할 일에 은행 다녀오기 추가해줘', 'todo.add', { title: '은행 다녀오기' }],
      // Codex P2 (round 2): a content noun in a quoted title
      ['할 일에 \'보고서 추가 검토\' 추가해줘', 'todo.add', { title: '보고서 추가 검토' }],
    ];
    for (const [text, entryId, args] of executes) expect(v(entryId, args, text), text).toMatchObject({ ok: true });
  });

  it('gaps closed: these are refused', () => {
    const refused: Array<[string, string, Record<string, string>, string]> = [
      ['2번 완료 예정', 'todo.complete', { ref: '#2' }, 'statement'],
      ['2번 완료해 버릴까', 'todo.complete', { ref: '#2' }, 'question'],
      ['2번 해도 될 듯', 'todo.complete', { ref: '#2' }, 'wish'],
      ['2번 완료인듯', 'todo.complete', { ref: '#2' }, 'wish'],
      ['2번 완료 각', 'todo.complete', { ref: '#2' }, 'wish'],
      ['민수가 할 일에 보고서 추가함', 'todo.add', { title: '보고서' }, 'statement'],
      ['원상복구 필요함', 'action.undo', {}, 'statement'],
      ['you should cancel 2', 'todo.cancel', { ref: '#2' }, 'reported'],
      ['someone should add milk to my todos', 'todo.add', { title: 'milk' }, 'reported'],
      ['she said add milk to my todos', 'todo.add', { title: 'milk' }, 'reported'],
      ['2번 완료해줘 농담이야', 'todo.complete', { ref: '#2' }, 'joke'],
      ['cancel 2 jk', 'todo.cancel', { ref: '#2' }, 'joke'],
      ['2번 하지 마', 'todo.complete', { ref: '#2' }, 'negation'],
      ['2번 완료 처리하지 마', 'todo.complete', { ref: '#2' }, 'negation'],
      // Codex P2: a quoted nominal command outside the selected span, and a quoted request with a trailing modifier
      ['"2번 완료"', 'todo.complete', { ref: '#2' }, 'reported'],
      ['이 문장 번역해줘 "2번 완료"', 'todo.complete', { ref: '#2' }, 'reported'],
      ['"2번 완료해줘 지금"', 'todo.complete', { ref: '#2' }, 'reported'],
      ['할 일에 "2번 완료해줘 지금" 추가해', 'todo.add', { title: '2번 완료해줘 지금' }, 'reported'],
    ];
    for (const [text, entryId, args, veto] of refused) expect(v(entryId, args, text), text).toMatchObject({ ok: false, reason: 'not-request', arg: veto });
    // Undo look-alikes have no undo head: chat.
    for (const text of ['되돌리기 해주는 앱 추천', '돈 좀 돌려줘']) expect(v('action.undo', {}, text), text).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    for (const text of ['되돌려줘', '원래대로 돌려놔', 'undo that please', '아까 거 원래대로 해줘']) expect(v('action.undo', {}, text).ok, text).toBe(true);
  });
});

describe('A6-D3a amendment 1, review round 4 (Codex P1/P2, CA P3)', () => {
  const v = (entryId: string, args: Record<string, string>, text: string) => validateSelection({ entryId, args }, ctx(text));

  it('Codex P1: trailing content after the request keeps its retraction, negation and joke checks', () => {
    expect(v('todo.add', { title: '우유 사기, 아니 취소' }, '할 일 추가해줘 우유 사기, 아니 취소')).toMatchObject({ ok: false, reason: 'not-request' });
    expect(v('todo.add', { title: '우유 사기, 취소' }, '할 일 추가해줘 우유 사기, 취소')).toMatchObject({ ok: false, reason: 'not-request', arg: 'retraction' });
    expect(v('todo.add', { title: '우유 사기 하지 마' }, '할 일 추가해줘 우유 사기 하지 마')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    expect(v('todo.add', { title: '우유 사기 농담이야' }, '할 일 추가해줘 우유 사기 농담이야')).toMatchObject({ ok: false, reason: 'not-request', arg: 'joke' });
    // Still content: a scoped content negation and a single-clause title ending in a cancel word.
    expect(v('todo.add', { title: '야식 먹지 않기' }, '할 일 추가해줘 야식 먹지 않기').ok).toBe(true);
    expect(v('todo.add', { title: '결제 취소' }, '할 일 추가해줘 결제 취소').ok).toBe(true);
  });

  it('Codex P2: a joke word inside enclosed content is content; a topic-marked noun after the undo word is no modifier', () => {
    expect(v('todo.add', { title: '농담 모음' }, "할 일에 '농담 모음' 추가해줘").ok).toBe(true);
    expect(v('todo.add', { title: '농담' }, '할 일에 농담 추가해줘')).toMatchObject({ ok: false, reason: 'not-request', arg: 'joke' });
    expect(v('action.undo', {}, '되돌려줘 이번에는 제대로 해줘').ok).toBe(true);
    expect(v('action.undo', {}, '되돌리기 해주는 앱 추천')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
  });

  it('CA P3: plans, guesses, sarcasm, -더라, state nouns, thanks and relief, English hedges, afterthoughts', () => {
    const refused: Array<[string, string, Record<string, string>, string]> = [
      ['2번 완료할 계획', 'todo.complete', { ref: '#2' }, 'statement'],
      ['2번 완료할 생각이야', 'todo.complete', { ref: '#2' }, 'statement'],
      ['2번 완료일걸', 'todo.complete', { ref: '#2' }, 'wish'],
      ['2번 해야 될걸', 'todo.complete', { ref: '#2' }, 'wish'],
      ['2번 완료 같은 소리 하네', 'todo.complete', { ref: '#2' }, 'joke'],
      ['되돌려줘 써봤는데 좋더라', 'action.undo', {}, 'statement'],
      ['원래대로 돌려놓은 상태', 'action.undo', {}, 'statement'],
      ['2번 취소해서 다행', 'todo.cancel', { ref: '#2' }, 'statement'],
      ['2번 취소해주셔서 감사', 'todo.cancel', { ref: '#2' }, 'statement'],
      ['probably cancel 2', 'todo.cancel', { ref: '#2' }, 'wish'],
      ['I might cancel 2', 'todo.cancel', { ref: '#2' }, 'wish'],
      ['thinking of cancelling 2', 'todo.cancel', { ref: '#2' }, 'wish'],
      ['he wants 2 cancelled', 'todo.cancel', { ref: '#2' }, 'reported'],
      ['cancel 2, kidding', 'todo.cancel', { ref: '#2' }, 'joke'],
      ['2번 완료해줘. 아 근데 그거 아직이네', 'todo.complete', { ref: '#2' }, 'retraction'],
    ];
    for (const [text, entryId, args, veto] of refused) expect(v(entryId, args, text), text).toMatchObject({ ok: false, reason: 'not-request', arg: veto });
    // Not over-blocked: a follow-up request after 근데, a plain request after a reason.
    expect(v('todo.complete', { ref: '#2' }, '2번 완료해줘. 근데 3번은 그대로 둬').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 끝났어 완료로 바꿔줘').ok).toBe(true);
  });
});

describe('A6-D3a amendment 1, final round (Codex P2)', () => {
  const undo = (text: string) => validateSelection({ entryId: 'action.undo', args: {} }, ctx(text));

  it('action.undo grounds only when the undo word is the command (a request form, or bare as the command)', () => {
    for (const text of ['되돌려줘', '되돌려 줄래', '되돌려 줄래?', '되돌리기 해줘', '원래대로 해줘', '되돌리기', '방금 거 원래대로', '원래대로 돌려놔', '실행 취소해줘', '원상복구 해줘', '취소 취소', '되돌려줘요요', '되돌려죠', 'undo', 'undo that', 'undo the last one', 'please revert that', '아까 거 undo 해줘', '되돌려줘 이번에는 제대로 해줘']) {
      expect(undo(text).ok, text).toBe(true);
    }
    // Codex P2 (after the final round): every request ending request-shape knows, spaced auxiliaries judged at the chain end.
    for (const text of ['원상복구 하세요', '취소하세요', '원복해주십시오', '되돌려 주세요', '되돌려 줄 수 있어?', '되돌려 주실래요', '원래대로 돌려 놔', '되돌리기 합시다']) {
      expect(undo(text).ok, text).toBe(true);
    }
    // Codex P2 (after 9dadff1b): whole auxiliary tokens only, sentence boundaries stop the chain, auxiliary imperatives, the
    // capability request after a bare anchor.
    for (const text of ['되돌려줘 주의 깊게', '되돌려줘. 주말 일정은 그대로 둬', '되돌려 봐', '되돌려 보세요', '되돌려 줘봐', '원래대로 돌려 줄 수 있어?', '원상복구 해 줄 수 있어?']) {
      expect(undo(text).ok, text).toBe(true);
    }
    for (const text of ['되돌려 주는 앱 추천', '되돌려 주는 기능 설명해줘', '되돌려 준 거 고마워', '원래대로 돌려 주는 버튼', '되돌려 보는 중', '되돌리기 돕는 앱 추천', '되돌려 주신 기능 설명해줘', '되돌려 주시는 앱 추천', '되돌려 보던 기능 설명해줘', '되돌려 드린 거 뭐였지']) {
      expect(undo(text).ok, text).toBe(false);
    }
    for (const text of ['되돌리기 돕는 앱 추천', '되돌리기 해주는 앱 추천', '되돌리기 기능', '되돌리는 앱 있어', '되돌리기 버튼 위치', '돈 좀 돌려줘', 'the undo button is missing']) {
      expect(undo(text).ok, text).toBe(false);
    }
  });

  it('known residual over-blocks (recorded in DECISIONS for D12 / shadow): an afterthought with 근데 / 그래도 goes to chat', () => {
    // Fail closed: chat, nothing written. Pinned in their current behaviour.
    expect(validateSelection({ entryId: 'todo.complete', args: { ref: '#2' } }, ctx('2번 완료해줘. 근데 3번은 진행 중이네'))).toMatchObject({ ok: false, reason: 'not-request', arg: 'retraction' });
    expect(validateSelection({ entryId: 'todo.complete', args: { ref: '#2' } }, ctx('2번 완료해줘. 근데 아직이네. 그래도 완료해줘'))).toMatchObject({ ok: false, reason: 'not-request', arg: 'retraction' });
  });
});

describe('A6-D3a amendment 1: corpus negatives through validateSelection (nl-action.v1 + seed)', () => {
  const load = (name: string) => (JSON.parse(readFileSync(new URL(`../golden/${name}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: unknown }> }).cases;
  const negatives = [...load('nl-action.v1.json'), ...load('nl-action.seed.v1.json')].filter((golden) => golden.expect === 'none');

  /**
   * Every selection a wrong selector could plausibly return for the text, each with grounded-looking args taken from the
   * text itself: the whole prose (and each contiguous run of words) as a title, body or match; every numeral as `#n`;
   * `this`; a reminder `when` from each run of words that is a time; the arg-less undo.
   */
  function lures(text: string): Array<{ entryId: string; args: Record<string, string> }> {
    const words = text.split(/\s+/u).filter((word) => word.length > 0);
    const runs = new Set<string>([text.trim()]);
    for (let from = 0; from < words.length; from += 1) for (let to = from + 1; to <= Math.min(words.length, from + 6); to += 1) runs.add(words.slice(from, to).join(' '));
    const refs = ['this', ...[...text.matchAll(/(\d{1,2})/gu)].map((match) => `#${match[1]}`)];
    const out: Array<{ entryId: string; args: Record<string, string> }> = [{ entryId: 'action.undo', args: {} }];
    for (const run of runs) {
      out.push({ entryId: 'todo.add', args: { title: run } });
      for (const entryId of ['todo.complete', 'todo.cancel']) out.push({ entryId, args: { match: run } });
      if (containsNlTimeExpression(run)) for (const body of runs) if (body !== run && !body.includes(run) && !run.includes(body)) out.push({ entryId: 'reminder.create', args: { body, when: run } });
    }
    for (const ref of refs) for (const entryId of ['todo.complete', 'todo.cancel', 'reminder.cancel']) out.push({ entryId, args: { ref } });
    return out;
  }
  /** Whether Core lets any lure through (spans, entry words and every check of the real validator). */
  const anyLureValidates = (text: string): boolean => {
    const prepared = prepareSelectionInput(text);
    if ('skip' in prepared) return false;
    if (nlActionInputRefusal(text, prepared.groundingText) !== undefined) return false;
    return lures(text).some((lure) => validateSelection(lure, ctx(text)).ok);
  };

  // Core refuses these for every LOCAL_WRITE lure, whatever the selector answers: must never execute.
  const VETOED: readonly string[] = [
    'a6-paraphrase-todo.add-009', // "할 일 하나 추가할게. …": first-person volition (owner 2026-10-16: none)
    'a6-reference-none-001',
    'a6-reference-none-003',
    'a6-reference-none-004',
    'a6-negative-none-001',
    'a6-negative-none-002',
    'a6-negative-none-003',
    'a6-negative-none-004',
    'a6-negative-none-005',
    'a6-negative-none-006',
    'a6-negative-none-007',
    'a6-negative-none-008',
    'a6-negative-none-009',
    'a6-negative-none-010',
    'a6-negative-none-011',
    'a6-negative-none-012',
    'a6-negative-none-013',
    'a6-negative-none-014',
    'a6-negative-none-015',
    'a6-negative-none-016',
    'a6-negative-none-017',
    'a6-negative-none-018',
    'a6-negative-none-019',
    'a6-negative-none-020',
    'a6-negative-none-021',
    'a6-negative-none-022',
    'a6-negative-none-023',
    'a6-negative-none-024',
    'a6-negative-none-025',
    'a6-negative-none-026',
    'a6-negative-none-027',
    'a6-negative-none-034',
    'a6-negative-none-035',
    'a6-negative-none-036',
    'a6-negative-none-037',
    'a6-negative-none-038',
    'a6-negative-none-039',
    'a6-negative-none-040',
    'a6-negative-none-041',
    'a6-negative-none-042',
    'a6-negative-none-043',
    'a6-negative-none-044',
    'a6-negative-none-045',
    'a6-negative-none-046',
    'a6-negative-none-048',
    'a6-negative-none-049',
    'a6-negative-none-051',
    'a6-negative-none-055',
    'a6-negative-none-056',
    'a6-negative-none-057',
    'a6-negative-none-058',
    'a6-negative-none-059',
    'a6-negative-none-060',
    'a6-negative-none-063',
    'a6-negative-none-065',
    'a6-negative-none-068',
    'a6-negative-none-069',
    'a6-negative-none-070',
    'a6-negative-none-072',
    'a6-negative-none-075',
    'a6-negative-none-077',
    'a6-negative-none-078',
    'a6-negative-none-079',
    'a6-negative-none-080',
    'a6-negative-none-081',
    'a6-negative-none-082',
    'a6-negative-none-083',
    'a6-negative-none-084',
    'a6-negative-none-085',
    'a6-negative-none-086',
    'a6-negative-none-087',
    'a6-negative-none-088',
    'a6-negative-none-089',
    'a6-negative-none-090',
    'a6-negative-none-091',
    'a6-negative-none-092',
    'a6-negative-none-093',
    'a6-negative-none-094',
    'a6-negative-none-096',
    'a6-negative-none-097',
    'a6-negative-none-098',
    'a6-negative-none-101',
    'a6-negative-none-106',
    'a6-negative-none-109',
    'a6-negative-none-111',
    'a6-negative-none-112',
    'a6-negative-none-113',
    'a6-negative-none-115',
    'a6-negative-none-117',
    'a6-negative-none-118',
    'a6-negative-none-119',
    'a6-negative-none-120',
    'a6-negative-none-121',
    'a6-negative-none-122',
    'a6-negative-none-123',
    'a6-negative-none-124',
    'a6-negative-none-125',
    'a6-negative-none-126',
    'a6-negative-none-130',
    'a6-negative-none-131',
    'a6-negative-none-132',
    'a6-negative-none-133',
    'a6-negative-none-134',
    'a6-negative-none-135',
    'a6-negative-none-136',
    'a6-negative-none-138',
    'a6-negative-none-139',
    'a6-negative-none-140',
    'a6-negative-none-141',
    'a6-negative-none-142',
    'a6-negative-none-143',
    'a6-negative-none-144',
    'a6-negative-none-145',
    'a6-negative-none-146',
    'a6-negative-none-147',
    'a6-negative-none-148',
    'a6-negative-none-151',
    'a6-negative-none-152',
    'a6-negative-none-153',
    'a6-negative-none-154',
    'a6-negative-none-155',
    'a6-negative-none-156',
    'a6-negative-none-157',
    'a6-negative-none-158',
    'a6-negative-none-159',
    'a6-negative-none-160',
    'a6-negative-none-161',
    'a6-negative-none-162',
    'a6-negative-none-163',
    'a6-negative-none-164',
    'a6-negative-none-167',
    'a6-negative-none-169',
    'a6-negative-none-170',
    'a6-negative-none-171',
    'a6-negative-none-172',
    'a6-negative-none-173',
    'a6-negative-none-174',
    'a6-negative-none-176',
    'a6-negative-none-177',
    'a6-negative-none-178',
    'a6-negative-none-179',
    'a6-negative-none-180',
    'a6-negative-none-181',
    'a6-negative-none-182',
    'a6-negative-none-183',
    'a6-negative-none-185',
    'a6-seed-neg-001',
    'a6-seed-neg-002',
    'a6-seed-neg-003',
  ];
  // Some lure validates: whether they act rests on the selector (it should answer none), on reference resolution or on
  // the reminder grammar at execution. The D12 gate's "negative captures 0" measures them.
  const SELECTOR_DEPENDENT: readonly string[] = [
    'a6-reference-none-002',
    'a6-reference-none-005',
    'a6-negative-none-047',
    'a6-negative-none-050',
    'a6-negative-none-052',
    'a6-negative-none-053',
    'a6-negative-none-054',
    'a6-negative-none-061',
    'a6-negative-none-062',
    'a6-negative-none-064',
    'a6-negative-none-066',
    'a6-negative-none-067',
    'a6-negative-none-071',
    'a6-negative-none-073',
    'a6-negative-none-074',
    'a6-negative-none-076',
    'a6-negative-none-095',
    'a6-negative-none-099',
    'a6-negative-none-100',
    'a6-negative-none-102',
    'a6-negative-none-103',
    'a6-negative-none-104',
    'a6-negative-none-105',
    'a6-negative-none-107',
    'a6-negative-none-108',
    'a6-negative-none-110',
    'a6-negative-none-114',
    'a6-negative-none-116',
    'a6-negative-none-127',
    'a6-negative-none-128',
    'a6-negative-none-129',
    'a6-negative-none-137',
    'a6-negative-none-149',
    'a6-negative-none-150',
    'a6-negative-none-165',
    'a6-negative-none-166',
    'a6-negative-none-168',
    'a6-negative-none-175',
    'a6-negative-none-184',
    'a6-seed-live-005',
  ];

  it('every pinned must-not-execute negative is refused for every lure', () => {
    for (const id of VETOED) {
      const golden = negatives.find((entry) => entry.id === id);
      expect(golden, id).toBeDefined();
      expect(anyLureValidates(golden!.text), id).toBe(false);
    }
  });

  it('the negatives some lure passes are exactly the pinned, gate-measured list', () => {
    const open = negatives.filter((golden) => anyLureValidates(golden.text)).map((golden) => golden.id);
    expect(open.sort()).toEqual([...SELECTOR_DEPENDENT].sort());
    expect(VETOED.length + SELECTOR_DEPENDENT.length).toBe(negatives.length);
  });
});
