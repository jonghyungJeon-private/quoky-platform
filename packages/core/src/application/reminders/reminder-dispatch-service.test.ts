import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ReminderStatus,
  WorkItemStatus,
  applyFiringCompletion,
  cancelReminder,
  claimReminder,
  createReminderDraft,
  type ConversationContext,
  type Reminder,
  type ReminderBodyKind,
  type ReminderDraft,
  type ReminderFiringCompletion,
  type ReminderSchedule,
  type WorkItem,
} from '../../domain';
import type { Logger, LogFields } from '../../ports/logger.port';
import type { NotificationSink, OwnerNotification } from '../../ports/notification-sink.port';
import type {
  CancelReminderResult,
  CompleteFiringResult,
  CreateReminderResult,
  ReminderRepository,
} from '../../ports/reminder-repository.port';
import { DailyBriefSources } from './daily-brief-sources';
import { ReminderDispatchService } from './reminder-dispatch-service';
import { ReminderReplyComposer } from './reminder-reply-composer';
import { PLAIN_TEXT_MARKUP, renderMessageContent } from '../message-rendering';

const ZONE = 'Asia/Seoul';
const ACTOR = 'actor-1';
const ORIGIN: ConversationContext = { platform: 'discord', spaceId: 'g1', channelId: 'c1', userId: 'owner' };
// 2026-10-02 12:00 KST (Friday).
const NOW = '2026-10-02T03:00:00.000Z';

const iso = (ms: number): string => new Date(ms).toISOString();
const minutes = (iso0: string, n: number): string => iso(Date.parse(iso0) + n * 60_000);

/** In-memory repository with the same compare-and-set semantics as the SQLite one. */
class FakeReminderRepository implements ReminderRepository {
  readonly rows = new Map<string, Reminder>();
  readonly completeCalls: Array<{ id: string; attemptId: string; completion: ReminderFiringCompletion }> = [];
  failClaim = false;
  failCompleteFor: string | undefined;
  failListActive = false;
  private nextNo = 1;

  seed(input: {
    id?: string;
    body?: string;
    kind?: ReminderBodyKind;
    schedule: ReminderSchedule;
    occurrenceAt: string;
    actorId?: string;
    status?: ReminderStatus;
  }): Reminder {
    const draft: ReminderDraft = createReminderDraft({
      id: input.id ?? `r${this.nextNo}`,
      actorId: input.actorId ?? ACTOR,
      kind: input.kind ?? 'TEXT',
      body: input.body ?? '회의 준비',
      schedule: input.schedule,
      timeZone: ZONE,
      origin: ORIGIN,
      firstFireAt: input.occurrenceAt,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    let reminder: Reminder = { ...draft, displayNo: this.nextNo++ };
    if (input.status === ReminderStatus.FIRING) reminder = claimReminder(reminder, 'old-attempt', input.occurrenceAt);
    this.rows.set(reminder.id, reminder);
    return reminder;
  }

  get(id: string): Reminder {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`missing ${id}`);
    return row;
  }

  async createWithinLimit(): Promise<CreateReminderResult> {
    throw new Error('not used by dispatch');
  }

  async listActiveByActor(actorId: string): Promise<Reminder[]> {
    if (this.failListActive) throw new Error('db down');
    return [...this.rows.values()]
      .filter((r) => r.actorId === actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING))
      .sort((a, b) => a.displayNo - b.displayNo);
  }

  async getByDisplayNo(actorId: string, displayNo: number): Promise<Reminder | null> {
    return [...this.rows.values()].find((r) => r.actorId === actorId && r.displayNo === displayNo) ?? null;
  }

  async cancel(actorId: string, displayNo: number, at: string): Promise<CancelReminderResult> {
    const row = await this.getByDisplayNo(actorId, displayNo);
    if (row === null) return { status: 'NOT_FOUND' };
    if (row.status === ReminderStatus.FIRING) return { status: 'IN_FLIGHT', reminder: row };
    if (row.status !== ReminderStatus.SCHEDULED) return { status: 'ALREADY_FINAL', reminder: row };
    const canceled = cancelReminder(row, at);
    this.rows.set(row.id, canceled);
    return { status: 'CANCELED', reminder: canceled };
  }

  async claimDue(now: string, limit: number, attemptId: string): Promise<Reminder[]> {
    if (this.failClaim) throw new Error('db down');
    const due = [...this.rows.values()]
      .filter((r) => r.status === ReminderStatus.SCHEDULED && Date.parse(r.nextFireAt ?? '') <= Date.parse(now))
      .sort((a, b) => Date.parse(a.nextFireAt ?? '') - Date.parse(b.nextFireAt ?? '') || a.displayNo - b.displayNo)
      .slice(0, limit);
    return due.map((r) => {
      const claimed = claimReminder(r, attemptId, now);
      this.rows.set(r.id, claimed);
      return claimed;
    });
  }

  async completeFiring(id: string, attemptId: string, completion: ReminderFiringCompletion): Promise<CompleteFiringResult> {
    this.completeCalls.push({ id, attemptId, completion });
    if (this.failCompleteFor === id) throw new Error('db down');
    const row = this.rows.get(id);
    if (row === undefined || row.status !== ReminderStatus.FIRING || row.firingAttemptId !== attemptId) {
      return { status: 'CONFLICT' };
    }
    const next = applyFiringCompletion(row, attemptId, completion);
    this.rows.set(id, next);
    return { status: 'COMPLETED', reminder: next };
  }

  async listFiring(): Promise<Reminder[]> {
    return [...this.rows.values()].filter((r) => r.status === ReminderStatus.FIRING);
  }
}

type SinkScript = (notification: OwnerNotification, call: number) => ReturnType<NotificationSink['deliver']>;

class ScriptedSink implements NotificationSink {
  readonly delivered: OwnerNotification[] = [];
  constructor(private script: SinkScript = async () => ({ status: 'SENT', via: 'dm' })) {}
  setScript(script: SinkScript): void {
    this.script = script;
  }
  async deliver(notification: OwnerNotification) {
    this.delivered.push(notification);
    return this.script(notification, this.delivered.length);
  }
}

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, ...(fields ? { fields } : {}) });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, ...(fields ? { fields } : {}) });
  }
}

const ONCE_AT = (at: string): ReminderSchedule => ({ type: 'ONCE', at });
const DAILY_8: ReminderSchedule = { type: 'DAILY', time: { hour: 8, minute: 0 } };

function workItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    actorId: ACTOR,
    resourceRefs: [],
    status: WorkItemStatus.ACTIVE,
    origin: 'conversation',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(workItems: readonly WorkItem[] = []) {
  const repository = new FakeReminderRepository();
  const sink = new ScriptedSink();
  const logger = new RecordingLogger();
  let attempt = 0;
  const listCalls: string[] = [];
  const service = new ReminderDispatchService({
    repository,
    sink,
    composer: new ReminderReplyComposer(),
    workItems: {
      async listByActor(actorId) {
        listCalls.push(actorId);
        return workItems;
      },
    },
    logger,
    idGenerator: () => `attempt-${++attempt}`,
  });
  return { repository, sink, logger, service, listCalls };
}

describe('ReminderDispatchService.dispatchDue', () => {
  it('stops starting new deliveries once shouldContinue is false; the active one is recorded, the rest stay FIRING', async () => {
    const { repository, sink, service, logger } = setup();
    const a = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    const b = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    const c = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    let stopping = false;
    sink.setScript(async () => {
      stopping = true; // stop requested while the first send is in flight
      return { status: 'SENT', via: 'dm' };
    });
    const summary = await service.dispatchDue(NOW, { shouldContinue: () => !stopping });
    expect(summary).toMatchObject({ claimed: 3, delivered: 1 });
    expect(sink.delivered).toHaveLength(1);
    expect(repository.get(a.id).status).toBe(ReminderStatus.COMPLETED);
    expect(repository.get(b.id).status).toBe(ReminderStatus.FIRING);
    expect(repository.get(c.id).status).toBe(ReminderStatus.FIRING);
    expect(logger.lines).toContainEqual({ level: 'warn', message: 'reminder.dispatch.cancelled', fields: { unstarted: 2 } });
  });

  it('delivers an on-time ONCE reminder once and completes it', async () => {
    const { repository, sink, service } = setup();
    const r = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, deliveredLate: 0, viaDm: 1, errors: 0 });
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]).toMatchObject({ target: ORIGIN, kind: 'TEXT', text: '알림 #1: 회의 준비' });
    const done = repository.get(r.id);
    expect(done.status).toBe(ReminderStatus.COMPLETED);
    expect(done.lastOutcome).toMatchObject({ outcome: 'SENT', via: 'dm', occurrenceAt: NOW, recordedAt: NOW });
    expect(done.nextFireAt).toBeUndefined();
    // Never delivered again.
    await service.dispatchDue(minutes(NOW, 60));
    expect(sink.delivered).toHaveLength(1);
  });

  it('does not claim a reminder that is not yet due', async () => {
    const { repository, sink, service } = setup();
    repository.seed({ schedule: ONCE_AT(minutes(NOW, 5)), occurrenceAt: minutes(NOW, 5) });
    const summary = await service.dispatchDue(NOW);
    expect(summary.claimed).toBe(0);
    expect(sink.delivered).toHaveLength(0);
  });

  it('delivers a ONCE reminder that is 3 hours overdue late, once, with the original time in the text', async () => {
    const { repository, sink, service } = setup();
    const scheduled = '2026-10-02T00:00:00.000Z'; // 09:00 KST
    const r = repository.seed({ schedule: ONCE_AT(scheduled), occurrenceAt: scheduled });
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ delivered: 1, deliveredLate: 1 });
    expect(sink.delivered[0]?.text).toBe('알림 #1: 회의 준비 (원래 오전 9:00 예정 — 늦게 전달됐어요)');
    expect(repository.get(r.id).status).toBe(ReminderStatus.COMPLETED);
  });

  it('delivers a DAILY reminder 20 minutes overdue late and schedules tomorrow 08:00', async () => {
    const { repository, sink, service } = setup();
    const occurrence = '2026-10-01T23:00:00.000Z'; // 08:00 KST on Oct 2
    const r = repository.seed({ schedule: DAILY_8, occurrenceAt: occurrence });
    const now = minutes(occurrence, 20);
    await service.dispatchDue(now);
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]?.text).toContain('늦게 전달');
    const next = repository.get(r.id);
    expect(next.status).toBe(ReminderStatus.SCHEDULED);
    expect(next.occurrenceAt).toBe('2026-10-02T23:00:00.000Z');
    expect(next.nextFireAt).toBe('2026-10-02T23:00:00.000Z');
    expect(next.attempt).toBe(0);
    expect(next.lastOutcome).toMatchObject({ outcome: 'SENT', occurrenceAt: occurrence });
  });

  it('skips a DAILY reminder 7 hours overdue without sending and moves to the next future 08:00', async () => {
    const { repository, sink, service } = setup();
    const occurrence = '2026-10-01T23:00:00.000Z';
    const r = repository.seed({ schedule: DAILY_8, occurrenceAt: occurrence });
    const now = minutes(occurrence, 7 * 60); // 15:00 KST
    const summary = await service.dispatchDue(now);
    expect(sink.delivered).toHaveLength(0);
    expect(summary).toMatchObject({ claimed: 1, skippedMissed: 1, delivered: 0 });
    const next = repository.get(r.id);
    expect(next.status).toBe(ReminderStatus.SCHEDULED);
    expect(next.nextFireAt).toBe('2026-10-02T23:00:00.000Z');
    expect(next.lastOutcome).toMatchObject({ outcome: 'SKIPPED_MISSED', occurrenceAt: occurrence });
  });

  it('delivers a DAILY reminder at exactly the 60-minute catch-up limit and skips one minute past it', async () => {
    const occurrence = '2026-10-01T23:00:00.000Z';
    const atLimit = setup();
    atLimit.repository.seed({ schedule: DAILY_8, occurrenceAt: occurrence });
    await atLimit.service.dispatchDue(minutes(occurrence, 60));
    expect(atLimit.sink.delivered).toHaveLength(1);

    const past = setup();
    past.repository.seed({ schedule: DAILY_8, occurrenceAt: occurrence });
    await past.service.dispatchDue(minutes(occurrence, 61));
    expect(past.sink.delivered).toHaveLength(0);
  });

  it('retries only a retryable NOT_SENT at +1/+5/+15 minutes, then fails a ONCE reminder', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async () => ({ status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true }));
    const r = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });

    let now = NOW;
    const expectedBackoff = [1, 5, 15];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const summary = await service.dispatchDue(now);
      expect(summary).toMatchObject({ retried: 1, failed: 0 });
      const row = repository.get(r.id);
      expect(row.status).toBe(ReminderStatus.SCHEDULED);
      expect(row.attempt).toBe(attempt);
      expect(row.occurrenceAt).toBe(NOW);
      expect(row.nextFireAt).toBe(minutes(now, expectedBackoff[attempt - 1] as number));
      // Not claimable before the backoff elapses.
      expect((await service.dispatchDue(minutes(now, expectedBackoff[attempt - 1] as number - 0.5))).claimed).toBe(0);
      now = row.nextFireAt as string;
    }
    const last = await service.dispatchDue(now);
    expect(last).toMatchObject({ retried: 0, failed: 1 });
    const failed = repository.get(r.id);
    expect(failed.status).toBe(ReminderStatus.FAILED);
    expect(failed.lastOutcome).toMatchObject({ outcome: 'FAILED', reason: 'RATE_LIMITED' });
    expect(sink.delivered).toHaveLength(4);
    // Terminal: nothing further is sent.
    await service.dispatchDue(minutes(now, 120));
    expect(sink.delivered).toHaveLength(4);
  });

  it('retries a recurring reminder, then advances to the next occurrence after retries are exhausted', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async () => ({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true }));
    const occurrence = '2026-10-01T23:00:00.000Z';
    const r = repository.seed({ schedule: DAILY_8, occurrenceAt: occurrence });
    let now = occurrence;
    for (let i = 0; i < 3; i++) {
      await service.dispatchDue(now);
      now = repository.get(r.id).nextFireAt as string;
    }
    expect(now).toBe(minutes(occurrence, 21));
    await service.dispatchDue(now);
    const row = repository.get(r.id);
    expect(sink.delivered).toHaveLength(4);
    expect(row.status).toBe(ReminderStatus.SCHEDULED);
    expect(row.nextFireAt).toBe('2026-10-02T23:00:00.000Z');
    expect(row.attempt).toBe(0);
    expect(row.lastOutcome).toMatchObject({ outcome: 'FAILED', reason: 'NOT_CONNECTED', occurrenceAt: occurrence });
  });

  it('a retry that later succeeds completes the reminder', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async (_n, call) =>
      call === 1 ? { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true } : { status: 'SENT', via: 'dm' },
    );
    const r = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    await service.dispatchDue(NOW);
    await service.dispatchDue(minutes(NOW, 1));
    expect(repository.get(r.id).status).toBe(ReminderStatus.COMPLETED);
    expect(sink.delivered).toHaveLength(2);
  });

  it('treats a refused delivery as terminal with no retry', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async () => ({ status: 'NOT_SENT', reason: 'NOT_OWNER', retryable: false }));
    const r = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ failed: 1, retried: 0 });
    expect(repository.get(r.id)).toMatchObject({ status: ReminderStatus.FAILED });
    await service.dispatchDue(minutes(NOW, 30));
    expect(sink.delivered).toHaveLength(1);
  });

  it('records UNCERTAIN as terminal DELIVERY_UNCERTAIN, never retried, no fallback target', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async () => ({ status: 'UNCERTAIN', reason: 'TIMEOUT' }));
    const r = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ uncertain: 1, retried: 0, delivered: 0 });
    const row = repository.get(r.id);
    expect(row.status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
    expect(row.lastOutcome).toMatchObject({ outcome: 'DELIVERY_UNCERTAIN', reason: 'TIMEOUT' });
    await service.dispatchDue(minutes(NOW, 60));
    await service.dispatchDue(minutes(NOW, 24 * 60));
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered.every((n) => n.target === ORIGIN)).toBe(true);
  });

  it('records UNCERTAIN for a recurring reminder and advances without resending', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async () => ({ status: 'UNCERTAIN', reason: 'NETWORK_ERROR' }));
    const occurrence = '2026-10-01T23:00:00.000Z';
    const r = repository.seed({ schedule: DAILY_8, occurrenceAt: occurrence });
    await service.dispatchDue(occurrence);
    const row = repository.get(r.id);
    expect(row.status).toBe(ReminderStatus.SCHEDULED);
    expect(row.nextFireAt).toBe('2026-10-02T23:00:00.000Z');
    expect(row.lastOutcome).toMatchObject({ outcome: 'DELIVERY_UNCERTAIN', reason: 'NETWORK_ERROR' });
    await service.dispatchDue(minutes(occurrence, 30));
    expect(sink.delivered).toHaveLength(1);
  });

  it('isolates a sink exception to its reminder (uncertain, never retried) and still delivers the others', async () => {
    const { repository, sink, service, logger } = setup();
    repository.seed({ id: 'a', body: '첫째', schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    repository.seed({ id: 'b', body: '둘째 비밀본문', schedule: ONCE_AT(minutes(NOW, -1)), occurrenceAt: minutes(NOW, -1) });
    repository.seed({ id: 'c', body: '셋째', schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    sink.setScript(async (n) => {
      if (n.text.includes('둘째')) throw new Error('boom with 둘째 비밀본문');
      return { status: 'SENT', via: 'dm' };
    });
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ claimed: 3, delivered: 2, uncertain: 1, errors: 0 });
    expect(repository.get('a').status).toBe(ReminderStatus.COMPLETED);
    expect(repository.get('b').status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
    expect(repository.get('c').status).toBe(ReminderStatus.COMPLETED);
    await service.dispatchDue(minutes(NOW, 30));
    expect(sink.delivered).toHaveLength(3);
    // The log carries the error class only, never the body or the exception message.
    const serialized = JSON.stringify(logger.lines);
    expect(serialized).not.toContain('비밀본문');
    expect(serialized).not.toContain('boom');
  });

  it('isolates a completion write failure: the reminder stays FIRING and the batch continues', async () => {
    const { repository, sink, service } = setup();
    repository.seed({ id: 'a', schedule: ONCE_AT(minutes(NOW, -2)), occurrenceAt: minutes(NOW, -2) });
    repository.seed({ id: 'b', schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    repository.failCompleteFor = 'a';
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ claimed: 2, errors: 1 });
    expect(sink.delivered).toHaveLength(2);
    expect(repository.get('a').status).toBe(ReminderStatus.FIRING);
    expect(repository.get('b').status).toBe(ReminderStatus.COMPLETED);
    // A stuck FIRING row is never re-sent: it is only ever recovered as uncertain.
    await service.dispatchDue(minutes(NOW, 30));
    expect(sink.delivered).toHaveLength(2);
  });

  it('claims and delivers at most 10 reminders per call', async () => {
    const { repository, sink, service } = setup();
    for (let i = 0; i < 12; i++) {
      repository.seed({ schedule: ONCE_AT(minutes(NOW, -i)), occurrenceAt: minutes(NOW, -i) });
    }
    const first = await service.dispatchDue(NOW);
    expect(first.claimed).toBe(10);
    expect(sink.delivered).toHaveLength(10);
    const second = await service.dispatchDue(NOW);
    expect(second.claimed).toBe(2);
    expect(sink.delivered).toHaveLength(12);
  });

  it('ignores a stale attempt id: nothing is written and the summary counts the conflict', async () => {
    const { repository, sink, service } = setup();
    const r = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    sink.setScript(async () => {
      // Another dispatcher took over the row while the send was in flight.
      repository.rows.set(r.id, { ...repository.get(r.id), firingAttemptId: 'someone-else' });
      return { status: 'SENT', via: 'dm' };
    });
    const summary = await service.dispatchDue(NOW);
    expect(summary.staleCompletions).toBe(1);
    expect(repository.get(r.id).status).toBe(ReminderStatus.FIRING);
    expect(repository.get(r.id).firingAttemptId).toBe('someone-else');
  });

  it('does not throw when the claim fails', async () => {
    const { repository, service, sink } = setup();
    repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    repository.failClaim = true;
    const summary = await service.dispatchDue(NOW);
    expect(summary).toMatchObject({ claimed: 0, errors: 1 });
    expect(sink.delivered).toHaveLength(0);
  });

  it('does not deliver a reminder the owner canceled before the claim', async () => {
    const { repository, service, sink } = setup();
    repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    await repository.cancel(ACTOR, 1, NOW);
    await service.dispatchDue(NOW);
    expect(sink.delivered).toHaveLength(0);
  });

  it('counts channel deliveries separately from DM deliveries', async () => {
    const { repository, sink, service } = setup();
    sink.setScript(async () => ({ status: 'SENT', via: 'channel' }));
    repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    expect(await service.dispatchDue(NOW)).toMatchObject({ delivered: 1, viaChannel: 1, viaDm: 0 });
  });
});

describe('ReminderDispatchService BRIEF', () => {
  it("composes today's remaining reminders and ACTIVE WorkItem titles from local reads only", async () => {
    const { repository, sink, service, listCalls } = setup([
      workItem({ id: 'w1', title: '분기 보고서 작성' }),
      workItem({ id: 'w2', title: '끝난 일', status: WorkItemStatus.COMPLETED }),
      workItem({ id: 'w3', title: '취소된 일', status: WorkItemStatus.CANCELED }),
      workItem({ id: 'w4', title: '@everyone 공지' }),
      workItem({ id: 'w5' }),
    ]);
    const occurrence = '2026-10-01T23:00:00.000Z'; // 08:00 KST Oct 2
    const brief = repository.seed({ kind: 'BRIEF', body: '오늘 할 일', schedule: DAILY_8, occurrenceAt: occurrence });
    repository.seed({ body: '오후 회의', schedule: ONCE_AT('2026-10-02T06:00:00.000Z'), occurrenceAt: '2026-10-02T06:00:00.000Z' });
    repository.seed({ body: '내일 일정', schedule: ONCE_AT('2026-10-03T00:00:00.000Z'), occurrenceAt: '2026-10-03T00:00:00.000Z' });
    repository.seed({ body: '다른 사람 알림', actorId: 'other', schedule: ONCE_AT('2026-10-02T06:00:00.000Z'), occurrenceAt: '2026-10-02T06:00:00.000Z' });

    await service.dispatchDue(occurrence);
    expect(sink.delivered).toHaveLength(1);
    const delivered = sink.delivered[0] as OwnerNotification;
    expect(delivered.kind).toBe('BRIEF');
    expect(delivered.target).toBe(ORIGIN);
    expect(delivered.text).toContain('오후 회의');
    expect(delivered.text).not.toContain('내일 일정');
    expect(delivered.text).not.toContain('다른 사람 알림');
    expect(delivered.text).not.toContain('오늘 할 일'); // the brief reminder itself is not listed
    expect(delivered.text).toContain('진행 중인 작업 3건');
    expect(delivered.text).toContain('분기 보고서 작성');
    expect(delivered.text).not.toContain('끝난 일');
    expect(delivered.text).not.toContain('취소된 일');
    // PLT-0: a title is an untrusted span of the notification content; the adapter keeps its mentions from pinging.
    expect(renderMessageContent(delivered.content ?? delivered.text, { ...PLAIN_TEXT_MARKUP, untrusted: (text, guard) => `«${guard}:${text}»` })).toContain(
      '- «mentions:@everyone 공지»',
    );
    expect(listCalls).toEqual([ACTOR]);
    const next = repository.get(brief.id);
    expect(next.status).toBe(ReminderStatus.SCHEDULED);
    expect(next.nextFireAt).toBe('2026-10-02T23:00:00.000Z');
    expect(next.lastOutcome).toMatchObject({ outcome: 'SENT' });
  });

  it('degrades the brief instead of failing when a local read throws', async () => {
    const repository = new FakeReminderRepository();
    const sink = new ScriptedSink();
    const service = new ReminderDispatchService({
      repository,
      sink,
      composer: new ReminderReplyComposer(),
      workItems: {
        async listByActor() {
          throw new Error('db down');
        },
      },
      logger: new RecordingLogger(),
      idGenerator: () => 'attempt',
    });
    repository.failListActive = true;
    const r = repository.seed({ kind: 'BRIEF', body: '브리핑', schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    await service.dispatchDue(NOW);
    expect(sink.delivered[0]?.text).toContain('불러오지 못했어요');
    expect(repository.get(r.id).status).toBe(ReminderStatus.COMPLETED);
  });
});

describe('ReminderDispatchService BRIEF with sources (ADR-0117, BRF-1)', () => {
  function withSources(briefSources: ConstructorParameters<typeof ReminderDispatchService>[0]['briefSources']) {
    const repository = new FakeReminderRepository();
    const sink = new ScriptedSink();
    const service = new ReminderDispatchService({
      repository,
      sink,
      composer: new ReminderReplyComposer(),
      workItems: { listByActor: async () => [] },
      logger: new RecordingLogger(),
      ...(briefSources !== undefined ? { briefSources } : {}),
      idGenerator: () => 'attempt',
    });
    return { repository, sink, service };
  }
  const occurrence = '2026-10-01T23:00:00.000Z'; // 08:00 KST Oct 2

  it("adds today's calendar read through the sources with the brief's actor, instant and zone", async () => {
    const requests: unknown[] = [];
    const { repository, sink, service } = withSources({
      async read(request) {
        requests.push(request);
        return {
          calendar: {
            events: [{ id: 'e', title: '팀 회의', start: '2026-10-02T01:00:00.000Z', end: '2026-10-02T02:00:00.000Z', allDay: false, status: 'confirmed', calendarName: 'primary' }],
            limit: 50,
          },
        };
      },
    });
    repository.seed({ kind: 'BRIEF', body: '브리핑', schedule: DAILY_8, occurrenceAt: occurrence });
    await service.dispatchDue(occurrence);
    expect(requests).toEqual([{ actorId: ACTOR, now: occurrence, timeZone: ZONE }]);
    expect(sink.delivered[0]?.text).toContain('오늘 일정 1건\n- 10:00–11:00 팀 회의');
    expect(sink.delivered[0]?.kind).toBe('BRIEF');
  });

  it('an unreadable calendar is delivered as the could-not-read note and the brief completes', async () => {
    const { repository, sink, service } = withSources(
      new DailyBriefSources({ calendar: { source: 'calendar', readOnly: true, listEvents: async () => { throw new Error('down'); } } }),
    );
    const brief = repository.seed({ kind: 'BRIEF', body: '브리핑', schedule: DAILY_8, occurrenceAt: occurrence });
    await service.dispatchDue(occurrence);
    expect(sink.delivered[0]?.text).toContain('오늘 일정: 불러오지 못했어요.');
    expect(repository.get(brief.id).lastOutcome).toMatchObject({ outcome: 'SENT' });
  });

  it('a TEXT reminder never reads the brief sources', async () => {
    let reads = 0;
    const { repository, sink, service } = withSources({ async read() { reads += 1; return {}; } });
    repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW });
    await service.dispatchDue(NOW);
    expect(sink.delivered).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it('without sources the brief text is the local-only brief', async () => {
    const a = withSources(undefined);
    const b = withSources({ async read() { return {}; } });
    for (const { repository, service } of [a, b]) {
      repository.seed({ kind: 'BRIEF', body: '브리핑', schedule: DAILY_8, occurrenceAt: occurrence });
      await service.dispatchDue(occurrence);
    }
    expect(a.sink.delivered[0]?.text).toBe(b.sink.delivered[0]?.text);
    expect(a.sink.delivered[0]?.text).not.toContain('오늘 일정');
  });

  it('accepts briefSources as the one additional documented dependency key', () => {
    const { service } = withSources({ async read() { return {}; } });
    const deps = (service as unknown as { deps: Record<string, unknown> }).deps;
    expect(Object.keys(deps).sort()).toEqual(['briefSources', 'composer', 'idGenerator', 'logger', 'repository', 'sink', 'workItems']);
  });
});

describe('ReminderDispatchService.recoverInterrupted', () => {
  it('marks every FIRING row DELIVERY_UNCERTAIN without any send; recurring advances to the next occurrence', async () => {
    const { repository, sink, service } = setup();
    const once = repository.seed({ schedule: ONCE_AT(NOW), occurrenceAt: NOW, status: ReminderStatus.FIRING });
    const daily = repository.seed({
      schedule: DAILY_8,
      occurrenceAt: '2026-10-01T23:00:00.000Z',
      status: ReminderStatus.FIRING,
    });
    const scheduled = repository.seed({ schedule: ONCE_AT(minutes(NOW, 60)), occurrenceAt: minutes(NOW, 60) });

    const summary = await service.recoverInterrupted(NOW);
    expect(summary).toEqual({ recovered: 2, staleCompletions: 0, errors: 0 });
    expect(sink.delivered).toHaveLength(0);
    expect(repository.get(once.id).status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
    expect(repository.get(once.id).lastOutcome).toMatchObject({ outcome: 'DELIVERY_UNCERTAIN', reason: 'INTERRUPTED' });
    const next = repository.get(daily.id);
    expect(next.status).toBe(ReminderStatus.SCHEDULED);
    expect(next.nextFireAt).toBe('2026-10-02T23:00:00.000Z');
    expect(next.lastOutcome).toMatchObject({ outcome: 'DELIVERY_UNCERTAIN', reason: 'INTERRUPTED' });
    expect(repository.get(scheduled.id).status).toBe(ReminderStatus.SCHEDULED);

    // A later tick never sends the recovered occurrence.
    await service.dispatchDue(minutes(NOW, 5));
    expect(sink.delivered).toHaveLength(0);
  });

  it('does nothing when no row is FIRING and survives a list failure', async () => {
    const { repository, service } = setup();
    expect(await service.recoverInterrupted(NOW)).toEqual({ recovered: 0, staleCompletions: 0, errors: 0 });
    repository.listFiring = async () => {
      throw new Error('db down');
    };
    expect(await service.recoverInterrupted(NOW)).toEqual({ recovered: 0, staleCompletions: 0, errors: 1 });
  });
});

describe('ReminderDispatchService reachable surface', () => {
  const source = readFileSync(new URL('./reminder-dispatch-service.ts', import.meta.url), 'utf8');
  const imports = source.split('\n').filter((line) => /^\s*(import|\} from)/.test(line)).join('\n');

  it('imports no provider, connector, tool, task, work-item write or runtime module', () => {
    expect(imports).not.toMatch(/ai-provider|connector|tool-provider|tool-manager|task-manager|work-manager|conversation-runtime|workspace|git-provider|command-runner/i);
  });

  it('accepts only the documented dependency keys', () => {
    const { service } = setup();
    const deps = (service as unknown as { deps: Record<string, unknown> }).deps;
    expect(Object.keys(deps).sort()).toEqual(['composer', 'idGenerator', 'logger', 'repository', 'sink', 'workItems']);
    const workItems = deps['workItems'] as Record<string, unknown>;
    expect(Object.keys(workItems)).toEqual(['listByActor']);
  });
});
