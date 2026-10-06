import type { MemoryCommandLanguage } from './memory-command-grammar';

/**
 * Deterministic KO/EN copy for the memory commands (ADR-0106). Pure: maps data to text, never reads a clock or a
 * store. Memory text reaches a reply only through {@link memoryPreview} / {@link memoryBody}, which have already
 * passed the credential guard (the service masks credential-like records before rendering) and are escaped here
 * for Discord (mentions, markdown) and bounded.
 */

/** ADR-0106 D3: a listed preview is at most this many characters. */
export const MEMORY_PREVIEW_MAX_CHARS = 120;
/** One memory shown in full (`기억 N 보여줘`) is bounded so the reply fits one Discord message. */
export const MEMORY_VIEW_MAX_CHARS = 1_500;
/** The preview a confirmation prompt shows for the current and the proposed text. */
export const MEMORY_CONFIRM_PREVIEW_MAX_CHARS = 300;
/** ADR-0106 D3: 10 memories per listed page. */
export const MEMORY_LIST_PAGE_SIZE = 10;

/** Discord mention / markdown neutralization for owner text echoed back into a reply. */
function escapeDiscord(text: string): string {
  return text
    .replace(/[\\*_~`|>[\]]/g, '\\$&')
    .replace(/@/g, '@​')
    .replace(/</g, '<​');
}

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`;
}

/** Single-line, bounded, escaped preview. */
export function memoryPreview(content: string, maxChars = MEMORY_PREVIEW_MAX_CHARS): string {
  return escapeDiscord(clip(content.replace(/\s+/gu, ' ').trim(), maxChars));
}

/** Multi-line, bounded, escaped body (line breaks kept). */
export function memoryBody(content: string, maxChars = MEMORY_VIEW_MAX_CHARS): string {
  return escapeDiscord(clip(content.trim(), maxChars));
}

/** What a credential-like record shows instead of its text (it is still listed, so it can be forgotten). */
export function maskedMemoryText(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? '(hidden: this looks like a secret or credential)'
    : '(비밀번호·토큰처럼 보여서 내용을 표시하지 않아요)';
}

export interface MemoryListRow {
  readonly number: number;
  /** Already masked or previewed. */
  readonly preview: string;
}

export interface MemoryListPage {
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly rows: readonly MemoryListRow[];
}

const MANAGE_HINT_KO = '"기억 N 보여줘", "기억 N 수정: 내용", "기억 N 잊어줘"로 하나씩 관리할 수 있어요.';
const MANAGE_HINT_EN = 'Use "show memory N", "edit memory N: text" or "forget memory N" to manage one.';

export function renderMemoryListEmpty(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'No memories are saved yet. Send "remember: <text>" to save one.'
    : '저장된 기억이 없어요. "기억해: 내용"이라고 보내면 저장해 둬요.';
}

export function renderMemoryList(page: MemoryListPage, language: MemoryCommandLanguage): string {
  const first = page.rows[0]?.number ?? 0;
  const last = page.rows.at(-1)?.number ?? 0;
  const rows = page.rows.map((row) => `${row.number}. ${row.preview}`);
  if (language === 'en') {
    return [
      `Saved memories ${first}–${last} of ${page.total} (page ${page.page}/${page.pages}):`,
      ...rows,
      ...(page.page < page.pages ? [`Next page: "list memories ${page.page + 1}"`] : []),
      MANAGE_HINT_EN,
    ].join('\n');
  }
  return [
    `저장된 기억 ${page.total}개 중 ${first}–${last}번이에요 (${page.page}/${page.pages}쪽).`,
    ...rows,
    ...(page.page < page.pages ? [`다음 쪽: "기억 목록 ${page.page + 1}"`] : []),
    MANAGE_HINT_KO,
  ].join('\n');
}

export function renderMemoryPageOutOfRange(pages: number, language: MemoryCommandLanguage): string {
  return language === 'en'
    ? `The memory list has ${pages} page${pages === 1 ? '' : 's'}. Send "list memories" to start from page 1.`
    : `기억 목록은 ${pages}쪽까지 있어요. "기억 목록"으로 첫 쪽부터 볼 수 있어요.`;
}

export function renderMemoryNotFound(number: number, total: number, language: MemoryCommandLanguage): string {
  if (total === 0) return renderMemoryListEmpty(language);
  return language === 'en'
    ? `There is no memory ${number}. ${total} ${total === 1 ? 'memory is' : 'memories are'} saved; send "list memories" to see the numbers.`
    : `기억 ${number}번은 없어요. 지금 저장된 기억은 ${total}개예요. "기억 목록"으로 번호를 확인해 주세요.`;
}

export function renderMemoryView(number: number, body: string, language: MemoryCommandLanguage): string {
  return language === 'en' ? `Memory ${number}:\n${body}` : `기억 ${number}번:\n${body}`;
}

export function renderForgetConfirmation(
  number: number,
  preview: string,
  code: string,
  language: MemoryCommandLanguage,
): string {
  return language === 'en'
    ? [
        `Forget memory ${number}?`,
        `> ${preview}`,
        `To confirm, send "confirm memory ${code}" within 30 minutes. Anything else forgets nothing.`,
      ].join('\n')
    : [
        `기억 ${number}번을 잊을까요?`,
        `> ${preview}`,
        `맞으면 30분 안에 "기억 확인 ${code}"라고 보내 주세요. 다른 말을 하면 아무것도 지우지 않아요.`,
      ].join('\n');
}

export function renderEditConfirmation(
  number: number,
  currentPreview: string,
  nextPreview: string,
  code: string,
  language: MemoryCommandLanguage,
): string {
  return language === 'en'
    ? [
        `Change memory ${number}?`,
        `Now: ${currentPreview}`,
        `New: ${nextPreview}`,
        `To confirm, send "confirm memory ${code}" within 30 minutes. Anything else changes nothing.`,
      ].join('\n')
    : [
        `기억 ${number}번을 이렇게 바꿀까요?`,
        `지금: ${currentPreview}`,
        `새 내용: ${nextPreview}`,
        `맞으면 30분 안에 "기억 확인 ${code}"라고 보내 주세요. 다른 말을 하면 아무것도 바꾸지 않아요.`,
      ].join('\n');
}

export function renderEditUnchanged(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'That is already what the memory says, so nothing changed.'
    : '지금 내용과 같아서 바꿀 것이 없어요.';
}

export function renderEditSensitiveRefused(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'Secrets such as passwords or tokens are never saved to memory. Nothing changed.'
    : '비밀번호·토큰 같은 민감한 정보는 기억으로 저장하지 않아요. 아무것도 바꾸지 않았어요.';
}

export function renderEditTooLong(maxChars: number, language: MemoryCommandLanguage): string {
  const limit = maxChars.toLocaleString('en-US');
  return language === 'en'
    ? `A memory can hold at most ${limit} characters. Nothing changed.`
    : `기억은 ${limit}자까지 저장할 수 있어요. 아무것도 바꾸지 않았어요.`;
}

export function renderEditUsage(number: number | undefined, language: MemoryCommandLanguage): string {
  const n = number ?? 1;
  return language === 'en'
    ? `Send the new text after a colon, for example: "edit memory ${n}: new text"`
    : `바꿀 내용을 콜론 뒤에 함께 보내 주세요. 예: "기억 ${n} 수정: 새 내용"`;
}

export function renderConfirmUsage(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'Send the code from the confirmation message, for example: "confirm memory AB2C"'
    : '확인 메시지에 있던 코드를 함께 보내 주세요. 예: "기억 확인 AB2C"';
}

export function renderConfirmUnknown(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'That code does not match a pending request or has expired. Nothing changed. Ask again with "forget memory N" or "edit memory N: text".'
    : '확인 코드가 맞지 않거나 만료됐어요. 아무것도 바뀌지 않았어요. "기억 N 잊어줘" 또는 "기억 N 수정: 내용"으로 다시 요청해 주세요.';
}

export function renderConfirmStale(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'That memory changed or was removed after the request, so nothing was done. Send "list memories" to check again.'
    : '요청한 뒤에 그 기억이 바뀌었거나 없어져서 실행하지 않았어요. "기억 목록"으로 다시 확인해 주세요.';
}

export function renderForgotten(preview: string, earlierVersions: number, language: MemoryCommandLanguage): string {
  if (language === 'en') {
    const versions = earlierVersions > 0 ? `\nIts ${earlierVersions} earlier version${earlierVersions === 1 ? ' was' : 's were'} removed too.` : '';
    return `Forgot this memory:\n> ${preview}${versions}`;
  }
  const versions = earlierVersions > 0 ? `\n이전에 고쳐 쓰기 전 버전 ${earlierVersions}개도 함께 지웠어요.` : '';
  return `이 기억을 잊었어요:\n> ${preview}${versions}`;
}

/**
 * A forget that stopped part-way (ADR-0106 D5). States only what happened: how many earlier versions were removed,
 * and whether the memory itself is known to remain (`kept`: its delete was never attempted) or may remain
 * (`unknown`: its own delete failed). Deletion runs oldest version first, so whatever remains stays reachable and
 * asking again finishes the job.
 */
export function renderForgetIncomplete(
  removedVersions: number,
  current: 'kept' | 'unknown',
  language: MemoryCommandLanguage,
): string {
  if (language === 'en') {
    const head =
      removedVersions > 0
        ? `I only partly forgot this memory: ${removedVersions} earlier version${removedVersions === 1 ? ' was' : 's were'} removed, but I could not finish.`
        : 'I could not finish forgetting this memory. Some data derived from it may already be removed.';
    const state = current === 'kept' ? 'The memory itself is still in your list.' : 'The memory itself may still be stored.';
    return `${head}\n${state} Send "list memories" to find its number, then "forget memory N" to try again.`;
  }
  const head =
    removedVersions > 0
      ? `기억을 일부만 지웠어요: 이전 버전 ${removedVersions}개는 지웠지만 끝까지 마치지 못했어요.`
      : '기억을 끝까지 지우지 못했어요. 관련 데이터는 일부 지워졌을 수 있어요.';
  const state = current === 'kept' ? '이 기억은 아직 목록에 남아 있어요.' : '이 기억이 아직 남아 있을 수 있어요.';
  return `${head}\n${state} "기억 목록"에서 번호를 확인한 뒤 "기억 N 잊어줘"로 다시 시도해 주세요.`;
}

export function renderEdited(preview: string, language: MemoryCommandLanguage, cleanupPending = false): string {
  const base =
    language === 'en'
      ? `Updated the memory:\n> ${preview}\nAn edited memory moves to the end of the list.`
      : `기억을 바꿨어요:\n> ${preview}\n바꾼 기억은 목록 맨 뒤로 옮겨져요.`;
  if (!cleanupPending) return base;
  return language === 'en'
    ? `${base}\nSome data derived from the old text could not be cleaned up yet.`
    : `${base}\n다만 이전 내용에서 파생된 데이터 일부는 아직 정리하지 못했어요.`;
}

export function renderEditDuplicate(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'A memory with that exact text already exists, so nothing changed.'
    : '같은 내용의 기억이 이미 있어서 바꾸지 않았어요.';
}

/**
 * W2-L01: what the SHORT_TERM conversation history keeps of an edit request — the command with its text withheld, so
 * the new text is not copied into the chat transcript (the memory itself holds it).
 */
export function renderEditRequestHistory(number: number, language: MemoryCommandLanguage): string {
  return language === 'en'
    ? `edit memory ${number}: (text not kept in the conversation history)`
    : `기억 ${number} 수정: (내용은 대화 기록에 남기지 않아요)`;
}

/** W2-L01: the content-free note the conversation history keeps instead of an edit/forget reply that echoed memory text. */
export function renderMemoryCommandHistoryReply(
  outcome: 'forget-confirmation' | 'edit-confirmation' | 'forgotten' | 'edited',
  language: MemoryCommandLanguage,
): string {
  if (language === 'en') {
    switch (outcome) {
      case 'forget-confirmation':
        return '(Asked for a confirmation code before forgetting a memory; its text is not kept in the conversation history.)';
      case 'edit-confirmation':
        return '(Asked for a confirmation code before changing a memory; its text is not kept in the conversation history.)';
      case 'forgotten':
        return '(Forgot the requested memory; its content is no longer used.)';
      case 'edited':
        return '(Changed the requested memory; its text is not kept in the conversation history.)';
    }
  }
  switch (outcome) {
    case 'forget-confirmation':
      return '(기억을 잊기 전에 확인 코드를 보냈어요. 기억 내용은 대화 기록에 남기지 않아요.)';
    case 'edit-confirmation':
      return '(기억을 바꾸기 전에 확인 코드를 보냈어요. 기억 내용은 대화 기록에 남기지 않아요.)';
    case 'forgotten':
      return '(요청한 기억을 잊었어요. 그 내용은 더 이상 쓰지 않아요.)';
    case 'edited':
      return '(요청한 기억을 바꿨어요. 기억 내용은 대화 기록에 남기지 않아요.)';
  }
}

export function renderMemoryCommandFailed(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'I could not complete that memory request. Nothing was changed; please try again in a moment.'
    : '기억 요청을 처리하지 못했어요. 바뀐 것은 없어요. 잠시 후 다시 시도해 주세요.';
}

export function renderEditFailed(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'I could not save that change. The memory was not changed.'
    : '수정 내용을 저장하지 못했어요. 기억은 바뀌지 않았어요.';
}

export function renderBulkForgetRefused(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'I do not forget all memories at once. Send "list memories", then "forget memory N" for each one.'
    : '기억을 한꺼번에 지우지는 않아요. "기억 목록"으로 번호를 확인한 뒤 "기억 N 잊어줘"로 하나씩 지워 주세요.';
}

export function renderMemoryStatusLatest(preview: string, total: number, language: MemoryCommandLanguage): string {
  return language === 'en'
    ? [
        `The most recent saved memory (${total} in total) is:`,
        `> ${preview}`,
        'Send "list memories" to see them all, or "remember: <text>" to save something new.',
      ].join('\n')
    : [
        `가장 최근에 저장된 기억이에요 (모두 ${total}개):`,
        `> ${preview}`,
        '전체는 "기억 목록"으로 볼 수 있고, 새로 저장하려면 "기억해: 내용"이라고 보내 주세요.',
      ].join('\n');
}

export function renderMemoryStatusNone(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'Nothing is saved to memory yet. Send "remember: <text>" to save something.'
    : '아직 저장된 기억이 없어요. 기억해 두려면 "기억해: 내용"이라고 보내 주세요.';
}
