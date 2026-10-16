import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, NL_ACTION_LOANWORDS, NL_ACTION_VERBAL_NOUNS, NL_ACTION_WORDS } from './action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { nlGarbledActionWord, nlJamoDistance } from './garbled-action';
import { prepareSelectionInput } from './selection-input';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// A6-D3a amendment 1, garbled action word addendum (owner decision 2026-10-16): a word in the action word's slot that is one
// jamo (Latin: one letter) from an action word, without being it or a form of it, makes a LOCAL_WRITE ask. Pure.

const NOW = '2026-10-14T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const offered = new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const));
const ctx = (text: string): NlValidationContext => {
  const prepared = prepareSelectionInput(text);
  if ('skip' in prepared) throw new Error(`skipped: ${prepared.skip}`);
  return { offered, groundingText: prepared.groundingText, now: NOW, timeZone: 'Asia/Seoul', actions: true };
};
const complete = (text: string, args: Record<string, string> = { ref: '#3' }) => validateSelection({ entryId: 'todo.complete', args }, ctx(text));
const vocabularies = (own: string) => {
  const all = ACTIONS.flatMap((entry) => (entry.risk === 'LOCAL_WRITE' && entry.actionGrounding !== undefined ? [{ owner: entry.id, words: entry.actionGrounding }] : []));
  return [...all.filter((v) => v.owner === own), ...all.filter((v) => v.owner !== own)];
};
const garbled = (text: string, own = 'todo.complete') => nlGarbledActionWord(text, vocabularies(own), NL_ACTION_VERBAL_NOUNS)?.word;

describe('jamo distance', () => {
  it('decomposes Hangul into initial, medial and final', () => {
    expect(nlJamoDistance('완룐', '완료')).toBe(1); // a final ㄴ added
    expect(nlJamoDistance('완요', '완료')).toBe(1); // initial ㄹ → ㅇ
    expect(nlJamoDistance('완뇨', '완료')).toBe(1); // initial ㄹ → ㄴ
    expect(nlJamoDistance('완료', '완료')).toBe(0);
    expect(nlJamoDistance('체크', '취소')).toBeGreaterThan(1);
    expect(nlJamoDistance('complte', 'complete')).toBe(1);
  });
});

describe('garbled action words ask (LOCAL_WRITE)', () => {
  it('완룐 / 완요 / 완뇨 in the action slot ask, offering 완료', () => {
    for (const text of ['3번 완룐 처리해줘', '3번 완요 처리해줘', '3번 완뇨 처리해줘', '3번 완룐해줘', '3번 완뇨 해줘', '3번 완요 좀 해줘', '3번 완룐로 처리해줘']) {
      expect(complete(text), text).toEqual({ ok: false, reason: 'garbled-action', entryId: 'todo.complete', arg: 'action', candidate: '완료' });
    }
  });

  it('English: one letter off a word of five letters or more, in the imperative slot', () => {
    expect(complete('complte 3')).toMatchObject({ ok: false, reason: 'garbled-action', candidate: 'complete' });
    expect(complete('please complte number 3')).toMatchObject({ ok: false, reason: 'garbled-action', candidate: 'complete' });
    expect(complete('mark 3 as complte')).toMatchObject({ ok: false, reason: 'garbled-action', candidate: 'complete' });
    expect(complete('complete 3')).toMatchObject({ ok: true });
  });

  it('a garbled verb with its request ending glued on asks too ("지웨줘" for 지워)', () => {
    // The question offers the entry's canonical word (취소), never the raw vocabulary stem (지워).
    expect(validateSelection({ entryId: 'todo.cancel', args: { ref: '#2' } }, ctx('2번 지웨줘'))).toMatchObject({ ok: false, reason: 'garbled-action', candidate: '취소' });
  });

  it('a verbal noun does not inflect by itself: any one-jamo change to 완료 / 취소 / 추가 asks', () => {
    expect(garbled('3번 완룐 처리해줘')).toBe('완료');
    expect(garbled('3번 취솨해줘', 'todo.cancel')).toBe('취소');
    expect(validateSelection({ entryId: 'todo.add', args: { title: '우유' } }, ctx('우유 할 일 츄가해줘'))).toMatchObject({ ok: false, reason: 'garbled-action', candidate: '추가' });
  });
});

describe('valid forms and noise never ask', () => {
  it('완료 and its forms execute: 완료, 완료해, 완료로, 완료해줘, 완료 처리해줘', () => {
    for (const text of ['3번 완료', '3번 완료해', '3번 완료로 해줘', '3번 완료해줘', '3번 완료 처리해줘', '세 번째 거 완료해줘']) expect(complete(text), text).toMatchObject({ ok: true });
    for (const text of ['3번 완료됨', '3번 완료하고 4번 빼줘', '3번 완료로 바꿔줘']) expect(garbled(text), text).toBeUndefined();
  });

  it('"1번 할일 체크해줘" (complete-009) executes', () => {
    expect(complete('1번 할일 체크해줘', { ref: '#1' })).toMatchObject({ ok: true });
  });

  it('a near word outside the action slot, or a short one, has no effect', () => {
    // 원본 is one jamo from 원복 and 없어 from 없애, but neither stands in the slot (취소해줘 is the action).
    expect(garbled('원본 3번 완료 처리해줘')).toBeUndefined();
    expect(garbled('12번 알림 필요 없어 취소해줘')).toBeUndefined();
    // An adnominal inflection modifies the noun after it (끝내 + ㄴ, 마치 + ㄴ): never the action slot.
    expect(garbled('1번 끝낸 거 완료해줘')).toBeUndefined();
    expect(garbled('마친 일 3번 완료 처리')).toBeUndefined();
    // One-syllable action words (거 / 꺼, 해 / 빼) and short Latin words (dome / done) are too short to compare.
    expect(garbled('3번 거 해줘')).toBeUndefined();
    expect(garbled('dome 3')).toBeUndefined();
    // English noise outside the imperative slot.
    expect(garbled('mark the remote one as done')).toBeUndefined();
  });

  it('normal inflections in the slot are forms, not garbles: the 어/아 contraction, English -s / -d', () => {
    expect(garbled('2번 마쳐줘')).toBeUndefined(); // 마치 + 어
    expect(garbled('13번 알림 멈추세요', 'reminder.cancel')).toBeUndefined(); // 멈춰 ↔ 멈추
    expect(garbled('completes 3')).toBeUndefined();
    expect(garbled('removed 3', 'todo.cancel')).toBeUndefined();
  });

  it('verb forms: ending consonants ㄴ / ㄹ / ㅁ / ㅂ / ㅆ and present / past pairs are inflection (Codex P2, CA review)', () => {
    for (const text of ['2번 해치워줘', '2번 끝냄 처리해줘', '2번 마침 처리해줘', '2번 끝남으로 해줘', '2번 지움 처리해줘', '2번 없앰 처리해줘']) {
      expect(garbled(text), text).toBeUndefined();
      expect(garbled(text, 'todo.cancel'), text).toBeUndefined();
    }
    expect(complete('2번 해치워줘', { ref: '#2' })).toMatchObject({ ok: true });
    expect(complete('2번 끝냄 처리해줘', { ref: '#2' })).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'todo.cancel', args: { ref: '#2' } }, ctx('2번 지움 처리해줘'))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'todo.cancel', args: { ref: '#2' } }, ctx('2번 없앰 처리해줘'))).toMatchObject({ ok: true });
  });

  it('runs after the vetoes and only for LOCAL_WRITE; content spans are content', () => {
    expect(complete('3번 완룐 처리하지 마')).toMatchObject({ ok: false, reason: 'not-request' });
    expect(validateSelection({ entryId: 'todo.list', args: {} }, ctx('할 일 완룐 처리해줘'))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'todo.add', args: { title: '완룐 보고서' } }, ctx("할 일에 '완룐 보고서' 추가해줘"))).toMatchObject({ ok: true });
  });
});

describe('the whole action corpus with the gold selections', () => {
  const files = ['nl-action.v1.json', 'nl-action.seed.v1.json', 'nl-action.exec-time.v1.json', 'nl-action.deictic.v1.json'];
  const golds = files.flatMap((file) =>
    (JSON.parse(readFileSync(new URL(`../golden/${file}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: unknown }> }).cases.map((golden) => ({ ...golden, id: `${file}:${golden.id}` })),
  );

  it('only the ask golds ask (complete-018, and the loanword golds of owner decision E); no execute gold asks', () => {
    const asking: string[] = [];
    let checked = 0;
    for (const golden of golds) {
      const expectation = golden.expect as { entryId?: string; args?: Record<string, string>; outcome?: string } | 'none';
      if (expectation === 'none' || expectation.entryId === undefined || offered.get(expectation.entryId)?.risk !== 'LOCAL_WRITE') continue;
      const prepared = prepareSelectionInput(golden.text);
      if ('skip' in prepared) continue;
      checked += 1;
      const result = validateSelection({ entryId: expectation.entryId, args: expectation.args ?? {} }, { ...ctx('x'), groundingText: prepared.groundingText });
      if (!result.ok && result.reason === 'garbled-action') asking.push(`${golden.id} ${expectation.outcome ?? ''}`);
    }
    expect(checked).toBeGreaterThan(300);
    expect(asking).toEqual([
      'nl-action.v1.json:a6-paraphrase-todo.complete-018 ask',
      'nl-action.v1.json:a6-paraphrase-reminder.cancel-905 ask',
      'nl-action.v1.json:a6-paraphrase-reminder.cancel-906 ask',
    ]);
  });
});

describe('action.undo', () => {
  it('its own-word anchor runs first: a garbled undo word alone stays chat (ungrounded action), as before', () => {
    expect(validateSelection({ entryId: 'action.undo', args: {} }, ctx('원볶해줘'))).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(validateSelection({ entryId: 'action.undo', args: {} }, ctx('원복해줘'))).toMatchObject({ ok: true });
  });
});

describe('verb-final slot: a bare garbled word that ends the message (live test 2026-10-16 H09)', () => {
  const add = (text: string, title: string) => validateSelection({ entryId: 'todo.add', args: { title } }, ctx(text));

  it('asks when the last word of the message, before nothing or punctuation only, is one jamo off an action word', () => {
    for (const text of ['사무실 청소 할 일 츄가', '사무실 청소 할 일 츄가!', '사무실 청소 할 일 츄가요.', '사무실 청소 할 일에 츄가 ~']) {
      expect(add(text, '사무실 청소'), text).toEqual({ ok: false, reason: 'garbled-action', entryId: 'todo.add', arg: 'action', candidate: '추가' });
    }
    expect(complete('3번 완룐')).toMatchObject({ ok: false, reason: 'garbled-action', candidate: '완료' });
    expect(garbled('3번 취솨.', 'todo.cancel')).toBe('취소');
  });

  it('counter-cases still execute: the real word, its forms, and content that ends the message', () => {
    for (const text of ['사무실 청소 할 일 추가', '사무실 청소 할 일 추가!', '사무실 청소 할 일 추가요', '사무실 청소 할 일에 추가해']) expect(add(text, '사무실 청소'), text).toMatchObject({ ok: true });
    for (const text of ['3번 완료', '3번 완료!', '2번 마쳐', '2번 끝냄', '3번 완료됨']) expect(garbled(text), text).toBeUndefined();
    // The last word belongs to the content span: the frame's last word is not the message's ("할 일 추가해줘 완룐 보고서").
    expect(add('할 일 추가해줘 완룐 보고서', '완룐 보고서')).toMatchObject({ ok: true });
    expect(add('할 일에 넣어줘 보고서 츄가', '보고서 츄가')).toMatchObject({ ok: true });
  });
});

describe('owner decision E (2026-10-17): a vowel-only variant of a loanword action word asks', () => {
  const cancel = (text: string, entryId = 'reminder.cancel', args: Record<string, string> = { ref: '#11' }) => validateSelection({ entryId, args }, ctx(text));

  it('the loanword set is a tag on the existing vocabulary (no word added): each is an action word and a verbal noun', () => {
    for (const word of NL_ACTION_LOANWORDS) {
      expect(NL_ACTION_WORDS, word).toContain(word);
      expect(NL_ACTION_VERBAL_NOUNS, word).toContain(word);
    }
    expect(NL_ACTION_LOANWORDS).toEqual(['캔슬', '리마인드', '롤백']);
  });

  it('same syllables, same initial and final consonant per syllable, other vowels: asks, whatever the jamo distance', () => {
    // 칸셀 is two vowels from 캔슬 (distance 2): the one-jamo rule alone let it execute.
    expect(nlJamoDistance('칸셀', '캔슬')).toBe(2);
    for (const text of ['11번 알림 칸셀해줘', '11번 알림 칸셀', '11번 알림 캔설해줘', '11번 알림 켄슬 해줘']) {
      expect(cancel(text), text).toEqual({ ok: false, reason: 'garbled-action', entryId: 'reminder.cancel', arg: 'action', candidate: '취소' });
    }
    expect(cancel('치과 예약 확인 알림 칸셀해줘', 'reminder.cancel', { match: '치과 예약 확인' })).toMatchObject({ ok: false, reason: 'garbled-action', candidate: '취소' });
    expect(cancel('2번 할 일 칸셀', 'todo.cancel', { ref: '#2' })).toMatchObject({ ok: false, reason: 'garbled-action', candidate: '취소' });
    expect(validateSelection({ entryId: 'reminder.create', args: { body: '약 먹기', when: '내일 9시' } }, ctx('내일 9시 약 먹기 레마인드해줘'))).toMatchObject({ ok: false, reason: 'garbled-action', candidate: '알림' });
  });

  it('counter-cases: the loanword itself, a known catalog word, another consonant frame, a non-loanword and the undo anchor', () => {
    for (const text of ['11번 알림 캔슬', '11번 알림 캔슬해줘']) expect(cancel(text), text).toMatchObject({ ok: true });
    expect(cancel('치과 예약 확인 알림 캔슬해줘', 'reminder.cancel', { match: '치과 예약 확인' })).toMatchObject({ ok: true });
    // 리마인더 is the catalog's own alias (vowel-only beside 리마인드) and 알림 is never compared with the untagged 알람.
    for (const text of ['내일 9시 약 먹기 리마인드해줘', '내일 9시 약 먹기 리마인더 설정해줘', '내일 9시 약 먹기 알림해줘']) {
      expect(validateSelection({ entryId: 'reminder.create', args: { body: '약 먹기', when: '내일 9시' } }, ctx(text)), text).toMatchObject({ ok: true });
    }
    // Another consonant frame (a final consonant changes too) is not a vowel-only variant, and three jamo away.
    expect(cancel('11번 알림 칸시해줘')).toMatchObject({ ok: true });
    // The rule is for loanwords only: a two-vowel change of the Sino-Korean 완료 stays outside it.
    expect(complete('2번 운류해줘', { ref: '#2' })).toMatchObject({ ok: true });
    // action.undo keeps its own-word anchor first: a garbled undo word alone stays chat, as before.
    expect(validateSelection({ entryId: 'action.undo', args: {} }, ctx('랄백해줘'))).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'action' });
    expect(validateSelection({ entryId: 'action.undo', args: {} }, ctx('롤백해줘'))).toMatchObject({ ok: true });
  });
});
