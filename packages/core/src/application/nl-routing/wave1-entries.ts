import type { NlAmbiguityKey, NlArgs, NlArgValue, NlCatalogEntry, NlWave1EntryId } from './catalog';
import { containsGroundingWord } from './grammar-residual';
import { hasJiraReleaseLink } from '../work-chat/jira-release-link';
import { nlRangeLabel, type NlResolvedRange } from './symbolic-time';

/**
 * The wave-1 catalog (ADR-0120 D1): eleven READ entries, each mapped by its owning handler's `handleSelected` to the
 * handler's existing typed command. Defined once here so the closed vocabulary is reviewable in one place; a handler
 * contributes the entries of its configured sources (`ConversationTurnHandler.catalog`).
 */

const SEARCH_LIMIT = { name: 'limit', kind: 'limit', description: 'Only when the owner asks for at most N results (1-10).' } as const;
const COUNT = { name: 'count', kind: 'flag', default: false, description: 'true only when the owner asks how many ("몇 개", "how many").' } as const;

/**
 * ADR-0120 A6 R1 status filter (owner-approved 2026-10-15, "지금 추가"): which to-dos or reminders a list shows. Closed
 * values from the domain lifecycles (WorkItemStatus; ReminderStatus with `done` = already fired); default the open ones.
 * The value words are value validators (`valueGrounding`), never routing.
 */
export const TODO_LIST_STATUS_VALUES = ['active', 'canceled', 'completed', 'all'] as const;
export const REMINDER_LIST_STATUS_VALUES = ['active', 'canceled', 'done', 'all'] as const;
const ALL_STATUS_WORDS = ['전체', '전부', '모든', '모두', '다 보여', 'all', 'every'];
const TODO_STATUS = {
  name: 'status',
  kind: 'enum',
  values: TODO_LIST_STATUS_VALUES,
  default: 'active',
  valueGrounding: {
    canceled: ['취소된', '취소한', '취소했던', '취소 된', '뺀', '빠진', '삭제된', 'canceled', 'cancelled'],
    completed: ['완료된', '완료한', '완료했던', '완료 된', '끝난', '끝낸', '마친', '다 한', 'completed', 'done', 'finished'],
    all: ALL_STATUS_WORDS,
  },
  description: 'Omit for the open to-dos. canceled (취소된/뺀), completed (완료된/끝난) or all (전체/전부) only when the owner asks for those.',
} as const;
const REMINDER_STATUS = {
  name: 'status',
  kind: 'enum',
  values: REMINDER_LIST_STATUS_VALUES,
  default: 'active',
  valueGrounding: {
    canceled: ['취소된', '취소한', '취소했던', '취소 된', '꺼진', '끈', '삭제된', 'canceled', 'cancelled'],
    done: ['지난', '지나간', '울린', '보낸', '끝난', '완료된', 'past', 'sent', 'fired', 'done'],
    all: ALL_STATUS_WORDS,
  },
  description: 'Omit for the scheduled reminders. canceled (취소된/끈), done (지난/울린, already sent) or all (전체/전부) only when the owner asks for those.',
} as const;

function quoted(value: string): string {
  return `"${value}"`;
}

function joinBasis(parts: ReadonlyArray<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length === 0 ? undefined : present.join(' / ');
}

/** ADR-0120 D7/D13: "오늘 등록된 jira 이슈" — whose issues does "등록된" mean? Asked once, kept per actor for 30 days. */
export const JIRA_CREATED_SCOPE: NlAmbiguityKey = Object.freeze({
  key: 'jira.created-scope',
  arg: 'role',
  values: Object.freeze([
    { value: 'assignee', label: { ko: '내가 담당자인 이슈', en: 'Issues assigned to me' }, aliases: ['담당', '할당', '배정', 'assignee', 'assigned', 'assigned to me'], grounding: ['담당', '할당', '배정', 'assign'] },
    { value: 'reporter', label: { ko: '내가 보고자(등록자)인 이슈', en: 'Issues I reported' }, aliases: ['보고', '보고자', '등록자', '내가 만든', '내가 등록한', 'reporter', 'reported'], grounding: ['보고자', '보고한', '내가 보고', '등록자', '내가 만든', '내가 등록한', '내가 올린', '내가 작성한', 'reporter', 'i reported', 'reported by me', 'i created', 'i made', 'i filed', 'i opened'] },
    { value: 'either', label: { ko: '둘 다 (담당 또는 보고)', en: 'Both (assigned or reported)' }, aliases: ['둘 다', '둘다', '모두', '전부', '다', 'both', 'either', 'all'], grounding: ['둘 다', '둘다', '담당이든', '보고든', '담당이나 보고', 'both', 'either'] },
  ]),
  question: {
    ko: '"등록된 이슈"를 어떤 기준으로 볼까요? 한 번 정하면 30일 동안 같은 기준을 쓸게요.',
    en: 'Which issues should "created" cover? I will keep your choice for 30 days.',
  },
  openWhen: (args: NlArgs) => args.window === 'created',
});

/** Words that show the owner asked for in-progress issues (ADR-0120 follow-up): a status value is grounded like a role. */
export const JIRA_IN_PROGRESS_WORDS: readonly string[] = ['진행', 'in progress', 'in-progress', 'working on'];

/** Words of the date field a Jira period applies to (`window`): created, updated, due (ADR-0120 D13). */
export const JIRA_WINDOW_WORDS: readonly string[] = ['등록', '생성', '올라온', '업데이트', '수정', '변경', '마감', '기한', 'created', 'updated', 'due'];
/** Words of a status the owner can state besides in-progress: finished or all. */
export const JIRA_STATUS_WORDS: readonly string[] = ['완료', '종료', '닫힌', 'closed', 'resolved', 'done', 'finished', 'open'];
/**
 * ADR-0120 amendment A8: words that name a release (fix version). A Jira keyword slot carrying one is for `jira.release`,
 * so the frozen grammar yields it (the A2 rule, derived from the entry's own vocabulary; it routes nothing by itself).
 */
export const JIRA_RELEASE_WORDS: readonly string[] = ['릴리스', '릴리즈', '배포건', '배포 건', '배포항목', '배포 항목', '배포 버전', '수정 버전', 'release', 'fix version', 'fixversion'];
/**
 * ADR-0120 amendment A8: words that ask for every assignee. `jira.issues` (the owner's own items) cannot express them:
 * its validator refuses a selection whose text carries one, and the frozen Jira grammar yields it.
 */
export const JIRA_ALL_ASSIGNEE_WORDS: readonly string[] = ['전체 담당', '모든 담당', '담당 상관없이', '담당자 상관없이', '담당자 전체', '전체 담당자', '모든 담당자', '다른 사람 담당', '팀 전체', 'all assignees', 'any assignee', 'everyone'];
/**
 * ADR-0120 amendment A8 (owner decision 2, 2026-10-15: "default로는 당연히 내 담당 기준"): words with which the owner explicitly
 * asks a release listing for every assignee (`scope: all`). Without one the listing is the owner's own items.
 */
export const JIRA_SCOPE_ALL_WORDS: readonly string[] = [...JIRA_ALL_ASSIGNEE_WORDS, '전체'];

/** Period words (relative days, weeks, months): a keyword carrying one is a period, not a topic. */
export const NL_PERIOD_WORDS: readonly string[] = ['오늘', '어제', '내일', '모레', '이번', '지난', '다음', '금주', '최근', '요즘', 'today', 'yesterday', 'tomorrow', 'week', 'month', 'recent'];

/**
 * Whether a keyword the owner typed also carries something the Jira entry expresses with a typed arg (a role, a status, a
 * date field or a period). A grammar that would take such text as a plain keyword declines, so selection binds the typed
 * args instead (ADR-0120 follow-up 2). Derived from the entry's own argument vocabularies; no topic words.
 */
export function jiraKeywordCarriesQualifier(keyword: string): boolean {
  const text = keyword.normalize('NFC').toLowerCase();
  const words = [
    ...JIRA_IN_PROGRESS_WORDS,
    ...JIRA_STATUS_WORDS,
    ...JIRA_WINDOW_WORDS,
    ...NL_PERIOD_WORDS,
    ...JIRA_CREATED_SCOPE.values.flatMap((value) => value.grounding ?? []),
    ...JIRA_RELEASE_WORDS,
    ...JIRA_ALL_ASSIGNEE_WORDS,
    '내가',
    '제가',
    '담당',
    '할당',
    '배정',
  ];
  // Latin words match as whole words ("weekly" is a topic, "week" a period); Korean words match inside the token (particles).
  return containsGroundingWord(text, words);
}

/** The closed Jira sort orders (live UAT R8): each maps to a constant ORDER BY in the adapter, never to owner text. */
export const JIRA_SORT_VALUES = ['oldest', 'newest', 'recently-updated'] as const;
/** Words that show the owner asked for a Jira order: a `sort` value counts only when one is in the owner's own text. */
export const JIRA_SORT_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  oldest: ['오래된', '오래 된', '가장 오래', '제일 오래', '옛날', 'oldest', 'longest open'],
  newest: ['최신', '가장 새', '제일 새', '새로 만든', '새로 생긴', 'newest', 'latest', 'most recent'],
  'recently-updated': ['최근 업데이트', '최근에 업데이트', '최근 수정', '최근에 수정', '최근 변경', '업데이트 순', '수정 순', 'recently updated', 'last updated', 'most recently updated'],
});
const JIRA_SORT_LABEL: Readonly<Record<string, { ko: string; en: string }>> = {
  oldest: { ko: '오래된 순', en: 'oldest first' },
  newest: { ko: '최신 순', en: 'newest first' },
  'recently-updated': { ko: '최근 업데이트 순', en: 'recently updated first' },
};

const JIRA_ROLE_LABEL: Readonly<Record<string, { ko: string; en: string }>> = {
  assignee: { ko: '내가 담당', en: 'assigned to me' },
  reporter: { ko: '내가 보고자', en: 'reported by me' },
  either: { ko: '내가 담당·보고자', en: 'assigned to or reported by me' },
};
const JIRA_WINDOW_LABEL: Readonly<Record<string, { ko: string; en: string }>> = {
  created: { ko: '생성', en: 'created' },
  updated: { ko: '업데이트', en: 'updated' },
  due: { ko: '마감', en: 'due' },
};

function rangePart(range: NlResolvedRange | undefined, language: 'ko' | 'en'): string | undefined {
  return range === undefined ? undefined : nlRangeLabel(range, language);
}

const jiraIssues: NlCatalogEntry = {
  id: 'jira.issues',
  risk: 'READ',
  dmOnly: false,
  label: { ko: 'Jira 이슈 조회', en: 'Jira issues' },
  aliases: ['jira', '지라', '이슈', '티켓'],
  description: {
    en: "The owner's own Jira issues (assigned to or reported by them), optionally narrowed by when they were created, updated or are due, by status, or by a keyword. Also briefings or counts of those issues.",
    ko: '내 Jira 이슈(담당·보고) 목록·브리핑·개수. 생성/업데이트/마감 기간, 상태, 키워드로 좁히기.',
  },
  args: [
    { name: 'role', kind: 'enum', values: ['assignee', 'reporter', 'either'], default: 'assignee', description: 'Set ONLY when the owner names it: assigned to me (나한테 할당된/배정된, 내 담당) = assignee; I reported/created/made (내가 만든/올린/보고한) = reporter; either ONLY when the owner says both (둘 다, 담당이든 보고든). Never guess it. 할당된/배정된 is this role, never a window.' },
    { name: 'window', kind: 'enum', values: ['created', 'updated', 'due'], description: 'Which date the period applies to: created (등록된/생성된/새로 올라온), updated (업데이트된/수정된/변경된), due (마감/기한). Omit when no such event word is used.' },
    { name: 'range', kind: 'range', pastWindow: (args) => args.window === 'created' || args.window === 'updated', description: 'The period of `window`. Omit unless `window` is set.' },
    { name: 'status', kind: 'enum', values: ['open', 'all', 'in-progress'], default: 'open', valueGrounding: { 'in-progress': JIRA_IN_PROGRESS_WORDS }, description: 'all only when the owner includes finished/closed issues (완료된 것도, 전체, all); in-progress only when the owner asks for issues being worked on (진행중인, 진행 중, in progress, working on); default open.' },
    { name: 'keyword', kind: 'keyword', description: 'A topic word the owner wants the issues narrowed to, copied verbatim (e.g. 위클리카). Never a weekday, date or period word: those are `range`.' },
    { name: 'sort', kind: 'enum', values: [...JIRA_SORT_VALUES], valueGrounding: JIRA_SORT_WORDS, description: 'Only when the owner asks for an order: oldest (제일 오래된 것, 오래된 순), newest (가장 새로 만든, 최신 순), recently-updated (최근에 업데이트된 순). Never guess it; "the oldest one" keeps the other args and adds sort oldest.' },
    COUNT,
    SEARCH_LIMIT,
  ],
  ambiguity: [JIRA_CREATED_SCOPE],
  usage: { ko: '"내 Jira 이슈 보여줘"', en: '"내 Jira 이슈 보여줘"' },
  sourceNames: ['jira', '지라'],
  check(_args: NlArgs, groundingText: string) {
    // ADR-0120 A8: the owner's own items cannot answer a request for every assignee ("전체 담당"): asked, never narrowed.
    return containsGroundingWord(groundingText.normalize('NFC').toLowerCase(), JIRA_ALL_ASSIGNEE_WORDS) ? { reason: 'invalid-arg', arg: 'role', askEntryId: 'jira.release' } : undefined;
  },
  normalize(args: Record<string, NlArgValue>): void {
    // A period needs a date field: without one the period word only means "now" ("오늘 나한테 할당된 이슈") and is
    // dropped; a date field without a period gets the field's natural window (due → this week, else today).
    if (args.window === undefined) delete args.range;
    else if (args.range === undefined) args.range = args.window === 'due' ? 'this-week' : 'today';
    // "다가오는 마감" read as the calendar's `upcoming`: the next 7 days of due dates.
    else if (args.range === 'upcoming') args.range = 'next-7-days';
  },
  describe(args: NlArgs, range: NlResolvedRange | undefined, language: 'ko' | 'en'): string | undefined {
    const role = JIRA_ROLE_LABEL[typeof args.role === 'string' ? args.role : 'assignee'];
    const window = typeof args.window === 'string' ? JIRA_WINDOW_LABEL[args.window] : undefined;
    const period = rangePart(range, language) ?? '';
    const when = window === undefined ? undefined : (language === 'en' ? `${window.en} ${period}` : `${period} ${window.ko}`).trim();
    const status =
      args.status === 'in-progress'
        ? (language === 'en' ? 'in progress' : '진행 중')
        : args.status === 'all'
          ? (language === 'en' ? 'including done' : '완료 포함')
          : window === undefined ? (language === 'en' ? 'open' : '미해결') : undefined;
    const keyword = typeof args.keyword === 'string' ? (language === 'en' ? `matching ${quoted(args.keyword)}` : `${quoted(args.keyword)} 포함`) : undefined;
    const sort = typeof args.sort === 'string' ? JIRA_SORT_LABEL[args.sort]?.[language] : undefined;
    return joinBasis([role?.[language], when, status, keyword, sort]);
  },
};

/**
 * ADR-0120 amendment A8: one Jira release (fix version) the way Jira's release report shows it, any assignee unless the
 * owner limits it to their own; or the release list of a project when no release is named. A link to a release page on
 * the configured Jira site is read by Core itself (the selector never copies it). Read-only; the list is never summarised.
 */
const jiraRelease: NlCatalogEntry = {
  id: 'jira.release',
  risk: 'READ',
  dmOnly: false,
  label: { ko: 'Jira 릴리스 조회', en: 'Jira release' },
  aliases: ['릴리스', '릴리즈', '배포', 'release', '버전'],
  description: {
    en: "The issues in one Jira release (fix version) of a project, the owner's own unless they ask for every assignee, grouped by status like Jira's release report; or a project's release list when no release is named. Also a pasted Jira release link.",
    ko: 'Jira 릴리스(배포 버전)에 포함된 이슈, 기본은 내 담당(전체 담당은 말할 때만), 상태별. 릴리스 이름 없이 프로젝트만 말하면 그 프로젝트의 릴리스 목록. Jira 릴리스 링크도.',
  },
  args: [
    { name: 'release', kind: 'keyword', description: 'The release (fix version) name copied verbatim from the owner\'s words (e.g. 3.2.0), without words like 배포/배포건/릴리스/버전. Omit for a pasted link: Quoky reads the link itself.' },
    { name: 'project', kind: 'keyword', description: 'The Jira project name or key copied verbatim and whole from the owner\'s words (every word of a multi-word name, e.g. 모바일 앱 운영, never just 모바일), without 프로젝트. Omit when none is named.' },
    { name: 'scope', kind: 'enum', values: ['mine', 'all'], default: 'mine', valueGrounding: { all: JIRA_SCOPE_ALL_WORDS }, description: 'all ONLY when the owner explicitly asks for every assignee (전체, 모든 담당, 담당 상관없이, all assignees); default mine = the owner\'s own issues. Every assignee with no release, project or link named: NEEDS_CLARIFICATION.' },
    COUNT,
  ],
  usage: { ko: '"ABC 프로젝트 1.2.0 릴리스 보여줘"', en: '"ABC 프로젝트 1.2.0 릴리스 보여줘"' },
  sourceNames: ['jira', '지라'],
  check(args: NlArgs, groundingText: string) {
    // A release listing is bounded by what the owner named: a release, a project or a release link (any host here;
    // the desk uses only a link on the configured site and says so when it ignores one).
    if (typeof args.release === 'string' || typeof args.project === 'string' || hasJiraReleaseLink(groundingText)) return undefined;
    return { reason: 'missing-arg', arg: 'release' };
  },
  describe(args: NlArgs, _range, language): string | undefined {
    const release = typeof args.release === 'string'
      ? (language === 'en' ? `release ${quoted(args.release)}` : `릴리스 ${quoted(args.release)}`)
      : typeof args.project === 'string' ? undefined : (language === 'en' ? 'the linked release' : '링크의 릴리스');
    const project = typeof args.project === 'string' ? (language === 'en' ? `project ${quoted(args.project)}` : `프로젝트 ${quoted(args.project)}`) : undefined;
    const what = typeof args.release === 'string' || typeof args.project !== 'string' ? undefined : (language === 'en' ? 'release list' : '릴리스 목록');
    const scope = typeof args.release === 'string' || typeof args.project !== 'string'
      ? (args.scope === 'all' ? (language === 'en' ? 'every assignee' : '전체 담당') : (language === 'en' ? 'assigned to me' : '내 담당'))
      : undefined;
    return joinBasis([release, project, what, scope]);
  },
};

const githubItems: NlCatalogEntry = {
  id: 'github.items',
  risk: 'READ',
  dmOnly: false,
  label: { ko: 'GitHub 이슈·PR 조회', en: 'GitHub issues and PRs' },
  aliases: ['github', '깃허브', '깃헙', 'pr', '풀리퀘'],
  description: {
    en: "The owner's own open GitHub issues and pull requests, or the pull requests waiting for the owner's review.",
    ko: '내 GitHub 이슈·PR 목록, 또는 나에게 온 리뷰 요청.',
  },
  args: [
    { name: 'query', kind: 'enum', values: ['my-items', 'review-requests'], default: 'my-items', description: 'review-requests when the owner asks about reviews requested from them (리뷰 요청, 리뷰할 PR); else my-items.' },
    { name: 'keyword', kind: 'keyword', description: 'A topic word to narrow the owner\'s items, copied verbatim.' },
    COUNT,
    SEARCH_LIMIT,
  ],
  usage: { ko: '"GitHub 리뷰 요청 보여줘"', en: '"GitHub 리뷰 요청 보여줘"' },
  sourceNames: ['github', '깃허브', '깃헙'],
  describe(args: NlArgs, _range, language): string | undefined {
    const what = args.query === 'review-requests'
      ? (language === 'en' ? 'review requests for me' : '나에게 온 리뷰 요청')
      : (language === 'en' ? 'my open issues and PRs' : '내 열린 이슈·PR');
    const keyword = typeof args.keyword === 'string' ? (language === 'en' ? `matching ${quoted(args.keyword)}` : `${quoted(args.keyword)} 포함`) : undefined;
    return joinBasis([what, keyword]);
  },
};

function searchEntry(id: 'slack.search' | 'confluence.search', source: string, aliases: readonly string[], ko: string): NlCatalogEntry {
  return {
    id,
    risk: 'READ',
    dmOnly: false,
    label: { ko: `${source} 검색`, en: `${source} search` },
    aliases,
    description: {
      en: `Search ${source} for a keyword the owner gives (messages or pages that mention it).`,
      ko,
    },
    args: [
      { name: 'keyword', kind: 'keyword', required: true, description: 'The core search term(s) only, copied verbatim from the owner\'s text: no particles (에서/를) and no conversational filler ("릴리즈 이야기 있던 것" -> 릴리즈, "정산 쪽 자료" -> 정산).' },
      COUNT,
      SEARCH_LIMIT,
    ],
    usage: { ko: `"${source}에서 배포 검색"`, en: `"${source}에서 배포 검색"` },
    sourceNames: [source.toLowerCase(), ...aliases.filter((alias) => alias !== '위키')],
    describe(args: NlArgs, _range, language): string | undefined {
      return typeof args.keyword === 'string' ? (language === 'en' ? `search ${quoted(args.keyword)}` : `${quoted(args.keyword)} 검색`) : undefined;
    },
  };
}

/** The closed parts of a day (live UAT R2): morning 00:00-12:00, afternoon 12:00-18:00, evening 18:00-24:00 local time. */
export const CALENDAR_PART_OF_DAY_VALUES = ['morning', 'afternoon', 'evening'] as const;
export type CalendarPartOfDay = (typeof CALENDAR_PART_OF_DAY_VALUES)[number];
/** Words that show the owner named a part of the day: a `partOfDay` value counts only when one is in the owner's own text. */
export const CALENDAR_PART_OF_DAY_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  morning: ['오전', '아침', 'morning'],
  afternoon: ['오후', '점심 이후', '점심 지나', '점심 후', 'afternoon'],
  evening: ['저녁', '밤', '야간', 'evening', 'tonight', 'night'],
});
/** Words that show the owner narrowed to meetings (timed events): `timedOnly` counts only when one is in the owner's words. */
export const CALENDAR_TIMED_ONLY_WORDS: readonly string[] = ['회의', '미팅', '시간 지정', '시간대 있는', 'meeting', 'meetings'];
const PART_OF_DAY_LABEL: Readonly<Record<string, { ko: string; en: string }>> = {
  morning: { ko: '오전', en: 'morning' },
  afternoon: { ko: '오후', en: 'afternoon' },
  evening: { ko: '저녁', en: 'evening' },
};

const calendarEvents: NlCatalogEntry = {
  id: 'calendar.events',
  risk: 'READ',
  dmOnly: false,
  label: { ko: '캘린더 일정 조회', en: 'Calendar events' },
  aliases: ['calendar', '캘린더', '일정', '스케줄', '달력', '회의', '미팅'],
  description: {
    en: "The owner's calendar events (schedule, meetings, appointments) for a period, the next upcoming event, or whether the owner is busy/free.",
    ko: '내 캘린더 일정·회의·약속(기간별), 다음 일정, 바쁜지 여부.',
  },
  args: [
    { name: 'range', kind: 'range', default: 'today', allowUpcoming: true, description: 'The period; upcoming for "the next meeting/event" (다음 회의 언제). Default today.' },
    { name: 'remaining', kind: 'flag', default: false, description: 'true only for events still left (남은 일정, remaining).' },
    { name: 'partOfDay', kind: 'enum', values: [...CALENDAR_PART_OF_DAY_VALUES], valueGrounding: CALENDAR_PART_OF_DAY_WORDS, description: 'Only when the owner names a part of the day: morning (오전, 아침), afternoon (오후, 점심 이후), evening (저녁, 밤). The events are filtered to that part of the day; the day itself stays in `range`. A follow-up like "밤 시간만 다시" keeps the previous range and adds it.' },
    { name: 'timedOnly', kind: 'flag', default: false, flagGrounding: CALENDAR_TIMED_ONLY_WORDS, description: 'true when the owner asks about meetings/timed events and away from all-day entries such as leave or holidays ("회의만", "미팅만", "only meetings").' },
    { name: 'availability', kind: 'flag', default: false, description: 'true when the owner asks whether they are free, busy or available ("스케줄 여유 있어?", "한가해?", "바빠?", "am I free"); an empty answer then says they are free.' },
    { name: 'keyword', kind: 'keyword', description: 'A word of the event title the owner wants the events narrowed to ("스크럼만", "스크럼 일정"), copied verbatim; omit for all events. Never a weekday, date, part of day or period word ("목요일", "오후"): those are `range` / `partOfDay`.' },
    COUNT,
  ],
  usage: { ko: '"오늘 일정"', en: '"오늘 일정"' },
  sourceNames: ['google calendar', 'calendar', '캘린더', '구글 캘린더'],
  describe(args: NlArgs, range: NlResolvedRange | undefined, language): string | undefined {
    const period = rangePart(range, language) ?? (language === 'en' ? 'today' : '오늘');
    const keyword = typeof args.keyword === 'string' ? (language === 'en' ? `title contains ${quoted(args.keyword)}` : `${quoted(args.keyword)} 포함`) : undefined;
    const part = typeof args.partOfDay === 'string' ? PART_OF_DAY_LABEL[args.partOfDay]?.[language] : undefined;
    const timed = args.timedOnly === true ? (language === 'en' ? 'timed events only' : '시간 지정 일정만') : undefined;
    if (language === 'en') return joinBasis([`${period}${part !== undefined ? ` ${part}` : ''}${args.remaining === true ? ', remaining' : ''} events`, timed, keyword]);
    return joinBasis([`${period}${part !== undefined ? ` ${part}` : ''} ${args.remaining === true ? '남은 일정' : '일정'}`, timed, keyword]);
  },
};

const mailList: NlCatalogEntry = {
  id: 'mail.list',
  risk: 'READ',
  dmOnly: true,
  label: { ko: '메일 목록', en: 'Mail list' },
  aliases: ['mail', 'email', 'gmail', '메일', '이메일', '지메일', '편지함', '받은편지함'],
  description: {
    en: "A list of the owner's received mail (inbox), optionally only unread, only today's, or from one sender. Listing only: never send, reply, delete or summarize one mail.",
    ko: '받은 메일 목록(안 읽은 것, 오늘 온 것, 보낸 사람별). 목록만, 발송·답장·삭제 아님.',
  },
  args: [
    { name: 'unread', kind: 'flag', default: false, description: 'true for unread/new mail (안 읽은, 읽지 않은, 새, unread, new).' },
    { name: 'range', kind: 'range', pastOnly: true, description: 'The period the mail was RECEIVED in: today (오늘 온), yesterday (어제 온), this-week, last-week, last-7-days, a weekday (last-fri = 지난주 금요일), a date. Omit when the owner names no period.' },
    { name: 'today', kind: 'flag', default: false, deprecated: true, description: 'Deprecated: use range today.' },
    { name: 'from', kind: 'keyword', allowsTimeWords: true, description: 'The sender name or address the owner names, copied verbatim (e.g. 김부장님).' },
    { name: 'item', kind: 'limit', transient: true, description: 'Only when the owner asks about ONE already-listed mail by its number ("N번째 건 누가 보냈어?"): that number. Never for a summary, reply or write request (those are none).' },
    COUNT,
  ],
  usage: { ko: '"안 읽은 메일"', en: '"안 읽은 메일"' },
  sourceNames: ['gmail', 'e-mail', 'email', 'inbox', '지메일', '이메일', '메일'],
  migrateArgs(args: NlArgs): NlArgs {
    // A selection stored before the symbolic `range` carried `today`; it is the same period now.
    if (!('today' in args)) return args;
    const { today, ...rest } = args;
    return today === true && rest.range === undefined ? { ...rest, range: 'today' } : rest;
  },
  normalize(args: Record<string, NlArgValue>): void {
    if (args.today === true && args.range === undefined) args.range = 'today';
    delete args.today;
  },
  describe(args: NlArgs, range: NlResolvedRange | undefined, language): string | undefined {
    const parts: string[] = [];
    if (range !== undefined) parts.push(language === 'en' ? `received ${nlRangeLabel(range, language)}` : `${nlRangeLabel(range, language)} 받은`);
    if (args.unread === true) parts.push(language === 'en' ? 'unread' : '안 읽은');
    if (typeof args.from === 'string') parts.push(language === 'en' ? `from ${quoted(args.from)}` : `${quoted(args.from)}에게서 온`);
    if (parts.length === 0) parts.push(language === 'en' ? 'recent' : '최근');
    return language === 'en' ? `${parts.join(', ')} mail` : `${parts.join(' ')} 메일`;
  },
};

/** Words that show the owner named a Drive file type: a `kind` value counts only when one is in the owner's own text. */
export const DRIVE_KIND_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  spreadsheet: ['스프레드시트', '스프레드 시트', '시트', '엑셀', 'sheet', 'spreadsheet', 'excel'],
  // A plain 문서/document is not a type (it also names uploaded Word/HWP/PDF files): only the Google Docs wording counts.
  document: ['구글 문서', '구글문서', '독스', 'google doc', 'google docs', 'docs'],
  presentation: ['슬라이드', '프레젠테이션', '피티', 'ppt', 'slide', 'presentation'],
  pdf: ['pdf'],
  folder: ['폴더', 'folder'],
});

const DRIVE_KIND_LABEL: Readonly<Record<string, { ko: string; en: string }>> = {
  spreadsheet: { ko: '스프레드시트', en: 'spreadsheets' },
  document: { ko: '문서', en: 'documents' },
  presentation: { ko: '프레젠테이션', en: 'presentations' },
  pdf: { ko: 'PDF', en: 'PDFs' },
  folder: { ko: '폴더', en: 'folders' },
};

const driveFiles: NlCatalogEntry = {
  id: 'drive.files',
  risk: 'READ',
  dmOnly: true,
  label: { ko: '드라이브 파일 조회', en: 'Drive files' },
  aliases: ['drive', '드라이브', '구글 드라이브', '문서', '파일'],
  description: {
    en: "The owner's recent Google Drive files (docs, sheets), or Drive files whose name contains a word the owner gives. Listing only.",
    ko: '구글 드라이브 최근 파일, 또는 이름으로 파일 찾기. 목록만.',
  },
  args: [
    { name: 'name', kind: 'keyword', description: 'A word of the file name the owner wants, copied verbatim (e.g. 기획서). Omit for recent files.' },
    { name: 'kind', kind: 'enum', values: ['spreadsheet', 'document', 'presentation', 'pdf', 'folder'], valueGrounding: DRIVE_KIND_WORDS, description: 'Only when the owner names the file type: spreadsheet (스프레드시트/시트/엑셀), document (only 구글 문서/독스/google docs; a plain 문서 is NOT a type), presentation (슬라이드/프레젠테이션/ppt), pdf, folder (폴더). Never guess it; the type word is not part of `name`.' },
    COUNT,
  ],
  usage: { ko: '"최근 드라이브 파일"', en: '"최근 드라이브 파일"' },
  sourceNames: ['google drive', 'drive', '구글 드라이브', '드라이브'],
  describe(args: NlArgs, _range, language): string | undefined {
    const kind = typeof args.kind === 'string' ? DRIVE_KIND_LABEL[args.kind] : undefined;
    if (typeof args.name === 'string') {
      const base = language === 'en' ? `${kind?.en ?? 'file'} names with ${quoted(args.name)}` : `${kind?.ko ?? '파일'} 이름에 ${quoted(args.name)}`;
      return base;
    }
    if (kind !== undefined) return language === 'en' ? `recent ${kind.en}` : `최근 ${kind.ko}`;
    return language === 'en' ? 'recent files' : '최근 파일';
  },
};

const todoList: NlCatalogEntry = {
  id: 'todo.list',
  risk: 'READ',
  dmOnly: false,
  label: { ko: '내 할 일 목록', en: 'My to-do list' },
  aliases: ['할 일', '할일', 'todo', '투두', '업무 목록'],
  description: {
    en: "The owner's own to-do list in Quoky, also called 업무 목록 or 투두 (what is left, how many). Reading only: adding, finishing or cancelling a to-do is not this entry.",
    ko: 'Quoky 할 일(업무 목록, 투두) 보기(남은 것, 몇 개). 추가·완료·취소는 아님.',
  },
  args: [COUNT, TODO_STATUS],
  usage: { ko: '"내 할 일 보여줘"', en: '"내 할 일 보여줘"' },
};

const reminderList: NlCatalogEntry = {
  id: 'reminder.list',
  risk: 'READ',
  dmOnly: false,
  label: { ko: '예정된 알림 목록', en: 'Scheduled reminders' },
  aliases: ['알림', '리마인더', 'reminder', '알람'],
  description: {
    en: "The owner's Quoky reminders (scheduled ones unless the owner asks for canceled or past ones). Listing only: creating or cancelling a reminder is not this entry.",
    ko: '알림(리마인더) 목록 보기(기본은 예정된 것, 취소된·지난 알림은 물을 때만). 만들기·취소는 아님.',
  },
  args: [REMINDER_STATUS],
  usage: { ko: '"알림 목록"', en: '"알림 목록"' },
};

const briefToday: NlCatalogEntry = {
  id: 'brief.today',
  risk: 'READ',
  dmOnly: true,
  label: { ko: '오늘의 브리핑', en: "Today's brief" },
  aliases: ['브리핑', '오늘 브리핑', 'brief', 'briefing'],
  description: {
    en: "Today's overall brief right now: today's schedule, reminders and to-dos together (a morning or daily briefing, a day summary, an at-a-glance view of the day). Not for one source only.",
    ko: '지금 오늘의 종합 브리핑(일정·알림·할 일을 한 번에, 하루 요약, 하루를 한눈에 보기). 한 소스만 묻는 경우는 아님.',
  },
  args: [],
  usage: { ko: '"오늘 브리핑해줘"', en: '"오늘 브리핑해줘"' },
};

/** The help topics `help.topic` accepts: the ADR-0104 index ids plus `mail`, `drive` and `all`. */
export const NL_HELP_TOPICS = [
  'all',
  'todo',
  'todo.complete',
  'reminder',
  'calendar',
  'mail',
  'drive',
  'work-lookup',
  'memory',
  'feedback',
  'branch',
  'commit',
  'project',
  'model',
  'connector-write',
] as const;

const helpTopic: NlCatalogEntry = {
  id: 'help.topic',
  risk: 'READ',
  dmOnly: false,
  label: { ko: 'Quoky 사용법 안내', en: 'How to use Quoky' },
  aliases: ['도움말', '사용법', 'help', '기능'],
  description: {
    en: "How to use Quoky itself, what Quoky can do, or whether Quoky can read a source (e.g. \"can you see my jira?\"). Not general how-to questions about other apps or programming.",
    ko: 'Quoky 자체 사용법·기능 질문, Quoky가 어떤 소스를 볼 수 있는지. 다른 앱·프로그래밍 사용법은 아님.',
  },
  args: [
    {
      name: 'topic',
      kind: 'enum',
      values: NL_HELP_TOPICS,
      default: 'all',
      description: 'The Quoky feature asked about: todo, todo.complete, reminder, calendar, mail, drive, work-lookup (Jira/GitHub/Slack/Confluence lookups), memory, feedback, branch, commit, project, model, connector-write; all for "which things are you able to help with".',
    },
  ],
  usage: { ko: '"도움말"', en: '"help"' },
};

export const NL_WAVE1_ENTRIES: Readonly<Record<NlWave1EntryId, NlCatalogEntry>> = Object.freeze({
  'jira.issues': jiraIssues,
  'jira.release': jiraRelease,
  'github.items': githubItems,
  'slack.search': searchEntry('slack.search', 'Slack', ['slack', '슬랙'], '슬랙에서 키워드 검색.'),
  'confluence.search': searchEntry('confluence.search', 'Confluence', ['confluence', '컨플루언스', '컨플', '위키'], '컨플루언스(위키)에서 키워드로 문서 검색.'),
  'calendar.events': calendarEvents,
  'mail.list': mailList,
  'drive.files': driveFiles,
  'todo.list': todoList,
  'reminder.list': reminderList,
  'brief.today': briefToday,
  'help.topic': helpTopic,
});

/** The wave-1 entry of `id`. */
export function nlWave1Entry(id: NlWave1EntryId): NlCatalogEntry {
  return NL_WAVE1_ENTRIES[id];
}
