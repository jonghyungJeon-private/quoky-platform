import { addLocalDays, localDateOf, weekdayOf, zonedToUtc } from '@quoky/core';
import type { LocalDate } from '@quoky/core';

/**
 * Backup file naming, schedule arithmetic and retention (ADR-0102 D6). Pure: every instant is an input.
 *
 * Names (UTC stamp, so they sort chronologically and never depend on the zone):
 *   `quoky-20261006T190000Z-daily.db`          a scheduled copy
 *   `quoky-20261006T190000Z-pre-migration.db`  the copy taken before a startup migration
 *   `.quoky-20261006T190000Z-daily.db.partial` a copy being written / verified (never a restore candidate)
 * Pruning deletes only names these patterns match: nothing else in the directory is ever touched.
 *
 * Retention: the newest copy of each of the 7 most recent local days that have a daily copy, plus the newest copy of
 * each of the 4 most recent local weeks (Monday start) — "7 daily + 4 weekly" — and the 3 newest pre-migration
 * copies. The days and weeks are read in `QUOKY_TIMEZONE`.
 */

export type BackupKind = 'daily' | 'pre-migration';

export const BACKUP_RETENTION = { dailyDays: 7, weeklyWeeks: 4, preMigration: 3 } as const;
/** The daily copy runs at 04:00 in `QUOKY_TIMEZONE`. */
export const DAILY_BACKUP_LOCAL_TIME = { hour: 4, minute: 0 } as const;

const FINAL_NAME = /^quoky-(\d{8}T\d{6}Z)-(daily|pre-migration)\.db$/;
const PARTIAL_NAME = /^\.quoky-\d{8}T\d{6}Z-(?:daily|pre-migration)\.db\.partial(?:-journal|-wal|-shm)?$/;

export interface BackupFile {
  readonly name: string;
  readonly kind: BackupKind;
  readonly takenAtMs: number;
}

function stamp(epochMs: number): string {
  // 2026-10-06T19:00:00.000Z -> 20261006T190000Z
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function backupFileName(kind: BackupKind, epochMs: number): string {
  return `quoky-${stamp(epochMs)}-${kind}.db`;
}

export function partialFileName(finalName: string): string {
  return `.${finalName}.partial`;
}

export function parseBackupFileName(name: string): BackupFile | undefined {
  const match = FINAL_NAME.exec(name);
  if (match === null) return undefined;
  const s = match[1] as string;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  const takenAtMs = Date.parse(iso);
  if (!Number.isFinite(takenAtMs) || stamp(takenAtMs) !== s) return undefined;
  return { name, kind: match[2] as BackupKind, takenAtMs };
}

export function isPartialBackupFileName(name: string): boolean {
  return PARTIAL_NAME.test(name);
}

/** The job's own final copies among `names`, newest first. */
export function listBackupFiles(names: readonly string[]): BackupFile[] {
  return names
    .map(parseBackupFileName)
    .filter((f): f is BackupFile => f !== undefined)
    .sort((a, b) => b.takenAtMs - a.takenAtMs || (a.name < b.name ? 1 : -1));
}

function dayKey(date: LocalDate): string {
  return `${date.year}-${date.month}-${date.day}`;
}

function weekKey(date: LocalDate): string {
  // Monday-start week: step back to that week's Monday.
  return dayKey(addLocalDays(date, -((weekdayOf(date) + 6) % 7)));
}

/** Which of the job's copies retention keeps; everything else of the job's own (final) copies is pruned. */
export function selectBackupsToKeep(files: readonly BackupFile[], timeZone: string): Set<string> {
  const newestFirst = [...files].sort((a, b) => b.takenAtMs - a.takenAtMs);
  const keep = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  let preMigration = 0;
  for (const file of newestFirst) {
    if (file.kind === 'pre-migration') {
      if (preMigration < BACKUP_RETENTION.preMigration) keep.add(file.name);
      preMigration += 1;
      continue;
    }
    // Newest first, so the first copy seen for a day/week is that day's/week's newest.
    const date = localDateOf(file.takenAtMs, timeZone);
    const day = dayKey(date);
    if (!days.has(day)) {
      if (days.size < BACKUP_RETENTION.dailyDays) keep.add(file.name);
      days.add(day);
    }
    const week = weekKey(date);
    if (!weeks.has(week)) {
      if (weeks.size < BACKUP_RETENTION.weeklyWeeks) keep.add(file.name);
      weeks.add(week);
    }
  }
  return keep;
}

/** The next 04:00 in `timeZone` strictly after `nowMs` (a DST gap moves it forward, like reminders). */
export function nextDailyBackupAt(nowMs: number, timeZone: string): number {
  const today = localDateOf(nowMs, timeZone);
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = addLocalDays(today, offset);
    const due = zonedToUtc({ ...date, ...DAILY_BACKUP_LOCAL_TIME }, timeZone).epochMs;
    if (due > nowMs) return due;
  }
  // Unreachable for real zones; fall back to 24 hours.
  return nowMs + 86_400_000;
}
