/**
 * ADR-0124 section 7, gate CH7: the hash-frozen SYNTHETIC durable-memory set (phase 1, stage A).
 *
 * 171 memories (Korean, English, mixed; 21 long ones that span several C1 passages, 9 of them over the 8,000 UTF-16 unit cut)
 * and 192 queries, each with exactly its gold memory id. A query either shares words with its memory (`shared`: it names the
 * subject the way the memory does) or shares none (`paraphrase`: subject and attribute are both said in other words, written
 * as synonym pairs below). `sharedTerms` records the measured overlap (Core `lexicalTerms`: Hangul bigrams, Latin words of
 * four letters or more) so "many sharing no word" is a checked property of the data, not a claim.
 *
 * Fictional objects and numbers only: no person, company or real data, no token-like literal. The vocabulary tables are
 * written once, by hand, before any embedder ran; nothing was fitted to a model's scores. The generator is seeded.
 */
import { createHash } from 'node:crypto';
import { chunking } from '@quoky/core';
import { between, pick, seeded, type Language, type Random } from './corpus';

export const MEMORY_VERSION = 'chunk-eval-memory.v1';
export const MEMORY_SEED = 'quoky-adr-0124-ch7-memory-2026-11-05';
/** The current memory embedding input bound (ADR-0124 section 5.6): UTF-16 code units. */
export const MEMORY_CUT_UNITS = 8_000;

export type QueryMode = 'paraphrase' | 'shared';

export interface MemoryItem {
  readonly id: string;
  readonly language: Language;
  readonly text: string;
  readonly long: boolean;
  /** UTF-16 offset of each fact sentence (long memories). */
  readonly factOffsets: readonly number[];
}
export interface MemoryQuery {
  readonly id: string;
  readonly language: Language;
  readonly text: string;
  readonly gold: readonly string[];
  readonly mode: QueryMode;
  /** Shared content terms between the query and its gold memory (0 = no shared word). */
  readonly sharedTerms: number;
  readonly targetLong: boolean;
  /** Long memories: which fact the query asks about, and whether that fact starts after the 8,000-unit cut. */
  readonly factIndex: number | null;
  readonly beyondCut: boolean;
}
export interface MemorySet {
  readonly memories: readonly MemoryItem[];
  readonly queries: readonly MemoryQuery[];
}

// ---------------------------------------------------------------- vocabulary (hand-written pairs: memory wording | query wording)

type Pair = readonly [string, string];

const EN_OBJECTS: readonly Pair[] = [
  ['bicycle', 'pedal cycle'],
  ['laptop', 'portable computer'],
  ['umbrella', 'rain shield'],
  ['kettle', 'water boiler'],
  ['guitar', 'six-string instrument'],
  ['backpack', 'rucksack'],
  ['lamp', 'reading light'],
  ['camera', 'picture-taking device'],
  ['suitcase', 'travel trunk'],
  ['helmet', 'head protector'],
  ['printer', 'paper-output machine'],
  ['blender', 'smoothie maker'],
  ['drill', 'boring tool'],
  ['tent', 'canvas shelter'],
  ['scooter', 'foot-pushed ride'],
  ['speaker', 'sound box'],
];
const EN_MODS: readonly Pair[] = [
  ['blue', 'sky-coloured'],
  ['old', 'well-used'],
  ['red', 'crimson'],
  ['small', 'compact'],
  ['heavy', 'weighty'],
  ['folding', 'collapsible'],
  ['wooden', 'timber-made'],
  ['spare', 'extra'],
  ['borrowed', 'lent-out'],
  ['second-hand', 'pre-owned'],
];
const EN_ATTRS: readonly Pair[] = [
  ['{S} was bought for {V} coins at a market stall.', 'What did {S} set me back?'],
  ['The warranty on {S} ends in month {V}.', 'When does the guarantee for {S} run out?'],
  ['{S} needs servicing every {V} weeks.', 'How frequently must someone inspect {S}?'],
  ['I lent {S} to a coworker for {V} days.', 'For what duration did a colleague borrow {S}?'],
  ['The manual of {S} sits in drawer {V}.', 'Which compartment holds the instruction booklet that came with {S}?'],
  ['{S} weighs about {V} kilograms.', 'How heavy is {S}?'],
  ['A spare part for {S} is on shelf {V}.', 'Where is the replacement component belonging to {S} stored?'],
  ['I fixed {S} on day {V} of last month.', 'On which date did I repair {S} recently?'],
  ['{S} is insured until 20{V}.', 'Up to which year does the cover protect {S}?'],
  ['The code number of {S} ends in {V}.', 'What are the final digits of the identifier printed on {S}?'],
  ['I keep {S} in the cellar next to box {V}.', 'In which basement location do I put away {S}?'],
  ['{S} was a gift from my aunt in 20{V}.', 'Who handed {S} over as a present?'],
  ['{S} performs fine after {V} minutes of charging.', 'How long must {S} be plugged in before it works properly?'],
  ['I plan to sell {S} for at least {V} coins.', 'What is the minimum amount I would accept when parting with {S}?'],
];
const KO_OBJECTS: readonly Pair[] = [
  ['자전거', '두 바퀴 탈것'],
  ['노트북', '휴대용 컴퓨터'],
  ['우산', '빗물막이'],
  ['주전자', '물 끓이는 기구'],
  ['기타', '여섯 줄 악기'],
  ['배낭', '등에 메는 짐가방'],
  ['스탠드', '책상 조명'],
  ['카메라', '사진 찍는 기계'],
  ['여행가방', '캐리어'],
  ['헬멧', '머리 보호구'],
  ['프린터', '인쇄 장치'],
  ['믹서기', '과일 갈아주는 기기'],
  ['전동드릴', '구멍 뚫는 공구'],
  ['텐트', '야영용 천막'],
  ['킥보드', '발로 구르는 이동수단'],
  ['스피커', '소리 내는 상자'],
];
const KO_MODS: readonly Pair[] = [
  ['파란', '하늘색'],
  ['낡은', '오랫동안 사용한'],
  ['빨간', '붉은'],
  ['작은', '아담한'],
  ['무거운', '묵직한'],
  ['접이식', '접히는'],
  ['나무로 된', '목재로 만든'],
  ['여분의', '남는'],
  ['빌린', '얻어 온'],
  ['중고', '이미 쓰던'],
];
const KO_ATTRS: readonly Pair[] = [
  ['{S은는} 시장 가판대에서 {V}코인에 샀다.', '{S을를} 살 때 얼마나 냈더라?'],
  ['{S}의 품질보증은 {V}월에 끝난다.', '{S}에 딸린 무상수리 기간은 언제 만료되지?'],
  ['{S은는} {V}주마다 점검을 받아야 한다.', '{S}의 정비 주기는 어느 정도야?'],
  ['{S을를} 동료에게 {V}일 동안 빌려줬다.', '{S}에 대해 누군가 며칠이나 가져가 썼지?'],
  ['{S}의 설명서는 {V}번 서랍에 있다.', '{S}에 딸려 온 사용 안내 책자는 어느 칸에 있지?'],
  ['{S은는} 약 {V}킬로그램이다.', '{S}의 무게가 얼마나 나가지?'],
  ['{S}의 예비 부품은 {V}번 선반에 놓여 있다.', '{S}에 쓸 교체용 부속은 어디에 보관했지?'],
  ['지난달 {V}일에 {S을를} 고쳤다.', '최근 {S을를} 수리한 날짜가 언제였지?'],
  ['{S은는} 20{V}년까지 보험에 들어 있다.', '{S}에 대한 보장이 유지되는 연도는 언제지?'],
  ['{S}의 제품 번호는 끝자리가 {V}이다.', '{S}에 새겨진 식별 숫자의 마지막은 뭐였지?'],
  ['{S은는} 지하 창고의 {V}번 상자 옆에 둔다.', '{S을를} 어느 아래층 공간에 놔뒀더라?'],
  ['{S은는} 20{V}년에 이모가 준 선물이다.', '누가 {S을를} 건네줬었지?'],
  ['{S은는} {V}분 충전하면 잘 작동한다.', '{S이가} 제대로 돌아가려면 전원을 얼마나 꽂아 둬야 하지?'],
  ['{S을를} 최소 {V}코인은 받고 팔 생각이다.', '{S을를} 넘길 때 최저 얼마까지 수락할까?'],
];
const EN_FILLER = [
  'Notes were collected over several weekends and tidied later.',
  'Nothing in this entry is urgent, but it should stay available.',
  'Some details were copied from older notebooks and may need a second look.',
  'The writing below follows no particular order.',
  'A few lines were added after a long afternoon of sorting boxes.',
  'Remember to review this entry at the start of each season.',
  'Many small items are mentioned here only for completeness.',
  'The tone of these notes is casual because they are only for me.',
];
const KO_FILLER = [
  '이 기록은 몇 주말에 걸쳐 모은 것을 나중에 정리한 내용이다.',
  '급한 내용은 없지만 나중을 위해 남겨 둔다.',
  '일부는 예전 수첩에서 옮겨 적어서 다시 확인이 필요할 수 있다.',
  '아래 글은 특별한 순서 없이 적었다.',
  '상자를 정리하던 긴 오후에 몇 줄을 덧붙였다.',
  '계절이 바뀔 때마다 이 기록을 한 번씩 훑어보자.',
  '사소한 물건들이 빠짐없이 적혀 있을 뿐이다.',
  '말투가 편한 것은 혼자 보려고 쓴 글이기 때문이다.',
];

// ---------------------------------------------------------------- text helpers

const hasBatchim = (word: string): boolean => {
  const code = (Array.from(word).pop() ?? '').codePointAt(0) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
};
const JOSA: Readonly<Record<string, readonly [string, string]>> = { 은는: ['은', '는'], 이가: ['이', '가'], 을를: ['을', '를'] };
/** Fills `{S}`, `{S은는}`, `{S이가}`, `{S을를}` (the particle follows the last syllable) and `{V}`. */
function fill(template: string, subject: string, value: string): string {
  return template.replace(/\{S(은는|이가|을를)?\}/gu, (_all, josa: string | undefined) => (josa === undefined ? subject : `${subject}${(JOSA[josa] as readonly [string, string])[hasBatchim(subject) ? 0 : 1]}`)).replace(/\{V\}/gu, value);
}
const capitalise = (text: string): string => (text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`);
/** Lower-cases the first letter unless the text starts with the pronoun "I". */
const lowerFirstWord = (text: string): string => (text.length === 0 || /^I\b/u.test(text) ? text : `${text[0]?.toLowerCase()}${text.slice(1)}`);

interface Subject {
  readonly m: string;
  readonly q: string;
}
function subjectsOf(language: 'en' | 'ko'): Subject[] {
  const objects = language === 'en' ? EN_OBJECTS : KO_OBJECTS;
  const mods = language === 'en' ? EN_MODS : KO_MODS;
  const out: Subject[] = [];
  for (const object of objects)
    for (const mod of mods) out.push(language === 'en' ? { m: `the ${mod[0]} ${object[0]}`, q: `the ${mod[1]} ${object[1]}` } : { m: `${mod[0]} ${object[0]}`, q: `${mod[1]} ${object[1]}` });
  return out;
}

function shuffle<T>(random: Random, list: readonly T[]): T[] {
  const out = [...list];
  for (let at = out.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [out[at], out[other]] = [out[other] as T, out[at] as T];
  }
  return out;
}

const valueOf = (attr: number, language: Language, random: Random): string => {
  if (attr === 8) return String(between(random, 27, 39));
  if (attr === 11) return String(between(random, 5, 24)).padStart(2, '0');
  return String(between(random, 2, 98));
};

/** A fact sentence in the memory's wording (`mem`) or the query wording. Mixed text: Korean subject, English clause with the subject as "it". */
function factSentence(language: Language, subject: Subject, attr: number, value: string, side: 'm' | 'q'): string {
  const at = side === 'm' ? 0 : 1;
  const topic = subject[side];
  if (language === 'en') return capitalise(fill((EN_ATTRS[attr] as Pair)[at], topic, value));
  if (language === 'ko') return fill((KO_ATTRS[attr] as Pair)[at], topic, value);
  return `${topic}: ${lowerFirstWord(fill((EN_ATTRS[attr] as Pair)[at], 'it', value))}`;
}

function fillerParagraph(random: Random, language: Language, target: number): string {
  const sentences: string[] = [];
  let length = 0;
  while (length < target) {
    const useKorean = language === 'ko' || (language === 'mixed' && sentences.length % 2 === 0);
    const sentence = pick(random, useKorean ? KO_FILLER : EN_FILLER);
    sentences.push(sentence);
    length += sentence.length + 1;
  }
  return sentences.join(' ');
}

/** Distinct content terms shared by a query and a memory: Hangul bigrams (and lone syllables), Latin words of 4+ letters. */
export function sharedContentTerms(query: string, memory: string): number {
  const content = (text: string): Set<string> => new Set(chunking.lexicalTerms(text).filter((term) => !/^[a-z0-9]+$/u.test(term) || term.length >= 4));
  const memoryTerms = content(memory);
  let shared = 0;
  for (const term of content(query)) if (memoryTerms.has(term)) shared += 1;
  return shared;
}

// ---------------------------------------------------------------- generator

const LANGS: readonly Language[] = ['en', 'ko', 'mixed'];
const SHORT_PER_LANGUAGE = 50;
const LONG_PER_LANGUAGE = 7;
const OVERSIZE_PER_LANGUAGE = 3;
const PARAGRAPH_UNITS = 450;
const OVERSIZE_PARAGRAPH_UNITS = 800;

interface Draft {
  readonly id: string;
  readonly language: Language;
  readonly subject: Subject;
  readonly kind: 'short' | 'long';
  readonly oversize: boolean;
}

export function generateMemorySet(): MemorySet {
  const random = seeded(`${MEMORY_SEED}/memories`);
  const enSubjects = shuffle(random, subjectsOf('en'));
  const koSubjects = shuffle(random, subjectsOf('ko'));
  const pools: Record<Language, Subject[]> = { en: enSubjects.slice(0, 57), ko: koSubjects.slice(0, 57), mixed: koSubjects.slice(57, 114) };
  const drafts: Draft[] = [];
  for (const language of LANGS) {
    const pool = pools[language];
    for (let at = 0; at < LONG_PER_LANGUAGE; at += 1) drafts.push({ id: `mem-${language}-l${String(at + 1).padStart(2, '0')}`, language, subject: pool[at] as Subject, kind: 'long', oversize: at < OVERSIZE_PER_LANGUAGE });
    for (let at = 0; at < SHORT_PER_LANGUAGE; at += 1) drafts.push({ id: `mem-${language}-s${String(at + 1).padStart(3, '0')}`, language, subject: pool[LONG_PER_LANGUAGE + at] as Subject, kind: 'short', oversize: false });
  }
  const memories: MemoryItem[] = [];
  const queries: MemoryQuery[] = [];
  const attrCount = EN_ATTRS.length;
  for (const draft of drafts) {
    const own = seeded(`${MEMORY_SEED}/${draft.id}`);
    const modeAt = (): QueryMode => (own() < 0.65 ? 'paraphrase' : 'shared');
    const queryOf = (language: Language, subject: Subject, attr: number, value: string, mode: QueryMode): string =>
      factSentence(language, mode === 'shared' ? { m: subject.m, q: subject.m } : subject, attr, value, 'q');
    if (draft.kind === 'short') {
      const attr = Math.floor(own() * attrCount);
      const value = valueOf(attr, draft.language, own);
      const text = factSentence(draft.language, draft.subject, attr, value, 'm');
      memories.push({ id: draft.id, language: draft.language, text, long: false, factOffsets: [0] });
      const mode = modeAt();
      const query = queryOf(draft.language, draft.subject, attr, value, mode);
      queries.push({ id: `q-${draft.id}`, language: draft.language, text: query, gold: [draft.id], mode, sharedTerms: sharedContentTerms(query, text), targetLong: false, factIndex: null, beyondCut: false });
      continue;
    }
    const facts = draft.oversize ? 12 : 9;
    const attrs = shuffle(own, Array.from({ length: attrCount }, (_, at) => at)).slice(0, facts);
    const values = attrs.map((attr) => valueOf(attr, draft.language, own));
    const unit = draft.oversize ? OVERSIZE_PARAGRAPH_UNITS : PARAGRAPH_UNITS;
    let text = '';
    const offsets: number[] = [];
    attrs.forEach((attr, at) => {
      const fact = factSentence(draft.language, draft.subject, attr, values[at] as string, 'm');
      if (text !== '') text += '\n\n';
      offsets.push(text.length);
      text += `${fact} ${fillerParagraph(own, draft.language, unit)}`;
    });
    memories.push({ id: draft.id, language: draft.language, text, long: true, factOffsets: offsets });
    for (const factIndex of [Math.floor(facts / 2), facts - 1]) {
      const mode = modeAt();
      const query = queryOf(draft.language, draft.subject, attrs[factIndex] as number, values[factIndex] as string, mode);
      queries.push({
        id: `q-${draft.id}-f${factIndex}`,
        language: draft.language,
        text: query,
        gold: [draft.id],
        mode,
        sharedTerms: sharedContentTerms(query, text),
        targetLong: true,
        factIndex,
        beyondCut: (offsets[factIndex] as number) >= MEMORY_CUT_UNITS,
      });
    }
  }
  return { memories, queries };
}

// ---------------------------------------------------------------- digest

const memoryDigestOf = (item: MemoryItem): string => createHash('sha256').update(JSON.stringify([item.id, item.language, item.text, item.long, item.factOffsets])).digest('hex');
const queryDigestOf = (item: MemoryQuery): string =>
  createHash('sha256').update(JSON.stringify([item.id, item.language, item.text, item.gold, item.mode, item.sharedTerms, item.targetLong, item.factIndex, item.beyondCut])).digest('hex');

/** sha256 over the version, the seed, the counts and every memory and query digest, in order. Changes with any byte. */
export function memoryDigest(set: MemorySet): string {
  const hash = createHash('sha256');
  hash.update(`${MEMORY_VERSION}\n${MEMORY_SEED}\n${set.memories.length}\n${set.queries.length}\n`);
  for (const item of set.memories) hash.update(`${memoryDigestOf(item)}\n`);
  for (const item of set.queries) hash.update(`${queryDigestOf(item)}\n`);
  return hash.digest('hex');
}

/** The whole memory as today's path embeds it: cut at 8,000 UTF-16 units. */
export const singleVectorText = (text: string): string => text.slice(0, MEMORY_CUT_UNITS);
