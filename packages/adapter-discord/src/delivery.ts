/**
 * Discord response delivery (ADR-0016). Pure, framework-free helpers so the
 * 2000-char limit, chunking, and send-failure handling are unit-testable without
 * a live gateway. Discord specifics stay in this adapter; the core never sees them.
 */

import { splitCanonicalDiff, type PreviewArtifact } from '@quoky/core';

/** Safe per-message length (Discord hard limit is 2000; headroom for safety). */
export const DISCORD_SAFE_LIMIT = 1900;

/**
 * Policy seam: above this many chunks, the intended behavior is to deliver the
 * response as a FILE ATTACHMENT instead of many messages. NOT implemented in v1
 * (seam + policy only) — we still send chunks and log that the threshold was hit.
 */
export const FILE_ATTACHMENT_CHUNK_THRESHOLD = 5;

/**
 * Split text into ≤ maxLen pieces, preferring newline then space boundaries;
 * an over-long single token is hard-cut. Pure slicing — no non-whitespace is lost.
 *
 * Code-fence aware (ADR-0094 delivery follow-up): when the text contains ``` fences, a chunk that would end
 * inside a fence is closed with a closing fence and the next chunk reopens with the same language tag, so every
 * delivered message renders balanced. Fence handling only adds fence markers/newlines (counted against
 * `maxLen`); text without fences is split exactly as before.
 */
export function chunkText(text: string, maxLen: number = DISCORD_SAFE_LIMIT): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxLen) return [text];
  if (maxLen < MIN_FENCE_AWARE_LIMIT || !text.includes(FENCE)) return chunkPlain(text, maxLen);
  return chunkFenceAware(text, maxLen);
}

const FENCE = '```';
/** Below this limit there is no room for a reopening fence + closing fence, so fences are not tracked. */
const MIN_FENCE_AWARE_LIMIT = 64;
/** Room reserved at the end of a chunk for "\n```" when the chunk ends inside a fence. */
const FENCE_CLOSER_RESERVE = FENCE.length + 1;
const FENCE_LANG = /^[A-Za-z0-9_+.#-]{1,32}$/;

/** Where to cut `rest` so the piece is ≤ `limit`: newline, else space, else a hard cut. */
function chooseCut(rest: string, limit: number): number {
  const window = rest.slice(0, limit);
  const minBoundary = Math.floor(limit * 0.6);
  const nl = window.lastIndexOf('\n');
  const sp = window.lastIndexOf(' ');
  if (nl >= minBoundary) return nl + 1;
  if (sp >= minBoundary) return sp + 1;
  return limit;
}

function chunkPlain(text: string, maxLen: number): string[] {
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

/** Fence state after `segment`, starting from `open` (the language tag of the open fence, or null). */
function advanceFence(open: string | null, segment: string): string | null {
  let state = open;
  let index = segment.indexOf(FENCE);
  while (index !== -1) {
    if (state === null) {
      const after = segment.slice(index + FENCE.length);
      const newline = after.indexOf('\n');
      const tag = newline === -1 ? '' : after.slice(0, newline);
      state = FENCE_LANG.test(tag) ? tag : '';
    } else {
      state = null;
    }
    index = segment.indexOf(FENCE, index + FENCE.length);
  }
  return state;
}

function chunkFenceAware(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  let open: string | null = null;

  for (;;) {
    const prefix = open === null ? '' : `${FENCE}${open}\n`;
    if (prefix.length + rest.length <= maxLen) {
      chunks.push(prefix + rest);
      return chunks;
    }
    let cut = chooseCut(rest, maxLen - prefix.length - FENCE_CLOSER_RESERVE);
    // Never split a ``` marker across two chunks.
    if (cut < rest.length && rest[cut - 1] === '`' && rest[cut] === '`') {
      let runStart = cut;
      while (runStart > 0 && rest[runStart - 1] === '`') runStart -= 1;
      if (runStart > 0) cut = runStart;
    }
    const body = rest.slice(0, cut);
    let endState = advanceFence(open, body);
    let out = prefix + body;
    if (endState !== null) {
      out += body.endsWith('\n') ? FENCE : `\n${FENCE}`;
      // The very next marker would only close this fence: the closer we just wrote already does that, so
      // consume it instead of reopening an empty block in the next chunk.
      if (rest.startsWith(FENCE, cut)) {
        cut += FENCE.length;
        endState = null;
      }
    }
    chunks.push(out);
    open = endState;
    rest = rest.slice(cut);
    if (rest.length === 0) return chunks;
  }
}

export interface DeliveryReport {
  totalChunks: number;
  sent: number;
  ok: boolean;
  error?: string;
}

export type ChunkSender = (chunk: string) => Promise<void>;

/**
 * Send `text` as ordered chunks via `send`. Sequential (awaits each before the
 * next, preserving order). On the first send failure it STOPS (partial delivery)
 * and reports — no resend, so no duplicate messages. Rate-limit backoff is
 * delegated to discord.js's REST layer (ADR-0016).
 */
export async function deliverChunks(
  text: string,
  send: ChunkSender,
  opts: { maxLen?: number } = {},
): Promise<DeliveryReport> {
  const chunks = chunkText(text, opts.maxLen ?? DISCORD_SAFE_LIMIT);
  const total = chunks.length;
  // Number multi-message replies so they read in order (single chunk = no prefix).
  const outgoing = total >= 2 ? chunks.map((c, i) => `(${i + 1}/${total}) ${c}`) : chunks;

  let sent = 0;
  for (const chunk of outgoing) {
    try {
      await send(chunk);
      sent += 1;
    } catch (err) {
      return {
        totalChunks: total,
        sent,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { totalChunks: total, sent, ok: true };
}

/** Short notice shown once when delivery partially fails (ADR-0016 / decision 3). */
export const PARTIAL_FAILURE_NOTICE = '답변 일부를 전송하지 못했어요.';

/**
 * Deliver chunks; if delivery partially fails, attempt the short notice ONCE
 * (no resend, no retry). A failing notice is swallowed (caller logs).
 */
export async function deliverWithNotice(
  text: string,
  send: ChunkSender,
  notify: (message: string) => Promise<void>,
  opts: { maxLen?: number } = {},
): Promise<DeliveryReport> {
  const report = await deliverChunks(text, send, opts);
  if (!report.ok) {
    await notify(PARTIAL_FAILURE_NOTICE).catch(() => undefined);
  }
  return report;
}

// ── Sprint 4c-Follow-up-5 (F5-C/D/E) — lossless multipart preview delivery ─────────────────────────

/**
 * Upper bound on the per-part wrapper overhead: the `[n/m]\n` prefix + the opening/closing ```diff fences
 * + newline slack. A conservative fixed reserve is a stable fixed-point (the actual wrapper never exceeds
 * it), so the payload budget handed to the core splitter guarantees each wrapped part stays ≤ the Discord
 * message limit (CA RC5). */
export const PREVIEW_WRAPPER_RESERVE = 40;

/** Explicit delivery outcomes (CA RC7) — never a false "complete" claim when Discord itself fails. */
export type PreviewDeliveryOutcome =
  | 'SUCCESS_TEXT_COMPLETE'
  | 'SUCCESS_ATTACHMENT_COMPLETE'
  | 'PARTIAL_TEXT_ATTACHMENT_COMPLETE'
  | 'DELIVERY_FAILED';

/** Length-only delivery metadata (CA RC8) — carries NO raw diff/proposal/file content. */
export interface PreviewDeliveryReport {
  /** The artifact's stable correlation id (F5-E) — same across chunks, fallback, and this report. */
  previewId: string;
  outcome: PreviewDeliveryOutcome;
  deliveryMode: 'text' | 'attachment';
  partCount: number;
  deliveredPartCount: number;
  attachmentFallbackUsed: boolean;
  canonicalDiffLength: number;
}

/** Platform send primitives (index.ts binds these to discord.js); kept out of the pure planner. */
export interface PreviewSenders {
  sendText: (text: string) => Promise<void>;
  /** Upload the COMPLETE canonical diff as a `.diff` attachment with a short caption. */
  sendAttachment: (canonicalDiff: string, filename: string, caption: string) => Promise<void>;
  notify?: (message: string) => Promise<void>;
}

/** Wrap one canonical PAYLOAD segment as an independently valid fenced Discord message (CA RC5). Each
 *  segment already ends with `\n` (canonical newline policy), so the closing fence sits on its own line. */
export function wrapDiffPart(payloadSegment: string, index: number, total: number): string {
  const prefix = total > 1 ? `[${index}/${total}]\n` : '';
  return `${prefix}\`\`\`diff\n${payloadSegment}\`\`\``;
}

/** The safety trailer appended AFTER the closing fence of the FINAL text message (and mirrored in the
 *  attachment caption): the out-of-scope warning (when present) then the apply-boundary footer. Leading
 *  newlines separate it from the fence. Kept in one place so budget reservation and delivery never drift. */
export function previewTrailer(artifact: PreviewArtifact): string {
  return `${artifact.warning ? `\n${artifact.warning}` : ''}\n${artifact.footer}`;
}

export type PreviewPlan =
  | { mode: 'text'; parts: string[]; canonicalDiffLength: number }
  | { mode: 'attachment'; reason: 'oversized-line' | 'part-threshold' | 'wrapped-overflow' | 'empty-budget'; canonicalDiffLength: number };

/**
 * Decide how to deliver a complete preview under the Discord budget (CA RC1/RC4/RC5/RC6). PURE: no send,
 * no discord.js. Text multipart when the diff splits within budget and part count ≤ threshold; otherwise a
 * complete `.diff` attachment. Never omits or splits a canonical diff line.
 */
export function planPreviewDelivery(
  artifact: PreviewArtifact,
  opts: { safeLimit?: number; partThreshold?: number } = {},
): PreviewPlan {
  const safeLimit = opts.safeLimit ?? DISCORD_SAFE_LIMIT;
  const partThreshold = opts.partThreshold ?? FILE_ATTACHMENT_CHUNK_THRESHOLD;
  const canonicalDiffLength = artifact.canonicalDiff.length;
  // Reserve room for the wrapper AND the safety trailer (out-of-scope warning + apply-boundary footer) that
  // deliverPreview appends to the FINAL part (F5 Finding 1 + warning propagation): with the trailer reserved
  // on every segment, `finalPart + trailer` is always ≤ safeLimit, so the boundary/warning framing is atomic
  // with the last diff message and never overflows.
  const trailerReserve = previewTrailer(artifact).length;
  const payloadBudget = safeLimit - PREVIEW_WRAPPER_RESERVE - trailerReserve;

  const split = splitCanonicalDiff(artifact.canonicalDiff, payloadBudget);
  if (split.kind === 'attachment-required') {
    return { mode: 'attachment', reason: split.reason === 'line-exceeds-budget' ? 'oversized-line' : 'empty-budget', canonicalDiffLength };
  }
  if (split.segments.length > partThreshold) {
    return { mode: 'attachment', reason: 'part-threshold', canonicalDiffLength };
  }
  const parts = split.segments.map((seg, i) => wrapDiffPart(seg, i + 1, split.segments.length));
  // Defensive: the final part carries the trailer, so verify IT (the largest) stays within the limit.
  const lastWithTrailer = parts.length > 0 ? `${parts[parts.length - 1]!}${previewTrailer(artifact)}` : '';
  if (parts.some((p) => p.length > safeLimit) || lastWithTrailer.length > safeLimit) {
    return { mode: 'attachment', reason: 'wrapped-overflow', canonicalDiffLength }; // reserve should prevent this
  }
  return { mode: 'text', parts, canonicalDiffLength };
}

const PREVIEW_ATTACHMENT_NOTICE = '전체 diff는 첨부파일로 보내드렸어요.';

/**
 * Deliver a COMPLETE code-change preview losslessly (CA RC3/RC7). Ordered text multipart when it fits;
 * otherwise (or on a known text-send failure) a complete `.diff` attachment. Never a blind duplicate
 * resend; explicit outcome on every path; a best-effort notice on failure.
 */
export async function deliverPreview(
  artifact: PreviewArtifact,
  senders: PreviewSenders,
  opts: { safeLimit?: number; partThreshold?: number } = {},
): Promise<PreviewDeliveryReport> {
  const plan = planPreviewDelivery(artifact, opts);
  const canonicalDiffLength = plan.canonicalDiffLength;
  const previewId = artifact.previewId;
  // The attachment caption carries the SAME safety trailer (out-of-scope warning + apply-boundary footer).
  const attachmentCaption = `${artifact.header}\n(전체 diff는 첨부파일로 보내드려요.)${previewTrailer(artifact)}`;

  const sendCompleteAttachment = async (): Promise<boolean> => {
    try {
      await senders.sendAttachment(artifact.canonicalDiff, artifact.attachmentFilename, attachmentCaption);
      return true;
    } catch {
      return false;
    }
  };

  if (plan.mode === 'attachment') {
    const ok = await sendCompleteAttachment();
    if (!ok) {
      await senders.notify?.(PARTIAL_FAILURE_NOTICE).catch(() => undefined);
      return { previewId, outcome: 'DELIVERY_FAILED', deliveryMode: 'attachment', partCount: 0, deliveredPartCount: 0, attachmentFallbackUsed: true, canonicalDiffLength };
    }
    return { previewId, outcome: 'SUCCESS_ATTACHMENT_COMPLETE', deliveryMode: 'attachment', partCount: 0, deliveredPartCount: 0, attachmentFallbackUsed: true, canonicalDiffLength };
  }

  // Text multipart: header → ordered [n/m] fenced parts → footer. A known failure at any diff part stops
  // further text sends and attempts ONE complete attachment (CA RC7) — no blind resend of sent parts.
  const attachmentFallback = async (delivered: number): Promise<PreviewDeliveryReport> => {
    const ok = await sendCompleteAttachment();
    if (!ok) {
      await senders.notify?.(PARTIAL_FAILURE_NOTICE).catch(() => undefined);
      return { previewId, outcome: 'DELIVERY_FAILED', deliveryMode: 'text', partCount: plan.parts.length, deliveredPartCount: delivered, attachmentFallbackUsed: true, canonicalDiffLength };
    }
    await senders.notify?.(PREVIEW_ATTACHMENT_NOTICE).catch(() => undefined);
    // 0 diff parts delivered as text → the attachment alone carries everything.
    return delivered === 0
      ? { previewId, outcome: 'SUCCESS_ATTACHMENT_COMPLETE', deliveryMode: 'text', partCount: plan.parts.length, deliveredPartCount: 0, attachmentFallbackUsed: true, canonicalDiffLength }
      : { previewId, outcome: 'PARTIAL_TEXT_ATTACHMENT_COMPLETE', deliveryMode: 'text', partCount: plan.parts.length, deliveredPartCount: delivered, attachmentFallbackUsed: true, canonicalDiffLength };
  };

  try {
    await senders.sendText(artifact.header);
  } catch {
    return attachmentFallback(0);
  }
  // F5 Finding 1 + warning propagation: the safety trailer (out-of-scope warning + apply-boundary footer)
  // is appended to the FINAL diff message so it is ATOMIC with the last part — SUCCESS_TEXT_COMPLETE is
  // returned only after that final (trailer-bearing) message is confirmed sent. A failure delivering it
  // routes to the attachment fallback like any other part failure; it is NEVER swallowed while claiming
  // success.
  const trailer = previewTrailer(artifact);
  let delivered = 0;
  for (let i = 0; i < plan.parts.length; i += 1) {
    const isLast = i === plan.parts.length - 1;
    const message = isLast ? `${plan.parts[i]!}${trailer}` : plan.parts[i]!;
    try {
      await senders.sendText(message);
      delivered += 1;
    } catch {
      return attachmentFallback(delivered);
    }
  }
  return { previewId, outcome: 'SUCCESS_TEXT_COMPLETE', deliveryMode: 'text', partCount: plan.parts.length, deliveredPartCount: delivered, attachmentFallbackUsed: false, canonicalDiffLength };
}
