import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../bootstrap-preflight';
import { QuokyExitCode, startupExitCode } from './exit-codes';
import { BackupErrorCode } from './backup-job';
import { OpsConfigErrorCode, loadOpsConfig } from './ops-config';

const HOST_DB = '/Users/owner/Library/Application Support/Quoky/quoky.db';

function failureOf(fn: () => unknown): { message: string; exit: number } {
  try {
    fn();
  } catch (err) {
    const report = describeStartupFailure(err);
    return { message: report.message, exit: startupExitCode(report) };
  }
  throw new Error('expected a failure');
}

describe('SUB-2 ops configuration (ADR-0102 D6)', () => {
  it('backs up by default under the launchd launcher, into <db dir>/backups, with the ledger beside the DB', () => {
    const config = loadOpsConfig({}, { dbPath: HOST_DB, launcher: 'launchd' });
    expect(config).toEqual({
      backup: { enabled: true, dbPath: HOST_DB, dir: '/Users/owner/Library/Application Support/Quoky/backups' },
      noticeLedgerPath: '/Users/owner/Library/Application Support/Quoky/ops/notice-ledger.json',
    });
  });

  it('is off by default outside the launcher (the delegated dev DB) and resolves a relative DB path from cwd', () => {
    const config = loadOpsConfig({}, { dbPath: './data/chunsik.db' }, '/repo');
    expect(config.backup).toEqual({ enabled: false, dbPath: '/repo/data/chunsik.db', dir: '/repo/data/backups' });
  });

  it('honours explicit QUOKY_BACKUP_ENABLED and QUOKY_BACKUP_DIR', () => {
    expect(loadOpsConfig({ QUOKY_BACKUP_ENABLED: 'true' }, { dbPath: '/d/q.db' }).backup.enabled).toBe(true);
    expect(loadOpsConfig({ QUOKY_BACKUP_ENABLED: 'false' }, { dbPath: '/d/q.db', launcher: 'launchd' }).backup.enabled).toBe(
      false,
    );
    expect(loadOpsConfig({ QUOKY_BACKUP_DIR: '/Volumes/External/quoky/' }, { dbPath: '/d/q.db' }).backup.dir).toBe(
      '/Volumes/External/quoky',
    );
  });

  it('carries the vector store path for the backup set (relative from cwd), and none when unset or empty', () => {
    expect(loadOpsConfig({}, { dbPath: HOST_DB, vectorPath: '/Users/owner/Library/Application Support/Quoky/vectors' }).backup.vectorPath).toBe(
      '/Users/owner/Library/Application Support/Quoky/vectors',
    );
    expect(loadOpsConfig({}, { dbPath: './data/chunsik.db', vectorPath: './data/vectors' }, '/repo').backup.vectorPath).toBe('/repo/data/vectors');
    expect(loadOpsConfig({}, { dbPath: HOST_DB }).backup.vectorPath).toBeUndefined();
    expect(loadOpsConfig({}, { dbPath: HOST_DB, vectorPath: '' }).backup.vectorPath).toBeUndefined();
  });

  it('never backs up an in-memory database', () => {
    expect(loadOpsConfig({ QUOKY_BACKUP_ENABLED: 'true' }, { dbPath: ':memory:', launcher: 'launchd' }).backup.enabled).toBe(
      false,
    );
  });

  it('refuses invalid values with value-free configuration codes (exit 78)', () => {
    const enabled = failureOf(() => loadOpsConfig({ QUOKY_BACKUP_ENABLED: 'yes' }, { dbPath: '/d/q.db' }));
    expect(enabled).toEqual({ message: OpsConfigErrorCode.BACKUP_ENABLED_INVALID, exit: QuokyExitCode.CONFIGURATION });
    const dir = failureOf(() => loadOpsConfig({ QUOKY_BACKUP_DIR: 'relative/backups' }, { dbPath: '/d/q.db' }));
    expect(dir).toEqual({ message: OpsConfigErrorCode.BACKUP_DIR_INVALID, exit: QuokyExitCode.CONFIGURATION });
  });

  it('a failed pre-migration backup is a configuration exit too (the launcher stops after 3)', () => {
    expect(startupExitCode({ message: BackupErrorCode.BACKUP_PRE_MIGRATION_FAILED })).toBe(QuokyExitCode.CONFIGURATION);
  });
});
