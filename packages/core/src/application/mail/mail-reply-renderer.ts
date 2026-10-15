import type { IsoTimestamp, MessageBody } from '../../domain';
import type { ConnectorQueryErrorReason } from '../../ports/connector-query';
import type { MailMessageSummary, MailSearchResult } from '../../ports/mail-reader.port';
import { clip, guardedClippedSpan } from '../guarded-clip';
import { joinBody, messageBody, takeLines, untrustedText, type MessagePart } from '../message-rendering';
import { addLocalDays, compareLocalDates, localDateOf, toZonedDateTime } from '../reminders/zoned-time';
import type { UntrustedDocumentRefusal } from '../untrusted-document-readout';
import type { MailLanguage } from './mail-question';

/**
 * Deterministic mail replies (ADR-0118 D4–D7, GML-1). Pure: every instant is rendered in the owner's zone
 * (`QUOKY_TIMEZONE`) from the data passed in; nothing here reads a clock, calls a provider or a reader.
 *
 * A listing shows, per message, the sender's display name (else the address), the subject, the date and a short
 * snippet — all untrusted readout (ADR-0100 D8): clipped, rendered as untrusted spans the platform neutralizes
 * (no mentions, no markup; PLT-0), and each replaced by a fixed placeholder when it looks like credential material
 * (ADR-0097). At most {@link MAIL_REPLY_MAX_ENTRIES} entries inside {@link MAIL_REPLY_MAX_CHARS} of the delivered text;
 * the rest is counted as "…외 N건". A failed read is answered with a "could not read" note, never as "no mail".
 */

export const MAIL_REPLY_MAX_CHARS = 1900;
export const MAIL_REPLY_MAX_ENTRIES = 10;
/**
 * Review P2 (Codex) / P3-2: a listing number must always name an entry the owner saw. Core cannot know which entries a
 * platform's budget would drop, so the display caps are sized so that {@link MAIL_REPLY_MAX_ENTRIES} entries ALWAYS fit
 * in {@link MAIL_REPLY_MAX_CHARS} even when every untrusted character renders as two (an escape before each character,
 * the worst case of the platform markups in use). The `take-lines` budget below is then a safety net that never drops
 * an entry; `mail-reply-renderer.test.ts` (a doubling markup) and the app test `mail-listing-fit.test.ts` (the real
 * platform markups) pin it, so the handler's number → message mapping is exactly the displayed list.
 */
export const MAIL_SENDER_DISPLAY_MAX_CHARS = 14;
export const MAIL_SUBJECT_DISPLAY_MAX_CHARS = 30;
export const MAIL_SNIPPET_DISPLAY_MAX_CHARS = 18;
/** The owner-typed sender echoed in a listing header. */
export const MAIL_SENDER_QUERY_DISPLAY_MAX_CHARS = 20;

/** Why a mail read produced no answer: the ADR-0100 reasons plus the handler's own timeout. */
export type MailReadFailure = ConnectorQueryErrorReason | 'TIMEOUT';

/** What a listing asked for (the header and the empty answer name it). */
export interface MailListingFilter {
  readonly unread: boolean;
  readonly today: boolean;
  /** A period other than today the mail was received in ("어제", "지난주"), as the owner-facing label per language. */
  readonly period?: { readonly ko: string; readonly en: string };
  readonly from?: string;
}

/**
 * Review P3-6: the source-specific words of the copy, supplied by the composition root from the adapter (the calendar
 * keeps its own copy the same way): Core names no mail provider, scope or consent tool.
 */
export interface MailSourceCopy {
  /** The mail source's display name per language (for example a provider name); at most 20 characters are shown. */
  readonly label: { readonly ko: string; readonly en: string };
  /** The owner's reconnect step, appended to the auth-expired and needs-consent notes. */
  readonly reconnectHint?: { readonly ko: string; readonly en: string };
}

/** The neutral copy used when the composition root supplies none. */
export const DEFAULT_MAIL_SOURCE_COPY: MailSourceCopy = Object.freeze({ label: Object.freeze({ ko: '메일', en: 'Mail' }) });

export interface MailRenderOptions {
  readonly timeZone: string;
  readonly now: IsoTimestamp;
  readonly language: MailLanguage;
  /** Defaults to {@link DEFAULT_MAIL_SOURCE_COPY}. */
  readonly copy?: MailSourceCopy;
}

function labelOf(copy: MailSourceCopy | undefined, language: MailLanguage): string {
  const label = (copy ?? DEFAULT_MAIL_SOURCE_COPY).label[language].replace(/\s+/g, ' ').trim();
  return clip(label.length > 0 ? label : DEFAULT_MAIL_SOURCE_COPY.label[language], 20);
}

function hintOf(copy: MailSourceCopy | undefined, language: MailLanguage): string {
  const hint = copy?.reconnectHint?.[language]?.trim();
  return hint ? ` ${hint}` : '';
}

const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * One guarded untrusted field (re-review item 2, final sign-off W-1, CA review P2-1): see `guardedClippedSpan` — the
 * credential check on the full, normalized and clipped text, links replaced, then clipped.
 */
function guardedField(value: string, maxChars: number, placeholder: string): MessagePart {
  return guardedClippedSpan(value, maxChars, placeholder);
}

/** The listing's guarded sender span, shared with the daily brief's mail section (ADR-0117 BRF-3). */
export function senderOf(message: MailMessageSummary, language: MailLanguage): MessagePart {
  const name = message.sender.name.trim();
  const shown = name.length > 0 ? name : message.sender.address.trim();
  if (shown.length === 0) return language === 'en' ? '(unknown sender)' : '(보낸 사람 없음)';
  return guardedField(shown, MAIL_SENDER_DISPLAY_MAX_CHARS, language === 'en' ? '(sender hidden)' : '(보낸 사람 숨김)');
}

/** The listing's guarded subject span, shared with the daily brief's mail section (ADR-0117 BRF-3). */
export function subjectOf(message: MailMessageSummary, language: MailLanguage): MessagePart {
  if (message.subject.trim().length === 0) return language === 'en' ? '(no subject)' : '(제목 없음)';
  return guardedField(message.subject, MAIL_SUBJECT_DISPLAY_MAX_CHARS, language === 'en' ? '(subject hidden)' : '(제목 숨김)');
}

function snippetOf(message: MailMessageSummary, language: MailLanguage): MessagePart | undefined {
  if (message.snippet.trim().length === 0) return undefined;
  return guardedField(message.snippet, MAIL_SNIPPET_DISPLAY_MAX_CHARS, language === 'en' ? '(preview hidden)' : '(미리보기 숨김)');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `오늘 09:12`, `어제 18:40`, `10월 6일 14:03`, `2025년 12월 30일` (EN: `today 09:12`, `Oct 6 14:03`, `Dec 30, 2025`). */
export function mailDateLabel(receivedAt: IsoTimestamp, options: MailRenderOptions): string {
  const ms = Date.parse(receivedAt);
  if (!Number.isFinite(ms)) return options.language === 'en' ? '(no date)' : '(날짜 없음)';
  const zoned = toZonedDateTime(ms, options.timeZone);
  const day = { year: zoned.year, month: zoned.month, day: zoned.day };
  const today = localDateOf(options.now, options.timeZone);
  const time = `${pad2(zoned.hour)}:${pad2(zoned.minute)}`;
  const en = options.language === 'en';
  if (compareLocalDates(day, today) === 0) return en ? `today ${time}` : `오늘 ${time}`;
  if (compareLocalDates(day, addLocalDays(today, -1)) === 0) return en ? `yesterday ${time}` : `어제 ${time}`;
  if (day.year === today.year) {
    return en ? `${MONTH_EN[day.month - 1]} ${day.day} ${time}` : `${day.month}월 ${day.day}일 ${time}`;
  }
  return en ? `${MONTH_EN[day.month - 1]} ${day.day}, ${day.year}` : `${day.year}년 ${day.month}월 ${day.day}일`;
}

function entryLine(index: number, message: MailMessageSummary, filter: MailListingFilter, options: MailRenderOptions): MessageBody {
  const { language } = options;
  const unreadMark = !filter.unread && message.unread ? (language === 'en' ? ' · unread' : ' · 안 읽음') : '';
  const snippet = snippetOf(message, language);
  return messageBody(
    `${index}. `,
    senderOf(message, language),
    ' · ',
    subjectOf(message, language),
    ` · ${mailDateLabel(message.receivedAt, options)}${unreadMark}`,
    ...(snippet !== undefined ? ['\n   ', snippet] : []),
  );
}

/** The quoted owner-typed sender of a `from` listing (still an untrusted span: it is echoed into chat). */
function senderQuery(from: string): MessagePart {
  return guardedClippedSpan(from, MAIL_SENDER_QUERY_DISPLAY_MAX_CHARS, '(…)');
}

function countText(result: MailSearchResult, language: MailLanguage): string {
  const more = result.matchedIsLowerBound;
  if (language === 'en') return `${result.matched}${more ? '+' : ''} message${result.matched === 1 && !more ? '' : 's'}`;
  return `${result.matched}건${more ? ' 이상' : ''}`;
}

function header(filter: MailListingFilter, result: MailSearchResult, options: MailRenderOptions): MessageBody {
  const en = options.language === 'en';
  const count = countText(result, options.language);
  const scope = en
    ? `${filter.unread ? 'Unread ' : ''}${filter.today ? "today's " : ''}mail${filter.period !== undefined ? ` received ${filter.period.en}` : ''}`
    : `${filter.today ? '오늘 받은 ' : ''}${filter.period !== undefined ? `${filter.period.ko} 받은 ` : ''}${filter.unread ? '안 읽은 ' : ''}메일`;
  if (filter.from !== undefined) {
    return en
      ? messageBody(`${scope.charAt(0).toUpperCase()}${scope.slice(1)} from "`, senderQuery(filter.from), `": ${count}`)
      : messageBody('"', senderQuery(filter.from), `" ${scope}: ${count}`);
  }
  return en ? `${scope.charAt(0).toUpperCase()}${scope.slice(1)}: ${count}` : `${scope}: ${count}`;
}

function emptyAnswer(filter: MailListingFilter, language: MailLanguage): MessageBody {
  if (language === 'en') {
    const scope = `${filter.unread ? 'unread ' : ''}${filter.today ? 'mail received today' : filter.period !== undefined ? `mail received ${filter.period.en}` : 'mail'}`;
    return filter.from !== undefined
      ? messageBody(`No ${scope} from "`, senderQuery(filter.from), '".')
      : `No ${scope}.`;
  }
  const scope = `${filter.today ? '오늘 받은 ' : ''}${filter.period !== undefined ? `${filter.period.ko} 받은 ` : ''}${filter.unread ? '안 읽은 ' : ''}메일`;
  return filter.from !== undefined
    ? messageBody('"', senderQuery(filter.from), `"에게서 온 ${scope}을 찾지 못했어요.`)
    : `${scope}이 없어요.`;
}

/** The footer of every listing: read-only, the zone, and how a summary works (only that mail's body leaves the host). */
export function mailListingFooter(
  timeZone: string,
  language: MailLanguage,
  hasEntries: boolean,
  copy?: MailSourceCopy,
): MessageBody {
  const zone = untrustedText(timeZone.replace(/\s+/g, ' '));
  const label = labelOf(copy, language);
  if (language === 'en') {
    return hasEntries
      ? messageBody(`(${label}, read-only · times in `, zone, ' · "summarize email 1" sends only that email\'s body to the chat model)')
      : messageBody(`(${label}, read-only · times in `, zone, ')');
  }
  return hasEntries
    ? messageBody(`(${label} 읽기 전용 · `, zone, ' 기준 · "1번 메일 요약해줘"라고 하면 그 메일 본문만 대화 모델에 보내 요약해요)')
    : messageBody(`(${label} 읽기 전용 · `, zone, ' 기준)');
}

/** The two line breaks around the list body, plus room always reserved for the closing "…외 N건" line. */
const MAIL_LIST_RESERVE_CHARS = 2 + 40;

/**
 * The listing of a successful search. Entries are numbered from 1 in the order shown (newest first); the numbers are
 * what `N번 메일 요약해줘` refers to. Messages past {@link MAIL_REPLY_MAX_ENTRIES}, matches the search only counted and
 * entries the message budget leaves out are summarised as "…외 N건" (`N건 이상` when the count stopped at its bound).
 */
export function renderMailListing(filter: MailListingFilter, result: MailSearchResult, options: MailRenderOptions): MessageBody {
  const { language } = options;
  const shown = result.messages.slice(0, MAIL_REPLY_MAX_ENTRIES);
  if (shown.length === 0 && result.matched === 0) {
    return joinBody([emptyAnswer(filter, language), mailListingFooter(options.timeZone, language, false, options.copy)]);
  }
  const hidden = Math.max(0, result.matched - shown.length);
  const lowerBound = result.matchedIsLowerBound;
  return messageBody(
    takeLines({
      unit: 'code-points',
      maxChars: MAIL_REPLY_MAX_CHARS,
      baseChars: MAIL_LIST_RESERVE_CHARS,
      head: [header(filter, result, options)],
      tail: [mailListingFooter(options.timeZone, language, shown.length > 0, options.copy)],
      lines: shown.map((message, index) => ({ content: entryLine(index + 1, message, filter, options), item: true })),
      omitted:
        language === 'en'
          ? { hidden, before: '…and ', after: lowerBound ? '+ more' : ' more' }
          : { hidden, before: '…외 ', after: lowerBound ? '건 이상' : '건' },
    }),
  );
}

/**
 * Live UAT R6: a number the owner asked about ("3번은 누가 보냈어?") that the last list does not have. It says how many
 * the list held; it never re-prints the list and reads nothing.
 */
export function renderMailPickOutOfRange(index: number, count: number, language: MailLanguage): string {
  if (count === 0) return renderMailSummaryNeedsListing(language);
  return language === 'en'
    ? `The last list has only ${count} email${count === 1 ? '' : 's'}, so there is no email ${index}.`
    : `목록에 ${count}건만 있어요. ${index}번 메일은 없어요.`;
}

/** Live UAT R6: the one listed mail the owner asked about, as a list line (sender, subject, date); no body is shown. */
export function renderMailPickLine(index: number, message: MailMessageSummary, options: MailRenderOptions): MessageBody {
  return entryLine(index, { ...message, snippet: '' }, { unread: false, today: false }, options);
}

/** The truthful note for a failed read: it always says the mail was NOT checked (never "no mail"). */
export function renderMailReadFailure(failure: MailReadFailure, language: MailLanguage, copy?: MailSourceCopy): string {
  const en = language === 'en';
  const label = labelOf(copy, language);
  const hint = hintOf(copy, language);
  switch (failure) {
    case 'UNAUTHORIZED':
      return en
        ? `I couldn't check your mail: the ${label} connection expired or was revoked.${hint}`
        : `${label} 연결이 만료됐거나 취소돼서 메일을 확인하지 못했어요.${hint}`;
    case 'INSUFFICIENT_SCOPE':
      return en
        ? `I couldn't check your mail: read access to ${label} has not been granted yet.${hint}`
        : `${label} 읽기 권한에 아직 동의하지 않아서 메일을 확인하지 못했어요.${hint}`;
    case 'FORBIDDEN':
      return en
        ? `I couldn't check your mail: ${label} refused the access (the grant is broader than read-only, or an administrator blocks it).`
        : `${label} 접근이 거부돼서 메일을 확인하지 못했어요. 권한이 읽기 전용보다 넓거나 관리자가 막았을 수 있어요.`;
    case 'NOT_FOUND':
      return en
        ? "I couldn't read that email: it no longer exists (deleted or moved). Ask for the list again."
        : '그 메일을 읽지 못했어요. 삭제됐거나 옮겨졌을 수 있어요. 목록을 다시 보여 달라고 해 주세요.';
    case 'RATE_LIMITED':
      return en
        ? `I couldn't check your mail: ${label} is rate-limiting requests right now. Please try again shortly.`
        : `${label} 요청 한도에 걸려서 메일을 확인하지 못했어요. 잠시 후 다시 물어봐 주세요.`;
    case 'UNSUPPORTED_QUERY':
      return en ? "I can't look up mail with that condition." : '그 조건으로는 메일을 찾을 수 없어요.';
    case 'INVALID_RESPONSE':
      return en
        ? `I couldn't check your mail: the ${label} response could not be read.`
        : `${label} 응답을 해석하지 못해서 메일을 확인하지 못했어요.`;
    case 'TIMEOUT':
      return en
        ? `I couldn't check your mail: ${label} didn't answer in time. Please try again shortly.`
        : `${label} 응답이 제한 시간 안에 오지 않아서 메일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.`;
    case 'UNAVAILABLE':
    default:
      return en
        ? `I couldn't check your mail: ${label} can't be reached right now. Please try again shortly.`
        : `지금은 ${label}에 연결할 수 없어서 메일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.`;
  }
}

/** ADR-0118 D5: outside the owner's DM nothing is read. */
export function renderMailDmOnly(language: MailLanguage): string {
  return language === 'en'
    ? 'Mail listings and summaries are answered only in a direct message. Nothing was read here; ask me again in a DM.'
    : '메일 목록과 요약은 DM에서만 답해요. 여기서는 메일을 읽지 않았어요. 저에게 DM으로 다시 물어봐 주세요.';
}

/** ADR-0118 D6: no send, reply, draft, label, archive or delete. */
export function renderMailWriteRefused(language: MailLanguage): string {
  return language === 'en'
    ? "I can only read your mail. Sending, replying, forwarding, deleting, archiving and labelling aren't available, so nothing was changed."
    : '메일은 읽기만 할 수 있어요. 보내기·답장·전달·삭제·보관·라벨 변경은 하지 않아서 아무것도 바꾸지 않았어요.';
}

export function renderMailUsage(language: MailLanguage): string {
  return language === 'en'
    ? 'You can ask: "unread emails", "emails today", "find emails from <sender>", then "summarize email 1" after a list. Mail is read-only.'
    : '메일은 이렇게 물어볼 수 있어요: "안 읽은 메일", "오늘 온 메일", "<보낸 사람> 메일 찾아줘", 목록을 본 뒤 "1번 메일 요약해줘". 메일은 읽기만 해요.';
}

/** A summary request with no recent listing in this conversation. */
export function renderMailSummaryNeedsListing(language: MailLanguage): string {
  return language === 'en'
    ? 'Which email? Ask for a list first ("unread emails" or "emails today"), then say "summarize email 1".'
    : '요약할 메일을 먼저 골라 주세요. "안 읽은 메일"이나 "오늘 온 메일"로 목록을 본 뒤 "1번 메일 요약해줘"라고 해 주세요.';
}

/** "이 메일" while the last listing had several entries. */
export function renderMailSummaryWhich(count: number, language: MailLanguage): string {
  return language === 'en'
    ? `The last list has ${count} emails. Which one should I summarize? For example: "summarize email 1".`
    : `방금 목록에 메일이 ${count}건 있어요. 몇 번 메일을 요약할까요? 예: "1번 메일 요약해줘"`;
}

/**
 * A number the last displayed list did not show (review P2): nothing is read; the reply names the shown range and the
 * usage line.
 */
export function renderMailSummaryOutOfRange(index: number, count: number, language: MailLanguage): string {
  if (count === 0) return renderMailSummaryNeedsListing(language);
  return language === 'en'
    ? `The last list showed no email ${index} (1–${count}). ${renderMailUsage(language)}`
    : `방금 보여 드린 목록에 ${index}번 메일이 없어요 (1–${count}번). ${renderMailUsage(language)}`;
}

/** Nothing was sent: the mail is credential-shaped (withheld, never redacted) or has no body. */
export function renderMailSummaryRefused(refusal: UntrustedDocumentRefusal, language: MailLanguage): string {
  if (refusal === 'EMPTY') {
    return language === 'en'
      ? 'That email has no body to summarize. Nothing was sent anywhere.'
      : '그 메일에는 요약할 본문이 없어요. 본문은 어디로도 보내지 않았어요.';
  }
  return language === 'en'
    ? 'That email looks like it contains a secret, so I did not summarize it. Its body was not sent anywhere.'
    : '그 메일에 비밀값처럼 보이는 내용이 있어 요약하지 않았어요. 본문은 어디로도 보내지 않았어요.';
}

/**
 * GML-2 review rule: the body could not be checked whole for secrets (cut before the guard, or credential-shaped), so it
 * was withheld; nothing was sent.
 */
export function renderMailSummaryWithheld(language: MailLanguage): string {
  return language === 'en'
    ? 'That email is too long to check safely as a whole, or looks like it contains a secret, so I did not summarize it. Its body was not sent anywhere.'
    : '그 메일은 본문이 너무 길어 전체를 안전하게 확인할 수 없거나 비밀값처럼 보이는 내용이 있어 요약하지 않았어요. 본문은 어디로도 보내지 않았어요.';
}

/** GML-2 review rule: every message of the thread had its body withheld; nothing was sent. */
export function renderMailThreadWithheld(language: MailLanguage): string {
  return language === 'en'
    ? 'The emails in that thread are too long to check safely as a whole, or look like they contain a secret, so I did not summarize it. Nothing was sent anywhere.'
    : '그 스레드의 메일 본문이 너무 길어 안전하게 확인할 수 없거나 비밀값처럼 보여 요약하지 않았어요. 본문은 어디로도 보내지 않았어요.';
}

/** The reply when the summary could not be produced (no ready provider, a provider failure). */
export function renderMailSummaryUnavailable(language: MailLanguage): string {
  return language === 'en'
    ? "I couldn't summarize that email right now. Please try again shortly."
    : '지금은 메일을 요약하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/** The deterministic disclosure appended to a successful summary. */
export function renderMailSummaryFooter(language: MailLanguage): string {
  return language === 'en'
    ? '(This email\'s body was sent to the chat model to summarize it · the mailbox was only read; nothing was sent or changed, and nothing was written to Jira, Slack or GitHub)'
    : '(메일 1건의 본문을 대화 모델에 보내 요약했어요 · 메일은 읽기만 했고 아무것도 보내거나 바꾸지 않았으며 Jira·Slack·GitHub에도 쓰지 않았어요)';
}

/** What a mail reply did, for its history note (review P3-7): listed mail, read nothing, or read but showed nothing. */
export type MailHistoryKind = 'listed' | 'not-read' | 'not-summarized';

/**
 * What SHORT_TERM history keeps instead of a mail reply (TurnHandlerReply.history): no sender, subject or snippet, so a
 * later chat turn's context — which may go to a REMOTE provider — never carries mail content (ADR-0118 D7). The note
 * says truthfully what happened (review P3-7): a DM-only, refusal, usage or failed-read reply read no mail.
 */
export function renderMailHistoryNote(language: MailLanguage, kind: MailHistoryKind): string {
  const en = language === 'en';
  switch (kind) {
    case 'listed':
      return en
        ? '[Quoky listed mail; mail details are not kept in the conversation history.]'
        : '[메일 목록 응답 — 메일 내용은 대화 기록에 남기지 않아요.]';
    case 'not-summarized':
      return en
        ? '[Quoky did not summarize the requested email; its content is not kept in the conversation history.]'
        : '[요청한 메일을 요약하지 않음 — 메일 내용은 대화 기록에 남기지 않아요.]';
    case 'not-read':
    default:
      return en ? '[Quoky answered a mail request without reading any mail.]' : '[메일 요청에 안내만 함 — 메일은 읽지 않았어요.]';
  }
}

/*
 * GML-2 (ADR-0118 amendment of 2026-10-12): thread summaries and reply picks. Fixed copy only; no mail field appears.
 */

/** "이 메일" in a reply to a listing that had several entries. */
export function renderMailReplyPickWhich(count: number, language: MailLanguage): string {
  return language === 'en'
    ? `The list you replied to has ${count} emails. Which one? For example: "summarize email 1".`
    : `답장하신 목록에 메일이 ${count}건 있어요. 몇 번 메일인지 알려 주세요. 예: "1번 메일 요약해줘"`;
}

/** A number the replied-to listing did not show; nothing is read. */
export function renderMailReplyPickOutOfRange(index: number, count: number, language: MailLanguage): string {
  return language === 'en'
    ? `The list you replied to showed no email ${index} (1–${count}). Nothing was read.`
    : `답장하신 목록에 ${index}번 메일이 없어요 (1–${count}번). 메일은 읽지 않았어요.`;
}

/** A reply to a listing Quoky showed too long ago: nothing is picked or read. */
export function renderMailReplyPickExpired(language: MailLanguage): string {
  return language === 'en'
    ? 'The list you replied to is too old to pick from (over 24 hours), so nothing was read. Ask for the list again.'
    : '답장하신 메일 목록이 오래돼서(24시간이 지남) 고를 수 없어요. 메일은 읽지 않았어요. 목록을 다시 보여 달라고 해 주세요.';
}

/**
 * A summary request sent as a reply to a message that is not a listing Quoky can still pick from (another message, or a
 * listing too old to be on record): nothing is picked or read, and the last list is NOT used instead.
 */
export function renderMailReplyPickUnknown(language: MailLanguage): string {
  return language === 'en'
    ? "I can't pick an email from the message you replied to (it isn't a mail list I can still use), so nothing was read. Ask for the list again."
    : '답장하신 메시지에서는 메일을 고를 수 없어요(메일 목록이 아니거나 오래된 목록이에요). 메일은 읽지 않았어요. 목록을 다시 보여 달라고 해 주세요.';
}

/** The configured mail source cannot read threads (its reader has no thread read). */
export function renderMailThreadNotSupported(language: MailLanguage): string {
  return language === 'en'
    ? 'This mail connection cannot read a whole thread. Nothing was read; "summarize email 1" summarizes one email.'
    : '지금 메일 연결로는 스레드 전체를 읽을 수 없어요. 메일은 읽지 않았어요. 메일 1건은 "1번 메일 요약해줘"로 요약할 수 있어요.';
}

/** Nothing was sent: a message of the thread is credential-shaped (withheld, never redacted) or none has text. */
export function renderMailThreadRefused(refusal: UntrustedDocumentRefusal, language: MailLanguage): string {
  if (refusal === 'EMPTY') {
    return language === 'en'
      ? 'That thread has no text to summarize. Nothing was sent anywhere.'
      : '그 스레드에는 요약할 본문이 없어요. 본문은 어디로도 보내지 않았어요.';
  }
  return language === 'en'
    ? 'A message in that thread looks like it contains a secret, so I did not summarize the thread. Nothing was sent anywhere.'
    : '그 스레드의 메일에 비밀값처럼 보이는 내용이 있어 요약하지 않았어요. 본문은 어디로도 보내지 않았어요.';
}

/** The reply when the thread summary could not be produced (no ready provider, a provider failure). */
export function renderMailThreadSummaryUnavailable(language: MailLanguage): string {
  return language === 'en'
    ? "I couldn't summarize that thread right now. Please try again shortly."
    : '지금은 메일 스레드를 요약하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/** The deterministic disclosure appended to a successful thread summary (how many messages were read and sent). */
export function renderMailThreadSummaryFooter(shown: number, total: number, language: MailLanguage, withheld = 0): string {
  const partial = total > shown;
  if (language === 'en') {
    const read = partial ? `the first and the latest ${shown - 1} of its ${total} emails` : `its ${shown} email${shown === 1 ? '' : 's'}`;
    const skipped = withheld > 0 ? ` · ${withheld} body${withheld === 1 ? ' was' : 'ies were'} too long to check safely and not summarized` : '';
    return `(One thread — ${read} — was sent to the chat model to summarize it${skipped} · the mailbox was only read; nothing was sent or changed, and nothing was written to Jira, Slack or GitHub)`;
  }
  const read = partial ? `${total}통 중 첫 메일과 최근 ${shown - 1}통` : `메일 ${shown}통`;
  const skipped = withheld > 0 ? ` · ${withheld}통은 본문이 너무 길어 안전하게 요약하지 않았어요` : '';
  return `(스레드 1개의 ${read} 본문을 대화 모델에 보내 요약했어요${skipped} · 메일은 읽기만 했고 아무것도 보내거나 바꾸지 않았으며 Jira·Slack·GitHub에도 쓰지 않았어요)`;
}
