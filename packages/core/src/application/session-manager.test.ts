import { describe, expect, it } from 'vitest';
import { SessionStatus } from '../domain';
import type { ConversationContext, Session } from '../domain';
import type { StorageProvider } from '../ports';
import { SessionManager } from './session-manager';

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
});
