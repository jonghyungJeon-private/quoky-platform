import type { MessageBody } from '../../domain';
import type { TurnHandlerReply } from '../../ports/conversation-turn-handler.port';
import { joinSections, type ChunkSection } from '../chunking';
import { neutralizeLinks } from '../link-neutralizer';
import { prepareUntrustedBody, untrustedDocumentSectionParts, type UntrustedDocumentSection, type UntrustedDocumentSource } from '../untrusted-document-readout';

/**
 * ADR-0124 Part L slice C5a-2 (DECISIONS ADR-0124 section 17, "slice 2"): the handler integration contract. A mail, thread
 * or Drive handler that answers a summary request with today's `summarize` outcome (its readout already built and guarded
 * by today's full-item guard) may attach the WHOLE prepared item as `longItem`. The runtime then runs the S3 whole-item
 * summary (`runS3ItemSummary`) before today's path when `QUOKY_CHUNK_ITEMS` is not `off`:
 *
 * - `today` / `S1`: today's path, byte for byte (the readout, the provider, the footer, the history note).
 * - `refused`: the handler's own refusal reply (`refused`), exactly as it would have refused the item.
 * - `summary` / `partial`: the S3 body plus Core's coverage line and the handler's LOCAL footer (`footer`), never the
 *   remote disclosure; the history keeps today's fixed note.
 *
 * The handler attaches it only when its composition says long items are on (`shadow` or `on`), so with the flag `off` the
 * handler's outcome is unchanged. Plain data; nothing here calls a model, stores or logs.
 */
export interface LongItemSummaryInput {
  readonly source: UntrustedDocumentSource;
  /** The item's raw title, author and date (S3 normalizes and guards them again, as today's builder does). */
  readonly title: string;
  readonly author: string;
  readonly date: string;
  /** The whole prepared item (normalized, link-neutralized): the chunker's input. */
  readonly prepared: string;
  /** Quoky's sections tiling `prepared` (thread messages, sheets). */
  readonly sections?: readonly ChunkSection[];
  /** The source already cut the item (a capped body, a thread shown in part, a withheld message, dropped sheets). */
  readonly sourceTruncated: boolean;
  /** The footer of an S3 reply: it says the item was summarized by a model on this device (Quoky copy). */
  readonly footer: MessageBody;
  /** The handler's refusal of a credential-shaped item, used when the S3 guard refuses what today's guard let through. */
  readonly refused: TurnHandlerReply;
}

/** The prepared text of one body: today's normalization and link neutralization (`buildUntrustedDocumentReadout`). */
export function preparedLongItemBody(body: string): string {
  return neutralizeLinks(prepareUntrustedBody(typeof body === 'string' ? body : ''), 'body');
}

/**
 * A spreadsheet read sheet by sheet: each sheet is a `table` section under today's `[Sheet i/n] "title"` frame, so a window
 * repeats a sheet's header row when it reads rows that are not adjacent to it. `undefined` when there are no sections or
 * none has text.
 */
export function sheetLongItemText(
  sections: readonly UntrustedDocumentSection[],
): { readonly prepared: string; readonly sections: readonly ChunkSection[]; readonly dropped: boolean } | undefined {
  const parts = untrustedDocumentSectionParts(sections, 'drive');
  if (parts === undefined) return undefined;
  const joined = joinSections(parts.list.map((part) => ({ frame: part.header, body: part.body, kind: 'table' as const })));
  return { prepared: joined.text, sections: joined.sections, dropped: parts.dropped };
}

/** Clause PN: the one fixed progress notice of a long S3 run (Core copy; the window count only, never model text). */
export function renderLongItemProgressNotice(windows: number, language: 'ko' | 'en'): string {
  const count = Number.isInteger(windows) && windows > 0 ? windows : 1;
  return PROGRESS_NOTICE[language].replace('{count}', String(count));
}

const PROGRESS_NOTICE = {
  ko: '긴 문서라 이 기기에서 {count}개 구간으로 나눠 읽고 있어요. 조금만 기다려 주세요.',
  en: 'This is a long item, so I am reading it in {count} parts on this device. It will take a moment.',
} as const;

/** Clause PN: the notice goes out after this long (8 s), at most once per request, in a DM only. */
export const LONG_ITEM_PROGRESS_NOTICE_AFTER_MS = 8_000;

/** Clause PN (review round 1, CA P3): the reply waits for the notice send at most this long (3 s). */
export const LONG_ITEM_PROGRESS_NOTICE_SEND_MAX_MS = 3_000;

/**
 * Review round 1 (CA P2): the footer of a partial S3 reply that read no part of the item. It makes no claim that anything
 * was summarized; it says only that the item was not sent to the chat model (true of every S3 run).
 */
export function renderLongItemUnreadFooter(language: 'ko' | 'en'): string {
  return UNREAD_FOOTER[language];
}

const UNREAD_FOOTER = {
  ko: '(본문은 대화 모델에 보내지 않았어요 · Quoky는 이 답변에서 아무 곳에도 쓰거나 보내지 않았어요)',
  en: '(The text was not sent to the chat model · nothing was written or sent anywhere by Quoky in this reply)',
} as const;
