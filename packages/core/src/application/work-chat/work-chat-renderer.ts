import type { ResourceRef, WorkItem } from '../../domain';
import type { ConnectorQueryErrorReason } from '../../ports';
import type { WorkSurface, WorkSurfaceSourceStatus } from '../work-surface-query';
import { escapeDiscordText } from './external-work-readout';
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
 * clock or calls a connector. Item and external text is escaped for Discord (mentions, markdown, masked links) and
 * every reply is bounded to the message budget.
 */

/** Below the 1,900-character message budget so a footer or notice can still be appended. */
export const WORK_CHAT_REPLY_MAX_CHARS = 1800;
const TODO_LIST_MAX_ROWS = 15;
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

/** Escaped, single-line display text for an item title. */
function display(text: string, maxChars = LIST_TITLE_MAX_CHARS): string {
  return escapeDiscordText(clip(text, maxChars));
}

function titleOf(item: WorkItem, maxChars?: number): string {
  return item.title ? display(item.title, maxChars) : '(제목 없는 항목)';
}

function refList(refs: readonly ResourceRef[]): string {
  const shown = refs.slice(0, REFS_SHOWN).map((ref) => escapeDiscordText(ref.identity));
  const more = refs.length > REFS_SHOWN ? ` 외 ${refs.length - REFS_SHOWN}건` : '';
  return `${shown.join(', ')}${more}`;
}

/**
 * Join lines within the reply budget. Lines marked `droppable` are removed from the end first; a note records that
 * something was cut. The last resort is a hard slice, so the result never exceeds the budget.
 */
function fit(lines: ReadonlyArray<{ text: string; droppable?: boolean }>, maxChars = WORK_CHAT_REPLY_MAX_CHARS): string {
  const kept = [...lines];
  let dropped = false;
  const render = (): string => {
    const text = kept.map((line) => line.text).join('\n');
    return dropped ? `${text}\n${OMITTED_NOTE}` : text;
  };
  while (render().length > maxChars) {
    let index = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i]?.droppable) {
        index = i;
        break;
      }
    }
    if (index < 0) break;
    kept.splice(index, 1);
    dropped = true;
  }
  const text = render();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

// ---------------------------------------------------------------------------------------------------------------------
// To-do mutations
// ---------------------------------------------------------------------------------------------------------------------

export function renderTodoAdded(item: WorkItem): string {
  const refs = item.resourceRefs.length > 0 ? ` (연결: ${refList(item.resourceRefs)})` : '';
  return fit([{ text: `할 일을 추가했어요: "${titleOf(item, 200)}"${refs}` }]);
}

export function renderTodoCompleted(item: WorkItem): string {
  return fit([{ text: `할 일을 완료 처리했어요: "${titleOf(item, 200)}"` }]);
}

export function renderTodoCanceled(item: WorkItem): string {
  return fit([{ text: `할 일을 취소했어요: "${titleOf(item, 200)}"` }]);
}

export function renderTodoLinked(item: WorkItem, added: readonly ResourceRef[]): string {
  if (added.length === 0) {
    return fit([{ text: `이미 연결돼 있어요: "${titleOf(item, 200)}" (연결: ${refList(item.resourceRefs)})` }]);
  }
  return fit([
    { text: `할 일에 연결했어요: "${titleOf(item, 200)}"` },
    { text: `추가된 연결: ${refList(added)}` },
    { text: '연결할 때 외부 시스템은 조회하지 않았어요.' },
  ]);
}

const ACTION_LABEL = { complete: '완료 처리', cancel: '취소', link: '연결' } as const;

/** Several to-dos match: nothing changed; the candidates are listed with their list numbers. */
export function renderTodoAmbiguous(
  action: keyof typeof ACTION_LABEL,
  candidates: ReadonlyArray<{ no: number; item: WorkItem }>,
): string {
  const rows = candidates.slice(0, TODO_LIST_MAX_ROWS).map(({ no, item }) => ({
    text: `${no}. ${titleOf(item)}`,
    droppable: true,
  }));
  const more = candidates.length > TODO_LIST_MAX_ROWS ? candidates.length - TODO_LIST_MAX_ROWS : 0;
  return fit([
    { text: `일치하는 할 일이 여러 개라 아무것도 ${ACTION_LABEL[action]}하지 않았어요. 번호로 지정해 주세요.` },
    ...rows,
    ...(more > 0 ? [{ text: `외 ${more}건` }] : []),
  ]);
}

export function renderTodoNotFound(target: WorkChatTarget, activeCount: number): string {
  const what = 'index' in target ? `${target.index}번 할 일` : `"${display(target.text, 60)}"와 일치하는 할 일`;
  const hint = activeCount === 0 ? '열린 할 일이 없어요.' : `열린 할 일은 ${activeCount}건이에요. "내 할 일"로 번호를 확인해 주세요.`;
  return fit([{ text: `${what}을 찾지 못해서 아무것도 바꾸지 않았어요. ${hint}` }]);
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
export function renderMyWork(todos: readonly WorkItem[], surface: WorkSurface | null): string {
  const lines: Array<{ text: string; droppable?: boolean }> = [];

  lines.push({ text: `**내 할 일** (${todos.length}건)` });
  if (todos.length === 0) {
    lines.push({ text: '열린 할 일이 없어요. "할 일 추가: 내용"으로 추가할 수 있어요.' });
  } else {
    todos.slice(0, TODO_LIST_MAX_ROWS).forEach((item, index) => {
      const refs = item.resourceRefs.length > 0 ? ` (연결: ${refList(item.resourceRefs)})` : '';
      lines.push({ text: `${index + 1}. ${titleOf(item)}${refs}`, droppable: true });
    });
    if (todos.length > TODO_LIST_MAX_ROWS) lines.push({ text: `외 ${todos.length - TODO_LIST_MAX_ROWS}건`, droppable: true });
  }

  lines.push({ text: '' });
  if (surface === null) {
    lines.push({ text: '**Jira·GitHub 업무**' });
    lines.push({ text: '지금은 Jira·GitHub 업무를 불러오지 못했어요. 로컬 할 일만 보여드려요.' });
  } else {
    lines.push({ text: `**Jira·GitHub 업무** (${surface.items.length}건)` });
    if (surface.items.length === 0) {
      lines.push({
        text:
          surface.status === 'COMPLETE'
            ? 'Jira와 GitHub에서 확인된 업무가 없어요.'
            : '확인 가능한 소스에는 업무가 없어요. 확인하지 못한 소스가 있으니 아래 상태를 확인해 주세요.',
      });
    } else {
      for (const item of surface.items.slice(0, EXTERNAL_LIST_MAX_ROWS)) {
        const url = safeLinkUrl(item.url);
        lines.push({
          text: `- [${escapeDiscordText(item.resource.identity)}] ${display(item.title)}${url ? ` <${url}>` : ''}`,
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
  }
  return fit(lines);
}

function safeLinkUrl(url: string | undefined): string | undefined {
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
export function renderExternalWorkList(readout: ExternalWorkReadout): string {
  const { source, query, text } = readout.request;
  const label = sourceLabel(source);
  const subject = query === 'search' && text ? `${QUERY_LABEL[query]} "${display(text, 60)}"` : QUERY_LABEL[query];
  const lines: Array<{ text: string; droppable?: boolean }> = [];

  if (readout.items.length === 0) {
    lines.push({ text: `${label} ${subject} 결과가 없어요.` });
  } else {
    lines.push({ text: `**${label} ${subject}** (${readout.items.length}건${readout.truncated ? ', 일부만 표시' : ''})` });
    for (const item of readout.items) {
      const meta = [item.status, item.dueDate ? dueText(item.dueDate) : undefined, item.container]
        .filter((part): part is string => Boolean(part))
        .map((part) => display(part, 60));
      const url = safeLinkUrl(item.url);
      lines.push({
        text:
          `- [${escapeDiscordText(item.ref)}] ${display(item.title)}` +
          `${meta.length > 0 ? ` (${meta.join(' · ')})` : ''}${url ? ` <${url}>` : ''}`,
        droppable: true,
      });
    }
  }
  if (readout.omittedSensitive > 0) {
    lines.push({ text: `민감정보가 있는 ${readout.omittedSensitive}건은 제외했어요.` });
  }
  return fit(lines);
}
