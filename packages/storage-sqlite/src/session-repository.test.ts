import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStatus } from '@quoky/core';
import type { Session } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function freshStore(): Promise<SqliteStorageProvider> {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-sessions-'));
  dirs.push(dir);
  const store = new SqliteStorageProvider({ dbPath: join(dir, 'quoky.db') });
  await store.init();
  return store;
}

const session: Session = {
  id: 's1',
  actorId: 'a1',
  context: { channelId: 'c1' },
  status: SessionStatus.ACTIVE,
  createdAt: '2026-06-29T00:00:00.000Z',
  lastActivityAt: '2026-06-29T00:00:00.000Z',
};

describe('SqliteSessionRepository', () => {
  it('a CLOSED session is terminal: a late save of a stale ACTIVE copy does not reopen it', async () => {
    const store = await freshStore();
    await store.sessions.save(session);
    await store.sessions.save({ ...session, status: SessionStatus.CLOSED });
    // a turn that started before the reset finishes and anchors an approval on its stale copy
    const result = await store.sessions.save({ ...session, activeTaskId: 't-late' });
    expect(result.status).toBe(SessionStatus.CLOSED);
    expect((await store.sessions.get('s1'))?.status).toBe(SessionStatus.CLOSED);
    expect((await store.sessions.get('s1'))?.activeTaskId).toBeUndefined();
    expect(await store.sessions.findActiveByContext('c1')).toBeNull();
    await store.close();
  });

  it('CLOSED protection is atomic: a stale ACTIVE save already in flight when reset writes CLOSED cannot reopen it', async () => {
    const store = await freshStore();
    await store.sessions.save(session);
    // A turn that loaded the session before the reset starts its (stale, ACTIVE) save but does not await it; the
    // reset's CLOSED write runs before that promise settles. A read-then-write guard read ACTIVE before the
    // reset and then wrote ACTIVE over CLOSED here.
    const stale = store.sessions.save({ ...session, activeTaskId: 't-late' });
    await store.sessions.save({ ...session, status: SessionStatus.CLOSED });
    await stale;
    expect((await store.sessions.get('s1'))?.status).toBe(SessionStatus.CLOSED);
    expect(await store.sessions.findActiveByContext('c1')).toBeNull();
    // and a stale ACTIVE save issued after the CLOSED write is refused by the same UPSERT
    const late = await store.sessions.save({ ...session, activeTaskId: 't-later' });
    expect(late.status).toBe(SessionStatus.CLOSED);
    expect((await store.sessions.get('s1'))?.activeTaskId).toBeUndefined();
    expect(await store.sessions.findActiveByContext('c1')).toBeNull();
    await store.close();
  });

  it('a CLOSED session can still be re-saved as CLOSED (e.g. a second reset)', async () => {
    const store = await freshStore();
    await store.sessions.save({ ...session, status: SessionStatus.CLOSED });
    await store.sessions.save({ ...session, status: SessionStatus.CLOSED, lastActivityAt: '2026-06-29T01:00:00.000Z' });
    expect((await store.sessions.get('s1'))?.lastActivityAt).toBe('2026-06-29T01:00:00.000Z');
    await store.close();
  });

  it('an ACTIVE session still saves and closes normally', async () => {
    const store = await freshStore();
    await store.sessions.save(session);
    await store.sessions.save({ ...session, activeTaskId: 't1' });
    expect((await store.sessions.findActiveByContext('c1'))?.activeTaskId).toBe('t1');
    await store.sessions.save({ ...session, status: SessionStatus.CLOSED });
    expect(await store.sessions.findActiveByContext('c1')).toBeNull();
    await store.close();
  });
});
