import { describe, expect, it } from 'vitest';
import {
  InvalidReminderTransitionError,
  ReminderStatus,
  WorkItemReopenError,
  WorkItemStatus,
  canTransitionReminder,
  canTransitionWorkItem,
  cancelReminder,
  createReminderDraft,
  reactivateReminder,
  reopenWorkItem,
  transitionWorkItem,
  type Reminder,
  type WorkItem,
} from './index';

// ADR-0120 amendment A6, ratification record B: the two undo-only reverse transitions. The generic tables stay closed.

const T0 = '2026-10-14T00:00:00.000Z';
const T1 = '2026-10-14T00:05:00.000Z';
const item: WorkItem = { id: 'w1', actorId: 'a1', title: '보고서', resourceRefs: [], status: WorkItemStatus.ACTIVE, origin: 'conversation', createdAt: T0, updatedAt: T0 };

describe('reopenWorkItem (amends ADR-0075 narrowly)', () => {
  it('reopens the SAME completed or canceled item only while unchanged', () => {
    for (const status of [WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED]) {
      const done = transitionWorkItem(item, status, T1);
      expect(reopenWorkItem(done, '2026-10-14T00:06:00.000Z', T1)).toMatchObject({ id: 'w1', status: WorkItemStatus.ACTIVE, createdAt: T0 });
      expect(() => reopenWorkItem(done, T1, T0)).toThrow(WorkItemReopenError);
    }
    expect(() => reopenWorkItem(item, T1, T0)).toThrow(/not COMPLETED or CANCELED/);
  });

  it('keeps the generic transition table closed for every other caller', () => {
    expect(canTransitionWorkItem(WorkItemStatus.COMPLETED, WorkItemStatus.ACTIVE)).toBe(false);
    expect(canTransitionWorkItem(WorkItemStatus.CANCELED, WorkItemStatus.ACTIVE)).toBe(false);
    expect(() => transitionWorkItem({ ...item, status: WorkItemStatus.COMPLETED }, WorkItemStatus.ACTIVE, T1)).toThrow();
  });
});

describe('reactivateReminder (amends ADR-0101 D4 narrowly)', () => {
  const scheduled: Reminder = {
    ...createReminderDraft({ id: 'r1', actorId: 'a1', kind: 'TEXT', body: '약', schedule: { type: 'DAILY', time: { hour: 8, minute: 0 } }, timeZone: 'Asia/Seoul', origin: { platform: 'p', channelId: 'c' }, firstFireAt: '2026-10-14T23:00:00.000Z', createdAt: T0 }),
    displayNo: 13,
  };
  it('CANCELED → SCHEDULED keeps id, #N and recurrence; the next fire is the given future occurrence', () => {
    const canceled = cancelReminder(scheduled, T1);
    const next = reactivateReminder(canceled, T1, '2026-10-15T23:00:00.000Z');
    expect(next).toMatchObject({ id: 'r1', displayNo: 13, status: ReminderStatus.SCHEDULED, schedule: { type: 'DAILY' }, nextFireAt: '2026-10-15T23:00:00.000Z', occurrenceAt: '2026-10-15T23:00:00.000Z', attempt: 0 });
  });
  it('refuses anything but CANCELED, a past fire time, or a schedule of another type', () => {
    expect(() => reactivateReminder(scheduled, T1, '2026-10-15T23:00:00.000Z')).toThrow(InvalidReminderTransitionError);
    const canceled = cancelReminder(scheduled, T1);
    expect(() => reactivateReminder(canceled, T1, T0)).toThrow();
    expect(() => reactivateReminder(canceled, T1, '2026-10-15T23:00:00.000Z', { type: 'ONCE', at: '2026-10-15T23:00:00.000Z' })).toThrow();
  });
  it('keeps the ADR-0101 D4 table closed: CANCELED has no successor for every other caller', () => {
    expect(canTransitionReminder(ReminderStatus.CANCELED, ReminderStatus.SCHEDULED)).toBe(false);
  });
});
