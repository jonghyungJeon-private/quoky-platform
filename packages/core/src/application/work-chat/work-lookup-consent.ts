import type { TurnHandlerOutcome, TurnHandlerSummarizeReply } from '../../ports/conversation-turn-handler.port';
import type { WorkLookupConsentDescriptor } from '../item-summary-consent-descriptor';
import { renderExternalWorkFooter, type ExternalWorkReadout } from './external-work-readout';
import { isSummarizableExternalWorkReadout } from './work-chat-turn-handler';

/**
 * ADR-0121 amendment A8.6 (OQ1-4): the pure part of the D8 continuation after the owner's yes. The lookup is re-run fresh (same
 * handler, same read) and only the refs the question named are kept (W3: a re-read item the owner was not asked about is
 * dropped). Orchestrator ruling (strict, A8.5 "a changed item sends nothing"): when ANY asked ref is missing from the re-read,
 * or the re-read is another lookup (handler, source or query), the verdict is `changed` and nothing is sent. Plain data: refs are
 * compared as opaque ids; no title, excerpt or owner text is read here.
 *
 * OQ1-4 review round 1: a re-read of the same lookup that SUCCEEDED and found no item at all (every asked ref is gone) is
 * `changed` too, never `refused`: the handler marks it with its ids-only `lookupEmpty` fact.
 */
export type WorkLookupRereadVerdict =
  | { readonly kind: 'same'; readonly summary: TurnHandlerSummarizeReply; readonly readout: ExternalWorkReadout }
  | { readonly kind: 'changed' }
  | { readonly kind: 'refused' };

export function keepAskedWorkLookupRefs(asked: WorkLookupConsentDescriptor, reread: TurnHandlerOutcome | null): WorkLookupRereadVerdict {
  try {
    if (reread !== null && (reread.kind === undefined || reread.kind === 'reply') && reread.lookupEmpty !== undefined) {
      // A successful read of a lookup with no item: every asked ref is gone (the same lookup) or it is another lookup. Both: changed.
      return { kind: 'changed' };
    }
    if (reread === null || reread.kind !== 'summarize' || !isSummarizableExternalWorkReadout(reread.readout)) return { kind: 'refused' };
    const readout = reread.readout;
    const facts = reread.lookupConsent;
    if (facts === undefined || facts.redo.handlerId !== asked.redo.handlerId || facts.source !== asked.source || facts.query !== asked.query) return { kind: 'changed' };
    if (readout.request.source !== asked.source || readout.request.query !== asked.query) return { kind: 'changed' };
    const wanted = new Set(asked.refs);
    if (wanted.size !== asked.refs.length || wanted.size === 0) return { kind: 'changed' };
    const kept = readout.items.filter((item) => wanted.has(item.ref));
    const keptRefs = new Set(kept.map((item) => item.ref));
    if (kept.length !== wanted.size || keptRefs.size !== wanted.size) return { kind: 'changed' };
    // Nothing dropped: the re-read itself, so the prompt is byte-identical to the one the D8 path makes for this read.
    if (kept.length === readout.items.length) return { kind: 'same', summary: reread, readout };
    // W3: the dropped rows were not asked about. The readout says it is partial, and the plain footer counts and links only the
    // kept items (a numbered reply renders its own index from the readout).
    const narrowed: ExternalWorkReadout = { ...readout, items: kept, truncated: true };
    const footer = reread.numbered !== undefined ? reread.footer : renderExternalWorkFooter(narrowed);
    return { kind: 'same', summary: { ...reread, readout: narrowed, footer }, readout: narrowed };
  } catch {
    return { kind: 'refused' };
  }
}
