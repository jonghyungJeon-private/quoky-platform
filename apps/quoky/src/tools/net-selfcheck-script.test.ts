import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the offline fixture tests of ops/security/quoky-net-selfcheck.sh (ADR-0121 S0). Nothing touches the host.
describe('ops/security/quoky-net-selfcheck.test.sh', () => {
  it('passes on the canned lsof/netstat/ifconfig/ledger fixtures', () => {
    const script = fileURLToPath(new URL('../../../../ops/security/quoky-net-selfcheck.test.sh', import.meta.url));
    const run = spawnSync('bash', [script], { encoding: 'utf8' });
    expect(run.stdout + run.stderr).toMatch(/0 failed/);
    expect(run.status).toBe(0);
  });
});

describe('ops/security/quoky-net-selfcheck.sh --json', () => {
  const script = fileURLToPath(new URL('../../../../ops/security/quoky-net-selfcheck.sh', import.meta.url));

  function localIso(d: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }

  it('emits parseable JSON, sums bytes over request records only and fails on guard findings in the window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfcheck-'));
    try {
      const now = new Date();
      const day = localIso(now).slice(0, 10);
      const old = localIso(new Date(now.getTime() - 3 * 86_400_000));
      const lines = [
        { v: 1, kind: 'request', ts: localIso(now), host: 'api.telegram.org', initiator: 'startup', bytesUp: 10, bytesDown: 90, outcome: 'ok' },
        { v: 1, kind: 'connect', ts: localIso(now), host: 'api.telegram.org', ip: '203.0.113.7', port: 443, outcome: 'pinned' },
        { v: 1, kind: 'guard', ts: localIso(now), host: 'tracker.example.net', event: 'new-destination', detail: 'x', mode: 'observe', action: 'observed' },
        { v: 1, kind: 'guard', ts: old, host: 'older.example.net', event: 'denied-range', detail: 'x', mode: 'observe', action: 'observed' },
      ].map((r) => JSON.stringify(r));
      writeFileSync(join(dir, `egress-${day}.jsonl`), `${lines.join('\n')}\n`);
      const run = spawnSync('bash', [script, '--json', '--expect-stopped', '--since', '24h'], {
        encoding: 'utf8',
        env: { ...process.env, QUOKY_LEDGER_DIR: dir, QUOKY_LAUNCHD_LABEL: 'com.quoky.selfcheck.test.absent' },
      });
      const report = JSON.parse(run.stdout) as { status: string; failures: string[]; ledger_summary: string[] };
      expect(report.status).toBe('FAIL');
      expect(report.failures.some((f) => f.includes('new-destination') && f.includes('tracker.example.net'))).toBe(true);
      expect(report.failures.some((f) => f.includes('older.example.net'))).toBe(false);
      expect(report.ledger_summary.some((l) => l.startsWith('lines=') && l.includes('requests=1 up=10 down=90'))).toBe(true);
      expect(run.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid --since before running anything', () => {
    const run = spawnSync('bash', [script, '--since', '1$(id)h'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
  });
});
