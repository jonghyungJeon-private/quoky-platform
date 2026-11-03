/**
 * ADR-0124 slice C2: the CH1 synthetic corpus ("needle in the middle"). Generated deterministically from a seed, by code,
 * and hash-frozen: `corpusDigest` is compared with the recorded digest before any run (see `chunk-eval-cli.ts`).
 *
 * Everything here is fictional: codenames, person names, amounts and dates are made from small syllable tables and a
 * seeded PRNG. There is no real name, company, address, link or token-like literal. No model is called.
 *
 * Query construction (fixed per case, independent of any scorer): a question is built from a per-kind, per-language
 * template that names the SUBJECT of the needle (its codename, or its identifier) and the ATTRIBUTE asked about
 * ("review", "budget", "owner", ...), and never contains the answer value (the new date, the amount, the person, the
 * chosen option, the row's cells, the constant). So the question does not quote the needle; it shares the subject and
 * topic words only, as a real question would. The same templates produce DECOYS (other codenames, other values) and
 * NEAR-DECOYS (the subject's codename in a status line that does not carry the answer), so a subject word alone does
 * not find the needle. The lexical scorer was never run against these templates while they were written.
 */
import { createHash } from 'node:crypto';
import { chunking } from '@quoky/core';

export const CORPUS_VERSION = 'chunk-eval-corpus.v1';
export const CORPUS_SEED = 'quoky-adr-0124-ch1-2026-11';

export const SHAPES = ['mail', 'thread', 'drive-doc', 'workbook', 'jira-issue', 'slack-thread', 'adr-file'] as const;
export type Shape = (typeof SHAPES)[number];
export const LENGTHS = [6_000, 20_000, 60_000, 87_000] as const;
export const DEPTHS = [10, 30, 50, 70, 90] as const;
export const LANGUAGES = ['ko', 'en', 'mixed'] as const;
export type Language = (typeof LANGUAGES)[number];
export const NEEDLE_KINDS = ['date', 'amount', 'decision', 'role', 'sheet-row', 'code-line'] as const;
export type NeedleKind = (typeof NEEDLE_KINDS)[number];

/** ADR-0124 section 7 CH1: sections per shape (a mail, a Drive doc and an ADR file are one text). */
export const SHAPE_SECTIONS: Readonly<Record<Shape, number>> = {
  mail: 0,
  thread: 14,
  'drive-doc': 0,
  workbook: 20,
  'jira-issue': 41,
  'slack-thread': 121,
  'adr-file': 0,
};
const SHAPE_KINDS: Readonly<Record<Shape, readonly NeedleKind[]>> = {
  mail: ['date', 'amount', 'decision', 'role'],
  thread: ['date', 'decision', 'role'],
  'drive-doc': ['date', 'amount', 'decision', 'role'],
  workbook: ['sheet-row'],
  'jira-issue': ['date', 'amount', 'decision', 'role'],
  'slack-thread': ['date', 'decision', 'role'],
  'adr-file': ['code-line', 'decision', 'date'],
};

export interface CasePart {
  /** Quoky's own label of the part (`[Message 3/14]`, `[Sheet 2/20] "…"`); '' for a single-text item. */
  readonly frame: string;
  /** The part's title (a sheet's); '' otherwise. */
  readonly title: string;
  readonly body: string;
  readonly kind?: 'text' | 'table';
}

export interface ChunkEvalCase {
  readonly id: string;
  readonly shape: Shape;
  /** The requested length in code points of the prepared text (frames not counted). */
  readonly length: number;
  /** The requested depth, percent. */
  readonly depth: number;
  readonly language: Language;
  readonly needleKind: NeedleKind;
  readonly parts: readonly CasePart[];
  /** The prepared item: the parts' bodies joined (Core `joinSections`); the chunker's input. */
  readonly prepared: string;
  readonly sections: ReturnType<typeof chunking.joinSections>['sections'];
  /** The question (the query of every arm). */
  readonly question: string;
  /** The needle's text and its half-open range in CODE POINTS of `prepared`. */
  readonly needle: { readonly text: string; readonly start: number; readonly end: number };
}

// ---------------------------------------------------------------- PRNG

type Random = () => number;

function seeded(label: string): Random {
  let state = createHash('sha256').update(label).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: Random, list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
const between = (random: Random, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

// ---------------------------------------------------------------- fictional vocabulary

const LATIN_HEAD = ['Zeph', 'Quor', 'Brin', 'Talv', 'Oxen', 'Merl', 'Vask', 'Nolt', 'Kesh', 'Dran', 'Pelt', 'Wyrn'];
const LATIN_TAIL = ['aran', 'ion', 'ex', 'uma', 'ibo', 'ora', 'ent', 'ula'];
const HANGUL_HEAD = ['세', '벨', '타', '리', '마', '누', '카', '레', '도', '빈', '솔', '하'];
const HANGUL_TAIL = ['온', '라', '미', '스', '벤', '넷'];
const EN_FIRST = ['Dovrin', 'Halte', 'Mirel', 'Osk', 'Tavin', 'Rhea', 'Yoru', 'Keld'];
const EN_LAST = ['Quen', 'Vael', 'Brask', 'Ondri', 'Sarn', 'Teller'];
const KO_FIRST = ['도린', '하르', '미렐', '오스', '타빈', '레아', '요루', '켈드'];
const KO_LAST = ['퀸', '바엘', '브라', '온드', '사른', '텔러'];
const EN_TOPIC = ['tracker', 'roadmap', 'dashboard', 'checklist', 'handbook', 'pipeline', 'archive', 'rollout'];
const ITEM_WORDS = ['licenses', 'travel', 'training', 'hosting', 'supplies', 'catering', 'storage', 'audit', 'printing', 'support'];
const OPTIONS_EN = ['keep the current vendor', 'postpone the migration to the next quarter', 'merge the two review stages', 'split the release into two parts', 'drop the optional export feature'];
const OPTIONS_KO = ['기존 업체를 계속 유지', '이전 작업을 다음 분기로 연기', '두 검토 단계를 하나로 통합', '릴리스를 두 부분으로 분리', '선택 내보내기 기능을 제외'];

const latinName = (random: Random, used: Set<string>): string => {
  for (;;) {
    const name = `${pick(random, LATIN_HEAD)}${pick(random, LATIN_TAIL)}`;
    if (!used.has(name)) return (used.add(name), name);
  }
};
const hangulName = (random: Random, used: Set<string>): string => {
  for (;;) {
    const name = `${pick(random, HANGUL_HEAD)}${pick(random, HANGUL_HEAD)}${pick(random, HANGUL_TAIL)}`;
    if (!used.has(name)) return (used.add(name), name);
  }
};
const person = (random: Random, language: Language): string =>
  language === 'ko' ? `${pick(random, KO_FIRST)} ${pick(random, KO_LAST)}` : `${pick(random, EN_FIRST)} ${pick(random, EN_LAST)}`;
const money = (random: Random): string => `${between(random, 12, 98)},${between(random, 100, 999)}`;
const day = (random: Random, language: Language): string => {
  const month = between(random, 1, 12);
  const date = between(random, 1, 28);
  if (language === 'ko') return `${month}월 ${date}일`;
  if (language === 'en') return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month - 1]} ${date}`;
  return `2027-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- templates

interface Slots {
  readonly subject: string;
  readonly a: string;
  readonly b: string;
}
interface NeedleTemplate {
  readonly text: (s: Slots) => string;
  readonly question: (subject: string) => string;
}

const topicWord = (language: Language, random: Random): string => (language === 'ko' ? pick(random, ['일정표', '현황판', '체크리스트', '로드맵']) : pick(random, EN_TOPIC));

function needleTemplate(kind: NeedleKind, language: Language): NeedleTemplate {
  const L = language;
  switch (kind) {
    case 'date':
      return L === 'ko'
        ? { text: (s) => `${s.subject}의 검토 회의 일정이 ${s.a}에서 ${s.b}로 변경되었습니다.`, question: (c) => `${c}의 검토 회의 일정은 언제로 변경되었나요?` }
        : L === 'en'
          ? { text: (s) => `The ${s.subject} review meeting was moved from ${s.a} to ${s.b}.`, question: (c) => `When was the ${c} review meeting moved to?` }
          : { text: (s) => `${s.subject} review 회의 일정이 ${s.a}에서 ${s.b}로 변경됐어요.`, question: (c) => `${c} review 회의는 언제로 변경됐나요?` };
    case 'amount':
      return L === 'ko'
        ? { text: (s) => `${s.subject}의 승인된 예산은 ${s.a}만 원입니다.`, question: (c) => `${c}의 승인된 예산은 얼마인가요?` }
        : L === 'en'
          ? { text: (s) => `The approved budget for ${s.subject} is ${s.a} thousand dollars.`, question: (c) => `What is the approved budget for ${c}?` }
          : { text: (s) => `${s.subject} 프로젝트의 approved budget은 ${s.a} USD로 확정됐습니다.`, question: (c) => `${c} 프로젝트의 approved budget은 얼마인가요?` };
    case 'decision':
      return L === 'ko'
        ? { text: (s) => `결정: ${s.subject} 팀은 ${s.a}하기로 했습니다.`, question: (c) => `${c} 팀은 무엇을 하기로 결정했나요?` }
        : L === 'en'
          ? { text: (s) => `Decision: the ${s.subject} team will ${s.a}.`, question: (c) => `What did the ${c} team decide to do?` }
          : { text: (s) => `Decision: ${s.subject} 팀은 ${s.a} 하기로 했습니다.`, question: (c) => `${c} 팀은 무엇을 decision으로 정했나요?` };
    case 'role':
      return L === 'ko'
        ? { text: (s) => `${s.a}님이 ${s.subject}의 담당자로 지정되었습니다.`, question: (c) => `${c}의 담당자는 누구로 지정되었나요?` }
        : L === 'en'
          ? { text: (s) => `${s.a} is now the owner of ${s.subject}.`, question: (c) => `Who is the owner of ${c}?` }
          : { text: (s) => `${s.a}님이 ${s.subject}의 owner로 지정됐어요.`, question: (c) => `${c}의 owner는 누구인가요?` };
    case 'sheet-row':
      return L === 'ko'
        ? { text: (s) => `${s.subject} | ${s.a}`, question: (c) => `${c} 항목의 담당자, 금액, 날짜는 무엇인가요?` }
        : L === 'en'
          ? { text: (s) => `${s.subject} | ${s.a}`, question: (c) => `What are the owner, amount and date listed for ${c}?` }
          : { text: (s) => `${s.subject} | ${s.a}`, question: (c) => `${c} 항목의 owner, amount, date는 무엇인가요?` };
    case 'code-line':
      return L === 'ko'
        ? { text: (s) => `const MAX_RETRY_${s.subject.toUpperCase()} = ${s.a};`, question: (c) => `${c} 재시도 상한 상수는 어떤 값으로 정의되어 있나요?` }
        : L === 'en'
          ? { text: (s) => `const MAX_RETRY_${s.subject.toUpperCase()} = ${s.a};`, question: (c) => `Which value is the ${c} retry limit constant defined as?` }
          : { text: (s) => `const MAX_RETRY_${s.subject.toUpperCase()} = ${s.a};`, question: (c) => `${c} retry limit 상수는 어떤 값으로 정의돼 있나요?` };
  }
}

/** The kind's slot values: `a` and `b` are the answer-bearing values. */
function slotValues(kind: NeedleKind, language: Language, random: Random, subject: string): Slots {
  switch (kind) {
    case 'date':
      return { subject, a: day(random, language), b: day(random, language) };
    case 'amount':
      return { subject, a: money(random), b: '' };
    case 'decision':
      return { subject, a: pick(random, language === 'en' ? OPTIONS_EN : OPTIONS_KO), b: '' };
    case 'role':
      return { subject, a: person(random, language), b: '' };
    case 'sheet-row':
      return { subject, a: `${person(random, language)} | ${money(random)} | ${day(random, language)}`, b: '' };
    case 'code-line':
      return { subject, a: String(between(random, 2, 97)), b: '' };
  }
}

function fillerSentence(random: Random, language: Language, names: readonly string[], target: string): string {
  const subject = random() < 0.05 ? target : pick(random, names);
  const topic = topicWord(language, random);
  const p = person(random, language);
  const when = day(random, language);
  const n = between(random, 3, 38);
  const tops = pick(random, EN_TOPIC);
  const en = [
    `The ${subject} workstream is on schedule and the next checkpoint is planned for ${when}.`,
    `${p} will share the notes from the ${topic} meeting with the group.`,
    `Please review the ${topic} summary before the sync and add comments where needed.`,
    `Open items for ${subject}: confirm the ${topic} contact, update the ${tops} and close the stale tasks.`,
    `The vendor sent a quote for the ${subject} extension, which is still under review.`,
    `We discussed the ${topic} risks and agreed to revisit them after the next release.`,
    `${p} asked whether the ${subject} timeline needs another review round.`,
    `Nothing blocks the ${topic} rollout at the moment; the checklist stands at ${n} of 40 items.`,
    `A short reminder: the ${subject} ${tops} refreshes every night, so figures can lag by a day.`,
    `Feedback on the ${topic} draft was mostly editorial and no change to scope was requested.`,
  ];
  const ko = [
    `${subject} 작업은 일정대로 진행 중이며 다음 점검은 ${when}에 계획되어 있습니다.`,
    `${p}님이 ${topic} 회의록을 팀에 공유할 예정입니다.`,
    `동기화 전에 ${topic} 요약을 읽어 보시고 필요한 부분에 의견을 남겨 주세요.`,
    `${subject} 관련 남은 항목은 ${topic} 확인, 문서 갱신, 오래된 작업 정리입니다.`,
    `협력사가 ${subject} 연장 건에 대한 견적을 보내 왔으며 아직 검토 중입니다.`,
    `${topic} 위험 요소를 논의했고 다음 릴리스 이후에 다시 보기로 했습니다.`,
    `${p}님이 ${subject} 일정에 검토 라운드가 더 필요한지 물어 보았습니다.`,
    `지금은 ${topic} 배포를 막는 문제가 없고 점검표는 40개 중 ${n}개까지 진행되었습니다.`,
    `참고로 ${subject} 현황은 매일 밤 갱신되므로 수치가 하루 늦을 수 있습니다.`,
    `${topic} 초안에 대한 의견은 대부분 문구 수정이었고 범위 변경 요청은 없었습니다.`,
  ];
  const mixed = [
    `${subject} workstream은 on schedule이고 next checkpoint는 ${when}입니다.`,
    `${p}님이 ${tops} 회의 notes를 팀에 공유할 예정입니다.`,
    `sync 전에 ${tops} summary를 review하고 필요한 곳에 comment를 남겨 주세요.`,
    `${subject} open items: ${tops} 확인, tracker 업데이트, stale tasks 정리.`,
    `vendor가 ${subject} extension quote를 보내 왔고 아직 review 중입니다.`,
    `${tops} risks를 논의했고 next release 이후에 다시 보기로 했어요.`,
    `${p}님이 ${subject} timeline에 review round가 더 필요한지 물어봤어요.`,
    `현재 ${tops} rollout을 막는 blocker는 없고 checklist는 40개 중 ${n}개 완료입니다.`,
    `참고로 ${subject} dashboard는 매일 밤 refresh되어 수치가 하루 lag될 수 있어요.`,
    `${tops} draft에 대한 feedback은 대부분 editorial이었고 scope 변경은 없었습니다.`,
  ];
  return pick(random, language === 'ko' ? ko : language === 'en' ? en : mixed);
}

function paragraph(random: Random, language: Language, names: readonly string[], target: string, shape: Shape, unitPoints: number): string {
  if (shape === 'adr-file' && random() < 0.12) {
    const lines = [`const MAX_RETRY_${pick(random, names).toUpperCase().replace(/[^A-Z]/g, 'X')} = ${between(random, 2, 97)};`, `const TIMEOUT_MS = ${between(random, 5, 90) * 100};`];
    return `\`\`\`ts\n${lines.join('\n')}\n\`\`\``;
  }
  if (shape === 'adr-file' && random() < 0.15) return `## ${language === 'ko' ? '결정' : 'Decision'} ${between(random, 100, 399)}`;
  const sentences: string[] = [];
  let size = 0;
  while (size < unitPoints) {
    const sentence = fillerSentence(random, language, names, target);
    sentences.push(sentence);
    size += Array.from(sentence).length + 1;
  }
  return sentences.join(' ');
}

function tableRow(random: Random, language: Language, names: readonly string[]): string {
  const item = random() < 0.5 ? pick(random, names) : `${pick(random, ITEM_WORDS)}-${between(random, 1, 40)}`;
  return `${item} | ${person(random, language)} | ${money(random)} | ${day(random, language)}`;
}

// ---------------------------------------------------------------- one case

const cpLength = (text: string): number => Array.from(text).length;

function frameOf(shape: Shape, language: Language, index: number, total: number): string {
  const ko = language === 'ko';
  switch (shape) {
    case 'thread':
      return ko ? `[메시지 ${index + 1}/${total}]` : `[Message ${index + 1}/${total}]`;
    case 'workbook':
      return `[Sheet ${index + 1}/${total}] "${ko ? '예산' : 'Budget'} ${index + 1}"`;
    case 'jira-issue':
      return index === 0 ? '[Issue]' : `[Comment ${index}/${total - 1}]`;
    case 'slack-thread':
      return index === 0 ? '[Thread root]' : `[Reply ${index}/${total - 1}]`;
    default:
      return '';
  }
}

export function buildCase(shape: Shape, length: number, depth: number, language: Language, ordinal: number): ChunkEvalCase {
  const id = `ch1-${shape}-${length / 1000}k-d${depth}-${language}`;
  const random = seeded(`${CORPUS_SEED}:${id}`);
  const kinds = SHAPE_KINDS[shape];
  const needleKind = kinds[ordinal % kinds.length] as NeedleKind;
  const sectionCount = Math.max(1, SHAPE_SECTIONS[shape]);
  const sectioned = SHAPE_SECTIONS[shape] > 0;
  const table = shape === 'workbook';
  const used = new Set<string>();
  const codename = (): string => (language === 'ko' && needleKind !== 'code-line' ? hangulName(random, used) : latinName(random, used));
  const target = codename();
  const decoyNames = Array.from({ length: 8 }, codename);
  const template = needleTemplate(needleKind, language);
  const unitPoints = shape === 'slack-thread' ? 60 : 150;

  // Units (paragraphs or rows) per section, up to the section's share of the requested length.
  const share = length / sectionCount;
  const units: string[][] = [];
  for (let section = 0; section < sectionCount; section += 1) {
    const list: string[] = [];
    let size = 0;
    if (table) {
      list.push(language === 'ko' ? '항목 | 담당자 | 금액 | 날짜' : 'Item | Owner | Amount | Date');
      size += cpLength(list[0] as string) + 1;
    }
    while (size < share) {
      const unit = table ? tableRow(random, language, decoyNames) : paragraph(random, language, decoyNames, target, shape, unitPoints);
      list.push(unit);
      size += cpLength(unit) + (table ? 1 : 2);
    }
    units.push(list);
  }

  // The needle replaces nothing: it is inserted as its own unit at the cumulative position of the requested depth.
  const needleSlots = slotValues(needleKind, language, random, target);
  const needleText = template.text(needleSlots);
  const total = units.reduce((sum, list) => sum + list.reduce((inner, unit) => inner + cpLength(unit) + 2, 0), 0);
  const wanted = (depth / 100) * total;
  let walked = 0;
  let placed = false;
  const decoyKinds: readonly NeedleKind[] = table ? ['sheet-row'] : kinds;
  // Decoys: the same template with another codename and other values; some of the needle's kind, some of the others.
  const decoyCount = length <= 6_000 ? 2 : length <= 20_000 ? 3 : 5;
  const decoys: { readonly text: string; readonly at: number }[] = [];
  for (let n = 0; n < decoyCount; n += 1) {
    const kind = n % 2 === 0 ? needleKind : (pick(random, decoyKinds) as NeedleKind);
    const subject = kind === 'code-line' ? latinName(random, used) : pick(random, decoyNames);
    decoys.push({ text: needleTemplate(kind, language).text(slotValues(kind, language, random, subject)), at: random() });
  }
  const sectionsOut: string[][] = units.map((list) => [...list]);
  for (let section = 0; section < sectionsOut.length && !placed; section += 1) {
    const list = sectionsOut[section] as string[];
    for (let at = table ? 1 : 0; at <= list.length; at += 1) {
      if (walked >= wanted || (section === sectionsOut.length - 1 && at === list.length)) {
        list.splice(at, 0, needleText);
        placed = true;
        break;
      }
      walked += cpLength(list[at] ?? '') + 2;
    }
  }
  for (const decoy of decoys) {
    // Never in the needle's own unit neighbourhood by construction of the depth: spread by a seeded fraction, skip the needle.
    let target2 = Math.floor(decoy.at * sectionsOut.length);
    target2 = Math.min(target2, sectionsOut.length - 1);
    const list = sectionsOut[target2] as string[];
    if (list.includes(needleText)) {
      const other = sectionsOut[(target2 + 1) % sectionsOut.length] as string[];
      if (!other.includes(needleText)) other.splice(table ? 1 : other.length, 0, decoy.text);
      continue;
    }
    list.splice(table ? 1 + Math.floor(decoy.at * (list.length - 1)) : Math.floor(decoy.at * list.length), 0, decoy.text);
  }

  const parts: CasePart[] = sectionsOut.map((list, index) => ({
    frame: sectioned ? frameOf(shape, language, index, sectionCount) : '',
    title: table ? `${language === 'ko' ? '예산' : 'Budget'} ${index + 1}` : '',
    body: list.join(table ? '\n' : '\n\n'),
    ...(table ? { kind: 'table' as const } : {}),
  }));
  const joined = chunking.joinSections(parts.map((part) => ({ frame: part.frame, body: part.body, ...(part.kind === undefined ? {} : { kind: part.kind }) })));
  const prepared = joined.text;
  const first = prepared.indexOf(needleText);
  if (first < 0 || prepared.indexOf(needleText, first + 1) >= 0) throw new Error(`corpus: needle not unique in ${id}`);
  const start = cpLength(prepared.slice(0, first));
  return {
    id,
    shape,
    length,
    depth,
    language,
    needleKind,
    parts,
    prepared,
    sections: joined.sections,
    question: template.question(target),
    needle: { text: needleText, start, end: start + cpLength(needleText) },
  };
}

/** Every case of the CH1 matrix: 7 shapes x 4 lengths x 5 depths x 3 languages = 420. Order is fixed. */
export function generateCorpus(): ChunkEvalCase[] {
  const cases: ChunkEvalCase[] = [];
  // The needle kind is (length index + depth index + language index) modulo the shape's kinds, so a kind is balanced across
  // every single factor and is not aliased with the language or the depth.
  for (const shape of SHAPES)
    LENGTHS.forEach((length, lengthAt) =>
      DEPTHS.forEach((depth, depthAt) => LANGUAGES.forEach((language, languageAt) => cases.push(buildCase(shape, length, depth, language, lengthAt + depthAt + languageAt)))),
    );
  return cases;
}

/** The digest of one case: everything the arms read (parts, question, needle) and the matrix coordinates. */
function caseDigest(item: ChunkEvalCase): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([item.id, item.shape, item.length, item.depth, item.language, item.needleKind, item.question, item.needle, item.parts]));
  return hash.digest('hex');
}

/** The corpus digest: sha256 over the version, the seed and every case digest, in order. Changes with any byte of any case. */
export function corpusDigest(cases: readonly ChunkEvalCase[]): string {
  const hash = createHash('sha256');
  hash.update(`${CORPUS_VERSION}\n${CORPUS_SEED}\n${cases.length}\n`);
  for (const item of cases) hash.update(`${caseDigest(item)}\n`);
  return hash.digest('hex');
}
