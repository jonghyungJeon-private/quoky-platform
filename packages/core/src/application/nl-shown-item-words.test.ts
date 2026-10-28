import { describe, expect, it } from 'vitest';
import type { IsoTimestamp, Metadata } from '../domain';
import { nlHeldItemWordsFor } from './conversation-runtime';
import { nlShownItemWords } from './nl-routing/honest-chat';
import { LAST_SELECTION_METADATA_KEY, agedLastSelectionRecord, lastSelectionRecord, readLastSelection } from './nl-routing/selection-state';

// Codex review of 7f7e8d32 (P2): the held item words must bind to the exact listing record, not to a completion time.
const at = (seconds: number): IsoTimestamp => new Date(Date.UTC(2026, 9, 28, 1, 0, seconds)).toISOString() as IsoTimestamp;
const read = (record: Metadata, now: IsoTimestamp) => readLastSelection({ metadata: { [LAST_SELECTION_METADATA_KEY]: record } }, 'owner', now);

describe('shown item words bind to the turn that recorded the listing', () => {
  const calendarWords = nlShownItemWords('- 10:00–11:00 1차 면접_AI Agent_김하늘');
  const driveWords = nlShownItemWords('1. 2026 로드맵 회의록 · document');

  it('two concurrent listings: A records first, B records last, A finishes last; A\'s words never attach to B\'s record', () => {
    // Turn A (calendar) and turn B (drive) run concurrently in one session. A writes lastSelection first, B overwrites it.
    const afterA = lastSelectionRecord('owner', { entryId: 'calendar.events', args: { range: 'tomorrow' } }, at(1), undefined, undefined, 'msg-A');
    const afterB = lastSelectionRecord('owner', { entryId: 'drive.files', args: {} }, at(2), afterA, undefined, 'msg-B');
    const last = read(afterB, at(5));
    expect(last).toMatchObject({ entryId: 'drive.files', turnId: 'msg-B' });
    // A completes after B, so the held words are A's (taken later than B's record was written).
    const heldFromA = { turnId: 'msg-A', words: calendarWords };
    expect(nlHeldItemWordsFor(heldFromA, last ?? {})).toBeUndefined();
    // The words of B's own turn attach to B's record.
    expect(nlHeldItemWordsFor({ turnId: 'msg-B', words: driveWords }, last ?? {})).toEqual(driveWords);
  });

  it('a record without a turn id attaches nothing; a chat turn keeps the id (D1)', () => {
    const plain = lastSelectionRecord('owner', { entryId: 'calendar.events', args: {} }, at(1));
    expect(nlHeldItemWordsFor({ turnId: 'msg-A', words: calendarWords }, read(plain, at(2)) ?? {})).toBeUndefined();
    const recorded = lastSelectionRecord('owner', { entryId: 'calendar.events', args: {} }, at(1), undefined, undefined, 'msg-A');
    const aged = agedLastSelectionRecord(recorded, 'owner', at(3)) as Metadata;
    expect(nlHeldItemWordsFor({ turnId: 'msg-A', words: calendarWords }, read(aged, at(4)) ?? {})).toEqual(calendarWords);
  });
});
