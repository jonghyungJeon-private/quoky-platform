import type { IsoTimestamp, MessageBody } from '../../domain';
import type { ConnectorQueryErrorReason } from '../../ports/connector-query';
import type { MailMessageSummary, MailSearchResult } from '../../ports/mail-reader.port';
import { containsCredentialMaterial } from '../credential-guard';
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
export const MAIL_SENDER_DISPLAY_MAX_CHARS = 30;
export const MAIL_SUBJECT_DISPLAY_MAX_CHARS = 60;
export const MAIL_SNIPPET_DISPLAY_MAX_CHARS = 50;

/** Why a mail read produced no answer: the ADR-0100 reasons plus the handler's own timeout. */
export type MailReadFailure = ConnectorQueryErrorReason | 'TIMEOUT';

/** What a listing asked for (the header and the empty answer name it). */
export interface MailListingFilter {
  readonly unread: boolean;
  readonly today: boolean;
  readonly from?: string;
}

export interface MailRenderOptions {
  readonly timeZone: string;
  readonly now: IsoTimestamp;
  readonly language: MailLanguage;
}

const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`;
}

/** One guarded untrusted field: clipped, or the placeholder when credential-shaped (checked on the full value). */
function guardedField(value: string, maxChars: number, placeholder: string): MessagePart {
  if (value.trim().length > 0 && containsCredentialMaterial(value)) return placeholder;
  return untrustedText(clip(value, maxChars));
}

function senderOf(message: MailMessageSummary, language: MailLanguage): MessagePart {
  const name = message.sender.name.trim();
  const shown = name.length > 0 ? name : message.sender.address.trim();
  if (shown.length === 0) return language === 'en' ? '(unknown sender)' : '(보낸 사람 없음)';
  return guardedField(shown, MAIL_SENDER_DISPLAY_MAX_CHARS, language === 'en' ? '(sender hidden)' : '(보낸 사람 숨김)');
}

function subjectOf(message: MailMessageSummary, language: MailLanguage): MessagePart {
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
  return untrustedText(clip(from, MAIL_SENDER_DISPLAY_MAX_CHARS));
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
    ? `${filter.unread ? 'Unread ' : ''}${filter.today ? "today's " : ''}mail`
    : `${filter.today ? '오늘 받은 ' : ''}${filter.unread ? '안 읽은 ' : ''}메일`;
  if (filter.from !== undefined) {
    return en
      ? messageBody(`${scope.charAt(0).toUpperCase()}${scope.slice(1)} from "`, senderQuery(filter.from), `": ${count}`)
      : messageBody('"', senderQuery(filter.from), `" ${scope}: ${count}`);
  }
  return en ? `${scope.charAt(0).toUpperCase()}${scope.slice(1)}: ${count}` : `${scope}: ${count}`;
}

function emptyAnswer(filter: MailListingFilter, language: MailLanguage): MessageBody {
  if (language === 'en') {
    const scope = `${filter.unread ? 'unread ' : ''}${filter.today ? 'mail received today' : 'mail'}`;
    return filter.from !== undefined
      ? messageBody(`No ${scope} from "`, senderQuery(filter.from), '".')
      : `No ${scope}.`;
  }
  const scope = `${filter.today ? '오늘 받은 ' : ''}${filter.unread ? '안 읽은 ' : ''}메일`;
  return filter.from !== undefined
    ? messageBody('"', senderQuery(filter.from), `"에게서 온 ${scope}을 찾지 못했어요.`)
    : `${scope}이 없어요.`;
}

/** The footer of every listing: read-only, the zone, and how a summary works (only that mail's body leaves the host). */
export function mailListingFooter(timeZone: string, language: MailLanguage, hasEntries: boolean): MessageBody {
  const zone = untrustedText(timeZone.replace(/\s+/g, ' '));
  if (language === 'en') {
    return hasEntries
      ? messageBody('(Gmail, read-only · times in ', zone, ' · "summarize email 1" sends only that email\'s body to the chat model)')
      : messageBody('(Gmail, read-only · times in ', zone, ')');
  }
  return hasEntries
    ? messageBody('(Gmail 읽기 전용 · ', zone, ' 기준 · "1번 메일 요약해줘"라고 하면 그 메일 본문만 대화 모델에 보내 요약해요)')
    : messageBody('(Gmail 읽기 전용 · ', zone, ' 기준)');
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
    return joinBody([emptyAnswer(filter, language), mailListingFooter(options.timeZone, language, false)]);
  }
  const hidden = Math.max(0, result.matched - shown.length);
  const lowerBound = result.matchedIsLowerBound;
  return messageBody(
    takeLines({
      unit: 'code-points',
      maxChars: MAIL_REPLY_MAX_CHARS,
      baseChars: MAIL_LIST_RESERVE_CHARS,
      head: [header(filter, result, options)],
      tail: [mailListingFooter(options.timeZone, language, shown.length > 0)],
      lines: shown.map((message, index) => ({ content: entryLine(index + 1, message, filter, options), item: true })),
      omitted:
        language === 'en'
          ? { hidden, before: '…and ', after: lowerBound ? '+ more' : ' more' }
          : { hidden, before: '…외 ', after: lowerBound ? '건 이상' : '건' },
    }),
  );
}

/** The truthful note for a failed read: it always says the mail was NOT checked (never "no mail"). */
export function renderMailReadFailure(failure: MailReadFailure, language: MailLanguage): string {
  const en = language === 'en';
  switch (failure) {
    case 'UNAUTHORIZED':
      return en
        ? "I couldn't check your mail: the Gmail connection expired or was revoked. Reconnect with the consent helper (calendar-auth --gmail)."
        : 'Gmail 연결이 만료됐거나 취소돼서 메일을 확인하지 못했어요. 동의 도구(calendar-auth --gmail)로 다시 연결해 주세요.';
    case 'INSUFFICIENT_SCOPE':
      return en
        ? "I couldn't check your mail: read access to Gmail (gmail.readonly) has not been granted yet. Grant it with the consent helper (calendar-auth --gmail)."
        : 'Gmail 읽기 권한(gmail.readonly)에 아직 동의하지 않아서 메일을 확인하지 못했어요. 동의 도구(calendar-auth --gmail)로 권한을 허용해 주세요.';
    case 'FORBIDDEN':
      return en
        ? "I couldn't check your mail: Gmail refused the access (the grant is broader than gmail.readonly, or the Workspace administrator blocks it)."
        : 'Gmail이 접근을 거부해서 메일을 확인하지 못했어요. 권한이 gmail.readonly보다 넓거나 Workspace 관리자가 막았을 수 있어요.';
    case 'NOT_FOUND':
      return en
        ? "I couldn't read that email: it no longer exists (deleted or moved). Ask for the list again."
        : '그 메일을 읽지 못했어요. 삭제됐거나 옮겨졌을 수 있어요. 목록을 다시 보여 달라고 해 주세요.';
    case 'RATE_LIMITED':
      return en
        ? "I couldn't check your mail: Gmail is rate-limiting requests right now. Please try again shortly."
        : 'Gmail 요청 한도에 걸려서 메일을 확인하지 못했어요. 잠시 후 다시 물어봐 주세요.';
    case 'UNSUPPORTED_QUERY':
      return en ? "I can't look up mail with that condition." : '그 조건으로는 메일을 찾을 수 없어요.';
    case 'INVALID_RESPONSE':
      return en
        ? "I couldn't check your mail: Gmail's response could not be read."
        : 'Gmail 응답을 해석하지 못해서 메일을 확인하지 못했어요.';
    case 'TIMEOUT':
      return en
        ? "I couldn't check your mail: Gmail didn't answer in time. Please try again shortly."
        : 'Gmail이 제한 시간 안에 응답하지 않아서 메일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'UNAVAILABLE':
    default:
      return en
        ? "I couldn't check your mail: Gmail can't be reached right now. Please try again shortly."
        : '지금은 Gmail에 연결할 수 없어서 메일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
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

export function renderMailSummaryOutOfRange(index: number, count: number, language: MailLanguage): string {
  if (count === 0) return renderMailSummaryNeedsListing(language);
  return language === 'en'
    ? `The last list has no email ${index} (1–${count}). Check the number.`
    : `방금 목록에 ${index}번 메일이 없어요 (1–${count}번). 번호를 확인해 주세요.`;
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

/** The reply when the summary could not be produced (no ready provider, a provider failure). */
export function renderMailSummaryUnavailable(language: MailLanguage): string {
  return language === 'en'
    ? "I couldn't summarize that email right now. Please try again shortly."
    : '지금은 메일을 요약하지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/** The deterministic disclosure appended to a successful summary. */
export function renderMailSummaryFooter(language: MailLanguage): string {
  return language === 'en'
    ? '(This email\'s body was sent to the chat model to summarize it · the mailbox was only read; nothing was sent or changed)'
    : '(메일 1건의 본문을 대화 모델에 보내 요약했어요 · 메일은 읽기만 했고 아무것도 보내거나 바꾸지 않았어요)';
}

/**
 * What SHORT_TERM history keeps instead of a mail reply (TurnHandlerReply.history): no sender, subject or snippet, so a
 * later chat turn's context — which may go to a REMOTE provider — never carries mail content (ADR-0118 D7).
 */
export function renderMailHistoryNote(language: MailLanguage): string {
  return language === 'en'
    ? '[Quoky answered a mail question from Gmail; mail details are not kept in the conversation history.]'
    : '[메일 조회 응답 — 메일 내용은 대화 기록에 남기지 않아요.]';
}
