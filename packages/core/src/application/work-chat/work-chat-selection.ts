import { nlFlagArg, nlLimitArg, nlStringArg, type NlWave1EntryId, type NlGrammarSelection, type NlSelectedCommand } from '../nl-routing/catalog';
import { addLocalDays } from '../reminders/zoned-time';
import { isoDateOf } from '../nl-routing/symbolic-time';
import type { PersonalWorkRole, PersonalWorkSort, PersonalWorkStatus, PersonalWorkWindowField } from '../../ports/connector-query';
import type { WorkChatCommand, WorkChatPersonalWorkOptions, WorkChatSource } from './work-chat-command';
import { parseJiraReleaseLinks } from './jira-release-link';

/**
 * ADR-0120 interfaces: a validated natural-language selection mapped to the existing typed work-chat commands. The
 * lookup handler serves `jira.issues`, `github.items`, `slack.search`, `confluence.search` and `todo.list`; everything
 * else (to-do writes, connector writes) stays on the anchored grammar. Pure.
 */

/** The catalog entry of each work source (ADR-0120 D1). */
export const WORK_CHAT_SOURCE_ENTRY: Readonly<Record<WorkChatSource, NlWave1EntryId>> = {
  jira: 'jira.issues',
  github: 'github.items',
  slack: 'slack.search',
  confluence: 'confluence.search',
};

/**
 * The `jira.release` lookup command of a natural-language selection turn (ADR-0120 A8), exactly as the lookup handler
 * runs it: the typed command, `confirmNear` (owner decision B, 2026-10-22: a selection turn can keep the confirmation)
 * and `inChannel` (A8 owner decision 7: the caller says whether the conversation is a channel without the grant). Shared
 * by the handler and the read scorers (`jiraReleaseOutcomeKey`), so both run one path.
 */
export function releaseCommandForSelection(
  selected: Pick<NlSelectedCommand, 'args' | 'language'>,
  groundingText: string,
  options: { readonly inChannel: boolean },
): Extract<WorkChatCommand, { kind: 'release' }> {
  const mapped = workChatCommandForSelection({ entryId: 'jira.release', args: selected.args, language: selected.language }, groundingText);
  if (mapped === null || mapped.kind !== 'release') throw new Error('jira.release maps to a release command');
  return { ...mapped, confirmNear: true, ...(options.inChannel ? { inChannel: true as const } : {}) };
}

const ROLES: readonly string[] = ['assignee', 'reporter', 'either'];
const STATUSES: readonly string[] = ['open', 'all', 'in-progress'];
const WINDOWS: readonly string[] = ['created', 'updated', 'due'];
const SORTS: readonly string[] = ['oldest', 'newest', 'recently-updated'];

/**
 * The typed command for a selection, or `null` when the entry is not a work-chat read. `groundingText` is the owner's own
 * non-quoted words of this turn: `jira.release` reads Jira release links from it (ADR-0120 A8), nothing else does.
 */
export function workChatCommandForSelection(selected: NlSelectedCommand, groundingText = ''): WorkChatCommand | null {
  const args = selected.args;
  const keyword = nlStringArg(args, 'keyword');
  const limit = nlLimitArg(args);
  const listOnly = nlFlagArg(args, 'count') ? { listOnly: true as const } : {};
  const bounded = limit !== undefined ? { limit } : {};
  switch (selected.entryId) {
    case 'jira.issues': {
      const personalWork = jiraOptions(selected);
      return {
        kind: 'lookup',
        source: 'jira',
        query: 'my-items',
        ...(keyword !== undefined ? { text: keyword } : {}),
        ...(personalWork !== undefined ? { personalWork } : {}),
        ...bounded,
        ...listOnly,
      };
    }
    case 'jira.release': {
      const release = nlStringArg(args, 'release');
      const project = nlStringArg(args, 'project');
      return {
        kind: 'release',
        source: 'jira',
        ...(release !== undefined ? { release } : {}),
        ...(project !== undefined ? { project } : {}),
        // ADR-0120 A8 owner decision 2: the owner's own items unless every assignee was asked for (grounded).
        scope: nlStringArg(args, 'scope') === 'all' ? 'all' : 'mine',
        links: parseJiraReleaseLinks(groundingText),
      };
    }
    case 'github.items': {
      const reviewRequests = nlStringArg(args, 'query') === 'review-requests';
      // Owner review 2026-10-21: the item type of the owner's own items (review requests are pull requests already).
      const kind = nlStringArg(args, 'kind');
      return {
        kind: 'lookup',
        source: 'github',
        query: reviewRequests ? 'review-requests' : 'my-items',
        ...(keyword !== undefined ? { text: keyword } : {}),
        ...bounded,
        ...listOnly,
        ...(!reviewRequests && (kind === 'pr' || kind === 'issue') ? { itemType: kind } : {}),
      };
    }
    case 'slack.search':
    case 'confluence.search':
      if (keyword === undefined) return null;
      return {
        kind: 'lookup',
        source: selected.entryId === 'slack.search' ? 'slack' : 'confluence',
        query: 'search',
        text: keyword,
        ...bounded,
        ...listOnly,
      };
    case 'todo.list': {
      // The status view (owner-approved 2026-10-15) is read-only and shows its own count line.
      const status = args.status === 'canceled' || args.status === 'completed' || args.status === 'all' ? args.status : undefined;
      if (status !== undefined) return { kind: 'todo.list', status };
      return nlFlagArg(args, 'count') ? { kind: 'todo.summary' } : { kind: 'todo.list' };
    }
    default:
      return null;
  }
}

/**
 * The reverse of {@link workChatCommandForSelection} (ADR-0120 follow-up): the canonical catalog selection of a listing
 * the work-chat grammar answered, or `null` when the command is not a catalog read (to-do writes, hints, usage lines,
 * connector writes). Pure; content-free apart from a keyword the owner typed, like every stored selection.
 */
export function nlSelectionForWorkChatCommand(command: WorkChatCommand): NlGrammarSelection | null {
  switch (command.kind) {
    case 'todo.list':
      return { entryId: 'todo.list', args: command.status !== undefined ? { status: command.status } : {} };
    case 'todo.summary':
      return { entryId: 'todo.list', args: {} };
    case 'lookup': {
      const keyword: Record<string, string> = command.text !== undefined ? { keyword: command.text } : {};
      switch (command.source) {
        case 'jira':
          // "이번 주 마감" is the due window of this week (the same normalization the selector's `due` gets).
          return command.query === 'due-this-week'
            ? { entryId: 'jira.issues', args: { window: 'due', range: 'this-week' } }
            : command.query === 'my-items'
              ? { entryId: 'jira.issues', args: { ...keyword } }
              : null;
        case 'github':
          return command.query === 'review-requests'
            ? { entryId: 'github.items', args: { query: 'review-requests', ...keyword } }
            : command.query === 'my-items'
              ? { entryId: 'github.items', args: { ...keyword, ...(command.itemType !== undefined ? { kind: command.itemType } : {}) } }
              : null;
        case 'slack':
        case 'confluence':
          return command.query === 'search' && command.text !== undefined
            ? { entryId: command.source === 'slack' ? 'slack.search' : 'confluence.search', args: { keyword: command.text } }
            : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/** ADR-0120 D13: window (from the Core-resolved range), role and status; `undefined` when all are the defaults. */
function jiraOptions(selected: NlSelectedCommand): WorkChatPersonalWorkOptions | undefined {
  const role = nlStringArg(selected.args, 'role');
  const status = nlStringArg(selected.args, 'status');
  const field = nlStringArg(selected.args, 'window');
  const sort = nlStringArg(selected.args, 'sort');
  const range = selected.range;
  const window =
    field !== undefined && WINDOWS.includes(field) && range !== undefined
      ? {
          field: field as PersonalWorkWindowField,
          from: isoDateOf(range.startDate),
          to: isoDateOf(addLocalDays(range.startDate, range.days)),
          // The same boundaries as instants (QUOKY_TIMEZONE midnights), for timestamp fields read in another zone.
          fromInstant: range.from,
          toInstant: range.to,
        }
      : undefined;
  const options: WorkChatPersonalWorkOptions = {
    ...(window !== undefined ? { window } : {}),
    ...(role !== undefined && role !== 'assignee' && ROLES.includes(role) ? { role: role as PersonalWorkRole } : {}),
    ...(status !== undefined && status !== 'open' && STATUSES.includes(status) ? { status: status as PersonalWorkStatus } : {}),
    ...(sort !== undefined && SORTS.includes(sort) ? { sort: sort as PersonalWorkSort } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : options;
}

const COUNT_LABEL: Readonly<Record<WorkChatSource, { ko: string; en: string }>> = {
  jira: { ko: 'Jira 이슈', en: 'Jira issues' },
  github: { ko: 'GitHub 항목', en: 'GitHub items' },
  slack: { ko: 'Slack 검색 결과', en: 'Slack results' },
  confluence: { ko: 'Confluence 검색 결과', en: 'Confluence results' },
};

/**
 * Owner review of 2026-10-21 (ap-p067, "count 와 일부 내역들도 같이"): a count answer shows the count and then at most this
 * many items of the list (the first ones in the source's order), never the whole list.
 */
export const WORK_CHAT_COUNT_PREVIEW_ITEMS = 5;

/** The first line of a count answer ("Jira 이슈 3개예요.", "… 12개예요. 처음 5개만 보여드려요."). */
export function renderWorkChatCount(
  source: WorkChatSource,
  listed: { readonly count: number; readonly truncated: boolean; readonly shown?: number },
  language: 'ko' | 'en',
): string {
  const label = COUNT_LABEL[source];
  const preview = listed.shown !== undefined && listed.shown < listed.count;
  if (language === 'en') return `${listed.count}${listed.truncated ? ' or more' : ''} ${label.en}.${preview ? ` Showing the first ${listed.shown}.` : ''}`;
  return `${label.ko} ${listed.count}개${listed.truncated ? ' 이상이에요' : '예요'}.${preview ? ` 처음 ${listed.shown}개만 보여드려요.` : ''}`;
}
