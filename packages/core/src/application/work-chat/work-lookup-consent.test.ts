import { describe, expect, it } from 'vitest';
import type { TurnHandlerOutcome } from '../../ports';
import { workLookupConsentDescriptor, type WorkLookupConsentDescriptor } from '../item-summary-consent-descriptor';
import { buildExternalWorkReadout, renderExternalWorkFooter } from './external-work-readout';
import { keepAskedWorkLookupRefs } from './work-lookup-consent';

// ADR-0121 A8.6 (OQ1-4): the D8 re-run keeps only the asked refs (W3); a missing asked ref or another lookup is `changed`.

const ASKED = workLookupConsentDescriptor({ handlerId: 'work-chat.lookup', source: 'jira', query: 'my-items', refs: ['jira:A-1', 'jira:A-2'], language: 'ko' }) as WorkLookupConsentDescriptor;

function reread(ids: readonly string[], over: Partial<WorkLookupConsentDescriptor> = {}): TurnHandlerOutcome {
  const readout = buildExternalWorkReadout({ source: 'jira', query: 'my-items', items: ids.map((id) => ({ id, title: `일 ${id}`, url: `https://example.atlassian.net/browse/${id}` })) });
  const lookupConsent = workLookupConsentDescriptor({ handlerId: 'work-chat.lookup', source: 'jira', query: 'my-items', refs: readout.items.map((item) => item.ref), language: 'ko' });
  return { kind: 'summarize', readout, fallbackText: 'LIST', footer: renderExternalWorkFooter(readout), ...(lookupConsent !== undefined ? { lookupConsent: { ...lookupConsent, ...over } } : {}) };
}

describe('keepAskedWorkLookupRefs (OQ1-4)', () => {
  it('the same set: the re-read itself (byte-identical readout and footer)', () => {
    const outcome = reread(['A-1', 'A-2']);
    const kept = keepAskedWorkLookupRefs(ASKED, outcome);
    expect(kept.kind === 'same' ? kept.summary : undefined).toBe(outcome);
  });

  it('W3: an extra row is dropped; the readout is marked partial and the footer counts and links only the kept rows', () => {
    const kept = keepAskedWorkLookupRefs(ASKED, reread(['A-0', 'A-2', 'A-1']));
    expect(kept.kind).toBe('same');
    if (kept.kind !== 'same') return;
    expect(kept.readout.items.map((item) => item.ref)).toEqual(['jira:A-2', 'jira:A-1']);
    expect(kept.readout.truncated).toBe(true);
    expect(JSON.stringify(kept.summary.footer)).not.toContain('browse/A-0');
  });

  it('a missing asked ref, another handler, source or query: changed', () => {
    expect(keepAskedWorkLookupRefs(ASKED, reread(['A-1'])).kind).toBe('changed');
    expect(keepAskedWorkLookupRefs(ASKED, reread(['A-1', 'A-3'])).kind).toBe('changed');
    expect(keepAskedWorkLookupRefs(ASKED, reread(['A-1', 'A-2'], { redo: { handlerId: 'other' } })).kind).toBe('changed');
    expect(keepAskedWorkLookupRefs(ASKED, reread(['A-1', 'A-2'], { query: 'search' })).kind).toBe('changed');
    const { lookupConsent: _dropped, ...noDescriptor } = reread(['A-1', 'A-2']) as Extract<TurnHandlerOutcome, { kind: 'summarize' }>;
    expect(keepAskedWorkLookupRefs(ASKED, noDescriptor).kind).toBe('changed');
  });

  it('no summarize outcome (summaries off, a lookup failure) or a document readout: refused', () => {
    expect(keepAskedWorkLookupRefs(ASKED, null).kind).toBe('refused');
    expect(keepAskedWorkLookupRefs(ASKED, { reply: { context: { platform: 't', channelId: 'c' }, text: 'LIST' } }).kind).toBe('refused');
  });

  it('review round 1: every asked ref gone (a successful empty lookup, marked lookupEmpty): changed, never refused', () => {
    const empty: TurnHandlerOutcome = { reply: { context: { platform: 't', channelId: 'c' }, text: 'NONE' }, lookupEmpty: { handlerId: 'work-chat.lookup', source: 'jira', query: 'my-items' } };
    expect(keepAskedWorkLookupRefs(ASKED, empty).kind).toBe('changed');
    expect(keepAskedWorkLookupRefs(ASKED, { ...empty, kind: 'reply' }).kind).toBe('changed');
  });
});
