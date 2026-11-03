import { isSummarizableDocumentReadout, UNTRUSTED_DOCUMENT_READOUT_KIND, type UntrustedDocumentReadout } from '../untrusted-document-readout';
import type { Window } from './types';

/**
 * A window is a readout (ADR-0124 section 3.2): the same shape, bounds and guards as today's. Returns `undefined` when
 * the window would not be sent (a credential-shaped window, a link, an invisible character): the caller drops it and says
 * so in the coverage line, and never redacts.
 */
export function windowReadout(
  window: Window,
  meta: Pick<UntrustedDocumentReadout, 'source' | 'title' | 'author' | 'date'>,
  truncated: boolean,
): UntrustedDocumentReadout | undefined {
  const readout: UntrustedDocumentReadout = {
    kind: UNTRUSTED_DOCUMENT_READOUT_KIND,
    source: meta.source,
    title: meta.title,
    author: meta.author,
    date: meta.date,
    body: window.text,
    truncated,
  };
  return isSummarizableDocumentReadout(readout) ? readout : undefined;
}
