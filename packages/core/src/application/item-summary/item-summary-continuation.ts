/**
 * ADR-0121 amendment A8.5 (OQ1-3): the pure parts of the continuation after the owner's yes to the rule-① question for an unexpected
 * recipient of ONE live item summary. The runtime re-reads the item through the same handler and the same content-free selection;
 * only when the re-read names the very item the owner said yes to (the same handler, source and item id, and for a thread the
 * same message count) may the one summary call go out. Otherwise the reply is the fixed "changed" line and nothing is sent.
 *
 * Plain data: the descriptors are compared as opaque ids and counts. No content, title or owner text is read here.
 */

/** The ids-only facts of one confirmed or re-read item (the shape of the turn-handler consent descriptor). */
export interface ItemSummaryContinuationFacts {
  readonly source: string;
  readonly itemId: string;
  readonly parts?: { readonly threadMessages: number };
  readonly redo: { readonly handlerId: string };
}

const isThreadSource = (source: string): boolean => source === 'mail-thread' || source === 'slack-thread';

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether the re-read names exactly the confirmed item: the same handler, source and item id, and for a mail or Slack thread a
 * defined message count equal to the count at the question. Total: any doubt is `false`.
 */
export function sameItemAsConfirmed(confirmed: ItemSummaryContinuationFacts, reread: ItemSummaryContinuationFacts | undefined): boolean {
  try {
    if (reread === undefined) return false;
    if (reread.source !== confirmed.source || reread.itemId !== confirmed.itemId || reread.redo.handlerId !== confirmed.redo.handlerId) return false;
    if (!isThreadSource(confirmed.source)) return true;
    const asked = confirmed.parts?.threadMessages;
    const now = reread.parts?.threadMessages;
    return isCount(asked) && isCount(now) && asked === now;
  } catch {
    return false;
  }
}

const CHANGED = {
  ko: '확인한 뒤로 항목이 바뀌어서 요약을 보내지 않았어요. 다시 요청해 주세요.',
  en: 'The item changed after you confirmed, so nothing was sent. Please ask again.',
} as const;

/** The fixed line of a continuation whose re-read is not the confirmed item (A8.5 "a changed item sends nothing"). No content or ids. */
export function renderItemSummaryChangedLine(language: 'ko' | 'en'): string {
  return language === 'en' ? CHANGED.en : CHANGED.ko;
}
