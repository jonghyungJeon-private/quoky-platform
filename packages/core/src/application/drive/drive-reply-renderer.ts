import type { IsoTimestamp, MessageBody } from '../../domain';
import type { ConnectorQueryErrorReason } from '../../ports/connector-query';
import type { DriveFileKind, DriveFileSummary, DriveListingKind, DriveListResult } from '../../ports/drive-reader.port';
import { clip, guardedClippedSpan } from '../guarded-clip';
import { mailDateLabel } from '../mail/mail-reply-renderer';
import { joinBody, messageBody, takeLines, untrustedText, type MessagePart } from '../message-rendering';
import type { UntrustedDocumentRefusal } from '../untrusted-document-readout';
import type { DriveLanguage } from './drive-question';

/**
 * Deterministic Drive replies (ADR-0118 D4–D7, DRV-1). Pure: every instant is rendered in the owner's zone
 * (`QUOKY_TIMEZONE`) from the data passed in; nothing here reads a clock, calls a provider or a reader.
 *
 * A listing shows, per file, its name, its kind and when it was last modified (D4) — the name is untrusted readout (a
 * file shared with the owner can carry a hostile name): clipped, its links replaced by the shared neutralizer, rendered
 * as an untrusted span the platform neutralizes (no mentions, no markup; PLT-0), and replaced by a fixed placeholder
 * when it looks like credential material (ADR-0097). At most {@link DRIVE_REPLY_MAX_ENTRIES} entries inside
 * {@link DRIVE_REPLY_MAX_CHARS} of the delivered text; the rest is counted as "…외 N건". A failed read is answered with a
 * "could not read" note, never as "no files".
 */

export const DRIVE_REPLY_MAX_CHARS = 1900;
export const DRIVE_REPLY_MAX_ENTRIES = 10;
/**
 * A listing number must always name an entry the owner saw (the GML-1 review P2 rule): the display cap is sized so that
 * {@link DRIVE_REPLY_MAX_ENTRIES} entries ALWAYS fit in {@link DRIVE_REPLY_MAX_CHARS} even when every untrusted
 * character renders as two. `drive-reply-renderer.test.ts` (a doubling markup) and the app test
 * `drive-listing-fit.test.ts` (the real platform markups) pin it.
 */
export const DRIVE_NAME_DISPLAY_MAX_CHARS = 40;
/** The owner-typed name echoed in a listing header. */
export const DRIVE_NAME_QUERY_DISPLAY_MAX_CHARS = 20;

/** Why a Drive read produced no answer: the ADR-0100 reasons plus the handler's own timeout. */
export type DriveReadFailure = ConnectorQueryErrorReason | 'TIMEOUT';

/** What a listing asked for: the recent files, or a name search. */
export type DriveListingFilter = (
  | { readonly kind: 'recent' }
  | { readonly kind: 'search'; readonly name: string }
) & {
  /** ADR-0120 follow-up: the listing was narrowed to this file kind. */
  readonly fileKind?: DriveListingKind;
};

/**
 * The source-specific words of the copy, supplied by the composition root from the adapter (the GML-1 review P3-6
 * rule): Core names no Drive provider, scope or consent tool.
 */
export interface DriveSourceCopy {
  /** The source's display name per language (for example a provider name); at most 20 characters are shown. */
  readonly label: { readonly ko: string; readonly en: string };
  /** The owner's reconnect step, appended to the auth-expired and needs-consent notes. */
  readonly reconnectHint?: { readonly ko: string; readonly en: string };
}

/** The neutral copy used when the composition root supplies none. */
export const DEFAULT_DRIVE_SOURCE_COPY: DriveSourceCopy = Object.freeze({ label: Object.freeze({ ko: '드라이브', en: 'Drive' }) });

export interface DriveRenderOptions {
  readonly timeZone: string;
  readonly now: IsoTimestamp;
  readonly language: DriveLanguage;
  /** Defaults to {@link DEFAULT_DRIVE_SOURCE_COPY}. */
  readonly copy?: DriveSourceCopy;
}

function labelOf(copy: DriveSourceCopy | undefined, language: DriveLanguage): string {
  const label = (copy ?? DEFAULT_DRIVE_SOURCE_COPY).label[language].replace(/\s+/g, ' ').trim();
  return clip(label.length > 0 ? label : DEFAULT_DRIVE_SOURCE_COPY.label[language], 20);
}

function hintOf(copy: DriveSourceCopy | undefined, language: DriveLanguage): string {
  const hint = copy?.reconnectHint?.[language]?.trim();
  return hint ? ` ${hint}` : '';
}

const KIND_LABEL: Readonly<Record<DriveFileKind, { readonly ko: string; readonly en: string }>> = {
  document: { ko: '문서', en: 'document' },
  spreadsheet: { ko: '스프레드시트', en: 'spreadsheet' },
  presentation: { ko: '프레젠테이션', en: 'presentation' },
  text: { ko: '텍스트', en: 'text' },
  pdf: { ko: 'PDF', en: 'PDF' },
  folder: { ko: '폴더', en: 'folder' },
  other: { ko: '파일', en: 'file' },
};

export function driveKindLabel(kind: DriveFileKind, language: DriveLanguage): string {
  return (KIND_LABEL[kind] ?? KIND_LABEL.other)[language];
}

/**
 * The guarded file name: the placeholder when credential-shaped (checked on the full value and on the normalized text
 * that is shown), else its links replaced by the shared neutralizer, then clipped.
 */
function nameOf(file: DriveFileSummary, language: DriveLanguage): MessagePart {
  if (file.name.trim().length === 0) return language === 'en' ? '(untitled)' : '(이름 없음)';
  const placeholder = language === 'en' ? '(name hidden)' : '(이름 숨김)';
  return guardedClippedSpan(file.name, DRIVE_NAME_DISPLAY_MAX_CHARS, placeholder);
}

function entryLine(index: number, file: DriveFileSummary, options: DriveRenderOptions): MessageBody {
  return messageBody(
    `${index}. `,
    nameOf(file, options.language),
    ` · ${driveKindLabel(file.kind, options.language)} · ${mailDateLabel(file.modifiedAt, options)}`,
  );
}

/** The quoted owner-typed name of a search (still an untrusted span: it is echoed into chat). */
function nameQuery(name: string): MessagePart {
  return guardedClippedSpan(name, DRIVE_NAME_QUERY_DISPLAY_MAX_CHARS, '(…)');
}

function countText(result: DriveListResult, language: DriveLanguage): string {
  const more = result.matchedIsLowerBound;
  if (language === 'en') return `${result.matched}${more ? '+' : ''} file${result.matched === 1 && !more ? '' : 's'}`;
  return `${result.matched}건${more ? ' 이상' : ''}`;
}

function header(filter: DriveListingFilter, result: DriveListResult, options: DriveRenderOptions): MessageBody {
  const count = countText(result, options.language);
  if (filter.fileKind !== undefined) {
    const kind = driveKindLabel(filter.fileKind, options.language);
    if (filter.kind === 'recent') return options.language === 'en' ? `Recently modified ${kind}: ${count}` : `최근 수정한 ${kind}: ${count}`;
    return options.language === 'en' ? messageBody(`${kind} named "`, nameQuery(filter.name), `": ${count}`) : messageBody('"', nameQuery(filter.name), `" 이름의 ${kind}: ${count}`);
  }
  if (options.language === 'en') {
    return filter.kind === 'recent'
      ? `Recently modified files: ${count}`
      : messageBody('Files named "', nameQuery(filter.name), `": ${count}`);
  }
  return filter.kind === 'recent' ? `최근 수정한 파일: ${count}` : messageBody('"', nameQuery(filter.name), `" 이름의 파일: ${count}`);
}

function emptyAnswer(filter: DriveListingFilter, language: DriveLanguage): MessageBody {
  if (filter.fileKind !== undefined) {
    const kind = driveKindLabel(filter.fileKind, language);
    if (filter.kind === 'recent') return language === 'en' ? `No recently modified ${kind}.` : `최근 수정한 ${kind}가 없어요.`;
    return language === 'en' ? messageBody(`No ${kind} named "`, nameQuery(filter.name), '".') : messageBody('"', nameQuery(filter.name), `" 이름이 들어간 ${kind}를 찾지 못했어요.`);
  }
  if (language === 'en') {
    return filter.kind === 'recent' ? 'No recently modified files.' : messageBody('No file named "', nameQuery(filter.name), '".');
  }
  return filter.kind === 'recent'
    ? '최근 수정한 파일이 없어요.'
    : messageBody('"', nameQuery(filter.name), '" 이름이 들어간 파일을 찾지 못했어요.');
}

/** The footer of every listing: read-only, the zone, and how a summary works (only that file's text leaves the host). */
export function driveListingFooter(
  timeZone: string,
  language: DriveLanguage,
  hasEntries: boolean,
  copy?: DriveSourceCopy,
): MessageBody {
  const zone = untrustedText(timeZone.replace(/\s+/g, ' '));
  const label = labelOf(copy, language);
  if (language === 'en') {
    return hasEntries
      ? messageBody(`(${label}, read-only · times in `, zone, ' · "summarize document 1" sends only that file\'s text to the chat model)')
      : messageBody(`(${label}, read-only · times in `, zone, ')');
  }
  return hasEntries
    ? messageBody(`(${label} 읽기 전용 · `, zone, ' 기준 · "1번 문서 요약해줘"라고 하면 그 문서의 텍스트만 대화 모델에 보내 요약해요)')
    : messageBody(`(${label} 읽기 전용 · `, zone, ' 기준)');
}

/** The two line breaks around the list body, plus room always reserved for the closing "…외 N건" line. */
const DRIVE_LIST_RESERVE_CHARS = 2 + 40;

/**
 * The listing of a successful read. Entries are numbered from 1 in the order shown (newest modified first); the
 * numbers are what `N번 문서 요약해줘` refers to. Files past {@link DRIVE_REPLY_MAX_ENTRIES} and matches the read only
 * counted are summarised as "…외 N건" (`N건 이상` when the count stopped at its bound).
 */
export function renderDriveListing(filter: DriveListingFilter, result: DriveListResult, options: DriveRenderOptions): MessageBody {
  const { language } = options;
  const shown = result.files.slice(0, DRIVE_REPLY_MAX_ENTRIES);
  if (shown.length === 0 && result.matched === 0) {
    return joinBody([emptyAnswer(filter, language), driveListingFooter(options.timeZone, language, false, options.copy)]);
  }
  const hidden = Math.max(0, result.matched - shown.length);
  const lowerBound = result.matchedIsLowerBound;
  return messageBody(
    takeLines({
      unit: 'code-points',
      maxChars: DRIVE_REPLY_MAX_CHARS,
      baseChars: DRIVE_LIST_RESERVE_CHARS,
      head: [header(filter, result, options)],
      tail: [driveListingFooter(options.timeZone, language, shown.length > 0, options.copy)],
      lines: shown.map((file, index) => ({ content: entryLine(index + 1, file, options), item: true })),
      omitted:
        language === 'en'
          ? { hidden, before: '…and ', after: lowerBound ? '+ more' : ' more' }
          : { hidden, before: '…외 ', after: lowerBound ? '건 이상' : '건' },
    }),
  );
}

/** The truthful note for a failed read: it always says the files were NOT checked (never "no files"). */
export function renderDriveReadFailure(failure: DriveReadFailure, language: DriveLanguage, copy?: DriveSourceCopy): string {
  const en = language === 'en';
  const label = labelOf(copy, language);
  const hint = hintOf(copy, language);
  switch (failure) {
    case 'UNAUTHORIZED':
      return en
        ? `I couldn't check your files: the ${label} connection expired or was revoked.${hint}`
        : `${label} 연결이 만료됐거나 취소돼서 파일을 확인하지 못했어요.${hint}`;
    case 'INSUFFICIENT_SCOPE':
      return en
        ? `I couldn't check your files: read access to ${label} has not been granted yet.${hint}`
        : `${label} 읽기 권한에 아직 동의하지 않아서 파일을 확인하지 못했어요.${hint}`;
    case 'FORBIDDEN':
      return en
        ? `I couldn't check your files: ${label} refused the access (the grant is broader than read-only, or an administrator blocks it).`
        : `${label} 접근이 거부돼서 파일을 확인하지 못했어요. 권한이 읽기 전용보다 넓거나 관리자가 막았을 수 있어요.`;
    case 'NOT_FOUND':
      return en
        ? "I couldn't read that file: it no longer exists or is no longer shared with you. Ask for the list again."
        : '그 파일을 읽지 못했어요. 삭제됐거나 공유가 해제됐을 수 있어요. 목록을 다시 보여 달라고 해 주세요.';
    case 'RATE_LIMITED':
      return en
        ? `I couldn't check your files: ${label} is rate-limiting requests right now. Please try again shortly.`
        : `${label} 요청 한도에 걸려서 파일을 확인하지 못했어요. 잠시 후 다시 물어봐 주세요.`;
    case 'UNSUPPORTED_QUERY':
      return en ? "I can't look up files with that condition." : '그 조건으로는 파일을 찾을 수 없어요.';
    case 'INVALID_RESPONSE':
      return en
        ? `I couldn't check your files: the ${label} response could not be read.`
        : `${label} 응답을 해석하지 못해서 파일을 확인하지 못했어요.`;
    case 'TIMEOUT':
      return en
        ? `I couldn't check your files: ${label} didn't answer in time. Please try again shortly.`
        : `${label} 응답이 제한 시간 안에 오지 않아서 파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.`;
    case 'UNAVAILABLE':
    default:
      return en
        ? `I couldn't check your files: ${label} can't be reached right now. Please try again shortly.`
        : `지금은 ${label}에 연결할 수 없어서 파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.`;
  }
}

/** ADR-0118 D5: outside the owner's DM nothing is read. */
export function renderDriveDmOnly(language: DriveLanguage): string {
  return language === 'en'
    ? 'Drive file listings and summaries are answered only in a direct message. Nothing was read here; ask me again in a DM.'
    : '드라이브 파일 목록과 문서 요약은 DM에서만 답해요. 여기서는 파일을 읽지 않았어요. 저에게 DM으로 다시 물어봐 주세요.';
}

/** ADR-0118 D6: no create, edit, move, rename, delete, upload, share or permission change. */
export function renderDriveWriteRefused(language: DriveLanguage): string {
  return language === 'en'
    ? "I can only read your Drive files. Creating, editing, moving, renaming, deleting, uploading, sharing and permission changes aren't available, so nothing was changed."
    : '드라이브는 읽기만 할 수 있어요. 파일 만들기·수정·이동·이름 변경·삭제·업로드·공유·권한 변경은 하지 않아서 아무것도 바꾸지 않았어요.';
}

export function renderDriveUsage(language: DriveLanguage): string {
  return language === 'en'
    ? 'You can ask: "recent documents", "find <name> in my drive", then "summarize document 1" after a list. Search is by file name only, and the drive is read-only.'
    : '드라이브는 이렇게 물어볼 수 있어요: "최근 문서", "드라이브에서 <이름> 찾아줘", 목록을 본 뒤 "1번 문서 요약해줘". 검색은 파일 이름으로만 하고, 드라이브는 읽기만 해요.';
}

/** A summary request with no recent Drive listing in this conversation. */
export function renderDriveSummaryNeedsListing(language: DriveLanguage): string {
  return language === 'en'
    ? 'Which document? Ask for a list first ("recent documents" or "find <name> in my drive"), then say "summarize document 1".'
    : '요약할 문서를 먼저 골라 주세요. "최근 문서"나 "드라이브에서 <이름> 찾아줘"로 목록을 본 뒤 "1번 문서 요약해줘"라고 해 주세요.';
}

/** "이 문서" while the last listing had several entries. */
export function renderDriveSummaryWhich(count: number, language: DriveLanguage): string {
  return language === 'en'
    ? `The last list has ${count} files. Which one should I summarize? For example: "summarize document 1".`
    : `방금 목록에 파일이 ${count}건 있어요. 몇 번 문서를 요약할까요? 예: "1번 문서 요약해줘"`;
}

/** A number the last displayed list did not show: nothing is read; the reply names the shown range and the usage line. */
export function renderDriveSummaryOutOfRange(index: number, count: number, language: DriveLanguage): string {
  if (count === 0) return renderDriveSummaryNeedsListing(language);
  return language === 'en'
    ? `The last list showed no file ${index} (1–${count}). ${renderDriveUsage(language)}`
    : `방금 보여 드린 목록에 ${index}번 파일이 없어요 (1–${count}번). ${renderDriveUsage(language)}`;
}

/** The listed file has no text export (a presentation, a PDF, a folder, another kind): nothing was read. */
export function renderDriveSummaryNotText(kind: DriveFileKind, language: DriveLanguage): string {
  const label = driveKindLabel(kind, language);
  if (kind === 'text') {
    return language === 'en'
      ? 'Uploaded text files are not read, so I did not read or summarize that one. Only Google Docs and Sheets can be summarized.'
      : '업로드한 텍스트 파일은 읽지 않아요. 구글 문서·스프레드시트만 요약할 수 있어요.';
  }
  return language === 'en'
    ? `That file is a ${label}, which has no text export, so I did not read or summarize it. Google Docs and Sheets can be summarized.`
    : `그 파일은 ${label} 형식이라 텍스트로 읽을 수 없어서 읽거나 요약하지 않았어요. 구글 문서·스프레드시트만 요약할 수 있어요.`;
}

/** Nothing was sent: the file is credential-shaped (withheld, never redacted) or has no text. */
export function renderDriveSummaryRefused(refusal: UntrustedDocumentRefusal, language: DriveLanguage): string {
  if (refusal === 'EMPTY') {
    return language === 'en'
      ? 'That document has no text to summarize. Nothing was sent anywhere.'
      : '그 문서에는 요약할 텍스트가 없어요. 내용은 어디로도 보내지 않았어요.';
  }
  return language === 'en'
    ? 'That document looks like it contains a secret, so I did not summarize it. Its text was not sent anywhere.'
    : '그 문서에 비밀값처럼 보이는 내용이 있어 요약하지 않았어요. 내용은 어디로도 보내지 않았어요.';
}

/** The reply when the summary could not be produced (no ready provider, a provider failure). */
export function renderDriveSummaryUnavailable(language: DriveLanguage): string {
  return language === 'en'
    ? "I couldn't summarize that document right now. Please try again shortly."
    : '지금은 문서를 요약하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/** The deterministic disclosure appended to a successful summary. */
export function renderDriveSummaryFooter(language: DriveLanguage): string {
  return language === 'en'
    ? "(This document's text was sent to the chat model to summarize it · the drive was only read; nothing was changed or shared)"
    : '(문서 1건의 텍스트를 대화 모델에 보내 요약했어요 · 드라이브는 읽기만 했고 아무것도 바꾸거나 공유하지 않았어요)';
}

/** What a Drive reply did, for its history note: listed files, read nothing, or read but showed nothing. */
export type DriveHistoryKind = 'listed' | 'not-read' | 'not-summarized';

/**
 * What SHORT_TERM history keeps instead of a Drive reply (TurnHandlerReply.history): no file name, so a later chat
 * turn's context — which may go to a REMOTE provider — never carries Drive content (ADR-0118 D7). The note says
 * truthfully what happened.
 */
export function renderDriveHistoryNote(language: DriveLanguage, kind: DriveHistoryKind): string {
  const en = language === 'en';
  switch (kind) {
    case 'listed':
      return en
        ? '[Quoky listed Drive files; file names are not kept in the conversation history.]'
        : '[드라이브 파일 목록 응답 — 파일 이름은 대화 기록에 남기지 않아요.]';
    case 'not-summarized':
      return en
        ? '[Quoky did not summarize the requested document; its content is not kept in the conversation history.]'
        : '[요청한 문서를 요약하지 않음 — 문서 내용은 대화 기록에 남기지 않아요.]';
    case 'not-read':
    default:
      return en ? '[Quoky answered a Drive request without reading any file.]' : '[드라이브 요청에 안내만 함 — 파일은 읽지 않았어요.]';
  }
}
