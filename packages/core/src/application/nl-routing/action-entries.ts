import type { NlActionEntryId, NlAmbiguityKey, NlArgValue, NlArgs, NlCatalogEntry, NlEntryCheckFailure, NlItemSource, NlWave1EntryId } from './catalog';
import type { InboundQuotedRange } from '../../domain';
import { normalizeForMatch } from './selection-input';
import { nlIsRequestForm } from './request-shape';
import { NL_EN_REQUEST_LEADS } from './garbled-action';
import { NL_WAVE1_ENTRIES } from './wave1-entries';
import { isNlTimeWord, nlRangeSymbolWords, nlWeekdayMentions, type NlWeekdayMention } from './symbolic-time';
import { ANCHORED_TODO_PREFIX_HEADS, reminderMonthDates, reminderTextNamesDay, withoutReminderMonthDates } from '../reminders/reminder-grammar';
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
export type NlRefKind = 'index' | (typeof NL_REF_KEYWORDS)[number] | 'key';

/**
 * A parsed `ref` value: `#n`, a deictic keyword, or (A6 R2 owner decision D2, amendment C8) a Jira issue key the owner
 * wrote verbatim ("PROJ-12"), valid only for `item.summarize` over the fresh Jira listing.
 */
export type NlRef =
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'recent' | 'this' | 'last' }
  | { readonly kind: 'key'; readonly key: string };

/** A6 R2 (D2): the shape of a Jira issue key as a `ref` value (upper-case project key, a dash, a number). */
export const NL_REF_JIRA_KEY = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/;

/**
 * `#3` → index 3, `recent` / `this` / `last`; a Jira key → `key` only with `{ keys: true }` (A6 R2 offering Jira, CA P1:
 * with R2 `off` a key-shaped value parses exactly as before, to `undefined`); anything else `undefined`.
 */
export function parseNlRef(value: unknown, options: { readonly keys?: boolean } = {}): NlRef | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (options.keys === true && NL_REF_JIRA_KEY.test(raw)) return { kind: 'key', key: raw };
  const trimmed = raw.toLowerCase();
  if (trimmed === 'recent' || trimmed === 'this' || trimmed === 'last') return { kind: trimmed };
  const match = /^#?([1-9][0-9]?)$/.exec(trimmed);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return index >= 1 && index <= NL_REF_MAX_INDEX ? { kind: 'index', index } : undefined;
}

/** The canonical text of a ref (`#3`, `recent`, …). */
export function formatNlRef(ref: NlRef): string {
  return ref.kind === 'index' ? `#${ref.index}` : ref.kind === 'key' ? ref.key : ref.kind;
}

// ── word classes (value validators) ───────────────────────────────────────────────────────────────────────────────

/**
 * D9 / A6-D2: the closed recency words ("방금 본 거", "아까 그거", "just now"). They are what `recent` means in the ref
 * description, the R5a referent's recency check and Core's `recent` grounding of `item.summarize` (owner decision
 * 2026-10-19); one list, never a phrase list.
 */
const RECENCY_KO = ['방금', '아까'] as const;
const RECENCY_EN = ['just now'] as const;
export const NL_RECENCY_WORDS: readonly string[] = [...RECENCY_KO, ...RECENCY_EN];
/** A6-D2: the closed deictics that ground `recent` / `this`. Korean words match inside a token (particles glued on). */
const DEICTIC_KO = ['그거', '이거', '저거', '그것', '이것', '저것', '그건', '이건', '저건', '그걸', '이걸', '저걸', ...RECENCY_KO];
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
/**
 * The list entry of each item source, whose catalog words are that source's nouns. A6 R2 adds `jira.issues` (지라, 이슈,
 * 티켓, jira) and `slack.search` (슬랙, slack): derived from the catalog, never listed by hand.
 */
const ITEM_SOURCE_LIST_ENTRIES: Readonly<Record<NlItemSource, NlWave1EntryId>> = {
  mail: 'mail.list',
  drive: 'drive.files',
  todo: 'todo.list',
  reminder: 'reminder.list',
  jira: 'jira.issues',
  slack: 'slack.search',
};
/** The A6 R2 sources whose nouns count only while R2 is offered (CA P1: with R2 `off` the R1 noun set is exact). */
export type NlR2NounSources = readonly ('jira' | 'slack')[];
const nounKey = (noun: string): string => noun.replace(/\s+/g, '');
/**
 * Where a noun (or its particles) may end: the end of the text, whitespace, or a closed set of sentence punctuation. A
 * letter, digit, `_` or any other word-joining character never ends it ("이 알림_봇", "그 문서화").
 */
const NOUN_END = '(?:$|\\s|[.,!?~…])';

/** The noun tables of one source set: the R1 sources, plus the R2 sources R2 offers (CA P1). Built once per set. */
interface NounTable {
  readonly nouns: ReadonlyMap<string, ReadonlySet<NlItemSource>>;
  readonly alternation: string;
  readonly determinerAll: RegExp;
  readonly namedAll: RegExp;
  readonly latin: ReadonlyArray<readonly [string, NlItemSource]>;
  glued?: RegExp;
}
const NOUN_TABLES = new Map<string, NounTable>();

function nounTable(r2: NlR2NounSources = []): NounTable {
  const offered = (['jira', 'slack'] as const).filter((source) => r2.includes(source));
  const key = offered.join(',');
  const cached = NOUN_TABLES.get(key);
  if (cached !== undefined) return cached;
  const entries = (Object.entries(ITEM_SOURCE_LIST_ENTRIES) as Array<[NlItemSource, NlWave1EntryId]>).filter(
    ([source]) => (source !== 'jira' && source !== 'slack') || (offered as readonly string[]).includes(source),
  );
  const words = (latinOnly: boolean): Array<readonly [string, NlItemSource]> =>
    entries.flatMap(([source, id]) =>
      [...NL_WAVE1_ENTRIES[id].aliases, ...(NL_WAVE1_ENTRIES[id].sourceNames ?? [])]
        .map(normalizeForMatch)
        .filter((noun) => /^[a-z0-9 .-]+$/.test(noun) === latinOnly)
        .map((noun) => [noun, source] as const),
    );
  const ko = words(false);
  const nouns = ko.reduce((map, [noun, source]) => {
    map.set(nounKey(noun), new Set([...(map.get(nounKey(noun)) ?? []), source]));
    return map;
  }, new Map<string, ReadonlySet<NlItemSource>>());
  const alternation = [...new Set(ko.map(([noun]) => noun))]
    .sort((a, b) => b.length - a.length)
    .map((noun) => noun.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s*'))
    .join('|');
  const table: NounTable = {
    nouns,
    alternation,
    // A determiner word, then an item-source noun that ends there or with particles (captures: determiner, noun).
    determinerAll: new RegExp(`(?<=^|\\s)(${DETERMINERS_KO.join('|')})\\s+(${alternation})(?=${PARTICLE_WORDS}*${NOUN_END})`, 'gu'),
    // A noun standing as its own word: after the start, whitespace or a number word ("1번 문서", "13번알림").
    namedAll: new RegExp(`(?<=^|\\s|\\d|번|째)(${alternation})(?=${PARTICLE_WORDS}*${NOUN_END})`, 'gu'),
    latin: words(true),
  };
  NOUN_TABLES.set(key, table);
  return table;
}

/**
 * The determiner references of the owner's words: which determiner, and which item sources its noun names. The R2 nouns
 * (지라, 이슈, 티켓, 슬랙) count only for the R2 sources offered (`r2`).
 */
function determinerReferences(groundingText: string, r2: NlR2NounSources = []): Array<{ readonly determiner: NlDeterminer; readonly sources: ReadonlySet<NlItemSource> }> {
  const table = nounTable(r2);
  const found: Array<{ determiner: NlDeterminer; sources: ReadonlySet<NlItemSource> }> = [];
  for (const match of normalizeForMatch(groundingText).matchAll(table.determinerAll)) {
    const sources = table.nouns.get(nounKey(match[2] as string));
    if (sources !== undefined) found.push({ determiner: match[1] as NlDeterminer, sources });
  }
  return found;
}

/**
 * ADR-0120 A6-D2 "Same source only" (A6 R1 fix): the item sources the owner's own words name with the catalog's words
 * for them ("1번 문서" names drive, "2번 메일" mail, "그 알림" a reminder). Core cross-checks a `ref` against them for every
 * ref kind, so a selector `source` (or entry) that disagrees with the noun the owner wrote can never read or change an
 * item of another source. The nouns are the catalog's own aliases and source names, never a phrase list. A6 R2: the Jira
 * and Slack nouns count only for the R2 sources offered (`r2Sources`); absent, the R1 set is exactly as before (CA P1).
 */
export function nlNamedItemSources(
  groundingText: string,
  options: { readonly withoutVocabulary?: readonly string[]; readonly r2Sources?: NlR2NounSources } = {},
): ReadonlySet<NlItemSource> {
  const table = nounTable(options.r2Sources);
  // Brackets and other punctuation, and a digit glued to a letter ("메일2번", "2번메일", "mail2"), are word boundaries
  // here, so "2번 (메일)" and "메일2번" name the mail source too (Codex review).
  const text = normalizeForMatch(groundingText)
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/(\p{N})(?=\p{L})|(\p{L})(?=\p{N})/gu, '$1$2 ')
    .replace(/\s+/g, ' ')
    .trim();
  const named = new Set<NlItemSource>();
  for (const match of text.matchAll(table.namedAll)) for (const source of table.nouns.get(nounKey(match[1] as string)) ?? []) named.add(source);
  // A noun glued to a following action or content word of the catalog's own vocabularies ("메일취소해줘", "알림취소해줘",
  // "문서요약해줘"; A6 R1 review); a noun glued to anything else ("알림장") is still no source.
  const glued = options.withoutVocabulary === undefined ? gluedNounPattern(table) : buildGluedNounPattern(options.withoutVocabulary, table);
  for (const match of text.matchAll(glued)) for (const source of table.nouns.get(nounKey(match[1] as string)) ?? []) named.add(source);
  for (const [word, source] of table.latin) if (latinWordIn(text, word)) named.add(source);
  return named;
}

/** Built on first use: the vocabularies are declared further down this module. */
function gluedNounPattern(table: NounTable): RegExp {
  table.glued ??= buildGluedNounPattern([], table);
  return table.glued;
}

/** The glued-noun pattern over the action and content vocabularies, `without` some words (the R5a no-regression gate). */
function buildGluedNounPattern(without: readonly string[], table: NounTable = nounTable()): RegExp {
  const dropped = new Set(without.map(normalizeForMatch));
  const verbs = [...new Set([...NL_ACTION_WORDS, ...NL_MODE_SUMMARY_WORDS, ...NL_MODE_FULL_WORDS, ...NL_CONTENT_WORDS].map(normalizeForMatch).filter((word) => !/^[a-z0-9 .;-]+$/.test(word) && !dropped.has(word)))]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s*'));
  return new RegExp(`(?<=^|\\s|\\d|번|째)(${table.alternation})(?=${verbs.join('|')})`, 'gu');
}

/** Whether the owner's words point with a determiner at an item-source noun ("이 문서", "그 메일"), whatever the entry. */
export function hasNlDeterminerReference(groundingText: string, r2Sources: NlR2NounSources = []): boolean {
  return determinerReferences(groundingText, r2Sources).length > 0;
}

/**
 * A6 R5a (§1.4 step 3): the item sources a determiner reference names ("그 할 일", "그 알림", "이 메일"); 이 and 그 only (저 is
 * also "I"). The noun names where the referent lives, never the entry's target.
 */
export function nlDeterminerSources(groundingText: string): ReadonlySet<NlItemSource> {
  const sources = new Set<NlItemSource>();
  for (const reference of determinerReferences(groundingText)) {
    if (READ_ONLY_DETERMINERS.has(reference.determiner)) continue;
    for (const source of reference.sources) sources.add(source);
  }
  return sources;
}

/** What a `ref` is for: the entry and the item source it acts on (the determiner rule needs both). */
export interface NlRefTarget {
  readonly entryId: NlActionEntryId;
  readonly source?: NlItemSource;
  /** A6 R2: the R2 sources offered this turn (their nouns ground a determiner, and a Jira key is a ref, only then). */
  readonly r2Sources?: NlR2NounSources;
}

/** A determiner reference grounds `target` only for the noun of its own source; 저 only for a read (`item.summarize`). */
function groundsByDeterminer(groundingText: string, target: NlRefTarget | undefined): boolean {
  if (target?.source === undefined) return false;
  const source = target.source;
  return determinerReferences(groundingText, target.r2Sources).some(
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

/** Whether the owner's words carry a `last` word (마지막 / last): what grounds the `last` ref. */
export function nlHasLastWord(groundingText: string): boolean {
  return hasLastWord(groundingText);
}

/** Whether the owner's words carry a recency word ({@link NL_RECENCY_WORDS}; Korean inside a token, as every deictic). */
export function nlHasRecencyWord(groundingText: string): boolean {
  const text = normalizeForMatch(groundingText);
  return RECENCY_KO.some((word) => text.includes(word)) || RECENCY_EN.some((word) => latinWordIn(text, word));
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
    case 'key':
      // A6 R2 (D2): only `item.summarize` over Jira, and only a key the owner wrote verbatim as its own token.
      return target?.entryId === 'item.summarize' && target.source === 'jira' && target.r2Sources?.includes('jira') === true && keyWrittenVerbatim(ref.key, groundingText);
  }
}

/** Whether `key` stands in the owner's words exactly as written (not inside a longer key or word). */
function keyWrittenVerbatim(key: string, groundingText: string): boolean {
  const text = groundingText.normalize('NFC');
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    const before = at > 0 ? text[at - 1] : undefined;
    const after = text[at + key.length];
    const joins = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
    if (!joins(before) && !joins(after)) return true;
  }
  return false;
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
let sourceNounWithParticles: RegExp | undefined;
/** Built on first use over the R1 noun table: an R2 noun is never stripped from a to-do or reminder payload (CA P1). */
function SOURCE_NOUN_WITH_PARTICLES(): RegExp {
  sourceNounWithParticles ??= new RegExp(`(?<=^|\\s)(?:${nounTable().alternation})${GLUED_PARTICLES}(?=${NOUN_END})`, 'gu');
  return sourceNounWithParticles;
}

function contentTokens(span: string, stripSourceNouns = true): string[] {
  let text = normalizeForMatch(span);
  text = text.replace(KO_ORDINAL_WITH_PARTICLES, ' ').replace(EN_ORDINAL_PATTERN, ' ');
  text = text.replace(NUMBER_WITH_PARTICLES, ' ');
  text = text.replace(nounTable().determinerAll, ' ');
  text = text.replace(DEICTIC_WITH_PARTICLES, ' ');
  // A6 R1 review: an item-source noun names where an item lives, never what a to-do or reminder says ("13번 알림").
  if (stripSourceNouns) text = text.replace(SOURCE_NOUN_WITH_PARTICLES(), ' ');
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
 * The closed action vocabularies of the A6 entries (A6 R1 review, `actionGrounding`). Since A6-D3a amendment 1 they only
 * VETO (a negated clause that names the entry's action, a command before a retraction, the glued-noun boundary of
 * {@link nlNamedItemSources}); a write no longer needs one of these words ("1번 할일 체크해줘"). Stems match inside a word.
 */
// 끝 only in its completion forms (끝냈 / 끝났 / 끝내 / 끝마치): "언제 끝나?" is a question, not a completion. No 처리 or 체크:
// "처리 방법", "체크해봐" are not completions (CA review).
const TODO_COMPLETE_WORDS: readonly string[] = ['완료', '끝냈', '끝났', '끝내', '끝마', '마쳤', '마치', '마무리', '다 했', '다했', '해치웠', 'done', 'complete', 'completed', 'finish', 'finished', 'check off'];
// No 그만 (CA delta: "2번 취소 그만해" means stop, not cancel) and no negation-shaped words.
const CANCEL_WORDS: readonly string[] = ['취소', '캔슬', '삭제', '지워', '지우', '지운', '없애', '없던 걸로', '없던걸로', '제거', '제외', 'cancel', 'remove', 'delete', 'drop', 'scrap'];
// No negation-shaped words ("안 할", "안 해도"): a negation in the clause voids grounding (CA review), so they cannot ground.
const TODO_CANCEL_WORDS: readonly string[] = [...CANCEL_WORDS, '빼'];
const REMINDER_CANCEL_WORDS: readonly string[] = [...CANCEL_WORDS, '꺼', '끄', '끈', '멈춰', 'stop', 'turn off', 'disable'];
// Verbs only, never a source noun (CA review: "메모장 열어줘", "알림 설정 어떻게 해?" must not ground a write).
// A6 R5a (owner decision 5, 2026-10-16): "할 일 만들" and its unspaced twin "할일 만들" (`normalizeForMatch` keeps spaces).
const TODO_ADD_WORDS: readonly string[] = ['추가', '넣어', '넣자', '넣기', '올려', '적어', '등록', '할 일 만들', '할일 만들', 'add', 'put', 'jot down'];
const REMINDER_CREATE_WORDS: readonly string[] = [
  '알려', '리마인드', '깨워', '상기시켜',
  // A reminder noun only together with its verb ("알림해줘", "리마인더 설정해줘", "알림 부탁해"), never the noun alone.
  '알림해', '알림 해', '알림 줘', '알림 걸', '알림 만들', '알림으로 만들', '알림 설정', '알림 맞춰', '알림 부탁',
  // A6 R5a (owner decision 5, 2026-10-16).
  '알림으로 걸',
  '리마인더 설정', '리마인더 만들', '리마인더 걸', '리마인더 부탁', '알람 맞춰', '알람 걸', '알람 설정',
  'remind', 'set a reminder', 'notify', 'alert me', 'ping me',
];
const UNDO_WORDS: readonly string[] = ['원상복구', '되돌리기', '되돌', '돌려', '원래대로', '원상', '원복', '롤백', '무르', '물러', '취소', 'undo', 'revert', 'roll back', 'rollback'];
/**
 * A6 R5a (owner decision 5): the closed vocabulary additions. They live in `TODO_ADD_WORDS` / `REMINDER_CREATE_WORDS` (so in
 * {@link NL_ACTION_WORDS}); this manifest only lets the no-regression gate compare every gold with and without them (they
 * change the glued-noun boundary and the negated-clause veto even while R5 is off).
 */
export const NL_R5A_VOCABULARY_ADDITIONS: Readonly<Record<'todo.add' | 'reminder.create', readonly string[]>> = Object.freeze({
  'todo.add': Object.freeze(['할 일 만들', '할일 만들']),
  'reminder.create': Object.freeze(['알림으로 걸']),
});
/**
 * Every action word of every A6 vocabulary. A6-D3a amendment 1: the vocabularies only VETO now (a negated clause that names
 * the entry's action, a command before a retraction; see `request-shape.ts`); they never decide that a write runs.
 */
export const NL_ACTION_WORDS: readonly string[] = [...new Set([...TODO_COMPLETE_WORDS, ...TODO_CANCEL_WORDS, ...REMINDER_CANCEL_WORDS, ...UNDO_WORDS, ...TODO_ADD_WORDS, ...REMINDER_CREATE_WORDS])];

// ── the local-list request shape (live test 2, 2026-10-16: A09, C01, D02) ───────────────────────────────────────────

const escapeForPattern = (word: string): string => word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s*');
const hangulOnly = (words: readonly string[]): string[] => words.filter((word) => /[가-힣]/u.test(word));
/** A past form (its last syllable closes with ㅆ: 끝냈, 마쳤, 다 했) states what happened; it never asks for a write. */
const isPastForm = (word: string): boolean => {
  const last = word.codePointAt(word.length - 1) ?? 0;
  return last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 === 20;
};
const alternationOf = (words: readonly string[]): string => [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeForPattern).join('|');
/** The verb a reminder noun carries in its own create words ("알림 걸", "알림으로 만들" → 걸, 만들); never a bare 해 / 줘. */
const REMINDER_NOUN_HEAD = /^(?:알림|리마인더|알람)(?:으로)?\s?/u;
const REMINDER_CREATE_VERBS = REMINDER_CREATE_WORDS.filter((word) => REMINDER_NOUN_HEAD.test(word))
  .map((word) => word.replace(REMINDER_NOUN_HEAD, ''))
  .filter((verb) => verb.length > 0 && verb !== '해' && verb !== '줘');
/**
 * The closed standalone fillers between a verbal noun and its request word (the undo grammar's filler class, adverbs only:
 * 좀, 좀만, 한번 / 한 번, 빨리, 다시, 제발, 지금); they carry no content and never make the request.
 */
const REQUEST_FILLERS: ReadonlySet<string> = new Set(['좀', '좀만', '한번', '빨리', '빨리요', '다시', '제발', '제발요', '지금']);
/** The closed particles a verbal noun may carry before a separate request word ("완료로 바꿔줘", "추가좀 해줘"). */
const VERB_PARTICLE = /^(?:으로|로|을|를|좀)?$/u;

interface LocalListShape {
  readonly list: 'todo' | 'reminder';
  /** The list noun with a destination particle; an add verb of that list follows later in the clause ("할 일로 … 등록"). */
  readonly destination: RegExp;
  /** The list noun as the object of a verb right after it ("… 할 일 취소", "… 알림 꺼줘"). */
  readonly object: RegExp;
  /** The list noun as the source; a cancel / complete verb follows later in the clause ("할 일 목록에서 … 빼줘"). */
  readonly source: RegExp;
  readonly addVerb: RegExp;
  readonly changeVerb: RegExp;
}

let localListShapes: readonly LocalListShape[] | undefined;

/** Built on first use from the catalog's own list nouns and the A6 vocabularies (one source of truth, no phrase list). */
function localListShapesOf(): readonly LocalListShape[] {
  if (localListShapes !== undefined) return localListShapes;
  const shape = (list: 'todo' | 'reminder', nouns: readonly string[], add: readonly string[], change: readonly string[]): LocalListShape => {
    const noun = `(?<![가-힣A-Za-z])(?:${alternationOf(nouns.map(normalizeForMatch))})(?:\\s*목록)?`;
    const addVerb = alternationOf(hangulOnly(add));
    const changeVerb = alternationOf(hangulOnly(change).filter((word) => !isPastForm(word)));
    return {
      list,
      destination: new RegExp(`${noun}\\s*(?:으로|로|에다가|에다|에)(?![가-힣])`, 'gu'),
      object: new RegExp(`${noun}\\s*(?:을|를|은|는|도|좀)?\\s*(?=${changeVerb})`, 'gu'),
      source: new RegExp(`${noun}\\s*에서(?![가-힣])`, 'gu'),
      addVerb: new RegExp(addVerb, 'gu'),
      changeVerb: new RegExp(`^(?:${changeVerb})`, 'u'),
    };
  };
  localListShapes = [
    shape('todo', NL_WAVE1_ENTRIES['todo.list'].aliases, TODO_ADD_WORDS, [...TODO_CANCEL_WORDS, ...TODO_COMPLETE_WORDS]),
    shape('reminder', NL_WAVE1_ENTRIES['reminder.list'].aliases, [...TODO_ADD_WORDS, ...REMINDER_CREATE_VERBS], REMINDER_CANCEL_WORDS),
  ];
  return localListShapes;
}

/**
 * Whether the vocabulary verb at `index` of `clause` is the clause's request: its word ends in a request form (the
 * request-shape recogniser `nlIsRequestForm`: "추가해줘", "취소해", "등록해 주세요"), or the bare verbal noun (a closed
 * particle at most) is followed by a request word ("완료로 바꿔줘", "취소 처리해줘"), or the bare verb ends the clause (the
 * terse command "… 하나 추가"). An adnominal ("추가한 회의"), past ("추가했어"), connective ("빼고") or descriptive form never is.
 */
function isRequestedVerbAt(clause: string, index: number, verb: string): boolean {
  const start = clause.lastIndexOf(' ', index) + 1;
  const spaceAfter = clause.indexOf(' ', index + verb.length);
  const end = spaceAfter === -1 ? clause.length : spaceAfter;
  const word = clause.slice(start, end);
  if (nlIsRequestForm(word)) return true;
  if (!VERB_PARTICLE.test(clause.slice(index + verb.length, end))) return false;
  // Closed standalone fillers before the request word are skipped ("추가 좀 해줘", "취소 한 번 해줘", "등록 빨리 해줘").
  const following = clause.slice(end).trim().split(' ').filter((token) => token.length > 0);
  let at = 0;
  while (at < following.length) {
    const token = following[at] ?? '';
    if (REQUEST_FILLERS.has(token)) at += 1;
    else if (token === '한' && following[at + 1] === '번') at += 2;
    else break;
  }
  const next = following[at];
  if (next === undefined) return clause.slice(index + verb.length, end).length === 0;
  return nlIsRequestForm(next);
}

/** Whether a verb of `verbs` after `from` in the clause is the clause's request. */
function requestedVerbAfter(clause: string, from: number, verbs: RegExp): boolean {
  verbs.lastIndex = 0;
  for (const match of clause.slice(from).matchAll(verbs)) {
    if (isRequestedVerbAt(clause, from + (match.index ?? 0), match[0])) return true;
  }
  return false;
}

/** Clause boundaries: sentence ends, commas and the coordinating connectives (the calendar grammar's own clause rule). */
const LOCAL_LIST_CLAUSE_SPLIT = /[.!?。！？\r\n]+|[,;]\s*|\s+(?:그리고|하지만|근데|그런데)\s+/u;
/** Quoted text is content (a title, a phrase), never the request's own list noun or verb. */
const LOCAL_LIST_QUOTED = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu;

function withoutQuotedPayloads(text: string, quotedRanges: readonly InboundQuotedRange[]): string {
  let out = text;
  for (const range of quotedRanges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start) continue;
    const end = Math.min(range.end, out.length);
    if (range.start >= end) continue;
    out = `${out.slice(0, range.start)}${' '.repeat(end - range.start)}${out.slice(end)}`;
  }
  return out.replace(LOCAL_LIST_QUOTED, ' ');
}

/**
 * Live test 2 (2026-10-16, A09 / C01 / D02): the local list (Quoky's own to-dos or reminders) one clause of the owner's
 * sentence names as the place of a write, or `undefined`. The shape is structural: a list noun of the catalog
 * (`todo.list` / `reminder.list` aliases) with
 *  - a destination particle (로 / 으로 / 에 / 에다) and an add verb of that list's A6 vocabulary later in the clause
 *    ("'…' 할 일로 등록해줘", "할 일에 … 추가해줘", "… 알림으로 … 등록해줘");
 *  - or directly followed (a particle at most) by a cancel / complete verb of that list ("… 일정 잡기 할 일 취소해줘");
 *  - or 에서 and such a verb later ("할 일 목록에서 … 빼줘");
 * and the verb is the clause's request ({@link isRequestedVerbAt}: an adnominal, past or connective form never counts).
 * Quoted text (quote marks, or the platform's quoted ranges) is blanked first: a quoted title is the payload of a request
 * around it ("'시안 반영' 할 일로 등록해줘" still names the to-do list), and a list phrase inside quotes is never one
 * ("디자인에 '할 일 완료' 문구를 반영해줘").
 *
 * Class A grammars that would otherwise claim the words around it (the calendar write grammar's "일정 … 취소해줘" and
 * "모레 3시 … 통화 등록해줘", the code-change chain's apply word 반영) read this so a local-list request is not mistaken
 * for theirs. It narrows their recognition (the message is not a calendar write or a code apply); it is not a yield to
 * selection and adds no phrase: every word is a catalog noun, an A6 vocabulary word or a closed particle.
 */
export function nlLocalListTarget(text: string, quotedRanges: readonly InboundQuotedRange[] = []): 'todo' | 'reminder' | undefined {
  const normalized = normalizeForMatch(withoutQuotedPayloads(text, quotedRanges));
  if (normalized.length === 0) return undefined;
  for (const clause of normalized.split(LOCAL_LIST_CLAUSE_SPLIT).map((part) => part.trim())) {
    for (const shape of localListShapesOf()) {
      for (const anchor of clause.matchAll(shape.destination)) {
        if (requestedVerbAfter(clause, (anchor.index ?? 0) + anchor[0].length, shape.addVerb)) return shape.list;
      }
      for (const anchor of clause.matchAll(shape.object)) {
        const at = (anchor.index ?? 0) + anchor[0].length;
        const verb = shape.changeVerb.exec(clause.slice(at))?.[0];
        if (verb !== undefined && isRequestedVerbAt(clause, at, verb)) return shape.list;
      }
      for (const anchor of clause.matchAll(shape.source)) {
        const from = (anchor.index ?? 0) + anchor[0].length;
        const verbs = new RegExp(shape.changeVerb.source.slice(1), 'gu');
        if (requestedVerbAfter(clause, from, verbs)) return shape.list;
      }
    }
  }
  return undefined;
}

/**
 * Garbled action word addendum (CA review, 2026-10-16): the word class of the Hangul action words that are verbal NOUNS
 * (Sino-Korean or loan nouns taking 하다 / 되다 / 처리, and nominal forms). A noun does not inflect by itself, so a one-jamo
 * change to it is a garble ("완룐"); every other Hangul action word is a verb form, whose ending consonants (끝냄, 마침,
 * 해치워 ↔ 해치웠) and vowel contraction (마쳐) are inflection (`garbled-action.ts`). A part-of-speech tag, not a phrase list.
 */
export const NL_ACTION_VERBAL_NOUNS: readonly string[] = ['완료', '마무리', '취소', '캔슬', '삭제', '제거', '제외', '추가', '등록', '리마인드', '원상복구', '원상', '원복', '롤백', '넣기', '되돌리기', '원래대로'];

/**
 * Owner decision E (2026-10-17): the Hangul action words of the vocabularies that are LOANWORDS (spelled from an English
 * sound: cancel, remind, roll back). A tag on the existing vocabulary, like {@link NL_ACTION_VERBAL_NOUNS}; no word is added.
 * A loanword's vowels drift in spelling while its consonant frame stays, so a vowel-only variant of one is garbled and asks
 * ("칸셀해줘"; `garbled-action.ts`). Only single-word entries are tagged: a phrase such as "알람 맞춰" is never compared.
 */
export const NL_ACTION_LOANWORDS: readonly string[] = ['캔슬', '리마인드', '롤백'];

/**
 * Owner decision (b) of 2026-10-19 (garbled entry noun, `garbled-action.ts` `nlGarbledEntryNoun`): the nouns that decide
 * which list a local write touches are the catalog's own list aliases (`todo.list`, `reminder.list`); no word is added.
 */
export const NL_ENTRY_NOUNS: readonly { readonly owner: 'todo' | 'reminder'; readonly words: readonly string[] }[] = Object.freeze([
  { owner: 'todo', words: NL_WAVE1_ENTRIES['todo.list'].aliases },
  { owner: 'reminder', words: NL_WAVE1_ENTRIES['reminder.list'].aliases },
]);
/** The list aliases spelled from an English sound (a tag, like {@link NL_ACTION_LOANWORDS}). */
export const NL_ENTRY_NOUN_LOANWORDS: readonly string[] = ['리마인더', '투두'];
/**
 * The verbs the vocabularies pair with a list noun ("알림 걸", "리마인더 설정", "할 일 만들" → 걸, 설정, 만들), derived from
 * the vocabularies themselves; the bare light verbs and request words (해, 줘, 부탁) carry no object of their own.
 */
const ENTRY_NOUN_HEAD = new RegExp(`^(?:${[...NL_ENTRY_NOUNS.flatMap((list) => list.words)].filter((word) => /[가-힣]/u.test(word)).sort((a, b) => b.length - a.length).map((word) => word.replace(/ /g, '\\s?')).join('|')})(?:으로|로)?\\s?`, 'u');
export const NL_ENTRY_NOUN_VERBS: readonly string[] = [
  ...new Set(
    [...TODO_ADD_WORDS, ...REMINDER_CREATE_WORDS]
      .filter((word) => ENTRY_NOUN_HEAD.test(word))
      .map((word) => word.replace(ENTRY_NOUN_HEAD, ''))
      .filter((verb) => verb.length > 0 && !/^(?:해|줘|부탁)$/u.test(verb)),
  ),
];

/** The canonical action word of each LOCAL_WRITE entry, offered when a garbled word asks (never the raw vocabulary stem). */
export const NL_ACTION_CANONICAL_WORDS: Readonly<Record<'todo.add' | 'todo.complete' | 'todo.cancel' | 'reminder.create' | 'reminder.cancel' | 'action.undo', { readonly ko: string; readonly en: string }>> = Object.freeze({
  'todo.add': { ko: '추가', en: 'add' },
  'todo.complete': { ko: '완료', en: 'complete' },
  'todo.cancel': { ko: '취소', en: 'cancel' },
  'reminder.create': { ko: '알림', en: 'remind' },
  'reminder.cancel': { ko: '취소', en: 'cancel' },
  'action.undo': { ko: '되돌리기', en: 'undo' },
});

/**
 * A6-D3a amendment 1: whether the owner's frame (the prose without the selector's content spans) expresses anything beyond
 * references, deictics, numbers, time words and fillers. "2번도", "그걸로요", "13번 알림" (a target entry) and "내일 9시
 * 우유" (a payload entry, frame "") express no action. For a target entry an item-source noun is part of the reference
 * ("13번 알림" names the item); for a payload entry it names what to make ("… 월세 이체 리마인더"), so it counts.
 */
/**
 * The R5a seam (A6-D3a amendment 1): `nlActionWordGrounded` keeps its name and signature; it now means "an action word is
 * present and no structural veto applies" (`request-shape.ts`), not the removed request-form rule.
 */
export { nlActionWordGrounded } from './request-shape';

export function nlFrameExpressesAction(frame: string, sourceNounIsReference: boolean): boolean {
  return contentTokens(frame, sourceNounIsReference).length > 0;
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
  // The canonical `when` carries no trailing locative 에 (its own arg description): "20분 후에" is "20분 후". The grammar
  // reads both as the same time, so this is a spelling of the owner's own time words, never another time (A6 R1 gate).
  normalize(args: Record<string, NlArgValue>): void {
    const when = args.when;
    if (typeof when !== 'string') return;
    const bare = when.replace(/(?<=\S)\s*에$/u, '');
    if (bare !== when && containsNlTimeExpression(bare)) args.when = bare;
  },
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
  // Owner decision C (2026-10-17, A6-D1 amendment): like the to-do transitions, a reminder is named by `ref` or by the
  // owner's own words (`match`), exactly one of them. The handler resolves a match against the scheduled list only.
  args: [
    { name: 'ref', kind: 'ref', description: REF_DESCRIPTION },
    {
      name: 'match',
      kind: 'span',
      maxChars: NL_SPAN_MAX_CHARS,
      description: 'Instead of ref: the reminder text the owner wrote, verbatim, without the verb and 알림. Exactly one of ref and match.',
    },
  ],
  usage: { ko: '"알림 N 취소"', en: '"알림 N 취소"' },
  staleCommands: [/알림\s?(?:\d+|N|번호)\s?(?:번\s?)?취소/u],
  check(args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined {
    if (isNlBulkRequest(groundingText)) return { reason: 'bulk' };
    return exactlyOneTarget(args);
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

/** The sources `item.summarize` can read, in canonical order (R1: mail, Drive; A6 R2: Jira, Slack). */
export const NL_ITEM_SUMMARIZE_SOURCES = ['mail', 'drive', 'jira', 'slack'] as const;
export type NlItemSummarizeSource = (typeof NL_ITEM_SUMMARIZE_SOURCES)[number];

const R2_REF_DESCRIPTION = `${REF_DESCRIPTION} For a Jira issue only: the issue key exactly as the owner wrote it (PROJ-12).`;

/**
 * A6 R2 (v46): the `mode` vocabulary as the selector reads it, built from the words Core grounds `mode` with
 * ({@link NL_MODE_SUMMARY_WORDS}, {@link NL_MODE_FULL_WORDS}), so the prompt and the validator cannot drift (v45 listed
 * five of nine summary words and five of ten full words by hand). v47 adds {@link NL_CONTENT_WORDS}: a content word alone
 * leaves `mode` unset (Core asks the content-mode question). Used by the R2 entry and the R2 rule 8 line.
 */
export function nlModeVocabularyText(): { readonly summary: string; readonly full: string; readonly content: string } {
  return { summary: NL_MODE_SUMMARY_WORDS.join('/'), full: NL_MODE_FULL_WORDS.join('/'), content: NL_CONTENT_WORDS.join('/') };
}

/**
 * A6 R2: the `item.summarize` entry for the offered sources. Without Jira or Slack it is the R1 entry itself (byte for
 * byte, so the A6 prompt stays nl-select.v44). With them, the `source` enum and the description list only the offered
 * R2 sources (mail and Drive stay as in R1), `scope: thread` is valid for mail and Slack, and `ref` may be a Jira key.
 */
export function nlItemSummarizeEntry(sources: Iterable<string>): NlCatalogEntry {
  const offered = new Set(sources);
  const r2 = (['jira', 'slack'] as const).filter((source) => offered.has(source));
  if (r2.length === 0) return itemSummarize;
  const names = { jira: { en: 'Jira issue', ko: '지라 이슈' }, slack: { en: 'Slack message', ko: '슬랙 메시지' } };
  const en = ['mail', 'Drive file', ...r2.map((source) => names[source].en)];
  const ko = ['메일', '드라이브', ...r2.map((source) => names[source].ko)];
  const threadSources = ['mail', ...(r2.includes('slack') ? ['slack'] : [])];
  return {
    ...itemSummarize,
    description: {
      // v46 (F1): one pointed item is this entry even when the message names its source or uses a show verb; the list
      // entries answer queries over a list.
      en: `Summarize or show ONE ${en.slice(0, -1).join(', ')} or ${en[en.length - 1]} from the list Quoky just showed, when the owner asks what it says. Also when the owner names the source or says show: one pointed item is this entry, a query over a list is the list entry.`,
      ko: `방금 보여준 ${ko.join('·')} 목록의 항목 하나를 요약하거나 보여주기(내용을 물을 때). 출처 이름이나 보여 달라는 말이 있어도 항목 하나를 가리키면 이 항목.`,
    },
    args: itemSummarize.args.map((spec) => {
      // v46 (F3): the owner's noun first, then the recency target, then the context.
      if (spec.name === 'source') {
        return {
          ...spec,
          values: ['mail', 'drive', ...r2],
          description: "The source the owner's own noun names; with no noun, 방금/아까 take the source of last read; otherwise the list in Reference context.",
        };
      }
      if (spec.name === 'mode') {
        const vocabulary = nlModeVocabularyText();
        return { ...spec, description: `summary ONLY for ${vocabulary.summary}; full ONLY for ${vocabulary.full}. Omit it otherwise; scope never sets it.` };
      }
      if (spec.name === 'ref' && r2.includes('jira')) return { ...spec, description: R2_REF_DESCRIPTION };
      if (spec.name === 'scope') {
        return { ...spec, description: `thread ONLY when the owner asks about the whole thread (스레드/thread); ${threadSources.join(' and ')} only.` };
      }
      return spec;
    }),
    check(args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined {
      if (!asksForItemContent(groundingText)) return { reason: 'ungrounded', arg: 'mode' };
      if (args.scope === 'thread' && !threadSources.includes(String(args.source))) return { reason: 'invalid-arg', arg: 'scope' };
      // A Jira key ref names a Jira issue only (D2).
      if (parseNlRef(args.ref, { keys: true })?.kind === 'key' && args.source !== 'jira') return { reason: 'invalid-arg', arg: 'ref' };
      return undefined;
    },
  };
}

/** A6 R2: the Jira / Slack sources the offered `item.summarize` entry lists (empty while R2 is `off`). */
export function nlR2SourcesOffered(entries: Iterable<NlCatalogEntry>): NlR2NounSources {
  for (const entry of entries) {
    if (entry.id !== 'item.summarize') continue;
    const values = itemSummarizeSources(entry);
    return (['jira', 'slack'] as const).filter((source) => values.includes(source));
  }
  return [];
}

/** The `source` values an `item.summarize` entry offers. */
function itemSummarizeSources(entry: NlCatalogEntry): string[] {
  return entry.args.find((spec) => spec.name === 'source')?.values?.map(String) ?? [];
}

/**
 * A6 R2: one `item.summarize` entry for every handler that contributes one (mail, Drive and the work-chat lookup for
 * Jira / Slack): the union of their `source` values in canonical order. Without an R2 source it is the R1 entry.
 */
export function mergeItemSummarizeEntries(entries: readonly NlCatalogEntry[]): NlCatalogEntry {
  const union = new Set(entries.flatMap(itemSummarizeSources));
  return nlItemSummarizeEntry(NL_ITEM_SUMMARIZE_SOURCES.filter((source) => union.has(source)));
}

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

/**
 * Owner decision of 2026-10-19 (reminder.list `range`, A5 rule 6): whether the owner's words name a period at all. The title
 * time check ({@link containsNlTimeExpression}) treats a spaced "이번 주" as two weak words; a period word written with a
 * space ("이번 주", "다음 달") is one period here, as in its unspaced form; and the reminder grammar's own day recognizer
 * (`reminderTextNamesDay`: "December 25", "Dec 25", "next week", weekdays, Korean dates) counts too (Codex P2).
 */
export function nlNamesPeriod(text: string): boolean {
  return containsNlTimeExpression(text) || containsNlTimeExpression(text.replace(/(이번|다음|다다음|지난|저번)\s+(주|달)/gu, '$1$2')) || reminderTextNamesDay(text);
}

/**
 * Codex P2 (2026-10-19, reminder.list `range`): the range symbols the owner's own words name, longest phrase first so a
 * shorter one inside it does not count ("이번 주말" is not also "이번 주"): the symbol words of `symbolic-time` (Korean with
 * or without the space, English) and the dates the reminder grammar reads (`reminderMonthDates`: "12월 25일", "12/25",
 * "Dec 25") as `MM-DD`. Weekdays are left to the weekday consistency rule. Pure.
 */
export function nlExpressedRangeSymbols(text: string): string[] {
  let rest = ` ${normalizeForMatch(text)} `;
  const symbols: string[] = [];
  const phrases = nlRangeSymbolWords()
    .flatMap(([symbol, ko, en]) => [
      [symbol, normalizeForMatch(ko)],
      [symbol, normalizeForMatch(ko).replace(/\s+/gu, '')],
      [symbol, normalizeForMatch(en)],
    ] as const)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [symbol, phrase] of phrases) {
    const latin = /^[a-z0-9 -]+$/u.test(phrase);
    const pattern = new RegExp(latin ? `(?<![a-z0-9])${phrase.replace(/ /g, '\\s+')}(?![a-z0-9])` : `(?<![가-힣])${phrase.replace(/ /g, '\\s*')}`, 'u');
    if (!pattern.test(rest)) continue;
    rest = rest.replace(pattern, ' ');
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  for (const date of reminderMonthDates(text)) {
    const symbol = `${date.year !== undefined ? `${date.year}-` : ''}${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  return symbols;
}

/**
 * Owner decision of 2026-10-19, bounded in review (Codex P2, three rounds): the CLOSED set of periods `reminder.list`
 * filters by. The owner's words resolve to exactly one of: today, tomorrow, this-week, next-week, one calendar date with
 * month and day (an explicit year kept: `MM-DD` / `YYYY-MM-DD`), or one weekday of this or next week ("다음 주 수요일" =
 * next-wed, "수요일" = wed). `none`: the words name no period. `unsupported`: anything else the words name (a span with
 * 부터/까지/until/~, a duration such as 앞으로 7일 / next 7 days, a month, a day-only date "25일", a past or other symbol,
 * several periods): Core asks with the fixed restate and never filters or drops it.
 */
export type NlReminderPeriod =
  | { readonly kind: 'none' }
  /**
   * `weekday`: the period is that one weekday mention, placed by the weekday validation's own rules (an English "next" /
   * "this" is a direction, not a week: `nlWeekdayMentionRanges`); `symbol` is then its Korean-week spelling or bare stem.
   */
  | { readonly kind: 'supported'; readonly symbol: string; readonly weekday?: NlWeekdayMention }
  | { readonly kind: 'unsupported' };

const REMINDER_RELATIVE_PERIODS = ['today', 'tomorrow', 'this-week', 'next-week'] as const;
const WEEKDAY_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/**
 * A span or an open bound (부터 … 까지, 이후, 이전, until, through, from, since, after, before, a "~" before a number): a
 * period with an edge the closed set has no symbol for.
 */
const PERIOD_SPAN = /부터|까지|이후|이전|이내|(?<![a-z])(?:until|till|through|thru|from|since|after|before|within|between)(?![a-z])|[~〜–]\s*\d/u;
/** A duration counted from now (앞으로 7일, 향후 2주, 3일 동안, next 7 days, in 3 days). */
const PERIOD_DURATION = /(?:앞으로|향후|최근|지난)\s*\d+\s*(?:일|주|개월|달)|\d+\s*(?:일|주|개월)\s*(?:동안|간|뒤|후|이내)|(?<![a-z])(?:next|past|last|coming|in)\s+\d+\s+(?:days?|weeks?|months?)(?![a-z])/u;
/** A number with a calendar or clock unit ("25일", "2월", "2주", "7 days", "3시간"): never placed by a guess. */
const NUMBER_TIME_UNIT = /\d+\s*(?:일|주|개월|달|월|년|시간|시|분|(?<![a-z])(?:days?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?)(?![a-z]))/u;
/**
 * Codex P2 (2026-10-19): an English month name on its own ("in November", "Dec reminders"): a month the closed set has no
 * symbol for. "may" and "march" are also a modal and a verb, so they count only after a period preposition or determiner
 * ("in May", "this March"). The Korean "11월" is a number with a unit (`NUMBER_TIME_UNIT`).
 */
const EN_MONTH_NAME = /(?<![a-z])(?:january|february|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)(?![a-z])|(?<![a-z])(?:in|for|during|of|this|next|last|until|by|since)\s+(?:may|march|mar)(?![a-z])/u;
/** A weekday form with its optional this / next week word ("다음 주 수요일", "이번주 금", "next Wednesday"). */
const WEEKDAY_FORM = /(?:(?:이번|다음|담|차|금)\s*주\s*)?[월화수목금토일](?:요일|욜)날?|(?:이번|다음|담|차|금)\s*주\s*[월화수목금토일](?![가-힣])|(?<![a-z])(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)(?![a-z])/gu;

/**
 * Whether `text` carries any time expression Core knows: the A6 time-expression detector, the period words and the
 * reminder grammar's own day recognizer (`nlNamesPeriod`), a range symbol word or date, a weekday, a duration or a number
 * with a calendar or clock unit.
 */
function hasReminderTimeExpression(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return (
    nlNamesPeriod(text) ||
    PERIOD_DURATION.test(normalized) ||
    NUMBER_TIME_UNIT.test(normalized) ||
    EN_MONTH_NAME.test(normalized) ||
    nlExpressedRangeSymbols(text).length > 0 ||
    nlWeekdayMentions(text).length > 0
  );
}

/** The one supported period the symbols and weekdays name, or `undefined` (none, several, or one outside the set). */
function supportedReminderPeriod(symbols: readonly string[], weekdays: readonly NlWeekdayMention[]): string | undefined {
  if (weekdays.length > 0) {
    // One weekday of this or next week: its week word is its only other period word ("다음 주 수요일" = next-wed).
    const day = weekdays[0] as NlWeekdayMention;
    const anchor = day.week === 'next' ? 'next-week' : day.week === 'this' ? 'this-week' : undefined;
    if (weekdays.length !== 1 || day.bound || (day.week !== undefined && anchor === undefined) || day.direction === 'past') return undefined;
    if (symbols.some((symbol) => symbol !== anchor)) return undefined;
    return `${anchor === 'next-week' ? 'next-' : anchor === 'this-week' ? 'this-' : ''}${WEEKDAY_BY_INDEX[day.weekday]}`;
  }
  if (symbols.length !== 1) return undefined;
  const symbol = symbols[0] as string;
  return (REMINDER_RELATIVE_PERIODS as readonly string[]).includes(symbol) || /^(?:\d{4}-)?\d{2}-\d{2}$/u.test(symbol) ? symbol : undefined;
}

/** `text` without the supported period forms: the four relative period words, month-day dates and weekday forms. */
function withoutSupportedPeriodForms(text: string): string {
  let rest = ` ${normalizeForMatch(withoutReminderMonthDates(text))} `.replace(WEEKDAY_FORM, ' ');
  const phrases = nlRangeSymbolWords()
    .filter(([symbol]) => (REMINDER_RELATIVE_PERIODS as readonly string[]).includes(symbol))
    .flatMap(([, ko, en]) => [normalizeForMatch(ko), normalizeForMatch(ko).replace(/\s+/gu, ''), normalizeForMatch(en)])
    .sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const latin = /^[a-z0-9 -]+$/u.test(phrase);
    rest = rest.replace(new RegExp(latin ? `(?<![a-z0-9])${phrase.replace(/ /g, '\\s+')}(?![a-z0-9])` : `(?<![가-힣])${phrase.replace(/ /g, '\\s*')}`, 'gu'), ' ');
  }
  return rest;
}

/**
 * Owner decision of 2026-10-19, bounded in review (Codex P2, four rounds): the CLOSED set of periods `reminder.list`
 * filters by: today, tomorrow, this-week, next-week, one calendar date with month and day (an explicit year kept: `MM-DD` /
 * `YYYY-MM-DD`), or one weekday of this or next week ("다음 주 수요일" = next-wed, "수요일" = wed).
 * One residual rule closes the class: the owner's prose (without structures) must name exactly one supported period, and
 * once its forms are removed NO time expression may remain (a clock "오전 9시", a part of the day "morning" / "저녁", a
 * duration "next 7 days", a span, a month, a day-only date, another period). `none`: the prose has no time expression at
 * all (no range). `unsupported`: any other prose with a time expression; Core asks with the fixed restate and never
 * filters with it or drops it. `weekdays` defaults to the prose's own weekday mentions.
 */
export function nlReminderPeriod(text: string, weekdays?: readonly NlWeekdayMention[]): NlReminderPeriod {
  const prose = withoutStructures(text);
  const days = weekdays ?? nlWeekdayMentions(prose);
  const symbols = nlExpressedRangeSymbols(prose);
  if (symbols.length === 0 && days.length === 0 && !hasReminderTimeExpression(prose)) return { kind: 'none' };
  if (PERIOD_SPAN.test(normalizeForMatch(prose))) return { kind: 'unsupported' };
  const symbol = supportedReminderPeriod(symbols, days);
  if (symbol === undefined || hasReminderTimeExpression(withoutSupportedPeriodForms(prose))) return { kind: 'unsupported' };
  return days.length === 1 ? { kind: 'supported', symbol, weekday: days[0] as NlWeekdayMention } : { kind: 'supported', symbol };
}

/**
 * Codex P2 (2026-10-19): every arg name the catalog defines (read and action entries). A diagnostic names an arg only when
 * it is one of these; any other key the model generated is reported without its name, so nothing it wrote reaches a log.
 */
export const NL_CATALOG_ARG_NAMES: ReadonlySet<string> = new Set(
  [...Object.values(NL_WAVE1_ENTRIES), ...Object.values(NL_ACTION_ENTRIES)].flatMap((entry) => (entry === undefined ? [] : entry.args.map((spec) => spec.name))),
);

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
export function nlActionSourceOf(entryId: NlActionEntryId, args: NlArgs): NlItemSource | undefined {
  switch (entryId) {
    case 'todo.add':
    case 'todo.complete':
    case 'todo.cancel':
      return 'todo';
    case 'reminder.create':
    case 'reminder.cancel':
      return 'reminder';
    case 'item.summarize':
      return args.source === 'mail' || args.source === 'drive' || args.source === 'jira' || args.source === 'slack' ? args.source : undefined;
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

/**
 * A Hangul speaker label, refused like the Latin "Kim: …" key (A6-D3a amendment 1, CA): a name or title with an address
 * suffix and a colon ("팀장님: …"), the same in brackets ("[김대리] …"), or "X 왈". The suffixes are the closed class of
 * Korean address terms (님, 씨 and the office titles), never a routing word.
 */
const ADDRESS_SUFFIX = '(?:님|씨|대리|과장|차장|부장|팀장|실장|사장|대표|이사|주임|사원|선배|선생)';
const HANGUL_SPEAKER_LABEL = new RegExp(
  `(?<![가-힣])[가-힣]{0,10}${ADDRESS_SUFFIX}\\s*[:：]|\\[\\s*[가-힣]{0,10}${ADDRESS_SUFFIX}\\s*\\]|(?<![가-힣])[가-힣]{1,10}\\s+왈(?=$|\\s|[:：])`,
  'u',
);

/** A bracket whose content looks like data: a quote, an identifier key with a colon, or a comma list. */
export function looksLikeData(inner: string): boolean {
  return /["“”'`]|[\p{L}\p{N}_]\s*:|,/u.test(inner);
}

/**
 * Markers of structured or quoted material (fail closed: any of them means the message is not one plain instruction):
 * braces, a data-like square bracket, backticks, a tilde fence, a line-leading `>`, or an ASCII identifier key followed
 * by a colon and a value (`request: …`, YAML-like). An ordinary bracketed phrase ("[긴급] 보고서 쓰기") is not a marker.
 */
function hasStructureMarker(rawText: string, allowActionLabel = false): boolean {
  // Nothing is removed from the checked text: only the URL and time colons below are neutralised, character for character.
  const text = neutraliseUrlAndTimeColons(rawText);
  if (/[{}`]/u.test(text) || /~~~/u.test(text) || /^\s*>/u.test(text)) return true;
  for (const match of text.matchAll(/\[([^[\]]*)\]/gu)) if (looksLikeData(match[1] ?? '')) return true;
  if (/[[\]]/u.test(text.replace(/\[[^[\]]*\]/gu, ''))) return true;
  // A key is an ASCII identifier not glued to a preceding letter ("12:00request:" and "x,request:" are keys).
  const keys = [...text.matchAll(KEY_COLON)];
  if (keys.length === 0) return false;
  // Owner decision D (2026-10-17): the one English command label of an action request ("Add a to-do: …", "Todo: …").
  return !(allowActionLabel && keys.length === 1 && isNlActionColonLabel(text.slice(0, text.indexOf(':', keys[0]?.index ?? 0))));
}

/** An ASCII identifier key followed by a colon and a value (`request: …`, YAML-like). */
const KEY_COLON = /(?<![A-Za-z_])[A-Za-z_][A-Za-z0-9_-]*\s*:(?=\s*\S)/gu;
/** A label of at most six Latin words (letters, digits, a hyphen or an apostrophe inside a word). */
const LATIN_LABEL = /^\s*[A-Za-z0-9][A-Za-z0-9'’-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’-]*){0,5}\s*$/u;

/**
 * Owner decision D (2026-10-17, amends the A6-D3a "known refusals"): an English colon label is the owner's command head,
 * like the Korean colon forms the owner approved ("todo 추가: …", "알림: …"), when it is the message's own start, holds the
 * message's only key colon, is made of Latin words only, and LEADS with a word the catalog already has for a LOCAL_WRITE
 * action or a local list (the LOCAL_WRITE action vocabularies and aliases, the to-do and reminder list aliases), after at
 * most the closed request leads of the imperative slot ("please"). A hyphen inside a word is ignored ("to-do" is "todo").
 * The leading position is the imperative or the bare list head, so "I added a to-do: …" and "Did you add a to-do: …" stay
 * refused. "Add a to-do: …", "Remind me: …", "Todo: …" pass; "Q4: …", "request: …", "password: …" and a second key
 * ("Todo: request: …") stay refused. No word is added for this.
 */
function isNlActionColonLabel(label: string): boolean {
  if (!LATIN_LABEL.test(label)) return false;
  const words = label.trim().toLowerCase().replace(/(?<=[a-z0-9])-(?=[a-z0-9])/gu, '').split(/\s+/u);
  while (words.length > 1 && NL_EN_REQUEST_LEADS.has(words[0] ?? '')) words.shift();
  const head = words.join(' ');
  return nlActionLabelWords().some((word) => head === word || head.startsWith(`${word} `));
}

let actionLabelWords: readonly string[] | undefined;
/** The catalog's own Latin words for the LOCAL_WRITE actions and the local lists (built on first use). */
function nlActionLabelWords(): readonly string[] {
  actionLabelWords ??= [
    ...new Set(
      [
        ...Object.values(NL_ACTION_ENTRIES).flatMap((entry) => (entry !== undefined && entry.risk === 'LOCAL_WRITE' ? [...(entry.actionGrounding ?? []), ...entry.aliases] : [])),
        ...NL_WAVE1_ENTRIES['todo.list'].aliases,
        ...NL_WAVE1_ENTRIES['reminder.list'].aliases,
      ]
        .map((word) => word.toLowerCase().replace(/-/gu, ''))
        .filter((word) => /^[a-z][a-z ]*$/u.test(word)),
    ),
  ];
  return actionLabelWords;
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
  if (quoted || LINE_SEPARATOR.test(rawText) || LINE_SEPARATOR.test(folded) || hasStructureMarker(text, true) || hasStructureMarker(folded, true)) return 'not-plain';
  if (HANGUL_SPEAKER_LABEL.test(text) || HANGUL_SPEAKER_LABEL.test(folded)) return 'not-plain';
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

// ── A6 R5a: deictic writes (owner decisions 1a–9 of 2026-10-16) ─────────────────────────────────────────────────────

/**
 * §1.4 step 4, a closed VALUE class (a validator, never a router): the words that say whose earlier text a deictic means.
 * First person plus a speech verb ("내가 말한 거", "what I said") is the owner's own message; a second-person or answer word
 * ("네가 추천한 거", "답변", "your answer") is a Quoky answer, which R5a refuses (`model-drafted`, decision 1b deferred).
 */
const OWNER_ORIGIN_KO = /(?<=^|\s)(?:내가|제가|나|저)\s*(?:아까\s*|방금\s*)?(?:말한|말했던|보낸|보냈던|쓴|썼던|적은|적었던)/u;
const OWNER_ORIGIN_EN = /\b(?:what\s+i\s+(?:said|wrote|sent|typed)|my\s+(?:last\s+)?message)\b/u;
const ASSISTANT_ORIGIN_KO = /(?<=^|\s)(?:네가|니가|너가|당신이|쿼키가)\s*(?:아까\s*|방금\s*)?(?:말한|말해\s?준|알려\s?준|추천한|추천해\s?준|제안한|정리해\s?준|써\s?준)|(?:네|니|그|이|방금|아까)?\s*(?:답변|대답|추천)(?:한|해\s?준)?/u;
const ASSISTANT_ORIGIN_EN = /\b(?:your\s+(?:answer|reply|suggestion|recommendation)|what\s+you\s+(?:said|wrote|suggested|recommended))\b/u;

/** Whose earlier text the owner's words name: `owner`, `assistant` (both: `assistant`, fail closed), or `undefined`. */
export function nlDeicticOriginOf(groundingText: string): 'owner' | 'assistant' | undefined {
  const text = normalizeForMatch(groundingText);
  if (ASSISTANT_ORIGIN_KO.test(text) || ASSISTANT_ORIGIN_EN.test(text)) return 'assistant';
  if (OWNER_ORIGIN_KO.test(text) || OWNER_ORIGIN_EN.test(text)) return 'owner';
  return undefined;
}

/** `text` with every origin phrase removed (a payload span "내가 말한 거" is then only a deictic). */
export function withoutNlOriginPhrases(text: string): string {
  const flags = 'gu';
  return normalizeForMatch(text)
    .replace(new RegExp(ASSISTANT_ORIGIN_KO.source, flags), ' ')
    .replace(new RegExp(ASSISTANT_ORIGIN_EN.source, flags), ' ')
    .replace(new RegExp(OWNER_ORIGIN_KO.source, flags), ' ')
    .replace(new RegExp(OWNER_ORIGIN_EN.source, flags), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A6 R5a, the `NlValidationContext.requestFrame` hook (A6-D3a amendment 1, CA review (c)): the owner's prose with every
 * origin phrase blanked, case and spacing kept so content spans still match the rest of the prose. "내가 말한 거 할 일로
 * 추가해줘" would otherwise be read as first-person volition, "아까 내가 보냈던 거 …" as a past statement; the phrase names
 * WHOSE text, never what the sentence does. Every other veto still reads the remaining frame.
 */
export function nlOriginRequestFrame(prose: string): string {
  const flags = 'giu';
  return prose
    .normalize('NFC')
    .replace(new RegExp(ASSISTANT_ORIGIN_KO.source, flags), ' ')
    .replace(new RegExp(ASSISTANT_ORIGIN_EN.source, flags), ' ')
    .replace(new RegExp(OWNER_ORIGIN_KO.source, flags), ' ')
    .replace(new RegExp(OWNER_ORIGIN_EN.source, flags), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether `text` holds an invisible, bidi, format or control character or a line break (§1.3 rule 6), checked on the RAW
 * text BEFORE any normalisation and with no emoji exemption (fail closed): `normalizeWorkItemTitle` would strip some of
 * them silently, so the previewed text could differ from what the owner sees.
 */
export function nlHasInvisibleCharacters(text: string): boolean {
  return HIDDEN.test(text) || HIDDEN.test(text.normalize('NFKC')) || LINE_SEPARATOR.test(text);
}

/** Why an owner message can never be a referent (§1.2), from its text alone; `undefined` when the text is eligible. */
export type NlOwnerTextIneligibility = 'multiline' | 'quoted' | 'fenced' | 'invisible' | 'command' | 'deictic' | 'credential';

/**
 * §1.2 owner-message eligibility, the text-intrinsic part (fail closed). One plain line with no `>` quote, fence or other
 * structure marker, no invisible / bidi / control character, no credential material, no anchored Class A command form, and
 * no deictic or determiner reference of its own ("그거 할 일로 추가해줘" never becomes the text of a later "그거").
 */
export function nlOwnerTextIneligibility(rawText: string, containsCredential: (text: string) => boolean): NlOwnerTextIneligibility | undefined {
  const text = rawText.normalize('NFC');
  const folded = rawText.normalize('NFKC');
  if (LINE_SEPARATOR.test(rawText) || LINE_SEPARATOR.test(folded)) return 'multiline';
  if (HIDDEN.test(text) || HIDDEN.test(folded) || /^[^\S ]|[^\S ]$/u.test(text)) return 'invisible';
  if (/^\s*>/u.test(text) || /^\s*>/u.test(folded)) return 'quoted';
  if (/```|~~~|`/u.test(folded) || hasStructureMarker(text) || hasStructureMarker(folded)) return 'fenced';
  if (COMMAND_FORMS.some((form) => form.test(folded))) return 'command';
  if (containsCredential(text)) return 'credential';
  if (hasNlDeictic(text) || hasNlDeterminerReference(text) || nlDeicticOriginOf(text) !== undefined) return 'deictic';
  return undefined;
}
