import type { MailMessage, MailThread } from '../../ports/mail-reader.port';
import { MAIL_THREAD_MAX_MESSAGES, MAIL_THREAD_TEXT_MAX_BYTES } from '../../ports/mail-reader.port';
import { clipHeadAndTail } from '../attachment-context';
import { joinSections, type ChunkSection } from '../chunking';
import { containsCredentialFileContent, containsCredentialMaterial } from '../credential-guard';
import { neutralizeLinks } from '../link-neutralizer';
import {
  UNTRUSTED_DOCUMENT_AUTHOR_MAX_CHARS,
  UNTRUSTED_DOCUMENT_BODY_MAX_CHARS,
  buildUntrustedDocumentReadout,
  normalizeUntrustedText,
  prepareUntrustedBody,
  type UntrustedDocumentBuildResult,
} from '../untrusted-document-readout';

/**
 * The bounded, untrusted readout of ONE mail thread the owner explicitly asked to summarize (ADR-0118 amendment of
 * 2026-10-12, GML-2). The same ADR-0111 D3 / ADR-0118 D7 rules as a single mail ({@link buildUntrustedDocumentReadout}),
 * applied to a conversation:
 *
 * - **Count and bytes.** At most {@link MAIL_THREAD_MAX_MESSAGES} messages (the first and the latest when the thread is
 *   longer) and {@link MAIL_THREAD_TEXT_MAX_BYTES} of body text in all, re-checked here whatever the reader returned.
 * - **Credential guard before the clip.** Every message's full normalized subject, sender and body is guarded; one match
 *   withholds the whole thread (never redacted, nothing is sent).
 * - **Quoted history removed.** A reply usually quotes the messages before it, which are already in the readout; lines
 *   starting with `>` and everything after a reply header (`On … wrote:`, `…님이 작성:`, `-----Original Message-----`)
 *   are dropped from a message, unless that would leave it empty.
 * - **A fair head-and-tail clip.** The 3,000-code-point body budget is shared so every shown message keeps its start
 *   and end (short messages give their unused share to long ones), each under a fixed `[i/n] sender (domain) · date`
 *   line. Anything in a body that imitates the `[i/n]` marker is rewritten before and after the clip, so only Core
 *   writes one.
 * - **Credential guard after the clip.** The builder guards the composed body again, then the clipped body and the exact
 *   prompt text.
 */

export interface MailThreadReadoutResult {
  readonly result: UntrustedDocumentBuildResult;
  /** How many messages the readout carries. */
  readonly shown: number;
  /** How many messages the thread holds. */
  readonly total: number;
  /**
   * How many shown messages had their body withheld (GML-2 review rule: the guard is trusted only on complete text): a
   * body the reader could not hand over whole (empty and marked cut), or one larger than its share here.
   */
  readonly withheld: number;
}

/** What a withheld body reads as in the readout (Core-authored, inside the untrusted body; no mail text). */
export const MAIL_THREAD_WITHHELD_BODY_NOTE = '(body withheld: it could not be checked whole for secrets, so it is not summarized)';

/** A Core header line: `[2/5] 김철수 · 2026-10-08 00:12Z`. */
const HEADER_SENDER_MAX_CHARS = 30;
/** No message's share is smaller than this many code points (a 20-message thread still shows each one's gist). */
const MIN_MESSAGE_SHARE = 60;
/**
 * Anything in a body that imitates the Core header marker (`[3/5]`, anywhere on a line) — rewritten to `(3/5)`, before
 * and again after the clip, so only Core writes one. (NFKC already folded full-width brackets and digits.)
 */
const HEADER_IMITATION = /\[(\s*\d{1,3}\s*)\/(\s*\d{1,3}\s*)\]/gu;
const HEADER_DOMAIN_MAX_CHARS = 60;

function withoutHeaderImitations(text: string): string {
  return text.replace(HEADER_IMITATION, '($1/$2)');
}
/** A reply header is one short line. */
const QUOTE_HEADER_MAX_CHARS = 300;
/** Reply headers after which the rest of a message is quoted history (bounded, single-line patterns). */
const QUOTE_HEADERS: readonly RegExp[] = [
  /^On .{1,200}wrote:\s*$/u,
  /^.{1,200}님이 작성:\s*$/u,
  /^.{1,200}에 .{1,120}작성:\s*$/u,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/iu,
  /^-{2,}\s*원본 메시지\s*-{2,}\s*$/u,
];

function isCredentialShaped(text: string): boolean {
  return containsCredentialMaterial(text) || containsCredentialFileContent(text);
}

/** At most `maxBytes` of UTF-8, cut on a code-point boundary. */
function cutUtf8(text: string, maxBytes: number): { readonly text: string; readonly cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, cut: false };
  let bytes = 0;
  let out = '';
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += point;
  }
  return { text: out, cut: true };
}

/** The first message and the latest ones, in order, when the thread holds more than the bound. */
function boundedMessages(messages: readonly MailMessage[]): readonly MailMessage[] {
  if (messages.length <= MAIL_THREAD_MAX_MESSAGES) return messages;
  return [messages[0] as MailMessage, ...messages.slice(messages.length - (MAIL_THREAD_MAX_MESSAGES - 1))];
}

/**
 * The reply's own words: quoted lines and the history after a reply header removed (kept whole if nothing is left).
 * Exported for the mail adapter, which strips before it splits the thread's byte budget (CA review P3).
 */
export function stripQuotedMailHistory(body: string): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Only a short line can be a reply header (and the bounded patterns stay cheap on a long one).
    if (trimmed.length <= QUOTE_HEADER_MAX_CHARS && QUOTE_HEADERS.some((pattern) => pattern.test(trimmed))) break;
    if (/^\s*>/u.test(line)) continue;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return text.length > 0 ? text : body;
}

function oneLine(value: string, max: number): string {
  const text = neutralizeLinks(normalizeUntrustedText(value), 'display').replace(/\s+/gu, ' ').replace(/[[\]]/gu, '').trim();
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

function senderLabel(message: MailMessage): string {
  const name = oneLine(message.sender.name, HEADER_SENDER_MAX_CHARS);
  if (name.length > 0) return name;
  const address = typeof message.sender.address === 'string' ? message.sender.address : '';
  const at = address.lastIndexOf('@');
  return oneLine(at > 0 ? address.slice(0, at) : address, HEADER_SENDER_MAX_CHARS);
}

/**
 * CA review P3: the sender's address domain, defanged (`example[.]com`, which no link neutralizer rewrites), so a display
 * name that imitates someone ("대표이사" from a stranger's domain) is visible in every header. `''` when there is none.
 */
function senderDomain(message: MailMessage): string {
  const address = typeof message.sender.address === 'string' ? normalizeUntrustedText(message.sender.address) : '';
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  const domain = address.slice(at + 1).toLowerCase().replace(/[^a-z0-9.-]/gu, '').replace(/^[.-]+|[.-]+$/gu, '');
  if (domain.length === 0 || !domain.includes('.')) return '';
  return domain.slice(0, HEADER_DOMAIN_MAX_CHARS).replace(/\./gu, '[.]');
}

function dateLabel(receivedAt: string): string {
  const ms = Date.parse(receivedAt);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z` : '';
}

/** Water-filling: each length gets at most an equal share of `budget`, and what a short one leaves goes to the rest. */
function fairShares(lengths: readonly number[], budget: number): number[] {
  const shares = lengths.map(() => 0);
  let remaining = Math.max(0, budget);
  const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length);
  order.forEach(({ length, index }, position) => {
    const fair = Math.floor(remaining / (order.length - position));
    const share = Math.min(length, Math.max(fair, MIN_MESSAGE_SHARE));
    shares[index] = share;
    remaining = Math.max(0, remaining - share);
  });
  return shares;
}

/**
 * Build the thread readout, or refuse it (`EMPTY` when no message has text, `CREDENTIAL_SHAPED` when any field of any
 * message matches the guard). Pure.
 */
export function buildMailThreadReadout(thread: MailThread): MailThreadReadoutResult {
  const all = Array.isArray(thread?.messages) ? thread.messages : [];
  const messages = boundedMessages(all);
  const total = Math.max(all.length, Number.isInteger(thread?.totalMessages) ? thread.totalMessages : 0);
  const shown = messages.length;
  if (shown === 0) return { result: { ok: false, refusal: 'EMPTY' }, shown, total, withheld: 0 };

  // The byte bound across the thread, whatever the reader did: each body may use at most its share of what is left.
  let bytesLeft = MAIL_THREAD_TEXT_MAX_BYTES;
  let sourceTruncated = shown < total;
  const prepared: string[] = [];
  const withheldAt = new Set<number>();
  for (const [index, message] of messages.entries()) {
    const share = Math.floor(bytesLeft / (shown - index));
    const raw = typeof message.bodyText === 'string' ? message.bodyText : '';
    const cut = cutUtf8(raw, share);
    if (cut.cut || message.bodyTruncated) sourceTruncated = true;
    // The guard is trusted only on complete text: a body Core would have to cut before guarding it, or one the reader
    // marks cut with no text (withheld upstream), is withheld here — never a pre-guard cut.
    const withheld = cut.cut || (raw.trim().length === 0 && message.bodyTruncated === true);
    if (withheld) withheldAt.add(index);
    bytesLeft -= withheld ? 0 : Buffer.byteLength(raw, 'utf8');
    const body = withheld ? '' : neutralizeLinks(prepareUntrustedBody(raw), 'body');
    // Review P1 rule (GML-1), per message: the guard reads every FULL normalized field before any clip.
    const subject = normalizeUntrustedText(typeof message.subject === 'string' ? message.subject : '');
    const name = normalizeUntrustedText(typeof message.sender?.name === 'string' ? message.sender.name : '');
    const address = normalizeUntrustedText(typeof message.sender?.address === 'string' ? message.sender.address : '');
    if ([body, subject, name, address].some((field) => field.length > 0 && isCredentialShaped(field))) {
      return { result: { ok: false, refusal: 'CREDENTIAL_SHAPED' }, shown, total, withheld: withheldAt.size };
    }
    prepared.push(withoutHeaderImitations(stripQuotedMailHistory(body)));
  }
  if (prepared.every((body) => body.length === 0)) return { result: { ok: false, refusal: 'EMPTY' }, shown, total, withheld: withheldAt.size };

  const headers = messages.map((message, index) => {
    const date = dateLabel(message.receivedAt);
    const domain = senderDomain(message);
    return `[${index + 1}/${shown}] ${senderLabel(message)}${domain.length > 0 ? ` (${domain})` : ''}${date.length > 0 ? ` · ${date}` : ''}`;
  });
  const frame = headers.reduce((sum, header) => sum + Array.from(header).length + 3, 0);
  const shares = fairShares(prepared.map((body) => Array.from(body).length), UNTRUSTED_DOCUMENT_BODY_MAX_CHARS - frame);
  const parts = prepared.map((body, index) => {
    const clipped = clipHeadAndTail(body, Math.max(shares[index] ?? 0, MIN_MESSAGE_SHARE));
    if (clipped.truncated) sourceTruncated = true;
    const text = withoutHeaderImitations(clipped.text);
    if (withheldAt.has(index)) return `${headers[index]}\n${MAIL_THREAD_WITHHELD_BODY_NOTE}`;
    return `${headers[index]}\n${text.length > 0 ? text : '(no text)'}`;
  });

  const first = messages.find((message) => typeof message.subject === 'string' && message.subject.trim().length > 0);
  const participants = [...new Set(messages.map(senderLabel).filter((label) => label.length > 0))].join(', ');
  const latest = messages[messages.length - 1] as MailMessage;
  const result = buildUntrustedDocumentReadout({
    source: 'mail-thread',
    title: first?.subject ?? '',
    author: oneLine(participants, UNTRUSTED_DOCUMENT_AUTHOR_MAX_CHARS),
    date: latest.receivedAt,
    body: parts.join('\n\n'),
    sourceTruncated,
  });
  return { result, shown, total, withheld: withheldAt.size };
}

/**
 * ADR-0124 Part L C5a-2: what a thread message reads as in the S3 input when every line removed from it was a quote of
 * earlier messages (Core-authored, inside the untrusted body; no mail text).
 */
export const MAIL_THREAD_QUOTE_ONLY_NOTE = '(only quotes earlier messages)';
/** The same, when some removed lines were unmarked repeats (a forwarded or top-posted history without `>`). */
export const MAIL_THREAD_REPEAT_ONLY_NOTE = '(only repeats earlier messages)';

/** A line of only quote markers (`>`, `> >`): structure, no text. */
const QUOTE_MARKERS_ONLY = /^\s*>[\s>]*$/u;
/** Leading quote markers of a line (`> > text`). */
const LEADING_QUOTE_MARKERS = /^(?:\s*>)+/u;
/**
 * Anything in a body that imitates a Core frame (`[메시지 2/5]`, `[Message 2/5] …`, `[2/5]`): a bracketed span on one line
 * that holds an `i/n` fraction, rewritten to parentheses so only Core writes a frame. Structural (brackets and digits).
 */
const FRAME_IMITATION = /\[([^[\]\n]{0,40}?\d{1,3}\s*\/\s*\d{1,3}[^[\]\n]{0,80}?)\]/gu;
/** Unmarked repeated lines are dropped only in runs of at least this many (review round 1, CA P2). */
const UNMARKED_REPEAT_RUN = 3;

/** The comparison key of a line: without its quote markers, whitespace collapsed. */
function quoteKey(line: string): string {
  return line.replace(LEADING_QUOTE_MARKERS, '').replace(/\s+/gu, ' ').trim();
}

/**
 * Owner Q12 (2026-11-09), structural only: a reply that quotes the messages before it repeats lines the S3 input already
 * holds. No phrase is matched. In each message (review round 1, CA P2):
 *
 * - a `>`-marked line whose text (markers removed) appeared in an EARLIER message of the shown thread is dropped, and so is
 *   a line of quote markers only;
 * - an unmarked line is dropped only inside a run of at least {@link UNMARKED_REPEAT_RUN} consecutive repeated unmarked
 *   lines (blank lines continue a run but do not count), so a short reply that happens to repeat an earlier line (a
 *   one-line acknowledgement from another sender) survives;
 * - a message left with nothing reads as {@link MAIL_THREAD_QUOTE_ONLY_NOTE} when every removed line was marked, else as
 *   {@link MAIL_THREAD_REPEAT_ONLY_NOTE}.
 */
export function withoutRepeatedQuotes(bodies: readonly string[]): string[] {
  const seen = new Set<string>();
  return bodies.map((body) => {
    const lines = body.split('\n');
    const keys = lines.map(quoteKey);
    const marked = lines.map((line) => LEADING_QUOTE_MARKERS.test(line));
    const drop = lines.map((line, index) => QUOTE_MARKERS_ONLY.test(line) || (marked[index] === true && (keys[index] ?? '').length > 0 && seen.has(keys[index] ?? '')));
    // Runs of repeated unmarked lines (blank lines continue a run without counting).
    let runStart = -1;
    let runCount = 0;
    const closeRun = (end: number): void => {
      if (runStart >= 0 && runCount >= UNMARKED_REPEAT_RUN) {
        for (let index = runStart; index < end; index += 1) {
          if ((keys[index] ?? '').length > 0) drop[index] = true;
        }
      }
      runStart = -1;
      runCount = 0;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const key = keys[index] ?? '';
      if (key.length === 0 || marked[index] === true) {
        if (marked[index] === true) closeRun(index);
        continue;
      }
      if (seen.has(key)) {
        if (runStart < 0) runStart = index;
        runCount += 1;
      } else {
        closeRun(index);
      }
    }
    closeRun(lines.length);
    for (const key of keys) {
      if (key.length > 0) seen.add(key);
    }
    const kept = lines.filter((_, index) => drop[index] !== true);
    const text = kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
    if (text.length > 0) return text;
    const removedUnmarked = lines.some((line, index) => drop[index] === true && marked[index] !== true && !QUOTE_MARKERS_ONLY.test(line));
    return removedUnmarked ? MAIL_THREAD_REPEAT_ONLY_NOTE : MAIL_THREAD_QUOTE_ONLY_NOTE;
  });
}

/** The S3 input of one thread (ADR-0124 Part L C5a-2). */
export interface MailThreadLongItemText {
  readonly title: string;
  readonly author: string;
  readonly date: string;
  /** Every shown message, prepared, repeated quotes removed, joined under Core frames (`[메시지 i/n] sender · date`). */
  readonly prepared: string;
  readonly sections: readonly ChunkSection[];
  /** Shown in part (the first and latest of a longer thread), a body cut or withheld, or a body the reader cut. */
  readonly sourceTruncated: boolean;
}

/**
 * ADR-0124 Part L C5a-2: the WHOLE thread for the S3 whole-item summary, under the same bounds as
 * {@link buildMailThreadReadout} (the shown messages, the thread byte bound, a body withheld when it would have to be cut
 * before its guard) but with no head-and-tail clip: each message is one section framed by Core (`[메시지 i/n]` or
 * `[Message i/n]`, sender, domain, date), and repeated quotes are removed structurally ({@link withoutRepeatedQuotes}).
 * `undefined` when the readout would refuse (credential-shaped or empty): the caller already refused from the readout.
 * Pure; the S3 guard re-reads the full text and every frame.
 */
export function buildMailThreadLongItem(thread: MailThread, language: 'ko' | 'en'): MailThreadLongItemText | undefined {
  const all = Array.isArray(thread?.messages) ? thread.messages : [];
  const messages = boundedMessages(all);
  const total = Math.max(all.length, Number.isInteger(thread?.totalMessages) ? thread.totalMessages : 0);
  const shown = messages.length;
  if (shown === 0) return undefined;
  let bytesLeft = MAIL_THREAD_TEXT_MAX_BYTES;
  let sourceTruncated = shown < total;
  const bodies: string[] = [];
  const withheldAt = new Set<number>();
  for (const [index, message] of messages.entries()) {
    const share = Math.floor(bytesLeft / (shown - index));
    const raw = typeof message.bodyText === 'string' ? message.bodyText : '';
    const cut = cutUtf8(raw, share);
    if (cut.cut || message.bodyTruncated) sourceTruncated = true;
    const withheld = cut.cut || (raw.trim().length === 0 && message.bodyTruncated === true);
    if (withheld) withheldAt.add(index);
    bytesLeft -= withheld ? 0 : Buffer.byteLength(raw, 'utf8');
    const body = withheld ? '' : neutralizeLinks(prepareUntrustedBody(raw), 'body');
    const subject = normalizeUntrustedText(typeof message.subject === 'string' ? message.subject : '');
    const name = normalizeUntrustedText(typeof message.sender?.name === 'string' ? message.sender.name : '');
    const address = normalizeUntrustedText(typeof message.sender?.address === 'string' ? message.sender.address : '');
    if ([body, subject, name, address].some((field) => field.length > 0 && isCredentialShaped(field))) return undefined;
    bodies.push(body);
  }
  if (bodies.every((body) => body.length === 0)) return undefined;
  const deduped = withoutRepeatedQuotes(bodies);
  const word = language === 'en' ? 'Message' : '메시지';
  const parts = messages.map((message, index) => {
    const date = dateLabel(message.receivedAt);
    const domain = senderDomain(message);
    const frame = `[${word} ${index + 1}/${shown}] ${senderLabel(message)}${domain.length > 0 ? ` (${domain})` : ''}${date.length > 0 ? ` · ${date}` : ''}`;
    const own = bodies[index] ?? '';
    const text = withheldAt.has(index) ? MAIL_THREAD_WITHHELD_BODY_NOTE : own.length === 0 ? '(no text)' : (deduped[index] ?? '').replace(FRAME_IMITATION, '($1)');
    return { frame, body: text };
  });
  const joined = joinSections(parts);
  const first = messages.find((message) => typeof message.subject === 'string' && message.subject.trim().length > 0);
  const participants = [...new Set(messages.map(senderLabel).filter((label) => label.length > 0))].join(', ');
  const latest = messages[messages.length - 1] as MailMessage;
  return {
    title: first?.subject ?? '',
    author: oneLine(participants, UNTRUSTED_DOCUMENT_AUTHOR_MAX_CHARS),
    date: latest.receivedAt,
    prepared: joined.text,
    sections: joined.sections,
    sourceTruncated: sourceTruncated || withheldAt.size > 0,
  };
}
