/**
 * ADR-0124 phase 1 stage E: the local cross-encoder (integrity, tokenization helpers, ordering, sanity check) and the stage E arms,
 * plan v3 and CLI. Fakes only; the single real-model test runs only when QUOKY_CROSS_ENCODER_DIR is set.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_INVALID, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, parseArguments, runCli, type CliDeps } from '../chunk-eval-cli';
import type { FetchLike } from '../selector-rag/embed';
import { buildCase, corpusDigest, CORPUS_SEED, CORPUS_VERSION } from './corpus';
import { buildCaseV2, corpusV2Digest, CORPUS_V2_SEED, CORPUS_V2_VERSION, type ChunkEvalCaseV2 } from './corpus-v2';
import { ARM_IDS, ARM_SPECS, STAGE_E_ARM_IDS, pinArm } from './embed-arms';
import { generateMemorySet, memoryDigest, MEMORY_SEED, MEMORY_VERSION } from './memory-set';
import {
  CROSS_ENCODER_FILES,
  CROSS_ENCODER_MODEL_FILE,
  CROSS_ENCODER_RUNTIME,
  OnnxCrossEncoder,
  crossEncoderPin,
  orderByScore,
  padBatch,
  sanityCheck,
  truncatePairIds,
  verifyModelDir,
  type PairScorer,
} from './cross-encoder';
import { MEMORY_LATENCY_QUERIES, decideStageD, type FirstStage, type StageDDecisionInput } from './stage-d';
import {
  STAGE_E_PARAMETERS,
  crossBase,
  crossTopN,
  decisionInputsE,
  limitStage,
  parseStageEArm,
  reorderRanking,
  runCrossArm,
  stageEDigest,
  stageEPlanned,
  type StageEInputs,
} from './stage-e';

const scratch = mkdtempSync(join(tmpdir(), 'chunk-cross-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A small fake model directory: the pinned file names with arbitrary content, and a SHA256SUMS that matches it. */
function fakeModelDir(name: string): { dir: string; expected: Record<string, string> } {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const expected: Record<string, string> = {};
  const lines: string[] = [];
  for (const path of Object.keys(CROSS_ENCODER_FILES)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `content of ${path}`);
    expected[path] = sha(`content of ${path}`);
    lines.push(`${expected[path]}  ${path}`);
  }
  writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return { dir, expected };
}

// ---------------------------------------------------------------- integrity (fail closed)

describe('verifyModelDir', () => {
  it('passes on an intact directory and returns every verified hash', async () => {
    const { dir, expected } = fakeModelDir('ok');
    expect(await verifyModelDir(dir, expected)).toEqual(expected);
  });

  it('throws when a file was tampered with, is missing, or SHA256SUMS lists a different or extra file', async () => {
    const tampered = fakeModelDir('tamper');
    writeFileSync(join(tampered.dir, 'tokenizer.json'), 'something else');
    await expect(verifyModelDir(tampered.dir, tampered.expected)).rejects.toThrow(/tokenizer\.json does not match its sha256/u);

    const missing = fakeModelDir('missing');
    rmSync(join(missing.dir, CROSS_ENCODER_MODEL_FILE));
    await expect(verifyModelDir(missing.dir, missing.expected)).rejects.toThrow(/file is missing/u);

    const noSums = fakeModelDir('nosums');
    rmSync(join(noSums.dir, 'SHA256SUMS'));
    await expect(verifyModelDir(noSums.dir, noSums.expected)).rejects.toThrow(/SHA256SUMS is missing/u);

    const dropped = fakeModelDir('dropped');
    writeFileSync(join(dropped.dir, 'SHA256SUMS'), readFileSync(join(dropped.dir, 'SHA256SUMS'), 'utf8').split('\n').slice(1).join('\n'));
    await expect(verifyModelDir(dropped.dir, dropped.expected)).rejects.toThrow(/does not list/u);

    const extra = fakeModelDir('extra');
    writeFileSync(join(extra.dir, 'SHA256SUMS'), `${readFileSync(join(extra.dir, 'SHA256SUMS'), 'utf8')}${sha('x')}  extra.bin\n`);
    await expect(verifyModelDir(extra.dir, extra.expected)).rejects.toThrow(/unexpected file extra\.bin/u);

    // an inherited name (Object.prototype) is still an unexpected entry (Codex P2)
    const inherited = fakeModelDir('inherited');
    writeFileSync(join(inherited.dir, 'SHA256SUMS'), `${readFileSync(join(inherited.dir, 'SHA256SUMS'), 'utf8')}${sha('x')}  toString\n`);
    await expect(verifyModelDir(inherited.dir, inherited.expected)).rejects.toThrow(/unexpected file toString/u);

    const forged = fakeModelDir('forged');
    writeFileSync(join(forged.dir, 'config.json'), 'forged');
    writeFileSync(join(forged.dir, 'SHA256SUMS'), readFileSync(join(forged.dir, 'SHA256SUMS'), 'utf8').replace(forged.expected['config.json'] as string, sha('forged')));
    await expect(verifyModelDir(forged.dir, forged.expected)).rejects.toThrow(/hash for config\.json differs from the pin/u);

    const unsafe = fakeModelDir('unsafe');
    writeFileSync(join(unsafe.dir, 'SHA256SUMS'), `${sha('x')}  ../outside\n`);
    await expect(verifyModelDir(unsafe.dir, unsafe.expected)).rejects.toThrow(/unsafe path/u);
  });

  it('the real loader refuses an unverifiable directory before reading any model file', async () => {
    const { dir } = fakeModelDir('load');
    await expect(OnnxCrossEncoder.load(dir)).rejects.toThrow(/differs from the pin|does not match/u);
  });

  it('pins the two devDependencies to the exact versions of apps/quoky/package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['onnxruntime-node']).toBe(CROSS_ENCODER_RUNTIME.onnxruntimeNode);
    expect(pkg.devDependencies['@huggingface/tokenizers']).toBe(CROSS_ENCODER_RUNTIME.huggingfaceTokenizers);
  });
});

// ---------------------------------------------------------------- tokenization helpers and ordering

describe('pair helpers', () => {
  it('truncates from the passage side and keeps the closing special token', () => {
    expect(truncatePairIds([0, 5, 2, 2, 7, 8, 9, 2], 8, 2)).toEqual([0, 5, 2, 2, 7, 8, 9, 2]);
    expect(truncatePairIds([0, 5, 2, 2, 7, 8, 9, 10, 11, 2], 7, 2)).toEqual([0, 5, 2, 2, 7, 8, 2]);
  });

  it('refuses a query that leaves no room for the separators and a passage token (Codex P2)', () => {
    // query of 4 tokens: <s> q q q q </s></s> p p </s> = 10 ids; max 7 cannot keep `</s></s> p </s>` after the query
    expect(() => truncatePairIds([0, 5, 6, 7, 8, 2, 2, 9, 10, 2], 7, 2)).toThrow(/query is too long/u);
    // max 9 keeps the whole query, both separators, one passage token and the closing token
    expect(truncatePairIds([0, 5, 6, 7, 8, 2, 2, 9, 10, 2], 9, 2)).toEqual([0, 5, 6, 7, 8, 2, 2, 9, 2]);
  });

  it('pads dynamically to the batch longest row', () => {
    const batch = padBatch([[0, 4, 2], [0, 4, 5, 6, 2]], 1);
    expect(batch.length).toBe(5);
    expect(Array.from(batch.inputIds)).toEqual([0n, 4n, 2n, 1n, 1n, 0n, 4n, 5n, 6n, 2n]);
    expect(Array.from(batch.attentionMask)).toEqual([1n, 1n, 1n, 0n, 0n, 1n, 1n, 1n, 1n, 1n]);
  });

  it('orders by descending score and keeps first-stage order on ties', () => {
    expect(orderByScore([0.1, 0.9, 0.5, 0.9])).toEqual([1, 3, 2, 0]);
  });

  it('a fake scorer decides the order; the sanity check needs the relevant pair to win', async () => {
    const words = (text: string): Set<string> => new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []));
    const overlap: PairScorer = { score: async (query, passages) => passages.map((passage) => [...words(passage)].filter((word) => words(query).has(word)).length) };
    expect((await sanityCheck(overlap)).ok).toBe(true);
    const inverted: PairScorer = { score: async (query, passages) => (await overlap.score(query, passages)).map((value) => -value) };
    expect((await sanityCheck(inverted)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- arms

describe('stage E arms', () => {
  it('parses X, X50, E4 and the stage D arms; E4 is not an arm of stages A-D', () => {
    expect(parseStageEArm('X(E2)')).toBe('X(E2)');
    expect(parseStageEArm('X50(E4)')).toBe('X50(E4)');
    expect(parseStageEArm('E4')).toBe('E4');
    expect(parseStageEArm('R(E1)')).toBe('R(E1)');
    expect(parseStageEArm('X(E9)')).toBeUndefined();
    expect(parseStageEArm('X20(E1)')).toBeUndefined();
    expect([...ARM_IDS]).toEqual(['E0', 'E1', 'E2', 'E3']);
    expect([...STAGE_E_ARM_IDS]).toEqual(['E0', 'E1', 'E2', 'E3', 'E4']);
    expect(crossBase('X50(E2)')).toBe('E2');
    expect([crossTopN('X(E1)'), crossTopN('X50(E1)')]).toEqual([20, 50]);
  });

  it('plans E0 always, the embedders of every X arm, then the X arms in the given order', () => {
    expect(stageEPlanned(['X50(E2)', 'E1', 'X(E1)'])).toEqual({ planned: ['E0', 'E1', 'X50(E2)', 'X(E1)'], embedderIds: ['E0', 'E1', 'E2'], rerankArms: [], crossArms: ['X50(E2)', 'X(E1)'] });
  });

  it('the pinned E0-E3 specs are unchanged and E4 carries the EmbeddingGemma card prompts', () => {
    expect(ARM_SPECS.E0).toMatchObject({ model: 'nomic-embed-text', queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' });
    expect(ARM_SPECS.E1.model).toBe('nomic-embed-text-v2-moe');
    expect(ARM_SPECS.E2).toMatchObject({ model: 'bge-m3', queryPrefix: '', documentPrefix: '' });
    expect(ARM_SPECS.E3.model).toBe('qwen3-embedding:0.6b');
    expect(ARM_SPECS.E4).toMatchObject({ model: 'embeddinggemma:300m', queryPrefix: 'task: search result | query: ', documentPrefix: 'title: none | text: ' });
  });

  const memory = generateMemorySet();
  const identity: FirstStage[] = memory.queries.map(() => ({ ranking: memory.memories.map((_, at) => at), candidates: memory.memories.slice(0, 50).map((m) => ({ id: m.id, text: m.text })) }));

  it('reorders the top N by score and keeps the ranks beyond N', () => {
    const stage: FirstStage = { ranking: [5, 3, 9, 1, 7, 2], candidates: [{ id: 'a', text: '' }, { id: 'b', text: '' }, { id: 'c', text: '' }] };
    expect(reorderRanking(stage, [0.1, 0.9, 0.5])).toEqual([3, 9, 5, 1, 7, 2]);
    expect(() => reorderRanking(stage, [1])).toThrow(/returned 1 scores for 3 candidates/u);
    expect(limitStage({ ranking: stage.ranking, candidates: stage.candidates }, 2).candidates.length).toBe(2);
  });

  it('runs an oracle and an anti-oracle scorer: only the top N moves, X50 scores 50 candidates per query, latency is per query', async () => {
    const goldTextOf = new Map(memory.queries.map((query) => [query.text, memory.memories.find((m) => query.gold.includes(m.id))?.text as string]));
    const seen: number[] = [];
    const oracle: PairScorer = { score: async (query, passages) => (seen.push(passages.length), passages.map((passage) => (passage === goldTextOf.get(query) ? 1 : 0))) };
    let now = 0;
    const clock = (): number => (now += 5);
    const x = await runCrossArm(oracle, 'E1', 20, memory, identity, clock);
    expect(new Set(seen)).toEqual(new Set([20]));
    expect(x.pairsScored).toBe(20 * memory.queries.length);
    expect(x.latencyMs).toEqual({ p50: 5, p95: 5, max: 5, queries: memory.queries.length });
    const goldAt = memory.queries.map((query) => memory.memories.findIndex((m) => query.gold.includes(m.id)));
    const expectedHits = goldAt.filter((at) => at < 20 || at < 5).length / goldAt.length;
    expect(x.metrics.overall.recallAt5).toBeCloseTo(expectedHits, 3);
    expect(x.firstStageRecallAtN.n).toBe(20);
    seen.length = 0;
    const x50 = await runCrossArm(oracle, 'E1', 50, memory, identity, clock);
    expect(new Set(seen)).toEqual(new Set([50]));
    expect(x50.metrics.overall.recallAt5).toBeGreaterThanOrEqual(x.metrics.overall.recallAt5);
    const anti: PairScorer = { score: async (query, passages) => passages.map((passage) => (passage === goldTextOf.get(query) ? -1 : 0)) };
    const bad = await runCrossArm(anti, 'E1', 20, memory, identity, clock);
    expect(bad.metrics.overall.recallAt5).toBeLessThan(x.metrics.overall.recallAt5);
  });

  const input = (extra: Partial<StageDDecisionInput> & { arm: string; ko: number; en: number }): StageDDecisionInput => ({ kind: extra.arm.startsWith('X') ? 'rerank' : 'embedder', koRecallAt5: extra.ko, enRecallAt5: extra.en, mixedRecallAt5: extra.en, paramsM: 100, sizeBytes: 1000, memoryP95Ms: 100, latencyMeetsBar: true, latencyReason: null, ...extra });

  it('the decision includes X arms; an X arm counts embedder plus reranker for the tie-break', () => {
    const verdict = decideStageD(['E0', 'E1', 'X(E1)'], [input({ arm: 'E0', ko: 0.4, en: 0.9 }), input({ arm: 'E1', ko: 0.9, en: 0.9 }), input({ arm: 'X(E1)', ko: 0.9, en: 0.9, paramsM: 668 })]);
    expect(verdict.chosen).toBe('E1');
    const better = decideStageD(['E0', 'E1', 'X(E1)'], [input({ arm: 'E0', ko: 0.4, en: 0.9 }), input({ arm: 'E1', ko: 0.7, en: 0.9 }), input({ arm: 'X(E1)', ko: 0.96, en: 0.95, paramsM: 668 })]);
    expect(better).toMatchObject({ verdict: 'CHOOSE', chosen: 'X(E1)' });
    expect(better.inputs.find((i) => i.arm === 'X(E1)')?.reachesTarget.ko).toBe(true);
  });

  it('decisionInputsE adds one input per X arm from its first stage embedder latency and size plus the reranker', async () => {
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (path === '/api/version') return reply({ version: '0.40.14' });
      if (path === '/api/tags') return reply({ models: [{ name: 'bge-m3:latest', digest: 'c'.repeat(64), size: 1000 }] });
      return reply({ details: { parameter_size: '566.70M' } });
    };
    const pin = await pinArm(ARM_SPECS.E2, undefined, fetchImpl);
    const run = { pin, memoryPathLatency: { p95: 33, meetsBar: true, reason: null }, multi: { byLanguage: {} } } as never;
    const crossRun = { base: 'E2', metrics: { byLanguage: { ko: { recallAt5: 0.97 }, en: { recallAt5: 0.9 }, mixed: { recallAt5: 0.95 } } } } as never;
    const inputs = decisionInputsE({ E2: run }, {}, { 'X(E2)': crossRun }, null);
    expect(inputs.find((i) => i.arm === 'X(E2)')).toMatchObject({ kind: 'rerank', koRecallAt5: 0.97, paramsM: 566.7 + 568, memoryP95Ms: 33, latencyMeetsBar: true });
  });

  it('the plan digest changes with revision, a file sha256, N, max_length, batch, threads, runtime versions and the arms', async () => {
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (path === '/api/version') return reply({ version: '0.40.14' });
      if (path === '/api/tags') return reply({ models: [{ name: 'bge-m3:latest', digest: 'c'.repeat(64), size: 1000 }] });
      return reply({ details: { parameter_size: '566.70M' } });
    };
    const e2 = await pinArm(ARM_SPECS.E2, undefined, fetchImpl);
    const base: StageEInputs = { sets: { memory: { digest: 'm'.repeat(64) }, v2: { digest: 'v'.repeat(64) } }, planned: ['E0', 'E2', 'X(E2)'], resolved: { planned: ['E2'], available: [e2], dropped: [] }, reranker: null, crossEncoder: crossEncoderPin(), dropped: [] };
    const digest = stageEDigest(base);
    expect(stageEDigest(base)).toBe(digest);
    const pin = base.crossEncoder as NonNullable<typeof base.crossEncoder>;
    expect(stageEDigest({ ...base, crossEncoder: { ...pin, revision: 'f'.repeat(40) } })).not.toBe(digest);
    expect(stageEDigest({ ...base, crossEncoder: { ...pin, files: { ...pin.files, [CROSS_ENCODER_MODEL_FILE]: 'f'.repeat(64) } } })).not.toBe(digest);
    expect(stageEDigest({ ...base, crossEncoder: { ...pin, runtime: { ...pin.runtime, onnxruntimeNode: '9.9.9' } } })).not.toBe(digest);
    expect(stageEDigest({ ...base, crossEncoder: { ...pin, runtime: { ...pin.runtime, huggingfaceTokenizers: '9.9.9' } } })).not.toBe(digest);
    const cross = STAGE_E_PARAMETERS.cross;
    for (const change of [{ topN: 10 }, { topNLarge: 100 }, { maxLength: 256 }, { batch: 16 }, { intraOpThreads: 2 }, { candidateText: 'capped' }])
      expect(stageEDigest(base, { ...STAGE_E_PARAMETERS, cross: { ...cross, ...change } })).not.toBe(digest);
    expect(stageEDigest(base, { ...STAGE_E_PARAMETERS, decision: { ...STAGE_E_PARAMETERS.decision, englishToleranceBp: 100 } })).not.toBe(digest);
    expect(stageEDigest({ ...base, planned: ['E0', 'E2'] })).not.toBe(digest);
    expect(stageEDigest({ ...base, crossEncoder: null })).not.toBe(digest);
  });
});

// ---------------------------------------------------------------- CLI (fake daemon, fake scorer)

const DIM = 64;
const embedText = (text: string): number[] => {
  const vector = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
    vector[h % DIM] = (vector[h % DIM] as number) + 1;
  }
  return vector;
};

function fakeDaemon(options: { gemma?: boolean } = {}) {
  const models: Record<string, string> = { 'nomic-embed-text:latest': 'a'.repeat(64), 'nomic-embed-text-v2-moe:latest': 'b'.repeat(64), 'bge-m3:latest': 'c'.repeat(64) };
  if (options.gemma === true) models['embeddinggemma:300m'] = 'e'.repeat(64);
  const embedBodies: { model: string; input: string[] }[] = [];
  const chatBodies: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    if (path === '/api/version') return reply(200, { version: '0.40.14' });
    if (path === '/api/tags') return reply(200, { models: Object.entries(models).map(([name, digest]) => ({ name, digest, size: 1000 })) });
    if (path === '/api/show') return reply(200, { details: { parameter_size: '137M' } });
    if (path === '/api/ps') return reply(200, { models: [] });
    if (path === '/api/embed') {
      const body = JSON.parse(init?.body ?? '{}') as { model: string; input: string[] };
      embedBodies.push(body);
      return reply(200, { embeddings: body.input.map(embedText), prompt_eval_count: body.input.length });
    }
    if (path === '/api/chat') {
      chatBodies.push(init?.body);
      return reply(200, {});
    }
    return reply(404, {});
  };
  return { fetchImpl, embedBodies, chatBodies };
}

describe('CLI stage E', () => {
  const v1 = [buildCase('mail', 6_000, 50, 'ko', 0)];
  const v2: ChunkEvalCaseV2[] = buildCaseV2({ shape: 'mail', length: 6_000, depth: 50, language: 'en', lengthAt: 0, depthAt: 2, languageAt: 1 });
  const memory = generateMemorySet();
  const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/\p{L}{4,}/gu) ?? []);
  const overlapScore = (query: string, passages: readonly string[]): number[] => passages.map((passage) => [...words(passage)].filter((word) => words(query).has(word)).length);

  const make = (options: { gemma?: boolean; verify?: () => Promise<Record<string, string>>; scorer?: PairScorer } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, unknown> = {};
    const daemon = fakeDaemon(options);
    const calls = { verify: 0, load: 0, scored: [] as number[] };
    let now = 0;
    const scorer: PairScorer = options.scorer ?? { score: async (query, passages) => (calls.scored.push(passages.length), overlapScore(query, passages)) };
    const deps: CliDeps = {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date('2026-11-06T00:00:00Z'),
      corpus: () => v1,
      readFreeze: () => ({ version: CORPUS_VERSION, seed: CORPUS_SEED, cases: v1.length, sha256: corpusDigest(v1) }),
      writeFreeze: () => undefined,
      writeReport: (dir, name, report) => {
        written[name] = report;
        return `${dir}/${name}`;
      },
      v2: { corpus: () => v2, readFreeze: () => ({ version: CORPUS_V2_VERSION, seed: CORPUS_V2_SEED, cases: v2.length, sha256: corpusV2Digest(v2) }), writeFreeze: () => undefined },
      memory: { corpus: () => memory, readFreeze: () => ({ version: MEMORY_VERSION, seed: MEMORY_SEED, cases: memory.memories.length + memory.queries.length, sha256: memoryDigest(memory) }), writeFreeze: () => undefined },
      embed: { fetch: daemon.fetchImpl, cacheDir: null, clock: () => (now += 7) },
      crossEncoder: {
        verify: async () => {
          calls.verify += 1;
          return options.verify === undefined ? { ...CROSS_ENCODER_FILES } : options.verify();
        },
        load: async () => {
          calls.load += 1;
          return scorer;
        },
        clock: () => (now += 3),
      },
    };
    return { deps, out, err, written, daemon, calls };
  };
  const digestOf = (out: string[]): string => (out.find((line) => line.startsWith('plan digest: ')) as string).slice('plan digest: '.length);
  const stage = ['--set', 'memory', '--stage', 'E'];
  const arms = 'E1,E2,X(E1),X(E2),X50(E2)';

  it('parses the stage E flags and rejects misuse with exit 2', async () => {
    const parsed = parseArguments([...stage, '--arms', arms, '--mode', 'plan', '--reranker-dir', '/models/x']);
    expect(parsed.stageEArms).toEqual(['E1', 'E2', 'X(E1)', 'X(E2)', 'X50(E2)']);
    expect(parsed.rerankerDir).toBe('/models/x');
    for (const argv of [
      ['--stage', 'E', '--mode', 'plan'],
      [...stage, '--arms', 'X(E9)', '--mode', 'plan'],
      [...stage, '--arms', 'E1,E1', '--mode', 'plan'],
      [...stage, '--mode', 'verify'],
      ['--set', 'memory', '--stage', 'D', '--arms', 'E1', '--reranker-dir', '/x', '--mode', 'plan'],
      ['--mode', 'plan', '--reranker-dir', '/x'],
    ])
      expect(await runCli(argv, make().deps), argv.join(' ')).toBe(EXIT_USAGE);
    // stages A-D do not accept E4 or X arms
    expect(() => parseArguments(['--set', 'memory', '--arms', 'E4', '--mode', 'run'])).toThrow();
    expect(() => parseArguments(['--set', 'memory', '--stage', 'D', '--arms', 'X(E1)', '--mode', 'plan'])).toThrow();
  });

  it('plan verifies the model files but never loads the model and makes no embedding call; the digest is stable and covers the files', async () => {
    const a = make();
    expect(await runCli([...stage, '--arms', arms, '--mode', 'plan'], a.deps)).toBe(EXIT_OK);
    expect(a.calls).toMatchObject({ verify: 1, load: 0 });
    expect(a.daemon.embedBodies).toEqual([]);
    const text = a.out.join('\n');
    expect(text).toMatch(/planned arms: E0, E1, E2, X\(E1\), X\(E2\), X50\(E2\)/u);
    expect(text).toMatch(/cross-encoder onnx-community\/bge-reranker-v2-m3-ONNX@6f5ff6529851 onnx\/model_int8\.onnx sha256 912fc1215c2d/u);
    expect(text).toMatch(/max_length 512, batch 8, threads 4/u);
    const digest = digestOf(a.out);
    const b = make();
    await runCli([...stage, '--arms', arms, '--mode', 'plan'], b.deps);
    expect(digestOf(b.out)).toBe(digest);
    const changed = make({ verify: async () => ({ ...CROSS_ENCODER_FILES, [CROSS_ENCODER_MODEL_FILE]: 'f'.repeat(64) }) });
    await runCli([...stage, '--arms', arms, '--mode', 'plan'], changed.deps);
    expect(digestOf(changed.out)).not.toBe(digest);
    const noX = make();
    await runCli([...stage, '--arms', 'E1,E2', '--mode', 'plan'], noX.deps);
    expect(noX.calls.verify).toBe(0);
    expect(digestOf(noX.out)).not.toBe(digest);
  });

  it('E4 drops with a note when the model is not pulled and is planned with its prefixes when it is', async () => {
    const missing = make();
    await runCli([...stage, '--arms', 'E4,X(E4)', '--mode', 'plan'], missing.deps);
    expect(missing.out.join('\n')).toMatch(/dropped: E4 \(.*\); X\(E4\) \(first-stage arm E4 is not available\)/u);
    const present = make({ gemma: true });
    await runCli([...stage, '--arms', 'E4', '--mode', 'plan'], present.deps);
    expect(present.out.join('\n')).toMatch(/E4 embeddinggemma:300m@eeeeeeeeeeee/u);
    const plan = Object.values(present.written)[0] as { arms: { arm: string; pin: { queryPrefix: string; documentPrefix: string } }[] };
    expect(plan.arms.find((arm) => arm.arm === 'E4')?.pin).toMatchObject({ queryPrefix: 'task: search result | query: ', documentPrefix: 'title: none | text: ' });
  });

  it('a run or probe without the matching digest is BLOCKED (exit 3) before the model loads; a tampered directory is INVALID (exit 5)', async () => {
    for (const mode of ['run', 'probe']) {
      const none = make();
      expect(await runCli([...stage, '--arms', arms, '--mode', mode], none.deps)).toBe(EXIT_BLOCKED);
      const wrong = make();
      expect(await runCli([...stage, '--arms', arms, '--plan-digest', 'e'.repeat(64), '--mode', mode], wrong.deps)).toBe(EXIT_BLOCKED);
      expect(wrong.calls.load).toBe(0);
      expect(wrong.daemon.embedBodies).toEqual([]);
    }
    const bad = make({ verify: async () => Promise.reject(new Error('cross-encoder file tokenizer.json does not match its sha256')) });
    expect(await runCli([...stage, '--arms', arms, '--mode', 'plan'], bad.deps)).toBe(EXIT_INVALID);
    expect(bad.err.join('\n')).toMatch(/does not match its sha256/u);
    expect(bad.calls.load).toBe(0);
  });

  it('a run reports plain and X arms with first-stage Recall@N, latency, the 95% lines and a verdict over all arms', async () => {
    const plan = make();
    await runCli([...stage, '--arms', arms, '--mode', 'plan'], plan.deps);
    const run = make();
    expect(await runCli([...stage, '--arms', arms, '--plan-digest', digestOf(plan.out), '--mode', 'run'], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.calls.load).toBe(1);
    expect(run.calls.scored.filter((n) => n === 20).length).toBe(2 * memory.queries.length);
    expect(run.calls.scored.filter((n) => n === 50).length).toBe(memory.queries.length);
    const report = Object.values(run.written)[0] as { cross: Record<string, { topN: number; maxLength: number; latencyMs: { p50: number; p95: number }; firstStageRecallAtN: { n: number }; metrics: { byLanguage: Record<string, unknown>; longMemories: unknown; shortMemories: unknown } }>; verdict: { verdict: string; inputs: { arm: string }[] } };
    expect(Object.keys(report.cross)).toEqual(['X(E1)', 'X(E2)', 'X50(E2)']);
    expect(report.cross['X50(E2)']).toMatchObject({ topN: 50, maxLength: 512 });
    expect(report.cross['X50(E2)']?.firstStageRecallAtN.n).toBe(50);
    expect(report.cross['X(E1)']?.latencyMs.p95).toBeGreaterThan(0);
    expect(Object.keys(report.cross['X(E1)']?.metrics.byLanguage ?? {})).toEqual(['ko', 'en', 'mixed']);
    expect(report.verdict.verdict).not.toBe('INCOMPLETE');
    expect(report.verdict.inputs.map((i) => i.arm)).toEqual(['E0', 'E1', 'E2', 'X(E1)', 'X(E2)', 'X50(E2)']);
    const text = run.out.join('\n');
    expect(text).toMatch(/X50\(E2\) .*R@5/u);
    expect(text).toMatch(/95% target X\(E1\)/u);
    expect(text).toMatch(/cross-encoder latency per query p50/u);
    expect(run.daemon.chatBodies).toEqual([]);
  });

  it('the probe checks sanity first (a failing scorer is INVALID), then scores 20 fixed queries per X arm with per-query latency', async () => {
    const plan = make();
    await runCli([...stage, '--arms', arms, '--mode', 'plan'], plan.deps);
    const digest = digestOf(plan.out);
    const bad = make({ scorer: { score: async (_query, passages) => passages.map(() => 0) } });
    expect(await runCli([...stage, '--arms', arms, '--plan-digest', digest, '--mode', 'probe'], bad.deps)).toBe(EXIT_INVALID);
    expect(bad.err.join('\n')).toMatch(/sanity check failed/u);
    expect(bad.daemon.embedBodies).toEqual([]);
    const probe = make();
    expect(await runCli([...stage, '--arms', arms, '--plan-digest', digest, '--mode', 'probe'], probe.deps)).toBe(EXIT_NON_GATING);
    const text = probe.out.join('\n');
    expect(text).toMatch(/cross-encoder sanity: .* ok/u);
    expect(text).toMatch(new RegExp(`E1 memory-path query embed \\(${MEMORY_LATENCY_QUERIES} queries after 1 warm-up\\)`, 'u'));
    for (const arm of ['X\\(E1\\)', 'X\\(E2\\)', 'X50\\(E2\\)']) expect(text).toMatch(new RegExp(`${arm} cross-encoder, 20 queries`, 'u'));
    expect(probe.out.filter((line) => /^ {2}\S+: [0-9.]+ ms/u.test(line)).length).toBe(60);
  });

  it('stage C and D commands keep working', async () => {
    const plan = make();
    expect(await runCli(['--set', 'memory', '--stage', 'D', '--arms', 'E1,R(E1)', '--mode', 'plan'], plan.deps)).toBe(EXIT_OK);
    expect(plan.out.join('\n')).toMatch(/stage D plan/u);
    const c = make();
    expect(await runCli(['--mode', 'plan', '--arms', 'E0,E1'], c.deps)).toBe(EXIT_OK);
    expect(c.calls.verify).toBe(0);
  });
});

// ---------------------------------------------------------------- the real model (opt in)

const realDir = process.env.QUOKY_CROSS_ENCODER_DIR;
describe.skipIf(realDir === undefined)('real cross-encoder (QUOKY_CROSS_ENCODER_DIR)', () => {
  it('tokenizes pairs and scores: relevant beats unrelated, English and Korean', async () => {
    const started = performance.now();
    const model = await OnnxCrossEncoder.load(realDir as string);
    const loaded = performance.now();
    const english = await sanityCheck(model);
    expect(english.ok).toBe(true);
    const [relevant, unrelated] = await model.score('한국의 수도는 어디인가요?', ['서울은 대한민국의 수도이며 가장 큰 도시이다.', '고양이는 하루에 열두 시간 넘게 잠을 자는 동물이다.']);
    expect((relevant as number) > (unrelated as number)).toBe(true);
    // a passage far over max_length is truncated, not refused
    const long = await model.score('capital city question', [`${'The river flows past the old mill. '.repeat(400)}`]);
    expect(Number.isFinite(long[0])).toBe(true);
    const done = performance.now();
    process.stdout.write(`real cross-encoder: load ${Math.round(loaded - started)} ms, scoring ${Math.round(done - loaded)} ms; sanity ${english.relevant.toFixed(3)} vs ${english.unrelated.toFixed(3)}\n`);
    await model.dispose();
  }, 120_000);
});
