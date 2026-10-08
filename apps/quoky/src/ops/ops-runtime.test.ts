import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogFields, Logger, NotificationSink, NotificationSinkOutcome, OwnerNotification } from '@quoky/core';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import type { BackupJobTimers } from './backup-job';
import { OPS_NOTICE_TEXT, type OpsNoticeLedgerStore } from './ops-notice';
import { createOpsRuntime, type OpsRuntimeInput } from './ops-runtime';
import { haltNoticeBuffer } from '../platform/platform-composition';

const OWNER = '111111111111111111';
const T0 = Date.parse('2026-10-06T01:00:00.000Z');

class QuietLogger implements Logger {
  readonly messages: string[] = [];
  info(message: string, _fields?: LogFields): void { this.messages.push(message); }
  warn(message: string, _fields?: LogFields): void { this.messages.push(message); }
  error(message: string, _fields?: LogFields): void { this.messages.push(message); }
}

class Timers implements BackupJobTimers {
  clockMs = T0;
  readonly pending: Array<{ callback: () => void; dueAt: number }> = [];
  setTimeout(callback: () => void, ms: number): unknown {
    const entry = { callback, dueAt: this.clockMs + ms };
    this.pending.push(entry);
    return entry;
  }
  clearTimeout(handle: unknown): void {
    const i = this.pending.indexOf(handle as never);
    if (i >= 0) this.pending.splice(i, 1);
  }
  fireNext(): void {
    this.pending.sort((a, b) => a.dueAt - b.dueAt);
    const next = this.pending.shift();
    if (next === undefined) return;
    this.clockMs = Math.max(this.clockMs, next.dueAt);
    next.callback();
  }
  now = (): string => new Date(this.clockMs).toISOString();
}

class Sink implements NotificationSink {
  readonly delivered: OwnerNotification[] = [];
  async deliver(n: OwnerNotification): Promise<NotificationSinkOutcome> {
    this.delivered.push(n);
    return { status: 'SENT', via: 'dm' };
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

describe('createOpsRuntime (ADR-0102 D6/D7 composition)', () => {
  let root: string;
  let sink: Sink;
  let timers: Timers;
  let ledgerContent: string | undefined;
  const ledger: OpsNoticeLedgerStore = { read: () => ledgerContent, write: (c) => { ledgerContent = c; } };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'quoky-ops-runtime-'));
    sink = new Sink();
    timers = new Timers();
    ledgerContent = undefined;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runtime(host: OpsRuntimeInput['config']['host'], env: NodeJS.ProcessEnv = {}, dbFile = 'quoky.db') {
    return createOpsRuntime({
      env,
      config: {
        storage: { dbPath: path.join(root, dbFile) },
        host,
        reminders: { enabled: true, channelDelivery: true, timeZone: 'Asia/Seoul' },
        discord: { ownerIds: [OWNER] },
      },
      sink,
      platform: 'discord',
      logger: new QuietLogger(),
      clock: timers.now,
      timers,
      ledger,
    });
  }

  it('a start after >=3 launcher-counted starts sends one CRASH_LOOP notice to the owner DM', async () => {
    const ops = runtime({ launcher: 'launchd', recentStarts: 3 }, { QUOKY_BACKUP_ENABLED: 'false' });
    ops.start();
    await settle();
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]).toMatchObject({ kind: 'BRIEF', text: OPS_NOTICE_TEXT.CRASH_LOOP, target: { userId: OWNER } });
    await ops.stop();
  });

  it('ADR-0114 (CA re-review P3-3): a Telegram halt sends one fixed OPS_NOTICE to the Discord owner DM, no content', async () => {
    const ops = runtime({ recentStarts: 0 }, { QUOKY_BACKUP_ENABLED: 'false' });
    ops.notifyTelegramHalt('TELEGRAM_POLL_CONFLICT');
    ops.notifyTelegramHalt('TELEGRAM_IDENTITY_UNVERIFIABLE'); // not a halt: nothing
    ops.notifyTelegramHalt('SOMETHING_ELSE');
    await settle();
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]).toMatchObject({
      kind: 'BRIEF',
      target: { platform: 'discord', userId: OWNER, channelId: '' },
      text: OPS_NOTICE_TEXT.TELEGRAM_POLL_CONFLICT,
    });
    expect(OPS_NOTICE_TEXT.TELEGRAM_POLL_CONFLICT).toContain('Telegram 연결을 멈췄어요: TELEGRAM_POLL_CONFLICT.');
    expect(OPS_NOTICE_TEXT.TELEGRAM_POLL_CONFLICT).toContain('같은 봇 토큰을 쓰는 다른 실행');
    for (const code of ['TELEGRAM_AUTH_REJECTED', 'TELEGRAM_IDENTITY_MISMATCH', 'TELEGRAM_POLL_LOOP_FAILED'] as const) {
      expect(OPS_NOTICE_TEXT[code]).toContain(`Telegram 연결을 멈췄어요: ${code}.`);
      expect(OPS_NOTICE_TEXT[code].length).toBeLessThan(1800);
    }
    // The ledger keeps the reason, so the OPS_NOTICE daily bound (3 per 24 h) also covers Telegram halts.
    expect(ledgerContent).toContain('TELEGRAM_POLL_CONFLICT');
    await ops.stop();
  });

  it('CA final check #3: a halt before Discord is READY is held and delivered once after release (no lost notice)', async () => {
    let ready = false;
    const attempts: string[] = [];
    sink.deliver = async (n) => {
      attempts.push(ready ? 'ready' : 'not-ready');
      if (!ready) return { status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true };
      sink.delivered.push(n);
      return { status: 'SENT', via: 'dm' };
    };
    const ops = runtime({ recentStarts: 0 }, { QUOKY_BACKUP_ENABLED: 'false' });
    const buffer = haltNoticeBuffer((code) => ops.notifyTelegramHalt(code));
    buffer.listener('TELEGRAM_AUTH_REJECTED');
    await settle();
    // Nothing tried before readiness: no NOT_CONNECTED attempt, no ledger slot taken.
    expect(attempts).toEqual([]);
    expect(ledgerContent).toBeUndefined();
    ready = true;
    buffer.release();
    await settle();
    expect(attempts).toEqual(['ready']);
    expect(sink.delivered.map((n) => n.text)).toEqual([OPS_NOTICE_TEXT.TELEGRAM_AUTH_REJECTED]);
    // After release a halt passes straight through.
    buffer.listener('TELEGRAM_POLL_CONFLICT');
    await settle();
    expect(sink.delivered).toHaveLength(2);
    await ops.stop();
  });

  it('control: without the buffer, a halt before readiness is NOT_CONNECTED and its ledger slot is spent', async () => {
    sink.deliver = async () => ({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true });
    const ops = runtime({ recentStarts: 0 }, { QUOKY_BACKUP_ENABLED: 'false' });
    ops.notifyTelegramHalt('TELEGRAM_AUTH_REJECTED');
    await settle();
    expect(ledgerContent).toContain('TELEGRAM_AUTH_REJECTED');
    await ops.stop();
  });

  it('no notice for a normal start, nor outside the launcher', async () => {
    runtime({ launcher: 'launchd', recentStarts: 2 }, { QUOKY_BACKUP_ENABLED: 'false' }).start();
    runtime({ recentStarts: 0 }).start();
    await settle();
    expect(sink.delivered).toEqual([]);
  });

  it('the memory-archive purge runs at start whether or not backups are enabled (ADR-0106 amendment D2)', async () => {
    const purges: string[] = [];
    const ops = createOpsRuntime({
      env: {},
      config: {
        storage: { dbPath: path.join(root, 'quoky.db') },
        host: { recentStarts: 0 },
        reminders: { enabled: true, channelDelivery: true, timeZone: 'Asia/Seoul' },
        discord: { ownerIds: [OWNER] },
      },
      sink,
      platform: 'discord',
      logger: new QuietLogger(),
      clock: timers.now,
      timers,
      ledger,
      memoryArchivePurge: async (now) => {
        purges.push(now);
        return { purged: 0, failed: 0 };
      },
    });
    ops.start();
    await settle();
    expect(ops.backupStatus()).toMatchObject({ enabled: false, state: 'DISABLED' });
    expect(purges).toEqual([new Date(T0).toISOString()]);
    // Only the purge chain is armed (backups are off), and stop() disarms it.
    expect(timers.pending).toHaveLength(1);
    await ops.stop();
    expect(timers.pending).toEqual([]);
  });

  it('outside the launcher backups are off by default: nothing is written', async () => {
    const ops = runtime({ recentStarts: 0 });
    await ops.ensurePreMigrationBackup();
    ops.start();
    expect(ops.backupStatus()).toMatchObject({ enabled: false, state: 'DISABLED', nextScheduledAt: null });
    expect(readdirSync(root)).toEqual([]);
    expect(timers.pending).toEqual([]);
  });

  it('a failed scheduled backup sends one BACKUP_FAILED notice', async () => {
    writeFileSync(path.join(root, 'broken.db'), 'not a sqlite database'.repeat(100));
    const ops = runtime({ launcher: 'launchd', recentStarts: 1 }, {}, 'broken.db');
    ops.start();
    expect(ops.backupStatus().enabled).toBe(true);
    // The catch-up copy is due 10 minutes after start (the only pending timer); then wait for its worker.
    timers.clockMs = T0 + 10 * 60 * 1000;
    timers.fireNext();
    for (let waited = 0; waited < 10_000 && ops.backupStatus().lastRun === null; waited += 20) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ops.backupStatus().lastRun).toMatchObject({ outcome: 'FAILED' });
    await settle();
    expect(sink.delivered.map((n) => n.text)).toEqual([OPS_NOTICE_TEXT.BACKUP_FAILED]);
    await ops.stop();
  });

  it('the scheduled copy includes the configured vector store (config.vector.storePath)', async () => {
    const storage = new SqliteStorageProvider({ dbPath: path.join(root, 'quoky.db') });
    await storage.init();
    await storage.close();
    const ops = createOpsRuntime({
      env: {},
      config: {
        storage: { dbPath: path.join(root, 'quoky.db') },
        vector: { storePath: path.join(root, 'vectors') },
        host: { launcher: 'launchd', recentStarts: 0 },
        reminders: { enabled: true, channelDelivery: true, timeZone: 'Asia/Seoul' },
        discord: { ownerIds: [OWNER] },
      },
      sink,
      platform: 'discord',
      logger: new QuietLogger(),
      clock: timers.now,
      timers,
      ledger,
    });
    ops.start();
    timers.clockMs = T0 + 10 * 60 * 1000;
    timers.fireNext();
    for (let waited = 0; waited < 10_000 && ops.backupStatus().lastRun === null; waited += 20) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // No vector store yet (semantic recall never wrote): an empty, verified snapshot.
    expect(ops.backupStatus().lastRun).toMatchObject({
      outcome: 'VERIFIED',
      vectors: { outcome: 'VERIFIED', storePresent: false, collections: 0, records: 0 },
    });
    expect(ops.backupStatus().retainedVectors).toHaveLength(1);
    await ops.stop();
  });
});
