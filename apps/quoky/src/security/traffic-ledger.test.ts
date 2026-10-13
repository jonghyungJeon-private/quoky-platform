import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '@quoky/core';
import {
  LEDGER_MAX_PARTS_PER_DAY,
  SmallRequestBurstDetector,
  TrafficLedger,
  summarizeTraffic,
} from './traffic-ledger';
import type { LedgerRequestRecord } from './traffic-ledger';
import { isoWithOffset, localDateKey } from './iso-time';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'quoky-ledger-'));
  dirs.push(dir);
  return path.join(dir, 'audit');
}

function logger(): Logger & { lines: Array<{ message: string; fields?: LogFields }> } {
  const lines: Array<{ message: string; fields?: LogFields }> = [];
  const push = (message: string, fields?: LogFields): void => {
    lines.push({ message, ...(fields ? { fields } : {}) });
  };
  return { lines, info: push, warn: push, error: push };
}

function request(at: Date, overrides: Partial<LedgerRequestRecord> = {}): LedgerRequestRecord {
  return {
    v: 1,
    kind: 'request',
    ts: isoWithOffset(at),
    cid: null,
    initiator: 'background',
    host: 'slack.com',
    label: 'slack',
    method: 'POST',
    path: '/api/conversations.info',
    status: 200,
    statusClass: '2xx',
    bytesUp: 100,
    bytesDown: 300,
    latencyMs: 12,
    outcome: 'ok',
    mode: 'observe',
    ...overrides,
  };
}

const NOW = new Date('2026-10-13T03:00:00.000Z');

describe('TrafficLedger file (design §5.4)', () => {
  it('appends JSON lines to <dir>/egress-YYYY-MM-DD.jsonl with modes 0700/0600', () => {
    const dir = tempDir();
    const ledger = new TrafficLedger({ dir, clock: () => NOW });
    ledger.append(request(NOW));
    ledger.append(request(NOW, { status: 404, statusClass: '4xx' }));
    const file = path.join(dir, `egress-${localDateKey(NOW)}.jsonl`);
    expect(ledger.currentFile()).toBe(file);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LedgerRequestRecord);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ v: 1, kind: 'request', status: 404, host: 'slack.com' });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rotates to numbered parts at the size cap, then drops the day\'s rest with one warning', () => {
    const dir = tempDir();
    const log = logger();
    const line = `${JSON.stringify(request(NOW))}\n`;
    const ledger = new TrafficLedger({ dir, clock: () => NOW, maxFileBytes: Buffer.byteLength(line) * 2, logger: log });
    for (let i = 0; i < LEDGER_MAX_PARTS_PER_DAY * 2 + 3; i += 1) ledger.append(request(NOW));
    const day = localDateKey(NOW);
    expect(readdirSync(dir).sort()).toEqual([
      `egress-${day}.1.jsonl`,
      `egress-${day}.2.jsonl`,
      `egress-${day}.3.jsonl`,
      `egress-${day}.jsonl`,
    ]);
    expect(log.lines.filter((entry) => entry.message === 'egress.ledger.cap_reached')).toHaveLength(1);
    // A restart continues in the last part instead of truncating.
    const restarted = new TrafficLedger({ dir, clock: () => NOW, maxFileBytes: Buffer.byteLength(line) * 2 });
    expect(restarted.currentFile()).toBe(path.join(dir, `egress-${day}.3.jsonl`));
  });

  it('deletes files older than the retention at start and keeps the rest', () => {
    const dir = tempDir();
    new TrafficLedger({ dir, clock: () => NOW }).currentFile();
    const old = new Date(NOW.getTime() - 91 * 86_400_000);
    const kept = new Date(NOW.getTime() - 89 * 86_400_000);
    writeFileSync(path.join(dir, `egress-${localDateKey(old)}.jsonl`), '');
    writeFileSync(path.join(dir, `egress-${localDateKey(old)}.1.jsonl`), '');
    writeFileSync(path.join(dir, `egress-${localDateKey(kept)}.jsonl`), '');
    writeFileSync(path.join(dir, 'unrelated.txt'), '');
    const ledger = new TrafficLedger({ dir, clock: () => NOW, retentionDays: 90 });
    ledger.append(request(NOW));
    expect(readdirSync(dir).sort()).toEqual(
      [`egress-${localDateKey(kept)}.jsonl`, `egress-${localDateKey(NOW)}.jsonl`, 'unrelated.txt'].sort(),
    );
  });

  it('a write failure never throws and is logged once by code', () => {
    const base = tempDir();
    writeFileSync(path.dirname(base) + '/blocker', '');
    const log = logger();
    const ledger = new TrafficLedger({ dir: path.join(path.dirname(base), 'blocker', 'audit'), clock: () => NOW, logger: log });
    expect(() => {
      ledger.append(request(NOW));
      ledger.append(request(NOW));
    }).not.toThrow();
    expect(log.lines).toEqual([{ message: 'egress.ledger.write_failed', fields: { errorCode: 'ENOTDIR' } }]);
  });
});

describe('cumulative summary: 5 min and 24 h per destination (MSIT ⑤-4)', () => {
  it('totals each window and flags ≥ 20 small requests outside an owner turn in 5 minutes', () => {
    const records: LedgerRequestRecord[] = [];
    for (let i = 0; i < 20; i += 1) records.push(request(new Date(NOW.getTime() - i * 10_000), { bytesUp: 50, bytesDown: 500 }));
    records.push(request(new Date(NOW.getTime() - 60_000), { initiator: 'owner-turn', bytesUp: 10, bytesDown: 10 }));
    records.push(request(new Date(NOW.getTime() - 2 * 3_600_000), { bytesDown: 10_000 }));
    records.push(request(new Date(NOW.getTime() - 25 * 3_600_000)));
    records.push(request(NOW, { host: 'api.github.com', label: 'github', outcome: 'refused', status: null, bytesUp: 0, bytesDown: 0 }));
    const [github, slack] = summarizeTraffic(records, NOW.getTime());
    expect(github).toMatchObject({ host: 'api.github.com', repeatedSmall: false, short: { requests: 1, refused: 1 } });
    expect(slack).toMatchObject({
      host: 'slack.com',
      labels: ['slack'],
      repeatedSmall: true,
      short: { requests: 21, small: 21, smallOutsideOwnerTurn: 20, bytesUp: 20 * 50 + 10 },
      long: { requests: 22, bytesDown: 20 * 500 + 10 + 10_000 },
    });
  });

  it('the live detector reports a host once per window', () => {
    const detector = new SmallRequestBurstDetector();
    const t0 = NOW.getTime();
    const hits: number[] = [];
    for (let i = 0; i < 45; i += 1) if (detector.observe(request(NOW, { bytesUp: 1, bytesDown: 1 }), t0 + i * 1000)) hits.push(i);
    expect(hits).toEqual([19]);
    expect(detector.observe(request(NOW, { bytesDown: 1 }), t0 + 6 * 60_000)).toBe(false);
    for (let i = 0; i < 25; i += 1) detector.observe(request(NOW, { bytesDown: 1 }), t0 + 12 * 60_000 + i);
    expect(detector.observe(request(NOW, { initiator: 'owner-turn', bytesDown: 1 }), t0 + 13 * 60_000)).toBe(false);
  });
});
