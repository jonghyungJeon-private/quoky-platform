import type { NlSelectedCommand } from './nl-routing/catalog';
import type { WorkChatLookupQuery, WorkChatSource } from './work-chat/work-chat-command';

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

/**
 * ADR-0121 amendment A8.6 (OQ1-4, = A5-S6): the ids-only descriptor of ONE ADR-0100 D8 work lookup whose summary would go to a
 * `REMOTE` recipient. The lookup handler attaches it to its `summarize` outcome; the runtime reads it only with
 * `QUOKY_ITEM_SUMMARY_CONSENT=on`. Plain data: the closed lookup source and query, the refs (`source:externalId`) of exactly the
 * readout items the summary prompt would carry (1..10, distinct, in readout order), the language and the redo of the same read.
 * Never a title, an excerpt or the readout.
 *
 * `redo.selection` is the handler's own validated selection when the lookup came through natural-language selection (its closed
 * entry id and validated args; a keyword arg is the owner's words, held in memory with the record exactly like the request text,
 * never logged or rendered). Absent: the lookup came through the deterministic grammar and is re-run from the stored request text
 * (`grammarYield` restores the turn's grammar-yield fact).
 */
export interface WorkLookupConsentDescriptor {
  readonly kind: 'work-lookup';
  readonly source: WorkChatSource;
  readonly query: WorkChatLookupQuery;
  readonly refs: readonly string[];
  readonly language: 'ko' | 'en';
  readonly redo: { readonly handlerId: string; readonly selection?: NlSelectedCommand; readonly grammarYield?: true };
}

/** The most refs one D8 question may name (the readout bound and the pending step's per-source bound). */
export const WORK_LOOKUP_CONSENT_MAX_REFS = 10;

/** Whether `refs` is a list the D8 question may name: 1..10 distinct, non-empty strings. Total. */
export function isWorkLookupConsentRefs(refs: unknown): refs is readonly string[] {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > WORK_LOOKUP_CONSENT_MAX_REFS) return false;
  if (!refs.every((ref) => typeof ref === 'string' && ref.trim().length > 0)) return false;
  return new Set(refs).size === refs.length;
}

/**
 * Builds the D8 descriptor from the readout's own refs. `undefined` when the refs are not a nameable set (none, more than 10, a
 * duplicate or an empty ref): no descriptor, so nothing can be asked (the runtime shows the listing and the fixed not-sent line).
 */
export function workLookupConsentDescriptor(input: {
  readonly handlerId: string;
  readonly source: WorkChatSource;
  readonly query: WorkChatLookupQuery;
  readonly refs: readonly string[];
  readonly language: 'ko' | 'en';
  readonly selection?: NlSelectedCommand;
  readonly grammarYield?: boolean;
}): WorkLookupConsentDescriptor | undefined {
  if (!isWorkLookupConsentRefs(input.refs)) return undefined;
  return {
    kind: 'work-lookup',
    source: input.source,
    query: input.query,
    refs: Object.freeze([...input.refs]),
    language: input.language,
    redo: {
      handlerId: input.handlerId,
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
      ...(input.selection === undefined && input.grammarYield === true ? { grammarYield: true as const } : {}),
    },
  };
}

/**
 * OQ1-4: the item key a D8 consent token is bound to: the canonical text of the asked ref SET (distinct refs, sorted), so the
 * token admits exactly that set and no other (an exact, collision-free key; no hashing). Order-independent by design.
 */
export function workLookupRefsKey(refs: readonly string[]): string {
  return JSON.stringify([...new Set(refs)].sort());
}
