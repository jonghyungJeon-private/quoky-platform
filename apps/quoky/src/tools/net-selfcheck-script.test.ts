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
