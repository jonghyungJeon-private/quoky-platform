import { describe, expect, it } from 'vitest';
import { WorkItemStatus, type Actor, type WorkItem } from '../../domain';
import type { StorageProvider } from '../../ports';
import { plainTextOf } from '../message-rendering';
import type { NlSelectedCommand } from '../nl-routing/catalog';
import { WorkManager } from '../work-manager';
import { detectWorkChatCommand } from './work-chat-command';
import { renderedTodoRows } from './work-chat-renderer';
import { WorkChatService, type WorkChatOutcome } from './work-chat-service';

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
    expect(a).toMatchObject({ action: { entryId: 'todo.add', result: 'executed', source: 'todo', label: 1, undoable: true } });
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
