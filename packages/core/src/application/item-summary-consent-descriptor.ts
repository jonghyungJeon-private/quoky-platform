import type { NlSelectedCommand } from './nl-routing/catalog';

/**
 * ADR-0121 amendment A8 (OQ1-1): the ids-only descriptor a turn handler attaches to its `summarize` outcome so a later
 * consent step can name exactly one item and re-run exactly the same read. Plain data: closed source noun, the item id, the
 * language and the redo selection (the handler id plus a content-free `item.summarize` selection). Never the item text, a title,
 * the owner's words or the readout.
 */
export type ItemSummaryConsentSource = 'mail' | 'mail-thread' | 'drive' | 'jira' | 'slack' | 'slack-thread';

export interface ItemSummaryConsentDescriptor {
  readonly source: ItemSummaryConsentSource;
  readonly itemId: string;
  /** A thread's message count at read time (the continuation requires the same count); absent for a single item. */
  readonly parts?: { readonly threadMessages: number };
  readonly language: 'ko' | 'en';
  /** The handler that produced the summary and the selection it re-runs (ids and closed values only). */
  readonly redo: { readonly handlerId: string; readonly selection: NlSelectedCommand };
}

/** Builds the descriptor of one `summary` read; the redo selection holds closed values only (never `full`: that path has no model call). */
export function itemSummaryConsentDescriptor(input: {
  readonly handlerId: string;
  readonly source: ItemSummaryConsentSource;
  readonly itemId: string;
  readonly language: 'ko' | 'en';
  readonly thread?: boolean;
  readonly threadMessages?: number;
  readonly label?: number;
  readonly listingAt?: string;
}): ItemSummaryConsentDescriptor {
  const itemSource = input.source === 'mail-thread' ? 'mail' : input.source === 'slack-thread' ? 'slack' : input.source;
  const selection: NlSelectedCommand = {
    entryId: 'item.summarize',
    args: { mode: 'summary', ...(input.thread === true ? { scope: 'thread' } : {}) },
    language: input.language,
    target: {
      source: itemSource,
      id: input.itemId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.listingAt !== undefined ? { listingAt: input.listingAt } : {}),
    },
  };
  return {
    source: input.source,
    itemId: input.itemId,
    ...(input.threadMessages !== undefined ? { parts: { threadMessages: input.threadMessages } } : {}),
    language: input.language,
    redo: { handlerId: input.handlerId, selection },
  };
}
