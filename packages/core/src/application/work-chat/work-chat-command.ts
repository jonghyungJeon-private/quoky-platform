import { IntentType, ResourceRef } from '../../domain';
import type { Intent } from '../../domain';
import { CONNECTOR_SEARCH_TEXT_MAX_LENGTH } from '../../ports';
import { unnegatedMatch } from '../intent-negation';

/**
 * Deterministic KO/EN work-chat grammar (ADR-0100 D1/D6). Pure: no clock, id, IO, connector or model call.
 *
 * `detectWorkChatCommand(text)` returns a typed `WorkChatCommand` or `null` (not a work-chat message; the turn falls
 * through unchanged). Two families exist:
 *
 * - **Anchored to-do commands** start with one head of the closed ADR-0100 D1 list followed by optional whitespace and
 *   `:` / `：`. They are recognized before any reminder exclusion: the text after an add head is the WorkItem title
 *   verbatim even when it contains a time phrase or `알려줘`. The list is owned here; the ADR-0101 grammar mirrors it.
 * - **Unanchored phrases** (to-do list, `N번 완료 처리`, `할 일 N번에 Jira KEY-1 연결`, connector lookups, external
 *   write requests) are negation-aware and conservative: an unanchored message with an explicit time expression bound
 *   by `에` / `뒤에` / `후에` plus `알려줘` belongs to ADR-0101 and is never claimed, nor is anything that names a
 *   reminder (`리마인드`, `remind`).
 *
 * The unanchored to-do list phrases are a superset of `IntentClassifier.isPersonalWorkSurface`.
 *
 * Explicit links only (D6): a Jira browse URL or `Jira|지라 KEY-123` becomes `jira:KEY-123`; a GitHub issue/PR URL or
 * `owner/repo#123` becomes `github:owner/repo#123`. A bare `ABC-123` is never linked.
 */

/** `Intent.raw.kind` of a work-chat intent (ADR-0100). */
export const WORK_CHAT_INTENT_KIND = 'work-chat';
/** `Intent.raw.kind` of the legacy classifier branch that `workChatCommandFromIntent` maps to `todo.list`. */
export const LEGACY_PERSONAL_WORK_SURFACE_KIND = 'personal-work-surface';

export const WORK_CHAT_SOURCES = ['jira', 'github', 'slack', 'confluence'] as const;
export type WorkChatSource = (typeof WORK_CHAT_SOURCES)[number];

export const WORK_CHAT_LOOKUP_QUERIES = ['my-items', 'due-this-week', 'review-requests', 'search'] as const;
export type WorkChatLookupQuery = (typeof WORK_CHAT_LOOKUP_QUERIES)[number];

/**
 * Which named queries each source supports (ADR-0100 D7): Jira and GitHub answer `personal-work` (Jira
 * `all`/`due-this-week`, GitHub `all`/`review-requested`); Slack and Confluence answer `search` only. A combination
 * outside this table is answered without a connector call.
 */
export const WORK_CHAT_SOURCE_QUERIES: Readonly<Record<WorkChatSource, readonly WorkChatLookupQuery[]>> = {
  jira: ['my-items', 'due-this-week'],
  github: ['my-items', 'review-requests'],
  slack: ['search'],
  confluence: ['search'],
};

/** Search text bound (same as the connector port); longer text is a usage hint, never truncated silently. */
export const WORK_CHAT_SEARCH_TEXT_MAX_LENGTH = CONNECTOR_SEARCH_TEXT_MAX_LENGTH;

/** A list number (1-based, `createdAt` ascending among ACTIVE to-dos) or a title fragment. */
export type WorkChatTarget = { readonly index: number } | { readonly text: string };

export type WorkChatUsageTopic =
  | 'todo-add'
  | 'todo-complete'
  | 'todo-cancel'
  | 'todo-link'
  | 'search'
  | 'search-too-long';

export type WorkChatCommand =
  | { readonly kind: 'todo.add'; readonly title: string; readonly refs: readonly ResourceRef[] }
  | { readonly kind: 'todo.list' }
  | { readonly kind: 'todo.complete'; readonly target: WorkChatTarget }
  | { readonly kind: 'todo.cancel'; readonly target: WorkChatTarget }
  | { readonly kind: 'todo.link'; readonly target: WorkChatTarget; readonly refs: readonly ResourceRef[] }
  | {
      readonly kind: 'lookup';
      readonly source: WorkChatSource;
      readonly query: WorkChatLookupQuery;
      /** Present only for `search`: 1..100 characters, whitespace collapsed. */
      readonly text?: string;
    }
  | { readonly kind: 'external-write-unsupported'; readonly source: WorkChatSource }
  | { readonly kind: 'usage'; readonly topic: WorkChatUsageTopic };

/**
 * Which ADR-0100 D2 handler owns a command: `mutation` (order 100: to-do add/complete/cancel/link and their usage
 * hints) or `lookup` (order 300: the list, connector lookups, the write refusal and the search usage hints).
 *
 * Decision (WORK-T3 review): the unanchored numbered forms (`2번 완료 처리해줘`, `할 일 2번 취소해줘`,
 * `할 일 2번에 Jira PROJ-1 연결`) are also `mutation` and so run at order 100, ahead of reminders. They match the whole
 * message (a leading number or `할 일 N번`), are negation-aware, and no reminder grammar claims them. The closed
 * ADR-0100 D1 prefix list (`startsWithWorkChatAnchoredPrefix`) is the only set that bypasses reminder exclusions.
 */
export type WorkChatMode = 'mutation' | 'lookup';

export function workChatCommandMode(command: WorkChatCommand): WorkChatMode {
  switch (command.kind) {
    case 'todo.add':
    case 'todo.complete':
    case 'todo.cancel':
    case 'todo.link':
      return 'mutation';
    case 'usage':
      return command.topic.startsWith('todo-') ? 'mutation' : 'lookup';
    default:
      return 'lookup';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Anchored to-do prefixes (ADR-0100 D1 closed list)
// ---------------------------------------------------------------------------------------------------------------------

type AnchoredKind = 'add' | 'complete' | 'cancel' | 'link';

const ANCHORED_HEADS_BY_KIND: Readonly<Record<AnchoredKind, readonly string[]>> = {
  add: ['할 일 추가', '할일 추가', '할 일 등록', '할일 등록', 'todo add', 'add todo', 'to-do add'],
  complete: ['완료 처리', '할 일 완료', '할일 완료', 'todo done'],
  cancel: ['할 일 취소', '할일 취소', 'todo cancel'],
  link: ['할 일 연결', '할일 연결', 'todo link'],
};

/** The closed ADR-0100 D1 head list, in add, complete, cancel, link order. */
export const WORK_CHAT_ANCHORED_TODO_HEADS: readonly string[] = [
  ...ANCHORED_HEADS_BY_KIND.add,
  ...ANCHORED_HEADS_BY_KIND.complete,
  ...ANCHORED_HEADS_BY_KIND.cancel,
  ...ANCHORED_HEADS_BY_KIND.link,
];

const KIND_BY_HEAD = new Map<string, AnchoredKind>(
  (Object.keys(ANCHORED_HEADS_BY_KIND) as AnchoredKind[]).flatMap((kind) =>
    ANCHORED_HEADS_BY_KIND[kind].map((head) => [head.toLowerCase(), kind] as const),
  ),
);

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ANCHORED_PREFIX = new RegExp(
  `^(${WORK_CHAT_ANCHORED_TODO_HEADS.map(escapeRegExp).join('|')})\\s*[:：]`,
  'i',
);

/** Whether the (trimmed) message starts with an anchored to-do prefix of the closed ADR-0100 D1 list. */
export function startsWithWorkChatAnchoredPrefix(text: string): boolean {
  return ANCHORED_PREFIX.test(normalizeInput(text));
}

function normalizeInput(text: string): string {
  return text.normalize('NFC').trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// Explicit ResourceRef extraction (ADR-0100 D6)
// ---------------------------------------------------------------------------------------------------------------------

const JIRA_BROWSE_URL = /https?:\/\/[^\s/<>]+\/browse\/([A-Za-z][A-Za-z0-9_]*-\d{1,9})(?![\w-])/gi;
const GITHUB_ITEM_URL =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/(?:issues|pull)\/(\d{1,9})(?![\w])/gi;
const JIRA_KEYWORD_KEY = /(?:\bjira|지라)\s*:?\s*([A-Za-z][A-Za-z0-9_]{1,19}-\d{1,9})(?![\w-])/gi;
const GITHUB_SHORT_REF = /(?<![\w./@#-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})#(\d{1,9})(?!\w)/g;

interface ExtractedRefs {
  readonly refs: readonly ResourceRef[];
  /** The input with every recognized reference blanked out (used to find a link target). */
  readonly rest: string;
}

/** Explicit forms only; the first occurrence of an identity wins, in order of appearance. */
export function extractExplicitResourceRefs(text: string): ExtractedRefs {
  const found: Array<{ index: number; ref: ResourceRef }> = [];
  let working = text;
  const scan = (pattern: RegExp, toRef: (match: RegExpMatchArray) => ResourceRef): void => {
    let blanked = working;
    for (const match of working.matchAll(pattern)) {
      const index = match.index ?? 0;
      found.push({ index, ref: toRef(match) });
      blanked = blanked.slice(0, index) + ' '.repeat(match[0].length) + blanked.slice(index + match[0].length);
    }
    working = blanked;
  };
  scan(JIRA_BROWSE_URL, (m) => jiraRef(m[1] as string));
  scan(GITHUB_ITEM_URL, (m) => githubRef(m[1] as string, m[2] as string, m[3] as string));
  scan(JIRA_KEYWORD_KEY, (m) => jiraRef(m[1] as string));
  scan(GITHUB_SHORT_REF, (m) => githubRef(m[1] as string, m[2] as string, m[3] as string));
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const refs: ResourceRef[] = [];
  for (const { ref } of found) {
    if (seen.has(ref.identity)) continue;
    seen.add(ref.identity);
    refs.push(ref);
  }
  return { refs, rest: working };
}

function jiraRef(key: string): ResourceRef {
  return new ResourceRef({ source: 'jira', externalId: key.toUpperCase() });
}

function githubRef(owner: string, repo: string, number: string): ResourceRef {
  return new ResourceRef({ source: 'github', externalId: `${owner}/${repo}#${Number(number)}` });
}

// ---------------------------------------------------------------------------------------------------------------------
// Anchored commands
// ---------------------------------------------------------------------------------------------------------------------

const INDEX_TARGET = /^#?(\d{1,6})\s*(?:번(?:째)?)?\s*(?:에|에게|과|와)?$/;

function parseTarget(raw: string): WorkChatTarget | null {
  const body = raw.replace(/^[\s,]+|[\s,]+$/g, '');
  if (body.length === 0) return null;
  const index = INDEX_TARGET.exec(body);
  if (index) return { index: Number(index[1]) };
  return { text: body.replace(/\s+/g, ' ') };
}

function detectAnchored(text: string): WorkChatCommand | null {
  const match = ANCHORED_PREFIX.exec(text);
  if (!match) return null;
  const kind = KIND_BY_HEAD.get((match[1] as string).toLowerCase());
  if (!kind) return null;
  const body = text.slice(match[0].length).trim();
  switch (kind) {
    case 'add':
      // The body is the title verbatim (D1); the service applies the D4/D5 bounds and refusals.
      return { kind: 'todo.add', title: body, refs: extractExplicitResourceRefs(body).refs };
    case 'complete':
    case 'cancel': {
      const target = parseTarget(body);
      if (!target) return { kind: 'usage', topic: kind === 'complete' ? 'todo-complete' : 'todo-cancel' };
      return kind === 'complete' ? { kind: 'todo.complete', target } : { kind: 'todo.cancel', target };
    }
    case 'link': {
      const { refs, rest } = extractExplicitResourceRefs(body);
      const target = parseTarget(rest);
      if (!target || refs.length === 0) return { kind: 'usage', topic: 'todo-link' };
      return { kind: 'todo.link', target, refs };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Unanchored phrases
// ---------------------------------------------------------------------------------------------------------------------

/** Longer messages are pasted content, not a command. */
const MAX_UNANCHORED_LENGTH = 300;

const SOURCE_PATTERNS: ReadonlyArray<readonly [WorkChatSource, RegExp]> = [
  ['jira', /\bjira\b|지라/i],
  ['github', /\bgit\s?hub\b|깃\s?허브|깃헙/i],
  ['slack', /\bslack\b|슬랙/i],
  ['confluence', /\bconfluence\b|컨플루언스|컨플루엔스/i],
];

function detectSources(text: string): WorkChatSource[] {
  return SOURCE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([source]) => source);
}

const SOURCE_ALTERNATION =
  '(?:jira|지라|git\\s?hub|깃\\s?허브|깃헙|slack|슬랙|confluence|컨플루언스|컨플루엔스)';

function sourceOf(token: string): WorkChatSource | undefined {
  return SOURCE_PATTERNS.find(([, pattern]) => pattern.test(token))?.[0];
}

/** Reminder-shaped messages belong to ADR-0101. */
const REMINDER_SIGNAL = /리마인드|\bremind(?:er)?s?\b/i;
const TELL_VERB = /알려\s*(?:줘|주세요|줄래|줄\s*수)|말해\s*줘/;
const TIME_BOUND_BY_EO = new RegExp(
  [
    '(?:오전|오후|아침|저녁|밤|새벽)?\\s*\\d{1,2}\\s*시(?:\\s*(?:\\d{1,2}\\s*분|반))?\\s*에',
    '\\d{1,2}:\\d{2}\\s*에',
    '\\d+\\s*(?:초|분|시간|일|주|개월|달)\\s*(?:뒤|후)\\s*에',
    '(?:뒤|후)에',
  ].join('|'),
);

function isReminderShaped(text: string): boolean {
  if (REMINDER_SIGNAL.test(text)) return true;
  return TELL_VERB.test(text) && TIME_BOUND_BY_EO.test(text);
}

/** First match of `pattern` (global copy) that is not under a negation marker in its clause. */
function unnegatedExec(text: string, pattern: RegExp): RegExpExecArray | null {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  if (!unnegatedMatch(text, [re])) return null;
  re.lastIndex = 0;
  return re.exec(text);
}

const REQUEST_VERB =
  /보여|알려|조회|확인|보기|목록|리스트|뭐\s*(?:가|있|야)|있어\s*\??|\bshow\b|\blist\b|\bwhat(?:'s|\s+is|\s+are)?\b|\bdisplay\b|\bcheck\b/i;

const END = '\\s*[.!?~]*$';

// -- to-do list ------------------------------------------------------------------------------------------------------

const LIST_VERBS =
  '(?:보여\\s*줘|보여\\s*주세요|보여\\s*줄래|알려\\s*줘|알려\\s*주세요|알려\\s*줄래|보기|확인(?:해\\s*줘)?|조회(?:해\\s*줘)?|뭐야|뭐지|뭐가\\s*있어|뭐\\s*있어|있어)';
const TODO_NOUN = '(?:할\\s*일|할일|투두|to-?do)s?';
const LIST_WITH_NOUN = new RegExp(
  `^(?:내|나의|오늘|지금|현재|전체)?\\s*${TODO_NOUN}\\s*(?:목록|리스트|list)\\s*(?:을|를|좀)?\\s*${LIST_VERBS}?${END}`,
  'i',
);
const LIST_WITH_VERB = new RegExp(
  `^(?:내|나의|오늘|지금|현재|전체)?\\s*${TODO_NOUN}\\s*(?:을|를|좀)?\\s*${LIST_VERBS}${END}`,
  'i',
);
/** Verbatim copy of `IntentClassifier.isPersonalWorkSurface` so the detector is a superset of it. */
const LEGACY_PERSONAL_WORK_SURFACE =
  /(?:내가|제가|나는)?\s*(?:해야\s*할|할)\s*(?:일|작업).*(?:보여|알려)|(?:show|list|what(?:'s| is))\b.*\b(?:my|i need to)\b.*\bwork\b/i;
const LIST_MY_WORK_KO = new RegExp(
  `(?:내|나의)\\s*(?:업무|작업)\\s*(?:목록|리스트)?\\s*(?:을|를)?\\s*${LIST_VERBS}`,
);
const LIST_EN =
  /\b(?:show|list|display|what(?:'s|\s+is|\s+are))\b.*\b(?:my|i need to)\b.*\b(?:work|to-?dos?|tasks?)\b|^(?:my\s+)?(?:to-?do|todo)s?(?:\s+list)?\s*[.!?]*$/i;

/** A negation marker anywhere in the message: negation only removes a trigger, it never creates one. */
function isNegatedMessage(text: string): boolean {
  return !unnegatedMatch(text, [/^[\s\S]+$/]);
}

function isTodoList(text: string): boolean {
  if (isNegatedMessage(text)) return false;
  return [LIST_WITH_NOUN, LIST_WITH_VERB, LEGACY_PERSONAL_WORK_SURFACE, LIST_MY_WORK_KO, LIST_EN].some((pattern) =>
    pattern.test(text),
  );
}

// -- N번 complete / cancel / link --------------------------------------------------------------------------------------

const POLITE_TAIL = '(?:해\\s*줘|해\\s*주세요|해\\s*줄래|해줘요|해요|해|할래|하자|해라|하기)?';
const COMPLETE_BY_NUMBER = new RegExp(
  `^(?:할\\s*일\\s*)?#?(\\d{1,6})\\s*번(?:째)?\\s*(?:할\\s*일\\s*)?(?:을|를|은|는)?\\s*완료\\s*(?:처리)?\\s*${POLITE_TAIL}${END}`,
);
const CANCEL_BY_NUMBER = new RegExp(
  `^(?:할\\s*일\\s*#?(\\d{1,6})\\s*번(?:째)?|#?(\\d{1,6})\\s*번(?:째)?\\s*할\\s*일)\\s*(?:을|를|은|는)?\\s*취소\\s*(?:처리)?\\s*${POLITE_TAIL}${END}`,
);
const COMPLETE_BY_NUMBER_EN =
  /^(?:mark\s+)?(?:to-?do|task)\s*#?(\d{1,6})\s*(?:as\s+)?(?:done|complete|completed)[.!]*$|^(?:done|complete)\s+(?:to-?do|task)\s*#?(\d{1,6})[.!]*$/i;
const CANCEL_BY_NUMBER_EN =
  /^(?:mark\s+)?(?:to-?do|task)\s*#?(\d{1,6})\s*(?:as\s+)?(?:canceled|cancelled|cancel)[.!]*$|^cancel\s+(?:to-?do|task)\s*#?(\d{1,6})[.!]*$/i;
const LINK_BY_NUMBER = new RegExp(
  `^(?:할\\s*일\\s*#?(\\d{1,6})\\s*번(?:째)?|#?(\\d{1,6})\\s*번(?:째)?\\s*할\\s*일)\\s*(?:에|과|와)\\s*(.+?)\\s*(?:을|를)?\\s*(?:연결|링크|붙여)\\s*(?:해\\s*줘|해\\s*주세요|해\\s*줄래|해|하기|줘|주세요)?${END}`,
);

function firstNumber(match: RegExpExecArray): number {
  return Number(match.slice(1).find((group) => group !== undefined && /^\d+$/.test(group)));
}

function detectNumbered(text: string): WorkChatCommand | null {
  const complete = unnegatedExec(text, COMPLETE_BY_NUMBER) ?? unnegatedExec(text, COMPLETE_BY_NUMBER_EN);
  if (complete) return { kind: 'todo.complete', target: { index: firstNumber(complete) } };
  const cancel = unnegatedExec(text, CANCEL_BY_NUMBER) ?? unnegatedExec(text, CANCEL_BY_NUMBER_EN);
  if (cancel) return { kind: 'todo.cancel', target: { index: firstNumber(cancel) } };
  const link = unnegatedExec(text, LINK_BY_NUMBER);
  if (link) {
    const refs = extractExplicitResourceRefs(link[3] as string).refs;
    if (refs.length === 0) return { kind: 'usage', topic: 'todo-link' };
    return { kind: 'todo.link', target: { index: firstNumber(link) }, refs };
  }
  return null;
}

// -- connector search ------------------------------------------------------------------------------------------------

const SEARCH_VERB = '(?:검색|찾아|찾기|서치)';
const SEARCH_TAIL = `\\s*(?:해\\s*줘|해\\s*주세요|해\\s*봐|봐\\s*줘|줘|주세요|줄래|해|해라|하기)?${END}`;
const SEARCH_KO_SOURCE_FIRST = new RegExp(
  `^(${SOURCE_ALTERNATION})\\s*(?:에서의|에서|내에서|에)\\s*(.*?)\\s*(?:을|를|좀)?\\s*${SEARCH_VERB}${SEARCH_TAIL}`,
  'i',
);
const SEARCH_KO_TEXT_FIRST = new RegExp(
  `^(.+?)\\s*(?:을|를)?\\s*(${SOURCE_ALTERNATION})\\s*(?:에서의|에서|내에서|에)\\s*${SEARCH_VERB}${SEARCH_TAIL}`,
  'i',
);
const SEARCH_EN_SOURCE_FIRST = new RegExp(
  `^(?:please\\s+)?(?:search|find|look\\s*up)\\s+(?:(?:in|on)\\s+)?(${SOURCE_ALTERNATION})\\s+(?:for\\s+)?(.*?)${END}`,
  'i',
);
const SEARCH_EN_TEXT_FIRST = new RegExp(
  `^(?:please\\s+)?(?:search|find|look\\s*up)\\s+(?:for\\s+)?(.+?)\\s+(?:in|on)\\s+(${SOURCE_ALTERNATION})${END}`,
  'i',
);

const QUOTE_EDGES = /^["'“”‘’「」『』`]+|["'“”‘’「」『』`]+$/g;

function cleanSearchText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(QUOTE_EDGES, '').trim();
}

function searchCommand(sourceToken: string, rawText: string): WorkChatCommand | null {
  const source = sourceOf(sourceToken);
  if (!source) return null;
  const text = cleanSearchText(rawText);
  if (text.length === 0) return { kind: 'usage', topic: 'search' };
  if (Array.from(text).length > WORK_CHAT_SEARCH_TEXT_MAX_LENGTH) return { kind: 'usage', topic: 'search-too-long' };
  return { kind: 'lookup', source, query: 'search', text };
}

function detectSearch(text: string): WorkChatCommand | null {
  const sourceFirst = unnegatedExec(text, SEARCH_KO_SOURCE_FIRST);
  if (sourceFirst) return searchCommand(sourceFirst[1] as string, sourceFirst[2] as string);
  const textFirst = unnegatedExec(text, SEARCH_KO_TEXT_FIRST);
  if (textFirst) return searchCommand(textFirst[2] as string, textFirst[1] as string);
  const enSourceFirst = unnegatedExec(text, SEARCH_EN_SOURCE_FIRST);
  if (enSourceFirst) return searchCommand(enSourceFirst[1] as string, enSourceFirst[2] as string);
  const enTextFirst = unnegatedExec(text, SEARCH_EN_TEXT_FIRST);
  if (enTextFirst) return searchCommand(enTextFirst[2] as string, enTextFirst[1] as string);
  return null;
}

// -- connector writes (fixed refusal) -------------------------------------------------------------------------------------

const WRITE_VERB_KO =
  '(?:만들어|만들|생성|작성|등록|추가|수정|업데이트|변경|삭제|지워|지우|닫아|닫|종료|할당|배정|보내|올려|올리|게시|전송|달아|남겨|써|넘겨|병합|머지|코멘트|댓글)';
const WRITE_ENDING_KO =
  '(?:해\\s*줘|해\\s*주세요|해\\s*줄래(?:요)?|해줘요|해라|하세요|해요|해|줘|주세요|줄래(?:요)?|주라|봐|라)';
const EXTERNAL_WRITE_KO = new RegExp(`${WRITE_VERB_KO}\\s*${WRITE_ENDING_KO}\\s*[.!?~]*$`);
const EXTERNAL_WRITE_EN =
  /^(?:please\s+|pls\s+|can\s+you\s+|could\s+you\s+)?(?:create|open|file|raise|update|edit|delete|close|reopen|comment|reply|post|send|assign|transition|merge|resolve)\b(?!\s+me\b)/i;
const TODO_WORD = /할\s*일|할일|투두|to-?do/i;

/**
 * A source counts for the write refusal only when it stands alone as a word: `slack.ts`, `connector-jira`,
 * `github-app-git-provider.ts` and `.github/` name files and packages of this repository, not the external system.
 */
const STANDALONE_SOURCE_PATTERNS: ReadonlyArray<readonly [WorkChatSource, RegExp]> = [
  ['jira', /(?<![\w./-])(?:jira|지라)(?![\w/-]|\.\w)/i],
  ['github', /(?<![\w./-])(?:git\s?hub|깃\s?허브|깃헙)(?![\w/-]|\.\w)/i],
  ['slack', /(?<![\w./-])(?:slack|슬랙)(?![\w/-]|\.\w)/i],
  ['confluence', /(?<![\w./-])(?:confluence|컨플루언스|컨플루엔스)(?![\w/-]|\.\w)/i],
];

/** The source followed by a locative particle: `Jira에`, `깃허브에서`, or `to|in|on Slack`. */
const SOURCE_LOCATIVE_KO =
  /(?<![\w./-])(?:jira|지라|git\s?hub|깃\s?허브|깃헙|slack|슬랙|confluence|컨플루언스|컨플루엔스)\s*(?:에게|에서|에|으로|로)(?![가-힣])/i;
const SOURCE_LOCATIVE_EN = /\b(?:to|in|on|into)\s+(?:the\s+)?(?:jira|git\s?hub|slack|confluence)(?![\w/.-])/i;

/** Items that live in the external system (a write to one of them is a connector write). */
const EXTERNAL_OBJECT =
  /이슈|티켓|풀\s*리퀘(?:스트)?|\bPRs?\b|댓글|코멘트|메시지|메세지|채널|스레드|에픽|스프린트|\bissues?\b|\btickets?\b|\bcomments?\b|\bmessages?\b|\bpull\s*requests?\b|\bthreads?\b|\bchannels?\b|\bepics?\b|\bsprints?\b/i;
/** Pages and documents are external objects only for Confluence. */
const CONFLUENCE_OBJECT = /페이지|문서|\bpages?\b|\bdocs?\b|\bdocuments?\b/i;

/**
 * Code or file work on this repository (the classifier's IMPLEMENT_CODE and file-path heuristics are the reference):
 * a code noun, a file name or extension, or a multi-segment path.
 */
const CODE_WORK_NOUN =
  /코드|파일|함수|테스트|커넥터|어댑터|연동|설정|리드미|README|클래스|모듈|패키지|워크플로|스크립트|라이브러리|기능|구현|리팩터|리팩토|개발|\bcode\b|\bfiles?\b|\bfunctions?\b|\btests?\b|\bconnectors?\b|\badapters?\b|\bconfig(?:uration)?\b|\bworkflows?\b|\bscripts?\b|\bpackages?\b|\bmodules?\b|\bsdk\b|\bimplement\w*|\brefactor\w*/i;
const FILE_NAME =
  /(?:^|[\s"'`(])[\w.-]*\.(?:[cm]?[jt]sx?|json|ya?ml|md|mdx|py|java|kt|go|rs|sh|css|html|sql|toml|lock|env|txt)(?!\w)/i;
const URL_OR_ITEM_REF = /https?:\/\/\S+|[\w.-]+\/[\w.-]+#\d+/gi;
const MULTI_SEGMENT_PATH = /(?:^|[\s"'`(])\.{0,2}\/?[\w@.-]+\/[\w@./-]+/;
const DOT_GITHUB = /(?:^|[\s"'`(])\.github\b/i;

function hasCodeWorkSignal(text: string): boolean {
  if (CODE_WORK_NOUN.test(text)) return true;
  const withoutLinks = text.replace(URL_OR_ITEM_REF, ' ');
  return FILE_NAME.test(withoutLinks) || MULTI_SEGMENT_PATH.test(withoutLinks) || DOT_GITHUB.test(withoutLinks);
}

/** A link to a source names the source (`github.com/o/r/issues/1`), even though its host is not a standalone word. */
const SOURCE_URL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/https?:\/\/(?:www\.)?github\.com\/\S*/gi, ' GitHub '],
  [/https?:\/\/\S*atlassian\.net\/browse\/\S*/gi, ' Jira '],
  [/https?:\/\/\S*atlassian\.net\/wiki\/\S*/gi, ' Confluence '],
  [/https?:\/\/\S*slack\.com\/\S*/gi, ' Slack '],
];

function detectExternalWrite(text: string): WorkChatCommand | null {
  if (TODO_WORD.test(text) || hasCodeWorkSignal(text)) return null;
  const named = SOURCE_URL_WORDS.reduce((acc, [pattern, word]) => acc.replace(pattern, word), text);
  const standalone = STANDALONE_SOURCE_PATTERNS.filter(([, pattern]) => pattern.test(named)).map(([source]) => source);
  const source = standalone[0];
  if (source === undefined) return null;
  const hasObject =
    EXTERNAL_OBJECT.test(named) ||
    (standalone.includes('confluence') && CONFLUENCE_OBJECT.test(named)) ||
    SOURCE_LOCATIVE_KO.test(named) ||
    SOURCE_LOCATIVE_EN.test(named);
  if (!hasObject) return null;
  if (unnegatedExec(text, EXTERNAL_WRITE_KO) || unnegatedExec(text, EXTERNAL_WRITE_EN)) {
    return { kind: 'external-write-unsupported', source };
  }
  return null;
}

// -- connector lookups -----------------------------------------------------------------------------------------------

const OWN_MARKER = /(?:^|\s)(?:내|나의|제|저의)(?=\s|[A-Za-z])|내가\s*(?:맡은|담당|할당)|(?:나|저)에게\s*할당|\bmy\b|\bassigned\s+to\s+me\b/i;
const ITEM_NOUN =
  /이슈|티켓|작업|업무|일|\bPRs?\b|풀\s*리퀘(?:스트)?|\bpull\s*requests?\b|\bissues?\b|\btickets?\b|\btasks?\b|\bwork\b|\bitems?\b/i;
const DUE_THIS_WEEK =
  /(?:이번\s*주|금주|this\s+week)\D{0,12}마감|마감\D{0,8}(?:이번\s*주|금주)|\bdue\b.*\bthis\s+week\b|\bthis\s+week\b.*\bdue\b/i;
const DUE_WHOLE_MESSAGE =
  /^(?:내\s*)?(?:이번\s*주|금주)\s*(?:내\s*)?마감(?:인|되는)?\s*(?:이슈|일|작업|티켓|항목|건|것)?\s*[?.!]*$/;
const REVIEW_REQUEST =
  /리뷰\s*(?:를\s*)?요청(?:된|받은|이\s*들어온|온)?|리뷰\s*대기|review[\s-]*requests?|requested\s+(?:my\s+)?review|review\s+requested/i;

function detectLookup(text: string): WorkChatCommand | null {
  const sources = detectSources(text);
  const hasRequestVerb = unnegatedMatch(text, [REQUEST_VERB]);

  const wholeDue = DUE_WHOLE_MESSAGE.test(text);
  if (unnegatedMatch(text, [DUE_THIS_WEEK, DUE_WHOLE_MESSAGE]) && (hasRequestVerb || wholeDue)) {
    const source = sources.length === 1 ? (sources[0] as WorkChatSource) : sources.length === 0 ? 'jira' : undefined;
    if (source) return { kind: 'lookup', source, query: 'due-this-week' };
  }

  if (REVIEW_REQUEST.test(text) && unnegatedMatch(text, [REVIEW_REQUEST]) && hasRequestVerb) {
    const source = sources.length === 1 ? (sources[0] as WorkChatSource) : sources.length === 0 ? 'github' : undefined;
    if (source) return { kind: 'lookup', source, query: 'review-requests' };
  }

  if (sources.length > 0 && hasRequestVerb && OWN_MARKER.test(text) && ITEM_NOUN.test(text)) {
    if (sources.length === 1) return { kind: 'lookup', source: sources[0] as WorkChatSource, query: 'my-items' };
    // "내 Jira랑 GitHub 이슈" is exactly what the combined my-work view shows.
    if (sources.every((source) => source === 'jira' || source === 'github')) return { kind: 'todo.list' };
  }
  return null;
}

function detectUnanchored(text: string): WorkChatCommand | null {
  if (text.length > MAX_UNANCHORED_LENGTH || isReminderShaped(text)) return null;
  return (
    detectNumbered(text) ??
    detectSearch(text) ??
    detectExternalWrite(text) ??
    detectLookup(text) ??
    (isTodoList(text) ? { kind: 'todo.list' } : null) ??
    detectBareAddUsage(text)
  );
}

const BARE_ADD = new RegExp(`^(?:${TODO_NOUN}\\s*(?:추가|등록)|(?:add|create)\\s+(?:a\\s+)?to-?do)\\s*(?:해\\s*줘|해\\s*주세요|하기)?${END}`, 'i');

function detectBareAddUsage(text: string): WorkChatCommand | null {
  return BARE_ADD.test(text) && !isNegatedMessage(text) ? { kind: 'usage', topic: 'todo-add' } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Detect a work-chat command in one User message, or `null`. Anchored to-do prefixes are tried first and win over every
 * other reading, including reminder phrasing (ADR-0100 D1).
 */
export function detectWorkChatCommand(text: string): WorkChatCommand | null {
  if (typeof text !== 'string') return null;
  const normalized = normalizeInput(text);
  if (normalized.length === 0) return null;
  return detectAnchored(normalized) ?? detectUnanchored(normalized);
}

/**
 * Map a classifier `Intent` to a work-chat command, validating `intent.raw`: the legacy `personal-work-surface` kind
 * is the combined list; a `work-chat` kind carries the original message text in `raw.text` and is re-detected.
 * Anything else (or a malformed `raw`) is `null`.
 */
export function workChatCommandFromIntent(intent: Intent): WorkChatCommand | null {
  if (intent.type !== IntentType.LOOKUP) return null;
  const raw = intent.raw;
  if (raw === null || typeof raw !== 'object') return null;
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === LEGACY_PERSONAL_WORK_SURFACE_KIND) return { kind: 'todo.list' };
  if (kind === WORK_CHAT_INTENT_KIND) {
    const text = (raw as Record<string, unknown>).text;
    return typeof text === 'string' ? detectWorkChatCommand(text) : null;
  }
  return null;
}
