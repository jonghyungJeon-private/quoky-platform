import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, NL_ACTION_WORDS } from './action-entries';
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

describe('A6-D3a amendment 1: corpus negatives (nl-action.v1 + seed)', () => {
  const load = (name: string) => (JSON.parse(readFileSync(new URL(`../golden/${name}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: unknown }> }).cases;
  const negatives = [...load('nl-action.v1.json'), ...load('nl-action.seed.v1.json')].filter((golden) => golden.expect === 'none');
  const grounding = (text: string) => {
    const prepared = prepareSelectionInput(text);
    return 'skip' in prepared ? undefined : prepared.groundingText;
  };

  // Core refuses these for every LOCAL_WRITE entry, whatever the selector answers: must never execute.
  const VETOED = [
    'a6-paraphrase-todo.add-009', // "할 일 하나 추가할게. …": first-person volition (owner decision 2026-10-16: none)
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
    'a6-negative-none-059',
    'a6-negative-none-069',
    'a6-negative-none-072',
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
    'a6-negative-none-091',
    'a6-negative-none-092',
    'a6-negative-none-093',
    'a6-negative-none-094',
    'a6-negative-none-096',
    'a6-negative-none-097',
    'a6-negative-none-098',
    'a6-negative-none-109',
    'a6-negative-none-111',
    'a6-negative-none-112',
    'a6-negative-none-120',
    'a6-negative-none-122',
    'a6-negative-none-123',
    'a6-negative-none-124',
    'a6-negative-none-125',
    'a6-negative-none-126',
    'a6-negative-none-130',
    'a6-seed-neg-001',
    'a6-seed-neg-002',
    'a6-seed-neg-003',
  ];
  // These carry no grammatical veto: whether they act is the selector's choice (it should answer none), and many cannot
  // act anyway (no grounded ref, no action expressed, another source). The D12 gate's "negative captures 0" measures them.
  const SELECTOR_DEPENDENT = [
    'a6-reference-none-001',
    'a6-reference-none-002',
    'a6-reference-none-003',
    'a6-reference-none-004',
    'a6-reference-none-005',
    'a6-negative-none-016',
    'a6-negative-none-017',
    'a6-negative-none-047',
    'a6-negative-none-050',
    'a6-negative-none-052',
    'a6-negative-none-053',
    'a6-negative-none-054',
    'a6-negative-none-058',
    'a6-negative-none-060',
    'a6-negative-none-061',
    'a6-negative-none-062',
    'a6-negative-none-063',
    'a6-negative-none-064',
    'a6-negative-none-065',
    'a6-negative-none-066',
    'a6-negative-none-067',
    'a6-negative-none-068',
    'a6-negative-none-070',
    'a6-negative-none-071',
    'a6-negative-none-073',
    'a6-negative-none-074',
    'a6-negative-none-075',
    'a6-negative-none-076',
    'a6-negative-none-089',
    'a6-negative-none-090',
    'a6-negative-none-095',
    'a6-negative-none-099',
    'a6-negative-none-100',
    'a6-negative-none-101',
    'a6-negative-none-102',
    'a6-negative-none-103',
    'a6-negative-none-104',
    'a6-negative-none-105',
    'a6-negative-none-106',
    'a6-negative-none-107',
    'a6-negative-none-108',
    'a6-negative-none-110',
    'a6-negative-none-113',
    'a6-negative-none-114',
    'a6-negative-none-115',
    'a6-negative-none-116',
    'a6-negative-none-117',
    'a6-negative-none-118',
    'a6-negative-none-119',
    'a6-negative-none-121',
    'a6-negative-none-127',
    'a6-negative-none-128',
    'a6-negative-none-129',
    'a6-negative-none-131',
    'a6-seed-live-005',
  ];

  it('every pinned must-not-execute negative is vetoed by structure alone', () => {
    for (const id of VETOED) {
      const golden = negatives.find((entry) => entry.id === id);
      expect(golden, id).toBeDefined();
      const text = grounding(golden!.text);
      expect(text === undefined || veto(text) !== undefined, id).toBe(true);
    }
  });

  it('the negatives without a structural veto are exactly the pinned, gate-measured list', () => {
    const open = negatives.filter((golden) => {
      const text = grounding(golden.text);
      return text !== undefined && veto(text) === undefined;
    });
    expect(open.map((golden) => golden.id).sort()).toEqual([...SELECTOR_DEPENDENT].sort());
    expect(VETOED.length + SELECTOR_DEPENDENT.length).toBe(negatives.length);
  });
});
