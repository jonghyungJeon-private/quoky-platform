import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger, NotificationSink, NotificationSinkOutcome } from '@quoky/core';

/**
 * `OPS_NOTICE` (ADR-0102 D7, amending ADR-0101 D1 narrowly): the one non-reminder owner notice.
 *
 * - Delivered through the **unchanged** `NotificationSink` to the **owner DM only**: the target carries no guild
 *   (`spaceId`) and the notification uses the sink's DM-only body kind (`BRIEF`), so the ADR-0101 D8 channel opt-in
 *   can never route it to a channel. `OPS_NOTICE` is this module's notice identity (log key and correlation-id
 *   prefix), not a new sink kind.
 * - Fixed text per reason, no provider, no connector, no secret, no conversation content, no path or error text.
 * - Reasons: `CRASH_LOOP` (sent once after a successful start that follows ≥3 starts in 10 minutes, counted by the
 *   launcher) and `BACKUP_FAILED` (once per failed or unverifiable backup).
 * - At most 3 per rolling 24 hours, enforced by a small ledger file beside the database (mode 600) so the bound
 *   survives restarts — the case that matters, because a crash loop restarts the process. A notice is recorded in
 *   the ledger **before** it is sent (at most once: a crash mid-send never yields a second notice). A ledger that
 *   cannot be written suppresses the notice (fail closed: the bound must hold).
 * - One `CRASH_LOOP` per 10 minutes at most: the starts of one restart burst produce one notice.
 * - It is not a scheduler and decides nothing; a delivery failure is logged (status only) and never retried.
 */

export type OpsNoticeReason = 'CRASH_LOOP' | 'BACKUP_FAILED';

export const OPS_NOTICE_TEXT: Readonly<Record<OpsNoticeReason, string>> = {
  CRASH_LOOP:
    '[Quoky 운영 알림] Quoky가 최근 10분 안에 여러 번 다시 시작된 뒤 지금은 정상적으로 실행 중입니다. ' +
    '원인은 Quoky 로그(quoky.log)에서 확인해 주세요.',
  BACKUP_FAILED:
    '[Quoky 운영 알림] 데이터 백업이 실패했거나 검증되지 않았습니다. Quoky는 계속 실행 중입니다. ' +
    '원인은 Quoky 로그(quoky.log)에서 확인해 주세요.',
};

export const OPS_NOTICE_LIMITS = {
  maxPerWindow: 3,
  windowMs: 24 * 60 * 60 * 1000,
  crashLoopQuietMs: 10 * 60 * 1000,
} as const;

/** ADR-0102 D7: "≥3 restarts in 10 minutes", as the launcher counts them (`QUOKY_LAUNCHER_RECENT_STARTS`). */
export const CRASH_LOOP_RECENT_STARTS = 3;

/** Whether this start follows a crash loop: only under the launcher, which is the only source of the count. */
export function isCrashLoopStart(host: { readonly launcher?: 'launchd'; readonly recentStarts: number }): boolean {
  return host.launcher === 'launchd' && host.recentStarts >= CRASH_LOOP_RECENT_STARTS;
}

export type OpsNoticeOutcome =
  | NotificationSinkOutcome['status']
  | 'SUPPRESSED_DAILY_LIMIT'
  | 'SUPPRESSED_REPEAT'
  | 'SUPPRESSED_LEDGER_UNAVAILABLE'
  | 'NO_OWNER';

interface LedgerEntry {
  readonly at: IsoTimestamp;
  readonly reason: OpsNoticeReason;
}

export interface OpsNoticeLedgerStore {
  read(): string | undefined;
  write(content: string): void;
}

/** A private file path refused because it, or its directory, is not what it must be (a symlink, not a directory). */
export class PrivateFileRefusedError extends Error {
  constructor(readonly code: 'PRIVATE_DIR_NOT_A_DIRECTORY' | 'PRIVATE_DIR_NOT_PRIVATE' | 'PRIVATE_FILE_IS_SYMLINK') {
    super(code);
    this.name = 'PrivateFileRefusedError';
  }
}

/** `O_NOFOLLOW` where the platform has it (POSIX); 0 elsewhere. */
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * The private directory must be a real directory, not a symlink to one: `lstat` says directory, and its realpath is
 * its parent's realpath plus its own name (so the directory itself resolves nowhere else; a symlinked ancestor such as
 * macOS `/var` → `/private/var` is ordinary and allowed). Returns the `lstat` result.
 */
function verifyRealDirectory(dir: string): Stats {
  const stat: Stats = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PrivateFileRefusedError('PRIVATE_DIR_NOT_A_DIRECTORY');
  const expected = path.join(realpathSync(path.dirname(path.resolve(dir))), path.basename(path.resolve(dir)));
  if (realpathSync(dir) !== expected) throw new PrivateFileRefusedError('PRIVATE_DIR_NOT_A_DIRECTORY');
  return stat;
}

/** Create (700) or verify the private directory for a write: a real directory, never a symlink to one. */
function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  verifyRealDirectory(dir);
  chmodSync(dir, 0o700);
}

/**
 * Replace `filePath` atomically with `content` as a private (600) file in a private (700) directory: the temp file has
 * an unpredictable name and is created exclusively without following a symlink (`O_CREAT | O_EXCL | O_NOFOLLOW`, mode
 * 600), written, fsynced, closed and renamed over the target (rename replaces a symlink at the target, never follows
 * it). A failure removes the temp file and throws; the previous file stays as it was.
 */
export function writePrivateFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensurePrivateDirectory(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${randomBytes(12).toString('hex')}`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw error;
  }
}

/**
 * Read a private file; `undefined` when it (or its directory) is absent. Refused (thrown, never followed): a directory
 * that is a symlink, not a real directory or not mode 700, and a symlink at the file path.
 */
export function readPrivateFile(filePath: string): string | undefined {
  try {
    const dir = verifyRealDirectory(path.dirname(filePath));
    if ((dir.mode & 0o777) !== 0o700) throw new PrivateFileRefusedError('PRIVATE_DIR_NOT_PRIVATE');
    if (lstatSync(filePath).isSymbolicLink()) throw new PrivateFileRefusedError('PRIVATE_FILE_IS_SYMLINK');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const fd = openSync(filePath, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A small private JSON/text file beside the database (the `OPS_NOTICE` ledger, the runtime model-switch default):
 * private directory (700, a real directory), private file (600), replaced atomically via {@link writePrivateFileAtomic}.
 */
export function fileLedgerStore(ledgerPath: string): OpsNoticeLedgerStore {
  return {
    read: () => readPrivateFile(ledgerPath),
    write: (content) => writePrivateFileAtomic(ledgerPath, content),
  };
}

export interface OpsNoticeDeps {
  readonly sink: NotificationSink;
  /** The owner the DM goes to (`QUOKY_DISCORD_OWNER_IDS`, first id). Absent → nothing is sent. */
  readonly ownerId: string | undefined;
  /** The sink's platform name (`discord`). */
  readonly platform: string;
  readonly ledger: OpsNoticeLedgerStore;
  readonly logger: Logger;
  readonly clock?: () => IsoTimestamp;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set<OpsNoticeReason>(['CRASH_LOOP', 'BACKUP_FAILED']);

function parseLedger(content: string | undefined): LedgerEntry[] {
  if (content === undefined) return [];
  try {
    const parsed = JSON.parse(content) as { sent?: unknown };
    if (!Array.isArray(parsed.sent)) return [];
    return parsed.sent.filter(
      (e): e is LedgerEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as LedgerEntry).at === 'string' &&
        Number.isFinite(Date.parse((e as LedgerEntry).at)) &&
        KNOWN_REASONS.has((e as LedgerEntry).reason),
    );
  } catch {
    // A corrupt ledger is replaced; the entries it held are lost, which at worst allows one more window of notices.
    return [];
  }
}

export class OpsNoticeService {
  private readonly clock: () => IsoTimestamp;
  /** Notices are serialized so two reasons never race the ledger. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OpsNoticeDeps) {
    this.clock = deps.clock ?? sharedClock;
  }

  /** Send one fixed `OPS_NOTICE`, within the bounds above. Never throws. */
  notify(reason: OpsNoticeReason): Promise<OpsNoticeOutcome> {
    const run = this.queue.then(() => this.send(reason));
    this.queue = run.catch(() => undefined);
    return run.catch(() => 'SUPPRESSED_LEDGER_UNAVAILABLE' as const);
  }

  private async send(reason: OpsNoticeReason): Promise<OpsNoticeOutcome> {
    const at = this.clock();
    const nowMs = Date.parse(at);
    const { ownerId } = this.deps;
    if (ownerId === undefined || ownerId === '') return this.done(reason, 'NO_OWNER');

    let entries: LedgerEntry[];
    try {
      entries = parseLedger(this.deps.ledger.read());
    } catch {
      return this.done(reason, 'SUPPRESSED_LEDGER_UNAVAILABLE');
    }
    const recent = entries.filter((e) => {
      const t = Date.parse(e.at);
      return t <= nowMs && nowMs - t < OPS_NOTICE_LIMITS.windowMs;
    });
    if (recent.length >= OPS_NOTICE_LIMITS.maxPerWindow) return this.done(reason, 'SUPPRESSED_DAILY_LIMIT');
    if (
      reason === 'CRASH_LOOP' &&
      recent.some((e) => e.reason === 'CRASH_LOOP' && nowMs - Date.parse(e.at) < OPS_NOTICE_LIMITS.crashLoopQuietMs)
    ) {
      return this.done(reason, 'SUPPRESSED_REPEAT');
    }
    try {
      this.deps.ledger.write(JSON.stringify({ version: 1, sent: [...recent, { at, reason }] }));
    } catch {
      return this.done(reason, 'SUPPRESSED_LEDGER_UNAVAILABLE');
    }

    let outcome: NotificationSinkOutcome;
    try {
      outcome = await this.deps.sink.deliver({
        correlationId: `ops-notice-${reason.toLowerCase()}-${nowMs}`,
        target: { platform: this.deps.platform, channelId: '', userId: ownerId },
        kind: 'BRIEF',
        text: OPS_NOTICE_TEXT[reason],
      });
    } catch {
      outcome = { status: 'UNCERTAIN', reason: 'UNCLASSIFIED' };
    }
    return this.done(reason, outcome.status);
  }

  private done(reason: OpsNoticeReason, outcome: OpsNoticeOutcome): OpsNoticeOutcome {
    const fields = { reason, outcome };
    if (outcome === 'SENT') this.deps.logger.info('ops.notice', fields);
    else this.deps.logger.warn('ops.notice', fields);
    return outcome;
  }
}
