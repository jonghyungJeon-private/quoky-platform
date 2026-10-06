import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger, MemoryArchivePurgeResult } from '@quoky/core';
import type { BackupJobTimers } from './backup-job';
import { BACKUP_POLL_MS } from './backup-job';
import { nextDailyBackupAt } from './backup-files';

/**
 * ADR-0106 amendment D2 (SUB-2 daily maintenance, ADR-0102): permanently deletes the memory-archive entries whose
 * `QUOKY_MEMORY_ARCHIVE_DAYS` retention has run out. It is its own non-overlapping, unref'd `setTimeout` chain beside
 * the backup chain — same shape, same 04:00 `QUOKY_TIMEZONE` schedule and 15-minute wall-clock poll (a sleeping Mac
 * catches up on waking) — so it runs whether or not backups are enabled and whatever the backup's outcome. It also
 * runs once at start. It reaches only the purge callback (`MemoryCommandService.purgeExpiredArchive`) and logs
 * counts only, never memory content.
 */

export interface MemoryArchivePurgeJobDeps {
  /** Deletes every archive entry expired at `now`; must not reject (a rejection is logged and the chain goes on). */
  readonly purge: (now: IsoTimestamp) => Promise<MemoryArchivePurgeResult>;
  /** `QUOKY_TIMEZONE`: the 04:00 daily run. */
  readonly timeZone: string;
  readonly logger: Logger;
  readonly clock?: () => IsoTimestamp;
  readonly timers?: BackupJobTimers;
}

const nodeTimers: BackupJobTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class MemoryArchivePurgeJob {
  private running = false;
  private timer: unknown = undefined;
  private dueMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly clock: () => IsoTimestamp;
  private readonly timers: BackupJobTimers;

  constructor(private readonly deps: MemoryArchivePurgeJobDeps) {
    this.clock = deps.clock ?? sharedClock;
    this.timers = deps.timers ?? nodeTimers;
  }

  /** Run once now (not awaited by the caller's start) and arm the daily chain. Idempotent; never throws. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const nowMs = Date.parse(this.clock());
    this.dueMs = nextDailyBackupAt(nowMs, this.deps.timeZone);
    void this.runOnce('startup').then(() => this.arm(Date.parse(this.clock())));
  }

  /** Disarm the chain and wait for an in-flight run. Idempotent; never throws. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dueMs = null;
    const pending = this.inFlight;
    if (pending !== null) await pending.catch(() => undefined);
  }

  /** Resolves once no run is in flight (tests). */
  async idle(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight.catch(() => undefined);
  }

  get nextScheduledAt(): IsoTimestamp | null {
    return this.dueMs === null ? null : new Date(this.dueMs).toISOString();
  }

  private arm(nowMs: number): void {
    if (!this.running || this.dueMs === null || this.timer !== undefined) return;
    const delay = Math.max(1_000, Math.min(this.dueMs - nowMs, BACKUP_POLL_MS));
    const handle = this.timers.setTimeout(() => this.onTimer(), delay);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.timer = handle;
  }

  private onTimer(): void {
    this.timer = undefined;
    if (!this.running || this.dueMs === null) return;
    const nowMs = Date.parse(this.clock());
    if (nowMs < this.dueMs) {
      this.arm(nowMs);
      return;
    }
    void this.runOnce('daily').then(() => {
      if (!this.running) return;
      const after = Date.parse(this.clock());
      this.dueMs = nextDailyBackupAt(after, this.deps.timeZone);
      this.arm(after);
    });
  }

  /** One purge, single-flight. Never rejects. */
  private runOnce(trigger: 'startup' | 'daily'): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const work = (async () => {
      try {
        const result = await this.deps.purge(this.clock());
        this.deps.logger.info('memory_archive.purge.ran', { trigger, purged: result.purged, failed: result.failed });
      } catch (error) {
        this.deps.logger.warn('memory_archive.purge.failed', {
          trigger,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    })().finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    this.inFlight = work;
    return work;
  }
}
