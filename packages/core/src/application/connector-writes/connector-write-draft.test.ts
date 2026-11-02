import { describe, expect, it } from 'vitest';
import { connectorWriteFamilyOf, type ConnectorWriteDraft } from './connector-write-draft';

// P3-1: every draft kind names its own writer family; there is no catch-all that could route a new kind to the calendar.
describe('connectorWriteFamilyOf is exhaustive', () => {
  const time = { allDay: false as const, start: '2026-11-03T17:00:00+09:00', end: '2026-11-03T18:00:00+09:00', timeZone: 'Asia/Seoul' };
  const cases: ReadonlyArray<readonly [ConnectorWriteDraft, string]> = [
    [{ kind: 'issue-comment', issueKey: 'PROJ-1', text: 't' } as unknown as ConnectorWriteDraft, 'issue-comment'],
    [{ kind: 'issue-transition', issueKey: 'PROJ-1', toStatus: 'Done' } as unknown as ConnectorWriteDraft, 'issue-transition'],
    [{ kind: 'channel-post', channel: 'c', text: 't' } as unknown as ConnectorWriteDraft, 'channel-post'],
    [{ kind: 'calendar-create', event: { title: 't', time } }, 'calendar'],
    [{ kind: 'calendar-update', ref: {}, changes: {} } as unknown as ConnectorWriteDraft, 'calendar'],
    [{ kind: 'calendar-delete', ref: {} } as unknown as ConnectorWriteDraft, 'calendar'],
    [{ kind: 'calendar-create-undo', receiptId: 'r1' }, 'calendar'],
    [{ kind: 'usage', topic: 'issue-comment' }, 'issue-comment'],
    [{ kind: 'usage', topic: 'channel-post' }, 'channel-post'],
  ];
  it.each(cases)('maps %j', (draft, family) => {
    expect(connectorWriteFamilyOf(draft)).toBe(family);
  });
  it('throws for an unknown kind instead of defaulting to the calendar', () => {
    expect(() => connectorWriteFamilyOf({ kind: 'something-new' } as unknown as ConnectorWriteDraft)).toThrow('unhandled connector write draft kind');
  });
});
