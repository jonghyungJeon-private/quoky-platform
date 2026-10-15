import type { NlActionEntryId, NlAmbiguityKey, NlArgs, NlCatalogEntry, NlEntryCheckFailure, NlItemSource, NlWave1EntryId } from './catalog';
import { normalizeForMatch } from './selection-input';
import { NL_WAVE1_ENTRIES } from './wave1-entries';
import { isNlTimeWord } from './symbolic-time';
import { ANCHORED_TODO_PREFIX_HEADS } from '../reminders/reminder-grammar';
import { SLACK_POST_COLON_HEAD } from '../work-chat/work-chat-command';
import { EXECUTION_PHRASES } from '../execution-command-guard';

/**
 * The ADR-0120 amendment A6 action entries (A6-D1, as amended by the ratification record): local writes on Quoky's own
 * to-dos and reminders, `action.undo`, and `item.summarize` over one listed mail or Drive item. Defined once here so the
 * closed vocabulary is reviewable in one place; the owning handlers contribute them (`ConversationTurnHandler.catalog`)
 * and the runtime offers them only while `QUOKY_NL_ACTIONS` allows (A6-D8) and the kill switch is running (A6-D3).
 *
 * The word classes below are VALUE VALIDATORS (A6-D2 "Grounding of a ref", A6-D3 payload rules), like the A2 grammatical
 * classes and the A5 time words: they decide whether an argument the selector returned is grounded in the owner's own
 * words. They never route a message: a deictic alone never selects an entry.
 *
 * `slack.post` and `calendar.create` (R3) have ids (`NL_ACTION_ENTRY_IDS`) but no entry here: they are never offered
 * before their stage.
 */

/** A6-D3: the span bound of a to-do title, a reminder body and a `match` (ADR-0100 D4 / ADR-0101 D2: 1..200). */
export const NL_SPAN_MAX_CHARS = 200;
/** The `when` span bound: a time expression, never a sentence. */
export const NL_WHEN_MAX_CHARS = 60;
/** A6-D1: `#n` is 1..50 (the listing bound). */
export const NL_REF_MAX_INDEX = 50;

/** The closed ref forms (A6-D1). */
export const NL_REF_KEYWORDS = ['recent', 'this', 'last'] as const;
export type NlRefKind = 'index' | (typeof NL_REF_KEYWORDS)[number];

/** A parsed `ref` value: `#n` or a deictic keyword. */
export type NlRef = { readonly kind: 'index'; readonly index: number } | { readonly kind: 'recent' | 'this' | 'last' };

/** `#3` → index 3, `recent` / `this` / `last`; anything else `undefined`. */
export function parseNlRef(value: unknown): NlRef | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'recent' || trimmed === 'this' || trimmed === 'last') return { kind: trimmed };
  const match = /^#?([1-9][0-9]?)$/.exec(trimmed);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return index >= 1 && index <= NL_REF_MAX_INDEX ? { kind: 'index', index } : undefined;
}

/** The canonical text of a ref (`#3`, `recent`, …). */
export function formatNlRef(ref: NlRef): string {
  return ref.kind === 'index' ? `#${ref.index}` : ref.kind;
}

// ── word classes (value validators) ───────────────────────────────────────────────────────────────────────────────

/** A6-D2: the closed deictics that ground `recent` / `this`. Korean words match inside a token (particles glued on). */
const DEICTIC_KO = ['그거', '이거', '저거', '그것', '이것', '저것', '그건', '이건', '저건', '그걸', '이걸', '저걸', '방금', '아까'];
const DEICTIC_EN = ['it', 'that', 'this', 'that one', 'this one'];
/** Particles glued on a deictic, filler, time or item-source noun ("이 문서를", "그 메일에서는"). */
const PARTICLE_WORDS = '(?:으로|에서|까지|부터|에는|이랑|하고|은|는|이|가|을|를|에|의|도|만|로|랑|요)';
const PARTICLE_TAIL = new RegExp(`${PARTICLE_WORDS}$`, 'u');
/** A token without its trailing particles: up to two stacked ones ("5시에도", "메일에서는"). */
function withoutParticles(token: string): string {
  return token.replace(PARTICLE_TAIL, '').replace(PARTICLE_TAIL, '');
}

/**
 * A6-D2 clarification (owner decision 2026-10-15, as recorded in DECISIONS): a demonstrative determiner 이 / 그 standing as
 * its own word before a noun that names an item source ("이 문서", "그 메일") is a closed deictic exactly like 그거 / 이거.
 * 저 also means "I" ("저 할 일 다 했어요"), so "저 + noun" grounds only `item.summarize` (a read), never a LOCAL_WRITE ref.
 * The noun must be a whole word (particles may follow: "이 문서를"; "이 파일럿", "그 문서화" are not references) and must
 * name the entry's own source ("그 알림" never grounds a to-do ref). The determiners are a closed set and the nouns are
 * the catalog's own words for the item sources (the aliases and source names of the mail, Drive, to-do and reminder list
 * entries), never a phrase list. English needs nothing new: "this document" and "that mail" already carry this / that.
 * Like every deictic it only grounds a `ref`; which item it means is A6-D2 resolution.
 */
const DETERMINERS_KO = ['이', '그', '저'] as const;
type NlDeterminer = (typeof DETERMINERS_KO)[number];
/** 저 is also the first-person pronoun: it grounds a read reference only. */
const READ_ONLY_DETERMINERS: ReadonlySet<NlDeterminer> = new Set(['저']);
const ITEM_SOURCE_LIST_ENTRIES: Readonly<Record<NlItemSource, NlWave1EntryId>> = { mail: 'mail.list', drive: 'drive.files', todo: 'todo.list', reminder: 'reminder.list' };
/** The catalog's Korean words for each item source (Latin aliases are left to this / that). */
const ITEM_SOURCE_WORDS_KO: ReadonlyArray<readonly [string, NlItemSource]> = (Object.entries(ITEM_SOURCE_LIST_ENTRIES) as Array<[NlItemSource, NlWave1EntryId]>).flatMap(
  ([source, id]) =>
    [...NL_WAVE1_ENTRIES[id].aliases, ...(NL_WAVE1_ENTRIES[id].sourceNames ?? [])]
      .map(normalizeForMatch)
      .filter((noun) => !/^[a-z0-9 .-]+$/.test(noun))
      .map((noun) => [noun, source] as const),
);
const nounKey = (noun: string): string => noun.replace(/\s+/g, '');
/** Each noun (spaces removed) → the item sources it names. */
const ITEM_SOURCE_NOUNS_KO: ReadonlyMap<string, ReadonlySet<NlItemSource>> = ITEM_SOURCE_WORDS_KO.reduce((nouns, [noun, source]) => {
  nouns.set(nounKey(noun), new Set([...(nouns.get(nounKey(noun)) ?? []), source]));
  return nouns;
}, new Map<string, ReadonlySet<NlItemSource>>());
const NOUN_ALTERNATION = [...new Set(ITEM_SOURCE_WORDS_KO.map(([noun]) => noun))]
  .sort((a, b) => b.length - a.length)
  .map((noun) => noun.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s*'))
  .join('|');
/**
 * Where a noun (or its particles) may end: the end of the text, whitespace, or a closed set of sentence punctuation. A
 * letter, digit, `_` or any other word-joining character never ends it ("이 알림_봇", "그 문서화").
 */
const NOUN_END = '(?:$|\\s|[.,!?~…])';
/** A determiner word, then an item-source noun that ends there or with particles (captures: determiner, noun). */
const DETERMINER_NOUN_SOURCE = `(?<=^|\\s)(${DETERMINERS_KO.join('|')})\\s+(${NOUN_ALTERNATION})(?=${PARTICLE_WORDS}*${NOUN_END})`;
const DETERMINER_NOUN_ALL = new RegExp(DETERMINER_NOUN_SOURCE, 'gu');

/** The determiner references of the owner's words: which determiner, and which item sources its noun names. */
function determinerReferences(groundingText: string): Array<{ readonly determiner: NlDeterminer; readonly sources: ReadonlySet<NlItemSource> }> {
  const found: Array<{ determiner: NlDeterminer; sources: ReadonlySet<NlItemSource> }> = [];
  for (const match of normalizeForMatch(groundingText).matchAll(DETERMINER_NOUN_ALL)) {
    const sources = ITEM_SOURCE_NOUNS_KO.get(nounKey(match[2] as string));
    if (sources !== undefined) found.push({ determiner: match[1] as NlDeterminer, sources });
  }
  return found;
}

/**
 * A Korean item-source noun standing as its own word: after the start, whitespace or a number word ("1번 문서", "두 번째
 * 메일", "13번알림"), ending at a whole-noun end (particles allowed: "문서를", "메일에서는"). "이메일" is its own noun.
 */
const NAMED_NOUN_ALL = new RegExp(`(?<=^|\\s|\\d|번|째)(${NOUN_ALTERNATION})(?=${PARTICLE_WORDS}*${NOUN_END})`, 'gu');
/** The catalog's Latin words for each item source ("mail", "inbox", "drive", "todo", "reminder"), whole words only. */
const ITEM_SOURCE_WORDS_LATIN: ReadonlyArray<readonly [string, NlItemSource]> = (Object.entries(ITEM_SOURCE_LIST_ENTRIES) as Array<[NlItemSource, NlWave1EntryId]>).flatMap(
  ([source, id]) =>
    [...NL_WAVE1_ENTRIES[id].aliases, ...(NL_WAVE1_ENTRIES[id].sourceNames ?? [])]
      .map(normalizeForMatch)
      .filter((noun) => /^[a-z0-9 .-]+$/.test(noun))
      .map((noun) => [noun, source] as const),
);

/**
 * ADR-0120 A6-D2 "Same source only" (A6 R1 fix): the item sources the owner's own words name with the catalog's words
 * for them ("1번 문서" names drive, "2번 메일" mail, "그 알림" a reminder). Core cross-checks a `ref` against them for every
 * ref kind, so a selector `source` (or entry) that disagrees with the noun the owner wrote can never read or change an
 * item of another source. The nouns are the catalog's own aliases and source names, never a phrase list.
 */
export function nlNamedItemSources(groundingText: string): ReadonlySet<NlItemSource> {
  // Brackets and other punctuation, and a digit glued to a letter ("메일2번", "2번메일", "mail2"), are word boundaries
  // here, so "2번 (메일)" and "메일2번" name the mail source too (Codex review).
  const text = normalizeForMatch(groundingText)
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/(\p{N})(?=\p{L})|(\p{L})(?=\p{N})/gu, '$1$2 ')
    .replace(/\s+/g, ' ')
    .trim();
  const named = new Set<NlItemSource>();
  for (const match of text.matchAll(NAMED_NOUN_ALL)) for (const source of ITEM_SOURCE_NOUNS_KO.get(nounKey(match[1] as string)) ?? []) named.add(source);
  // A noun glued to a following action or content word of the catalog's own vocabularies ("메일취소해줘", "알림취소해줘",
  // "문서요약해줘"; A6 R1 review); a noun glued to anything else ("알림장") is still no source.
  for (const match of text.matchAll(gluedNounPattern())) for (const source of ITEM_SOURCE_NOUNS_KO.get(nounKey(match[1] as string)) ?? []) named.add(source);
  for (const [word, source] of ITEM_SOURCE_WORDS_LATIN) if (latinWordIn(text, word)) named.add(source);
  return named;
}

let gluedNoun: RegExp | undefined;
/** Built on first use: the vocabularies are declared further down this module. */
function gluedNounPattern(): RegExp {
  if (gluedNoun !== undefined) return gluedNoun;
  const verbs = [...new Set([...ACTION_VOCABULARY_KO, ...NL_MODE_SUMMARY_WORDS, ...NL_MODE_FULL_WORDS, ...NL_CONTENT_WORDS].map(normalizeForMatch).filter((word) => !/^[a-z0-9 .;-]+$/.test(word)))]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s*'));
  gluedNoun = new RegExp(`(?<=^|\\s|\\d|번|째)(${NOUN_ALTERNATION})(?=${verbs.join('|')})`, 'gu');
  return gluedNoun;
}

/** Whether the owner's words point with a determiner at an item-source noun ("이 문서", "그 메일"), whatever the entry. */
export function hasNlDeterminerReference(groundingText: string): boolean {
  return determinerReferences(groundingText).length > 0;
}

/** What a `ref` is for: the entry and the item source it acts on (the determiner rule needs both). */
export interface NlRefTarget {
  readonly entryId: NlActionEntryId;
  readonly source?: NlItemSource;
}

/** A determiner reference grounds `target` only for the noun of its own source; 저 only for a read (`item.summarize`). */
function groundsByDeterminer(groundingText: string, target: NlRefTarget | undefined): boolean {
  if (target?.source === undefined) return false;
  const source = target.source;
  return determinerReferences(groundingText).some(
    (reference) => reference.sources.has(source) && (!READ_ONLY_DETERMINERS.has(reference.determiner) || target.entryId === 'item.summarize'),
  );
}

/** `last` needs one of these. */
const LAST_KO = ['마지막'];
const LAST_EN = ['last', 'the last one'];

const KO_ORDINALS: readonly string[] = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
const EN_ORDINALS: readonly string[] = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const KO_ORDINAL_PATTERN = /(첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:번\s*)?째/gu;
const EN_ORDINAL_PATTERN = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|(\d{1,2})(?:st|nd|rd|th))\b/giu;

function latinWordIn(text: string, word: string): boolean {
  // `-` stays literal outside a class (escaping it is invalid under the `u` flag: "e-mail").
  const escaped = word.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'u').test(text);
}

function wordIn(text: string, word: string): boolean {
  return /^[a-z0-9 -]+$/.test(word) ? latinWordIn(text, word) : text.includes(word);
}

/** Whether the owner's words carry a closed deictic (A6-D2). */
export function hasNlDeictic(groundingText: string): boolean {
  const text = normalizeForMatch(groundingText);
  return DEICTIC_KO.some((word) => text.includes(word)) || DEICTIC_EN.some((word) => latinWordIn(text, word));
}

function hasLastWord(groundingText: string): boolean {
  const text = normalizeForMatch(groundingText);
  return LAST_KO.some((word) => text.includes(word)) || LAST_EN.some((word) => latinWordIn(text, word));
}

/** The ordinal words of the owner's text, as positions (첫 번째 → 1, second → 2). */
export function nlOrdinalsIn(groundingText: string): number[] {
  const text = normalizeForMatch(groundingText);
  const found: number[] = [];
  for (const match of text.matchAll(KO_ORDINAL_PATTERN)) found.push(KO_ORDINALS.indexOf(match[1] as string) + 1);
  for (const match of text.matchAll(EN_ORDINAL_PATTERN)) {
    const digits = match[2];
    found.push(digits !== undefined ? Number(digits) : EN_ORDINALS.indexOf((match[1] as string).toLowerCase()) + 1);
  }
  return found.filter((value) => value >= 1);
}

/** The standalone numbers of the owner's text (`3`, `13번`, `#4`), never a part of a longer number or a clock. */
export function nlNumeralsIn(groundingText: string): number[] {
  const text = normalizeForMatch(groundingText);
  const found: number[] = [];
  for (const match of text.matchAll(/(?<![\d:.])(\d{1,2})(?![\d:.]|\s?(?:시|분|초|일|월|년|주|개월|시간|am|pm))/gu)) found.push(Number(match[1]));
  return found;
}

/** How the owner named `#n`: with digits (`13번`) or an ordinal word (`첫 번째`), or not at all. */
export function nlIndexWording(index: number, groundingText: string): 'digits' | 'ordinal' | undefined {
  if (nlNumeralsIn(groundingText).includes(index)) return 'digits';
  if (nlOrdinalsIn(groundingText).includes(index)) return 'ordinal';
  return undefined;
}

/**
 * A6-D2 grounding of a `ref`: `#n` needs that numeral or ordinal; `recent`/`this` a deictic (or a determiner + noun of the
 * target's own source, see above); `last` 마지막/last.
 */
export function isNlRefGrounded(ref: NlRef, groundingText: string, target?: NlRefTarget): boolean {
  switch (ref.kind) {
    case 'index':
      return nlIndexWording(ref.index, groundingText) !== undefined;
    case 'recent':
    case 'this':
      return hasNlDeictic(groundingText) || groundsByDeterminer(groundingText, target);
    case 'last':
      return hasLastWord(groundingText);
  }
}

/** One pair of enclosing quotes (A6-D1 `span`): '…', "…", 「…」, “…”, ‘…’. */
const ENCLOSING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ["'", "'"],
  ['"', '"'],
  ['「', '」'],
  ['“', '”'],
  ['‘', '’'],
  ['『', '』'],
];

/** NFC, whitespace collapsed, trimmed, one pair of enclosing quotes removed (A6-D1). Never repairs anything else. */
export function normalizeNlSpan(raw: string): string {
  let span = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  for (const [open, close] of ENCLOSING_QUOTES) {
    if (span.length >= 2 && span.startsWith(open) && span.endsWith(close)) {
      span = span.slice(open.length, span.length - close.length).trim();
      break;
    }
  }
  return span;
}

/** A6-D3: a span is grounded only verbatim (case kept, whitespace collapsed) in this turn's own words. */
export function isNlSpanGrounded(span: string, groundingText: string): boolean {
  const haystack = groundingText.normalize('NFC').replace(/\s+/g, ' ');
  return span.length > 0 && haystack.includes(span);
}

/** Filler words that carry no content on their own ("첫 번째 거", "the one"). */
const FILLER = new Set(['거', '것', '걸', '건', '게', '번', '개', '그', '이', '저', '좀', '하나', 'the', 'one', 'a', 'an', 'item', 'thing', 'please']);

/** Particles glued on a reference go with it ("2번만요", "그걸로요"; A6 R1 review). */
const GLUED_PARTICLES = `${PARTICLE_WORDS}*`;
const KO_ORDINAL_WITH_PARTICLES = new RegExp(`(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*(?:번\\s*)?째${GLUED_PARTICLES}`, 'gu');
const NUMBER_WITH_PARTICLES = new RegExp(`#?\\d+\\s*번\\s*째?${GLUED_PARTICLES}`, 'gu');
const DEICTIC_WITH_PARTICLES = new RegExp(`(?:${[...DEICTIC_KO, ...LAST_KO].sort((a, b) => b.length - a.length).join('|')})${GLUED_PARTICLES}`, 'gu');
/** An item-source noun of the catalog standing as its own word, with its particles ("13번 알림", "메일을"). */
const SOURCE_NOUN_WITH_PARTICLES = new RegExp(`(?<=^|\\s)(?:${NOUN_ALTERNATION})${GLUED_PARTICLES}(?=${NOUN_END})`, 'gu');

function contentTokens(span: string): string[] {
  let text = normalizeForMatch(span);
  text = text.replace(KO_ORDINAL_WITH_PARTICLES, ' ').replace(EN_ORDINAL_PATTERN, ' ');
  text = text.replace(NUMBER_WITH_PARTICLES, ' ');
  text = text.replace(DETERMINER_NOUN_ALL, ' ');
  text = text.replace(DEICTIC_WITH_PARTICLES, ' ');
  // A6 R1 review: an item-source noun names where an item lives, never what a to-do or reminder says ("13번 알림").
  text = text.replace(SOURCE_NOUN_WITH_PARTICLES, ' ');
  const tokens = text
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  return tokens.filter((token) => {
    const bare = token.replace(PARTICLE_TAIL, '');
    if (FILLER.has(token) || FILLER.has(bare) || bare.length === 0) return false;
    if ([...DEICTIC_EN, ...LAST_EN].includes(token)) return false;
    if (/^\d+$/.test(bare)) return false;
    return !isNlTimeWord(token);
  });
}

/**
 * A6-D3: a payload made only of deictic, ordinal, number, time or item-source words, with their particles ("그거", "첫 번째
 * 거", "내일", "2번만요", "13번 알림").
 */
export function isNlDeicticOnlyPayload(span: string): boolean {
  return contentTokens(span).length === 0;
}

/** Time words too weak to mean a time on their own inside a title ("다음 회의 준비", "this week's notes" keep theirs). */
const WEAK_TIME_WORDS = new Set([
  '이번', '지난', '저번', '다음', '다다음', '주', '달', '말', '초', '하루', '종일', '낮',
  'this', 'last', 'next', 'past', 'recent', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year',
]);
const EXTRA_TIME_TOKEN = /^(?:\d{1,3}\s?(?:분|시간)(?:\s?(?:뒤|후|전))?|\d{1,2}시(?:\d{1,2}분)?반?|\d{1,2}:\d{2})$/u;

/**
 * A6-D1/D3: whether `text` carries a time expression (a clock, a day, a part of the day, a weekday, a recurrence): a to-do
 * title with one gets the to-do-or-reminder question, a reminder message with one outside `when` gets a question.
 */
export function containsNlTimeExpression(text: string): boolean {
  const tokens = normalizeForMatch(text)
    .replace(/(?<!\d)[,.;!?~"'“”‘’()[\]]|[,.;!?~](?!\d)/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    // Up to two stacked particles (A6 R1: "그리고 5시에도" is a time outside `when`).
    const bare = withoutParticles(token);
    if (WEAK_TIME_WORDS.has(token) || WEAK_TIME_WORDS.has(bare)) continue;
    if (EXTRA_TIME_TOKEN.test(bare) || EXTRA_TIME_TOKEN.test(token)) return true;
    if (/^(?:매일|평일|주말|매주|매일매일|daily|weekly|everyday|tonight|tomorrow|today)/u.test(bare)) return true;
    if (isNlTimeWord(token)) return true;
  }
  return false;
}

/** `text` with the first verbatim occurrence of `span` removed (whitespace-normalized), or `text` when absent. */
export function withoutSpan(text: string, span: string): string {
  const haystack = text.normalize('NFC').replace(/\s+/g, ' ');
  const at = haystack.indexOf(span);
  return at < 0 ? haystack : `${haystack.slice(0, at)} ${haystack.slice(at + span.length)}`.replace(/\s+/g, ' ').trim();
}

// ── item.summarize mode and content words ────────────────────────────────────────────────────────────────────────

/** Ratification record C: the words that state `mode`. */
export const NL_MODE_SUMMARY_WORDS: readonly string[] = ['요약', '정리', '간추려', '간추린', '짧게', 'summarize', 'summary', 'sum up', 'tl;dr'];
export const NL_MODE_FULL_WORDS: readonly string[] = ['원문', '전체', '전문', '그대로 보여', '다 보여', '통째로', 'full text', 'whole', 'original', 'verbatim'];
/** Content-request words that ask what an item says without stating a mode (the open `item.content-mode` key). */
export const NL_CONTENT_WORDS: readonly string[] = [
  '내용', '무슨 얘기', '무슨 이야기', '무슨 말', '뭐라고', '뭐래', '뭔 얘기', '어떤 얘기', '무슨 내용',
  'what did it say', 'what does it say', 'what was it about', 'what is it about', 'what it says', 'contents', 'content',
];
/** A mail thread: `scope: thread` needs one of these (A6-D1). */
const THREAD_WORDS: readonly string[] = ['스레드', '쓰레드', '대화 전체', 'thread'];

function anyWord(groundingText: string, words: readonly string[]): boolean {
  const text = normalizeForMatch(groundingText);
  return words.some((word) => wordIn(text, normalizeForMatch(word)));
}

/** Whether the owner asked for an item's content at all (a mode word or a content word): `item.summarize` grounding. */
export function asksForItemContent(groundingText: string): boolean {
  return anyWord(groundingText, [...NL_MODE_SUMMARY_WORDS, ...NL_MODE_FULL_WORDS, ...NL_CONTENT_WORDS]);
}

/**
 * Ratification record C: the open interpretation key of `item.summarize` when the owner asks about the content without a
 * mode word. Asked once, kept per actor for 30 days (the ADR-0120 D7 store); an explicit mode word always wins.
 */
export const ITEM_CONTENT_MODE: NlAmbiguityKey = Object.freeze({
  key: 'item.content-mode',
  arg: 'mode',
  values: Object.freeze([
    { value: 'summary', label: { ko: '요약해서 보기', en: 'A summary' }, aliases: ['요약', '정리', '짧게', 'summary', 'summarize'], grounding: [...NL_MODE_SUMMARY_WORDS] },
    { value: 'full', label: { ko: '전체 보기', en: 'The full text' }, aliases: ['전체', '원문', '전문', '다', 'full', 'whole', 'original'], grounding: [...NL_MODE_FULL_WORDS] },
  ]),
  question: {
    ko: '요약해서 볼까요, 전체를 볼까요? 한 번 정하면 30일 동안 같은 방식으로 보여 드릴게요.',
    en: 'Should I summarize it or show the full text? I will keep your choice for 30 days.',
  },
  openWhen: (args: NlArgs) => args.mode === undefined,
});

// ── the entries ──────────────────────────────────────────────────────────────────────────────────────────────────

const REF_DESCRIPTION =
  'The item: "#N" for a number or ordinal the owner wrote (3번 / 세 번째 / item 3 -> "#3"); "this" for 그거/이거/저거/it/that/this (also the last action\'s item); "recent" only for 방금/아까 (just now); "last" for 마지막/the last one. Never an id or a title.';

function exactlyOneTarget(args: NlArgs): NlEntryCheckFailure | undefined {
  const hasRef = args.ref !== undefined;
  const hasMatch = args.match !== undefined;
  if (hasRef && hasMatch) return { reason: 'invalid-arg', arg: 'match' };
  if (!hasRef && !hasMatch) return { reason: 'missing-arg', arg: 'ref' };
  return undefined;
}

/** "다 완료해줘", "전부 취소", "all of them": one action per message (A6-D1); such a request is asked again. */
const BULK_KO = /(?:^|\s)(?:다|전부|모두|모든|싹\s?다|전체\s?다|몽땅)(?=\s|$)/u;
const BULK_EN = /\b(?:all|every|everything|each)\b/u;

export function isNlBulkRequest(groundingText: string): boolean {
  const text = normalizeForMatch(groundingText);
  return BULK_KO.test(text) || BULK_EN.test(text);
}

/**
 * The closed action vocabularies of the A6 entries that act on an existing item (A6 R1 review, `actionGrounding`): the
 * owner must say the action itself. Stems match inside a word (Korean endings follow: 완료해줘, 지워줘, 꺼줘, 되돌려
 * 놔); Latin words are whole words. A message with only a reference ("2번도", "그걸로요", "13번 알림") grounds none.
 */
// 끝 only in its completion forms (끝냈 / 끝났 / 끝내 / 끝마치): "언제 끝나?" is a question, not a completion. No 처리 or 체크:
// "처리 방법", "체크해봐" are not completions (CA review).
const TODO_COMPLETE_WORDS: readonly string[] = ['완료', '끝냈', '끝났', '끝내', '끝마', '마쳤', '마치', '마무리', '다 했', '다했', '해치웠', 'done', 'complete', 'completed', 'finish', 'finished', 'check off'];
const CANCEL_WORDS: readonly string[] = ['취소', '캔슬', '삭제', '지워', '지우', '지운', '없애', '없던 걸로', '없던걸로', '제거', '제외', '그만', '필요 없', '필요없', 'cancel', 'remove', 'delete', 'drop', 'scrap'];
// No negation-shaped words ("안 할", "안 해도"): a negation in the clause voids grounding (CA review), so they cannot ground.
const TODO_CANCEL_WORDS: readonly string[] = [...CANCEL_WORDS, '빼'];
const REMINDER_CANCEL_WORDS: readonly string[] = [...CANCEL_WORDS, '꺼', '끄', '끈', '멈춰', 'stop', 'turn off', 'disable'];
// Verbs only, never a source noun (CA review: "메모장 열어줘", "알림 설정 어떻게 해?" must not ground a write).
const TODO_ADD_WORDS: readonly string[] = ['추가', '넣어', '넣자', '넣기', '올려', '적어', '등록', 'add', 'put', 'jot down'];
const REMINDER_CREATE_WORDS: readonly string[] = [
  '알려', '리마인드', '깨워', '상기시켜',
  // A reminder noun only together with its verb ("알림해줘", "리마인더 설정해줘", "알림 부탁해"), never the noun alone.
  '알림해', '알림 해', '알림 줘', '알림 걸', '알림 만들', '알림으로 만들', '알림 설정', '알림 맞춰', '알림 부탁',
  '리마인더 설정', '리마인더 만들', '리마인더 걸', '리마인더 부탁', '알람 맞춰', '알람 걸', '알람 설정',
  'remind', 'set a reminder', 'notify', 'alert me', 'ping me',
];
const UNDO_WORDS: readonly string[] = ['되돌', '돌려', '원래대로', '원상', '원복', '롤백', '무르', '물러', '취소', 'undo', 'revert', 'roll back', 'rollback'];
/** Every Korean action word of the vocabularies above (for the glued-noun boundary of {@link nlNamedItemSources}). */
const ACTION_VOCABULARY_KO: readonly string[] = [...TODO_COMPLETE_WORDS, ...TODO_CANCEL_WORDS, ...REMINDER_CANCEL_WORDS, ...UNDO_WORDS, ...TODO_ADD_WORDS, ...REMINDER_CREATE_WORDS];

/** Where a clause ends after an action word: 말고, sentence punctuation or a line break. */
const CLAUSE_END = /말고|[,.!?。;~\n]/u;
/**
 * A negation anywhere later in the same clause (CA review): "-지 마/말아/않" ("취소는 하지 마", "완료하지 말아줘"), a
 * standalone 안/못 ("취소 안 해도 돼", "완료 안 됐어", "취소하면 안 돼"), 금지.
 */
const NEGATED_IN_CLAUSE = /지\s*(?:마|말|않)|(?:^|\s)(?:안|못)(?=\s|$|되|돼|됐|해|했|하|할)|금지/u;
/** A negation word right before it: "안 지워도 돼", "못 끝냈어". */
const NEGATED_BEFORE = /(?:^|\s)(?:안|못)\s*$/u;
/**
 * An adnominal or noun form of the action word in the same word, a bound noun and a particle allowed: "제외된 거",
 * "취소된거", "완료된건", "완료한 할 일".
 */
const ADNOMINAL_REST = /^(?:된|됐던|되었던|되는|됨|한|했던|하는|할)(?:거|것|건|걸)?(?:야|이야|요|은|는|이|가|을|를|도|만)?$/u;
/** A request form inside a question ("완료해줄래?", "취소해 줄 수 있어?"): such a question still asks for the action. */
const REQUEST_IN_QUESTION = /줘|주세요|줄래|줄 ?수|주실|주시|주겠|please|can you|could you|would you/u;
/** An interrogative clause ending without a question mark ("취소할까", "완료했니"). */
const INTERROGATIVE_END = /(?:까|니|냐|나요)\s*$/u;
const NEGATED_BEFORE_EN = /(?:^|\s)(?:don't|dont|do not|never|not|no)\s+(?:\S+\s+)?$/u;

/**
 * A6 R1 review: whether one of an entry's action words occurs in the owner's prose in a requesting form. An occurrence
 * followed by a negation in its clause ("-지 마/말아/않", a standalone 안/못, 금지), preceded by 안/못, in an adnominal form
 * ("취소된 거", "완료한 할 일") or in a question that is not a polite request ("2번 끝냈어?", "취소할까?") grounds nothing;
 * another occurrence of an action word in another clause still can ("완료하지 말고 취소해줘" grounds the cancel).
 */
export function nlActionWordGrounded(prose: string, words: readonly string[]): boolean {
  const text = normalizeForMatch(prose);
  for (const raw of words) {
    const word = normalizeForMatch(raw);
    if (/^[a-z0-9][a-z0-9 -]*$/.test(word)) {
      const pattern = new RegExp(`(?<![a-z0-9])${word.replace(/ /g, '\\s+')}s?(?![a-z0-9])`, 'gu');
      for (const match of text.matchAll(pattern)) if (!NEGATED_BEFORE_EN.test(text.slice(0, match.index))) return true;
      continue;
    }
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
      const after = text.slice(at + word.length);
      const end = CLAUSE_END.exec(after);
      const clause = end === null ? after : after.slice(0, end.index);
      const rest = /^\S*/u.exec(after)?.[0] ?? '';
      if (NEGATED_IN_CLAUSE.test(clause) || ADNOMINAL_REST.test(rest.replace(/[?!.,~]+$/u, ''))) continue;
      if (NEGATED_BEFORE.test(text.slice(0, at))) continue;
      // A question about the item ("2번 끝냈어?", "취소할까?") never grounds a write; a polite request in question form does.
      const question = end?.[0] === '?' || INTERROGATIVE_END.test(clause);
      if (question && !REQUEST_IN_QUESTION.test(`${word}${clause}`)) continue;
      return true;
    }
  }
  return false;
}

const todoAdd: NlCatalogEntry = {
  id: 'todo.add',
  actionGrounding: TODO_ADD_WORDS,
  risk: 'LOCAL_WRITE',
  dmOnly: true,
  label: { ko: '할 일 추가', en: 'Add a to-do' },
  aliases: ['할 일 추가', '추가', 'add'],
  description: {
    en: "Add one to-do to the owner's own to-do list now.",
    ko: '내 할 일 목록에 할 일 하나를 지금 추가.',
  },
  args: [
    {
      name: 'title',
      kind: 'span',
      required: true,
      maxChars: NL_SPAN_MAX_CHARS,
      description: 'The to-do text, copied verbatim from the message (without the verb and "할 일에"); never shortened or translated.',
    },
  ],
  usage: { ko: '"할 일 추가: 내용"', en: '"할 일 추가: <text>"' },
  staleCommands: [/할\s?일\s?추가\s?[:：]/u],
  check(args: NlArgs): NlEntryCheckFailure | undefined {
    const title = args.title;
    if (typeof title !== 'string') return { reason: 'missing-arg', arg: 'title' };
    // A6-D1: ADR-0100 to-dos carry no time; a time in the title asks "to-do or reminder?".
    if (containsNlTimeExpression(title)) return { reason: 'time-in-title', arg: 'title' };
    return undefined;
  },
};

function transitionEntry(id: 'todo.complete' | 'todo.cancel'): NlCatalogEntry {
  const complete = id === 'todo.complete';
  return {
    id,
    actionGrounding: complete ? TODO_COMPLETE_WORDS : TODO_CANCEL_WORDS,
    risk: 'LOCAL_WRITE',
    dmOnly: true,
    label: complete ? { ko: '할 일 완료 처리', en: 'Complete a to-do' } : { ko: '할 일 목록에서 빼기', en: 'Take a to-do off the list' },
    aliases: complete ? ['완료', 'complete', 'done'] : ['빼기', '취소', 'cancel', 'drop'],
    description: complete
      ? { en: 'Mark ONE of the owner\'s open to-dos as done now.', ko: '열린 할 일 하나를 지금 완료 처리.' }
      : { en: 'Take ONE of the owner\'s open to-dos off the list now (cancel it).', ko: '열린 할 일 하나를 지금 목록에서 빼기(취소).' },
    args: [
      { name: 'ref', kind: 'ref', description: REF_DESCRIPTION },
      {
        name: 'match',
        kind: 'span',
        maxChars: NL_SPAN_MAX_CHARS,
        description: 'Instead of ref: the to-do title words the owner wrote, verbatim. Exactly one of ref and match.',
      },
    ],
    usage: complete ? { ko: '"완료 처리: 번호"', en: '"완료 처리: <number>"' } : { ko: '"할 일 취소: 번호"', en: '"할 일 취소: <number>"' },
    staleCommands: complete ? [/완료\s?처리\s?[:：]/u] : [/할\s?일\s?취소\s?[:：]/u],
    check(args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined {
      if (isNlBulkRequest(groundingText)) return { reason: 'bulk' };
      return exactlyOneTarget(args);
    },
  };
}

const reminderCreate: NlCatalogEntry = {
  id: 'reminder.create',
  actionGrounding: REMINDER_CREATE_WORDS,
  risk: 'LOCAL_WRITE',
  dmOnly: true,
  label: { ko: '알림 만들기', en: 'Create a reminder' },
  aliases: ['알림', '리마인더', 'reminder', 'remind'],
  description: {
    en: 'Remind the owner of something at a time they state (once, daily or weekly).',
    ko: '정한 시간에(한 번, 매일, 매주) 무언가를 알려 주는 알림 만들기.',
  },
  args: [
    {
      name: 'body',
      kind: 'span',
      required: true,
      maxChars: NL_SPAN_MAX_CHARS,
      description: 'What to remind, verbatim from the message, without the time words and the verb ("물 마시기").',
    },
    {
      name: 'when',
      kind: 'span',
      required: true,
      // The time span itself: the payload rule (not only time words) does not apply to it.
      allowsTimeWords: true,
      maxChars: NL_WHEN_MAX_CHARS,
      description: 'Only the time words, verbatim, without a trailing particle such as 에 ("내일 9시", "매일 아침 8시", "30분 뒤"). Never compute a date.',
    },
  ],
  usage: { ko: '"내일 오전 9시에 회의 준비 알려줘"', en: '"remind me tomorrow at 9am to prepare the meeting"' },
  staleCommands: [/["“'‘][^"”'’\n]{1,80}알려\s?줘["”'’]\s?(?:라고|처럼|이라고)/u],
  check(args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined {
    const when = args.when;
    const body = args.body;
    if (typeof when !== 'string') return { reason: 'missing-arg', arg: 'when' };
    if (typeof body !== 'string') return { reason: 'missing-arg', arg: 'body' };
    // The `when` span must itself be a time; the deterministic grammar parses it at execution.
    if (!containsNlTimeExpression(when)) return { reason: 'time-outside-when', arg: 'when' };
    // A6-D1: the whole message is checked: a time word outside `when` (or inside `body`) asks.
    if (containsNlTimeExpression(body)) return { reason: 'time-outside-when', arg: 'body' };
    if (containsNlTimeExpression(withoutSpan(groundingText, when))) return { reason: 'time-outside-when', arg: 'when' };
    return undefined;
  },
};

const reminderCancel: NlCatalogEntry = {
  id: 'reminder.cancel',
  actionGrounding: REMINDER_CANCEL_WORDS,
  risk: 'LOCAL_WRITE',
  dmOnly: true,
  label: { ko: '알림 취소', en: 'Cancel a reminder' },
  aliases: ['알림 취소', 'cancel reminder'],
  description: {
    en: 'Cancel ONE of the owner\'s scheduled reminders now.',
    ko: '예정된 알림 하나를 지금 취소.',
  },
  args: [{ name: 'ref', kind: 'ref', required: true, description: REF_DESCRIPTION }],
  usage: { ko: '"알림 N 취소"', en: '"알림 N 취소"' },
  staleCommands: [/알림\s?(?:\d+|N|번호)\s?(?:번\s?)?취소/u],
  check(_args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined {
    return isNlBulkRequest(groundingText) ? { reason: 'bulk' } : undefined;
  },
};

const actionUndo: NlCatalogEntry = {
  id: 'action.undo',
  actionGrounding: UNDO_WORDS,
  risk: 'LOCAL_WRITE',
  dmOnly: true,
  label: { ko: '방금 한 작업 되돌리기', en: 'Undo the last action' },
  aliases: ['되돌리기', 'undo'],
  description: {
    en: "Undo the action Quoky itself just did (an added, completed or canceled to-do or reminder). Not for the owner's own past actions.",
    ko: 'Quoky가 방금 한 작업(할 일·알림 추가, 완료, 취소)을 되돌리기. 사용자가 스스로 한 일은 아님.',
  },
  args: [],
  usage: { ko: '"되돌리기"', en: '"되돌리기"' },
  staleCommands: [/되돌리기/u],
};

const itemSummarize: NlCatalogEntry = {
  id: 'item.summarize',
  risk: 'ITEM_READ',
  dmOnly: true,
  label: { ko: '목록의 항목 내용 보기', en: 'Read one listed item' },
  aliases: ['요약', '내용', 'summarize'],
  description: {
    en: 'Summarize or show ONE mail or Drive file from the list Quoky just showed, when the owner asks what it says.',
    ko: '방금 보여준 메일·드라이브 목록의 항목 하나를 요약하거나 보여주기(내용을 물을 때).',
  },
  args: [
    { name: 'source', kind: 'enum', values: ['mail', 'drive'], required: true, description: 'The list the item is in (see Reference context).' },
    { name: 'ref', kind: 'ref', required: true, description: REF_DESCRIPTION },
    {
      name: 'scope',
      kind: 'enum',
      values: ['item', 'thread'],
      default: 'item',
      valueGrounding: { thread: THREAD_WORDS },
      description: 'thread ONLY when the owner asks about the whole mail thread (스레드/thread); mail only.',
    },
    {
      name: 'mode',
      kind: 'enum',
      values: ['summary', 'full'],
      valueGrounding: { summary: NL_MODE_SUMMARY_WORDS, full: NL_MODE_FULL_WORDS },
      description: 'summary ONLY for 요약/정리/짧게/summarize; full ONLY for 원문/전체/전문/그대로 보여/full text. Omit it otherwise.',
    },
  ],
  usage: { ko: '"1번 메일 요약해줘"', en: '"1번 메일 요약해줘"' },
  staleCommands: [/(?:\d+|N)\s?번\s?(?:메일|문서)\s?요약/u],
  check(args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined {
    // A6-D1 (owner decision 5, narrowed by record C): the owner must ask for the content.
    if (!asksForItemContent(groundingText)) return { reason: 'ungrounded', arg: 'mode' };
    if (args.scope === 'thread' && args.source !== 'mail') return { reason: 'invalid-arg', arg: 'scope' };
    return undefined;
  },
};

/** The A6 entries that can be offered (R1 local entries and `item.summarize`). */
export const NL_ACTION_ENTRIES: Readonly<Partial<Record<NlActionEntryId, NlCatalogEntry>>> = Object.freeze({
  'todo.add': todoAdd,
  'todo.complete': transitionEntry('todo.complete'),
  'todo.cancel': transitionEntry('todo.cancel'),
  'reminder.create': reminderCreate,
  'reminder.cancel': reminderCancel,
  'action.undo': actionUndo,
  'item.summarize': itemSummarize,
});

/** The A6 entry of `id` (throws for an id with no entry yet: `slack.post`, `calendar.create`). */
export function nlActionEntry(id: 'todo.add' | 'todo.complete' | 'todo.cancel' | 'reminder.create' | 'reminder.cancel' | 'action.undo' | 'item.summarize'): NlCatalogEntry {
  const entry = NL_ACTION_ENTRIES[id];
  if (entry === undefined) throw new Error(`no A6 entry ${id}`);
  return entry;
}

/** Whether an entry is an A6 action entry (anything but a wave-1 READ). */
export function isNlActionEntry(entry: Pick<NlCatalogEntry, 'risk'>): boolean {
  return entry.risk !== 'READ';
}

/** A6-D2: the entries whose questions may resume from a pending target choice (payload entries never resume). */
export const NL_TARGET_ENTRY_IDS: readonly NlActionEntryId[] = ['todo.complete', 'todo.cancel', 'reminder.cancel', 'item.summarize', 'action.undo'];

/** Which item source an A6 entry acts on, when fixed by the entry (`item.summarize` takes it from its `source` arg). */
export function nlActionSourceOf(entryId: NlActionEntryId, args: NlArgs): 'todo' | 'reminder' | 'mail' | 'drive' | undefined {
  switch (entryId) {
    case 'todo.add':
    case 'todo.complete':
    case 'todo.cancel':
      return 'todo';
    case 'reminder.create':
    case 'reminder.cancel':
      return 'reminder';
    case 'item.summarize':
      return args.source === 'mail' || args.source === 'drive' ? args.source : undefined;
    default:
      return undefined;
  }
}

// ── the A6 input guard (red-team review: unmarked pastes, hidden characters, look-alikes) ───────────────────────────

/**
 * An action request is one short instruction: a longer message (a pasted memo with a command at its end) never acts.
 * The selection bound (600) still applies to reads.
 */
export const NL_ACTION_MAX_INPUT_CHARS = 300;

/**
 * Format, zero-width, bidi, tag, variation-selector and line/paragraph-separator characters, and every C0/C1 control
 * (TAB included). CR and LF are left to the line check, which refuses them as `not-plain`.
 */
const HIDDEN = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2028\u2029\u3164\uFE00-\uFE0F\uFFA0]|[\u{E0100}-\u{E01EF}]|[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
/**
 * An emoji with its own presentation selector (U+FE0F), skin tone or ZWJ joins (❤️, ☀️, 👨‍💻) and a keycap (1️⃣): the only
 * place U+FE0F and U+200D are allowed. Tag characters and every other hidden character stay refused.
 */
const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|[#*0-9]\uFE0F\u20E3/gu;

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The closed Class A command forms, taken from their own grammars (single source): the ADR-0100 D1 to-do heads with a
 * colon, the anchored Slack post head ("#채널에 게시:") and the Slack post execution phrase. Never inside a
 * natural-language request. (A reminder number with 취소 is an ordinary request.)
 */
const COMMAND_FORMS: readonly RegExp[] = [
  new RegExp(`(?:${ANCHORED_TODO_PREFIX_HEADS.map(escapeRegExp).join('|')})\\s*[:：]`, 'iu'),
  SLACK_POST_COLON_HEAD,
  new RegExp(
    `(?:${EXECUTION_PHRASES.channelPost
      .filter((phrase) => /^(?:slack|슬랙)\s/iu.test(phrase))
      .map((phrase) => escapeRegExp(phrase).replace(/ /g, '\\s*'))
      .join('|')})`,
    'iu',
  ),
];

export type NlActionInputRefusal = 'too-long' | 'hidden-characters' | 'not-plain' | 'embedded-command';

/** A bracket whose content looks like data: a quote, an identifier key with a colon, or a comma list. */
export function looksLikeData(inner: string): boolean {
  return /["“”'`]|[\p{L}\p{N}_]\s*:|,/u.test(inner);
}

/**
 * Markers of structured or quoted material (fail closed: any of them means the message is not one plain instruction):
 * braces, a data-like square bracket, backticks, a tilde fence, a line-leading `>`, or an ASCII identifier key followed
 * by a colon and a value (`request: …`, YAML-like). An ordinary bracketed phrase ("[긴급] 보고서 쓰기") is not a marker.
 */
function hasStructureMarker(rawText: string): boolean {
  // Nothing is removed from the checked text: only the URL and time colons below are neutralised, character for character.
  const text = neutraliseUrlAndTimeColons(rawText);
  if (/[{}`]/u.test(text) || /~~~/u.test(text) || /^\s*>/u.test(text)) return true;
  for (const match of text.matchAll(/\[([^[\]]*)\]/gu)) if (looksLikeData(match[1] ?? '')) return true;
  if (/[[\]]/u.test(text.replace(/\[[^[\]]*\]/gu, ''))) return true;
  // A key is an ASCII identifier not glued to a preceding letter ("12:00request:" and "x,request:" are keys).
  return /(?<![A-Za-z_])[A-Za-z_][A-Za-z0-9_-]*\s*:\s*\S/u.test(text);
}

/**
 * An `http`/`https` URL token: whitespace-free, a hostname of letters, digits, dots and hyphens, an optional numeric
 * port, an optional path/query/fragment, and not ending with `:`. Anything else with `://` is checked as written.
 */
const HTTP_URL_TOKEN = /(?<![^\s(\[,])https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:[/?#]\S*)?(?<!:)(?=\s|[)\],]|$)/giu;
/** An `HH:MM` time followed by a word boundary or the end of the text ("9:30", "14:05에"; not "12:00request"). */
const CLOCK_TIME = /(?<![A-Za-z0-9_])\d{1,2}:\d{2}(?![A-Za-z0-9_])/gu;

/**
 * The key-colon exemption (A6-D3a): in a valid http(s) URL token only the literal `://` (and a numeric port's colon)
 * become dots, and an `HH:MM` time's colon becomes a dot. The string keeps every other character, so a key around a
 * URL ("request: https://…", "https://request: …", "x://request: …") is still refused.
 */
function neutraliseUrlAndTimeColons(text: string): string {
  return text
    .replace(HTTP_URL_TOKEN, (token) => token.replace(/^(https?):\/\//iu, '$1...').replace(/^(https?\.\.\.[A-Za-z0-9.-]+):(\d{1,5})(?=[/?#]|$)/iu, '$1.$2'))
    .replace(CLOCK_TIME, (time) => time.replace(':', '.'));
}

/**
 * Action eligibility (ADR-0120 A6 input guard, fail closed). A turn may lead to an A6 action (a selection, an undo, an
 * answer to an A6 question) only when the WHOLE message is one plain instruction:
 *  - a single line, at most {@link NL_ACTION_MAX_INPUT_CHARS} characters, with no platform quote;
 *  - free of hidden characters (format, zero-width, bidi, tag, variation selectors, separators, controls), emoji
 *    sequences excepted;
 *  - free of structure markers (see {@link hasStructureMarker});
 *  - free of an exact-command form (the to-do colon heads, the Slack post head, the Slack post execution phrase).
 * Otherwise nothing acts (reads still work). The grounding text of an eligible message is the whole plain message.
 */
export function nlActionInputRefusal(rawText: string, groundingText: string, quoted = false): NlActionInputRefusal | undefined {
  // Every check runs on the RAW text before any trim, and the structure, colon-head and hidden-character checks also on
  // an NFKC-folded copy, so full-width and compatibility forms (｛ ｝ ［ ］ ｀ ：) count as their ASCII marks. The owner's
  // original text is what spans are grounded in.
  const text = rawText.normalize('NFC');
  const folded = rawText.normalize('NFKC');
  if (Array.from(text).length > NL_ACTION_MAX_INPUT_CHARS) return 'too-long';
  if (HIDDEN.test(text.replace(EMOJI_SEQUENCE, '')) || HIDDEN.test(folded.replace(EMOJI_SEQUENCE, ''))) return 'hidden-characters';
  if (quoted || LINE_SEPARATOR.test(rawText) || LINE_SEPARATOR.test(folded) || hasStructureMarker(text) || hasStructureMarker(folded)) return 'not-plain';
  // Only a plain space may pad the line: any other leading or trailing whitespace (NBSP, ideographic, em space …) refuses.
  if (/^[^\S ]|[^\S ]$/u.test(text)) return 'hidden-characters';
  const groundingFolded = groundingText.normalize('NFKC');
  if (COMMAND_FORMS.some((form) => form.test(groundingFolded) || form.test(folded))) return 'embedded-command';
  return undefined;
}

/** Any line break or separator: CR, LF, VT, FF, NEL (U+0085), LINE and PARAGRAPH SEPARATOR. Checked before any trim. */
const LINE_SEPARATOR = /[\r\n\u000B\u000C\u0085\u2028\u2029]/u;


/**
 * The owner's own prose of the message: every bracketed STRUCTURE (`{…}` / `[…]` holding a quote, a key:value pair or a
 * comma list: pasted JSON or data) is removed, innermost first; an ordinary bracketed phrase ("[긴급] 보고서 쓰기",
 * "할 일에 [보고서 작성] 추가해줘") stays. Every action argument is grounded only in this text.
 */
export function withoutStructures(groundingText: string): string {
  let text = groundingText.normalize('NFC');
  for (let round = 0; round < 8; round += 1) {
    const next = text.replace(/\{([^{}]*)\}|\[([^[\]]*)\]/gu, (whole, brace: string | undefined, square: string | undefined) => {
      const inner = brace ?? square ?? '';
      return brace !== undefined || looksLikeData(inner) ? ' ' : whole;
    });
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** A span that occurs in the message but only inside a pasted structure is data, not the owner's prose. */
export function isNlSpanInsideStructure(span: string, groundingText: string): boolean {
  const text = groundingText.normalize('NFC').replace(/\s+/g, ' ');
  return text.includes(span) && !withoutStructures(groundingText).includes(span);
}
