/**
 * ADR-0124 phase 2 P2-1: offline tests of stage R (the CH7 set through the real runtime recall path). The embedding provider is a
 * deterministic fake and the daemon a fake fetch; nothing here reaches a model. The retriever, scorer, sqlite and vector store are the real classes.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capability, chunking, formatEmbeddingEnvelope, type AiProvider } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_INVALID, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, runCli, parseArguments, type CliDeps } from '../chunk-eval-cli';
import type { FetchLike } from '../selector-rag/embed';
import { generateMemorySet, memoryDigest, MEMORY_SEED, MEMORY_VERSION, type MemorySet } from './memory-set';
import { IMPLEMENTATION_FILES, RUNTIME_CONSTANTS, STAGE_R_PARAMETERS, implementationHashes, runArmFresh, runtimePrefixesOf, seededUpdatedAt, stageRDigest, type RuntimeEmbeddingProvider, type StageRInputs } from './stage-r';

const scratch = mkdtempSync(join(tmpdir(), 'stage-r-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------- a small hand-made set: 60 memories, one query each (the pool cap is 50)

const WORDS = ['copper', 'lantern', 'harbor', 'violet', 'orchard', 'granite', 'saffron', 'meadow', 'compass', 'thistle'];
const SIZE = 60;
const smallSet = (): MemorySet => ({
  memories: Array.from({ length: SIZE }, (_, at) => ({ id: `mem-${at}`, language: 'en' as const, text: `note ${at} about ${WORDS[at % 10]} ${WORDS[(at * 3 + 1) % 10]} item${at}x`, long: false, factOffsets: [] })),
  queries: Array.from({ length: SIZE }, (_, at) => ({ id: `q-${at}`, language: 'en' as const, text: `what about item${at}x ${WORDS[at % 10]}`, gold: [`mem-${at}`], mode: 'shared' as const, sharedTerms: 2, targetLong: false, factIndex: null, beyondCut: false })),
});

const DIM = 64;
const hashOf = (term: string): number => {
  let h = 2166136261;
  for (const ch of term) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
  return h;
};
/** Bag-of-terms hashing "embedding" with a constant bias dimension, so no vector is ever zero. */
const embedText = (text: string): number[] => {
  const vector = new Array<number>(DIM).fill(0);
  for (const term of chunking.lexicalTerms(text)) vector[hashOf(term) % DIM] = (vector[hashOf(term) % DIM] as number) + 1;
  vector[0] = (vector[0] as number) + 0.01;
  return vector;
};
function fakeProvider(model = 'fake-embed'): RuntimeEmbeddingProvider & { calls: () => number } {
  let calls = 0;
  return {
    id: 'fake-embed',
    capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }],
    executionLocality: 'LOCAL',
    isAvailable: async () => true,
    execute: async (request) => {
      calls += 1;
      return { text: formatEmbeddingEnvelope(embedText(request.prompt), model), raw: {}, audit: { model } } as never;
    },
    calls: () => calls,
  } as AiProvider & { calls: () => number };
}

describe('stage R: the runtime path on a set larger than the candidate pool', () => {
  it('reports the share of queries whose gold memory is outside the recent-50 pool (lexical arm, no model)', async () => {
    const set = smallSet();
    const run = await runArmFresh({ arm: 'L', mode: 'lexical', set, tmpRoot: scratch });
    const stamps = seededUpdatedAt(set);
    const newest50 = new Set([...stamps.entries()].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).slice(0, 50).map(([id]) => id));
    const expectedOut = set.queries.filter((query) => !newest50.has(query.gold[0] as string)).length;
    expect(expectedOut).toBe(10);
    expect(run.diagnostics.goldNotInPool).toEqual({ n: 10, share: Math.round((10 / SIZE) * 10_000) / 10_000 });
    expect(run.diagnostics.poolSize).toEqual({ min: 50, max: 50 });
    expect(run.diagnostics.goldNoSemanticScore).toBeNull();
    // a gold outside the pool can never be returned
    const returnedAtMost = SIZE - expectedOut;
    expect(Math.round(run.metrics.overall.recallAt5 * SIZE)).toBeLessThanOrEqual(returnedAtMost);
  });

  it('timestamps are deterministic from the recorded seed and span the configured window', () => {
    const set = smallSet();
    const a = seededUpdatedAt(set);
    const b = seededUpdatedAt(set);
    expect([...a]).toEqual([...b]);
    const times = [...a.values()].map((value) => Date.parse(value));
    expect(Math.max(...times)).toBeLessThanOrEqual(Date.parse('2026-11-06T00:00:00.000Z'));
    expect(Date.parse('2026-11-06T00:00:00.000Z') - Math.min(...times)).toBeLessThanOrEqual(180 * 24 * 3_600_000);
    expect(new Set(times).size).toBe(SIZE);
  });

  it('live mode embeds lazily (at most 4 new documents per turn); warm mode has every memory scored first', async () => {
    const set = smallSet();
    const liveProvider = fakeProvider();
    const live = await runArmFresh({ arm: 'E0', mode: 'live', set, provider: liveProvider, tmpRoot: scratch });
    const warmProvider = fakeProvider();
    const warm = await runArmFresh({ arm: 'E0', mode: 'warm', set, provider: warmProvider, tmpRoot: scratch });

    expect(live.prewarm).toBeNull();
    expect(live.diagnostics.embeddedDocuments).toBeLessThanOrEqual(4 * SIZE);
    // the 50-memory pool needs ceil(50 / 4) = 13 turns to be fully embedded, so early queries find their gold unscored
    expect(live.diagnostics.goldInPoolNoSemanticScore?.n).toBeGreaterThan(0);
    expect(live.diagnostics.goldNoSemanticScore?.n).toBeGreaterThanOrEqual(live.diagnostics.goldNotInPool.n);

    expect(warm.prewarm).toMatchObject({ stored: SIZE, of: SIZE, missing: 0 });
    expect(warm.diagnostics.embeddedDocuments).toBe(0);
    expect(warm.diagnostics.goldInPoolNoSemanticScore?.n).toBe(0);
    // the pool is the recent 50 plus the semantic nearest; every gold is scored
    expect(warm.diagnostics.goldNoSemanticScore?.n).toBe(warm.diagnostics.goldNotInPool.n);
    // P2-2 candidate widening: with every vector stored, an old memory outside the recent 50 is a candidate again
    expect(warm.diagnostics.goldNotInPool.n).toBe(0);
    expect(warm.diagnostics.goldNoSemanticScore?.n).toBe(0);
    expect(warm.diagnostics.poolSize.max).toBeGreaterThan(50);
    expect(warm.metrics.overall.recallAt5).toBeGreaterThan(0.9);
    expect(warm.metrics.overall.recallAt5).toBeGreaterThanOrEqual(live.metrics.overall.recallAt5);
    expect(warm.diagnostics.goldNoSemanticScore?.n).toBeLessThanOrEqual(live.diagnostics.goldNoSemanticScore?.n as number);
    // the fake saw the document embeddings of the pre-warm and only query embeddings afterwards
    expect(warmProvider.calls()).toBeGreaterThan(SIZE);
  });
});

describe('stage R: backfilled mode runs the real backfill job before the queries', () => {
  it('stores every vector unit through the job, then measures like warm; live stays a fresh switch without backfill', async () => {
    const set = smallSet();
    const live = await runArmFresh({ arm: 'E0', mode: 'live', set, provider: fakeProvider(), tmpRoot: scratch });
    const backfilled = await runArmFresh({ arm: 'E0', mode: 'backfilled', set, provider: fakeProvider(), tmpRoot: scratch });
    expect(live.prewarm).toBeNull();
    expect(backfilled.invalid).toBeNull();
    expect(backfilled.prewarm).toMatchObject({ stored: SIZE, of: SIZE, missing: 0 });
    expect(backfilled.diagnostics.embeddedDocuments).toBe(0);
    expect(backfilled.diagnostics.goldNotInPool.n).toBe(0);
    expect(backfilled.metrics.overall.recallAt5).toBeGreaterThan(0.9);
    expect(backfilled.metrics.overall.recallAt5).toBeGreaterThan(live.metrics.overall.recallAt5);
  }, 60_000);

  it('an arm the job cannot complete is INVALID with the missing count', async () => {
    const inner = fakeProvider();
    const stuck = { ...inner, execute: async (request: Parameters<typeof inner.execute>[0]) => { if (request.prompt.includes('note 7 ')) throw new Error('embedding failed'); return inner.execute(request); } } as RuntimeEmbeddingProvider;
    const run = await runArmFresh({ arm: 'E0', mode: 'backfilled', set: smallSet(), provider: stuck, tmpRoot: scratch });
    expect(run.invalid?.missing).toBeGreaterThan(0);
    expect(run.diagnostics.queries).toBe(0);
  }, 60_000);
});

describe('stage R: the real CH7 set on the lexical arm', () => {
  it('runs all 192 queries through sqlite and the retriever with a 50-memory pool', async () => {
    const run = await runArmFresh({ arm: 'L', mode: 'lexical', set: generateMemorySet(), tmpRoot: scratch });
    expect(run.metrics.overall.n).toBe(192);
    expect(run.diagnostics.poolSize.max).toBe(50);
    expect(run.diagnostics.goldNotInPool.share).toBeGreaterThan(0.4);
  });
});

describe('stage R: the real provider supplies its own prefixes', () => {
  it('nomic-embed-text gets the nomic prefixes; embeddinggemma gets its model-card prefixes (P2-2)', async () => {
    expect(await runtimePrefixesOf('nomic-embed-text')).toEqual({ query: 'search_query: ', document: 'search_document: ' });
    expect(await runtimePrefixesOf('embeddinggemma:300m')).toEqual({ query: 'task: search result | query: ', document: 'title: none | text: ' });
  });
});

// ---------------------------------------------------------------- the CLI: plan digest gating, dropped arm

function harness(models: Record<string, string> = { 'nomic-embed-text:latest': 'a'.repeat(64), 'embeddinggemma:300m': 'e'.repeat(64) }) {
  const set = smallSet();
  const out: string[] = [];
  const err: string[] = [];
  const reports: Array<{ name: string; report: unknown }> = [];
  let providerBuilt = 0;
  const fetchImpl: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (path === '/api/version') return reply({ version: '0.40.14' });
    if (path === '/api/tags') return reply({ models: Object.entries(models).map(([name, digest]) => ({ name, digest, size: 1000 })) });
    return reply({});
  };
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-11-06T12:00:00.000Z'),
    corpus: () => [],
    readFreeze: () => undefined,
    writeFreeze: () => undefined,
    writeReport: (_dir, name, report) => {
      reports.push({ name, report });
      return `/mem/${name}`;
    },
    memory: { corpus: () => set, readFreeze: () => ({ version: MEMORY_VERSION, seed: MEMORY_SEED, cases: set.memories.length + set.queries.length, sha256: memoryDigest(set) }), writeFreeze: () => undefined },
    embed: { fetch: fetchImpl },
    runtime: {
      provider: (model) => {
        providerBuilt += 1;
        return fakeProvider(model);
      },
      tmpRoot: scratch,
    },
  };
  return { deps, out, err, reports, built: () => providerBuilt };
}
const digestOf = (out: string[]): string => /plan digest: ([0-9a-f]{64})/u.exec(out.join('\n'))?.[1] as string;
const base = ['--set', 'memory', '--stage', 'R', '--arms', 'L,E0,E4'];

describe('stage R: CLI gating and reporting', () => {
  it('parses stage R and rejects a probe or an unknown arm', () => {
    expect(parseArguments([...base, '--mode', 'plan']).stageRArms).toEqual(['L', 'E0', 'E4']);
    expect(() => parseArguments([...base, '--mode', 'probe'])).toThrow(/no probe/);
    expect(() => parseArguments(['--set', 'memory', '--stage', 'R', '--arms', 'E1', '--mode', 'plan'])).toThrow(/--arms must be/);
  });

  it('plan mode makes no model call, prints the pins, the runtime prefixes, the seed and a digest; run needs that digest', async () => {
    const h = harness();
    expect(await runCli([...base, '--mode', 'plan'], h.deps)).toBe(EXIT_OK);
    expect(h.built()).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('nomic-embed-text@aaaaaaaaaaaa');
    expect(text).toContain('embeddinggemma:300m@eeeeeeeeeeee');
    expect(text).toContain('quoky-adr-0124-p2-1-runtime-recall-2026-11-06');
    const digest = digestOf(h.out);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);

    const missing = harness();
    expect(await runCli([...base, '--mode', 'run'], missing.deps)).toBe(EXIT_BLOCKED);
    expect(missing.err.join('\n')).toContain('needs --plan-digest');
    expect(missing.built()).toBe(0);
    const wrong = harness();
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', 'f'.repeat(64)], wrong.deps)).toBe(EXIT_BLOCKED);
    expect(wrong.built()).toBe(0);
    // a different arm list or a changed pin changes the digest
    const other = harness();
    await runCli(['--set', 'memory', '--stage', 'R', '--arms', 'L,E0', '--mode', 'plan'], other.deps);
    expect(digestOf(other.out)).not.toBe(digest);
    const repinned = harness({ 'nomic-embed-text:latest': 'b'.repeat(64), 'embeddinggemma:300m': 'e'.repeat(64) });
    await runCli([...base, '--mode', 'plan'], repinned.deps);
    expect(digestOf(repinned.out)).not.toBe(digest);
  });

  it('a run with the right digest reports live and warm per semantic arm plus the lexical arm, NON-GATING', async () => {
    const plan = harness();
    await runCli([...base, '--mode', 'plan'], plan.deps);
    const digest = digestOf(plan.out);
    const run = harness();
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', digest], run.deps)).toBe(EXIT_NON_GATING);
    const report = run.reports.find((entry) => entry.name.startsWith('chunk-eval-memory-stage-r-'))?.report as { status: string; runs: Array<{ arm: string; mode: string }> };
    expect(report.status).toBe('NON-GATING');
    expect(report.runs.map((r) => `${r.arm}/${r.mode}`)).toEqual(['L/lexical', 'E0/live', 'E0/backfilled', 'E0/warm', 'E4/live', 'E4/backfilled', 'E4/warm']);
    expect(run.out.join('\n')).toContain('E4/warm:');
  }, 60_000);

  it('drops an arm whose model is not installed with a note and runs the rest (never pulls)', async () => {
    const models = { 'nomic-embed-text:latest': 'a'.repeat(64) };
    const plan = harness(models);
    expect(await runCli([...base, '--mode', 'plan'], plan.deps)).toBe(EXIT_OK);
    expect(plan.out.join('\n')).toMatch(/dropped: E4 \(embedding model embeddinggemma:300m is not installed/u);
    const digest = digestOf(plan.out);
    const run = harness(models);
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', digest], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.out.join('\n')).toContain('dropped E4:');
    const report = run.reports.find((entry) => entry.name.startsWith('chunk-eval-memory-stage-r-'))?.report as { runs: Array<{ arm: string }> };
    expect(report.runs.some((r) => r.arm === 'E4')).toBe(false);
    expect(run.built()).toBe(3);
  }, 60_000);
});


describe('stage R: daemon rule', () => {
  it('rejects an --ollama-url that is not the default daemon (USAGE) and an OLLAMA_HOST pointing elsewhere', async () => {
    const other = harness();
    expect(await runCli([...base, '--mode', 'plan', '--ollama-url', 'http://127.0.0.1:12345'], other.deps)).toBe(EXIT_USAGE);
    expect(other.err.join('\n')).toContain('not the default daemon');
    const hosted = harness();
    hosted.deps.env = { OLLAMA_HOST: '10.0.0.5:11434' };
    expect(await runCli([...base, '--mode', 'plan'], hosted.deps)).toBe(EXIT_USAGE);
    expect(hosted.err.join('\n')).toContain('OLLAMA_HOST');
    expect(hosted.built()).toBe(0);
    const same = harness();
    same.deps.env = { OLLAMA_HOST: '127.0.0.1:11434' };
    expect(await runCli([...base, '--mode', 'plan', '--ollama-url', 'http://127.0.0.1:11434'], same.deps)).toBe(EXIT_OK);
  });
});

describe('stage R: the plan digest binds parameters and implementation identity', () => {
  it('the hashed implementation list covers the chunker, the passage mapping and the shared production wiring', () => {
    for (const file of ['packages/core/src/application/recall/memory-passages.ts', 'packages/core/src/application/chunking/passages.ts', 'packages/core/src/application/chunking/boundaries.ts', 'packages/core/src/application/chunking/code-points.ts', 'packages/core/src/application/chunking/token-estimate.ts', 'apps/quoky/src/context-builder-provider.ts', 'apps/quoky/src/memory-vector-backfill.ts']) {
      expect(IMPLEMENTATION_FILES).toContain(file);
    }
    // every non-test source file of the chunker is hashed
    const dir = join(__dirname, '../../../../../packages/core/src/application/chunking');
    const sources = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    for (const name of sources) expect(IMPLEMENTATION_FILES).toContain(`packages/core/src/application/chunking/${name}`);
  });

  const inputs: StageRInputs = { set: { digest: 'd'.repeat(64), memories: 1, queries: 1 }, planned: ['L'], pins: [], dropped: [] };
  it('changes with any runtime parameter or any source hash, and a run with a stale digest is BLOCKED', async () => {
    const hashes = implementationHashes();
    const reference = stageRDigest(inputs, STAGE_R_PARAMETERS, hashes);
    expect(stageRDigest(inputs)).toBe(reference);
    for (const key of ['maxNewEmbeddingsPerTurn', 'embeddingTimeoutMs', 'semanticTurnBudgetMs', 'vectorQueryLimit', 'maxEmbeddingInputChars', 'candidateFetchMultiplier', 'candidateFetchMin', 'recencyWeight', 'recencyHalfLifeMs', 'semanticWeight', 'maxResults'] as const) {
      expect(RUNTIME_CONSTANTS[key]).toBeGreaterThan(0);
      const changed = { ...STAGE_R_PARAMETERS, runtime: { ...RUNTIME_CONSTANTS, [key]: RUNTIME_CONSTANTS[key] + 1 } };
      expect(stageRDigest(inputs, changed, hashes)).not.toBe(reference);
    }
    expect(stageRDigest(inputs, { ...STAGE_R_PARAMETERS, runtime: { ...RUNTIME_CONSTANTS, authorityFitness: ['USER_CLAIM_OR_INTENT'] } }, hashes)).not.toBe(reference);
    expect(Object.keys(hashes).sort()).toEqual([...IMPLEMENTATION_FILES].sort());
    for (const file of IMPLEMENTATION_FILES) expect(stageRDigest(inputs, STAGE_R_PARAMETERS, { ...hashes, [file]: '0'.repeat(64) })).not.toBe(reference);

    const plan = harness();
    await runCli([...base, '--mode', 'plan'], plan.deps);
    expect(digestOf(plan.out)).toMatch(/^[0-9a-f]{64}$/u);
    const run = harness();
    const stale = stageRDigest({ set: { digest: memoryDigest(smallSet()), memories: SIZE, queries: SIZE }, planned: ['L', 'E0', 'E4'], pins: [], dropped: [] }, { ...STAGE_R_PARAMETERS, runtime: { ...RUNTIME_CONSTANTS, recencyWeight: 0.9 } });
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', stale], run.deps)).toBe(EXIT_BLOCKED);
    expect(run.built()).toBe(0);
  });

  it('literals that production does not export match the production source', () => {
    const root = join(__dirname, '../../../../..');
    const read = (file: string): string => readFileSync(join(root, file), 'utf8');
    const retriever = read('packages/core/src/application/memory-retriever.ts');
    expect(retriever).toContain(`const CANDIDATE_FETCH_MULTIPLIER = ${RUNTIME_CONSTANTS.candidateFetchMultiplier};`);
    expect(retriever).toContain(`const MIN_CANDIDATE_FETCH = ${RUNTIME_CONSTANTS.candidateFetchMin};`);
    expect(retriever).toContain(`export const SEMANTIC_CANDIDATE_TOP_K = ${RUNTIME_CONSTANTS.semanticCandidateTopK};`);
    expect(retriever).toContain(`const DEFAULT_RECENCY_WEIGHT = ${RUNTIME_CONSTANTS.recencyWeight};`);
    expect(retriever).toContain('const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;');
    const builder = read('packages/core/src/application/context-builder.ts');
    expect(builder).toContain(`const DURABLE_RECALL_LIMIT = ${RUNTIME_CONSTANTS.maxResults};`);
    for (const level of RUNTIME_CONSTANTS.authorityFitness) expect(builder).toContain(`'${level}',`);
    expect(read('apps/quoky/src/config.ts')).toContain(`const DEFAULT_EMBEDDING_TIMEOUT_MS = ${RUNTIME_CONSTANTS.embeddingTimeoutMs};`);
  });
});

describe('stage R: warm prewarming must be complete', () => {
  const stuckProvider = (): RuntimeEmbeddingProvider => {
    const inner = fakeProvider();
    return {
      ...inner,
      execute: async (request) => {
        if (request.prompt.includes('note 7 ')) throw new Error('embedding failed');
        return inner.execute(request);
      },
    } as RuntimeEmbeddingProvider;
  };
  it('an arm whose memories cannot all be embedded is INVALID with the missing count and runs no queries', async () => {
    const run = await runArmFresh({ arm: 'E0', mode: 'warm', set: smallSet(), provider: stuckProvider(), tmpRoot: scratch });
    expect(run.invalid).not.toBeNull();
    expect(run.invalid?.missing).toBeGreaterThan(0);
    expect(run.prewarm?.missing).toBe(run.invalid?.missing);
    expect(run.diagnostics.queries).toBe(0);
  }, 60_000);

  it('the CLI reports it and exits INVALID (5), still writing the report', async () => {
    const plan = harness();
    await runCli([...base, '--mode', 'plan'], plan.deps);
    const run = harness();
    run.deps.runtime = { ...run.deps.runtime, provider: () => stuckProvider() };
    expect(await runCli([...base, '--mode', 'run', '--plan-digest', digestOf(plan.out)], run.deps)).toBe(EXIT_INVALID);
    expect(run.out.join('\n')).toContain('E0/warm: INVALID');
    expect(run.reports.some((entry) => entry.name.startsWith('chunk-eval-memory-stage-r-'))).toBe(true);
  }, 60_000);
});
