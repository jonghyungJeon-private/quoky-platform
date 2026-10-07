import { describe, expect, it } from 'vitest';
import { SessionStatus } from '../domain';
import type { ConversationContext, Session } from '../domain';
import type { StorageProvider } from '../ports';
import { SessionManager } from './session-manager';
import { SessionWriteLock } from './session-write-lock';

const CTX: ConversationContext = { platform: 'test', channelId: 'chan-1', userId: 'u1' };

/** In-memory SessionRepository honoring the port contract: findActiveByContext returns ACTIVE sessions only. */
function storageWithSessions() {
  const rows = new Map<string, Session>();
  const saves: Session[] = [];
  const sessions = {
    async save(s: Session) {
      saves.push(s);
      rows.set(s.id, { ...s });
      return s;
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async findActiveByContext(channelId: string, threadId?: string) {
      return (
        [...rows.values()].find(
          (s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId && s.context.threadId === threadId,
        ) ?? null
      );
    },
  };
  return { storage: { sessions } as unknown as StorageProvider, rows, saves };
}

describe('SessionManager', () => {
  it('reuses the active session for the same context', async () => {
    const { storage } = storageWithSessions();
    const manager = new SessionManager(storage);
    const first = await manager.openForContext(CTX, 'actor-1');
    const again = await manager.openForContext(CTX, 'actor-1');
    expect(again.id).toBe(first.id);
    expect(first.status).toBe(SessionStatus.ACTIVE);
  });

  it('close() saves the session as CLOSED through the existing repository, keeping its other fields', async () => {
    const { storage, rows, saves } = storageWithSessions();
    const manager = new SessionManager(storage);
    const opened = await manager.openForContext(CTX, 'actor-1');
    const withTask = { ...opened, activeTaskId: 'task-1', activeProjectId: 'proj-1' };
    const closed = await manager.close(withTask);
    expect(closed.status).toBe(SessionStatus.CLOSED);
    expect(saves.at(-1)).toBe(closed);
    expect(rows.get(opened.id)).toMatchObject({
      id: opened.id,
      status: SessionStatus.CLOSED,
      actorId: 'actor-1',
      activeTaskId: 'task-1',
      activeProjectId: 'proj-1',
    });
  });

  it('after close(), the next openForContext opens a NEW active session (ADR-0093 reset)', async () => {
    const { storage } = storageWithSessions();
    const manager = new SessionManager(storage);
    const opened = await manager.openForContext(CTX, 'actor-1');
    await manager.close(opened);
    const next = await manager.openForContext(CTX, 'actor-1');
    expect(next.id).not.toBe(opened.id);
    expect(next.status).toBe(SessionStatus.ACTIVE);
    expect(next.activeTaskId).toBeUndefined();
  });

  describe('updateMetadataEntry (ADR-0092 amendment, runtime switching; ADR-0113 D7 field-scoped saves)', () => {
    it('changes only its own metadata key on the LIVE row, keeping every other field and key', async () => {
      const { storage, rows } = storageWithSessions();
      const manager = new SessionManager(storage);
      const opened = await manager.openForContext(CTX, 'actor-1');
      rows.set(opened.id, { ...opened, activeTaskId: 'task-live', metadata: { other: 1 } });
      // The caller's copy is stale (no task, no metadata): it is never written back.
      const saved = await manager.updateMetadataEntry(opened, 'quoky.providerSelection', () => ({ chat: { provider: 'codex' } }));
      expect(saved).not.toBeNull();
      expect(rows.get(opened.id)).toMatchObject({
        activeTaskId: 'task-live',
        metadata: { other: 1, 'quoky.providerSelection': { chat: { provider: 'codex' } } },
      });
      // `undefined` removes the key; an emptied metadata object is dropped.
      await manager.updateMetadataEntry(opened, 'quoky.providerSelection', () => undefined);
      expect(rows.get(opened.id)?.metadata).toEqual({ other: 1 });
      await manager.updateMetadataEntry(opened, 'other', () => undefined);
      expect(rows.get(opened.id)?.metadata).toBeUndefined();
    });

    it('passes the live value to the update and leaves a gone or CLOSED session untouched', async () => {
      const { storage, rows, saves } = storageWithSessions();
      const manager = new SessionManager(storage);
      const opened = await manager.openForContext(CTX, 'actor-1');
      await manager.updateMetadataEntry(opened, 'k', () => ({ n: 1 }));
      const seen: unknown[] = [];
      await manager.updateMetadataEntry(opened, 'k', (current) => {
        seen.push(current);
        return { n: 2 };
      });
      expect(seen).toEqual([{ n: 1 }]);
      await manager.close(opened);
      const before = saves.length;
      expect(await manager.updateMetadataEntry(opened, 'k', () => ({ n: 3 }))).toBeNull();
      expect(await manager.updateMetadataEntry({ id: 'missing' }, 'k', () => ({ n: 3 }))).toBeNull();
      expect(saves.length).toBe(before);
      expect(rows.get(opened.id)?.status).toBe(SessionStatus.CLOSED);
    });

    it('runs under the shared session write lock: a concurrent touch and metadata write never lose each other', async () => {
      const { storage, rows } = storageWithSessions();
      const lock = new SessionWriteLock();
      const manager = new SessionManager(storage, lock);
      const opened = await manager.openForContext(CTX, 'actor-1');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      // Hold the session lock (as another writer would), then queue both writes behind it.
      const holder = lock.run(opened.id, async () => gate);
      const metadataWrite = manager.updateMetadataEntry(opened, 'quoky.providerSelection', () => ({ image: 'off' }));
      const touch = manager.touch(opened);
      await Promise.resolve();
      expect(rows.get(opened.id)?.metadata).toBeUndefined(); // still queued behind the holder
      release();
      await Promise.all([holder, metadataWrite, touch]);
      const live = rows.get(opened.id);
      expect(live?.metadata).toEqual({ 'quoky.providerSelection': { image: 'off' } });
      expect(live?.lastActivityAt).toBeDefined();
    });
  });
});

