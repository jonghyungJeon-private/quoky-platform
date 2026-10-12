import { nlFlagArg, nlLimitArg, nlStringArg, type NlCatalogEntryId, type NlSelectedCommand } from '../nl-routing/catalog';
import { addLocalDays } from '../reminders/zoned-time';
import { isoDateOf } from '../nl-routing/symbolic-time';
import type { PersonalWorkRole, PersonalWorkStatus, PersonalWorkWindowField } from '../../ports/connector-query';
import type { WorkChatCommand, WorkChatPersonalWorkOptions, WorkChatSource } from './work-chat-command';

/**
 * ADR-0120 interfaces: a validated natural-language selection mapped to the existing typed work-chat commands. The
 * lookup handler serves `jira.issues`, `github.items`, `slack.search`, `confluence.search` and `todo.list`; everything
 * else (to-do writes, connector writes) stays on the anchored grammar. Pure.
 */

/** The catalog entry of each work source (ADR-0120 D1). */
export const WORK_CHAT_SOURCE_ENTRY: Readonly<Record<WorkChatSource, NlCatalogEntryId>> = {
  jira: 'jira.issues',
  github: 'github.items',
  slack: 'slack.search',
  confluence: 'confluence.search',
};

const ROLES: readonly string[] = ['assignee', 'reporter', 'either'];
const STATUSES: readonly string[] = ['open', 'all'];
const WINDOWS: readonly string[] = ['created', 'updated', 'due'];

/** The typed command for a selection, or `null` when the entry is not a work-chat read. */
export function workChatCommandForSelection(selected: NlSelectedCommand): WorkChatCommand | null {
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
    case 'github.items':
      return {
        kind: 'lookup',
        source: 'github',
        query: nlStringArg(args, 'query') === 'review-requests' ? 'review-requests' : 'my-items',
        ...(keyword !== undefined ? { text: keyword } : {}),
        ...bounded,
        ...listOnly,
      };
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
    case 'todo.list':
      return nlFlagArg(args, 'count') ? { kind: 'todo.summary' } : { kind: 'todo.list' };
    default:
      return null;
  }
}

/** ADR-0120 D13: window (from the Core-resolved range), role and status; `undefined` when all are the defaults. */
function jiraOptions(selected: NlSelectedCommand): WorkChatPersonalWorkOptions | undefined {
  const role = nlStringArg(selected.args, 'role');
  const status = nlStringArg(selected.args, 'status');
  const field = nlStringArg(selected.args, 'window');
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
  };
  return Object.keys(options).length === 0 ? undefined : options;
}

const COUNT_LABEL: Readonly<Record<WorkChatSource, { ko: string; en: string }>> = {
  jira: { ko: 'Jira 이슈', en: 'Jira issues' },
  github: { ko: 'GitHub 항목', en: 'GitHub items' },
  slack: { ko: 'Slack 검색 결과', en: 'Slack results' },
  confluence: { ko: 'Confluence 검색 결과', en: 'Confluence results' },
};

/** The first line of a count answer ("Jira 이슈 3개예요."). */
export function renderWorkChatCount(
  source: WorkChatSource,
  listed: { readonly count: number; readonly truncated: boolean },
  language: 'ko' | 'en',
): string {
  const label = COUNT_LABEL[source];
  if (language === 'en') return `${listed.count}${listed.truncated ? ' or more' : ''} ${label.en}.`;
  return `${label.ko} ${listed.count}개${listed.truncated ? ' 이상이에요' : '예요'}.`;
}
