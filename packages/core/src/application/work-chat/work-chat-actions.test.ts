import { describe, expect, it } from 'vitest';
import { ActionWriteStoppedError, WorkItemStatus, type Actor, type WorkItem } from '../../domain';
import type { StorageProvider } from '../../ports';
import { plainTextOf } from '../message-rendering';
import type { NlSelectedCommand } from '../nl-routing/catalog';
import { WorkManager } from '../work-manager';
import { detectWorkChatCommand } from './work-chat-command';
import { renderedTodoRows } from './work-chat-renderer';
import { WorkChatService, type WorkChatOutcome } from './work-chat-service';
import { readListingRecord, withLabelledListing, type ListingSlot } from '../last-listing';

// ADR-0120 amendment A6 (NLA-3): natural-language to-do actions and their per-action inverses (ratification record A)
// through the REAL WorkManager; the anchored grammar's replies are unchanged and only gain content-free receipts.

const owner: Actor = { id: 'owner-1', displayName: 'Owner', identities: [], createdAt: '2026-10-14T00:00:00.000Z' };

function world(actionReceipts = true, onAwait: (point?: 'write') => void = () => undefined) {
  const rows = new Map<string, WorkItem>();
  const actor = { metadata: {} as Record<string, unknown> };
  const storage = {
    actors: {
      async get() {
        onAwait();
        return { ...owner, metadata: actor.metadata };
      },
    },
    workItems: {
      async get(id: string) {
        onAwait();
        return rows.get(id) ?? null;
      },
      async save(item: WorkItem) {
        rows.set(item.id, item);
        return item;
      },
      // The store's atomic conditional write (the SQLite adapter checks the actor row in the same transaction).
      async saveIf(item: WorkItem) {
        onAwait('write');
        if (actor.metadata['quoky.actionSwitch'] !== undefined && (actor.metadata['quoky.actionSwitch'] as { state: string }).state === 'stopped') return null;
        rows.set(item.id, item);
        return item;
      },
      async listByActor(actorId: string) {
        onAwait();
        return [...rows.values()].filter((item) => item.actorId === actorId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      },
      async listByResource() {
        return [];
      },
    },
  } as unknown as StorageProvider;
  const work = new WorkManager(storage);
  const desk = new WorkChatService(
    { workSurface: { forActor: async () => ({ items: [], status: 'COMPLETE', sources: [] }) as never }, connectors: { list: () => [] }, work },
    { summaryEnabled: false, actionReceipts },
  );
  return { rows, work, desk, actor };
}

const text = (outcome: WorkChatOutcome): string => (outcome.kind === 'reply' ? plainTextOf(outcome.content ?? outcome.text) : `<${outcome.kind}>`);
const cmd = (entryId: NlSelectedCommand['entryId'], args: NlSelectedCommand['args'] = {}, extra: Partial<NlSelectedCommand> = {}): NlSelectedCommand => ({ entryId, args, language: 'ko', ...extra });

async function addThree(desk: WorkChatService): Promise<void> {
  for (const title of ['보고서 쓰기', 'UAT 결과 정리', '회의록 공유']) {
    const command = detectWorkChatCommand(`할 일 추가: ${title}`);
    if (command === null) throw new Error('no command');
    await desk.handle(command, owner);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('anchored to-do commands keep their replies and only gain receipts (A6-D6)', () => {
  it('receipts are attached only with actionReceipts; the text is identical either way', async () => {
    const on = world(true);
    const off = world(false);
    const add = detectWorkChatCommand('할 일 추가: 보고서 쓰기');
    if (add === null) throw new Error('no command');
    const a = await on.desk.handle(add, owner);
    const b = await off.desk.handle(add, owner);
    expect(text(a)).toBe(text(b));
    // A6-D2 amendment (2026-10-16): without a fresh listing the anchored add (whose reply shows no number) carries no
    // label, so it never becomes a one-item listing that would stop the live numbering of the next "N번 완료".
    expect(a).toMatchObject({ action: { entryId: 'todo.add', result: 'executed', source: 'todo', undoable: true } });
    expect((a as { action: { label?: number } }).action.label).toBeUndefined();
    expect(b).not.toHaveProperty('action');
    const list = detectWorkChatCommand('내 할 일 보여줘');
    if (list === null) throw new Error('no command');
    expect(await on.desk.handle(list, owner)).toMatchObject({ listing: { source: 'todo', items: [{ label: 1 }] } });
    expect(await off.desk.handle(list, owner)).not.toHaveProperty('listing');
  });
});

describe('A6 to-do actions (A6-D1/D3)', () => {
  it('todo.add echoes the number and the exact title with the undo hint', async () => {
    const { desk } = world();
    await addThree(desk);
    const outcome = await desk.handleAction(cmd('todo.add', { title: 'UAT 결과 보고' }), owner);
    expect(text(outcome)).toBe('할 일 4번으로 추가했어요: "UAT 결과 보고" · 되돌리기: "되돌려줘" (10분)');
    expect(outcome).toMatchObject({ action: { entryId: 'todo.add', result: 'executed', label: 4 } });
  });

  it('todo.complete by the resolved id; the execution-time check refuses an item that is no longer open', async () => {
    const { desk, rows } = world();
    await addThree(desk);
    const second = [...rows.values()].find((item) => item.title === 'UAT 결과 정리') as WorkItem;
    const done = await desk.handleAction(cmd('todo.complete', { ref: '#2' }, { target: { source: 'todo', id: second.id, label: 2 } }), owner);
    expect(text(done)).toBe('할 일 2번을 완료 처리했어요: "UAT 결과 정리" · 되돌리기: "되돌려줘" (10분)');
    expect(rows.get(second.id)?.status).toBe(WorkItemStatus.COMPLETED);
    const again = await desk.handleAction(cmd('todo.complete', { ref: '#2' }, { target: { source: 'todo', id: second.id, label: 2 } }), owner);
    expect(again).toMatchObject({ action: { result: 'refused', reason: 'already-final' } });
  });

  it('todo.cancel says "목록에서 뺐어요" (record decision 3) and stays CANCELED internally', async () => {
    const { desk, rows } = world();
    await addThree(desk);
    const first = [...rows.values()][0] as WorkItem;
    const out = await desk.handleAction(cmd('todo.cancel', { ref: '#1' }, { target: { source: 'todo', id: first.id, label: 1 } }), owner);
    expect(text(out)).toContain('할 일 1번을 목록에서 뺐어요');
    expect(rows.get(first.id)?.status).toBe(WorkItemStatus.CANCELED);
  });

  it('match: exactly one open title acts; several ask with their own numbers; none refuses', async () => {
    const { desk } = world();
    await addThree(desk);
    expect(await desk.handleAction(cmd('todo.complete', { match: '회의록 공유' }), owner)).toMatchObject({ action: { result: 'executed', label: 3 } });
    expect(await desk.handleAction(cmd('todo.complete', { match: '없는 일' }), owner)).toMatchObject({ action: { result: 'refused' } });
    await desk.handleAction(cmd('todo.add', { title: '보고서 쓰기' }), owner);
    expect(await desk.handleAction(cmd('todo.complete', { match: '보고서 쓰기' }), owner)).toMatchObject({ action: { result: 'asked', candidates: [{ label: 1 }, { label: 3 }] } });
  });
});

describe('per-action inverses (ratification record A)', () => {
  it('todo.add → cancel that to-do; already final → said plainly', async () => {
    const { desk, rows } = world();
    const added = await desk.handleAction(cmd('todo.add', { title: '새 일' }), owner);
    const id = (added as { action: { itemId: string } }).action.itemId;
    const undo = await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id }, undo: { entryId: 'todo.add' } }), owner);
    expect(text(undo)).toBe('방금 추가한 할 일을 취소했어요: "새 일"');
    expect(undo).toMatchObject({ action: { result: 'undone', undoOf: 'todo.add', undoable: false } });
    expect(rows.get(id)?.status).toBe(WorkItemStatus.CANCELED);
    const again = await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id }, undo: { entryId: 'todo.add' } }), owner);
    expect(text(again)).toBe('이미 완료/취소된 할 일이라 되돌릴 게 없어요.');
  });

  it('todo.complete / todo.cancel → reopen the SAME item (same id), in its original place; changed since → refused', async () => {
    for (const entryId of ['todo.complete', 'todo.cancel'] as const) {
      const { desk, rows } = world();
      await addThree(desk);
      const first = [...rows.values()][0] as WorkItem;
      const done = await desk.handleAction(cmd(entryId, { ref: '#1' }, { target: { source: 'todo', id: first.id, label: 1 } }), owner);
      const version = (done as { action: { version: string } }).action.version;
      const stale = await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id: first.id }, undo: { entryId, version: '2000-01-01T00:00:00.000Z' } }), owner);
      expect(stale).toMatchObject({ action: { result: 'refused', reason: 'changed' } });
      const undo = await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id: first.id }, undo: { entryId, version } }), owner);
      expect(text(undo)).toBe('할 일 1번을 다시 열었어요: "보고서 쓰기"');
      expect(rows.get(first.id)).toMatchObject({ id: first.id, status: WorkItemStatus.ACTIVE });
      const twice = await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id: first.id }, undo: { entryId, version } }), owner);
      expect(twice).toMatchObject({ action: { result: 'refused' } });
    }
  });

  it('another actor\'s item is never touched', async () => {
    const { desk } = world();
    const added = await desk.handleAction(cmd('todo.add', { title: '남의 일' }), owner);
    const id = (added as { action: { itemId: string } }).action.itemId;
    const other: Actor = { ...owner, id: 'someone-else' };
    expect(await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id }, undo: { entryId: 'todo.add' } }), other)).toMatchObject({ action: { result: 'refused', reason: 'not-found' } });
    expect(await desk.handleAction(cmd('todo.complete', { ref: '#1' }, { target: { source: 'todo', id, label: 1 } }), other)).toMatchObject({ action: { result: 'refused' } });
  });
});

describe('the to-do listing receipt is capped at the rows certainly rendered (P3a)', () => {
  it('records every row of a short list and fewer than shown never more for long titles; an empty list clears', async () => {
    const { desk } = world();
    await addThree(desk);
    const list = detectWorkChatCommand('내 할 일 보여줘');
    if (list === null) throw new Error('no command');
    expect(await desk.handle(list, owner)).toMatchObject({ listing: { items: [{ label: 1 }, { label: 2 }, { label: 3 }] } });
    const long = Array.from({ length: 15 }, (_, i) => ({ id: `w${i}`, actorId: 'o', title: '가'.repeat(80), resourceRefs: [], status: WorkItemStatus.ACTIVE, origin: 'conversation' as const, createdAt: 'x', updatedAt: 'x' }));
    expect(renderedTodoRows(long)).toBeLessThan(15);
    expect(renderedTodoRows(long.slice(0, 3))).toBe(3);
    const empty = world();
    expect(await empty.desk.handle(list, owner)).toMatchObject({ listing: { source: 'todo', items: [] } });
  });
});


describe('the kill switch is atomic with every to-do write (Codex round 3, A6-D3)', () => {
  const condition = { actionSwitchOf: owner.id };
  type Step = (desk: WorkChatService, rows: Map<string, WorkItem>) => Promise<WorkChatOutcome>;
  const first = (rows: Map<string, WorkItem>) => [...rows.values()].find((item) => item.title === '보고서 쓰기') as WorkItem;
  const cases: Array<[string, Step | null, Step]> = [
    ['add', null, (desk) => desk.handleAction(cmd('todo.add', { title: '새 일' }), owner, condition)],
    ['complete', null, (desk, rows) => desk.handleAction(cmd('todo.complete', { ref: '#1' }, { target: { source: 'todo', id: first(rows).id, label: 1 } }), owner, condition)],
    ['cancel', null, (desk, rows) => desk.handleAction(cmd('todo.cancel', { ref: '#1' }, { target: { source: 'todo', id: first(rows).id, label: 1 } }), owner, condition)],
    ['undo add (cancel)', null, (desk, rows) => desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id: first(rows).id }, undo: { entryId: 'todo.add' } }), owner, condition)],
    [
      'undo complete (reopen)',
      (desk, rows) => desk.handleAction(cmd('todo.complete', { ref: '#1' }, { target: { source: 'todo', id: first(rows).id, label: 1 } }), owner),
      (desk, rows) => desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id: first(rows).id }, undo: { entryId: 'todo.complete', version: first(rows).updatedAt } }), owner, condition),
    ],
  ];

  it.each(cases)('%s: a stop persisted at ANY await point before the write means nothing is written', async (_name, prepare, act) => {
    // Count the await points of an unstopped run up to and including the write, then stop at each one in turn.
    let awaits = 0;
    let writeAt = 0;
    const probe = world(true, (point) => {
      awaits += 1;
      if (point === 'write') writeAt = awaits;
    });
    await addThree(probe.desk);
    if (prepare) await prepare(probe.desk, probe.rows);
    awaits = 0;
    writeAt = 0;
    await act(probe.desk, probe.rows);
    const points = writeAt;
    expect(points).toBeGreaterThan(0);
    for (let stopAt = 1; stopAt <= points; stopAt += 1) {
      let count = 0;
      let armed = false;
      const w = world(true, () => {
        if (!armed) return;
        count += 1;
        if (count === stopAt) w.actor.metadata = { 'quoky.actionSwitch': { state: 'stopped', at: 'x' } };
      });
      await addThree(w.desk);
      if (prepare) await prepare(w.desk, w.rows);
      const before = [...w.rows.values()].map((item) => `${item.id}:${item.status}`).join(',');
      armed = true;
      const outcome = await act(w.desk, w.rows);
      expect(outcome, `stop at await ${stopAt}/${points}`).toMatchObject({ action: { reason: 'stopped' } });
      expect([...w.rows.values()].map((item) => `${item.id}:${item.status}`).join(','), `stop at await ${stopAt}`).toBe(before);
    }
  });
});

describe('CA P3: fail closed without an atomic store, and the stopped reply follows the turn language', () => {
  it('a store without saveIf never takes a conditioned write; unconditioned writes still work', async () => {
    const rows = new Map<string, WorkItem>();
    const storage = {
      actors: { get: async () => ({ ...owner, metadata: {} }) },
      workItems: {
        get: async (id: string) => rows.get(id) ?? null,
        save: async (item: WorkItem) => {
          rows.set(item.id, item);
          return item;
        },
        listByActor: async () => [...rows.values()],
        listByResource: async () => [],
      },
    } as unknown as StorageProvider;
    const work = new WorkManager(storage);
    await expect(work.create({ actorId: owner.id, title: '조건부' }, { actionSwitchOf: owner.id })).rejects.toBeInstanceOf(ActionWriteStoppedError);
    expect(rows.size).toBe(0);
    await work.create({ actorId: owner.id, title: '조건 없음' });
    expect(rows.size).toBe(1);
  });

  it('English turn → English stopped reply', async () => {
    const w = world();
    w.actor.metadata = { 'quoky.actionSwitch': { state: 'stopped', at: 'x' } };
    expect(text(await w.desk.handleAction(cmd('todo.add', { title: 'report' }, { language: 'en' }), owner, { actionSwitchOf: owner.id }))).toBe(
      'Natural-language actions are stopped, so I did nothing. Exact commands still work.',
    );
  });
});


// ADR-0120 amendment A6-D2 amendment note (2026-10-16): the deterministic numbered grammar ("N번 완료", "할 일 N번 취소",
// "완료 처리: N", "할 일 N번에 … 연결") resolves N against the owner's fresh to-do listing by item id, never the live order.
describe('numbered to-do commands resolve against the fresh listing snapshot (A6-D2 amendment)', () => {
  const NOW = '2026-10-16T00:00:00.000Z';
  const say = async (desk: WorkChatService, phrase: string, todoListing?: ListingSlot): Promise<WorkChatOutcome> => {
    const command = detectWorkChatCommand(phrase);
    if (command === null) throw new Error(`no command: ${phrase}`);
    return desk.handle(command, owner, todoListing === undefined ? {} : { todoListing });
  };
  /** "내 할 일 보여줘" → the slot the runtime would persist from the listing receipt. */
  const listed = async (desk: WorkChatService): Promise<ListingSlot> => {
    const outcome = await say(desk, '내 할 일 보여줘');
    const items = (outcome as { listing?: { items: ListingSlot['items'] } }).listing?.items;
    if (items === undefined) throw new Error('no listing receipt');
    return { source: 'todo', at: NOW, items };
  };
  const byTitle = (rows: Map<string, WorkItem>, title: string) => [...rows.values()].find((item) => item.title === title) as WorkItem;
  const statuses = (rows: Map<string, WorkItem>) => Object.fromEntries([...rows.values()].map((item) => [item.title, item.status]));

  it('drift by completion: after 1 is completed elsewhere, "2번 완료" completes the SHOWN 2 (not today\'s 2) and keeps label 2', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    await work.transition(byTitle(rows, '보고서 쓰기').id, WorkItemStatus.COMPLETED);
    const outcome = await say(desk, '2번 완료', snapshot);
    expect(text(outcome)).toBe('할 일을 완료 처리했어요: "UAT 결과 정리"');
    expect(statuses(rows)).toEqual({ '보고서 쓰기': 'COMPLETED', 'UAT 결과 정리': 'COMPLETED', '회의록 공유': 'ACTIVE' });
    expect(outcome).toMatchObject({ action: { entryId: 'todo.complete', itemId: byTitle(rows, 'UAT 결과 정리').id, label: 2 } });
    // Every anchored numbered form follows the same rule.
    const again = world();
    await addThree(again.desk);
    const shown = await listed(again.desk);
    await again.work.transition(byTitle(again.rows, '보고서 쓰기').id, WorkItemStatus.CANCELED);
    expect(text(await say(again.desk, '할 일 2번 취소', shown))).toBe('할 일을 취소했어요: "UAT 결과 정리"');
    expect(text(await say(again.desk, '완료 처리: 3', shown))).toBe('할 일을 완료 처리했어요: "회의록 공유"');
  });

  it('drift by an add: a number the listing never showed is refused with the current list, never the live item', async () => {
    const { desk, rows } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    await desk.handleAction(cmd('todo.add', { title: '새로 생긴 일' }), owner);
    const outcome = await say(desk, '4번 완료', snapshot);
    expect(text(outcome)).toBe(
      [
        '아까 보여드린 할 일 목록에는 4번이 없어서 아무것도 바꾸지 않았어요.',
        '지금 열린 할 일이에요 (4건). 번호를 확인하고 다시 보내 주세요.',
        '1. 보고서 쓰기',
        '2. UAT 결과 정리',
        '3. 회의록 공유',
        '4. 새로 생긴 일',
      ].join('\n'),
    );
    expect(Object.values(statuses(rows)).every((status) => status === 'ACTIVE')).toBe(true);
    // The refusal shows the current list, so it becomes the next listing.
    expect(outcome).toMatchObject({ listing: { source: 'todo', items: [{ label: 1 }, { label: 2 }, { label: 3 }, { label: 4, id: byTitle(rows, '새로 생긴 일').id }] } });
    expect(outcome).not.toHaveProperty('action');
  });

  it('gone: the shown item was canceled since → nothing changes; the reply names it and shows the current list', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    await work.transition(byTitle(rows, 'UAT 결과 정리').id, WorkItemStatus.CANCELED);
    const before = JSON.stringify(statuses(rows));
    const outcome = await say(desk, '2번 완료', snapshot);
    expect(text(outcome)).toBe(
      [
        '아까 보여드린 할 일 목록의 2번 "UAT 결과 정리"는 이미 취소된 할 일이라 아무것도 바꾸지 않았어요.',
        '지금 열린 할 일이에요 (2건). 번호를 확인하고 다시 보내 주세요.',
        '1. 보고서 쓰기',
        '2. 회의록 공유',
      ].join('\n'),
    );
    expect(JSON.stringify(statuses(rows))).toBe(before);
    expect(outcome).toMatchObject({ listing: { items: [{ label: 1, id: byTitle(rows, '보고서 쓰기').id }, { label: 2, id: byTitle(rows, '회의록 공유').id }] } });
    // A completed item says so; an id that no longer exists (or is not the actor's) is never named.
    await work.transition(byTitle(rows, '보고서 쓰기').id, WorkItemStatus.COMPLETED);
    expect(text(await say(desk, '할 일 1번 취소', snapshot))).toContain('1번 "보고서 쓰기"는 이미 완료된 할 일이라');
    const ghost: ListingSlot = { source: 'todo', at: NOW, items: [{ label: 1, id: 'no-such-id' }] };
    expect(text(await say(desk, '1번 완료', ghost))).toContain('아까 보여드린 할 일 목록의 1번은 지금 찾을 수 없어서 아무것도 바꾸지 않았어요.');
  });

  it('out of range: a number beyond the shown listing writes nothing (live has no such item either, or a different one)', async () => {
    const { desk, rows } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    for (const phrase of ['9번 완료', '할 일 9번 취소', '완료 처리: 9']) {
      expect(text(await say(desk, phrase, snapshot)), phrase).toContain('아까 보여드린 할 일 목록에는 9번이 없어서 아무것도 바꾸지 않았어요.');
    }
    expect(Object.values(statuses(rows)).every((status) => status === 'ACTIVE')).toBe(true);
  });

  it('the link form: "할 일 N번에 … 연결" follows the snapshot, and a drifted number links nothing', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    await work.transition(byTitle(rows, '보고서 쓰기').id, WorkItemStatus.COMPLETED);
    expect(text(await say(desk, '할 일 2번에 Jira PROJ-1 연결', snapshot))).toContain('할 일에 연결했어요: "UAT 결과 정리"');
    expect(byTitle(rows, 'UAT 결과 정리').resourceRefs.map((ref) => ref.identity)).toEqual(['jira:PROJ-1']);
    expect(byTitle(rows, '회의록 공유').resourceRefs).toEqual([]);
    const refused = await say(desk, '할 일 1번에 Jira PROJ-2 연결', snapshot);
    expect(text(refused)).toContain('1번 "보고서 쓰기"는 이미 완료된 할 일이라 아무것도 바꾸지 않았어요.');
    expect([...rows.values()].flatMap((item) => item.resourceRefs.map((ref) => ref.identity))).toEqual(['jira:PROJ-1']);
  });

  it('no fresh listing (never listed, or expired — the runtime passes none): N is the live number, and the reply echoes the title', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    await work.transition(byTitle(rows, '보고서 쓰기').id, WorkItemStatus.COMPLETED);
    const outcome = await say(desk, '2번 완료');
    expect(text(outcome)).toBe('할 일을 완료 처리했어요: "회의록 공유"');
    // No label: a live index is never written over (or into) a listing.
    expect(outcome).toMatchObject({ action: { entryId: 'todo.complete', itemId: byTitle(rows, '회의록 공유').id } });
    expect((outcome as { action: { label?: number } }).action.label).toBeUndefined();
    // With receipts off (QUOKY_NL_ACTIONS=off) a passed listing is ignored: exactly as before A6.
    const off = world(false);
    await addThree(off.desk);
    const stale: ListingSlot = { source: 'todo', at: NOW, items: [{ label: 1, id: 'gone' }] };
    expect(text(await say(off.desk, '1번 완료', stale))).toBe('할 일을 완료 처리했어요: "보고서 쓰기"');
  });

  it('undo: "되돌려줘" after a snapshot-resolved completion reopens the SAME item id in its original place', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    await work.transition(byTitle(rows, '보고서 쓰기').id, WorkItemStatus.COMPLETED);
    const done = await say(desk, '2번 완료', snapshot);
    const action = (done as { action: { itemId: string; version: string } }).action;
    const target = byTitle(rows, 'UAT 결과 정리');
    expect(action.itemId).toBe(target.id);
    const undo = await desk.handleAction(cmd('action.undo', {}, { target: { source: 'todo', id: action.itemId }, undo: { entryId: 'todo.complete', version: action.version } }), owner);
    expect(text(undo)).toBe('할 일 1번을 다시 열었어요: "UAT 결과 정리"');
    expect(rows.get(target.id)).toMatchObject({ id: target.id, status: WorkItemStatus.ACTIVE, createdAt: target.createdAt });
    expect([...rows.values()].filter((item) => item.title === 'UAT 결과 정리')).toHaveLength(1);
  });

  it('snapshot-label regression (S4): recording a deterministic receipt never changes which item a shown label names', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    const ids = snapshot.items.map((item) => item.id);
    let record: unknown = withLabelledListing(undefined, owner.id, 'todo', snapshot.items, NOW, 'listing');
    // What the runtime does with a receipt (nl-selection-service `recordReceipt`): merge the echo label, if any.
    const merge = (outcome: WorkChatOutcome) => {
      const action = (outcome as { action?: { label?: number; itemId?: string } }).action;
      if (action?.label !== undefined && action.itemId !== undefined) {
        record = withLabelledListing(record, owner.id, 'todo', [{ label: action.label, id: action.itemId }], NOW, 'merge');
      }
    };
    await work.transition(ids[0] as string, WorkItemStatus.COMPLETED);
    merge(await say(desk, '2번 완료', snapshot));
    // A deterministic add after the list changed: its live number 2 would rename a shown label, so it carries none.
    const added = await say(desk, '할 일 추가: 늦게 온 일', snapshot);
    expect((added as { action: { label?: number } }).action.label).toBeUndefined();
    merge(added);
    const labels = readListingRecord(record, owner.id, NOW).slots.todo?.items;
    expect(labels).toEqual([{ label: 1, id: ids[0] }, { label: 2, id: ids[1] }, { label: 3, id: ids[2] }]);
    expect(rows.get(ids[2] as string)?.status).toBe(WorkItemStatus.ACTIVE);
    // An add that does not collide extends the listing with its live number, so "4번 완료" then names it.
    const fresh = world();
    await addThree(fresh.desk);
    const shown = await listed(fresh.desk);
    const extended = await say(fresh.desk, '할 일 추가: 넷째 일', shown);
    expect(extended).toMatchObject({ action: { label: 4 } });
  });

  it('read-only hints name only a number the numbered command resolves to the same item', async () => {
    const { desk, rows, work } = world();
    await addThree(desk);
    const snapshot = await listed(desk);
    await work.transition(byTitle(rows, '보고서 쓰기').id, WorkItemStatus.COMPLETED);
    // By title: the shown number (3), not the live one (2).
    expect(text(await say(desk, '회의록 공유 완료', snapshot))).toBe('"회의록 공유" 할 일을 완료 처리하려면 "완료 처리: 3"라고 보내 주세요. 아직 아무것도 바꾸지 않았어요.');
    expect(text(await say(desk, '회의록 공유 완료했나?', snapshot))).toBe('"회의록 공유"는 아직 열린 할 일이에요 (3번). 완료하려면 "완료 처리: 3"라고 보내 주세요.');
    // By number: the shown item; a shown item that is no longer open falls through.
    expect(text(await say(desk, '2번 할 일 완료됐어?', snapshot))).toContain('"UAT 결과 정리"는 아직 열린 할 일이에요 (2번)');
    expect(await say(desk, '1번 할 일 완료됐어?', snapshot)).toEqual({ kind: 'none' });
    // An open item the listing does not show: no number is named.
    await desk.handleAction(cmd('todo.add', { title: '목록 밖 일' }), owner);
    expect(text(await say(desk, '목록 밖 일 완료', snapshot))).toBe(
      '"목록 밖 일" 할 일을 완료 처리하려면 "내 할 일"로 번호를 확인한 뒤 "완료 처리: 번호"라고 보내 주세요. 아직 아무것도 바꾸지 않았어요.',
    );
    expect(Object.values(statuses(rows)).filter((status) => status !== 'ACTIVE')).toEqual(['COMPLETED']);
  });
});
