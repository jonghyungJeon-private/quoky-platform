/**
 * Help-intent grammar (ADR-0104 D4, amends ADR-0096 D5 and notes ADR-0093). Pure and deterministic: no provider, no
 * storage, no clock.
 *
 * A message is a help intent only when it has BOTH
 *  - a how-to shape about the topic ("<topic> 어떻게 해?", "<topic> 지우려면?", "<topic> 추가하는 법 알려줘",
 *    "<topic> 사용법", "도움말 <topic>", "how do I set a reminder"), and
 *  - a Quoky command keyword from the closed topic index below at the START of the message (after an optional
 *    "Quoky" / "여기서" address), so the topic is the subject of the question.
 *
 * Anything else falls through: a generic programming question ("git 브랜치 어떻게 만들어?", "파이썬 리스트 정렬 어떻게
 * 해?"), a question about another app ("아이폰 알림 어떻게 꺼?", "알림 소리 어떻게 바꿔?"), a command itself ("알림
 * 목록"), a long or multi-line message, and code. Matching is conservative on purpose: a miss costs one ordinary chat
 * answer, a false match hijacks a chat turn.
 *
 * A topic answers only with contributed help lines that contain one of its anchors, so a topic whose feature is not
 * registered (no line contains its anchor) never matches anything.
 */

/** One entry of the closed help topic index. */
export interface HelpIntentTopic {
  readonly id: string;
  /** Regular-expression sources (lower-case, no flags, no anchors) for the words a User names the topic with. */
  readonly keywords: readonly string[];
  /**
   * A contributed help line answers this topic when its own (unquoted) text contains an anchor, or one of its quoted
   * example commands STARTS with an anchor ("완료 처리: 번호"). A quoted example that only mentions the word elsewhere
   * ("매일 오전 8시에 오늘 할 일 알려줘") does not count.
   */
  readonly anchors: readonly string[];
}

/**
 * The closed, versioned topic index (v1). Changing it needs a routing-corpus update. Keywords are Quoky's own
 * command nouns; names of other services (Slack, Jira, GitHub) are deliberately absent so "슬랙 어떻게 써?" stays chat.
 */
export const HELP_INTENT_TOPICS: readonly HelpIntentTopic[] = Object.freeze([
  { id: 'todo.complete', keywords: [String.raw`완료\s?처리`, '완료'], anchors: ['완료 처리'] },
  { id: 'todo', keywords: [String.raw`할\s?일`, '투두', 'todo', 'to-do'], anchors: ['할 일'] },
  { id: 'reminder', keywords: ['알림', '리마인더', 'reminder'], anchors: ['알림'] },
  { id: 'feedback', keywords: ['피드백'], anchors: ['피드백', '👍'] },
  { id: 'branch', keywords: ['브랜치'], anchors: ['브랜치'] },
  { id: 'work-lookup', keywords: [String.raw`업무\s?조회`], anchors: ['업무 조회'] },
  { id: 'memory', keywords: ['기억'], anchors: ['기억'] },
  { id: 'commit', keywords: ['커밋'], anchors: ['커밋'] },
  { id: 'project', keywords: [String.raw`프로젝트\s?등록`], anchors: ['프로젝트 등록'] },
].map((topic) => Object.freeze({ ...topic, keywords: Object.freeze(topic.keywords), anchors: Object.freeze(topic.anchors) })));

export type HelpIntentLanguage = 'ko' | 'en';

export interface HelpIntentMatch {
  /** Topic ids in the order the User named them. */
  readonly topicIds: readonly string[];
  readonly language: HelpIntentLanguage;
}

/** Longer messages are never a short how-to question about a command. */
export const HELP_INTENT_MAX_CHARS = 60;

const TRAILING_PUNCTUATION = /[\s?？!！.。~…]+$/u;
/** An optional address before the topic: "Quoky야,", "퀴키", "여기서", "Quoky에서". */
const ADDRESS_PREFIX =
  /^(?:(?:quoky|퀴키|쿼키)(?:야|아)?[,，]?\s+)?(?:(?:여기서|여기선|여기에서|(?:quoky|퀴키|쿼키)(?:에서|로|는|에선))\s+)?/u;
/** A Korean particle, optionally after the noun 기능, following a topic keyword ("알림 기능은", "할 일을"). */
const TOPIC_SUFFIX = String.raw`(?:\s?기능)?(?:은|는|을|를|이|가|도|의|에서|에|이랑|랑|하고)?`;
/** A leading "도움말 <topic>" / "사용법: <topic>" / "help <topic>". */
const HELP_PREFIX = /^(?:도움말|사용법|help|\/help)\s*[:：]?\s+/u;

/**
 * Verb or noun stems of Quoky command actions that may sit between the topic and the how-to tail ("알림 설정 어떻게
 * 해?"). Advice verbs (관리, 정리, 잘 …) are deliberately absent: "할 일 관리하는 방법 알려줘" asks for productivity
 * advice, not for a command, and stays chat.
 */
const ACTION_STEM =
  '추가|등록|설정|취소|삭제|완료|처리|목록|확인|연결|해제|조회|검색|요약|전환|수정|생성|만들|만드|보|지우|지워|끄|켜|쓰|사용|입력|바꾸|변경|남기|잊|저장|표시|보내|받';
const ACTION_ENDING = '하는|하기|하고|하려면|해야|할|하|해|는|기|고|려면|을|를|은';
const ACTION_TOKEN = new RegExp(`^(?:${ACTION_STEM})(?:${ACTION_ENDING})?$`, 'u');
/** "추가하는 법", "지우는방법", "사용법", "도움말", "명령어", "안내", with an optional particle. */
const GUIDE_TOKEN = new RegExp(
  `^(?:(?:${ACTION_STEM})(?:${ACTION_ENDING})?)?(?:법|방법|사용법|도움말|명령어|안내)(?:은|는|이|가|을|를|좀)?$`,
  'u',
);
/** Polite closers after a guide noun: "알려줘", "뭐야", "있어?". */
const GUIDE_CLOSER =
  /^(?:좀|알려\s?줘|알려줘요|알려\s?주세요|알려줄래|알려줄래요|뭐야|뭐예요|뭐에요|뭔가요|있어|있어요|있나요|궁금해|궁금해요)$/u;
/** The verb right after "어떻게": a command action or a plain do/use verb ("해", "지워", "설정해", "써", "만들어"). */
const HOWTO_VERB_HEAD = new RegExp(
  `^(?:${ACTION_STEM}|하|해|되|돼|써|꺼|봐|만들어|지워|바꿔|잊어|없애|빼|남겨|보여|올려)[가-힣]{0,4}$`,
  'u',
);
/** Helper words after that verb: "하면 돼", "하는 거야", "해 줘". */
const HOWTO_HELPER_TOKEN =
  /^(?:돼|돼요|되나요|되지|되는지|되는데|거야|거예요|거에요|건가요|거지|해|해요|하나요|하지|하는|하면|줘|줘요|주세요|할까|할까요)$/u;
const NEGATION_TOKEN = /^(?:마|말고|않아|않고|안|못|하지마|하지)$/u;

// English: "how do I add a reminder", "how to cancel my todos", "how can I mark a todo as done".
const EN_TOPICS: ReadonlyArray<{ readonly id: string; readonly pattern: string }> = [
  { id: 'reminder', pattern: 'reminders?' },
  { id: 'todo', pattern: String.raw`(?:to-?dos?|tasks?)` },
];
const EN_VERB = '(?:add|set|set up|create|make|cancel|delete|remove|complete|finish|list|see|view|check|mark|use|turn off|stop)';
const EN_HOWTO = new RegExp(
  String.raw`^how\s+(?:do\s+i|can\s+i|should\s+i|to)\s+${EN_VERB}\s+(?:(?:a|an|my|the|all|new|all\s+my)\s+)?` +
    String.raw`(${EN_TOPICS.map((t) => t.pattern).join('|')})(?:\s+as\s+(?:done|complete|completed))?(?:\s+(?:here|in\s+quoky|with\s+quoky))?$`,
  'u',
);

function normalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/\s+/gu, ' ')
    .trim();
}

interface ConsumedTopics {
  readonly topicIds: string[];
  readonly rest: string;
}

/** Consume one or more topic keywords (each with an optional particle) from the start of `text`. */
function consumeTopics(text: string, topics: readonly HelpIntentTopic[]): ConsumedTopics {
  const topicIds: string[] = [];
  let rest = text;
  for (;;) {
    let best: { id: string; length: number } | null = null;
    for (const topic of topics) {
      for (const keyword of topic.keywords) {
        const match = new RegExp(`^(?:${keyword})${TOPIC_SUFFIX}(?=\\s|$)`, 'u').exec(rest);
        if (match !== null && (best === null || match[0].length > best.length)) {
          best = { id: topic.id, length: match[0].length };
        }
      }
    }
    if (best === null) break;
    if (!topicIds.includes(best.id)) topicIds.push(best.id);
    rest = rest.slice(best.length).trimStart();
  }
  return { topicIds, rest };
}

/** True when the tokens after the topic(s) form a how-to tail. */
function isHowToTail(tokens: readonly string[]): boolean {
  if (tokens.some((token) => NEGATION_TOKEN.test(token))) return false;
  let index = 0;
  while (index < tokens.length && ACTION_TOKEN.test(tokens[index] ?? '')) index += 1;
  const tail = tokens.slice(index);

  // "<topic> 지우려면?" / "<topic> 추가하려면" — the last action token is the conditional how-to form.
  if (tail.length === 0) return index > 0 && /려면$/u.test(tokens[index - 1] ?? '');

  // "<topic> (설정) 어떻게 (해|지워|하면 돼|하는 거야)?"
  if (tail[0] === '어떻게') {
    const [verb, ...helpers] = tail.slice(1);
    if (verb === undefined) return true;
    return HOWTO_VERB_HEAD.test(verb) && helpers.length <= 2 && helpers.every((token) => HOWTO_HELPER_TOKEN.test(token));
  }

  // "<topic> 추가하는 법 알려줘", "<topic> 사용법", "<topic> 도움말", "<topic> 명령어 뭐야"
  if (GUIDE_TOKEN.test(tail[0] ?? '')) {
    const closers = tail.slice(1);
    return closers.length <= 2 && closers.every((token) => GUIDE_CLOSER.test(token));
  }
  return false;
}

/**
 * The help intent of one whole User message, or `null` for any other message. `topics` defaults to the closed
 * {@link HELP_INTENT_TOPICS} index.
 */
export function detectHelpIntent(
  text: string,
  topics: readonly HelpIntentTopic[] = HELP_INTENT_TOPICS,
): HelpIntentMatch | null {
  if (/[\r\n`]|:\/\//u.test(text)) return null;
  const normalized = normalize(text).replace(TRAILING_PUNCTUATION, '');
  if (normalized.length === 0 || normalized.length > HELP_INTENT_MAX_CHARS) return null;

  const english = EN_HOWTO.exec(normalized);
  if (english !== null) {
    const noun = english[1] ?? '';
    const topic = EN_TOPICS.find((t) => new RegExp(`^${t.pattern}$`, 'u').test(noun));
    return topic !== undefined && topics.some((t) => t.id === topic.id)
      ? Object.freeze({ topicIds: Object.freeze([topic.id]), language: 'en' as const })
      : null;
  }

  const addressed = normalized.replace(ADDRESS_PREFIX, '');

  // "도움말 알림", "사용법: 할 일", "도움말 알림 기능"
  const helpPrefixed = HELP_PREFIX.exec(addressed);
  if (helpPrefixed !== null) {
    const { topicIds, rest } = consumeTopics(addressed.slice(helpPrefixed[0].length), topics);
    return topicIds.length > 0 && rest === ''
      ? Object.freeze({ topicIds: Object.freeze(topicIds), language: 'ko' as const })
      : null;
  }

  const { topicIds, rest } = consumeTopics(addressed, topics);
  if (topicIds.length === 0 || rest === '') return null;
  return isHowToTail(rest.split(' '))
    ? Object.freeze({ topicIds: Object.freeze(topicIds), language: 'ko' as const })
    : null;
}

const QUOTED = /"([^"\n]*)"|“([^”\n]*)”/gu;

/** True when `line` answers `anchor` (see {@link HelpIntentTopic.anchors}). */
function lineAnswersAnchor(line: string, anchor: string): boolean {
  if (line.replace(QUOTED, ' ').includes(anchor)) return true;
  for (const quoted of line.matchAll(QUOTED)) {
    if ((quoted[1] ?? quoted[2] ?? '').trimStart().startsWith(anchor)) return true;
  }
  return false;
}

/** At most this many help lines answer one help intent. */
export const HELP_INTENT_MAX_LINES = 6;
/** A help line longer than this is cut, ending in `…`. */
export const HELP_INTENT_MAX_LINE_CHARS = 160;

/**
 * The contributed help lines that answer `match`, in contribution order: whitespace collapsed, blank and duplicate
 * lines dropped, lines in `exclude` (the help-intent handler's own lines) skipped, bounded. Empty when no line answers
 * an anchor of a matched topic (the feature is not registered), in which case the turn falls through.
 */
export function selectHelpLines(
  match: HelpIntentMatch,
  helpLines: readonly string[],
  options: { readonly topics?: readonly HelpIntentTopic[]; readonly exclude?: readonly string[] } = {},
): string[] {
  const topics = options.topics ?? HELP_INTENT_TOPICS;
  const anchors = topics.filter((topic) => match.topicIds.includes(topic.id)).flatMap((topic) => topic.anchors);
  const excluded = new Set((options.exclude ?? []).map((line) => line.replace(/\s+/gu, ' ').trim()));
  const selected: string[] = [];
  for (const raw of helpLines) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (line === '' || excluded.has(line) || selected.includes(line)) continue;
    if (!anchors.some((anchor) => lineAnswersAnchor(line, anchor))) continue;
    selected.push(line);
    if (selected.length === HELP_INTENT_MAX_LINES) break;
  }
  return selected.map((line) => {
    const chars = Array.from(line);
    return chars.length <= HELP_INTENT_MAX_LINE_CHARS
      ? line
      : `${chars.slice(0, HELP_INTENT_MAX_LINE_CHARS - 1).join('')}…`;
  });
}

/** The deterministic reply text for a help intent with its selected lines. */
export function composeHelpIntentReply(language: HelpIntentLanguage, lines: readonly string[]): string {
  if (language === 'en') {
    return [
      'Here is how to do that in Quoky (the commands are in Korean):',
      ...lines,
      'Send "/help" for the full guide.',
    ].join('\n');
  }
  return ['Quoky에서는 이렇게 하면 돼요.', ...lines, '전체 안내는 "도움말"이라고 보내 주세요.'].join('\n');
}
