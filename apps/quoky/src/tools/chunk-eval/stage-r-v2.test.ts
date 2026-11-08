/**
 * ADR-0124 phase 2 P2-3: stage R on CH8 (offline; fake embedder and fake daemon, nothing reaches a model). The CH7 plan digest must not
 * change by this work.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capability, chunking, formatEmbeddingEnvelope, type AiProvider } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, parseArguments, runCli, type CliDeps } from '../chunk-eval-cli';
import type { FetchLike } from '../selector-rag/embed';
import { loadMemorySetV2, memoryDigestV2, MEMORY_V2_SEED, MEMORY_V2_VERSION } from './memory-set-v2';
import { STAGE_R_PLAN_VERSION, stageRDigest, implementationHashes, type RuntimeEmbeddingProvider } from './stage-r';
import { IMPLEMENTATION_FILES_V2, STAGE_R_V2_PARAMETERS, buildStageRV2Plan, memoryRecordsOfV2, runArmFreshV2, stageRV2Digest, updatedAtOfV2, type StageRV2Inputs } from './stage-r-v2';
import { generateMemorySet, memoryDigest, MEMORY_SEED, MEMORY_VERSION } from './memory-set';

const scratch = mkdtempSync(join(tmpdir(), 'stage-r-v2-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const set = loadMemorySetV2();

const DIM = 64;
const hashOf = (term: string): number => {
  let h = 2166136261;
  for (const ch of term) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
  return h;
};
const embedText = (text: string): number[] => {
  const vector = new Array<number>(DIM).fill(0);
  for (const term of chunking.lexicalTerms(text)) vector[hashOf(term) % DIM] = (vector[hashOf(term) % DIM] as number) + 1;
  vector[0] = (vector[0] as number) + 0.01;
  return vector;
};
const fakeProvider = (model = 'fake-embed'): RuntimeEmbeddingProvider =>
  ({
    id: 'fake-embed',
    capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }],
    executionLocality: 'LOCAL',
    isAvailable: async () => true,
    execute: async (request: { prompt: string }) => ({ text: formatEmbeddingEnvelope(embedText(request.prompt), model), raw: {}, audit: { model } }),
  }) as unknown as AiProvider as RuntimeEmbeddingProvider;

describe('CH7 plan digest is unchanged by the CH8 work', () => {
  // recorded with `--mode plan --set memory --stage R --arms E0,E4 --modes backfilled` before the CH8 edit: 3569866f288d166cbe9975d84a9d0c3dfc278d776103b13ea57b0c27d04911b0
  // (the daemon pins are part of that digest; this pin covers the code side: the hashed CH7 sources and parameters, with fixed inputs)
  const FIXED: Parameters<typeof stageRDigest>[0] = { set: { digest: '0'.repeat(64), memories: 1, queries: 1 }, planned: ['L'], pins: [], dropped: [] };
  it('stageRDigest of fixed inputs equals the value recorded before the CH8 edit', () => {
    expect(STAGE_R_PLAN_VERSION).toBe('runtime-recall-plan.v3');
    expect(stageRDigest(FIXED)).toBe('6b2fa49c0edce08ba4581b810d32a032c7c50a30bc0e2f69e4b95113c7b7041a');
  });
  it('the CH7 implementation hashes do not include any CH8 file', () => {
    expect(Object.keys(implementationHashes()).filter((file) => /v2|validation/u.test(file))).toEqual([]);
  });
});

describe('CH8 timestamps', () => {
  it('updatedAt is the fixed retrieval time minus the authored daysAgo; records are built like CH7', () => {
    const stamps = updatedAtOfV2(set);
    for (const memory of set.memories) expect(Date.parse('2026-11-06T00:00:00.000Z') - Date.parse(stamps.get(memory.id) as string)).toBe(memory.daysAgo * 86_400_000);
    const records = memoryRecordsOfV2(set);
    expect(records).toHaveLength(set.memories.length);
    expect(records[0]).toMatchObject({ type: 'LONG_TERM', scope: { userId: 'ch7-runtime-actor' }, metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT' } });
  });
});

describe('CH8 plan digest', () => {
  const inputs: StageRV2Inputs = { set: { digest: memoryDigestV2(set), memories: 120, queries: 150 }, planned: ['L'], pins: [], dropped: [] };
  it('covers the set digest, candidates, verdict rule and modes, and differs from the CH7 digest', () => {
    const base = stageRV2Digest(inputs);
    expect(stageRV2Digest({ ...inputs, set: { ...inputs.set, digest: '1'.repeat(64) } })).not.toBe(base);
    expect(stageRV2Digest(inputs, { ...STAGE_R_V2_PARAMETERS, validation: { ...STAGE_R_V2_PARAMETERS.validation, verdictRule: { ...STAGE_R_V2_PARAMETERS.validation.verdictRule, text: 'changed' } } })).not.toBe(base);
    expect(stageRV2Digest(inputs, { ...STAGE_R_V2_PARAMETERS, validation: { ...STAGE_R_V2_PARAMETERS.validation, candidateIds: ['B0', 'B1'] } })).not.toBe(base);
    expect(stageRV2Digest({ ...inputs, modes: ['backfilled'] })).not.toBe(stageRV2Digest({ ...inputs, modes: ['warm'] }));
    expect(base).not.toBe(stageRDigest({ ...inputs, set: inputs.set }));
    expect(IMPLEMENTATION_FILES_V2).toEqual(expect.arrayContaining(['apps/quoky/src/tools/chunk-eval/blend-validation.ts', 'apps/quoky/src/tools/chunk-eval/stage-r-v2.ts', 'apps/quoky/src/tools/chunk-eval/memory-set-v2.ts']));
    expect(stageRV2Digest(inputs, STAGE_R_V2_PARAMETERS, Object.fromEntries(IMPLEMENTATION_FILES_V2.map((f) => [f, 'x'])))).not.toBe(base);
  });
  it('the plan reports the model-call upper bound and the verdict rule', () => {
    const plan = buildStageRV2Plan({ ...inputs, planned: ['E0'], pins: [], modes: ['backfilled'] }, set);
    expect(plan.runs).toEqual([{ arm: 'E0', mode: 'backfilled', queries: 150, modelCallsUpperBound: 150 + 120 + Math.ceil(120 / 8) + 20 }]);
    expect(JSON.stringify(plan.parameters)).toContain('B2 confirmed if B2 overall Recall@5 >= 0.95');
  });
});

describe('CH8 runtime run (fake embedder, real runtime classes)', () => {
  it('a backfilled run produces the validation with B0 matching the real retriever, per-category metrics and a verdict', async () => {
    const run = await runArmFreshV2({ arm: 'E0', mode: 'backfilled', set, provider: fakeProvider(), tmpRoot: scratch });
    expect(run.invalid).toBeNull();
    expect(run.metrics.overall.n).toBe(150);
    const validation = run.blendValidation;
    expect(validation).not.toBeNull();
    expect(validation?.invalid).toBeNull();
    expect(validation?.fidelity).toEqual({ queries: 150, mismatches: 0 });
    expect(validation?.results.map((r) => r.id)).toEqual(['B0', 'B1', 'B2']);
    expect(Object.keys(validation?.results[0]?.byCategory ?? {}).sort()).toEqual(['old-relevant', 'paraphrase', 'recency-wins', 'shared']);
    expect(validation?.results[0]?.newerFirst.n).toBe(22);
    expect(['B2 confirmed', 'B1 recommended', 'no change recommended']).toContain(validation?.verdict);
  }, 60_000);

  it('the lexical arm runs without a validation table', async () => {
    const run = await runArmFreshV2({ arm: 'L', mode: 'lexical', set, tmpRoot: scratch });
    expect(run.blendValidation).toBeNull();
    expect(run.metrics.overall.n).toBe(150);
  });
});

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const reports: Array<{ name: string; report: unknown }> = [];
  let providerBuilt = 0;
  const fetchImpl: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (path === '/api/version') return reply({ version: '0.40.14' });
    if (path === '/api/tags') return reply({ models: [{ name: 'nomic-embed-text:latest', digest: 'a'.repeat(64), size: 1000 }, { name: 'embeddinggemma:300m', digest: 'e'.repeat(64), size: 1000 }] });
    return reply({});
  };
  const ch7 = generateMemorySet();
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-11-09T12:00:00.000Z'),
    corpus: () => [],
    readFreeze: () => undefined,
    writeFreeze: () => undefined,
    writeReport: (_dir, name, report) => {
      reports.push({ name, report });
      return `/mem/${name}`;
    },
    memory: { corpus: () => ch7, readFreeze: () => ({ version: MEMORY_VERSION, seed: MEMORY_SEED, cases: ch7.memories.length + ch7.queries.length, sha256: memoryDigest(ch7) }), writeFreeze: () => undefined },
    memoryV2: { corpus: () => set, readFreeze: () => ({ version: MEMORY_V2_VERSION, seed: MEMORY_V2_SEED, cases: 270, sha256: memoryDigestV2(set) }), writeFreeze: () => undefined },
    embed: { fetch: fetchImpl },
    runtime: { provider: (model) => { providerBuilt += 1; return fakeProvider(model); }, tmpRoot: scratch },
  };
  return { deps, out, err, reports, built: () => providerBuilt };
}
const digestOf = (out: string[]): string => /plan digest: ([0-9a-f]{64})/u.exec(out.join('\n'))?.[1] as string;
const base = ['--set', 'memory-v2', '--stage', 'R', '--arms', 'E0', '--modes', 'backfilled'];

describe('CH8 CLI', () => {
  it('parses --set memory-v2 for stage R only; stage D/E and --arms without a stage are usage errors', () => {
    expect(parseArguments([...base, '--mode', 'plan']).set).toBe('memory-v2');
    expect(() => parseArguments(['--set', 'memory-v2', '--stage', 'E', '--arms', 'E1', '--mode', 'plan'])).toThrow(/--stage R only|needs --set memory/);
    expect(() => parseArguments(['--set', 'memory-v2', '--arms', 'E0', '--mode', 'run'])).toThrow(/--stage R only/);
  });

  it('plan makes no model call; the run needs that digest and is NON-GATING with the verdict printed', async () => {
    const plan = harness();
    expect(await runCli([...base, '--mode', 'plan'], plan.deps)).toBe(EXIT_OK);
    expect(plan.built()).toBe(0);
    const text = plan.out.join('\n');
    expect(text).toContain('stage R plan on CH8');
    expect(text).toContain('validation (not selection): candidates B0, B1, B2');
    expect(text).toContain('up to 305 ollama calls');
    const digest = digestOf(plan.out);

    const missing = harness();
    expect(await runCli([...base, '--mode', 'run'], missing.deps)).toBe(EXIT_BLOCKED);
    expect(missing.built()).toBe(0);
    const wrong = harness();
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', 'f'.repeat(64)], wrong.deps)).toBe(EXIT_BLOCKED);

    const run = harness();
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', digest], run.deps)).toBe(EXIT_NON_GATING);
    const lines = run.out.join('\n');
    expect(lines).toContain('verdict (advisory, pre-declared):');
    expect(lines).toContain('newer-first');
    expect(run.reports.some((entry) => entry.name.startsWith('chunk-eval-memory-stage-r-ch8-'))).toBe(true);
  }, 60_000);

  it('the CH7 path is untouched: --set memory plan still prints the CH7 plan version and a different digest', async () => {
    const ch7 = harness();
    expect(await runCli(['--set', 'memory', '--stage', 'R', '--arms', 'E0', '--modes', 'backfilled', '--mode', 'plan'], ch7.deps)).toBe(EXIT_OK);
    expect(ch7.out.join('\n')).toContain('runtime-recall-plan.v3');
    const ch8 = harness();
    await runCli([...base, '--mode', 'plan'], ch8.deps);
    expect(digestOf(ch8.out)).not.toBe(digestOf(ch7.out));
  });

  it('an unrecognized mode for the CH8 set without a stage is a usage error', async () => {
    const h = harness();
    expect(await runCli(['--set', 'memory-v2', '--mode', 'run'], h.deps)).toBe(EXIT_USAGE);
  });
});
