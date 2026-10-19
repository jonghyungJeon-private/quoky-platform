import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, NL_ACTION_WORDS, containsNlTimeExpression, nlActionInputRefusal, nlActionWordGrounded } from './action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { nlFrameIsCopularReference, nlFrameIsElliptical, nlRequestVeto } from './request-shape';
import { NL_ACTION_ENTRIES as ENTRIES_FOR_UNDO } from './action-entries';
import { interpretUndoConfirmReply, nlUndoIsDirect } from './undo-confirm';
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
    // Owner decision (a) of 2026-10-19, amended: a temporal clause right before the task's own words says when the task is
    // done (the title excludes it); a temporal clause before anything else still defers the request.
    expect(v('todo.add', { title: '검증 회의록 정리' }, '회의 끝나고 검증 회의록 정리 할 일에 넣어줘').ok).toBe(true);
    expect(v('todo.add', { title: '검증 회의록 정리' }, '회의 끝난 후 검증 회의록 정리 할 일에 넣어줘').ok).toBe(true);
    expect(v('todo.add', { title: '회의록 정리' }, '회의 끝나고 할 일에 회의록 정리 넣어줘')).toMatchObject({ ok: false, reason: 'not-request', arg: 'deferred' });
    expect(v('todo.add', { title: '회의록 정리' }, '회의 끝난 후 할 일에 회의록 정리 넣어줘')).toMatchObject({ ok: false, reason: 'not-request', arg: 'deferred' });
  });

  it('CA P2 (2026-10-19): only an event clause with its own predicate right before a todo.add title times the task', () => {
    const deferred = { ok: false, reason: 'not-request', arg: 'deferred' };
    // Event clauses (-고, -고 나서, -ㄴ 뒤에, -ㄴ 후에, -은 다음에) right before a to-do title: the task's own time.
    for (const text of [
      '회의 끝나고 검증 회의록 정리 할 일에 넣어줘',
      '회의 끝나고 나서 검증 회의록 정리 할 일에 넣어줘',
      '점심 먹은 뒤에 검증 회의록 정리 할 일에 넣어줘',
      '점심 먹은 후에 검증 회의록 정리 할 일에 넣어줘',
      '점심 먹은 다음에 검증 회의록 정리 할 일에 넣어줘',
    ]) expect(v('todo.add', { title: '검증 회의록 정리' }, text).ok, text).toBe(true);
    // Bare adverbs still defer, even right before the title.
    for (const text of ['나중에 우유 사기 할 일 추가해줘', '이따가 우유 사기 할 일에 넣어줘', '좀 있다가 우유 사기 할 일에 넣어줘']) {
      expect(v('todo.add', { title: '우유 사기' }, text), text).toMatchObject(deferred);
    }
    // A day or time word right before the request verb defers the write; a present-day word does not.
    expect(v('todo.add', { title: '우유 사기' }, '우유 사기 할 일에 내일 추가해줘')).toMatchObject(deferred);
    expect(v('todo.add', { title: '우유 사기' }, '우유 사기 할 일에 저녁에 추가 해줘')).toMatchObject(deferred);
    expect(v('todo.add', { title: '우유 사기' }, '우유 사기 할 일에 추가해줘').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 내일 완료해줘')).toMatchObject(deferred);
    // Complete and cancel have no task to time: an event clause before their target defers them, by title or by number.
    expect(v('todo.complete', { match: '회의 준비' }, '회의 끝나고 회의 준비 완료해줘')).toMatchObject(deferred);
    expect(v('todo.complete', { ref: '#2' }, '회의 끝나고 2번 완료해줘')).toMatchObject(deferred);
    expect(v('todo.cancel', { match: '회의 준비' }, '점심 먹은 뒤에 회의 준비 취소해줘')).toMatchObject(deferred);
    expect(v('todo.cancel', { match: '회의 준비' }, '회의 끝나고 나서 회의 준비 취소해줘')).toMatchObject(deferred);
  });

  it('CA follow-up (2026-10-19): a non-today day word on a to-do complete / cancel defers it (to-dos have no dates)', () => {
    const deferred = { ok: false, reason: 'not-request', arg: 'deferred' };
    expect(v('todo.complete', { ref: '#2' }, '내일 2번 완료해줘')).toMatchObject(deferred);
    expect(v('todo.cancel', { ref: '#3' }, '다음 주에 3번 취소해줘')).toMatchObject(deferred);
    expect(v('todo.complete', { ref: '#2' }, 'complete 2 tomorrow')).toMatchObject(deferred);
    expect(v('todo.complete', { ref: '#2' }, '오늘 2번 완료해줘').ok).toBe(true);
    expect(v('todo.complete', { ref: '#2' }, '2번 완료해줘').ok).toBe(true);
    // The target's own words are content: a title holding a time is no deferral.
    expect(v('todo.complete', { match: '1시 회의 준비' }, '1시 회의 준비 완료해줘').ok).toBe(true);
    // Accepted fail-closed residual (CA P3): a reminder with its own time after an event clause is refused as deferred.
    expect(v('reminder.create', { when: '3시', body: '회의록 정리' }, '회의 끝나고 3시에 회의록 정리 알려줘')).toMatchObject(deferred);
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
    // Undo look-alikes never execute directly (undo confirmation rule): a bare 돌려 is no undo; a descriptive use asks.
    expect(v('action.undo', {}, '돈 좀 돌려줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(nlUndoIsDirect('되돌리기 해주는 앱 추천')).toBe(false);
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
    expect(nlUndoIsDirect('되돌리기 해주는 앱 추천')).toBe(false);
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

describe('A6-D3a amendment 1, final round (Codex P2) and the undo confirmation rule', () => {
  const undo = (text: string) => validateSelection({ entryId: 'action.undo', args: {} }, ctx(text));
  const direct = (text: string) => {
    const prepared = prepareSelectionInput(text);
    return !('skip' in prepared) && nlUndoIsDirect(prepared.groundingText);
  };

  it('executes directly only an unambiguous undo command (every string of the last review rounds)', () => {
    for (const text of [
      // the coordinator's direct list
      '되돌려줘', '되돌려 두세요', '원상복구 부탁', '원복 좀', '되돌리기 좀 해줘', '되돌려줘 빨리요', '되돌려줘 제발요', '되돌려 봐', '원래대로 돌려 줄 수 있어?',
      // earlier rounds
      '되돌려 줄래', '되돌려 줄래?', '되돌리기 해줘', '원래대로 해줘', '되돌리기', '방금 거 원래대로', '원래대로 돌려놔', '실행 취소해줘', '원상복구 해줘', '취소 취소',
      '되돌려줘요요', '되돌려죠', 'undo', 'undo that', 'undo the last one', 'please revert that', '아까 거 undo 해줘', '원상복구 하세요', '취소하세요', '원복해주십시오',
      '되돌려 주세요', '되돌려 줄 수 있어?', '되돌려 주실래요', '원래대로 돌려 놔', '되돌리기 합시다', '원래대로 돌려 두세요', '되돌려 보세요', '되돌려 줘봐', '원상복구 해 줄 수 있어?',
      '잘못 눌렀어 되돌려줘', '아니 방금 거 되돌려줘', '5번 되돌려줘', '방금 추가한 거 취소해줘', '방금 처리한 거 되돌려줘',
      // A bare 취소, or one pointing at the last action by recency, stays the direct undo (gate 2026-10-19).
      '취소해줘', '취소', '방금 거 취소',
    ]) {
      expect(undo(text).ok, text).toBe(true);
      expect(direct(text), text).toBe(true);
    }
  });

  it('asks a confirmation instead (never executes directly): descriptive, mixed or extra-content messages with an undo word', () => {
    for (const text of [
      '되돌려 주셨던 기능 추천', '되돌려 봐 주는 앱 추천', '되돌려 주신 기능 설명해줘', '되돌려 주시는 앱 추천', '되돌려 보던 기능 설명해줘', '되돌려 드린 거 뭐였지',
      '되돌려 주는 앱 추천', '되돌려 주는 기능 설명해줘', '되돌려 준 거 고마워', '원래대로 돌려 주는 버튼', '되돌려 보는 중', '되돌리기 돕는 앱 추천', '되돌리기 해주는 앱 추천',
      '되돌리기 기능', '되돌리는 앱 있어', '되돌리기 버튼 위치', '되돌려 주었던 기능', '되돌려 보았던 기능',
      // Codex P1 (closed grammar, exact tokens): a prefix of an auxiliary is no auxiliary.
      '되돌려 주신 거 보여줘', '되돌려 주는 거', '되돌려 주실 분', '원래대로 돌려 주신 거',
      // the choice for "되돌려줘 주의 깊게": confirm (it carries words beyond the command); likewise "…이번에는 제대로 해줘"
      '되돌려줘 주의 깊게', '되돌려줘 이번에는 제대로 해줘', '되돌려줘. 주말 일정은 그대로 둬',
      // Gate 2026-10-19 (a6-reference-todo.cancel-011): 취소 with an object may cancel an item, never a direct undo.
      '그거 취소해 줘요', '이거 취소해줘', '3번 취소해줘', '할 일 취소해줘', '알림 취소', '취소해줘 그거',
    ]) {
      expect(direct(text), text).toBe(false);
    }
    // Refused before any confirmation: no undo word, or a statement.
    for (const text of ['돈 좀 돌려줘', 'the undo button is missing', '되돌리기 기능 좋다']) expect(undo(text).ok, text).toBe(false);
  });

  it('the confirmation answer is a narrow whole-message yes / no', () => {
    for (const text of ['응', '네', '좋아', 'yes', 'OK', '되돌려줘', '응!']) expect(interpretUndoConfirmReply(text), text).toBe('approve');
    for (const text of ['아니', '취소', '됐어', 'no']) expect(interpretUndoConfirmReply(text), text).toBe('deny');
    for (const text of ['응 근데 2번은?', '응?', '글쎄', '응 아니']) expect(interpretUndoConfirmReply(text), text).toBe('none');
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
      // Owner decision C (2026-10-17): reminder.cancel takes a `match` too.
      for (const entryId of ['todo.complete', 'todo.cancel', 'reminder.cancel']) out.push({ entryId, args: { match: run } });
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
    // Elliptical continuation (D12 gate v44 run 3): no action word, no request form, so no target lure executes; with the
    // same action fresh the runtime asks "할 일 3번도 완료할까요?" (nl-action-service.test.ts), never a write.
    'a6-reference-none-002',
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
    'a6-negative-none-116', // "ㅋㅋ 그거": elliptical (no action word, no request form) since D12 gate v44 run 3
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
    'a6-negative-none-186', // owner decision A counter-case: the bare "<title> 할 일" as a question
    'a6-negative-none-187', // owner decision C counter-cases: a negated / questioned cancel by title
    'a6-negative-none-188',
    'a6-negative-none-190', // owner decision D counter-case: a label not led by the command word (input guard)
    // A6 v49 gate (2026-10-19): the trailing clause of a label's content meets the vetoes (`nlLabelTailVeto`): a final
    // question mark and a hearsay tail are refused for every lure (both were the gate's negative captures).
    'a6-negative-none-189',
    'a6-negative-none-193',
    'a6-seed-neg-001',
    'a6-seed-neg-002',
    'a6-seed-neg-003',
  ];
  // Some lure validates: whether they act rests on the selector (it should answer none), on reference resolution or on
  // the reminder grammar at execution. The D12 gate's "negative captures 0" measures them.
  const SELECTOR_DEPENDENT: readonly string[] = [
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
    // Agent-drafted recorded gaps (owner decision D review): a status-report label validates for some lure; the selector's
    // none is the only guard. No code change for them (owner: recorded gap).
    'a6-negative-none-191',
    'a6-negative-none-192',
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

describe('live test 2026-10-16 negative captures (QUOKY_NL_ACTIONS=local)', () => {
  const v = (entryId: string, args: Record<string, string>, text: string) => validateSelection({ entryId, args }, ctx(text));

  it('I16: 장난 as the manner adverbial or the copula predicate is a joke (none), like 농담', () => {
    expect(v('reminder.create', { body: '우주 여행', when: '내일 9시' }, '장난으로 알림 걸어줘 내일 9시 우주 여행')).toMatchObject({ ok: false, reason: 'not-request', arg: 'joke' });
    for (const text of ['장난삼아 2번 완료해줘', '2번 완료해줘 장난임', '2번 취소해줘 ㅋㅋ 장난이야ㅋㅋ', 'jokingly cancel 2', 'cancel 2 as a joke', 'cancel 2, just joking']) {
      expect(veto(text), text).toBe('joke');
    }
  });

  it('I16 counter-cases: a compound of 장난 is another noun, and enclosed content is content', () => {
    expect(v('todo.add', { title: '장난감 정리' }, '장난감 정리 할 일 추가해줘')).toMatchObject({ ok: true });
    expect(v('todo.add', { title: '말장난 모음 정리' }, '말장난 모음 정리 할 일에 추가해줘')).toMatchObject({ ok: true });
    expect(v('todo.add', { title: '장난으로 만든 노래 정리' }, "할 일에 '장난으로 만든 노래 정리' 추가해줘")).toMatchObject({ ok: true });
    expect(v('reminder.create', { body: '장난감 반납', when: '내일 9시' }, '내일 9시에 장난감 반납 알려줘')).toMatchObject({ ok: true });
  });

  it('G09 (owner decision A, 2026-10-17): a bare "<title> 할 일" with no action word executes todo.add, like owner gold reminder.create-022', () => {
    // Amendment 1 D1/D3, confirmed by the owner: no action word and no request form is needed, and for a payload entry the
    // source noun names what to make. The duplicate guard (an open to-do with the same title writes nothing) stays in the
    // handler (`work-chat-actions.test.ts`).
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일')).toMatchObject({ ok: true });
    expect(v('todo.add', { title: '분기 보고서 표지 교체' }, '분기 보고서 표지 교체 할일')).toMatchObject({ ok: true });
    expect(v('reminder.create', { body: '월세 이체', when: '3일 뒤 오전 9시' }, '3일 뒤 오전 9시에 월세 이체 리마인더')).toMatchObject({ ok: true });
  });

  it('G09 counter-cases: the same bare shape as a question, a negation, a statement or with a time in the title never executes', () => {
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일 있어?')).toMatchObject({ ok: false, reason: 'not-request', arg: 'question' });
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일 맞지?')).toMatchObject({ ok: false, reason: 'not-request', arg: 'question' });
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일 아니야')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일 하지 마')).toMatchObject({ ok: false, reason: 'not-request', arg: 'negation' });
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일이었어')).toMatchObject({ ok: false, reason: 'not-request', arg: 'statement' });
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일이야')).toMatchObject({ ok: false, reason: 'not-request', arg: 'statement' });
    expect(v('todo.add', { title: '내일 세금 서류 챙기기' }, '내일 세금 서류 챙기기 할 일')).toMatchObject({ ok: false, reason: 'time-in-title' });
  });
});

describe('owner decision D (2026-10-17): English colon label forms execute like the Korean colon forms', () => {
  const eligible = (text: string, entryId: string, args: Record<string, string>) => {
    const prepared = prepareSelectionInput(text);
    if ('skip' in prepared) throw new Error(text);
    return { guard: nlActionInputRefusal(text, prepared.groundingText), result: validateSelection({ entryId, args }, ctx(text)) };
  };

  it('"Add a to-do: X", "Todo: X", "To-do: X", "Remind me: …" pass the input guard and validate, the content colon-enclosed', () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ['Add a to-do: buy milk', 'todo.add', { title: 'buy milk' }],
      ['Todo: renew passport', 'todo.add', { title: 'renew passport' }],
      ['To-do: 사무실 와이파이 비밀번호 변경', 'todo.add', { title: '사무실 와이파이 비밀번호 변경' }],
      ['Please add a todo: 분기 메모 정리', 'todo.add', { title: '분기 메모 정리' }],
      ['Remind me: tomorrow 9am call mom', 'reminder.create', { body: 'call mom', when: 'tomorrow 9am' }],
      ['Remind me tomorrow at 9am: call mom', 'reminder.create', { body: 'call mom', when: 'tomorrow at 9am' }],
      ['Done: 장보기', 'todo.complete', { match: '장보기' }],
      ['Todo: "buy milk"', 'todo.add', { title: 'buy milk' }],
    ];
    for (const [text, entryId, args] of cases) {
      const { guard, result } = eligible(text, entryId, args);
      expect(guard, text).toBeUndefined();
      expect(result, text).toMatchObject({ ok: true });
    }
  });

  it('counter-cases: questions and quoted or reported text keep their vetoes; other labels stay refused by the guard', () => {
    const vetoed: Array<[string, string, Record<string, string>, string]> = [
      ['Todo: buy milk?', 'todo.add', { title: 'buy milk' }, 'question'],
      ['Remind me: tomorrow 9am call mom?', 'reminder.create', { body: 'call mom', when: 'tomorrow 9am' }, 'question'],
      ['Add a to-do: buy milk, he said', 'todo.add', { title: 'buy milk' }, 'reported'],
      ['Todo: buy milk 라고 했어', 'todo.add', { title: 'buy milk' }, 'reported'],
      ['Add a to-do: buy milk, not now', 'todo.add', { title: 'buy milk' }, 'negation'],
    ];
    for (const [text, entryId, args, veto] of vetoed) {
      const { guard, result } = eligible(text, entryId, args);
      expect(guard, text).toBeUndefined();
      expect(result, text).toMatchObject({ ok: false, reason: 'not-request', arg: veto });
    }
    // A quoted label, a label that does not lead with the command word, a question form and a second key: the guard refuses.
    for (const text of ['"Todo: buy milk" he said', 'he told me to write "Todo: buy milk"', 'How do I add a to-do: buy milk', 'I added a to-do: buy milk', 'Todo: request: buy milk', 'Q4: 예산 검토 할 일로']) {
      expect(eligible(text, 'todo.add', { title: 'buy milk' }).guard, text).toBe('not-plain');
    }
  });
});

describe('A6-D3a amendment 1, elliptical continuation (D12 gate v44 run 3): no action word and no request form never executes', () => {
  const v = (entryId: string, args: Record<string, string>, text: string) => validateSelection({ entryId, args }, ctx(text));

  it('a frame without any A6 action word and without a request form is elliptical', () => {
    for (const text of ['이번엔 3번', '그럼 3번', '이번엔 3번요', '3 too', 'now 3', '2번 체크', '2번 check']) expect(nlFrameIsElliptical(text, NL_ACTION_WORDS), text).toBe(true);
    // CA review P2: the light-verb class (해/하, 처리, 부탁, ㄱㄱ, 고고, 똑같이, do/please) requests without naming an action.
    for (const text of ['3번도 해줘', '이번엔 3번 해줘', '그럼 3번 부탁해', '3번도 ㄱㄱ', '3번도 고고', '3번도 처리해줘', '3번도 똑같이 해줘', '3번 해 주세요', '3번 부탁드립니다', 'do 3 too please']) {
      expect(nlFrameIsElliptical(text, NL_ACTION_WORDS), text).toBe(true);
    }
    for (const text of ['이번엔 3번 완료', '3번도 완료해줘', '1번 할일 체크해줘', '2번 할 일 빼', 'mark 3 done', 'complete 3 too', '3번 완료 처리해줘', '3번도 빼줘']) {
      expect(nlFrameIsElliptical(text, NL_ACTION_WORDS), text).toBe(false);
    }
  });

  it('a target entry refuses it as `elliptical` (gold a6-reference-none-002); payload entries and clear requests are unchanged', () => {
    for (const entryId of ['todo.complete', 'todo.cancel', 'reminder.cancel']) {
      expect(v(entryId, { ref: '#3' }, '이번엔 3번'), entryId).toMatchObject({ ok: false, reason: 'elliptical', arg: 'action' });
    }
    // A reference alone is still `ungrounded` (the frame expresses nothing), as before.
    expect(v('todo.complete', { ref: '#3' }, '3번')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(v('todo.complete', { ref: '#3' }, '이번엔 3번 완료')).toMatchObject({ ok: true });
    expect(v('todo.complete', { ref: '#1' }, '1번 할일 체크해줘')).toMatchObject({ ok: true });
    // Owner decision A: a bare payload names what to make and acts (no action word needed for a payload entry).
    expect(v('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일')).toMatchObject({ ok: true });
    // An inflected action word names its action even with only the light verb around it (garbled-action inflection rule).
    expect(v('todo.complete', { ref: '#2' }, '2번 끝냄 처리해줘')).toMatchObject({ ok: true });
    expect(v('todo.complete', { ref: '#3' }, '3번도 해줘')).toMatchObject({ ok: false, reason: 'elliptical' });
    expect(v('todo.complete', { ref: '#2' }, '2번 체크')).toMatchObject({ ok: false, reason: 'elliptical' });
    // The garbled action word keeps its own question first.
    expect(v('todo.complete', { ref: '#3' }, '3번 완룐 처리해줘')).toMatchObject({ ok: false, reason: 'garbled-action' });
  });
});

describe('live test 4 (turn 39): a bare reference with the copula is a copular reference, not a fact (nlFrameIsCopularReference)', () => {
  it('a numeral or ordinal reference with the copula, in an elliptical frame', () => {
    for (const text of ['이번엔 3번이야', '그럼 3번이요', '이번엔 4번입니다', '세 번째야', '그 다음은 2번이에요']) expect(nlFrameIsCopularReference(text, NL_ACTION_WORDS), text).toBe(true);
  });

  it('not a reference, an action word, a request or no copula', () => {
    for (const text of ['3번은 회의야', '그냥 메모야', '3번 완료야', '3번 완료해줘', '이번엔 3번', '3번이 문제야']) expect(nlFrameIsCopularReference(text, NL_ACTION_WORDS), text).toBe(false);
  });
});

describe('CA review of 2026-10-19: colon labels act only as the owner\'s own command; a bare list phrase is no task', () => {
  const NOW_ = '2026-10-14T03:00:00.000Z';
  const offered_ = new Map([...NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]), ...Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined)].map((entry) => [entry.id, entry] as const));
  const check = (entryId: string, args: Record<string, string>, text: string) => {
    const prepared = prepareSelectionInput(text);
    if ('skip' in prepared) throw new Error('skipped');
    return validateSelection({ entryId, args }, { offered: offered_, groundingText: prepared.groundingText, now: NOW_, timeZone: 'Asia/Seoul', actions: true });
  };

  it('P1: a whole-message quote, a label that does not open the message, and a second key inside the content are reported', () => {
    expect(check('todo.add', { title: '우유 사기' }, '"할 일: 우유 사기"')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '보고서 제출' }, '회의록 중 할 일: 보고서 제출')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '보고서 제출, 담당: 김대리' }, '회의록 붙여넣기 할 일: 보고서 제출, 담당: 김대리')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '보고서 제출' }, '회의록 붙여넣기 할 일: 보고서 제출, 담당: 김대리')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '보고서 제출, 담당: 김대리' }, '할 일: 보고서 제출, 담당: 김대리')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('reminder.create', { when: '내일 9시', body: '보고서' }, '회의록 중 알림: 내일 9시 보고서')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
  });

  it('P1: the English label forms the input guard already refuses stay refused', () => {
    for (const text of ['I added a to-do: renew passport', 'My todo: buy milk', 'Did you add a to-do: renew passport', 'Q4: 예산 검토 할 일로', 'Todo: request: buy milk']) {
      const prepared = prepareSelectionInput(text);
      if ('skip' in prepared) continue;
      expect(nlActionInputRefusal(text, prepared.groundingText, false), text).toBeDefined();
    }
  });

  it('P1: the owner\'s own labels still act (opening the message, after a time, or after a request)', () => {
    expect(check('todo.add', { title: 'return the library books' }, 'To-do: return the library books')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '세탁소에서 셔츠 찾아오기' }, '할 일: 세탁소에서 셔츠 찾아오기')).toMatchObject({ ok: true });
    expect(check('reminder.create', { when: '10월 23일 오후 6시', body: '팀 회식 예약' }, '알림: 10월 23일 오후 6시 팀 회식 예약')).toMatchObject({ ok: true });
    expect(check('reminder.create', { when: '10월 23일 오후 6시', body: '팀 회식 예약' }, '10월 23일 오후 6시 알림: 팀 회식 예약')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: 'buy milk' }, 'can you add a todo for me: buy milk')).toMatchObject({ ok: true });
    expect(check('reminder.create', { when: '모레 저녁 7시', body: '은행에 전화' }, 'Remind me: 모레 저녁 7시 은행에 전화')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '보고서 쓰기' }, '할 일에 추가해줘: 보고서 쓰기')).toMatchObject({ ok: true });
    // A colon inside the content is the content's own.
    expect(check('todo.add', { title: '회의: 안건 정리' }, "할 일에 '회의: 안건 정리' 추가해줘")).toMatchObject({ ok: true });
  });

  it('P2: a modifier before 할 일 names a list (chat); one bare or owner noun asks; a multi-word task title executes', () => {
    for (const [text, title] of [['남은 할 일', '남은'], ['밀린 할 일', '밀린'], ['제일 급한 할 일', '제일 급한']] as const) {
      expect(check('todo.add', { title }, text), text).toMatchObject({ ok: false, reason: 'not-request', arg: 'statement' });
    }
    for (const [text, title] of [['회사 할 일', '회사'], ['팀장님 할 일', '팀장님'], ['우리 팀 할 일', '우리 팀'], ['청소 할 일', '청소']] as const) {
      expect(check('todo.add', { title }, text), text).toMatchObject({ ok: false, reason: 'uncertain-title', arg: 'title' });
    }
    expect(check('todo.add', { title: '검증 노트북 점검' }, '검증 노트북 점검 할 일')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '세금 서류 챙기기' }, '세금 서류 챙기기 할 일')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '회의 안건 정리' }, '회의 안건 정리 할 일')).toMatchObject({ ok: true });
  });

  it('Codex P2: a ㄴ-final noun is no modifier: a noun phrase before it executes, an uncertain one asks; never refused as a list', () => {
    for (const title of ['직원 정기 건강 검진', '분기 정산', '서버 점검', '도서관 책 반납']) {
      expect(check('todo.add', { title }, `${title} 할 일`), title).toMatchObject({ ok: true });
    }
    for (const title of ['검진', '정산', '점검', '반납']) {
      expect(check('todo.add', { title }, `${title} 할 일`), title).toMatchObject({ ok: false, reason: 'uncertain-title' });
    }
    // A strong adnominal after other words is uncertain: asked, never chat or a write.
    expect(check('todo.add', { title: '어제 받은' }, '어제 받은 할 일')).toMatchObject({ ok: false, reason: 'uncertain-title' });
  });

  it('CA P3 #6: a one-word title in the -기 nominalizer is a task by form and executes', () => {
    for (const title of ['장보기', '빨래하기']) expect(check('todo.add', { title }, `${title} 할 일`), title).toMatchObject({ ok: true });
  });

  it('Codex P2: the time before a colon label is read by the reminder grammar (반, 분, a date)', () => {
    for (const [text, when, body] of [
      ['내일 오전 9시 반 알림: 약 먹기', '내일 오전 9시 반', '약 먹기'],
      ['내일 오전 9시 30분 알림: 약 먹기', '내일 오전 9시 30분', '약 먹기'],
      ['오후 3시 15분 알림: 회의 준비', '오후 3시 15분', '회의 준비'],
      ['10월 22일 오후 3시 알림: 서류 제출', '10월 22일 오후 3시', '서류 제출'],
    ] as const) {
      expect(check('reminder.create', { when, body }, text), text).toMatchObject({ ok: true });
    }
    expect(check('reminder.create', { when: '내일 9시', body: '보고서' }, '회의록 중 알림: 내일 9시 보고서')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
  });

  it('A6 v49 gate: the trailing clause of a label\'s content meets the vetoes (a6-negative-none-189 / -193); the rest stays content', () => {
    // The gate captures: the selector's span swallowed the question mark and the hearsay tail.
    expect(check('todo.add', { title: 'renew passport?' }, 'Todo: renew passport?')).toMatchObject({ ok: false, reason: 'not-request', arg: 'question' });
    expect(check('todo.add', { title: 'renew passport' }, 'Todo: renew passport?')).toMatchObject({ ok: false, reason: 'not-request', arg: 'question' });
    expect(check('todo.add', { title: 'buy milk he told me' }, 'Todo: buy milk he told me')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: 'call the bank my boss said' }, 'To-do: call the bank my boss said')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '우유 사기 하래' }, '할 일: 우유 사기 하래')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '우유 사기 하랬어' }, '할 일: 우유 사기 하랬어')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '우유 사기 그가 말했어' }, '할 일: 우유 사기 그가 말했어')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    expect(check('todo.add', { title: '우유 사기, 아니 취소' }, '할 일: 우유 사기, 아니 취소')).toMatchObject({ ok: false, reason: 'not-request' });
    // Still executing: the labels themselves, a negation inside the content, a polite question form.
    expect(check('todo.add', { title: 'return the library books' }, 'To-do: return the library books')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: "don't forget the keys" }, "Todo: don't forget the keys")).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '하지 말아야 할 것 정리' }, '할 일: 하지 말아야 할 것 정리')).toMatchObject({ ok: true });
    expect(check('reminder.create', { when: '10월 23일 오후 6시', body: '검증 팀 회식 예약' }, '알림: 10월 23일 오후 6시 검증 팀 회식 예약')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '검증 vendor invoice recheck' }, 'To-do: 검증 vendor invoice recheck')).toMatchObject({ ok: true });
    // Codex P2: a reporting clause led by a relative or wh-word is content (the R2 relative-clause rule).
    expect(check('todo.add', { title: 'Read what she wrote' }, 'To-do: Read what she wrote')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: 'reply to the mail that my boss mentioned' }, 'To-do: reply to the mail that my boss mentioned')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: 'buy milk he told me' }, 'Todo: buy milk he told me')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
    // Codex P2: an explicit request label keeps a titled colon in its content; a bare label with a second key is pasted.
    expect(check('todo.add', { title: '회의: 안건 정리' }, '할 일 추가해줘: 회의: 안건 정리')).toMatchObject({ ok: true });
    expect(check('todo.add', { title: '회의: 안건 정리' }, '할 일: 회의: 안건 정리')).toMatchObject({ ok: false, reason: 'not-request', arg: 'reported' });
  });
});
