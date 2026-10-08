/**
 * Telegram response delivery (ADR-0114 D7, relates ADR-0016). Pure, framework-free helpers so the 4096-character limit,
 * chunking and send-failure handling are unit-testable without the network.
 *
 * Budgets: Core keeps its own reply budgets (the 1,800/1,900-character lists and clamps of PLT-0), which fit a Telegram
 * message as they fit a Discord one; ADR-0114 asks for no adapter-reported budget. What a Core reply does not bound
 * (a model answer, a long listing) is split here, LOSSLESSLY: the chunks joined back are exactly the text.
 */

import type { PreviewArtifact } from '@quoky/core';
import { escapeTelegramHtml } from './rendering';

/** Telegram's hard limit for one message's text (characters after entity parsing; counted here in UTF-16 units). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Room kept for the `(i/n) ` prefix of a multi-part reply. */
const PART_PREFIX_RESERVE = 16;
/** The chunk body limit: a numbered chunk is still ≤ {@link TELEGRAM_MESSAGE_LIMIT}. */
export const TELEGRAM_CHUNK_LIMIT = TELEGRAM_MESSAGE_LIMIT - PART_PREFIX_RESERVE;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Where to cut `rest` so the piece is ≤ `limit`: newline, else space, else a hard cut (never inside a pair or a ``` run). */
function chooseCut(rest: string, limit: number): number {
  const window = rest.slice(0, limit);
  const minBoundary = Math.floor(limit * 0.6);
  const nl = window.lastIndexOf('\n');
  const sp = window.lastIndexOf(' ');
  let cut = nl >= minBoundary ? nl + 1 : sp >= minBoundary ? sp + 1 : limit;
  // Never split a surrogate pair (an astral emoji or CJK extension character would become two broken halves).
  if (cut < rest.length && isHighSurrogate(rest.charCodeAt(cut - 1)) && isLowSurrogate(rest.charCodeAt(cut))) cut -= 1;
  // Never split a backtick run (a fence marker stays whole in one chunk).
  if (cut < rest.length && rest[cut - 1] === '`' && rest[cut] === '`') {
    let runStart = cut;
    while (runStart > 0 && rest[runStart - 1] === '`') runStart -= 1;
    if (runStart > 0) cut = runStart;
  }
  return Math.max(cut, 1);
}

/**
 * Split text into pieces of at most `maxLen` UTF-16 units, preferring newline then space boundaries; an over-long
 * token is hard-cut. LOSSLESS: `chunks.join('') === text`, nothing is added or removed (plain text has no fence to
 * rebalance), a surrogate pair is never split and a backtick run is never split.
 */
export function chunkTelegramText(text: string, maxLen: number = TELEGRAM_CHUNK_LIMIT): string[] {
  if (maxLen < 2) throw new RangeError('maxLen must be at least 2');
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const cut = chooseCut(rest, maxLen);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Number multi-part replies so they read in order (a single chunk gets no prefix). */
export function numberChunks(chunks: readonly string[]): string[] {
  return chunks.length >= 2 ? chunks.map((chunk, index) => `(${index + 1}/${chunks.length}) ${chunk}`) : [...chunks];
}

/** Short notice shown once when delivery partially fails (ADR-0016; the Discord wording). */
export const PARTIAL_FAILURE_NOTICE = '답변 일부를 전송하지 못했어요.';

export interface TelegramDeliveryReport {
  readonly totalChunks: number;
  readonly sent: number;
  readonly ok: boolean;
  /** The failure's fixed code (never a message that could carry content or the URL). */
  readonly errorCode?: string;
}

export type TelegramChunkSender = (chunk: string) => Promise<void>;

/**
 * Send `text` as ordered numbered chunks. Sequential; on the first failure it STOPS (partial delivery), attempts the
 * short notice once and reports — no resend, so no duplicate messages.
 */
export async function deliverTelegramText(
  text: string,
  send: TelegramChunkSender,
  notify: (notice: string) => Promise<void>,
  errorCodeOf: (error: unknown) => string,
): Promise<TelegramDeliveryReport> {
  const outgoing = numberChunks(chunkTelegramText(text));
  let sent = 0;
  for (const chunk of outgoing) {
    try {
      await send(chunk);
      sent += 1;
    } catch (err) {
      await notify(PARTIAL_FAILURE_NOTICE).catch(() => undefined);
      return { totalChunks: outgoing.length, sent, ok: false, errorCode: errorCodeOf(err) };
    }
  }
  return { totalChunks: outgoing.length, sent, ok: true };
}

// ── Code-change previews: the fixed HTML subset (`<pre>` only), lossless ─────────────────────────────────────────

/** Above this many diff parts the complete diff goes as one `.diff` document instead (the Discord threshold). */
export const TELEGRAM_PREVIEW_PART_THRESHOLD = 5;
/** Room for `[nn/nn]\n<pre></pre>` around a part (escaped length). */
const PREVIEW_WRAPPER_RESERVE = 32;

/** The safety trailer after the final diff part (out-of-scope warning, then the apply-boundary footer). */
export function previewTrailer(artifact: PreviewArtifact): string {
  return `${artifact.warning ? `\n${artifact.warning}` : ''}\n${artifact.footer}`;
}

/** One diff part as Telegram HTML: the adapter's own `<pre>` around escaped content; nothing else is markup. */
export function wrapPreviewPart(segment: string, index: number, total: number): string {
  const prefix = total > 1 ? `[${index}/${total}]\n` : '';
  return `${prefix}<pre>${escapeTelegramHtml(segment)}</pre>`;
}

export type TelegramPreviewPlan =
  | { readonly mode: 'text'; readonly parts: readonly string[] }
  | { readonly mode: 'attachment'; readonly reason: 'oversized-line' | 'part-threshold' | 'empty-budget' };

/**
 * Split the canonical diff into whole lines whose ESCAPED length fits the part budget (so the part fits however
 * Telegram counts: the escaped form is never shorter than the visible one). Lossless: the segments joined are the diff.
 */
function splitEscaped(diff: string, budget: number): string[] | 'oversized-line' {
  const lines = diff.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const segments: string[] = [];
  let current = '';
  let currentLength = 0;
  for (const line of lines) {
    const length = escapeTelegramHtml(line).length;
    if (length > budget) return 'oversized-line';
    if (current.length > 0 && currentLength + length > budget) {
      segments.push(current);
      current = '';
      currentLength = 0;
    }
    current += line;
    currentLength += length;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Decide how to deliver a complete preview (PURE): HTML text parts within budget and threshold, else a document. */
export function planTelegramPreview(
  artifact: PreviewArtifact,
  opts: { readonly limit?: number; readonly partThreshold?: number } = {},
): TelegramPreviewPlan {
  const limit = opts.limit ?? TELEGRAM_MESSAGE_LIMIT;
  const threshold = opts.partThreshold ?? TELEGRAM_PREVIEW_PART_THRESHOLD;
  const trailer = escapeTelegramHtml(previewTrailer(artifact));
  const budget = limit - PREVIEW_WRAPPER_RESERVE - trailer.length;
  if (budget <= 0) return { mode: 'attachment', reason: 'empty-budget' };
  const split = splitEscaped(artifact.canonicalDiff, budget);
  if (split === 'oversized-line') return { mode: 'attachment', reason: 'oversized-line' };
  if (split.length > threshold) return { mode: 'attachment', reason: 'part-threshold' };
  const parts = split.map((segment, index) => wrapPreviewPart(segment, index + 1, split.length));
  const last = parts.length - 1;
  return { mode: 'text', parts: parts.map((part, index) => (index === last ? `${part}${trailer}` : part)) };
}

export type TelegramPreviewOutcome =
  | 'SUCCESS_TEXT_COMPLETE'
  | 'SUCCESS_ATTACHMENT_COMPLETE'
  | 'PARTIAL_TEXT_ATTACHMENT_COMPLETE'
  | 'DELIVERY_FAILED';

/** Length-only delivery metadata; carries no diff content. */
export interface TelegramPreviewReport {
  readonly previewId: string;
  readonly outcome: TelegramPreviewOutcome;
  readonly deliveryMode: 'text' | 'attachment';
  readonly partCount: number;
  readonly deliveredPartCount: number;
  readonly canonicalDiffLength: number;
}

export interface TelegramPreviewSenders {
  /** Plain text (no parse mode). */
  readonly sendPlain: (text: string) => Promise<void>;
  /** One diff part in the fixed HTML subset. */
  readonly sendHtml: (html: string) => Promise<void>;
  /** The COMPLETE canonical diff as one `.diff` document. */
  readonly sendDocument: (canonicalDiff: string, filename: string) => Promise<void>;
  readonly notify: (notice: string) => Promise<void>;
}

const PREVIEW_ATTACHMENT_NOTICE = '전체 diff는 첨부파일로 보내드렸어요.';

/**
 * Deliver a COMPLETE code-change preview losslessly: the header (plain), then ordered `<pre>` parts with the safety
 * trailer atomic with the last one; otherwise, or on a known part failure, the caption (plain) and the complete diff as
 * a document. Never a blind resend; an explicit outcome on every path.
 */
export async function deliverTelegramPreview(
  artifact: PreviewArtifact,
  senders: TelegramPreviewSenders,
): Promise<TelegramPreviewReport> {
  const plan = planTelegramPreview(artifact);
  const base = { previewId: artifact.previewId, canonicalDiffLength: artifact.canonicalDiff.length };
  const caption = `${artifact.header}\n(전체 diff는 첨부파일로 보내드려요.)${previewTrailer(artifact)}`;
  const sendComplete = async (): Promise<boolean> => {
    try {
      for (const chunk of numberChunks(chunkTelegramText(caption))) await senders.sendPlain(chunk);
      await senders.sendDocument(artifact.canonicalDiff, artifact.attachmentFilename);
      return true;
    } catch {
      return false;
    }
  };
  if (plan.mode === 'attachment') {
    const ok = await sendComplete();
    if (!ok) await senders.notify(PARTIAL_FAILURE_NOTICE).catch(() => undefined);
    return { ...base, outcome: ok ? 'SUCCESS_ATTACHMENT_COMPLETE' : 'DELIVERY_FAILED', deliveryMode: 'attachment', partCount: 0, deliveredPartCount: 0 };
  }
  const fallback = async (delivered: number): Promise<TelegramPreviewReport> => {
    const ok = await sendComplete();
    if (!ok) {
      await senders.notify(PARTIAL_FAILURE_NOTICE).catch(() => undefined);
      return { ...base, outcome: 'DELIVERY_FAILED', deliveryMode: 'text', partCount: plan.parts.length, deliveredPartCount: delivered };
    }
    await senders.notify(PREVIEW_ATTACHMENT_NOTICE).catch(() => undefined);
    return {
      ...base,
      outcome: delivered === 0 ? 'SUCCESS_ATTACHMENT_COMPLETE' : 'PARTIAL_TEXT_ATTACHMENT_COMPLETE',
      deliveryMode: 'text',
      partCount: plan.parts.length,
      deliveredPartCount: delivered,
    };
  };
  try {
    for (const chunk of numberChunks(chunkTelegramText(artifact.header))) await senders.sendPlain(chunk);
  } catch {
    return fallback(0);
  }
  if (plan.parts.length === 0) {
    // An empty diff has no part to carry the trailer: the safety trailer still goes, as plain text.
    try {
      await senders.sendPlain(previewTrailer(artifact).trimStart());
    } catch {
      return fallback(0);
    }
  }
  let delivered = 0;
  for (const part of plan.parts) {
    try {
      await senders.sendHtml(part);
      delivered += 1;
    } catch {
      return fallback(delivered);
    }
  }
  return { ...base, outcome: 'SUCCESS_TEXT_COMPLETE', deliveryMode: 'text', partCount: plan.parts.length, deliveredPartCount: delivered };
}
