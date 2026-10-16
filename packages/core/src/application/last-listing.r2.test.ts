import { describe, expect, it } from 'vitest';
import {
  findAnyListingByReply,
  LAST_LISTING_TTL_MS,
  LISTING_REPLY_TTL_MS,
  readListing,
  readListingRecord,
  withLabelledListing,
  withListing,
  withListingReplies,
} from './last-listing';

const ACTOR = 'a-1';
const T0 = '2026-10-16T01:00:00.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

describe('last-listing A6 R2 slots', () => {
  it('round-trips jira labels and KEY:numericId ids', () => {
    const items = [
      { label: 1, id: 'PROJ-12:10012' },
      { label: 3, id: 'PROJ-14:10014' },
    ];
    const value = withLabelledListing(undefined, ACTOR, 'jira', items, T0, 'listing');
    const record = readListingRecord(value, ACTOR, T0);
    expect(record.slots.jira?.items).toEqual(items);
    expect(record.mostRecent?.source).toBe('jira');
    expect(record.slots.slack).toBeUndefined();
  });

  it('round-trips slack channel:ts and channel:ts:threadTs ids', () => {
    const items = [
      { label: 1, id: 'C0123:1700000000.000100' },
      { label: 2, id: 'C0123:1700000001.000200:1700000000.000100' },
    ];
    const value = withLabelledListing(undefined, ACTOR, 'slack', items, T0, 'listing');
    expect(readListingRecord(value, ACTOR, T0).slots.slack?.items).toEqual(items);
    expect(readListing(value, ACTOR, 'slack', T0)?.labels).toEqual([1, 2]);
  });

  it('withListing without labels yields positions 1..n for jira', () => {
    const value = withListing(undefined, ACTOR, 'jira', ['A-1:1', 'A-2:2'], T0);
    expect(readListingRecord(value, ACTOR, T0).slots.jira?.items.map((i) => i.label)).toEqual([1, 2]);
  });

  it('a record with only mail/drive/todo/reminder slots has no jira/slack keys', () => {
    let value: unknown = withListing(undefined, ACTOR, 'mail', ['m1'], T0);
    value = withListing(value, ACTOR, 'drive', ['d1'], T0);
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 2, id: 't2' }], T0, 'listing');
    value = withLabelledListing(value, ACTOR, 'reminder', [{ label: 1, id: 'r1' }], T0, 'listing');
    const json = JSON.stringify(value);
    expect(json).not.toContain('jira');
    expect(json).not.toContain('slack');
    expect(Object.keys((value as { byActor: Record<string, object> }).byActor[ACTOR]!).sort()).toEqual(['drive', 'mail', 'reminder', 'todo']);
    // Byte-identical to the serialisation produced when the new slots never existed.
    const again = withListing(JSON.parse(json), ACTOR, 'mail', ['m1'], T0);
    expect(JSON.stringify(again)).toBe(JSON.stringify(JSON.parse(json)));
  });

  it('orders most recent across all six sources', () => {
    const sources = ['mail', 'drive', 'todo', 'reminder', 'jira', 'slack'] as const;
    let value: unknown;
    sources.forEach((source, index) => {
      value = withLabelledListing(value, ACTOR, source, [{ label: 1, id: `${source}-id` }], at(index * 1000), 'listing');
    });
    const now = at(10_000);
    expect(readListingRecord(value, ACTOR, now).mostRecent?.source).toBe('slack');
    // Rewrite jira later: it becomes the most recent.
    value = withLabelledListing(value, ACTOR, 'jira', [{ label: 1, id: 'J-1:1' }], at(7000), 'listing');
    const record = readListingRecord(value, ACTOR, now);
    expect(record.mostRecent?.source).toBe('jira');
    expect(Object.keys(record.slots).sort()).toEqual([...sources].sort());
    // Mail first.
    let mailLast: unknown = withListing(undefined, ACTOR, 'slack', ['C1:1.1'], at(0));
    mailLast = withListing(mailLast, ACTOR, 'mail', ['m1'], at(1000));
    expect(readListingRecord(mailLast, ACTOR, at(2000)).mostRecent?.source).toBe('mail');
  });

  it('reply-to-pick works for a jira slot', () => {
    let value = withLabelledListing(undefined, ACTOR, 'jira', [{ label: 1, id: 'PROJ-1:1' }, { label: 2, id: 'PROJ-2:2' }], T0, 'listing', 'req-1');
    const replies = withListingReplies(value, ACTOR, 'jira', 'req-1', ['msg-9'], T0);
    expect(replies.found).toBe(true);
    value = replies.next;
    const match = findAnyListingByReply(value, ACTOR, 'msg-9', at(60_000));
    expect(match?.kind).toBe('listing');
    if (match?.kind === 'listing') {
      expect(match.slot.source).toBe('jira');
      expect(match.slot.items.map((i) => i.id)).toEqual(['PROJ-1:1', 'PROJ-2:2']);
    }
    expect(findAnyListingByReply(value, ACTOR, 'unknown', at(60_000))).toBeUndefined();
    expect(withListingReplies(value, ACTOR, 'jira', 'other-req', ['x'], T0).found).toBe(false);
  });

  it('a reply to a jira listing still picks after the 30 minute window, expires after 24 h', () => {
    let value = withLabelledListing(undefined, ACTOR, 'jira', [{ label: 1, id: 'PROJ-1:1' }], T0, 'listing', 'req-1');
    value = withListingReplies(value, ACTOR, 'jira', 'req-1', ['msg-9'], T0).next;
    expect(readListingRecord(value, ACTOR, at(LAST_LISTING_TTL_MS + 1)).slots.jira).toBeUndefined();
    expect(findAnyListingByReply(value, ACTOR, 'msg-9', at(LAST_LISTING_TTL_MS + 1))?.kind).toBe('listing');
    expect(findAnyListingByReply(value, ACTOR, 'msg-9', at(LISTING_REPLY_TTL_MS + 1))).toEqual({ kind: 'expired', source: 'jira' });
  });

  it('expires a jira/slack slot after 30 minutes', () => {
    const value = withLabelledListing(undefined, ACTOR, 'slack', [{ label: 1, id: 'C1:1.1' }], T0, 'listing');
    expect(readListingRecord(value, ACTOR, at(LAST_LISTING_TTL_MS - 1)).slots.slack).toBeDefined();
    const expired = readListingRecord(value, ACTOR, at(LAST_LISTING_TTL_MS));
    expect(expired.slots.slack).toBeUndefined();
    expect(expired.mostRecent).toBeUndefined();
  });
});
