import { describe, expect, it } from 'vitest';
import { UsageError, parseArguments } from '../selector-rag-cli';
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

  it('plan and run refuse to start without an explicit --split, and --split is rejected elsewhere', () => {
    expect(() => parseArguments(['--mode', 'plan'])).toThrow(UsageError);
    expect(() => parseArguments(['--mode', 'run', '--approved-plan-digest', 'x'])).toThrow(UsageError);
    expect(() => parseArguments(['--mode', 'run', '--split', 'all', '--approved-plan-digest', 'x'])).toThrow(UsageError);
    expect(() => parseArguments(['--mode', 'lint', '--split', 'dev'])).toThrow(UsageError);
    expect(parseArguments(['--mode', 'run', '--split', 'dev', '--approved-plan-digest', 'x']).options['--split']).toBe('dev');
  });
});
