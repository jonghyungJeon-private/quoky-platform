import { describe, expect, it } from 'vitest';
import { UsageError, parseArguments, runCli, EXIT_OK } from '../selector-rag-cli';
import { buildRagPlan, ragPlanDigest, type RagPlanInput } from './plan';

const base: Omit<RagPlanInput, 'split'> = {
  poolDigest: 'p',
  goldDigest: 'g',
  splitSha256: 's',
  devCases: 10,
  heldOutCases: 30,
  excludedContaminated: 2,
  models: [{ model: 'm', spaceId: 'm@x@ollama1', prefix: 'search_query: ', tau: 0.9, tauLow: 0.8 }],
  selectorModel: 'haiku',
};

describe('ADR-0123 D6 plan binds the split (exact-scope approval)', () => {
  const dev = buildRagPlan({ ...base, split: 'dev' });
  const heldout = buildRagPlan({ ...base, split: 'heldout' });

  it('scopes arms, runs and call count to the split, and gives each split its own digest', () => {
    expect(dev.split_scope).toBe('dev');
    expect(dev.arms.map((arm) => arm.kind)).toEqual(['A0', 'A1']);
    expect(dev.calls).toEqual({ split: 'dev', cases: 10, arms: 2, runs: 1, total: 20 });
    expect(heldout.split_scope).toBe('heldout');
    expect(heldout.arms).toHaveLength(4);
    expect(heldout.calls).toEqual({ split: 'heldout', cases: 30, arms: 4, runs: 5, total: 600 });
    expect(ragPlanDigest(dev)).not.toBe(ragPlanDigest(heldout));
    expect(ragPlanDigest(buildRagPlan({ ...base, split: 'dev' }))).toBe(ragPlanDigest(dev));
  });

  it('binds the pre-selector exclusions into the digest', () => {
    const withExcluded = buildRagPlan({ ...base, split: 'dev', preSelectorExcluded: ['b', 'a'] });
    expect(withExcluded.split.excludedPreSelector).toEqual(['a', 'b']);
    expect(ragPlanDigest(withExcluded)).not.toBe(ragPlanDigest(dev));
  });

  it('plan and run refuse to start without an explicit --split, and --split is rejected elsewhere', () => {
    expect(() => parseArguments(['--mode', 'plan'])).toThrow(UsageError);
    expect(() => parseArguments(['--mode', 'run', '--approved-plan-digest', 'x'])).toThrow(UsageError);
    expect(() => parseArguments(['--mode', 'run', '--split', 'all', '--approved-plan-digest', 'x'])).toThrow(UsageError);
    expect(() => parseArguments(['--mode', 'lint', '--split', 'dev'])).toThrow(UsageError);
    expect(parseArguments(['--mode', 'run', '--split', 'dev', '--approved-plan-digest', 'x']).options['--split']).toBe('dev');
  });
});

describe('plan over a pool with a pending batch (approved subset only)', () => {
  it('plans dev and heldout, excludes the pending entries, and validates the audit against the approved subset', async () => {
    for (const split of ['dev', 'heldout']) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(['--mode', 'plan', '--split', split], { stdout: (l) => out.push(l), stderr: (l) => err.push(l), now: () => '2026-10-16T03:00:00.000Z' });
      expect(err.join('\n')).not.toContain('BLOCKED');
      expect(code).toBe(EXIT_OK);
      expect(out.join('\n')).toMatch(/plan digest \(sha256\): [0-9a-f]{64}/);
    }
  }, 120_000);
});

describe('dry-run audit uses the approved subset, so plan accepts it', () => {
  // A deterministic character-trigram embedder: no network, no Ollama. Near copies score high, unrelated texts low.
  const fakeEmbedder = (model: string) => ({
    pin: { model, digest12: '000000000000', ollamaVersion: '0.0.0', spaceId: `${model}@000000000000@ollama0.0.0`, prefix: 'search_query: ' },
    embed: async (texts: readonly string[]) =>
      texts.map((text) => {
        const v = new Array<number>(512).fill(0);
        const chars = Array.from(text.normalize('NFC').toLowerCase());
        for (let i = 0; i + 3 <= chars.length; i += 1) {
          let h = 7;
          for (const c of chars.slice(i, i + 3)) h = (h * 31 + (c.codePointAt(0) as number)) % 512;
          v[h] = (v[h] as number) + 1;
        }
        const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        return v.map((x) => x / norm);
      }),
  });

  it('regenerates the audit from a mixed pool (approved + pending) with a fake embedder in a temp dir, then plans', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadPoolFile, approvedEntries, poolDigest } = await import('./pool');
    const dir = mkdtempSync(join(tmpdir(), 'rag-audit-'));
    const poolPath = join(dir, 'pool.json');
    const auditPath = join(dir, 'audit.json');
    const pool = loadPoolFile();
    expect(pool.entries.length).toBeGreaterThan(approvedEntries(pool).length); // mixed: a pending batch is present
    writeFileSync(poolPath, JSON.stringify(pool));
    const deps = {
      stdout: () => undefined,
      stderr: () => undefined,
      now: () => '2026-10-16T03:00:00.000Z',
      evalDir: join(dir, 'eval'),
      createEmbedder: async (model: string) => fakeEmbedder(model),
    };
    const code = await runCli(['--mode', 'dry-run', '--pool', poolPath, '--audit', auditPath, '--write-audit', 'true', '--latency-sample', '3'], deps);
    expect(existsSync(auditPath)).toBe(true);
    const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as { poolDigest: string; poolScope: { entries: number; approvedBatches: number[] }; models: Array<{ flaggedPairs: unknown[]; lowStratumValid: boolean | null }> };
    expect(audit.poolDigest).toBe(poolDigest(approvedEntries(pool)));
    expect(audit.poolScope).toEqual({ entries: approvedEntries(pool).length, approvedBatches: [1] });
    // the fake space need not pass the real audit gates; plan must at least accept the audit's pool scope (not call it stale)
    const err: string[] = [];
    await runCli(['--mode', 'plan', '--split', 'dev', '--pool', poolPath, '--audit', auditPath], { ...deps, stderr: (l) => err.push(l) });
    expect(err.join('\n')).not.toContain('stale');
    expect(code === EXIT_OK || code === 1).toBe(true);
  }, 120_000);
});
