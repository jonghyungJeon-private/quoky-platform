import type { NlActionEntryId, NlAmbiguityKey, NlArgs, NlCatalogEntry, NlEntryCheckFailure } from './catalog';
import { normalizeForMatch } from './selection-input';
import { isNlTimeWord } from './symbolic-time';
import { ANCHORED_TODO_PREFIX_HEADS } from '../reminders/reminder-grammar';

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
/** `last` needs one of these. */
const LAST_KO = ['마지막'];
const LAST_EN = ['last', 'the last one'];

const KO_ORDINALS: readonly string[] = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
const EN_ORDINALS: readonly string[] = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const KO_ORDINAL_PATTERN = /(첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:번\s*)?째/gu;
const EN_ORDINAL_PATTERN = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|(\d{1,2})(?:st|nd|rd|th))\b/giu;

function latinWordIn(text: string, word: string): boolean {
  const escaped = word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s+');
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

/** A6-D2 grounding of a `ref`: `#n` needs that numeral or ordinal; `recent`/`this` a deictic; `last` 마지막/last. */
export function isNlRefGrounded(ref: NlRef, groundingText: string): boolean {
  switch (ref.kind) {
    case 'index':
      return nlIndexWording(ref.index, groundingText) !== undefined;
    case 'recent':
    case 'this':
      return hasNlDeictic(groundingText);
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
/** Particles glued on a deictic, filler or time word. */
const PARTICLE_TAIL = /(?:으로|에서|까지|부터|에는|이랑|하고|은|는|이|가|을|를|에|의|도|만|로|랑|요)$/u;

function contentTokens(span: string): string[] {
  let text = normalizeForMatch(span);
  text = text.replace(KO_ORDINAL_PATTERN, ' ').replace(EN_ORDINAL_PATTERN, ' ');
  text = text.replace(/#?\d+\s*번\s*째?/gu, ' ');
  for (const word of [...DEICTIC_KO, ...LAST_KO].sort((a, b) => b.length - a.length)) text = text.split(word).join(' ');
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

/** A6-D3: a payload made only of deictic, ordinal, number or time words ("그거", "첫 번째 거", "내일"). */
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
    const bare = token.replace(PARTICLE_TAIL, '');
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
  'The item: "#N" for a number or ordinal the owner wrote (3번 / 세 번째 -> "#3"); "recent" or "this" for 그거/이거/방금/아까/it/that; "last" for 마지막/the last one. Never an id or a title.';

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

const todoAdd: NlCatalogEntry = {
  id: 'todo.add',
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
      description: 'Only the time words, verbatim ("내일 9시", "매일 아침 8시", "30분 뒤"). Never compute a date.',
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

/** Format, zero-width, bidi, variation-selector and line/paragraph-separator characters: never in an action request. */
const HIDDEN = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2028\u2029\u3164\uFE00-\uFE0F\uFFA0]|[\u{E0100}-\u{E01EF}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The closed Class A command forms with a colon head (the ADR-0100 D1 heads, a connector-write head) and the write
 * execution phrase: never inside a natural-language request. (A reminder number with 취소 is an ordinary request.)
 */
const COMMAND_FORMS: readonly RegExp[] = [
  new RegExp(`(?:${ANCHORED_TODO_PREFIX_HEADS.map(escapeRegExp).join('|')})\\s*[:：]`, 'giu'),
  /[#＃][\p{L}\p{N}_-]+\s*(?:채널)?\s*에\s*(?:게시|올려|보내)\s*[:：]/gu,
  /(?:Slack|슬랙)\s*게시\s*실행/gu,
];

export type NlActionInputRefusal = 'too-long' | 'hidden-characters' | 'embedded-command';

/**
 * A6 refuses to act on a message (before any validation) when:
 *  - it is longer than {@link NL_ACTION_MAX_INPUT_CHARS} (a long paste is not one instruction);
 *  - it carries hidden characters (format, zero-width, bidi, variation selectors, separators, controls), which can make
 *    what the owner sees differ from what is parsed;
 *  - it contains a Class A command form anywhere (the exact commands are sent alone and run by their own grammar; one
 *    inside a request, quoted, pasted or glued to other text, or a look-alike the grammar did not accept, is material,
 *    not an instruction).
 * These are value checks over closed sets (the existing command heads); nothing here routes a message.
 */
export function nlActionInputRefusal(rawText: string, groundingText: string): NlActionInputRefusal | undefined {
  if (Array.from(rawText).length > NL_ACTION_MAX_INPUT_CHARS) return 'too-long';
  if (HIDDEN.test(rawText)) return 'hidden-characters';
  const folded = groundingText.normalize('NFKC');
  for (const form of COMMAND_FORMS) {
    form.lastIndex = 0;
    if (form.test(folded)) return 'embedded-command';
  }
  return undefined;
}

/** A span that occurs only inside a bracketed structure (`{…}`, `[…]`) of the message is data, not the owner's prose. */
export function isNlSpanInsideStructure(span: string, groundingText: string): boolean {
  const text = groundingText.normalize('NFC').replace(/\s+/g, ' ');
  // Innermost brackets first, until stable, so nested structures (JSON) are removed whole.
  let outside = text;
  for (let round = 0; round < 8; round += 1) {
    const next = outside.replace(/\{[^{}]*\}|\[[^[\]]*\]/gu, ' ');
    if (next === outside) break;
    outside = next;
  }
  return text.includes(span) && !outside.replace(/\s+/g, ' ').includes(span);
}
