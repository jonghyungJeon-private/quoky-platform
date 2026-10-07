import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverOwnerNotification } from '@quoky/adapter-discord';
import type { NotificationChannel, NotificationSendOptions } from '@quoky/adapter-discord';
import type { LogFields, Logger, NotificationSink, NotificationSinkOutcome, OwnerNotification } from '@quoky/core';
import {
  CRASH_LOOP_RECENT_STARTS,
  OPS_NOTICE_LIMITS,
  OPS_NOTICE_TEXT,
  OpsNoticeService,
  fileLedgerStore,
  isCrashLoopStart,
  type OpsNoticeLedgerStore,
} from './ops-notice';

const OWNER = '111111111111111111';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const T0 = Date.parse('2026-10-06T00:00:00.000Z');

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, fields }); }
}

class RecordingSink implements NotificationSink {
  readonly delivered: OwnerNotification[] = [];
  constructor(private readonly outcome: NotificationSinkOutcome = { status: 'SENT', via: 'dm' }) {}
  async deliver(notification: OwnerNotification): Promise<NotificationSinkOutcome> {
    this.delivered.push(notification);
    return this.outcome;
  }
}

function memoryLedger(): OpsNoticeLedgerStore & { content: string | undefined; writes: number } {
  const store = {
    content: undefined as string | undefined,
    writes: 0,
    read: () => store.content,
    write: (content: string) => {
      store.content = content;
      store.writes += 1;
    },
  };
  return store;
}

function service(opts: { sink?: NotificationSink; ledger?: OpsNoticeLedgerStore; at?: () => number; ownerId?: string }) {
  const logger = new RecordingLogger();
  const at = opts.at ?? (() => T0);
  const notices = new OpsNoticeService({
    sink: opts.sink ?? new RecordingSink(),
    ownerId: 'ownerId' in opts ? opts.ownerId : OWNER,
    platform: 'discord',
    ledger: opts.ledger ?? memoryLedger(),
    logger,
    clock: () => new Date(at()).toISOString(),
  });
  return { notices, logger };
}

describe('OPS_NOTICE (ADR-0102 D7)', () => {
  it('sends fixed text to the owner DM only: no guild target, the sink’s DM-only kind', async () => {
    const sink = new RecordingSink();
    const { notices } = service({ sink });
    expect(await notices.notify('BACKUP_FAILED')).toBe('SENT');
    expect(sink.delivered).toHaveLength(1);
    const sent = sink.delivered[0] as OwnerNotification;
    expect(sent.text).toBe(OPS_NOTICE_TEXT.BACKUP_FAILED);
    expect(sent.kind).toBe('BRIEF');
    expect(sent.target).toEqual({ platform: 'discord', channelId: '', userId: OWNER });
    expect(sent.target.spaceId).toBeUndefined();
    expect(sent.correlationId.startsWith('ops-notice-backup_failed-')).toBe(true);
  });

  it('the real Discord sink routes it to the DM even with channel delivery opted in', async () => {
    const sends: Array<{ where: string; options: NotificationSendOptions }> = [];
    const channel = (where: string): NotificationChannel => ({
      send: async (options) => {
        sends.push({ where, options });
        return {};
      },
    });
    const sink: NotificationSink = {
      deliver: (n) =>
        deliverOwnerNotification(n, {
          ownerIds: [OWNER],
          channelIds: [CHANNEL],
          guildId: GUILD,
          channelDelivery: true,
          fetchChannel: async () => channel('channel'),
          fetchOwnerDm: async () => channel('dm'),
          logger: new RecordingLogger(),
        }),
    };
    const { notices } = service({ sink });
    expect(await notices.notify('CRASH_LOOP')).toBe('SENT');
    expect(sends).toEqual([{ where: 'dm', options: { content: OPS_NOTICE_TEXT.CRASH_LOOP, allowedMentions: { parse: [] } } }]);
  });

  it('texts are fixed and carry no path, id, secret-shaped or variable content', () => {
    for (const text of Object.values(OPS_NOTICE_TEXT)) {
      expect(text.startsWith('[Quoky 운영 알림]')).toBe(true);
      expect(text).not.toMatch(/\/|\\|\d{5,}|token|key|@/i);
    }
  });

  it('at most 3 per rolling 24 hours, and the bound survives a restart (persisted ledger)', async () => {
    const ledger = memoryLedger();
    let nowMs = T0;
    const sink = new RecordingSink();
    for (let i = 0; i < 3; i += 1) {
      // A fresh service per notice = a fresh process per crash-loop start.
      const { notices } = service({ sink, ledger, at: () => nowMs });
      expect(await notices.notify('BACKUP_FAILED')).toBe('SENT');
      nowMs += 60 * 60 * 1000;
    }
    const { notices: fourth } = service({ sink, ledger, at: () => nowMs });
    expect(await fourth.notify('BACKUP_FAILED')).toBe('SUPPRESSED_DAILY_LIMIT');
    expect(sink.delivered).toHaveLength(3);
    // 24 hours after the first, one slot frees up.
    nowMs = T0 + OPS_NOTICE_LIMITS.windowMs;
    const { notices: later } = service({ sink, ledger, at: () => nowMs });
    expect(await later.notify('BACKUP_FAILED')).toBe('SENT');
    expect(sink.delivered).toHaveLength(4);
  });

  it('one CRASH_LOOP per restart burst (10 minutes), recorded before the send', async () => {
    const ledger = memoryLedger();
    let nowMs = T0;
    const sink = new RecordingSink({ status: 'UNCERTAIN', reason: 'TIMEOUT' });
    const first = service({ sink, ledger, at: () => nowMs });
    expect(await first.notices.notify('CRASH_LOOP')).toBe('UNCERTAIN');
    expect(ledger.writes).toBe(1);
    nowMs += 5 * 60 * 1000;
    const second = service({ sink, ledger, at: () => nowMs });
    expect(await second.notices.notify('CRASH_LOOP')).toBe('SUPPRESSED_REPEAT');
    // A backup failure in the same window is a different reason.
    expect(await second.notices.notify('BACKUP_FAILED')).toBe('UNCERTAIN');
    nowMs += 10 * 60 * 1000;
    const third = service({ sink, ledger, at: () => nowMs });
    expect(await third.notices.notify('CRASH_LOOP')).toBe('UNCERTAIN');
    expect(sink.delivered.map((n) => n.text)).toEqual([
      OPS_NOTICE_TEXT.CRASH_LOOP,
      OPS_NOTICE_TEXT.BACKUP_FAILED,
      OPS_NOTICE_TEXT.CRASH_LOOP,
    ]);
  });

  it('fails closed when the ledger cannot be written or read; a corrupt ledger is replaced', async () => {
    const sink = new RecordingSink();
    const unwritable: OpsNoticeLedgerStore = { read: () => undefined, write: () => { throw new Error('EACCES'); } };
    expect(await service({ sink, ledger: unwritable }).notices.notify('BACKUP_FAILED')).toBe('SUPPRESSED_LEDGER_UNAVAILABLE');
    const unreadable: OpsNoticeLedgerStore = { read: () => { throw new Error('EIO'); }, write: () => undefined };
    expect(await service({ sink, ledger: unreadable }).notices.notify('BACKUP_FAILED')).toBe('SUPPRESSED_LEDGER_UNAVAILABLE');
    expect(sink.delivered).toHaveLength(0);
    const corrupt = memoryLedger();
    corrupt.content = '{not json';
    expect(await service({ sink, ledger: corrupt }).notices.notify('BACKUP_FAILED')).toBe('SENT');
    expect(JSON.parse(corrupt.content as string).sent).toHaveLength(1);
  });

  it('sends nothing without an owner, and a throwing sink is UNCERTAIN, never a crash', async () => {
    const sink = new RecordingSink();
    expect(await service({ sink, ownerId: undefined }).notices.notify('CRASH_LOOP')).toBe('NO_OWNER');
    expect(sink.delivered).toHaveLength(0);
    const throwing: NotificationSink = { deliver: async () => { throw new Error('boom'); } };
    const { notices, logger } = service({ sink: throwing });
    expect(await notices.notify('BACKUP_FAILED')).toBe('UNCERTAIN');
    expect(logger.lines).toEqual([{ level: 'warn', message: 'ops.notice', fields: { reason: 'BACKUP_FAILED', outcome: 'UNCERTAIN' } }]);
  });

  it('crash loop = launcher-counted starts >= 3, only under the launcher', () => {
    expect(CRASH_LOOP_RECENT_STARTS).toBe(3);
    expect(isCrashLoopStart({ launcher: 'launchd', recentStarts: 3 })).toBe(true);
    expect(isCrashLoopStart({ launcher: 'launchd', recentStarts: 2 })).toBe(false);
    expect(isCrashLoopStart({ recentStarts: 9 })).toBe(false);
  });

  describe('file ledger', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'quoky-ops-ledger-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('creates a private directory (700) and file (600); absent file reads as empty', () => {
      const ledgerPath = path.join(dir, 'ops', 'notice-ledger.json');
      const store = fileLedgerStore(ledgerPath);
      expect(store.read()).toBeUndefined();
      store.write('{"version":1,"sent":[]}');
      expect(store.read()).toBe('{"version":1,"sent":[]}');
      expect(statSync(path.join(dir, 'ops')).mode & 0o777).toBe(0o700);
      expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    });

    it('refuses a symlinked ledger directory or ledger file (the shared private-file helper; fail closed)', () => {
      const outside = path.join(dir, 'outside');
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, path.join(dir, 'ops'));
      const store = fileLedgerStore(path.join(dir, 'ops', 'notice-ledger.json'));
      expect(() => store.write('{"version":1,"sent":[]}')).toThrow();
      expect(readdirSync(outside)).toEqual([]);
      const linked = path.join(dir, 'linked.json');
      symlinkSync(path.join(outside, 'x.json'), linked);
      expect(() => fileLedgerStore(linked).read()).toThrow();
    });
  });
});
