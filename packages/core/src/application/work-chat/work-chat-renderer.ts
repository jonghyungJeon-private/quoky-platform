import { WorkItemStatus } from '../../domain';
import type { MessageBody, ResourceRef, UntrustedTextNode, WorkItem } from '../../domain';
import { CONNECTOR_QUERY_MAX_LIMIT } from '../../ports';
import type { ConnectorQueryErrorReason } from '../../ports';
import { fitLines, joinMessage, messageBody, messageContent, messageLink, plainTextOf, untrustedText } from '../message-rendering';
import type { MessagePart } from '../message-rendering';
import type { WorkSurface, WorkSurfaceSource, WorkSurfaceSourceStatus } from '../work-surface-query';
import type { ExternalWorkReadout } from './external-work-readout';
import { WORK_CHAT_SEARCH_TEXT_MAX_LENGTH } from './work-chat-command';
import type {
  WorkChatLookupQuery,
  WorkChatSource,
  WorkChatTarget,
  WorkChatUsageTopic,
} from './work-chat-command';

/**
 * Deterministic Korean copy for work-chat replies (ADR-0100). Pure: every function maps data to text, never reads a
 * clock or calls a connector. Item and external text is an untrusted span the platform neutralizes (mentions, markup,
 * masked links; PLT-0), links are link spans, and every reply is bounded to the message budget of its rendering.
 */

/** Below the 1,900-character message budget so a footer or notice can still be appended. */
export const WORK_CHAT_REPLY_MAX_CHARS = 1800;
const TODO_LIST_MAX_ROWS = 15;
/** The candidate rows an ambiguous to-do reply shows (and so records as the listing, A6-D2 amendment). */
export const TODO_AMBIGUOUS_MAX_ROWS = TODO_LIST_MAX_ROWS;
const EXTERNAL_LIST_MAX_ROWS = 10;
const LIST_TITLE_MAX_CHARS = 80;
const REFS_SHOWN = 3;
const OMITTED_NOTE = '(길이 때문에 일부는 생략했어요)';

const SOURCE_LABEL: Readonly<Record<WorkChatSource, string>> = {
  jira: 'Jira',
  github: 'GitHub',
  slack: 'Slack',
  confluence: 'Confluence',
};

const QUERY_LABEL: Readonly<Record<WorkChatLookupQuery, string>> = {
  'my-items': '내 항목',
  'due-this-week': '이번 주 마감',
  'review-requests': '리뷰 요청',
  search: '검색',
};

/** Lines the to-do and lookup handlers contribute to the help reply (ADR-0096 D6). */
export const WORK_CHAT_TODO_HELP_LINES: readonly string[] = [
  '할 일: "할 일 추가: 내용", "완료 처리: 번호", "할 일 취소: 번호", "할 일 연결: 번호 Jira KEY-1"',
];
export const WORK_CHAT_LOOKUP_HELP_LINES: readonly string[] = [
  '업무 조회: "내 할 일 보여줘", "내 Jira 이슈", "GitHub 리뷰 요청 PR", "Slack에서 배포 검색" (읽기 전용)',
];

function sourceLabel(source: WorkChatSource): string {
  return SOURCE_LABEL[source];
}

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`;
}

/** Single-line untrusted text (whitespace collapsed), for an identity or a ref. */
function inline(text: string): UntrustedTextNode {
  return untrustedText(text.replace(/\s+/g, ' '));
}

/** Clipped, single-line untrusted display text for an item title. */
function display(text: string, maxChars = LIST_TITLE_MAX_CHARS): UntrustedTextNode {
  return untrustedText(clip(text, maxChars));
}

function titleOf(item: WorkItem, maxChars?: number): MessagePart {
  return item.title ? display(item.title, maxChars) : '(제목 없는 항목)';
}

function refList(refs: readonly ResourceRef[]): MessageBody {
  const shown = joinMessage(refs.slice(0, REFS_SHOWN).map((ref) => inline(ref.identity)), ', ');
  const more = refs.length > REFS_SHOWN ? ` 외 ${refs.length - REFS_SHOWN}건` : '';
  return messageContent(shown, more);
}

/**
 * Join lines within the reply budget. Lines marked `droppable` are removed from the end first; a note records that
 * something was cut. The last resort is a hard slice, so the result never exceeds the budget. The budget applies to
 * the delivered (rendered) text of each platform.
 */
function fit(lines: ReadonlyArray<{ text: MessagePart; droppable?: boolean }>, maxChars = WORK_CHAT_REPLY_MAX_CHARS): MessageBody {
  return messageBody(fitLines(lines.map((line) => ({ content: line.text, ...(line.droppable ? { droppable: true } : {}) })), maxChars, OMITTED_NOTE));
}

// ---------------------------------------------------------------------------------------------------------------------
// To-do mutations
// ---------------------------------------------------------------------------------------------------------------------

export function renderTodoAdded(item: WorkItem, reminderShaped = false): MessageBody {
  const refs = item.resourceRefs.length > 0 ? messageContent(' (연결: ', refList(item.resourceRefs), ')') : '';
  return fit([
    { text: messageContent('할 일을 추가했어요: "', titleOf(item, 200), '"', refs) },
    ...(reminderShaped
      ? [{ text: '알림은 설정하지 않았어요. 알림이 필요하면 "내일 9시에 회의 알려줘"처럼 따로 보내 주세요.' }]
      : []),
  ]);
}

/**
 * Answer to a status question about one to-do (QA-V2-W7-05); `no` is its list number when it is still open. `undefined`
 * (A6-D2 amendment, 2026-10-16): the owner's fresh to-do listing does not show it, so no number is named that the
 * numbered command would resolve differently.
 */
export function renderTodoStatusAnswer(item: WorkItem, no: number | undefined): MessageBody {
  const title = titleOf(item, 120);
  if (item.status === WorkItemStatus.COMPLETED) return fit([{ text: messageContent('"', title, '"는 완료 처리된 할 일이에요.') }]);
  if (item.status === WorkItemStatus.CANCELED) return fit([{ text: messageContent('"', title, '"는 취소된 할 일이에요.') }]);
  if (no === undefined) return fit([{ text: messageContent('"', title, `"는 아직 열린 할 일이에요. 번호는 "내 할 일"로 확인해 주세요.`) }]);
  return fit([{ text: messageContent('"', title, `"는 아직 열린 할 일이에요 (${no}번). 완료하려면 "완료 처리: ${no}"라고 보내 주세요.`) }]);
}

/**
 * Hint for an unanchored "<title> 완료" statement (QA-V2-W7-03): nothing was changed; the exact command is named.
 * `no` undefined (A6-D2 amendment, 2026-10-16): the fresh listing does not show the item, so the command names no number.
 */
export function renderTodoCompletionHint(action: 'complete' | 'cancel', no: number | undefined, item: WorkItem): MessageBody {
  const verb = action === 'complete' ? '완료 처리' : '취소';
  if (no === undefined) {
    const form = action === 'complete' ? '완료 처리: 번호' : '할 일 취소: 번호';
    return fit([
      { text: messageContent('"', titleOf(item, 120), `" 할 일을 ${verb}하려면 "내 할 일"로 번호를 확인한 뒤 "${form}"라고 보내 주세요. 아직 아무것도 바꾸지 않았어요.`) },
    ]);
  }
  const command = action === 'complete' ? `완료 처리: ${no}` : `할 일 취소: ${no}`;
  return fit([
    { text: messageContent('"', titleOf(item, 120), `" 할 일을 ${verb}하려면 "${command}"라고 보내 주세요. 아직 아무것도 바꾸지 않았어요.`) },
  ]);
}

export function renderTodoCompleted(item: WorkItem): MessageBody {
  return fit([{ text: messageContent('할 일을 완료 처리했어요: "', titleOf(item, 200), '"') }]);
}

export function renderTodoCanceled(item: WorkItem): MessageBody {
  return fit([{ text: messageContent('할 일을 취소했어요: "', titleOf(item, 200), '"') }]);
}

export function renderTodoLinked(item: WorkItem, added: readonly ResourceRef[]): MessageBody {
  if (added.length === 0) {
    return fit([{ text: messageContent('이미 연결돼 있어요: "', titleOf(item, 200), '" (연결: ', refList(item.resourceRefs), ')') }]);
  }
  return fit([
    { text: messageContent('할 일에 연결했어요: "', titleOf(item, 200), '"') },
    { text: messageContent('추가된 연결: ', refList(added)) },
    { text: '연결할 때 외부 시스템은 조회하지 않았어요.' },
  ]);
}

const ACTION_LABEL = { complete: '완료 처리', cancel: '취소', link: '연결' } as const;

/**
 * How many candidate rows `renderTodoAmbiguous` certainly shows (and so records as the listing): the same conservative
 * rendered-budget count as `renderedTodoRows` (each row at twice its plain length, the worst escaping).
 */
export function renderedAmbiguousRows(candidates: ReadonlyArray<{ no: number; item: WorkItem }>): number {
  const budget = WORK_CHAT_REPLY_MAX_CHARS - 400;
  let used = 0;
  let shown = 0;
  for (const { no, item } of candidates.slice(0, TODO_AMBIGUOUS_MAX_ROWS)) {
    const title = Array.from(clip(item.title ?? '(제목 없는 항목)', LIST_TITLE_MAX_CHARS)).length;
    const length = `${no}. `.length + 2 * title + 1;
    if (used + length > budget) break;
    used += length;
    shown += 1;
  }
  return shown;
}

/** Several to-dos match: nothing changed; the candidates are listed with their list numbers. */
export function renderTodoAmbiguous(
  action: keyof typeof ACTION_LABEL,
  candidates: ReadonlyArray<{ no: number; item: WorkItem }>,
): MessageBody {
  const shown = renderedAmbiguousRows(candidates);
  const rows = candidates.slice(0, shown).map(({ no, item }) => ({
    text: messageContent(`${no}. `, titleOf(item)),
    droppable: true,
  }));
  const more = candidates.length - shown;
  return fit([
    { text: `일치하는 할 일이 여러 개라 아무것도 ${ACTION_LABEL[action]}하지 않았어요. 번호로 지정해 주세요.` },
    ...rows,
    ...(more > 0 ? [{ text: `외 ${more}건` }] : []),
  ]);
}

export function renderTodoNotFound(target: WorkChatTarget, activeCount: number): MessageBody {
  const what = 'index' in target ? `${target.index}번 할 일` : messageContent('"', display(target.text, 60), '"와 일치하는 할 일');
  const hint = activeCount === 0 ? '열린 할 일이 없어요.' : `열린 할 일은 ${activeCount}건이에요. "내 할 일"로 번호를 확인해 주세요.`;
  return fit([{ text: messageContent(what, `을 찾지 못해서 아무것도 바꾸지 않았어요. ${hint}`) }]);
}

/**
 * A6-D2 amendment (2026-10-16): a numbered command named a number of the owner's fresh to-do listing that no longer
 * points at an open to-do (`gone`: completed, canceled or deleted since) or that the listing never showed (`unlisted`).
 * Nothing changed; the current open list follows, numbered as the next listing snapshot records it (`shown` rows).
 */
export function renderTodoSnapshotDrift(
  drift: { readonly kind: 'gone'; readonly label: number; readonly item?: WorkItem } | { readonly kind: 'unlisted'; readonly label: number },
  todos: readonly WorkItem[],
  shown: number,
): MessageBody {
  let head: MessagePart;
  if (drift.kind === 'unlisted') {
    head = `아까 보여드린 할 일 목록에는 ${drift.label}번이 없어서 아무것도 바꾸지 않았어요.`;
  } else if (drift.item === undefined) {
    head = `아까 보여드린 할 일 목록의 ${drift.label}번은 지금 찾을 수 없어서 아무것도 바꾸지 않았어요.`;
  } else {
    const state = drift.item.status === WorkItemStatus.COMPLETED ? '이미 완료된' : '이미 취소된';
    head = messageContent(`아까 보여드린 할 일 목록의 ${drift.label}번 "`, titleOf(drift.item, 120), `"는 ${state} 할 일이라 아무것도 바꾸지 않았어요.`);
  }
  const lines: Array<{ text: MessagePart; droppable?: boolean }> = [{ text: head }];
  if (todos.length === 0) {
    lines.push({ text: '지금 열린 할 일이 없어요.' });
  } else {
    lines.push({ text: `지금 열린 할 일이에요 (${todos.length}건). 번호를 확인하고 다시 보내 주세요.` });
    todos.slice(0, shown).forEach((item, index) => lines.push({ text: messageContent(`${index + 1}. `, titleOf(item)) }));
    if (todos.length > shown) lines.push({ text: `외 ${todos.length - shown}건` });
  }
  return fit(lines);
}

export function renderTodoEmptyTitle(): string {
  return '할 일 내용이 비어 있어서 추가하지 않았어요. 예: 할 일 추가: 주간 보고서 쓰기';
}

export function renderTodoTitleTooLong(maxChars: number): string {
  return `할 일 내용이 너무 길어서 추가하지 않았어요. ${maxChars}자 이하로 줄여 주세요.`;
}

export function renderTodoCredentialRefused(): string {
  return '할 일 내용에 비밀번호나 토큰 같은 민감한 값이 들어 있는 것 같아서 저장하지 않았어요. 값을 빼고 다시 알려 주세요.';
}

export function renderTodoTooManyRefs(maxRefs: number): string {
  return `한 할 일에는 외부 항목을 ${maxRefs}개까지만 연결할 수 있어요. 아무것도 바꾸지 않았어요.`;
}

export function renderTodoNotActive(): string {
  return '이미 완료되었거나 취소된 할 일이라 바꿀 수 없어요. 아무것도 바꾸지 않았어요.';
}

export function renderTodoFailure(): string {
  return '할 일을 처리하는 중에 문제가 생겼어요. 아무것도 바뀌지 않았을 수 있으니 "내 할 일"로 확인해 주세요.';
}

/** A read-only list that failed changed nothing, so it never tells the user to re-check with the same command. */
export function renderTodoListFailure(): string {
  return '할 일 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
}

export function renderSearchCredentialRefused(): string {
  return '검색어에 비밀번호나 토큰 같은 민감한 값이 들어 있는 것 같아서 외부 시스템에 보내지 않았어요.';
}

export function renderWorkChatUsage(topic: WorkChatUsageTopic): string {
  switch (topic) {
    case 'todo-add':
      return '추가할 내용을 알려 주세요. 예: 할 일 추가: 주간 보고서 쓰기';
    case 'todo-complete':
      return '완료할 할 일을 알려 주세요. 예: 완료 처리: 2 (번호는 "내 할 일"에서 확인해요)';
    case 'todo-cancel':
      return '취소할 할 일을 알려 주세요. 예: 할 일 취소: 2 (번호는 "내 할 일"에서 확인해요)';
    case 'todo-link':
      return '연결할 할 일과 외부 항목을 함께 알려 주세요. 예: 할 일 연결: 2 Jira PROJ-123 (GitHub는 owner/repo#12 또는 이슈 링크)';
    case 'search':
      return '검색어를 알려 주세요. 예: Slack에서 배포 검색, Confluence에서 온보딩 찾아줘';
    case 'search-too-long':
      return `검색어가 너무 길어요. ${WORK_CHAT_SEARCH_TEXT_MAX_LENGTH}자 이하로 줄여 주세요.`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Combined "my work" view
// ---------------------------------------------------------------------------------------------------------------------

const SURFACE_STATUS_LINE: Readonly<Record<Exclude<WorkSurfaceSourceStatus, 'AVAILABLE'>, string>> = {
  NOT_CONFIGURED: '연결이 설정되어 있지 않아요',
  IDENTITY_MISSING: '내 계정 정보(identity)가 설정되어 있지 않아요',
  UNAVAILABLE: '지금 연결할 수 없어요',
};

/**
 * One combined view (ADR-0100 D3): the owner's ACTIVE to-dos first, numbered in the order given (the same numbers
 * `완료 처리: N` resolves), then Jira/GitHub personal work. Sources that could not be read are named, and a partial
 * result is never presented as "no work". `surface` is null when it could not be read at all.
 */
/** ADR-0122 D2.4: the fixed line of a "my work" view whose Jira and GitHub sections the channel does not allow (not read). */
export const MY_WORK_SECTIONS_WITHHELD_LINE = 'Jira·GitHub 항목은 이 채널에서 허용되지 않아 뺐어요.';
/** ADR-0122 D2.4: the status line of one section the channel does not allow (not read). */
export const MY_WORK_SOURCE_WITHHELD_STATUS = '이 채널에서 허용되지 않아 뺐어요';

/**
 * `withheld` (ADR-0122 D2.4, P2): the Jira / GitHub sections a channel's permit does not allow — never read, each named
 * with a fixed line; both withheld replace the section with one fixed line. Empty (the default): exactly as before.
 */
export function renderMyWork(todos: readonly WorkItem[], surface: WorkSurface | null, withheld: readonly WorkSurfaceSource[] = []): MessageBody {
  const lines: Array<{ text: MessagePart; droppable?: boolean }> = [];

  lines.push({ text: `**내 할 일** (${todos.length}건)` });
  if (todos.length === 0) {
    lines.push({ text: '열린 할 일이 없어요. "할 일 추가: 내용"으로 추가할 수 있어요.' });
  } else {
    todos.slice(0, TODO_LIST_MAX_ROWS).forEach((item, index) => {
      const refs = item.resourceRefs.length > 0 ? messageContent(' (연결: ', refList(item.resourceRefs), ')') : '';
      lines.push({ text: messageContent(`${index + 1}. `, titleOf(item), refs), droppable: true });
    });
    if (todos.length > TODO_LIST_MAX_ROWS) lines.push({ text: `외 ${todos.length - TODO_LIST_MAX_ROWS}건`, droppable: true });
  }

  lines.push({ text: '' });
  if (withheld.includes('jira') && withheld.includes('github')) {
    lines.push({ text: '**Jira·GitHub 업무**' });
    lines.push({ text: MY_WORK_SECTIONS_WITHHELD_LINE });
  } else if (surface === null) {
    lines.push({ text: '**Jira·GitHub 업무**' });
    lines.push({ text: '지금은 Jira·GitHub 업무를 불러오지 못했어요. 로컬 할 일만 보여드려요.' });
  } else {
    lines.push({ text: `**Jira·GitHub 업무** (${surface.items.length}건)` });
    if (surface.items.length === 0) {
      lines.push({
        text:
          surface.status === 'COMPLETE' && withheld.length === 0
            ? 'Jira와 GitHub에서 확인된 업무가 없어요.'
            : surface.status === 'COMPLETE'
              ? '확인한 소스에는 업무가 없어요.'
            : '확인 가능한 소스에는 업무가 없어요. 확인하지 못한 소스가 있으니 아래 상태를 확인해 주세요.',
      });
    } else {
      for (const item of surface.items.slice(0, EXTERNAL_LIST_MAX_ROWS)) {
        const url = safeLinkUrl(item.url);
        lines.push({
          text: messageContent('- [', inline(item.resource.identity), '] ', display(item.title), url ? messageContent(' ', messageLink(url)) : ''),
          droppable: true,
        });
      }
      if (surface.items.length > EXTERNAL_LIST_MAX_ROWS) {
        lines.push({ text: `외 ${surface.items.length - EXTERNAL_LIST_MAX_ROWS}건`, droppable: true });
      }
    }
    for (const source of surface.sources) {
      if (source.status === 'AVAILABLE') continue;
      const label = sourceLabel(source.source);
      lines.push({ text: `- ${label}: ${SURFACE_STATUS_LINE[source.status]}` });
    }
    for (const source of withheld) lines.push({ text: `- ${sourceLabel(source)}: ${MY_WORK_SOURCE_WITHHELD_STATUS}` });
  }
  return fit(lines);
}

const TODO_STATUS_VIEW_TITLE: Readonly<Record<'canceled' | 'completed' | 'all', string>> = {
  canceled: '취소된 할 일',
  completed: '완료한 할 일',
  all: '전체 할 일',
};
const TODO_STATUS_LABEL: Readonly<Record<string, string>> = { ACTIVE: '진행 중', COMPLETED: '완료', CANCELED: '취소' };

/**
 * A read-only status view of the owner's to-dos (owner-approved 2026-10-15): bullets with each item's status, never
 * numbered (the numbers of the open list are the ones "N번 완료" refers to).
 */
export function renderTodoStatusList(todos: readonly WorkItem[], status: 'canceled' | 'completed' | 'all'): MessageBody {
  const lines: Array<{ text: MessagePart; droppable?: boolean }> = [{ text: `**${TODO_STATUS_VIEW_TITLE[status]}** (${todos.length}건)` }];
  if (todos.length === 0) lines.push({ text: `${TODO_STATUS_VIEW_TITLE[status]}이 없어요.` });
  for (const item of todos.slice(0, TODO_LIST_MAX_ROWS)) {
    lines.push({ text: messageContent('- ', titleOf(item), ` (${TODO_STATUS_LABEL[item.status] ?? item.status})`), droppable: true });
  }
  if (todos.length > TODO_LIST_MAX_ROWS) lines.push({ text: `외 ${todos.length - TODO_LIST_MAX_ROWS}건`, droppable: true });
  return fit(lines);
}

/** A connector URL safe to show as a link span (http(s), no whitespace or quoting characters, ≤ 300 characters). */
export function safeLinkUrl(url: string | undefined): string | undefined {
  if (!url || url.length > 300) return undefined;
  return /^https?:\/\/[^\s<>"'`\\]+$/i.test(url) ? url : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Connector lookups
// ---------------------------------------------------------------------------------------------------------------------

/** Why a lookup produced no list: the neutral connector reasons plus the service's own preconditions. */
export type WorkChatLookupFailure =
  | ConnectorQueryErrorReason
  | 'NOT_CONFIGURED'
  | 'IDENTITY_MISSING'
  | 'TIMEOUT';

export function renderLookupFailure(source: WorkChatSource, failure: WorkChatLookupFailure): string {
  const label = sourceLabel(source);
  switch (failure) {
    case 'NOT_CONFIGURED':
      return `${label} 연결이 설정되어 있지 않아요. 설정을 확인한 뒤 다시 시도해 주세요.`;
    case 'IDENTITY_MISSING':
      return `${label}에서 내 항목을 찾으려면 내 ${label} 계정 정보(identity)가 필요한데 설정되어 있지 않아요.`;
    case 'UNAUTHORIZED':
      return `${label} 인증에 실패했어요. 토큰이 올바른지, 만료되지 않았는지 확인해 주세요.`;
    case 'FORBIDDEN':
      return `${label}에서 이 조회를 허용하지 않았어요. 접근 권한을 확인해 주세요.`;
    case 'INSUFFICIENT_SCOPE':
      return source === 'slack'
        ? 'Slack 검색에는 search:read 권한이 있는 사용자 토큰이 필요해요. 현재 토큰으로는 검색할 수 없어요.'
        : `${label} 토큰에 이 조회에 필요한 권한(scope)이 없어요.`;
    case 'NOT_FOUND':
      return `${label}에서 조회 대상을 찾지 못했어요.`;
    case 'RATE_LIMITED':
      return `${label} 요청 한도에 걸렸어요. 잠시 후 다시 시도해 주세요.`;
    case 'UNSUPPORTED_QUERY':
      return `${label}에서는 이 조회를 지원하지 않아요.`;
    case 'UNAVAILABLE':
      return `지금은 ${label}에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.`;
    case 'INVALID_RESPONSE':
      return `${label}의 응답을 해석하지 못했어요.`;
    case 'MOVED':
      // A6 R2: only an `item` read can answer MOVED; a listing never does. Neutral, no destination.
      return `${label}에서 조회 대상이 다른 곳으로 옮겨졌어요.`;
    case 'TOO_LARGE':
      // A6 R2: only an `item` read can answer TOO_LARGE.
      return `${label}의 응답이 너무 커서 읽지 못했어요.`;
    case 'TIMEOUT':
      return `${label}이 제한 시간 안에 응답하지 않았어요. 잠시 후 다시 시도해 주세요.`;
  }
}

/** A combination the source does not answer (for example Jira search); no connector call was made. */
export function renderLookupUnsupported(
  source: WorkChatSource,
  query: WorkChatLookupQuery,
  supported: readonly WorkChatLookupQuery[],
): string {
  const label = sourceLabel(source);
  const hint = supported.map((candidate) => QUERY_LABEL[candidate]).join(', ');
  return `${label}에서는 "${QUERY_LABEL[query]}" 조회를 지원하지 않아요. ${label}은(는) ${hint} 조회만 읽기 전용으로 지원해요.`;
}

/** The fixed read-only refusal for connector write requests; no connector or provider is called (ADR-0100 D9). */
export function renderExternalWriteRefusal(source: WorkChatSource): string {
  const label = sourceLabel(source);
  return [
    `${label}에 만들기·수정·댓글·전송 같은 쓰기 작업은 아직 할 수 없어요. Quoky의 외부 연결은 읽기 전용이라 ${label}에는 아무것도 하지 않았어요.`,
    '대신 "내 할 일"에 기록하거나, 조회(예: "내 Jira 이슈", "Slack에서 배포 검색")는 할 수 있어요.',
  ].join('\n');
}

function dueText(dueDate: string): string {
  return `마감 ${dueDate}`;
}

/**
 * The deterministic list for a lookup (also the fallback text of a `summarize` outcome). An empty result is stated as
 * an empty result of a successful lookup, never as a failure.
 */
export function renderExternalWorkList(readout: ExternalWorkReadout): MessageBody {
  return externalWorkList(readout, false).body;
}

/**
 * ADR-0120 amendment A6 R2 (owner decision D1, amendment C3): the deterministic list with each item row prefixed `1.` …
 * `n.` in readout order (while `QUOKY_NL_ITEM_R2` is not `off`), and `labelled`: how many leading rows the reply
 * certainly shows. The reply is fitted on the platform's rendering (droppable rows go from the end), so each row is
 * counted at twice its plain length (the worst escaping) against the budget minus a reserve for the fixed lines, as the
 * to-do receipts do. A row beyond `labelled` may still be shown, but its number is never recorded as a label.
 */
export function renderNumberedExternalWorkList(readout: ExternalWorkReadout): { readonly body: MessageBody; readonly labelled: number } {
  return externalWorkList(readout, true);
}

function externalWorkList(readout: ExternalWorkReadout, numbered: boolean): { readonly body: MessageBody; readonly labelled: number } {
  const { source, query, text } = readout.request;
  const label = sourceLabel(source);
  const subject =
    query === 'search' && text
      ? messageContent(`${QUERY_LABEL[query]} "`, display(text, 60), '"')
      : query === 'my-items' && text
        ? messageContent(`${QUERY_LABEL[query]} 중 "`, display(text, 60), '" 포함')
        : QUERY_LABEL[query];
  const lines: Array<{ text: MessagePart; droppable?: boolean }> = [];

  if (readout.items.length === 0 && readout.truncated && query === 'my-items' && text) {
    // A filter over a full page that matched nothing: the owner may have more items than were checked.
    lines.push({
      text: messageContent(`${label} 내 항목 최근 ${CONNECTOR_QUERY_MAX_LIMIT}건 중 "`, display(text, 60), '" 포함 항목이 없어요 (전체를 확인하진 못했어요).'),
    });
  } else if (readout.items.length === 0) {
    lines.push({ text: messageContent(`${label} `, subject, ' 결과가 없어요.') });
  } else {
    lines.push({ text: messageContent(`**${label} `, subject, `** (${readout.items.length}건${readout.truncated ? ', 일부만 표시' : ''})`) });
    for (const [index, item] of readout.items.entries()) {
      const meta = [item.status, item.dueDate ? dueText(item.dueDate) : undefined, item.container]
        .filter((part): part is string => Boolean(part))
        .map((part) => display(part, 60));
      const url = safeLinkUrl(item.url);
      lines.push({
        text: messageContent(
          numbered ? `${index + 1}. [` : '- [',
          inline(item.ref),
          '] ',
          display(item.title),
          meta.length > 0 ? messageContent(' (', joinMessage(meta, ' · '), ')') : '',
          url ? messageContent(' ', messageLink(url)) : '',
        ),
        droppable: true,
      });
    }
  }
  if (readout.omittedSensitive > 0) {
    lines.push({ text: `민감정보가 있는 ${readout.omittedSensitive}건은 제외했어요.` });
  }
  return { body: fit(lines), labelled: numbered ? certainlyRenderedRows(lines) : 0 };
}

/**
 * A6 R2: how many droppable rows of a fitted reply certainly survive (worst-case rendering, rows dropped from the end):
 * the fixed lines are charged first at twice their plain length, then each row in order, against the reply budget minus
 * the omitted-note reserve.
 */
export function certainlyRenderedRows(lines: ReadonlyArray<{ text: MessagePart; droppable?: boolean }>, maxChars = WORK_CHAT_REPLY_MAX_CHARS): number {
  const length = (part: MessagePart): number => 2 * Array.from(plainTextOf(messageBody(part))).length + 1;
  let room = maxChars - OMITTED_NOTE.length - 2 - lines.filter((line) => line.droppable !== true).reduce((sum, line) => sum + length(line.text), 0);
  let rows = 0;
  for (const line of lines) {
    if (line.droppable !== true) continue;
    const cost = length(line.text);
    if (cost > room) break;
    room -= cost;
    rows += 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// ADR-0120 amendment A6: echo lines of natural-language to-do actions (never used by the anchored grammar)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * ADR-0120 amendment A6-D2: how many to-do rows `renderMyWork` certainly shows. The reply is fitted to its budget on the
 * RENDERED text of the platform (droppable rows go from the end, the work-surface rows first), so this counts each row at
 * twice its plain length (the worst escaping) against the budget minus a reserve for the fixed lines. It may record fewer
 * labels than the owner sees (then a number asks), never one the budget cut.
 */
export function renderedTodoRows(todos: readonly WorkItem[]): number {
  const budget = WORK_CHAT_REPLY_MAX_CHARS - 400;
  let used = 0;
  let shown = 0;
  for (const [index, item] of todos.slice(0, TODO_LIST_MAX_ROWS).entries()) {
    const refs = item.resourceRefs.slice(0, REFS_SHOWN).reduce((sum, ref) => sum + Array.from(ref.identity).length + 2, item.resourceRefs.length > 0 ? 12 : 0);
    const length = `${index + 1}. `.length + 2 * (Array.from(clip(item.title ?? '(제목 없는 항목)', LIST_TITLE_MAX_CHARS)).length + refs) + 1;
    if (used + length > budget) break;
    used += length;
    shown += 1;
  }
  return shown;
}

/** A6-D3: the undo hint of every A6 local write (the 10-minute `lastAction` window; wording per the owner, 2026-10-16). */
export const NL_ACTION_UNDO_HINT = '되돌리려면 "되돌려줘" (10분 안)';

/** The number of a to-do as the owner sees it: its position among the open to-dos (createdAt order), 1-based. */
export function todoNumberOf(todos: readonly WorkItem[], id: string): number | undefined {
  const index = todos.findIndex((item) => item.id === id);
  return index < 0 ? undefined : index + 1;
}

/** `할 일 7번으로 추가했어요: "UAT 결과 정리" · 되돌리려면 "되돌려줘" (10분 안)` (A6-D3 echo). */
export function renderTodoActionAdded(item: WorkItem, no: number): MessageBody {
  return fit([{ text: messageContent(`할 일 ${no}번으로 추가했어요: "`, titleOf(item, 200), `" · ${NL_ACTION_UNDO_HINT}`) }]);
}

/** Completed or taken off the list (record decision 3: a cancel reads "목록에서 뺐어요"). */
export function renderTodoActionTransitioned(item: WorkItem, no: number | undefined, action: 'complete' | 'cancel'): MessageBody {
  const head = no === undefined ? '할 일을' : `할 일 ${no}번을`;
  const verb = action === 'complete' ? '완료 처리했어요' : '목록에서 뺐어요';
  return fit([{ text: messageContent(`${head} ${verb}: "`, titleOf(item, 200), `" · ${NL_ACTION_UNDO_HINT}`) }]);
}

/** The inverse of a completion or a cancel: the same to-do is open again under its current number. */
export function renderTodoActionReopened(item: WorkItem, no: number | undefined): MessageBody {
  const head = no === undefined ? '할 일을' : `할 일 ${no}번을`;
  return fit([{ text: messageContent(`${head} 다시 열었어요: "`, titleOf(item, 200), '"') }]);
}

/** The inverse of an add: that to-do is canceled. */
export function renderTodoActionAddUndone(item: WorkItem): MessageBody {
  return fit([{ text: messageContent('방금 추가한 할 일을 취소했어요: "', titleOf(item, 200), '"') }]);
}

/** An inverse that cannot run (record A): said plainly, nothing changed. */
export function renderTodoUndoRefused(reason: 'already-final' | 'changed' | 'not-found' | 'not-final'): string {
  switch (reason) {
    case 'already-final':
      return '이미 완료/취소된 할 일이라 되돌릴 게 없어요.';
    case 'changed':
      return '그 뒤에 바뀐 할 일이라 되돌리지 않았어요. 아무것도 바꾸지 않았어요.';
    case 'not-final':
      return '그 할 일은 이미 열려 있어요. 아무것도 바꾸지 않았어요.';
    case 'not-found':
      return '되돌릴 할 일을 찾지 못했어요. 아무것도 바꾸지 않았어요.';
  }
}

/** A6-D2 execution-time check: the target is gone or no longer open. */
export function renderTodoActionNotActionable(): string {
  return '그 할 일은 이미 완료되었거나 목록에서 빠졌어요. 아무것도 바꾸지 않았어요.';
}

/** A `match` that names no single open to-do: the candidates under their own numbers (A6-D2), nothing changed. */
export function renderTodoActionWhich(candidates: ReadonlyArray<{ no: number; item: WorkItem }>): MessageBody {
  if (candidates.length === 0) return fit([{ text: '그 이름의 열린 할 일을 찾지 못했어요. 아무것도 바꾸지 않았어요. 몇 번인지 말씀해 주세요.' }]);
  return fit([
    { text: '어느 할 일인가요? 번호로 답해 주세요. 아직 아무것도 바꾸지 않았어요.' },
    ...candidates.slice(0, 10).map(({ no, item }) => ({ text: messageContent(`${no}. `, titleOf(item)), droppable: true })),
  ]);
}
