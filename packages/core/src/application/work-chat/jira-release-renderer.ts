import type { MessageBody, UntrustedTextNode } from '../../domain';
import type { ConnectorItem } from '../../ports';
import { fitLines, joinMessage, messageBody, messageContent, messageLink, untrustedText } from '../message-rendering';
import type { MessagePart } from '../message-rendering';
import { WORK_CHAT_REPLY_MAX_CHARS, certainlyRenderedRows, safeLinkUrl } from './work-chat-renderer';

/**
 * ADR-0120 amendment A8: deterministic Korean copy for a Jira release listing, in the shape of Jira's release report:
 * a count line per status group (완료 · 진행 중 · 할 일), then each group with key, summary, assignee, status and link,
 * and the release page link. Pure. Every Jira text (summary, assignee, status, project and release names) is an
 * untrusted span; the reply stays inside the work-chat message budget (item lines are dropped from the end first, with
 * the usual note, and the release page link is kept).
 */

const TITLE_MAX_CHARS = 60;
const NAME_MAX_CHARS = 40;
const OMITTED_NOTE = '(길이 때문에 일부는 생략했어요)';
const RELEASE_LIST_MAX_ROWS = 10;
const NEARBY_MAX = 5;
const CANDIDATES_MAX = 5;

export type ReleaseScope = 'mine' | 'all';

export interface ReleaseProjectRef {
  readonly key: string;
  readonly name?: string;
}

const GROUPS: ReadonlyArray<{ readonly key: 'done' | 'in-progress' | 'todo'; readonly label: string }> = [
  { key: 'done', label: '완료' },
  { key: 'in-progress', label: '진행 중' },
  { key: 'todo', label: '할 일' },
];

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`;
}

function display(text: string, maxChars = TITLE_MAX_CHARS): UntrustedTextNode {
  return untrustedText(clip(text, maxChars));
}

function fit(lines: ReadonlyArray<{ text: MessagePart; droppable?: boolean }>): MessageBody {
  return messageBody(fitLines(lines.map((line) => ({ content: line.text, ...(line.droppable ? { droppable: true } : {}) })), WORK_CHAT_REPLY_MAX_CHARS, OMITTED_NOTE));
}

function projectLabel(project: ReleaseProjectRef | undefined): MessagePart {
  if (project === undefined) return '';
  return project.name !== undefined && project.name !== project.key
    ? messageContent(display(project.name, NAME_MAX_CHARS), ` (${project.key})`)
    : project.key;
}

function scopeLabel(scope: ReleaseScope): string {
  return scope === 'mine' ? '내 담당' : '전체 담당';
}

/** The status group of an item: the neutral category, else "할 일" (Jira's report puts an unknown category there). */
function groupOf(item: ConnectorItem): 'done' | 'in-progress' | 'todo' {
  return item.statusCategory ?? 'todo';
}

export interface ReleaseIssuesView {
  readonly project?: ReleaseProjectRef;
  /** The release name as Jira spells it, or the owner's words when Jira's own name is unknown. */
  readonly releaseName?: string;
  readonly releaseUrl?: string;
  readonly scope: ReleaseScope;
  readonly items: readonly ConnectorItem[];
  readonly truncated: boolean;
  /** A link on another host was in the message and was ignored (never fetched). */
  readonly ignoredLink?: boolean;
  /** A DM: an empty own-items answer says how to ask for every assignee. */
  readonly offerAllScope?: boolean;
  /** A6 R2 (D1): number the issue rows `1.` … `n.` in display order (while `QUOKY_NL_ITEM_R2` is not `off`). */
  readonly numbered?: boolean;
}

/** A6 R2: the issues in the order the report shows them (grouped: to do, in progress, done). */
export function releaseIssuesInDisplayOrder(items: readonly ConnectorItem[]): ConnectorItem[] {
  return GROUPS.flatMap((group) => items.filter((item) => groupOf(item) === group.key));
}

/** The release report: header, counts per group, the grouped items, the release page link. */
export function renderReleaseIssues(view: ReleaseIssuesView): MessageBody {
  return releaseIssues(view).body;
}

/**
 * A6 R2: the release report numbered (`view.numbered`) and how many leading issue rows it certainly shows (the group
 * headings are droppable too and are charged as rows, so the count stays conservative).
 */
export function renderNumberedReleaseIssues(view: ReleaseIssuesView): { readonly body: MessageBody; readonly labelled: number } {
  return releaseIssues({ ...view, numbered: true });
}

function releaseIssues(view: ReleaseIssuesView): { readonly body: MessageBody; readonly labelled: number } {
  const lines: Array<{ text: MessagePart; droppable?: boolean; row?: boolean }> = [];
  if (view.ignoredLink === true) lines.push({ text: renderIgnoredLinkNote() });
  const release = view.releaseName !== undefined ? messageContent('릴리스 ', display(view.releaseName, NAME_MAX_CHARS)) : '링크의 릴리스';
  const where = view.project !== undefined ? messageContent(' · ', projectLabel(view.project)) : '';
  lines.push({ text: messageContent('**Jira ', release, '**', where, ` · ${scopeLabel(view.scope)}`) });
  if (view.items.length === 0) {
    lines.push({ text: view.scope === 'mine' ? '이 릴리스에 내 담당 이슈가 없어요.' : '이 릴리스에 포함된 이슈가 없어요.' });
    if (view.scope === 'mine' && view.offerAllScope === true) lines.push({ text: "전체 담당으로 보려면 '전체 담당'이라고 말씀해 주세요" });
  } else {
    const counts = GROUPS.map((group) => ({ ...group, items: view.items.filter((item) => groupOf(item) === group.key) }));
    const summary = counts.map((group) => `${group.label} ${group.items.length}`).join(' · ');
    lines.push({
      text: view.truncated
        ? `이슈 ${view.items.length}건 이상 — 표시한 ${view.items.length}건 기준: ${summary} (일부만 표시, 전체는 릴리스 페이지에서)`
        : `이슈 ${view.items.length}건: ${summary}`,
    });
    let shown = 0;
    for (const group of counts) {
      if (group.items.length === 0) continue;
      lines.push({ text: `${group.label} (${group.items.length})`, droppable: true });
      for (const item of group.items) {
        shown += 1;
        lines.push({ text: renderItemLine(item, view.numbered === true ? shown : undefined), droppable: true, ...(view.numbered === true ? { row: true } : {}) });
      }
    }
  }
  const pageUrl = safeLinkUrl(view.releaseUrl);
  if (pageUrl !== undefined) lines.push({ text: messageContent('릴리스 페이지: ', messageLink(pageUrl)) });
  if (view.numbered !== true) return { body: fit(lines), labelled: 0 };
  // Rows and headings drop from the end together: count the issue rows inside the droppable prefix that certainly fits.
  const fits = certainlyRenderedRows(lines);
  let droppable = 0;
  let labelled = 0;
  for (const line of lines) {
    if (line.droppable !== true) continue;
    if (droppable >= fits) break;
    droppable += 1;
    if (line.row === true) labelled += 1;
  }
  return { body: fit(lines), labelled };
}

function renderItemLine(item: ConnectorItem, number?: number): MessagePart {
  const meta = [item.assignee ?? '담당자 없음', item.status].filter((part): part is string => part !== undefined && part.length > 0).map((part) => display(part, NAME_MAX_CHARS));
  const url = safeLinkUrl(item.url);
  return messageContent(
    number !== undefined ? `${number}. [` : '- [',
    untrustedText(item.id.replace(/\s+/g, ' ')),
    '] ',
    display(item.title),
    meta.length > 0 ? messageContent(' · ', joinMessage(meta, ' · ')) : '',
    url !== undefined ? messageContent(' ', messageLink(url)) : '',
  );
}

/** The releases of a project (the owner named a project and no release): newest first, at most 10. */
export function renderReleaseList(project: ReleaseProjectRef, releases: readonly ConnectorItem[], truncated: boolean, ignoredLink = false): MessageBody {
  const lines: Array<{ text: MessagePart; droppable?: boolean }> = [];
  if (ignoredLink) lines.push({ text: renderIgnoredLinkNote() });
  if (releases.length === 0) {
    lines.push({ text: messageContent(projectLabel(project), '에는 보이는 릴리스가 없어요.') });
    return fit(lines);
  }
  const unreleased = releases.filter((item) => item.status === 'unreleased').length;
  const shown = releases.slice(0, RELEASE_LIST_MAX_ROWS);
  const more = releases.length > shown.length || truncated;
  lines.push({
    text: messageContent(
      '**',
      projectLabel(project),
      ' 릴리스**',
      ` (미출시 ${unreleased} · 출시 ${releases.length - unreleased}${truncated ? ' 이상' : ''}${more ? `, 최근 ${shown.length}개 표시` : ''})`,
    ),
  });
  for (const item of shown) {
    const date = item.dueDate !== undefined ? ` · ${item.dueDate}` : '';
    lines.push({ text: messageContent('- ', display(item.title, NAME_MAX_CHARS), ` · ${item.status === 'released' ? '출시됨' : '미출시'}${date}`), droppable: true });
  }
  lines.push({ text: '릴리스 이름을 말씀하시면 그 릴리스의 이슈를 보여드릴게요.' });
  return fit(lines);
}

/** No visible project matches the owner's words. */
export function renderProjectNotFound(text: string, ignoredLink = false): MessageBody {
  return fit([
    ...(ignoredLink ? [{ text: renderIgnoredLinkNote() as MessagePart }] : []),
    { text: messageContent('"', display(text, NAME_MAX_CHARS), '"에 맞는 Jira 프로젝트를 찾지 못했어요. 프로젝트 키(예: ABC)나 정확한 이름으로 다시 말씀해 주세요.') },
  ]);
}

/** Several visible projects match: the owner is asked which one (never guessed). */
export function renderProjectAmbiguous(text: string, candidates: readonly ReleaseProjectRef[]): MessageBody {
  return fit([
    { text: messageContent('"', display(text, NAME_MAX_CHARS), '"에 맞는 Jira 프로젝트가 여러 개예요. 어느 프로젝트인가요?') },
    ...candidates.slice(0, CANDIDATES_MAX).map((candidate) => ({ text: messageContent('- ', projectLabel(candidate)) })),
    { text: '프로젝트 이름이나 키로 다시 말씀해 주세요.' },
  ]);
}

/** The project has no release of that name: up to five of its release names, read-only. */
export function renderReleaseNotFound(text: string, project: ReleaseProjectRef | undefined, nearby: readonly ConnectorItem[]): MessageBody {
  const where = project !== undefined ? messageContent(projectLabel(project), '에서 ') : '';
  const lines: Array<{ text: MessagePart; droppable?: boolean }> = [
    { text: messageContent(where, '"', display(text, NAME_MAX_CHARS), '" 릴리스를 찾지 못했어요.') },
  ];
  if (nearby.length > 0) {
    lines.push({ text: messageContent('비슷한 릴리스: ', joinMessage(nearby.slice(0, NEARBY_MAX).map((item) => display(item.title, NAME_MAX_CHARS)), ', ')) });
  } else if (project === undefined) {
    lines.push({ text: '프로젝트 이름도 함께 말씀해 주시면 그 프로젝트에서 찾아볼게요.' });
  }
  return fit(lines);
}

/**
 * ADR-0120 A8 owner decision 7 (2026-10-15): in a channel, every-assignee scope and the project / release lists are
 * refused until the A9 surface permissions exist; nothing was read for the refused part.
 */
export function renderReleaseDmOnly(what: 'all' | 'list'): MessageBody {
  return fit([{ text: what === 'all' ? '전체 담당 릴리스 조회는 DM에서만 할 수 있어요.' : '프로젝트·릴리스 목록은 DM에서만 볼 수 있어요. 릴리스 이름을 정확히 말씀해 주시거나 DM에서 물어봐 주세요.' }]);
}

/** Nothing to read: no release, no project and no usable link. */
export function renderReleaseUsage(ignoredLink = false): MessageBody {
  return fit([
    ...(ignoredLink ? [{ text: renderIgnoredLinkNote() as MessagePart }] : []),
    { text: '어느 릴리스를 볼까요? "ABC 프로젝트 1.2.0 릴리스 보여줘"처럼 프로젝트와 릴리스 이름을 말씀하시거나, 설정된 Jira 사이트의 릴리스 링크를 보내 주세요.' },
  ]);
}

function renderIgnoredLinkNote(): string {
  return '설정된 Jira 사이트의 링크가 아니라서 그 링크는 열지 않았어요.';
}
