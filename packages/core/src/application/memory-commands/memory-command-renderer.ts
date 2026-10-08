import type { MessageBody } from '../../domain';
import { joinBody, messageBody, untrustedText } from '../message-rendering';
import type { MemoryCommandLanguage } from './memory-command-grammar';

/**
 * Deterministic KO/EN copy for the memory commands (ADR-0106). Pure: maps data to text, never reads a clock or a
 * store. Memory text reaches a reply only through {@link memoryPreview} / {@link memoryBody}, which have already
 * passed the credential guard (the service masks credential-like records before rendering), are bounded here, and
 * are untrusted spans the platform neutralizes (mentions, markup; PLT-0).
 */

/** ADR-0106 D3: a listed preview is at most this many characters. */
export const MEMORY_PREVIEW_MAX_CHARS = 120;
/** One memory shown in full (`기억 N 보여줘`) is bounded so the reply fits one chat message. */
export const MEMORY_VIEW_MAX_CHARS = 1_500;
/** The preview a confirmation prompt shows for the current and the proposed text. */
export const MEMORY_CONFIRM_PREVIEW_MAX_CHARS = 300;
/** ADR-0106 D3: 10 memories per listed page. */
export const MEMORY_LIST_PAGE_SIZE = 10;

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`;
}

/** Single-line, bounded preview (owner text echoed back: an untrusted span). */
export function memoryPreview(content: string, maxChars = MEMORY_PREVIEW_MAX_CHARS): MessageBody {
  return messageBody(untrustedText(clip(content.replace(/\s+/gu, ' ').trim(), maxChars)));
}

/** Multi-line, bounded body (line breaks kept; owner text echoed back: an untrusted span). */
export function memoryBody(content: string, maxChars = MEMORY_VIEW_MAX_CHARS): MessageBody {
  return messageBody(untrustedText(clip(content.trim(), maxChars)));
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
  readonly preview: MessageBody;
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

export function renderMemoryList(page: MemoryListPage, language: MemoryCommandLanguage): MessageBody {
  const first = page.rows[0]?.number ?? 0;
  const last = page.rows.at(-1)?.number ?? 0;
  const rows = page.rows.map((row) => messageBody(`${row.number}. `, row.preview));
  if (language === 'en') {
    return joinBody([
      `Saved memories ${first}–${last} of ${page.total} (page ${page.page}/${page.pages}):`,
      ...rows,
      ...(page.page < page.pages ? [`Next page: "list memories ${page.page + 1}"`] : []),
      MANAGE_HINT_EN,
    ]);
  }
  return joinBody([
    `저장된 기억 ${page.total}개 중 ${first}–${last}번이에요 (${page.page}/${page.pages}쪽).`,
    ...rows,
    ...(page.page < page.pages ? [`다음 쪽: "기억 목록 ${page.page + 1}"`] : []),
    MANAGE_HINT_KO,
  ]);
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

export function renderMemoryView(number: number, body: MessageBody, language: MemoryCommandLanguage): MessageBody {
  return language === 'en' ? messageBody(`Memory ${number}:\n`, body) : messageBody(`기억 ${number}번:\n`, body);
}

export function renderForgetConfirmation(
  number: number,
  preview: MessageBody,
  code: string,
  language: MemoryCommandLanguage,
): MessageBody {
  return language === 'en'
    ? joinBody([
        `Forget memory ${number}?`,
        messageBody('> ', preview),
        `To confirm, send "confirm memory ${code}" within 30 minutes. Anything else forgets nothing.`,
      ])
    : joinBody([
        `기억 ${number}번을 잊을까요?`,
        messageBody('> ', preview),
        `맞으면 30분 안에 "기억 확인 ${code}"라고 보내 주세요. 다른 말을 하면 아무것도 지우지 않아요.`,
      ]);
}

export function renderEditConfirmation(
  number: number,
  currentPreview: MessageBody,
  nextPreview: MessageBody,
  code: string,
  language: MemoryCommandLanguage,
): MessageBody {
  return language === 'en'
    ? joinBody([
        `Change memory ${number}?`,
        messageBody('Now: ', currentPreview),
        messageBody('New: ', nextPreview),
        `To confirm, send "confirm memory ${code}" within 30 minutes. Anything else changes nothing.`,
      ])
    : joinBody([
        `기억 ${number}번을 이렇게 바꿀까요?`,
        messageBody('지금: ', currentPreview),
        messageBody('새 내용: ', nextPreview),
        `맞으면 30분 안에 "기억 확인 ${code}"라고 보내 주세요. 다른 말을 하면 아무것도 바꾸지 않아요.`,
      ]);
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

export function renderConfirmStale(language: MemoryCommandLanguage, surface: 'list' | 'archive' = 'list'): string {
  if (surface === 'archive') {
    return language === 'en'
      ? 'That archived memory changed or left the archive after the request, so nothing was done. Send "memory archive" to check again.'
      : '요청한 뒤에 그 기억이 바뀌었거나 보관함에서 없어져서 실행하지 않았어요. "보관함"으로 다시 확인해 주세요.';
  }
  return language === 'en'
    ? 'That memory changed or was removed after the request, so nothing was done. Send "list memories" to check again.'
    : '요청한 뒤에 그 기억이 바뀌었거나 없어져서 실행하지 않았어요. "기억 목록"으로 다시 확인해 주세요.';
}

/**
 * How a confirmed forget ended (ADR-0106 amendment): `archived` (kept `archiveDays` days, restorable), `deleted`
 * (no archive configured: `QUOKY_MEMORY_ARCHIVE_DAYS=0`) or `deleted-sensitive` (credential-like text is never
 * archived). `sessionCleared` adds the line saying the current conversation's history was cleared too.
 */
export interface ForgottenReplyOptions {
  readonly mode?: 'archived' | 'deleted' | 'deleted-sensitive';
  readonly archiveDays?: number;
  readonly sessionCleared?: boolean;
}

/** The line a forget/edit reply ends with when the current session's short-term history was cleared. */
export function renderSessionHistoryCleared(language: MemoryCommandLanguage): string {
  return language === 'en' ? "I also cleared this conversation's history." : '이번 대화 기록도 비웠어요.';
}

export function renderForgotten(
  preview: MessageBody,
  earlierVersions: number,
  language: MemoryCommandLanguage,
  options: ForgottenReplyOptions = {},
): MessageBody {
  const mode = options.mode ?? 'deleted';
  const days = options.archiveDays ?? 0;
  const lines: MessageBody[] = [];
  if (language === 'en') {
    lines.push('Forgot this memory:', messageBody('> ', preview));
    if (earlierVersions > 0) {
      const verb = mode === 'archived' ? 'moved to the archive' : 'removed';
      lines.push(`Its ${earlierVersions} earlier version${earlierVersions === 1 ? ' was' : 's were'} ${verb} too.`);
    }
    if (mode === 'archived') {
      lines.push(
        `It is no longer used. It stays in the archive for ${days} day${days === 1 ? '' : 's'}, then is deleted for good. ` +
          'To undo, send "memory archive" to find its number, then "restore memory N".',
      );
    } else if (mode === 'deleted-sensitive') {
      lines.push('It looked like a secret or credential, so it was deleted for good at once instead of being archived.');
    }
  } else {
    lines.push('이 기억을 잊었어요:', messageBody('> ', preview));
    if (earlierVersions > 0) {
      lines.push(
        mode === 'archived'
          ? `이전에 고쳐 쓰기 전 버전 ${earlierVersions}개도 함께 보관함으로 옮겼어요.`
          : `이전에 고쳐 쓰기 전 버전 ${earlierVersions}개도 함께 지웠어요.`,
      );
    }
    if (mode === 'archived') {
      lines.push(
        `이제 대화에 쓰지 않아요. 보관함에 ${days}일 동안 두었다가 완전히 지워요. ` +
          '되돌리려면 "보관함"에서 번호를 확인한 뒤 "기억 복원 N"이라고 보내 주세요.',
      );
    } else if (mode === 'deleted-sensitive') {
      lines.push('비밀번호·토큰처럼 보이는 내용이라 보관함에 두지 않고 바로 완전히 지웠어요.');
    }
  }
  if (options.sessionCleared === true) lines.push(renderSessionHistoryCleared(language));
  return joinBody(lines);
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
  mode: 'deleted' | 'archived' = 'deleted',
): string {
  if (language === 'en') {
    const verb = mode === 'archived' ? 'moved to the archive' : 'removed';
    const head =
      removedVersions > 0
        ? `I only partly forgot this memory: ${removedVersions} earlier version${removedVersions === 1 ? ' was' : 's were'} ${verb}, but I could not finish.`
        : 'I could not finish forgetting this memory. Some data derived from it may already be removed.';
    const state = current === 'kept' ? 'The memory itself is still in your list.' : 'The memory itself may still be stored.';
    return `${head}\n${state} Send "list memories" to find its number, then "forget memory N" to try again.`;
  }
  const head =
    removedVersions > 0
      ? mode === 'archived'
        ? `기억을 일부만 잊었어요: 이전 버전 ${removedVersions}개는 보관함으로 옮겼지만 끝까지 마치지 못했어요.`
        : `기억을 일부만 지웠어요: 이전 버전 ${removedVersions}개는 지웠지만 끝까지 마치지 못했어요.`
      : '기억을 끝까지 지우지 못했어요. 관련 데이터는 일부 지워졌을 수 있어요.';
  const state = current === 'kept' ? '이 기억은 아직 목록에 남아 있어요.' : '이 기억이 아직 남아 있을 수 있어요.';
  return `${head}\n${state} "기억 목록"에서 번호를 확인한 뒤 "기억 N 잊어줘"로 다시 시도해 주세요.`;
}

export function renderEdited(
  preview: MessageBody,
  language: MemoryCommandLanguage,
  cleanupPending = false,
  sessionCleared = false,
): MessageBody {
  const base =
    language === 'en'
      ? messageBody('Updated the memory:\n> ', preview, '\nAn edited memory moves to the end of the list.')
      : messageBody('기억을 바꿨어요:\n> ', preview, '\n바꾼 기억은 목록 맨 뒤로 옮겨져요.');
  const cleared = sessionCleared ? `\n${renderSessionHistoryCleared(language)}` : '';
  if (!cleanupPending) return messageBody(base, cleared);
  return language === 'en'
    ? messageBody(base, `\nSome data derived from the old text could not be cleaned up yet.${cleared}`)
    : messageBody(base, `\n다만 이전 내용에서 파생된 데이터 일부는 아직 정리하지 못했어요.${cleared}`);
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

/** The memory-command outcomes whose reply echoes memory text and is kept in history as a content-free note. */
export type MemoryCommandHistoryNoteOutcome =
  | 'forget-confirmation'
  | 'edit-confirmation'
  | 'forgotten'
  | 'edited'
  | 'archive-listed'
  | 'restore-confirmation'
  | 'purge-confirmation'
  | 'restored'
  | 'purged';

/** W2-L01: the content-free note the conversation history keeps instead of a reply that echoed memory text. */
export function renderMemoryCommandHistoryReply(
  outcome: MemoryCommandHistoryNoteOutcome,
  language: MemoryCommandLanguage,
): string {
  if (language === 'en') {
    switch (outcome) {
      case 'archive-listed':
        return '(Showed the memory archive; archived text is not kept in the conversation history.)';
      case 'restore-confirmation':
        return '(Asked for a confirmation code before restoring an archived memory; its text is not kept in the conversation history.)';
      case 'purge-confirmation':
        return '(Asked for a confirmation code before permanently deleting an archived memory; its text is not kept in the conversation history.)';
      case 'restored':
        return '(Restored the requested memory from the archive; its text is not kept in the conversation history.)';
      case 'purged':
        return '(Permanently deleted the requested archived memory.)';
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
    case 'archive-listed':
      return '(보관함을 보여줬어요. 보관된 기억 내용은 대화 기록에 남기지 않아요.)';
    case 'restore-confirmation':
      return '(보관함의 기억을 복원하기 전에 확인 코드를 보냈어요. 기억 내용은 대화 기록에 남기지 않아요.)';
    case 'purge-confirmation':
      return '(보관함의 기억을 완전히 지우기 전에 확인 코드를 보냈어요. 기억 내용은 대화 기록에 남기지 않아요.)';
    case 'restored':
      return '(요청한 기억을 보관함에서 복원했어요. 기억 내용은 대화 기록에 남기지 않아요.)';
    case 'purged':
      return '(보관함의 요청한 기억을 완전히 지웠어요.)';
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

export function renderMemoryStatusLatest(preview: MessageBody, total: number, language: MemoryCommandLanguage): MessageBody {
  return language === 'en'
    ? joinBody([
        `The most recent saved memory (${total} in total) is:`,
        messageBody('> ', preview),
        'Send "list memories" to see them all, or "remember: <text>" to save something new.',
      ])
    : joinBody([
        `가장 최근에 저장된 기억이에요 (모두 ${total}개):`,
        messageBody('> ', preview),
        '전체는 "기억 목록"으로 볼 수 있고, 새로 저장하려면 "기억해: 내용"이라고 보내 주세요.',
      ]);
}

export function renderMemoryStatusNone(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'Nothing is saved to memory yet. Send "remember: <text>" to save something.'
    : '아직 저장된 기억이 없어요. 기억해 두려면 "기억해: 내용"이라고 보내 주세요.';
}

// ADR-0106 amendment — the archive view, restore and permanent delete. Archive numbers are the archive's own (by
// archive time, oldest first) and are never the active list's numbers; the replies say so.

export interface MemoryArchiveRow {
  readonly number: number;
  /** Already masked or previewed. */
  readonly preview: MessageBody;
  /** Whole days until the daily maintenance deletes it (at least 1 while it is listed). */
  readonly daysLeft: number;
}

export interface MemoryArchivePage {
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly rows: readonly MemoryArchiveRow[];
}

export function renderMemoryArchiveEmpty(archiveDays: number, language: MemoryCommandLanguage): string {
  if (archiveDays === 0) {
    return language === 'en'
      ? 'The memory archive is empty. With the current setting a forgotten memory is deleted for good at once (no archive).'
      : '보관함이 비어 있어요. 지금 설정에서는 잊은 기억을 보관하지 않고 바로 완전히 지워요.';
  }
  return language === 'en'
    ? `The memory archive is empty. A forgotten memory stays here for ${archiveDays} day${archiveDays === 1 ? '' : 's'} before it is deleted for good.`
    : `보관함이 비어 있어요. 잊은 기억은 여기에 ${archiveDays}일 동안 보관했다가 완전히 지워요.`;
}

export function renderMemoryArchive(page: MemoryArchivePage, language: MemoryCommandLanguage): MessageBody {
  if (language === 'en') {
    return joinBody([
      `Memory archive: ${page.total} forgotten ${page.total === 1 ? 'memory' : 'memories'} (page ${page.page}/${page.pages}). Archive numbers are separate from the "list memories" numbers.`,
      ...page.rows.map((row) => messageBody(`${row.number}. `, row.preview, ` (${row.daysLeft} day${row.daysLeft === 1 ? '' : 's'} left)`)),
      ...(page.page < page.pages ? [`Next page: "memory archive ${page.page + 1}"`] : []),
      'Send "restore memory N" to bring one back or "permanently delete memory N" to delete it now (each asks for a confirmation code).',
    ]);
  }
  return joinBody([
    `보관함에 잊은 기억 ${page.total}개가 있어요 (${page.page}/${page.pages}쪽). 보관함 번호는 "기억 목록" 번호와 따로 매겨져요.`,
    ...page.rows.map((row) => messageBody(`${row.number}. `, row.preview, ` (${row.daysLeft}일 남음)`)),
    ...(page.page < page.pages ? [`다음 쪽: "보관함 ${page.page + 1}"`] : []),
    '"기억 복원 N"으로 되돌리거나 "기억 완전 삭제 N"으로 바로 지울 수 있어요 (확인 코드로 한 번 더 확인해요).',
  ]);
}

export function renderMemoryArchivePageOutOfRange(pages: number, language: MemoryCommandLanguage): string {
  return language === 'en'
    ? `The memory archive has ${pages} page${pages === 1 ? '' : 's'}. Send "memory archive" to start from page 1.`
    : `보관함은 ${pages}쪽까지 있어요. "보관함"으로 첫 쪽부터 볼 수 있어요.`;
}

export function renderArchivedMemoryNotFound(
  number: number,
  total: number,
  archiveDays: number,
  language: MemoryCommandLanguage,
): string {
  if (total === 0) return renderMemoryArchiveEmpty(archiveDays, language);
  return language === 'en'
    ? `There is no archived memory ${number}. The archive holds ${total}; send "memory archive" to see its numbers (they differ from "list memories").`
    : `보관함에 ${number}번 기억은 없어요. 지금 보관함에는 ${total}개가 있어요. "보관함"으로 번호를 확인해 주세요 (기억 목록 번호와 달라요).`;
}

export function renderRestoreConfirmation(
  number: number,
  preview: MessageBody,
  code: string,
  language: MemoryCommandLanguage,
): MessageBody {
  return language === 'en'
    ? joinBody([
        `Restore archived memory ${number}?`,
        messageBody('> ', preview),
        `To confirm, send "confirm memory ${code}" within 30 minutes. Anything else changes nothing.`,
      ])
    : joinBody([
        `보관함 ${number}번 기억을 복원할까요?`,
        messageBody('> ', preview),
        `맞으면 30분 안에 "기억 확인 ${code}"라고 보내 주세요. 다른 말을 하면 아무것도 바꾸지 않아요.`,
      ]);
}

export function renderPurgeConfirmation(
  number: number,
  preview: MessageBody,
  code: string,
  language: MemoryCommandLanguage,
): MessageBody {
  return language === 'en'
    ? joinBody([
        `Permanently delete archived memory ${number}? This cannot be undone.`,
        messageBody('> ', preview),
        `To confirm, send "confirm memory ${code}" within 30 minutes. Anything else deletes nothing.`,
      ])
    : joinBody([
        `보관함 ${number}번 기억을 완전히 지울까요? 지우면 되돌릴 수 없어요.`,
        messageBody('> ', preview),
        `맞으면 30분 안에 "기억 확인 ${code}"라고 보내 주세요. 다른 말을 하면 아무것도 지우지 않아요.`,
      ]);
}

export function renderRestored(preview: MessageBody, language: MemoryCommandLanguage): MessageBody {
  return language === 'en'
    ? messageBody('Restored this memory from the archive:\n> ', preview, '\nIt is used again; send "list memories" to see it.')
    : messageBody('기억을 복원했어요:\n> ', preview, '\n다시 대화에 쓰여요. "기억 목록"에서 확인할 수 있어요.');
}

export function renderRestoreIncomplete(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'I could not finish restoring that memory; it is still in the archive. Send "memory archive" to find its number and try again.'
    : '기억을 끝까지 복원하지 못했어요. 그 기억은 아직 보관함에 있어요. "보관함"에서 번호를 확인한 뒤 다시 시도해 주세요.';
}

export function renderPurged(preview: MessageBody, earlierVersions: number, language: MemoryCommandLanguage): MessageBody {
  if (language === 'en') {
    const versions =
      earlierVersions > 0 ? `\nIts ${earlierVersions} earlier version${earlierVersions === 1 ? ' was' : 's were'} deleted too.` : '';
    return messageBody('Permanently deleted this archived memory:\n> ', preview, `${versions}\nIt cannot be restored.`);
  }
  const versions = earlierVersions > 0 ? `\n이전에 고쳐 쓰기 전 버전 ${earlierVersions}개도 함께 지웠어요.` : '';
  return messageBody('보관함의 기억을 완전히 지웠어요:\n> ', preview, `${versions}\n이제 되돌릴 수 없어요.`);
}

export function renderPurgeIncomplete(language: MemoryCommandLanguage): string {
  return language === 'en'
    ? 'I could not finish deleting that archived memory; it may still be in the archive. Send "memory archive" to check, then "permanently delete memory N" to try again.'
    : '보관함의 기억을 끝까지 지우지 못했어요. 아직 보관함에 남아 있을 수 있어요. "보관함"에서 확인한 뒤 "기억 완전 삭제 N"으로 다시 시도해 주세요.';
}
