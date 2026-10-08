import { describe, expect, it } from 'vitest';
import {
  BACKUP_RETENTION,
  backupFileName,
  isPartialBackupFileName,
  isPartialVectorSnapshotName,
  listBackupFiles,
  nextDailyBackupAt,
  parseBackupFileName,
  partialBackupKind,
  partialFileName,
  selectBackupsToKeep,
  vectorSnapshotDbName,
  vectorSnapshotName,
} from './backup-files';

const SEOUL = 'Asia/Seoul';

describe('backup file names (ADR-0102 D6)', () => {
  it('uses a UTC stamp and round-trips', () => {
    const at = Date.parse('2026-10-06T19:00:05.123Z');
    const name = backupFileName('daily', at);
    expect(name).toBe('quoky-20261006T190005Z-daily.db');
    expect(parseBackupFileName(name)).toEqual({ name, kind: 'daily', takenAtMs: Date.parse('2026-10-06T19:00:05Z') });
    expect(backupFileName('pre-migration', at)).toBe('quoky-20261006T190005Z-pre-migration.db');
  });

  it('recognises only its own names', () => {
    for (const foreign of [
      'quoky.db',
      'quoky-20261006T190005Z-daily.db.bak',
      'quoky-20261306T190005Z-daily.db', // month 13
      'quoky-20261006T190005Z-weekly.db',
      'xquoky-20261006T190005Z-daily.db',
      'backup-status.json',
      '.quoky-20261006T190005Z-daily.db.partial',
    ]) {
      expect(parseBackupFileName(foreign)).toBeUndefined();
    }
    const partial = partialFileName('quoky-20261006T190005Z-daily.db');
    expect(partial).toBe('.quoky-20261006T190005Z-daily.db.partial');
    expect(isPartialBackupFileName(partial)).toBe(true);
    expect(isPartialBackupFileName(`${partial}-journal`)).toBe(true);
    expect(isPartialBackupFileName('quoky-20261006T190005Z-daily.db')).toBe(false);
    expect(isPartialBackupFileName('.other.partial')).toBe(false);
  });
});

describe('manual copies and vector snapshot names', () => {
  it('names a manual copy and pairs every copy with a .vectors snapshot of the same stem', () => {
    const at = Date.parse('2026-10-07T03:04:05Z');
    const manual = backupFileName('manual', at);
    expect(manual).toBe('quoky-20261007T030405Z-manual.db');
    expect(parseBackupFileName(manual)).toEqual({ name: manual, kind: 'manual', takenAtMs: at });
    for (const kind of ['daily', 'pre-migration', 'manual'] as const) {
      const db = backupFileName(kind, at);
      const vectors = vectorSnapshotName(db);
      expect(vectors).toBe(db.replace(/\.db$/, '.vectors'));
      expect(vectorSnapshotDbName(vectors)).toBe(db);
      expect(isPartialVectorSnapshotName(partialFileName(vectors))).toBe(true);
      expect(partialBackupKind(partialFileName(vectors))).toBe(kind);
      expect(partialBackupKind(partialFileName(db))).toBe(kind);
      expect(partialBackupKind(`${partialFileName(db)}-wal`)).toBe(kind);
    }
    for (const foreign of ['vectors', 'quoky-20261007T030405Z-weekly.vectors', 'quoky-20261307T030405Z-daily.vectors', 'x.vectors']) {
      expect(vectorSnapshotDbName(foreign)).toBeUndefined();
    }
    expect(partialBackupKind('quoky-20261007T030405Z-daily.db')).toBeUndefined();
    expect(partialBackupKind('.other.partial')).toBeUndefined();
  });

  it('keeps the 5 newest manual copies, independently of the daily and pre-migration ones', () => {
    const manual = Array.from({ length: 7 }, (_, i) => backupFileName('manual', Date.parse('2026-10-07T00:00:00Z') - i * 3_600_000));
    const daily = [backupFileName('daily', Date.parse('2026-10-05T19:00:00Z'))];
    const pre = [backupFileName('pre-migration', Date.parse('2026-10-01T10:00:00Z'))];
    const keep = selectBackupsToKeep(listBackupFiles([...manual, ...daily, ...pre]), SEOUL);
    expect(BACKUP_RETENTION.manual).toBe(5);
    expect(manual.filter((name) => keep.has(name))).toEqual(manual.slice(0, 5));
    for (const name of [...daily, ...pre]) expect(keep.has(name)).toBe(true);
    // Manual copies never count as a day's or week's copy: the one daily copy is still kept.
    expect(keep.size).toBe(7);
  });
});

describe('retention: 7 daily + 4 weekly + 3 pre-migration', () => {
  /** One daily copy at 04:00 Seoul (19:00Z the day before) for `days` consecutive days ending 2026-10-06. */
  function dailyCopies(days: number): string[] {
    const last = Date.parse('2026-10-05T19:00:00Z'); // 2026-10-06 04:00 KST (a Tuesday)
    return Array.from({ length: days }, (_, i) => backupFileName('daily', last - i * 86_400_000));
  }

  it('keeps the newest copy of each of the 7 newest days and of each of the 4 newest weeks', () => {
    const names = dailyCopies(40);
    const keep = selectBackupsToKeep(listBackupFiles(names), SEOUL);
    // 7 days: 10-06 .. 09-30. Weeks (Monday start): 10-05 week (newest 10-06), 09-28 week (newest 10-04),
    // 09-21 week (newest 09-27), 09-14 week (newest 09-20). Daily copies already cover the first two.
    const expected = new Set([
      ...names.slice(0, BACKUP_RETENTION.dailyDays),
      backupFileName('daily', Date.parse('2026-09-26T19:00:00Z')), // 09-27 KST, Sunday
      backupFileName('daily', Date.parse('2026-09-19T19:00:00Z')), // 09-20 KST, Sunday
    ]);
    expect(keep).toEqual(expected);
  });

  it('keeps only the newest copy of a day that has several (catch-up + 04:00)', () => {
    const a = backupFileName('daily', Date.parse('2026-10-05T19:00:00Z')); // 10-06 04:00 KST
    const b = backupFileName('daily', Date.parse('2026-10-06T01:00:00Z')); // 10-06 10:00 KST
    const keep = selectBackupsToKeep(listBackupFiles([a, b]), SEOUL);
    expect([...keep]).toEqual([b]);
  });

  it('keeps the 3 newest pre-migration copies independently of the daily ones', () => {
    const pre = [1, 2, 3, 4].map((d) => backupFileName('pre-migration', Date.parse(`2026-10-0${d}T10:00:00Z`)));
    const daily = dailyCopies(2);
    const keep = selectBackupsToKeep(listBackupFiles([...pre, ...daily]), SEOUL);
    expect(keep.has(pre[0] as string)).toBe(false);
    for (const name of [...pre.slice(1), ...daily]) expect(keep.has(name)).toBe(true);
  });
});

describe('nextDailyBackupAt: 04:00 in QUOKY_TIMEZONE', () => {
  it('is today 04:00 before it and tomorrow 04:00 at/after it (Seoul)', () => {
    expect(new Date(nextDailyBackupAt(Date.parse('2026-10-05T18:59:00Z'), SEOUL)).toISOString()).toBe(
      '2026-10-05T19:00:00.000Z',
    );
    expect(new Date(nextDailyBackupAt(Date.parse('2026-10-05T19:00:00Z'), SEOUL)).toISOString()).toBe(
      '2026-10-06T19:00:00.000Z',
    );
  });

  it('follows the zone offset across a DST change (New York)', () => {
    // 2026-11-01 is the US fall-back day: 04:00 EST = 09:00Z (EDT was 08:00Z the day before).
    expect(new Date(nextDailyBackupAt(Date.parse('2026-10-31T09:00:00Z'), 'America/New_York')).toISOString()).toBe(
      '2026-11-01T09:00:00.000Z',
    );
    expect(new Date(nextDailyBackupAt(Date.parse('2026-10-30T12:00:00Z'), 'America/New_York')).toISOString()).toBe(
      '2026-10-31T08:00:00.000Z',
    );
  });
});
