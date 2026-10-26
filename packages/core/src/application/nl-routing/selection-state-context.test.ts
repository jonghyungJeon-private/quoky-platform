import { describe, expect, it } from 'vitest';
import type { IsoTimestamp, Metadata } from '../../domain';
import {
  LAST_SELECTION_MAX_EARLIER,
  LAST_SELECTION_METADATA_KEY,
  agedLastSelectionRecord,
  lastSelectionFor,
  lastSelectionRecord,
  nlSelectionSourceOf,
  readLastSelection,
} from './selection-state';

/** Owner decision D1 (a chat turn keeps `lastSelection`, one turn older) and P7 (the latest selection of each other source). */

const at = (minutes: number): IsoTimestamp => new Date(Date.UTC(2026, 9, 26, 1, minutes)).toISOString() as IsoTimestamp;
const read = (record: Metadata | undefined, now: IsoTimestamp, actorId = 'owner') => readLastSelection({ metadata: record === undefined ? {} : { [LAST_SELECTION_METADATA_KEY]: record } }, actorId, now);

describe('lastSelection context (D1, P7)', () => {
  it('a source is the closed entry id prefix (both Jira entries are one source)', () => {
    expect(nlSelectionSourceOf('jira.issues')).toBe('jira');
    expect(nlSelectionSourceOf('jira.release')).toBe('jira');
    expect(nlSelectionSourceOf('calendar.events')).toBe('calendar');
  });

  it('a new selection of another source keeps the replaced one as earlier, one turn older; the same source replaces it', () => {
    const calendar = lastSelectionRecord('owner', { entryId: 'calendar.events', args: { range: 'tomorrow' } }, at(0));
    const todo = lastSelectionRecord('owner', { entryId: 'todo.list', args: {} }, at(1), calendar);
    expect(read(todo, at(2))).toMatchObject({ entryId: 'todo.list', earlier: [{ entryId: 'calendar.events', args: { range: 'tomorrow' }, turns: 1, at: at(0) }] });
    const calendarAgain = lastSelectionRecord('owner', { entryId: 'calendar.events', args: { range: 'today' } }, at(3), todo);
    expect(read(calendarAgain, at(4))).toMatchObject({ entryId: 'calendar.events', args: { range: 'today' }, earlier: [{ entryId: 'todo.list', turns: 1 }] });
    expect(read(calendarAgain, at(4))?.earlier).toHaveLength(1);
    // A refinement of the same entry carries no earlier copy of itself.
    expect(read(lastSelectionRecord('owner', { entryId: 'todo.list', args: { status: 'done' } }, at(2), todo), at(3))?.earlier).toEqual([{ entryId: 'calendar.events', args: { range: 'tomorrow' }, at: at(0), turns: 2 }]);
  });

  it('keeps at most the bound, newest first, each within its own 30 minutes, and never another actor\'s record', () => {
    let record: Metadata | undefined;
    const ids = ['mail.list', 'drive.files', 'calendar.events', 'jira.issues', 'todo.list'] as const;
    ids.forEach((entryId, index) => {
      record = lastSelectionRecord('owner', { entryId, args: {} }, at(index), record);
    });
    expect(read(record, at(5))?.earlier?.map((item) => item.entryId)).toEqual(['jira.issues', 'calendar.events', 'drive.files'].slice(0, LAST_SELECTION_MAX_EARLIER));
    // The mail selection of minute 0 is past its 30 minutes at minute 30 even though the record is fresh.
    const late = lastSelectionRecord('owner', { entryId: 'calendar.events', args: {} }, at(29), lastSelectionRecord('owner', { entryId: 'mail.list', args: {} }, at(0)));
    expect(read(late, at(31))?.earlier).toBeUndefined();
    expect(lastSelectionRecord('owner', { entryId: 'todo.list', args: {} }, at(1), lastSelectionRecord('guest', { entryId: 'mail.list', args: {} }, at(0)))).not.toHaveProperty('earlier');
  });

  it('a chat turn ages the record (and its earlier selections) by one turn, keeping its time and TTL', () => {
    const shown = lastSelectionRecord('owner', { entryId: 'todo.list', args: {} }, at(1), lastSelectionRecord('owner', { entryId: 'calendar.events', args: { range: 'tomorrow' } }, at(0)));
    const once = agedLastSelectionRecord(shown, 'owner', at(2));
    const twice = agedLastSelectionRecord(once, 'owner', at(3));
    expect(read(twice, at(4))).toMatchObject({ entryId: 'todo.list', at: at(1), turns: 2, earlier: [{ entryId: 'calendar.events', turns: 3 }] });
    expect(agedLastSelectionRecord(shown, 'guest', at(2))).toBeUndefined();
    expect(agedLastSelectionRecord(shown, 'owner', at(40))).toBeUndefined();
    // A plain record reads as before: no turns, no earlier.
    expect(read(lastSelectionRecord('owner', { entryId: 'mail.list', args: {} }, at(0)), at(1))).toEqual({ entryId: 'mail.list', args: {}, at: at(0) });
  });

  it('an output for an earlier entry refines that selection; any other output keeps the previous one', () => {
    const last = read(lastSelectionRecord('owner', { entryId: 'todo.list', args: {} }, at(1), lastSelectionRecord('owner', { entryId: 'calendar.events', args: { range: 'tomorrow' } }, at(0))), at(2));
    expect(lastSelectionFor('calendar.events', last)).toEqual({ entryId: 'calendar.events', args: { range: 'tomorrow' }, at: at(0), turns: 1 });
    expect(lastSelectionFor('todo.list', last)).toBe(last);
    expect(lastSelectionFor('mail.list', last)).toBe(last);
    expect(lastSelectionFor(null, last)).toBe(last);
  });

  it('malformed stored parts are ignored', () => {
    const record = { actorId: 'owner', entryId: 'todo.list', args: {}, at: at(1), turns: -3, earlier: [{ entryId: 'todo.add', args: {}, at: at(0), turns: 1 }, 'x', { entryId: 'mail.list', args: { a: { b: 1 } }, at: at(0) }] };
    expect(read(record, at(2))).toEqual({ entryId: 'todo.list', args: {}, at: at(1) });
  });
});
