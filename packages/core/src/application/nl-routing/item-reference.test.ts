import { describe, expect, it } from 'vitest';
import {
  LAST_LISTING_METADATA_KEY,
  findAnyListingByReply,
  readListingRecord,
  withLabelledListing,
  withListing,
  withListingReplies,
  type ListingItem,
  type ListingSource,
} from '../last-listing';
import { isNlRefGrounded, parseNlRef } from './action-entries';
import type { NlActionEntryId, NlItemSource } from './catalog';
import { hasReferenceRecord, renderReferenceContext, resolveItemReference, resolveUndo, type NlReferenceState } from './item-reference';
import {
  LAST_ACTION_METADATA_KEY,
  LAST_ACTION_TTL_MS,
  readLastAction,
  readSessionLastAction,
  withLastAction,
  withLastActionEcho,
  type LastActionRecord,
} from './last-action';
import { newestReference } from './reference-recency';
import { resolveLabelChoice } from './nl-action-policy';

// ADR-0120 amendment A6-D2 (NLA-2): labelled listings, the most recent slot, `quoky.lastAction` and the pure reference
// resolution. Every A6-D2 branch as a table, plus a property test over random states.

const ACTOR = 'actor-1';
const T0 = '2026-10-14T03:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const items = (source: string, labels: readonly number[]): ListingItem[] => labels.map((label) => ({ label, id: `${source}-${label}` }));

function listings(spec: ReadonlyArray<{ source: ListingSource; labels: readonly number[]; minute: number }>): unknown {
  let value: unknown;
  for (const slot of [...spec].sort((a, b) => a.minute - b.minute)) {
    value =
      slot.source === 'mail' || slot.source === 'drive'
        ? withListing(value, ACTOR, slot.source, slot.labels.map((label) => `${slot.source}-${label}`), at(slot.minute))
        : withLabelledListing(value, ACTOR, slot.source, items(slot.source, slot.labels), at(slot.minute), 'listing');
  }
  return value;
}

function action(entryId: NlActionEntryId, source: 'todo' | 'reminder', itemId: string, minute: number, extra: Partial<LastActionRecord> = {}): unknown {
  const record: LastActionRecord = { entryId, source, itemId, at: at(minute), undoable: true, undone: false, echoReplyIds: [], ...extra };
  return withLastAction(undefined, ACTOR, record, at(minute));
}

function state(listingValue: unknown, now: number, extra: { lastAction?: unknown; replyTo?: string } = {}): NlReferenceState {
  const lastAction = readLastAction(extra.lastAction, ACTOR, at(now));
  const listing = extra.replyTo === undefined ? undefined : findAnyListingByReply(listingValue, ACTOR, extra.replyTo, at(now));
  return {
    listings: readListingRecord(listingValue, ACTOR, at(now)),
    ...(lastAction !== undefined ? { lastAction } : {}),
    ...(extra.replyTo !== undefined ? { replyTo: { messageId: extra.replyTo, ...(listing !== undefined ? { listing } : {}) } } : {}),
    now: at(now),
  };
}

const resolve = (entryId: NlActionEntryId, source: NlItemSource, ref: string, text: string, s: NlReferenceState) =>
  resolveItemReference({ entryId, source, ref: parseNlRef(ref) ?? (() => { throw new Error(ref); })(), groundingText: text, state: s });

describe('labelled listings (A6-D2)', () => {
  it('stores (label → id) pairs and the most recent slot is the latest written', () => {
    const value = listings([{ source: 'mail', labels: [1, 2, 3], minute: 0 }, { source: 'drive', labels: [1, 2], minute: 2 }]);
    const record = readListingRecord(value, ACTOR, at(3));
    expect(record.mostRecent?.source).toBe('drive');
    expect(record.slots.mail?.items).toEqual(items('mail', [1, 2, 3]));
  });

  it('an echo merges into a fresh listing of the same source and never shrinks it; a same label for a new item wins', () => {
    let value = listings([{ source: 'todo', labels: [1, 2, 3], minute: 0 }]);
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 1, id: 'todo-1' }], at(1), 'merge');
    expect(readListingRecord(value, ACTOR, at(2)).slots.todo?.items).toEqual(items('todo', [1, 2, 3]));
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 3, id: 'todo-new' }, { label: 4, id: 'todo-x' }], at(2), 'merge');
    expect(readListingRecord(value, ACTOR, at(3)).slots.todo?.items).toEqual([...items('todo', [1, 2]), { label: 3, id: 'todo-new' }, { label: 4, id: 'todo-x' }]);
  });

  it('an echo becomes the listing only when no listing of that source is fresh', () => {
    const value = withLabelledListing(listings([{ source: 'todo', labels: [1, 2, 3], minute: 0 }]), ACTOR, 'todo', [{ label: 7, id: 'todo-7' }], at(40), 'merge');
    expect(readListingRecord(value, ACTOR, at(41)).slots.todo?.items).toEqual([{ label: 7, id: 'todo-7' }]);
  });

  it('with no A6 write, a mail/drive record keeps exactly its pre-A6 shape (no labels key)', () => {
    const value = listings([{ source: 'mail', labels: [1, 2], minute: 0 }]) as { byActor: Record<string, { mail: Record<string, unknown> }> };
    expect(Object.keys(value.byActor[ACTOR]?.mail ?? {}).sort()).toEqual(['at', 'ids', 'source']);
  });

  it('reply-to-pick across every slot names its listing', () => {
    let value = withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2]), at(0), 'listing', 'req-1');
    value = withListingReplies(value, ACTOR, 'todo', 'req-1', ['reply-a'], at(0)).next;
    expect(findAnyListingByReply(value, ACTOR, 'reply-a', at(10))).toMatchObject({ kind: 'listing', slot: { source: 'todo' } });
    expect(findAnyListingByReply(value, ACTOR, 'reply-b', at(10))).toBeUndefined();
  });
});

describe('resolution table (every A6-D2 branch)', () => {
  const todoList = listings([{ source: 'todo', labels: [1, 2, 3], minute: 0 }]);

  it('#n against the most recent listing by shown label', () => {
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(todoList, 1))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-2', label: 2 } });
  });

  it('"내 할 일" → "1번 완료" → "2번도 완료" completes the listed to-do 2 (never "목록에 1건만")', () => {
    let value = todoList;
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 1, id: 'todo-1' }], at(1), 'merge');
    expect(resolve('todo.complete', 'todo', '#2', '2번도 완료', state(value, 2))).toMatchObject({ kind: 'resolved', target: { id: 'todo-2', label: 2 } });
  });

  it('out of range: nothing runs and the count is reported', () => {
    expect(resolve('todo.complete', 'todo', '#7', '7번 완료', state(todoList, 1))).toMatchObject({ kind: 'unresolved', outcome: 'out-of-range', count: 3, index: 7 });
  });

  it('missing or expired listing: none (an offer to show the list)', () => {
    expect(resolve('todo.complete', 'todo', '#1', '1번 완료', state(undefined, 1))).toMatchObject({ kind: 'unresolved', outcome: 'none' });
    expect(resolve('todo.complete', 'todo', '#1', '1번 완료', state(todoList, 31))).toMatchObject({ kind: 'unresolved', outcome: 'none' });
  });

  it('an older mail listing behind a newer Drive listing asks and reads nothing', () => {
    const value = listings([{ source: 'mail', labels: [1, 2], minute: 0 }, { source: 'drive', labels: [1, 2], minute: 1 }]);
    expect(resolve('item.summarize', 'mail', '#1', '1번 메일 무슨 내용이야', state(value, 2))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'drive' });
    expect(resolve('item.summarize', 'drive', '#1', '1번 요약해줘', state(value, 2))).toMatchObject({ kind: 'resolved', target: { source: 'drive', id: 'drive-1', label: 1, listingAt: at(1) } });
  });

  it('"13번 취소해줘" after a mail list asks; never a reminder cancel', () => {
    const value = listings([{ source: 'reminder', labels: [13, 14], minute: 0 }, { source: 'mail', labels: [1, 2, 3], minute: 1 }]);
    expect(resolve('reminder.cancel', 'reminder', '#13', '13번 취소해줘', state(value, 2))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'mail' });
  });

  it('reminder digits mean the display number with a reminder noun, a fresh reminder listing or a reminder lastAction', () => {
    const mailFirst = listings([{ source: 'mail', labels: [1, 2], minute: 1 }]);
    expect(resolve('reminder.cancel', 'reminder', '#13', '알림 13 취소해줘', state(mailFirst, 2))).toEqual({ kind: 'resolved', target: { source: 'reminder', label: 13 } });
    const reminders = listings([{ source: 'reminder', labels: [11, 13], minute: 0 }]);
    expect(resolve('reminder.cancel', 'reminder', '#13', '13번 취소해줘', state(reminders, 1))).toEqual({ kind: 'resolved', target: { source: 'reminder', id: 'reminder-13', label: 13 } });
    const last = action('reminder.create', 'reminder', 'rem-uuid', 0, { label: 13 });
    expect(resolve('reminder.cancel', 'reminder', '#13', '13번 취소해줘', state(undefined, 1, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'reminder', label: 13 } });
  });

  it('reminder ordinal words mean the position in the reminder listing', () => {
    const reminders = listings([{ source: 'reminder', labels: [11, 13], minute: 0 }]);
    expect(resolve('reminder.cancel', 'reminder', '#1', '첫 번째 거 취소해줘', state(reminders, 1))).toMatchObject({ kind: 'resolved', target: { id: 'reminder-11', label: 11 } });
  });

  it('recent/this: the fresh lastAction of the source, else a single-item listing, else ask', () => {
    const last = action('reminder.create', 'reminder', 'rem-uuid', 0, { label: 13 });
    expect(resolve('reminder.cancel', 'reminder', 'recent', '방금 거 취소해줘', state(undefined, 1, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'reminder', id: 'rem-uuid', label: 13 } });
    const single = listings([{ source: 'todo', labels: [4], minute: 0 }]);
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료 처리해줘', state(single, 1))).toMatchObject({ kind: 'resolved', target: { id: 'todo-4' } });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료 처리해줘', state(todoList, 1))).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', candidates: items('todo', [1, 2, 3]) });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료 처리해줘', state(undefined, 1))).toMatchObject({ kind: 'unresolved', outcome: 'none' });
    const old = action('todo.add', 'todo', 'todo-x', 0, { label: 5 });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료 처리해줘', state(undefined, 11, { lastAction: old }))).toMatchObject({ kind: 'unresolved', outcome: 'stale' });
  });

  it('conflict: a fresh lastAction item that differs from a fresh single-item listing asks', () => {
    const single = listings([{ source: 'todo', labels: [4], minute: 0 }]);
    const last = action('todo.add', 'todo', 'todo-other', 0, { label: 5 });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(single, 1, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'conflict' });
  });

  it('last: the last shown item of the most recent listing', () => {
    expect(resolve('todo.complete', 'todo', 'last', '마지막 거 완료', state(todoList, 1))).toMatchObject({ kind: 'resolved', target: { id: 'todo-3', label: 3 } });
  });

  it('reply-to-pick: 30 minutes for a LOCAL_WRITE, 24 hours for item.summarize, another source asks', () => {
    let value = withListing(undefined, ACTOR, 'mail', ['mail-1', 'mail-2'], at(0), 'req-m');
    value = withListingReplies(value, ACTOR, 'mail', 'req-m', ['reply-m'], at(0)).next;
    let todo = withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2]), at(0), 'listing', 'req-t');
    todo = withListingReplies(todo, ACTOR, 'todo', 'req-t', ['reply-t'], at(0)).next;
    expect(resolve('item.summarize', 'mail', '#2', '2번 요약해줘', state(value, 120, { replyTo: 'reply-m' }))).toMatchObject({ kind: 'resolved', target: { id: 'mail-2' } });
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(todo, 29, { replyTo: 'reply-t' }))).toMatchObject({ kind: 'resolved', target: { id: 'todo-2' } });
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(todo, 31, { replyTo: 'reply-t' }))).toMatchObject({ kind: 'unresolved', outcome: 'expired' });
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(value, 5, { replyTo: 'reply-m' }))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'mail' });
  });
});

describe('A6-D2 clarification (owner 2026-10-15): "이 / 그 / 저 + noun" resolves like 그거 / 이거', () => {
  // The determiner only grounds the ref (`hasNlDeterminerReference`); the item is the ordinary A6-D2 step 3.
  const rows: ReadonlyArray<{ text: string; source: NlItemSource; slots: Array<{ source: ListingSource; labels: number[]; minute: number }>; expected: object }> = [
    { text: '이 문서 요약해줘', source: 'drive', slots: [{ source: 'drive', labels: [1], minute: 0 }], expected: { kind: 'resolved', target: { source: 'drive', id: 'drive-1', label: 1 } } },
    { text: '이 문서 요약해줘', source: 'drive', slots: [{ source: 'drive', labels: [1, 2, 3], minute: 0 }], expected: { kind: 'unresolved', outcome: 'ambiguous', candidates: items('drive', [1, 2, 3]) } },
    { text: '이 메일 요약해줘', source: 'mail', slots: [{ source: 'mail', labels: [1], minute: 0 }, { source: 'drive', labels: [1], minute: 1 }], expected: { kind: 'unresolved', outcome: 'other-source', found: 'drive' } },
    { text: '그 메일 무슨 내용이야', source: 'mail', slots: [{ source: 'mail', labels: [1], minute: 0 }], expected: { kind: 'resolved', target: { source: 'mail', id: 'mail-1', label: 1 } } },
    { text: 'summarize this document', source: 'drive', slots: [{ source: 'drive', labels: [1], minute: 0 }], expected: { kind: 'resolved', target: { source: 'drive', id: 'drive-1', label: 1 } } },
    { text: 'what does that mail say', source: 'mail', slots: [{ source: 'mail', labels: [1, 2], minute: 0 }], expected: { kind: 'unresolved', outcome: 'ambiguous' } },
    { text: '이 알림 취소해줘', source: 'reminder', slots: [{ source: 'reminder', labels: [13], minute: 0 }], expected: { kind: 'resolved', target: { source: 'reminder', id: 'reminder-13', label: 13 } } },
    { text: '그 할 일 완료해줘', source: 'todo', slots: [{ source: 'todo', labels: [1, 2, 3], minute: 0 }], expected: { kind: 'unresolved', outcome: 'ambiguous', candidates: items('todo', [1, 2, 3]) } },
  ];
  it.each(rows)('$text ($source; most recent listing $slots.length slot(s))', ({ text, source, slots, expected }) => {
    const entryId: NlActionEntryId = source === 'reminder' ? 'reminder.cancel' : source === 'todo' ? 'todo.complete' : 'item.summarize';
    expect(isNlRefGrounded({ kind: 'this' }, text, { entryId, source })).toBe(true);
    expect(resolve(entryId, source, 'this', text, state(listings(slots), 2))).toMatchObject(expected);
  });

  it('never a reference: 저 + noun for a write, a noun that is not whole, a noun of another source (nothing to resolve)', () => {
    // A ref that is not grounded never reaches resolution: the validator refuses it as `ungrounded` (no write, no read).
    expect(isNlRefGrounded({ kind: 'this' }, '저 할 일 다 했어요', { entryId: 'todo.complete', source: 'todo' })).toBe(false);
    expect(isNlRefGrounded({ kind: 'this' }, '이 파일럿 요약해줘', { entryId: 'item.summarize', source: 'drive' })).toBe(false);
    // A word-joining character is no noun end (Codex review): "알림_봇", "알림-봇", "알림2", "알림·봇" are other words.
    for (const text of ['이 알림_봇 취소해줘', '이 알림-봇 취소해줘', '이 알림2 취소해줘', '이 알림·봇 취소해줘', '그 메일_요약해줘']) {
      expect(isNlRefGrounded({ kind: 'this' }, text, { entryId: 'reminder.cancel', source: 'reminder' }), text).toBe(false);
      expect(isNlRefGrounded({ kind: 'this' }, text, { entryId: 'item.summarize', source: 'mail' }), text).toBe(false);
    }
    // Sentence punctuation and particles do end it.
    for (const text of ['이 알림, 취소해줘', '이 알림을 취소해줘', '이 알림!', '이 알림']) expect(isNlRefGrounded({ kind: 'this' }, text, { entryId: 'reminder.cancel', source: 'reminder' }), text).toBe(true);
    expect(isNlRefGrounded({ kind: 'this' }, '그 알림 취소해줘', { entryId: 'todo.cancel', source: 'todo' })).toBe(false);
    // The same words with the matching entry do ground, and then resolve by the ordinary rules (another source asks).
    const todos = listings([{ source: 'todo', labels: [4], minute: 0 }]);
    expect(isNlRefGrounded({ kind: 'this' }, '그 알림 취소해줘', { entryId: 'reminder.cancel', source: 'reminder' })).toBe(true);
    expect(resolve('reminder.cancel', 'reminder', 'this', '그 알림 취소해줘', state(todos, 1))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'todo' });
  });

  it('A6 reference priority (owner 2026-10-16): a newer multi-item listing makes 그거 and 이/그 + noun ask alike', () => {
    const last = action('todo.add', 'todo', 'todo-a', 0, { label: 1 });
    const newer = listings([{ source: 'todo', labels: [1, 2], minute: 1 }]);
    for (const text of ['그거 완료해줘', '그 할 일 완료해줘']) {
      expect(resolve('todo.complete', 'todo', 'this', text, state(newer, 2, { lastAction: last })), text).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', candidates: items('todo', [1, 2]) });
    }
  });

  it('a fresh lastAction of the source wins over the listing, exactly as for 그거', () => {
    const last = action('todo.add', 'todo', 'todo-new', 0, { label: 7 });
    expect(resolve('todo.complete', 'todo', 'this', '그 할 일 완료해줘', state(undefined, 1, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-new', label: 7 } });
  });
});

describe('a reply resolves against exactly what its message showed (Codex review P1)', () => {
  it('list [1:A, 2:B] → complete A → add C (echo 2:C) → a reply to the ORIGINAL list with "2번 완료" means B, never C', () => {
    let value = withLabelledListing(undefined, ACTOR, 'todo', [{ label: 1, id: 'A' }, { label: 2, id: 'B' }], at(0), 'listing', 'req-list');
    value = withListingReplies(value, ACTOR, 'todo', 'req-list', ['list-message'], at(0)).next;
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 1, id: 'A' }], at(1), 'merge', 'req-done');
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 2, id: 'C' }], at(2), 'merge', 'req-add');
    // Without a reply, label 2 is the newest echo (C); a reply to the original list message is pinned to B.
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(value, 3))).toMatchObject({ kind: 'resolved', target: { id: 'C' } });
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(value, 3, { replyTo: 'list-message' }))).toMatchObject({ kind: 'resolved', target: { id: 'B', label: 2 } });
  });
});

describe('property: random states never resolve to another source, a stale item or an older listing', () => {
  it('holds over 2000 random states', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const sources: ListingSource[] = ['todo', 'reminder', 'mail', 'drive'];
    const entries: Array<[NlActionEntryId, NlItemSource]> = [['todo.complete', 'todo'], ['todo.cancel', 'todo'], ['reminder.cancel', 'reminder'], ['item.summarize', 'mail'], ['item.summarize', 'drive']];
    for (let i = 0; i < 2000; i += 1) {
      const slots = sources.filter(() => rand(2) === 0).map((source) => ({ source, labels: Array.from({ length: 1 + rand(4) }, (_, k) => k + 1 + (source === 'reminder' ? 10 : 0)), minute: rand(60) }));
      const value = listings(slots);
      const now = 60;
      const s = state(value, now);
      const [entryId, source] = entries[rand(entries.length)] as [NlActionEntryId, NlItemSource];
      const refs = ['#1', '#2', '#12', 'last', 'this', 'recent'];
      const ref = refs[rand(refs.length)] as string;
      const text = ref.startsWith('#') ? `${ref.slice(1)}번 처리` : ref === 'last' ? '마지막 거' : '그거';
      const result = resolve(entryId, source, ref, text, s);
      if (result.kind !== 'resolved') continue;
      expect(result.target.source).toBe(source);
      if (result.target.id === undefined) continue;
      const fresh = s.listings.mostRecent;
      // Only the most recent fresh listing (or, for a reminder display number, the reminder slot) supplies ids.
      expect(fresh).toBeDefined();
      const slot = source === 'reminder' && ref.startsWith('#') ? s.listings.slots.reminder : fresh;
      expect(slot?.source).toBe(source);
      expect(slot?.items.some((item) => item.id === result.target.id)).toBe(true);
      expect(Date.parse(now === 60 ? at(60) : '') - Date.parse(slot?.at ?? '')).toBeLessThan(30 * 60_000);
    }
  });
});

describe('lastAction and undo resolution (ratification record A)', () => {
  it('is fresh for 10 minutes, kept for 30, and binds the echo ids of its own turn only', () => {
    let value = action('todo.add', 'todo', 'todo-9', 0, { requestId: 'req-1' });
    expect(readLastAction(value, ACTOR, at(9))?.fresh).toBe(true);
    expect(readLastAction(value, ACTOR, at(11))?.fresh).toBe(false);
    expect(readLastAction(value, ACTOR, at(31))).toBeUndefined();
    expect(withLastActionEcho(value, ACTOR, 'req-other', ['e1'], at(1)).found).toBe(false);
    value = withLastActionEcho(value, ACTOR, 'req-1', ['e1'], at(1)).next;
    expect(readLastAction(value, ACTOR, at(2))?.record.echoReplyIds).toEqual(['e1']);
    expect(LAST_ACTION_TTL_MS).toBe(600_000);
  });

  it('undo: the fresh last action; never an undo of an undo; a reply to another message asks', () => {
    const last = readLastAction(action('reminder.cancel', 'reminder', 'rem-1', 0, { label: 13, echoReplyIds: ['echo-1'] }), ACTOR, at(1));
    expect(resolveUndo({ ...(last !== undefined ? { lastAction: last } : {}) })).toEqual({ kind: 'resolved', target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel' } });
    expect(resolveUndo({})).toEqual({ kind: 'unresolved', outcome: 'no-action' });
    const undone = readLastAction(action('action.undo', 'todo', 'todo-1', 0, { undoable: false, undoOf: 'todo.complete' }), ACTOR, at(1));
    expect(resolveUndo({ ...(undone !== undefined ? { lastAction: undone } : {}) })).toEqual({ kind: 'unresolved', outcome: 'undo-of-undo' });
    expect(resolveUndo({ ...(last !== undefined ? { lastAction: last } : {}), replyTo: { messageId: 'older-echo' } })).toEqual({ kind: 'unresolved', outcome: 'echo-mismatch' });
    const lateReply = readLastAction(action('reminder.cancel', 'reminder', 'rem-1', 0, { echoReplyIds: ['echo-1'] }), ACTOR, at(20));
    expect(resolveUndo({ ...(lateReply !== undefined ? { lastAction: lateReply } : {}), replyTo: { messageId: 'echo-1' } })).toMatchObject({ kind: 'resolved' });
    expect(resolveUndo({ ...(lateReply !== undefined ? { lastAction: lateReply } : {}) })).toEqual({ kind: 'unresolved', outcome: 'stale' });
  });
});

describe('the Reference context line is structure only', () => {
  it('names kinds, counts and ages, never ids or labels', () => {
    const value = listings([{ source: 'mail', labels: [1, 2], minute: 0 }, { source: 'todo', labels: [1, 2, 3], minute: 2 }]);
    const s = state(value, 3, { lastAction: action('todo.add', 'todo', 'todo-secret-id', 1, { label: 3 }) });
    const line = renderReferenceContext(s);
    expect(line).toBe('last listing: todo (3 items, 1 min ago); older listings: mail (2 items, 3 min ago); last action: todo.add (2 min ago, undoable)');
    expect(line).not.toContain('todo-secret-id');
    expect(hasReferenceRecord(s)).toBe(true);
    expect(renderReferenceContext(state(undefined, 0))).toBe('none');
    expect(hasReferenceRecord(state(undefined, 0))).toBe(false);
  });
});

describe('a target question is answered by the SHOWN label (A6-D2)', () => {
  it('numbers are labels, ordinals are positions, anything else is a new request', () => {
    expect(resolveLabelChoice('3', [2, 3, 7])).toEqual({ kind: 'pick', index: 1 });
    expect(resolveLabelChoice('7번', [2, 3, 7])).toEqual({ kind: 'pick', index: 2 });
    expect(resolveLabelChoice('#13', [11, 13])).toEqual({ kind: 'pick', index: 1 });
    expect(resolveLabelChoice('첫 번째 거', [2, 3, 7])).toEqual({ kind: 'pick', index: 0 });
    // A bare number that is none of the labels is asked again (A6 R1 review), never routed as a new request.
    expect(resolveLabelChoice('1', [2, 3, 7])).toEqual({ kind: 'unlisted' });
    expect(resolveLabelChoice('네 번째 거', [2, 3, 7])).toEqual({ kind: 'unlisted' });
    expect(resolveLabelChoice('열 번째', [2, 3, 7])).toEqual({ kind: 'unlisted' });
    expect(resolveLabelChoice('취소', [2, 3])).toEqual({ kind: 'cancel' });
    expect(resolveLabelChoice('3번 메일 요약해줘', [2, 3])).toEqual({ kind: 'none' });
  });
});

describe('A6 R1 fix: the owner\'s source noun is cross-checked for every ref kind ("Same source only")', () => {
  const mail = state(listings([{ source: 'mail', labels: [1, 2], minute: 0 }]), 1);
  const drive = state(listings([{ source: 'drive', labels: [1, 2, 3], minute: 0 }]), 1);

  it('"1번 문서" after a mail list never reads a mail, whatever source the selector named', () => {
    expect(resolve('item.summarize', 'mail', '#1', '1번 문서 요약해줘요', mail)).toMatchObject({ kind: 'unresolved', outcome: 'other-source', source: 'drive', found: 'mail' });
    // With the owner's own source the existing rule asks too (the newest list is mail).
    expect(resolve('item.summarize', 'drive', '#1', '1번 문서 요약해줘요', mail)).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'mail' });
  });

  it('"2번 메일" after a Drive list never reads a Drive file; a matching noun resolves as before', () => {
    expect(resolve('item.summarize', 'drive', '#2', '2번 메일 요약해줘', drive)).toMatchObject({ kind: 'unresolved', outcome: 'other-source', source: 'mail', found: 'drive' });
    expect(resolve('item.summarize', 'drive', '#2', '2번 파일 요약해줘', drive)).toMatchObject({ kind: 'resolved', target: { source: 'drive', id: 'drive-2' } });
    expect(resolve('item.summarize', 'drive', '#2', '두 번째 거 요약해줘', drive)).toMatchObject({ kind: 'resolved', target: { id: 'drive-2' } });
  });

  it('applies to this / last / display numbers and to local writes (a reminder noun never completes a to-do)', () => {
    const todos = state(listings([{ source: 'todo', labels: [1, 2], minute: 0 }]), 1, { lastAction: action('todo.add', 'todo', 'todo-2', 0) });
    expect(resolve('todo.complete', 'todo', 'this', '그거 알림 완료해줘', todos)).toMatchObject({ kind: 'unresolved', outcome: 'other-source', source: 'reminder' });
    expect(resolve('todo.complete', 'todo', 'last', '마지막 메일 완료해줘', todos)).toMatchObject({ kind: 'unresolved', outcome: 'other-source', source: 'mail' });
    expect(resolve('reminder.cancel', 'reminder', '#13', '13번 할 일 취소해줘', todos)).toMatchObject({ kind: 'unresolved', outcome: 'other-source', source: 'todo' });
    expect(resolve('todo.complete', 'todo', '#2', '2번 할 일 완료해줘', todos)).toMatchObject({ kind: 'resolved', target: { id: 'todo-2' } });
    // A noun inside another word is not a source ("알림장").
    expect(resolve('todo.complete', 'todo', '#2', '2번 알림장 챙기기 완료', todos)).toMatchObject({ kind: 'resolved' });
  });
});

// ── A6 reference priority (owner-approved 2026-10-16; docs/plans/a6-reference-priority-proposal.md §2-§3) ──────────

describe('A6 reference priority: a newer listing vs a fresh lastAction (proposal §3 tests 1-10, 14)', () => {
  const sec = (seconds: number) => seconds / 60;
  const reqAction = (entryId: NlActionEntryId, source: 'todo' | 'reminder', itemId: string, minute: number, extra: Partial<LastActionRecord> = {}) =>
    action(entryId, source, itemId, minute, { requestId: `req-${itemId}`, ...extra });

  it('1. this: a todo lastAction, then a newer multi-item todo listing asks with the listing\'s candidates (B1 same source)', () => {
    const last = reqAction('todo.complete', 'todo', 'todo-a', 0, { label: 3 });
    const newer = listings([{ source: 'todo', labels: [1, 2, 4, 5, 6], minute: 1 }]);
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(newer, 2, { lastAction: last }))).toMatchObject({
      kind: 'unresolved',
      outcome: 'ambiguous',
      candidates: items('todo', [1, 2, 4, 5, 6]),
      found: 'todo',
      listingAt: at(1),
    });
  });

  it('2. this: a todo lastAction, then a reminder listing, entry todo.cancel asks other-source (B1 case a)', () => {
    const last = reqAction('todo.complete', 'todo', 'todo-a', 0, { label: 3 });
    const reminders = listings([{ source: 'reminder', labels: [11, 12], minute: 2 }]);
    expect(resolve('todo.cancel', 'todo', 'this', '그거 취소해', state(reminders, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', source: 'todo', found: 'reminder' });
  });

  it('3. the same state with entry reminder.cancel: one listed reminder resolves, several ask', () => {
    const last = reqAction('todo.complete', 'todo', 'todo-a', 0, { label: 3 });
    const one = listings([{ source: 'reminder', labels: [11], minute: 2 }]);
    expect(resolve('reminder.cancel', 'reminder', 'this', '그거 취소해', state(one, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'reminder', id: 'reminder-11', label: 11 } });
    const several = listings([{ source: 'reminder', labels: [11, 12], minute: 2 }]);
    expect(resolve('reminder.cancel', 'reminder', 'this', '그거 취소해', state(several, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', candidates: items('reminder', [11, 12]) });
  });

  it('4. recent (방금 거): a newer same-source multi-item or cross-source listing asks; no newer listing stays on lastAction', () => {
    const last = reqAction('todo.complete', 'todo', 'todo-a', 0, { label: 3 });
    const sameSource = listings([{ source: 'todo', labels: [1, 2, 4], minute: 1 }]);
    expect(resolve('todo.cancel', 'todo', 'recent', '방금 거 취소해', state(sameSource, 2, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', candidates: items('todo', [1, 2, 4]) });
    const crossSource = listings([{ source: 'reminder', labels: [11], minute: 1 }]);
    expect(resolve('todo.cancel', 'todo', 'recent', '방금 거 취소해', state(crossSource, 2, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'reminder' });
    expect(resolve('todo.cancel', 'todo', 'recent', '방금 거 취소해', state(undefined, 2, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-a', label: 3 } });
    // A recency word is never rebound to a listing item: one newer item that is another to-do asks (conflict).
    const otherOne = listings([{ source: 'todo', labels: [9], minute: 1 }]);
    expect(resolve('todo.cancel', 'todo', 'recent', '방금 거 취소해', state(otherOne, 2, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'conflict' });
  });

  it('5. this with lastAction newer than the listing resolves to lastAction', () => {
    const older = listings([{ source: 'todo', labels: [1, 2, 3], minute: 0 }]);
    const last = reqAction('todo.add', 'todo', 'todo-x', 2, { label: 7 });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(older, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-x', label: 7 } });
    const otherSource = listings([{ source: 'reminder', labels: [11, 12], minute: 0 }]);
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(otherSource, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-x', label: 7 } });
  });

  it('6. echo exclusion through the real record/read path: the action\'s own merged slot is not a newer listing', () => {
    // A listing at T, then the write at T+2 records quoky.lastAction AND merges its echo label into the to-do slot under
    // the same requestId (exactly as recordReceipt does); then the session metadata is read back.
    const record: LastActionRecord = { entryId: 'todo.add', source: 'todo', itemId: 'todo-new', label: 4, at: at(2), undoable: true, undone: false, requestId: 'req-add', echoReplyIds: [] };
    const build = (echoRequestId: string) => {
      const listing = withLabelledListing(
        withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2, 3]), at(0), 'listing', 'req-list'),
        ACTOR,
        'todo',
        [{ label: 4, id: 'todo-new' }],
        at(2),
        'merge',
        echoRequestId,
      );
      const metadata = { [LAST_LISTING_METADATA_KEY]: listing, [LAST_ACTION_METADATA_KEY]: withLastAction(undefined, ACTOR, record, at(2)) };
      const lastAction = readSessionLastAction({ metadata }, ACTOR, at(3));
      const s: NlReferenceState = { listings: readListingRecord(metadata[LAST_LISTING_METADATA_KEY], ACTOR, at(3)), ...(lastAction !== undefined ? { lastAction } : {}), now: at(3) };
      return s;
    };
    const echoed = build('req-add');
    expect(echoed.listings.slots.todo?.requestId).toBe('req-add');
    expect(echoed.listings.slots.todo?.at).toBe(echoed.lastAction?.record.at);
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', echoed)).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-new', label: 4 } });
    expect(resolve('todo.complete', 'todo', 'recent', '방금 거 완료', echoed)).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-new', label: 4 } });
    // Control: the same slot written by ANOTHER request ties with the action and asks, so the read path really keeps it.
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', build('req-other'))).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous' });
  });

  it('7. a tie within one second with a listing that is not the echo asks', () => {
    const last = reqAction('todo.add', 'todo', 'todo-a', 2, { label: 4 });
    const sameSource = withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2]), at(2 + sec(0.5)), 'listing', 'req-list');
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(sameSource, 3, { lastAction: last }))).toMatchObject({
      kind: 'unresolved',
      outcome: 'ambiguous',
      candidates: items('todo', [1, 2]),
    });
    // A tied single item asks too: as a conflict when it is another to-do, as a question even when it is the same one.
    const otherOne = withLabelledListing(undefined, ACTOR, 'todo', [{ label: 5, id: 'todo-b' }], at(2 + sec(0.5)), 'listing', 'req-list');
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(otherOne, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'conflict' });
    const sameOne = withLabelledListing(undefined, ACTOR, 'todo', [{ label: 4, id: 'todo-a' }], at(2 + sec(0.5)), 'listing', 'req-list');
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(sameOne, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', candidates: [{ label: 4, id: 'todo-a' }] });
    const before = withLabelledListing(undefined, ACTOR, 'reminder', items('reminder', [11]), at(2 - sec(0.5)), 'listing', 'req-list');
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(before, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'reminder' });
    // A recency word asks only for a strictly newer listing (rule 3): a tie keeps it on the action.
    expect(resolve('todo.complete', 'todo', 'recent', '방금 거 완료', state(before, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-a', label: 4 } });
    expect(resolve('todo.complete', 'todo', 'recent', '방금 거 완료', state(sameSource, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-a', label: 4 } });
    expect(newestReference(readLastAction(last, ACTOR, at(3))!.record, readListingRecord(sameSource, ACTOR, at(3))).kind).toBe('tie');
    // One full second apart is ordered again.
    const apart = withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2]), at(2 - sec(1)), 'listing', 'req-list');
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(apart, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-a', label: 4 } });
  });

  it('8. numbers: the listing, never lastAction; a newer other-source listing asks other-source', () => {
    const todoList = listings([{ source: 'todo', labels: [1, 2, 3], minute: 0 }]);
    const last = reqAction('todo.add', 'todo', 'todo-x', 2, { label: 2 });
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(todoList, 3, { lastAction: last }))).toEqual({ kind: 'resolved', target: { source: 'todo', id: 'todo-2', label: 2 } });
    const withReminders = listings([{ source: 'todo', labels: [1, 2, 3], minute: 0 }, { source: 'reminder', labels: [11, 12], minute: 2 }]);
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(withReminders, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'other-source', found: 'reminder' });
    expect(resolve('todo.complete', 'todo', '#2', '2번 완료', state(undefined, 3, { lastAction: last }))).toMatchObject({ kind: 'unresolved', outcome: 'none' });
    // The one exception: a reminder display number.
    const reminderLast = reqAction('reminder.create', 'reminder', 'rem-uuid', 2, { label: 13 });
    expect(resolve('reminder.cancel', 'reminder', '#13', '알림 13 취소', state(todoList, 3, { lastAction: reminderLast }))).toEqual({ kind: 'resolved', target: { source: 'reminder', label: 13 } });
  });

  it('9. undo stays on lastAction: newer listings, another actor\'s action and a firing reminder change nothing', () => {
    const record: LastActionRecord = { entryId: 'todo.complete', source: 'todo', itemId: 'todo-a', label: 3, at: at(0), undoable: true, undone: false, requestId: 'req-a', echoReplyIds: ['echo-a'] };
    let value = withLastAction(undefined, ACTOR, record, at(0));
    value = withLastAction(value, 'actor-2', { ...record, itemId: 'todo-b', requestId: 'req-b', at: at(1) }, at(1));
    const expected = { kind: 'resolved', target: { source: 'todo', id: 'todo-a', label: 3 }, undo: { entryId: 'todo.complete' } };
    // A newer listing of any source is never read by undo (resolveUndo does not even take one).
    const newer = listings([{ source: 'reminder', labels: [11, 12], minute: 2 }, { source: 'todo', labels: [1, 2], minute: 3 }]);
    expect(resolveUndo(state(newer, 4, { lastAction: value }))).toEqual(expected);
    expect(resolveUndo(state(undefined, 9, { lastAction: value }))).toEqual(expected);
    expect(resolveUndo(state(newer, 11, { lastAction: value }))).toEqual({ kind: 'unresolved', outcome: 'stale' });
    expect(resolveUndo(state(newer, 29, { lastAction: value, replyTo: 'echo-a' }))).toMatchObject(expected);
    const undone = withLastAction(value, ACTOR, { ...record, entryId: 'action.undo', undoOf: 'todo.complete', undoable: false, at: at(5) }, at(5));
    expect(resolveUndo(state(newer, 6, { lastAction: undone }))).toEqual({ kind: 'unresolved', outcome: 'undo-of-undo' });
  });

  it('10. expiry boundaries: lastAction 9:59 / 10:01 against a listing 29:59 / 30:01', () => {
    const now = 40;
    const listingAt = (age: number) => withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2]), at(now - age), 'listing', 'req-list');
    const lastAt = (age: number) => reqAction('todo.add', 'todo', 'todo-x', now - age, { label: 9 });
    const fresh = listingAt(29 + sec(59));
    const gone = listingAt(30 + sec(1));
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(fresh, now, { lastAction: lastAt(9 + sec(59)) }))).toMatchObject({ kind: 'resolved', target: { id: 'todo-x' } });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(fresh, now, { lastAction: lastAt(10 + sec(1)) }))).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous', candidates: items('todo', [1, 2]) });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(gone, now, { lastAction: lastAt(9 + sec(59)) }))).toMatchObject({ kind: 'resolved', target: { id: 'todo-x' } });
    expect(resolve('todo.complete', 'todo', 'this', '그거 완료', state(gone, now, { lastAction: lastAt(10 + sec(1)) }))).toMatchObject({ kind: 'unresolved', outcome: 'stale' });
  });

  it('14. the Reference context line stays structure only with the slot requestId (no id, label, title or request id)', () => {
    let value = withLabelledListing(undefined, ACTOR, 'todo', items('todo', [1, 2, 3]), at(0), 'listing', 'req-list-secret');
    value = withLabelledListing(value, ACTOR, 'todo', [{ label: 4, id: 'todo-secret-id' }], at(2), 'merge', 'req-add-secret');
    const s = state(value, 3, { lastAction: reqAction('todo.add', 'todo', 'todo-secret-id', 2, { label: 4, requestId: 'req-add-secret' }) });
    const line = renderReferenceContext(s);
    expect(line).toBe('last listing: todo (4 items, 1 min ago); last action: todo.add (1 min ago, undoable)');
    for (const secret of ['todo-secret-id', 'req-add-secret', 'req-list-secret', 'todo-1']) expect(line).not.toContain(secret);
  });
});
