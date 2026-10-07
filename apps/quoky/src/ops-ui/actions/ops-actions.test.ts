import { describe, expect, it, vi } from 'vitest';
import {
  DefaultMemoryWriter,
  MemoryCommandService,
  MemoryType,
  ReminderConversationService,
  ReminderReplyComposer,
  ReminderStatus,
  cancelReminder,
  createVectorRemovalCascade,
  isArchivedMemory,
  parseMemoryCommand,
} from '@quoky/core';
import type {
  CancelReminderResult,
  DurableMemoryQuery,
  LogFields,
  Logger,
  MemoryRecord,
  MemoryRepository,
  Reminder,
  ReminderRepository,
} from '@quoky/core';

import type { OpsOwnerResolution } from '../snapshot/build-snapshot';
import { OpsUiActions } from './ops-actions';
import type { OpsActionsDeps } from './ops-actions';

/**
 * OPS-2 (ADR-0113 D7) acceptance, offline: the UI actions reach the same Core services as chat (one fixture driven
 * from both surfaces, effects compared), memory forget needs the ADR-0106 code, and with owner ids that map to zero
 * or several Actors every action is refused.
 */

const OWNER = 'actor-owner';
const NOW = '2026-10-06T03:00:00.000Z';
const ZONE = 'Asia/Seoul';
// Built by concatenation so no token-shaped literal sits in the source.
const SECRET_LIKE = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function captureLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, fields?: LogFields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

// ---------------------------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------------------------

function reminder(displayNo: number, body: string, status: ReminderStatus = ReminderStatus.SCHEDULED): Reminder {
  return {
    id: `r${displayNo}`,
    actorId: OWNER,
    displayNo,
    status,
    kind: 'TEXT',
    body,
    schedule: { type: 'ONCE', at: '2026-10-07T00:00:00.000Z' },
    timeZone: ZONE,
    origin: { platform: 'discord', channelId: 'dm', userId: 'owner-discord-id' },
    nextFireAt: '2026-10-07T00:00:00.000Z',
    occurrenceAt: '2026-10-07T00:00:00.000Z',
    attempt: 0,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  } as Reminder;
}

class FakeReminders implements ReminderRepository {
  rows: Reminder[];
  cancels = 0;
  constructor(rows: Reminder[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }
  async createWithinLimit(): Promise<never> {
    throw new Error('not used');
  }
  async listActiveByActor(actorId: string): Promise<Reminder[]> {
    return this.rows.filter((r) => r.actorId === actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING));
  }
  async getByDisplayNo(actorId: string, displayNo: number): Promise<Reminder | null> {
    return this.rows.find((r) => r.actorId === actorId && r.displayNo === displayNo) ?? null;
  }
  async cancel(actorId: string, displayNo: number, at: string): Promise<CancelReminderResult> {
    this.cancels += 1;
    const index = this.rows.findIndex((r) => r.actorId === actorId && r.displayNo === displayNo);
    const row = this.rows[index];
    if (row === undefined) return { status: 'NOT_FOUND' };
    if (row.status === ReminderStatus.FIRING) return { status: 'IN_FLIGHT', reminder: row };
    if (row.status !== ReminderStatus.SCHEDULED) return { status: 'ALREADY_FINAL', reminder: row };
    const canceled = cancelReminder(row, at);
    this.rows[index] = canceled;
    return { status: 'CANCELED', reminder: canceled };
  }
  async claimDue(): Promise<Reminder[]> {
    return [];
  }
  async completeFiring(): Promise<never> {
    throw new Error('not used');
  }
  async listFiring(): Promise<Reminder[]> {
    return [];
  }
}

function reminderService(repository: ReminderRepository, enabled = true): ReminderConversationService {
  return new ReminderConversationService({
    repository,
    composer: new ReminderReplyComposer(),
    timeZone: ZONE,
    enabled,
    logger: captureLogger(),
  });
}

function actions(overrides: Partial<OpsActionsDeps> & { owner?: () => Promise<OpsOwnerResolution> }): OpsUiActions {
  return new OpsUiActions({
    owner: async () => ({ status: 'RESOLVED', actorId: OWNER }),
    clock: () => NOW,
    timeZone: ZONE,
    logger: captureLogger(),
    ...overrides,
  });
}

describe('OPS-2 reminder cancel (ADR-0113 D7)', () => {
  it('has the same effect as the chat cancel on one fixture', async () => {
    const fixture = [reminder(1, '회의 준비'), reminder(2, '약 먹기')];
    const chatRepo = new FakeReminders(fixture);
    const uiRepo = new FakeReminders(fixture);
    const chat = reminderService(chatRepo);
    await chat.handleTurn({ text: '알림 2 취소', context: { platform: 'discord', channelId: 'dm', userId: 'o' }, actorId: OWNER, messageId: 'm', now: NOW });
    const ui = actions({ reminders: { service: reminderService(uiRepo), repository: uiRepo } });
    expect(await ui.cancelReminder(2)).toEqual({ code: 'CANCELED', message: '알림을 취소했어요. 더 이상 보내지 않아요.', ok: true });
    expect(uiRepo.rows).toEqual(chatRepo.rows);
    expect(uiRepo.rows[1]?.status).toBe(ReminderStatus.CANCELED);
  });

  it('maps every typed outcome to fixed copy without the reminder body', async () => {
    const repo = new FakeReminders([reminder(1, 'BODY_MARKER 회의'), reminder(2, 'x', ReminderStatus.FIRING), reminder(3, 'y', ReminderStatus.COMPLETED)]);
    const ui = actions({ reminders: { service: reminderService(repo), repository: repo } });
    const outcomes = [await ui.cancelReminder(1), await ui.cancelReminder(1), await ui.cancelReminder(2), await ui.cancelReminder(3), await ui.cancelReminder(9)];
    expect(outcomes.map((o) => o.code)).toEqual(['CANCELED', 'ALREADY_FINAL', 'IN_FLIGHT', 'ALREADY_FINAL', 'NOT_FOUND']);
    expect(JSON.stringify(outcomes)).not.toContain('BODY_MARKER');
    const off = actions({ reminders: { service: reminderService(repo, false), repository: repo } });
    expect((await off.cancelReminder(1)).code).toBe('REMINDERS_DISABLED');
  });

  it('previews a cancel read-only with the 알림 목록 label, guarded', async () => {
    const repo = new FakeReminders([reminder(1, '회의 준비'), reminder(2, `토큰 ${SECRET_LIKE}`), reminder(3, 'z', ReminderStatus.CANCELED)]);
    const ui = actions({ reminders: { service: reminderService(repo), repository: repo } });
    expect(await ui.reminderCancelPreview(1)).toEqual({ status: 'FOUND', displayNo: 1, label: '회의 준비', nextAt: '2026-10-07 09:00:00' });
    expect(await ui.reminderCancelPreview(2)).toMatchObject({ status: 'FOUND', label: '[hidden]' });
    expect(await ui.reminderCancelPreview(3)).toMatchObject({ status: 'REFUSED', outcome: { code: 'NOT_FOUND' } });
    expect(repo.cancels).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------------------------

let seq = 0;
function memory(content: string): MemoryRecord {
  seq += 1;
  const createdAt = new Date(Date.parse('2026-09-01T00:00:00.000Z') + seq * 60_000).toISOString();
  return {
    id: `memory-${String(seq).padStart(3, '0')}`,
    type: MemoryType.LONG_TERM,
    scope: { userId: OWNER, sessionId: 'session-1' },
    content,
    metadata: {
      kind: 'SEMANTIC',
      provenance: 'USER_PROVIDED',
      authorityLevel: 'USER_CLAIM_OR_INTENT',
      sourceContent: `기억해: ${content}`,
      trigger: 'EXPLICIT_USER_INSTRUCTION',
    },
    createdAt,
    updatedAt: createdAt,
  } as MemoryRecord;
}

function memoryHarness(initial: MemoryRecord[]) {
  const records: MemoryRecord[] = initial.map((record) => ({ ...record, metadata: { ...(record.metadata ?? {}) } }));
  const archiveFilter = (record: MemoryRecord, query: DurableMemoryQuery) => {
    const mode = query.archived ?? 'exclude';
    return mode === 'include' ? true : mode === 'exclude' ? !isArchivedMemory(record) : isArchivedMemory(record);
  };
  const repository: MemoryRepository = {
    get: async (id) => records.find((record) => record.id === id) ?? null,
    save: async (record) => {
      const index = records.findIndex((existing) => existing.id === record.id);
      if (index >= 0) records[index] = record;
      else records.push(record);
      return record;
    },
    delete: async (id) => {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) records.splice(index, 1);
    },
    list: async () => [...records],
    findByScope: async (scope, type) =>
      records.filter((record) => (type === undefined || record.type === type) && record.scope.userId === scope.userId && !isArchivedMemory(record)),
    findDurableCandidates: async (query) =>
      records
        .filter(
          (record) =>
            record.type === MemoryType.LONG_TERM &&
            (query.scope.userId === undefined || record.scope.userId === query.scope.userId) &&
            !(query.excludeSuperseded && record.metadata?.['supersededBy'] !== undefined) &&
            archiveFilter(record, query),
        )
        .slice(0, query.limit),
    findShortTermByUser: async () => [],
  };
  const writer = new DefaultMemoryWriter({
    durableMemory: (id) => repository.get(id),
    durableMemories: (scope) => repository.findByScope(scope, MemoryType.LONG_TERM),
    saveDurable: (record) => repository.save(record),
    forgetDurable: (id) => repository.delete(id),
  });
  const vectors = { delete: vi.fn(async () => undefined) };
  const service = new MemoryCommandService({
    records: repository,
    writer,
    cascades: [createVectorRemovalCascade(vectors)],
    archiveDays: 7,
    logger: captureLogger(),
  });
  const chat = async (text: string) => {
    const command = parseMemoryCommand(text);
    if (command === null) throw new Error(`not a memory command: ${text}`);
    return service.execute(command, { actorId: OWNER, now: NOW, sourceText: text });
  };
  return { records, service, vectors, chat };
}

function codeOf(text: string): string {
  const match = /기억 확인 ([A-Z0-9]{4})/.exec(text);
  if (!match?.[1]) throw new Error('no code');
  return match[1];
}

describe('OPS-2 memory forget (ADR-0113 D7, ADR-0106 D4)', () => {
  it('has the same effect as the chat forget on one fixture', async () => {
    const fixture = [memory('커피는 아메리카노'), memory('홍차도 좋아')];
    const chat = memoryHarness(fixture);
    const ui = memoryHarness(fixture);
    await chat.chat(`기억 확인 ${codeOf((await chat.chat('기억 1 잊어줘')).text)}`);

    const handling = actions({ memory: ui.service });
    const request = await handling.requestForget(1);
    if (request.status !== 'CONFIRMATION') throw new Error('expected a confirmation');
    expect(request).toMatchObject({ number: 1, preview: '커피는 아메리카노' });
    expect((await handling.confirmForget(request.code)).code).toBe('FORGOTTEN');

    expect(ui.records).toEqual(chat.records);
    expect(isArchivedMemory(ui.records[0] as MemoryRecord)).toBe(true);
    expect(ui.vectors.delete.mock.calls).toEqual(chat.vectors.delete.mock.calls);
    // The forget code is one-time across both surfaces.
    expect((await handling.confirmForget(request.code)).code).toBe('CODE_UNKNOWN');
    expect((await ui.chat(`기억 확인 ${request.code}`)).outcome).toBe('confirm-unknown');
  });

  it('requires the ADR-0106 code: a wrong code, or one issued for an edit, changes nothing', async () => {
    const h = memoryHarness([memory('버전 1')]);
    const handling = actions({ memory: h.service });
    const request = await handling.requestForget(1);
    if (request.status !== 'CONFIRMATION') throw new Error('expected a confirmation');
    expect((await handling.confirmForget(request.code === 'AAAA' ? 'BBBB' : 'AAAA')).code).toBe('CODE_UNKNOWN');
    const editCode = codeOf((await h.chat('기억 1 수정: 버전 2')).text);
    expect((await handling.confirmForget(editCode)).code).toBe('CODE_UNKNOWN');
    expect(h.records[0]?.content).toBe('버전 1');
    expect(isArchivedMemory(h.records[0] as MemoryRecord)).toBe(false);
    // The chat edit code is still pending for chat.
    expect((await h.chat(`기억 확인 ${editCode}`)).outcome).toBe('edited');
  });

  it('lists the 기억 목록 previews only, masking credential-like text', async () => {
    const h = memoryHarness([memory('커피는 아메리카노'), memory(`깃허브 토큰 ${SECRET_LIKE}`), memory('x'.repeat(400))]);
    const list = await actions({ memory: h.service }).listMemories();
    if (list.status !== 'OK') throw new Error('expected a list');
    expect(list.total).toBe(3);
    expect(list.rows[0]).toEqual({ number: 1, preview: '커피는 아메리카노' });
    expect(list.rows[1]?.preview).toBe('(비밀번호·토큰처럼 보여서 내용을 표시하지 않아요)');
    expect(Array.from(list.rows[2]?.preview ?? '').length).toBe(120);
    expect(JSON.stringify(list)).not.toContain(SECRET_LIKE);
  });

  it('reports a store failure as FAILED without content', async () => {
    const logger = captureLogger();
    const failing = {
      listable: async () => {
        throw new Error('db down: 커피는 아메리카노');
      },
      requestForgetConfirmation: async () => {
        throw new Error('db down: 커피는 아메리카노');
      },
      confirmForget: async () => {
        throw new Error('db down');
      },
    } as unknown as OpsActionsDeps['memory'];
    const handling = actions({ memory: failing, logger });
    expect(await handling.listMemories()).toMatchObject({ status: 'REFUSED', outcome: { code: 'FAILED' } });
    expect(await handling.requestForget(1)).toMatchObject({ status: 'REFUSED', outcome: { code: 'FAILED' } });
    expect((await handling.confirmForget('ABCD')).code).toBe('FAILED');
    expect(logger.lines.join('\n')).not.toContain('아메리카노');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Owner identity and audit
// ---------------------------------------------------------------------------------------------------------------

describe('OPS-2 owner identity and audit (ADR-0113 D7)', () => {
  it.each([
    ['no Actor', { status: 'NONE' } as const],
    ['several Actors', { status: 'AMBIGUOUS' } as const],
  ])('disables every action when the owner ids map to %s', async (_label, resolution) => {
    const repo = new FakeReminders([reminder(1, '회의 준비')]);
    const h = memoryHarness([memory('커피는 아메리카노')]);
    const requestSpy = vi.spyOn(h.service, 'requestForgetConfirmation');
    const confirmSpy = vi.spyOn(h.service, 'confirmForget');
    const handling = actions({
      owner: async () => resolution,
      reminders: { service: reminderService(repo), repository: repo },
      memory: h.service,
    });
    expect((await handling.cancelReminder(1)).code).toBe('ACTIONS_DISABLED');
    expect(await handling.reminderCancelPreview(1)).toMatchObject({ status: 'REFUSED', outcome: { code: 'ACTIONS_DISABLED' } });
    expect(await handling.listMemories()).toMatchObject({ status: 'REFUSED', outcome: { code: 'ACTIONS_DISABLED' } });
    expect(await handling.requestForget(1)).toMatchObject({ status: 'REFUSED', outcome: { code: 'ACTIONS_DISABLED' } });
    expect((await handling.confirmForget('ABCD')).code).toBe('ACTIONS_DISABLED');
    expect(repo.cancels).toBe(0);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(repo.rows[0]?.status).toBe(ReminderStatus.SCHEDULED);
  });

  it('refuses an action whose service is not wired', async () => {
    const handling = actions({});
    expect((await handling.cancelReminder(1)).code).toBe('ACTION_UNAVAILABLE');
    expect(await handling.listMemories()).toMatchObject({ status: 'REFUSED', outcome: { code: 'ACTION_UNAVAILABLE' } });
  });

  it('writes content-free audit lines with the ops-ui surface marker', async () => {
    const logger = captureLogger();
    const repo = new FakeReminders([reminder(1, 'BODY_MARKER 회의')]);
    const h = memoryHarness([memory('MEMORY_MARKER 커피')]);
    const handling = actions({ logger, reminders: { service: reminderService(repo), repository: repo }, memory: h.service });
    await handling.cancelReminder(1);
    const request = await handling.requestForget(1);
    if (request.status !== 'CONFIRMATION') throw new Error('expected a confirmation');
    await handling.confirmForget(request.code);
    expect(logger.lines).toEqual([
      'info ops-ui.action.executed {"surface":"ops-ui","action":"reminder.cancel","outcome":"CANCELED"}',
      'info ops-ui.action.executed {"surface":"ops-ui","action":"memory.forget","outcome":"FORGOTTEN"}',
    ]);
    expect(logger.lines.join('\n')).not.toMatch(/BODY_MARKER|MEMORY_MARKER|커피/);
    expect(logger.lines.join('\n')).not.toContain(request.code);
  });

  it('decides no approval when approval handling is not wired (OPS-2b needs the runtime decision service)', async () => {
    const handling = actions({});
    expect(await handling.approvalPreview('approval-1')).toEqual({
      status: 'REFUSED',
      outcome: { code: 'ACTION_UNAVAILABLE', message: '이 처리는 지금 쓸 수 없어요.', ok: false },
    });
    expect(await handling.decideApproval('approval-1', 'approve', 'ABCDEF')).toMatchObject({ code: 'ACTION_UNAVAILABLE', ok: false });
  });
});
