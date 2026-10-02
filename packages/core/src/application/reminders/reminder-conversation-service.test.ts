import { describe, expect, it } from 'vitest';
import {
  REMINDER_LIMITS,
  ReminderStatus,
  cancelReminder,
  claimReminder,
  type ConversationContext,
  type Reminder,
  type ReminderDraft,
} from '../../domain';
import type { Logger, LogFields } from '../../ports/logger.port';
import type {
  CancelReminderResult,
  CompleteFiringResult,
  CreateReminderResult,
  ReminderRepository,
} from '../../ports/reminder-repository.port';
import { ReminderConversationService } from './reminder-conversation-service';
import { ReminderReplyComposer } from './reminder-reply-composer';

const ZONE = 'Asia/Seoul';
const ACTOR = 'actor-1';
const CONTEXT: ConversationContext = { platform: 'discord', spaceId: 'g1', channelId: 'c1', userId: 'owner' };
// 2026-10-02 12:00 KST (Friday).
const NOW = '2026-10-02T03:00:00.000Z';

class FakeRepository implements ReminderRepository {
  readonly rows: Reminder[] = [];
  writes = 0;
  throwOn: 'create' | 'list' | 'cancel' | undefined;
  private nextNo = 1;

  async createWithinLimit(draft: ReminderDraft, maxActive: number): Promise<CreateReminderResult> {
    if (this.throwOn === 'create') throw new Error('db down: 비밀본문');
    const active = this.rows.filter(
      (r) => r.actorId === draft.actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING),
    );
    if (active.length >= maxActive) return { status: 'LIMIT_REACHED', activeCount: active.length };
    const reminder: Reminder = { ...draft, displayNo: this.nextNo++ };
    this.rows.push(reminder);
    this.writes++;
    return { status: 'CREATED', reminder };
  }

  async listActiveByActor(actorId: string): Promise<Reminder[]> {
    if (this.throwOn === 'list') throw new Error('db down');
    return this.rows.filter(
      (r) => r.actorId === actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING),
    );
  }

  async getByDisplayNo(): Promise<Reminder | null> {
    return null;
  }

  async cancel(actorId: string, displayNo: number, at: string): Promise<CancelReminderResult> {
    if (this.throwOn === 'cancel') throw new Error('db down');
    const index = this.rows.findIndex((r) => r.actorId === actorId && r.displayNo === displayNo);
    const row = this.rows[index];
    if (row === undefined) return { status: 'NOT_FOUND' };
    if (row.status === ReminderStatus.FIRING) return { status: 'IN_FLIGHT', reminder: row };
    if (row.status !== ReminderStatus.SCHEDULED) return { status: 'ALREADY_FINAL', reminder: row };
    const canceled = cancelReminder(row, at);
    this.rows[index] = canceled;
    this.writes++;
    return { status: 'CANCELED', reminder: canceled };
  }

  async claimDue(): Promise<Reminder[]> {
    return [];
  }
  async completeFiring(): Promise<CompleteFiringResult> {
    return { status: 'CONFLICT' };
  }
  async listFiring(): Promise<Reminder[]> {
    return [];
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

function setup(options: { enabled?: boolean } = {}) {
  const repository = new FakeRepository();
  const logger = new RecordingLogger();
  const composer = new ReminderReplyComposer();
  let ids = 0;
  const service = new ReminderConversationService({
    repository,
    composer,
    timeZone: ZONE,
    enabled: options.enabled ?? true,
    logger,
    idGenerator: () => `rem-${++ids}`,
  });
  const turn = (text: string, actorId = ACTOR) =>
    service.handleTurn({ text, context: CONTEXT, actorId, messageId: 'm1', now: NOW });
  return { repository, logger, composer, service, turn };
}

describe('ReminderConversationService create', () => {
  it('confirms with the absolute KST date, weekday, time, #N and the cancel hint, and stores the reminder', async () => {
    const { repository, turn } = setup();
    const reply = await turn('내일 오전 9시에 회의 준비 알려줘');
    expect(reply).toEqual({
      context: CONTEXT,
      text: "10월 3일(토) 오전 9:00에 '회의 준비' 알려드릴게요. (#1 · 취소: '알림 1 취소')",
      replyToMessageId: 'm1',
    });
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      id: 'rem-1',
      actorId: ACTOR,
      status: ReminderStatus.SCHEDULED,
      kind: 'TEXT',
      body: '회의 준비',
      timeZone: ZONE,
      origin: CONTEXT,
      occurrenceAt: '2026-10-03T00:00:00.000Z',
      nextFireAt: '2026-10-03T00:00:00.000Z',
      createdAt: NOW,
      schedule: { type: 'ONCE', at: '2026-10-03T00:00:00.000Z' },
    });
  });

  it('confirms a recurring reminder with its repeat label and first occurrence', async () => {
    const { turn } = setup();
    const reply = await turn('매일 오전 8시에 약 먹기 알려줘');
    expect(reply?.text).toBe("매일 오전 8:00에 '약 먹기' 알려드릴게요. 첫 알림은 10월 3일(토) 오전 8:00이에요. (#1 · 취소: '알림 1 취소')");
  });

  it('stores the daily brief as kind BRIEF and says it goes to the DM', async () => {
    const { repository, turn } = setup();
    const reply = await turn('매일 아침 8시에 오늘 할 일 알려줘');
    expect(repository.rows[0]?.kind).toBe('BRIEF');
    expect(reply?.text).toContain('오늘의 브리핑을 DM으로');
  });

  it('refuses a credential body with zero writes and never echoes it', async () => {
    const { repository, turn, composer } = setup();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const reply = await turn(`내일 오전 9시에 token=${secret} 알려줘`);
    expect(reply?.text).toBe(composer.credentialRefused());
    expect(reply?.text).not.toContain(secret);
    expect(repository.writes).toBe(0);
    expect(repository.rows).toHaveLength(0);
  });

  it('replies LIMIT_REACHED when the owner already has the maximum active reminders', async () => {
    const { repository, turn } = setup();
    for (let i = 0; i < REMINDER_LIMITS.maxActivePerActor; i++) {
      await turn(`내일 오전 9시에 일정${i} 알려줘`);
    }
    expect(repository.rows).toHaveLength(REMINDER_LIMITS.maxActivePerActor);
    const reply = await turn('내일 오전 10시에 하나 더 알려줘');
    expect(reply?.text).toContain(`${REMINDER_LIMITS.maxActivePerActor}건`);
    expect(reply?.text).toContain('취소');
    expect(repository.rows).toHaveLength(REMINDER_LIMITS.maxActivePerActor);
    // Another owner is unaffected.
    const other = await turn('내일 오전 9시에 일정 알려줘', 'actor-2');
    expect(other?.text).toContain('알려드릴게요');
  });
});

describe('ReminderConversationService disabled', () => {
  it('replies with the fixed disabled text to every recognized phrase and writes nothing', async () => {
    const { repository, turn, composer } = setup({ enabled: false });
    for (const text of ['내일 오전 9시에 회의 준비 알려줘', '알림 목록', '알림 1 취소', '내일 회의 리마인드 해줘']) {
      const reply = await turn(text);
      expect(reply?.text).toBe(composer.disabled());
    }
    expect(repository.writes).toBe(0);
  });

  it('still returns null for messages that are not reminders', async () => {
    const { turn } = setup({ enabled: false });
    expect(await turn('안녕하세요')).toBeNull();
  });
});

describe('ReminderConversationService list and cancel', () => {
  it('lists the owner active reminders with number, local time, repeat label and body', async () => {
    const { turn } = setup();
    expect((await turn('알림 목록'))?.text).toContain('예정된 알림이 없어요');
    await turn('내일 오전 9시에 회의 준비 알려줘');
    await turn('매일 오전 8시에 약 먹기 알려줘');
    await turn('내일 오전 9시에 남의 알림 알려줘', 'actor-2');
    const reply = await turn('알림 목록');
    expect(reply?.text).toBe(
      [
        '예정된 알림 2건',
        '#1 10월 3일(토) 오전 9:00 [1회] 회의 준비',
        '#2 10월 3일(토) 오전 8:00 [매일] 약 먹기',
      ].join('\n'),
    );
  });

  it('cancels by number, then reports it as already canceled', async () => {
    const { repository, turn } = setup();
    await turn('내일 오전 9시에 회의 준비 알려줘');
    expect((await turn('알림 1 취소'))?.text).toBe("알림 #1 취소했어요: '회의 준비'");
    expect(repository.rows[0]?.status).toBe(ReminderStatus.CANCELED);
    expect((await turn('알림 1 취소'))?.text).toContain('이미 취소됐어요');
    expect((await turn('알림 9 취소'))?.text).toContain('찾지 못했어요');
  });

  it('cannot cancel another owner reminder', async () => {
    const { repository, turn } = setup();
    await turn('내일 오전 9시에 회의 준비 알려줘');
    expect((await turn('알림 1 취소', 'actor-2'))?.text).toContain('찾지 못했어요');
    expect(repository.rows[0]?.status).toBe(ReminderStatus.SCHEDULED);
  });

  it('reports a reminder that is being sent as not cancelable, and final states by their status', async () => {
    const { repository, turn } = setup();
    await turn('내일 오전 9시에 회의 준비 알려줘');
    await turn('내일 오전 9시에 두번째 알려줘');
    await turn('내일 오전 9시에 세번째 알려줘');
    repository.rows[0] = claimReminder(repository.rows[0] as Reminder, 'att', NOW);
    repository.rows[1] = { ...(repository.rows[1] as Reminder), status: ReminderStatus.DELIVERY_UNCERTAIN };
    repository.rows[2] = { ...(repository.rows[2] as Reminder), status: ReminderStatus.COMPLETED };
    expect((await turn('알림 1 취소'))?.text).toContain('전달 중이라 취소할 수 없어요');
    expect((await turn('알림 2 취소'))?.text).toContain('다시 보내지 않아요');
    expect((await turn('알림 3 취소'))?.text).toContain('이미 전달됐어요');
  });

  it('clarifies a bulk cancel and an invalid number without touching anything', async () => {
    const { repository, turn, composer } = setup();
    expect((await turn('모든 알림 취소'))?.text).toBe(composer.clarify('BULK_CANCEL_UNSUPPORTED'));
    expect((await turn('알림 0 취소'))?.text).toBe(composer.clarify('INVALID_REMINDER_NUMBER'));
    expect(repository.writes).toBe(0);
  });
});

describe('ReminderConversationService clarify and non-reminders', () => {
  it('answers a request with no clock time with a clarification and writes nothing', async () => {
    const { repository, turn, composer } = setup();
    const reply = await turn('내일 회의 리마인드 해줘');
    expect(reply?.text).toBe(composer.clarify('MISSING_TIME'));
    expect(reply?.text).toContain('예:');
    expect(repository.writes).toBe(0);
  });

  it.each(['안녕하세요', '내일 회의 알려줘', '', '   ', '할 일 추가: 내일 9시에 회의 알려줘', '9시에 뭐 있어? 알려줘'])(
    'returns null for %j',
    async (text) => {
      const { repository, turn } = setup();
      expect(await turn(text)).toBeNull();
      expect(repository.writes).toBe(0);
    },
  );
});

describe('ReminderConversationService storage failure', () => {
  it.each([
    ['create', '내일 오전 9시에 비밀본문 알려줘'],
    ['list', '알림 목록'],
    ['cancel', '알림 1 취소'],
  ] as const)('a repository throw on %s gives the storage-failure reply, never an exception', async (op, text) => {
    const { repository, turn, composer, logger } = setup();
    repository.throwOn = op;
    const reply = await turn(text);
    expect(reply?.text).toBe(composer.storageFailure());
    const errorLine = logger.lines.find((l) => l.level === 'error');
    expect(errorLine).toBeDefined();
    const serialized = JSON.stringify(logger.lines);
    expect(serialized).not.toContain('비밀본문');
    expect(serialized).not.toContain('db down');
  });
});
