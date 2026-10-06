import { describe, expect, it } from 'vitest';
import type { LogFields, Logger, MemoryArchivePurgeResult } from '@quoky/core';
import type { BackupJobTimers } from './backup-job';
import { BACKUP_POLL_MS } from './backup-job';
import { MemoryArchivePurgeJob } from './memory-archive-purge';

// 2026-10-06 10:00 KST.
const T0 = Date.parse('2026-10-06T01:00:00.000Z');
const NEXT_0400_KST = Date.parse('2026-10-06T19:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  warn(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  error(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function job(purge: (now: string) => Promise<MemoryArchivePurgeResult>) {
  const timers = new Timers();
  const logger = new RecordingLogger();
  const purgeJob = new MemoryArchivePurgeJob({ purge, timeZone: 'Asia/Seoul', logger, clock: timers.now, timers });
  return { timers, logger, purgeJob };
}

describe('MemoryArchivePurgeJob (ADR-0106 amendment D2, SUB-2 daily maintenance)', () => {
  it('purges once at start, then daily at 04:00 local time, polling the wall clock at most every 15 minutes', async () => {
    const calls: string[] = [];
    const { timers, logger, purgeJob } = job(async (now) => {
      calls.push(now);
      return { purged: calls.length, failed: 0 };
    });
    purgeJob.start();
    purgeJob.start(); // idempotent
    await purgeJob.idle();
    await settle();
    expect(calls).toEqual([new Date(T0).toISOString()]);
    expect(purgeJob.nextScheduledAt).toBe(new Date(NEXT_0400_KST).toISOString());
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0]?.dueAt).toBe(T0 + BACKUP_POLL_MS);

    // Poll until the due instant; only then does the daily purge run.
    while (timers.clockMs < NEXT_0400_KST && timers.pending.length > 0) {
      timers.fireNext();
      await settle();
    }
    await purgeJob.idle();
    await settle();
    expect(calls).toEqual([new Date(T0).toISOString(), new Date(NEXT_0400_KST).toISOString()]);
    expect(purgeJob.nextScheduledAt).toBe(new Date(NEXT_0400_KST + DAY).toISOString());
    expect(logger.lines).toEqual([
      'memory_archive.purge.ran {"trigger":"startup","purged":1,"failed":0}',
      'memory_archive.purge.ran {"trigger":"daily","purged":2,"failed":0}',
    ]);
    await purgeJob.stop();
    expect(timers.pending).toEqual([]);
    expect(purgeJob.nextScheduledAt).toBeNull();
  });

  it('a failing purge is logged by error name only and the chain keeps going', async () => {
    let attempts = 0;
    const { timers, logger, purgeJob } = job(async () => {
      attempts += 1;
      throw new TypeError('database is locked: 커피는 아메리카노');
    });
    purgeJob.start();
    await purgeJob.idle();
    await settle();
    expect(attempts).toBe(1);
    expect(logger.lines).toEqual(['memory_archive.purge.failed {"trigger":"startup","errorName":"TypeError"}']);
    expect(logger.lines.join('\n')).not.toContain('커피');
    expect(timers.pending).toHaveLength(1);
    await purgeJob.stop();
  });

  it('stop before the start run finishes leaves no timer armed', async () => {
    let release: () => void = () => undefined;
    const { timers, purgeJob } = job(
      () => new Promise<MemoryArchivePurgeResult>((resolve) => (release = () => resolve({ purged: 0, failed: 0 }))),
    );
    purgeJob.start();
    const stopping = purgeJob.stop();
    release();
    await stopping;
    await settle();
    expect(timers.pending).toEqual([]);
  });
});
