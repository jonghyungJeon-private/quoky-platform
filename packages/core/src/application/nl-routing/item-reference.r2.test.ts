import { describe, expect, it } from 'vitest';
import { findAnyListingByReply, withLabelledListing, withListing, withListingReplies, readListingRecord, type ListingItem, type ListingSource } from '../last-listing';
import { parseNlRef, type NlRef } from './action-entries';
import type { NlActionEntryId, NlItemSource } from './catalog';
import { hasReferenceRecord, renderReferenceContext, resolveItemReference, resolveUndo, type NlReferenceState } from './item-reference';
import type { LastActionView } from './last-action';
import { LAST_READ_TTL_MS, readLastRead, withLastRead, type LastReadRecord } from './last-read';

const ACTOR = 'a-1';
const T0 = '2026-10-16T01:00:00.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();
const MIN = 60_000;

const JIRA_ITEMS: ListingItem[] = [
  { label: 1, id: 'PROJ-12:10012' },
  { label: 2, id: 'PROJ-14:10014' },
  { label: 3, id: 'OPS-7:10007' },
];
const SLACK_ITEMS: ListingItem[] = [
  { label: 1, id: 'C1:1700000000.000100' },
  { label: 2, id: 'C1:1700000001.000200:1700000000.000100' },
];

/** Build a listing-state value from (source, items, offset) triples. */
function listings(...rows: Array<[ListingSource, ListingItem[], number, string?]>): unknown {
  let value: unknown;
  for (const [source, items, offset, requestId] of rows) value = withLabelledListing(value, ACTOR, source, items, at(offset), 'listing', requestId);
  return value;
}

function state(value: unknown, now: number, extra: Partial<NlReferenceState> = {}): NlReferenceState {
  return { listings: readListingRecord(value, ACTOR, at(now)), now: at(now), r2Sources: ['jira', 'slack'], ...extra };
}

function resolve(source: NlItemSource, ref: NlRef, groundingText: string, st: NlReferenceState, entryId: NlActionEntryId = 'item.summarize') {
  return resolveItemReference({ entryId, source, ref, groundingText, state: st });
}

const ref = (value: string): NlRef => parseNlRef(value, { keys: true }) as NlRef;
const lastRead = (source: 'jira' | 'slack', id: string, offset: number, extra: Partial<LastReadRecord> = {}): LastReadRecord => ({ source, id, at: at(offset), ...extra });

describe('resolveItemReference item.summarize jira and slack', () => {
  it('#n resolves by shown label with listingAt', () => {
    const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
    expect(resolve('jira', ref('#2'), '2번 요약해줘', st)).toEqual({
      kind: 'resolved',
      target: { source: 'jira', id: 'PROJ-14:10014', label: 2, listingAt: at(0) },
    });
    const slack = state(listings(['slack', SLACK_ITEMS, 0]), MIN);
    expect(resolve('slack', ref('#2'), '2번 요약해줘', slack)).toMatchObject({ kind: 'resolved', target: { source: 'slack', id: SLACK_ITEMS[1]!.id } });
  });

  it('last resolves to the last item; this resolves a single-item listing', () => {
    const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
    expect(resolve('jira', ref('last'), '마지막 거 요약해줘', st)).toMatchObject({ kind: 'resolved', target: { id: 'OPS-7:10007', label: 3 } });
    const one = state(listings(['slack', [SLACK_ITEMS[0]!], 0]), MIN);
    expect(resolve('slack', ref('this'), '그거 요약해줘', one)).toMatchObject({ kind: 'resolved', target: { source: 'slack', id: SLACK_ITEMS[0]!.id } });
  });

  it('multi-item this asks ambiguous with the shown labels', () => {
    const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
    const result = resolve('jira', ref('this'), '그거 요약해줘', st);
    expect(result).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', found: 'jira', candidates: JIRA_ITEMS });
  });

  it('out of range reports the count and the index', () => {
    const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
    expect(resolve('jira', ref('#9'), '9번 요약해줘', st)).toMatchObject({ kind: 'unresolved', outcome: 'out-of-range', count: 3, index: 9, found: 'jira' });
  });

  it('the owner naming another source asks other-source', () => {
    const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
    expect(resolve('jira', ref('#1'), '1번 메일 요약해줘', st)).toMatchObject({ outcome: 'other-source', source: 'mail', found: 'jira' });
    expect(resolve('jira', ref('#1'), '1번 슬랙 요약해줘', st)).toMatchObject({ outcome: 'other-source', source: 'slack', found: 'jira' });
    const slack = state(listings(['slack', SLACK_ITEMS, 0]), MIN);
    expect(resolve('slack', ref('#1'), '1번 이슈 요약해줘', slack)).toMatchObject({ outcome: 'other-source', source: 'jira', found: 'slack' });
  });

  it('most recent listing of another source asks other-source in every direction', () => {
    const sources: Array<[ListingSource, ListingItem[]]> = [
      ['mail', [{ label: 1, id: 'm1' }]],
      ['jira', JIRA_ITEMS],
      ['slack', SLACK_ITEMS],
    ];
    for (const [asked, , ] of sources.map((s) => [s[0], s[1]] as const)) {
      for (const [shown, items] of sources) {
        if (asked === shown || asked === 'mail') continue;
        const st = state(listings([asked, asked === 'jira' ? JIRA_ITEMS : SLACK_ITEMS, 0], [shown, items, 5000]), MIN);
        expect(resolve(asked as NlItemSource, ref('#1'), '1번 요약해줘', st)).toMatchObject({ outcome: 'other-source', found: shown });
      }
    }
    // mail entry behind a newer jira listing
    const st = state(listings(['mail', [{ label: 1, id: 'm1' }], 0], ['jira', JIRA_ITEMS, 5000]), MIN);
    expect(resolve('mail', ref('#1'), '1번 요약해줘', st)).toMatchObject({ outcome: 'other-source', found: 'jira' });
  });

  it('an expired listing resolves to none', () => {
    const value = listings(['jira', JIRA_ITEMS, 0]);
    const st = state(value, 31 * MIN);
    expect(resolve('jira', ref('#1'), '1번 요약해줘', st)).toMatchObject({ kind: 'unresolved', outcome: 'none' });
  });

  describe('reply-to-pick', () => {
    const base = withListingReplies(listings(['jira', JIRA_ITEMS, 0, 'req-1']), ACTOR, 'jira', 'req-1', ['msg-1'], at(0)).next;
    it('within 24 h picks from the replied listing even after 30 minutes', () => {
      const now = 3 * 60 * MIN;
      const match = findAnyListingByReply(base, ACTOR, 'msg-1', at(now));
      const st: NlReferenceState = { listings: readListingRecord(base, ACTOR, at(now)), now: at(now), r2Sources: ['jira', 'slack'], replyTo: { messageId: 'msg-1', ...(match !== undefined ? { listing: match } : {}) } };
      expect(resolve('jira', ref('#2'), '2번 요약해줘', st)).toMatchObject({ kind: 'resolved', target: { id: 'PROJ-14:10014' } });
    });
    it('after 24 h the reply is expired', () => {
      const now = 25 * 60 * MIN;
      const match = findAnyListingByReply(base, ACTOR, 'msg-1', at(now));
      expect(match).toEqual({ kind: 'expired', source: 'jira' });
      const st: NlReferenceState = { listings: readListingRecord(base, ACTOR, at(now)), now: at(now), r2Sources: ['jira', 'slack'], replyTo: { messageId: 'msg-1', listing: match! } };
      expect(resolve('jira', ref('#2'), '2번 요약해줘', st)).toMatchObject({ outcome: 'expired', found: 'jira' });
    });
    it('a replied listing slot aged beyond the window is expired even when passed as a listing', () => {
      const match = findAnyListingByReply(base, ACTOR, 'msg-1', at(MIN));
      const st: NlReferenceState = { listings: { slots: {} }, now: at(24 * 60 * MIN + 1), r2Sources: ['jira', 'slack'], replyTo: { messageId: 'msg-1', listing: match! } };
      expect(resolve('jira', ref('#1'), '1번 요약해줘', st)).toMatchObject({ outcome: 'expired' });
    });
    it('a reply to another source listing asks other-source', () => {
      const mailBase = withListingReplies(withListing(undefined, ACTOR, 'mail', ['m1'], T0, 'req-m'), ACTOR, 'mail', 'req-m', ['msg-m'], T0).next;
      const match = findAnyListingByReply(mailBase, ACTOR, 'msg-m', at(MIN));
      const st: NlReferenceState = { listings: readListingRecord(mailBase, ACTOR, at(MIN)), now: at(MIN), r2Sources: ['jira', 'slack'], replyTo: { messageId: 'msg-m', listing: match! } };
      expect(resolve('jira', ref('#1'), '1번 요약해줘', st)).toMatchObject({ outcome: 'other-source', found: 'mail' });
    });
  });

  describe('the D2 key ref', () => {
    it('parses a key', () => {
      expect(parseNlRef('PROJ-12', { keys: true })).toEqual({ kind: 'key', key: 'PROJ-12' });
      expect(parseNlRef('PROJ-12')).toBeUndefined();
    });
    it('resolves by id prefix against the fresh jira slot, not by prefix of a longer key', () => {
      const items = [{ label: 4, id: 'PROJ-123:1' }, ...JIRA_ITEMS];
      const st = state(listings(['jira', items, 0]), MIN);
      expect(resolve('jira', ref('PROJ-12'), 'PROJ-12 요약해줘', st)).toEqual({
        kind: 'resolved',
        target: { source: 'jira', id: 'PROJ-12:10012', label: 1, listingAt: at(0) },
      });
    });
    it('a key not in the slot asks ambiguous with the slot candidates', () => {
      const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
      expect(resolve('jira', ref('PROJ-99'), 'PROJ-99 요약해줘', st)).toMatchObject({ outcome: 'ambiguous', found: 'jira', candidates: JIRA_ITEMS });
    });
    it('no jira slot is none', () => {
      const st = state(listings(['slack', SLACK_ITEMS, 0]), MIN);
      expect(resolve('jira', ref('PROJ-12'), 'PROJ-12 요약해줘', st)).toMatchObject({ outcome: 'none' });
      expect(resolve('jira', ref('PROJ-12'), 'PROJ-12 요약해줘', state(undefined, MIN))).toMatchObject({ outcome: 'none' });
    });
    it('a key ref for a local write or another source is none', () => {
      const st = state(listings(['jira', JIRA_ITEMS, 0]), MIN);
      expect(resolve('todo', ref('PROJ-12'), 'PROJ-12 완료해줘', st, 'todo.complete')).toMatchObject({ kind: 'unresolved', outcome: 'none' });
      expect(resolve('slack', ref('PROJ-12'), 'PROJ-12 요약해줘', st)).toMatchObject({ outcome: 'none' });
    });
  });

  describe('D9 lastRead', () => {
    const jiraAt = (offset: number) => listings(['jira', JIRA_ITEMS, offset]);

    it('plain this resolves to lastRead when no newer listing exists', () => {
      const read = lastRead('jira', 'PROJ-14:10014', 5 * 1000, { label: 2, listingAt: at(0) });
      const st = state(jiraAt(0), 10_000, { lastRead: read });
      expect(resolve('jira', ref('this'), '그거 요약해줘', st)).toEqual({
        kind: 'resolved',
        target: { source: 'jira', id: 'PROJ-14:10014', label: 2, listingAt: at(0) },
      });
      expect(resolve('jira', ref('this'), '그거 요약해줘', state(undefined, 10_000, { lastRead: read }))).toMatchObject({ kind: 'resolved' });
    });

    it('a newer multi-item listing of the same source asks ambiguous', () => {
      const read = lastRead('jira', 'PROJ-12:10012', 1000, { label: 1 });
      const st = state(jiraAt(30_000), 40_000, { lastRead: read });
      expect(resolve('jira', ref('this'), '그거 요약해줘', st)).toMatchObject({ outcome: 'ambiguous', candidates: JIRA_ITEMS });
      expect(resolve('jira', ref('recent'), '방금 거 요약해줘', st)).toMatchObject({ outcome: 'ambiguous' });
    });

    it('a newer listing of another source asks other-source', () => {
      const read = lastRead('jira', 'PROJ-12:10012', 1000, { label: 1 });
      const st = state(listings(['slack', SLACK_ITEMS, 30_000]), 40_000, { lastRead: read });
      expect(resolve('jira', ref('this'), '그거 요약해줘', st)).toMatchObject({ outcome: 'other-source', found: 'slack' });
    });

    it('a tie asks for this but recent stays on lastRead', () => {
      const one = listings(['jira', [JIRA_ITEMS[0]!], 10_000]);
      const read = lastRead('jira', 'PROJ-12:10012', 10_400, { label: 1 });
      const st = state(one, 20_000, { lastRead: read });
      expect(resolve('jira', ref('this'), '그거 요약해줘', st)).toMatchObject({ outcome: 'ambiguous', candidates: [JIRA_ITEMS[0]] });
      expect(resolve('jira', ref('recent'), '방금 거 요약해줘', st)).toMatchObject({ kind: 'resolved', target: { source: 'jira', id: 'PROJ-12:10012' } });
    });

    it('Codex P2 (2026-10-27): an external-write receipt (a Jira / Slack write) is never an item candidate; lastRead stands, and the undo still sees the write', () => {
      const receipt = { record: { entryId: 'external.write', source: 'jira', itemId: '8f1c2d3e-receipt', at: at(20_000), undoable: false, undone: false, echoReplyIds: [], outcome: 'SENT' }, fresh: true } as unknown as LastActionView;
      const read = lastRead('jira', 'PROJ-14:10014', 5 * 1000, { label: 2 });
      // The newer receipt does not override the valid lastRead.
      for (const value of ['recent', 'this'] as const) {
        expect(resolve('jira', ref(value), '방금 지라 그거 요약해줘', state(undefined, 30_000, { lastRead: read, lastAction: receipt })), value).toMatchObject({ kind: 'resolved', target: { source: 'jira', id: 'PROJ-14:10014' } });
        // Without a lastRead nothing resolves to the receipt id.
        const alone = resolve('jira', ref(value), '방금 지라 그거 요약해줘', state(undefined, 30_000, { lastAction: receipt }));
        expect(JSON.stringify(alone), value).not.toContain('8f1c2d3e-receipt');
        expect(alone.kind, value).toBe('unresolved');
      }
      // The same record is still the last action for "되돌려줘" (the honest external copy, never an older item).
      expect(resolveUndo({ lastAction: receipt })).toEqual({ kind: 'unresolved', outcome: 'external', external: { source: 'jira', outcome: 'SENT' } });
    });

    it('a lastRead of jira is ignored for a slack entry', () => {
      const read = lastRead('jira', 'PROJ-12:10012', 1000);
      expect(resolve('slack', ref('this'), '그거 요약해줘', state(undefined, 5000, { lastRead: read }))).toMatchObject({ kind: 'unresolved', outcome: 'none' });
    });

    it('is never used by a local write', () => {
      const read = lastRead('jira', 'PROJ-12:10012', 1000);
      const result = resolve('todo', ref('this'), '그거 완료해줘', state(undefined, 5000, { lastRead: read }), 'todo.complete');
      expect(result.kind).toBe('unresolved');
      const slackRead = lastRead('slack', 'C1:1.1', 1000);
      expect(resolve('todo', ref('this'), '그거 완료해줘', state(undefined, 5000, { lastRead: slackRead }), 'todo.cancel').kind).toBe('unresolved');
    });
  });

  describe('structural views', () => {
    it('renderReferenceContext names the kind and age of the last read and never an id', () => {
      const read = lastRead('jira', 'PROJ-12:10012', 0, { label: 1 });
      const text = renderReferenceContext(state(undefined, 4 * MIN, { lastRead: read }));
      expect(text).toBe('last read: jira (4 min ago)');
      expect(text).not.toContain('PROJ');
      const withListing = renderReferenceContext(state(listings(['slack', SLACK_ITEMS, 0]), 4 * MIN, { lastRead: read }));
      expect(withListing).toContain('last listing: slack (2 items, 4 min ago)');
      expect(withListing).toContain('last read: jira (4 min ago)');
      expect(withListing).not.toContain('C1:');
    });
    it('hasReferenceRecord is true with only a lastRead', () => {
      expect(hasReferenceRecord(state(undefined, 1000))).toBe(false);
      expect(hasReferenceRecord(state(undefined, 1000, { lastRead: lastRead('slack', 'C1:1.1', 0) }))).toBe(true);
    });
  });
});

describe('last-read persistence', () => {
  const record = (offset: number): LastReadRecord => ({ source: 'jira', id: 'PROJ-12:10012', label: 1, listingAt: at(0), at: at(offset) });

  it('round-trips and expires after 10 minutes', () => {
    const value = withLastRead(undefined, ACTOR, record(0), at(0));
    expect(readLastRead(value, ACTOR, at(LAST_READ_TTL_MS - 1))).toEqual(record(0));
    expect(readLastRead(value, ACTOR, at(LAST_READ_TTL_MS))).toBeUndefined();
    expect(readLastRead(value, 'other', at(1000))).toBeUndefined();
    expect(readLastRead(value, ACTOR, at(-1000))).toBeUndefined();
  });

  it('ignores malformed records', () => {
    const bad = (raw: unknown) => readLastRead({ byActor: { [ACTOR]: raw } }, ACTOR, at(1000));
    expect(bad(undefined)).toBeUndefined();
    expect(bad('x')).toBeUndefined();
    expect(bad({ source: 'mail', id: 'x', at: at(0) })).toBeUndefined();
    expect(bad({ source: 'jira', id: '', at: at(0) })).toBeUndefined();
    expect(bad({ source: 'jira', id: 'x'.repeat(513), at: at(0) })).toBeUndefined();
    expect(bad({ source: 'jira', id: 'K-1:1', at: 'nope' })).toBeUndefined();
    expect(bad({ source: 'jira', id: 'K-1:1', at: at(0), label: 0, listingAt: 'bad' })).toEqual({ source: 'jira', id: 'K-1:1', at: at(0) });
    expect(readLastRead(null, ACTOR, at(0))).toBeUndefined();
  });

  it('keeps other fresh actors, drops stale or malformed ones', () => {
    const value = {
      byActor: {
        'other-fresh': { source: 'slack', id: 'C1:1.1', at: at(5 * MIN) },
        'other-stale': { source: 'slack', id: 'C1:1.1', at: at(0) },
      },
    };
    const next = withLastRead(value, ACTOR, record(11 * MIN), at(11 * MIN)) as { byActor: Record<string, unknown> };
    expect(Object.keys(next.byActor).sort()).toEqual(['a-1', 'other-fresh']);
    const after = withLastRead({ byActor: { junk: 'x', other: { source: 'jira', id: 'K-1:1', at: at(9 * MIN) } } }, ACTOR, record(9 * MIN), at(9 * MIN)) as { byActor: Record<string, unknown> };
    expect(Object.keys(after.byActor).sort()).toEqual(['a-1', 'other']);
  });
});
