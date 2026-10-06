import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogFields, Logger, NotificationSink, NotificationSinkOutcome, OwnerNotification } from '@quoky/core';
import type { BackupJobTimers } from './backup-job';
import { OPS_NOTICE_TEXT, type OpsNoticeLedgerStore } from './ops-notice';
import { createOpsRuntime, type OpsRuntimeInput } from './ops-runtime';

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

  it('no notice for a normal start, nor outside the launcher', async () => {
    runtime({ launcher: 'launchd', recentStarts: 2 }, { QUOKY_BACKUP_ENABLED: 'false' }).start();
    runtime({ recentStarts: 0 }).start();
    await settle();
    expect(sink.delivered).toEqual([]);
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
});
