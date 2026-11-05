/**
 * ADR-0124 phase 1 stage D: the rerank arm, the memory-path latency bar, the stage D plan v2 and decision. A fake loopback
 * Ollama only: no model is called.
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunking } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_INVALID, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, parseArguments, runCli, type CliDeps } from '../chunk-eval-cli';
import type { FetchLike } from '../selector-rag/embed';
import { buildCase, corpusDigest, CORPUS_SEED, CORPUS_VERSION } from './corpus';
import { buildCaseV2, corpusV2Digest, CORPUS_V2_SEED, CORPUS_V2_VERSION, type ChunkEvalCaseV2 } from './corpus-v2';
import { ARM_SPECS, ArmEmbedder, EmbeddingCache, pinArm, type ArmId } from './embed-arms';
import { EN_ATTRS, EN_MODS, EN_OBJECTS, KO_ATTRS, KO_MODS, KO_OBJECTS, generateMemorySet, memoryDigest, MEMORY_SEED, MEMORY_VERSION } from './memory-set';
import {
  CANDIDATE_CAP_UNITS,
  LlmReranker,
  RERANK_DIGEST12,
  RERANK_PROMPT_SHA,
  RERANK_SYSTEM_PROMPT,
  RERANK_ANSWER_TAIL,
  RERANK_CANDIDATES_HEAD,
  RERANK_QUESTION_HEAD,
  RerankCache,
  capText,
  parseRanking,
  pinReranker,
  userMessage,
} from './rerank-arm';
import {
  MEMORY_LATENCY_QUERIES,
  PROBE_RERANK_QUERIES,
  STAGE_D_PARAMETERS,
  decideStageD,
  measureQueryLatency,
  parseStageDArm,
  sampleQueries,
  stageDDigest,
  stageDPlanned,
  type StageDDecisionInput,
  type StageDInputs,
} from './stage-d';

// ---------------------------------------------------------------- a fake loopback Ollama (embed + chat)

const DIM = 64;
const hashOf = (term: string): number => {
  let h = 2166136261;
  for (const ch of term) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
  return h;
};
const embedText = (text: string): number[] => {
  const vector = new Array<number>(DIM).fill(0);
  for (const term of chunking.lexicalTerms(text)) vector[hashOf(term) % DIM] = (vector[hashOf(term) % DIM] as number) + 1;
  return vector;
};

interface FakeOptions {
  readonly rerankerDigest?: string;
  readonly version?: string;
  /** the content the fake model answers, from the user message; default: candidates in the given order */
  readonly chat?: (user: string) => string;
  readonly chatStatus?: number;
}

function fake(options: FakeOptions = {}) {
  const models: Record<string, string> = {
    'nomic-embed-text:latest': 'a'.repeat(64),
    'nomic-embed-text-v2-moe:latest': 'b'.repeat(64),
    'bge-m3:latest': 'c'.repeat(64),
    'qwen3-embedding:0.6b': 'd'.repeat(64),
    'qwen3:8b': options.rerankerDigest ?? `${RERANK_DIGEST12}${'0'.repeat(52)}`,
  };
  const urls: string[] = [];
  const chatBodies: { model: string; stream: boolean; think: boolean; format: unknown; keep_alive: unknown; options: { temperature: number; seed: number }; messages: { role: string; content: string }[] }[] = [];
  const embedBodies: { input: string[] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (path === '/api/version') return reply(200, { version: options.version ?? '0.40.14' });
    if (path === '/api/tags') return reply(200, { models: Object.entries(models).map(([name, digest]) => ({ name, digest, size: 1000 })) });
    if (path === '/api/show') {
      const asked = (JSON.parse(init?.body ?? '{}') as { model: string }).model;
      return reply(200, { details: { parameter_size: asked === 'qwen3:8b' ? '8.2B' : asked === 'bge-m3:latest' ? '566.70M' : '137M' } });
    }
    if (path === '/api/ps') return reply(200, { models: [] });
    if (path === '/api/embed') {
      const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
      embedBodies.push(body);
      return reply(200, { embeddings: body.input.map(embedText), prompt_eval_count: body.input.length });
    }
    if (path === '/api/chat') {
      const body = JSON.parse(init?.body ?? '{}') as (typeof chatBodies)[number];
      if (body.messages.length === 0) return reply(200, {});
      chatBodies.push(body);
      if (options.chatStatus !== undefined) return reply(options.chatStatus, { error: 'fault' });
      const user = body.messages[1]?.content ?? '';
      const count = (user.match(/^\[\d+\] /gmu) ?? []).length;
      const content = options.chat === undefined ? JSON.stringify(Array.from({ length: count }, (_, at) => at + 1)) : options.chat(user);
      return reply(200, { message: { role: 'assistant', content }, prompt_eval_count: 100, eval_count: 20 });
    }
    return reply(404, {});
  };
  return { fetchImpl, urls, chatBodies, embedBodies };
}

const scratch = mkdtempSync(join(tmpdir(), 'chunk-rerank-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const uniqueDir = (name: string): string => mkdtempSync(join(scratch, `${name}-`));

// ---------------------------------------------------------------- prompt

describe('rerank prompt', () => {
  const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  const subjectTables = [EN_OBJECTS, EN_MODS, KO_OBJECTS, KO_MODS];
  const vocabulary = new Set(subjectTables.flatMap((table) => table.flatMap((pair) => pair.flatMap(words))));
  const promptWords = new Set(words([RERANK_SYSTEM_PROMPT, RERANK_QUESTION_HEAD, RERANK_CANDIDATES_HEAD, RERANK_ANSWER_TAIL].join(' ')));

  it('contains no word of the memory set subject tables and no attribute phrase (set-agnostic)', () => {
    expect(vocabulary.size).toBeGreaterThan(100);
    expect([...promptWords].filter((word) => vocabulary.has(word))).toEqual([]);
    const prompt = [RERANK_SYSTEM_PROMPT, RERANK_QUESTION_HEAD, RERANK_CANDIDATES_HEAD, RERANK_ANSWER_TAIL].join(' ').toLowerCase();
    for (const pair of [...EN_ATTRS, ...KO_ATTRS]) for (const phrase of pair) expect(prompt.includes(phrase.toLowerCase()), phrase).toBe(false);
  });

  it('is one generic instruction with a recorded sha256', () => {
    expect(RERANK_PROMPT_SHA).toMatch(/^[0-9a-f]{64}$/u);
    expect(RERANK_SYSTEM_PROMPT).toMatch(/JSON array/u);
  });

  it('numbers candidates from 1 and caps each at the constant, collapsing whitespace', () => {
    const long = `${'가'.repeat(CANDIDATE_CAP_UNITS)} tail`;
    const message = userMessage('q?', [{ id: 'a', text: 'one\n two' }, { id: 'b', text: long }]);
    expect(message).toContain('[1] one two');
    expect(message).toContain(`[2] ${'가'.repeat(CANDIDATE_CAP_UNITS)}`);
    expect(message).not.toContain('tail');
    expect(capText(`${'x'.repeat(CANDIDATE_CAP_UNITS - 1)}😀`)).toBe('x'.repeat(CANDIDATE_CAP_UNITS - 1));
  });
});

// ---------------------------------------------------------------- parsing

describe('parseRanking', () => {
  it('keeps valid unique in-range numbers in order and appends the missing ones in first-stage order', () => {
    expect(parseRanking('[3,1]', 4)).toEqual({ order: [2, 0, 1, 3], parsed: true });
    expect(parseRanking('[2,2,9,0,-1,"3",1.5,"x"]', 4)).toEqual({ order: [1, 2, 0, 3], parsed: true });
  });
  it('accepts an object that wraps the array and prose around an array', () => {
    expect(parseRanking('{"ranking":[2,1]}', 3)).toEqual({ order: [1, 0, 2], parsed: true });
    expect(parseRanking('Best first: [2, 3]. done', 3)).toEqual({ order: [1, 2, 0], parsed: true });
  });
  it('falls back to the first-stage order when nothing usable is parsed', () => {
    for (const text of ['', 'no idea', '[]', '[0, 99]', '{"a":1}', '[[1]]', '{']) expect(parseRanking(text, 3), text).toEqual({ order: [0, 1, 2], parsed: false });
  });
});

// ---------------------------------------------------------------- reranker

const candidates = [
  { id: 'm1', text: 'first memory' },
  { id: 'm2', text: 'second memory' },
  { id: 'm3', text: 'third memory' },
];

describe('LlmReranker', () => {
  it('pins qwen3:8b by digest and refuses a different digest', async () => {
    const pin = await pinReranker(undefined, fake().fetchImpl);
    expect(pin).toMatchObject({ model: 'qwen3:8b', digest12: RERANK_DIGEST12, ollamaVersion: '0.40.14', paramsM: 8200 });
    await expect(pinReranker(undefined, fake({ rerankerDigest: 'e'.repeat(64) }).fetchImpl)).rejects.toThrow(/not the ratified/u);
  });

  it('calls /api/chat on loopback with temperature 0, a fixed seed, no thinking and JSON output', async () => {
    const f = fake({ chat: () => '[2,3,1]' });
    const reranker = new LlmReranker(await pinReranker(undefined, f.fetchImpl), { fetchImpl: f.fetchImpl, clock: (() => { let t = 0; return () => (t += 5); })() });
    const result = await reranker.rerank('q1', 'question?', candidates);
    expect(result).toMatchObject({ order: [1, 2, 0], fallback: false, cached: false, ms: 5, promptTokens: 100, evalTokens: 20 });
    const body = f.chatBodies[0];
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, think: false, format: { type: 'array', items: { type: 'integer' } }, keep_alive: '2m', options: { temperature: 0, seed: 7 } });
    expect(body?.messages[0]?.content).toBe(RERANK_SYSTEM_PROMPT);
    expect(f.urls.filter((url) => url.endsWith('/api/chat')).every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
    expect(() => new LlmReranker(result as never, { baseUrl: 'http://example.com:11434' })).toThrow(/loopback/u);
  });

  it('an unparseable answer falls back to the first-stage order and is counted; a daemon fault throws', async () => {
    const f = fake({ chat: () => 'cannot say' });
    const reranker = new LlmReranker(await pinReranker(undefined, f.fetchImpl), { fetchImpl: f.fetchImpl });
    const result = await reranker.rerank('q1', 'question?', candidates);
    expect(result).toMatchObject({ order: [0, 1, 2], fallback: true });
    expect(reranker.fallbacks).toBe(1);
    const bad = fake({ chatStatus: 500 });
    await expect(new LlmReranker(await pinReranker(undefined, bad.fetchImpl), { fetchImpl: bad.fetchImpl }).rerank('q', 'x', candidates)).rejects.toThrow(/status 500/u);
  });

  it('a cache hit makes no call, in memory and from the jsonl file; a changed candidate list is a miss; a torn row is dropped', async () => {
    const f = fake({ chat: () => '[3,2,1]' });
    const pin = await pinReranker(undefined, f.fetchImpl);
    const file = join(uniqueDir('cache'), 'rerank.jsonl');
    const first = new LlmReranker(pin, { fetchImpl: f.fetchImpl, cache: new RerankCache(file) });
    await first.rerank('q1', 'question?', candidates);
    await first.rerank('q1', 'question?', candidates);
    expect(f.chatBodies.length).toBe(1);
    expect(first.cacheHits).toBe(1);
    const second = new LlmReranker(pin, { fetchImpl: f.fetchImpl, cache: new RerankCache(file) });
    const again = await second.rerank('q1', 'question?', candidates);
    expect(again).toMatchObject({ order: [2, 1, 0], cached: true });
    expect(f.chatBodies.length).toBe(1);
    await second.rerank('q1', 'question?', [...candidates].reverse());
    await second.rerank('q2', 'question?', candidates);
    expect(f.chatBodies.length).toBe(3);
    // same ids, different question or candidate text: a miss (Codex P2)
    await second.rerank('q1', 'another question?', candidates);
    await second.rerank('q1', 'question?', candidates.map((candidate) => ({ ...candidate, text: `${candidate.text} changed` })));
    expect(f.chatBodies.length).toBe(5);
    appendFileSync(file, '{"k":"torn\n');
    writeFileSync(`${file}.copy`, '');
    expect(new RerankCache(file).rejectedAtLoad).toBe(1);
    // the probe bypasses the cache both ways
    await second.rerank('q1', 'question?', candidates, false);
    expect(f.chatBodies.length).toBe(6);
  });

  it('the cache key covers the model digest and the prompt sha', async () => {
    const pin = await pinReranker(undefined, fake().fetchImpl);
    const a = RerankCache.key(pin, 'q', ['x'], 'm');
    expect(RerankCache.key({ digest12: 'f'.repeat(12) }, 'q', ['x'], 'm')).not.toBe(a);
    expect(RerankCache.key(pin, 'q', ['x', 'y'], 'm')).not.toBe(a);
    expect(RerankCache.key(pin, 'q', ['x'], 'm2')).not.toBe(a);
    expect(RERANK_PROMPT_SHA).toMatch(/^[0-9a-f]{64}$/u);
  });
});

// ---------------------------------------------------------------- memory-path latency

describe('memory-path latency bar', () => {
  const set = generateMemorySet();
  const embedderWith = async (step: number): Promise<ArmEmbedder> => {
    const f = fake();
    let now = 0;
    return new ArmEmbedder(await pinArm(ARM_SPECS.E2, undefined, f.fetchImpl), { fetchImpl: f.fetchImpl, cache: new EmbeddingCache(), clock: () => (now += step) });
  };

  it('samples a fixed seeded subset of queries', () => {
    const a = sampleQueries(set.queries, MEMORY_LATENCY_QUERIES, 'memory-path-latency');
    expect(a.map((q) => q.id)).toEqual(sampleQueries(set.queries, MEMORY_LATENCY_QUERIES, 'memory-path-latency').map((q) => q.id));
    expect(a.length).toBe(MEMORY_LATENCY_QUERIES);
    expect(sampleQueries(set.queries, PROBE_RERANK_QUERIES, 'probe-rerank').length).toBe(20);
    expect(sampleQueries(set.queries, 20, 'probe-rerank').map((q) => q.id)).not.toEqual(sampleQueries(set.queries, 20, 'other').map((q) => q.id));
  });

  it('is eligible when the warm single query embed p95 is within 1000 ms, and not above it', async () => {
    const fast = await measureQueryLatency(await embedderWith(40), sampleQueries(set.queries, MEMORY_LATENCY_QUERIES, 'memory-path-latency'));
    expect(fast).toMatchObject({ sample: 50, warmups: 1, p50: 120, p95: 120, meetsBar: true, reason: null });
    const slow = await measureQueryLatency(await embedderWith(1500), sampleQueries(set.queries, MEMORY_LATENCY_QUERIES, 'memory-path-latency'));
    expect(slow.meetsBar).toBe(false);
    expect(slow.reason).toMatch(/over the 1000 ms memory-path bar/u);
    const small = await measureQueryLatency(await embedderWith(40), set.queries.slice(0, 5));
    expect(small.meetsBar).toBe(false);
    expect(small.reason).toMatch(/smaller than planned/u);
  });
});

// ---------------------------------------------------------------- decision

describe('stage D decision', () => {
  const input = (arm: string, ko: number, en: number, extra: Partial<StageDDecisionInput> = {}): StageDDecisionInput => ({
    arm,
    kind: arm.startsWith('R(') ? 'rerank' : 'embedder',
    koRecallAt5: ko,
    enRecallAt5: en,
    mixedRecallAt5: en,
    paramsM: 100,
    sizeBytes: 1000,
    memoryP95Ms: 200,
    latencyMeetsBar: true,
    latencyReason: null,
    ...extra,
  });
  const planned = ['E0', 'E1', 'E2', 'R(E1)', 'R(E2)'];

  it('chooses a rerank arm that beats E0 by 5 points on Korean, English within 2 points, base eligible', () => {
    const verdict = decideStageD(planned, [input('E0', 0.4, 0.9), input('E1', 0.7, 0.9), input('E2', 0.8, 0.9, { memoryP95Ms: 900 }), input('R(E1)', 0.9, 0.95), input('R(E2)', 0.96, 0.96, { memoryP95Ms: 900 })]);
    expect(verdict).toMatchObject({ verdict: 'CHOOSE', chosen: 'R(E2)' });
    expect(verdict.inputs.find((i) => i.arm === 'R(E2)')?.reachesTarget).toEqual({ ko: true, mixed: true });
    expect(verdict.inputs.find((i) => i.arm === 'E1')?.reachesTarget.ko).toBe(false);
  });

  it('eligibility is the memory-path bar of the first stage (p95 <= 1000 ms); an over-bar arm and its rerank arm are not eligible', () => {
    const slow = { memoryP95Ms: 1200, latencyMeetsBar: false, latencyReason: 'p95 1200 ms is over the 1000 ms memory-path bar' };
    const verdict = decideStageD(planned, [input('E0', 0.4, 0.9), input('E1', 0.7, 0.9), input('E2', 0.84, 0.9, slow), input('R(E1)', 0.8, 0.9), input('R(E2)', 0.99, 0.99, slow)]);
    expect(verdict).toMatchObject({ verdict: 'CHOOSE', chosen: 'R(E1)' });
    expect(verdict.reasons.join('\n')).toMatch(/E2: .*NOT ELIGIBLE/u);
    expect(verdict.reasons.join('\n')).toMatch(/R\(E2\): .*NOT ELIGIBLE/u);
  });

  it('a p95 above the bar fails even when the block said it meets the bar', () => {
    const verdict = decideStageD(['E0', 'E1'], [input('E0', 0.4, 0.9), input('E1', 0.9, 0.9, { memoryP95Ms: 1001 })]);
    expect(verdict.verdict).toBe('KEEP_E0');
  });

  it('keeps E0 without a 5 point Korean gain, rejects an English drop over 2 points, and is INCOMPLETE until every planned arm ran', () => {
    expect(decideStageD(['E0', 'E1'], [input('E0', 0.6, 0.9), input('E1', 0.64, 0.9)]).verdict).toBe('KEEP_E0');
    expect(decideStageD(['E0', 'E1'], [input('E0', 0.4, 0.9), input('E1', 0.9, 0.87)]).verdict).toBe('KEEP_E0');
    expect(decideStageD(planned, [input('E0', 0.4, 0.9), input('E1', 0.9, 0.9)])).toMatchObject({ verdict: 'INCOMPLETE', chosen: null });
  });

  it('a tie goes to the smaller model; a rerank arm counts the reranker too, so the plain arm wins an equal score', () => {
    const verdict = decideStageD(['E0', 'E1', 'R(E1)'], [input('E0', 0.4, 0.9), input('E1', 0.9, 0.9, { paramsM: 100 }), input('R(E1)', 0.9, 0.9, { paramsM: 8300 })]);
    expect(verdict.chosen).toBe('E1');
  });

  it('the 95% target is informational: it does not change the verdict', () => {
    const verdict = decideStageD(['E0', 'E1'], [input('E0', 0.4, 0.9), input('E1', 0.5, 0.9)]);
    expect(verdict.verdict).toBe('CHOOSE');
    expect(verdict.inputs.every((i) => !i.reachesTarget.ko)).toBe(true);
  });
});

// ---------------------------------------------------------------- arms, plan digest

describe('stage D arms and plan digest', () => {
  it('parses R arms, always plans E0 and the first stages of the R arms', () => {
    expect(parseStageDArm('R(E1)')).toBe('R(E1)');
    expect(parseStageDArm('R(E9)')).toBeUndefined();
    expect(parseStageDArm('E2')).toBe('E2');
    expect(stageDPlanned(['R(E2)', 'E1'])).toEqual({ planned: ['E0', 'E1', 'R(E2)'], embedderIds: ['E0', 'E1', 'E2'], rerankArms: ['R(E2)'] });
  });

  const base = async (): Promise<StageDInputs> => {
    const f = fake();
    const reranker = await pinReranker(undefined, f.fetchImpl);
    const pin = await pinArm(ARM_SPECS.E1, undefined, f.fetchImpl);
    return { sets: { memory: { digest: 'm'.repeat(64) }, v2: { digest: 'v'.repeat(64) } }, planned: ['E0', 'E1', 'R(E1)'], resolved: { planned: ['E1'], available: [pin], dropped: [] }, reranker, dropped: [] };
  };

  it('changes with N, the prompt sha, the candidate cap, the latency sample, the bars, the reranker pin and the arms', async () => {
    const input = await base();
    const digest = stageDDigest(input);
    expect(stageDDigest(input)).toBe(digest);
    const rerank = STAGE_D_PARAMETERS.rerank;
    const variants: unknown[] = [
      { ...STAGE_D_PARAMETERS, rerank: { ...rerank, topN: 10 } },
      { ...STAGE_D_PARAMETERS, rerank: { ...rerank, promptSha256: 'f'.repeat(64) } },
      { ...STAGE_D_PARAMETERS, rerank: { ...rerank, candidateCapUnits: 300 } },
      { ...STAGE_D_PARAMETERS, memoryLatency: { ...STAGE_D_PARAMETERS.memoryLatency, sampleQueries: 20 } },
      { ...STAGE_D_PARAMETERS, memoryLatency: { ...STAGE_D_PARAMETERS.memoryLatency, barMs: 2000 } },
      { ...STAGE_D_PARAMETERS, base: { ...STAGE_D_PARAMETERS.base, latency: { ...STAGE_D_PARAMETERS.base.latency, budgetMs: 9000 } } },
    ];
    for (const parameters of variants) expect(stageDDigest(input, parameters)).not.toBe(digest);
    expect(stageDDigest({ ...input, reranker: input.reranker === null ? null : { ...input.reranker, digest12: 'f'.repeat(12) } })).not.toBe(digest);
    expect(stageDDigest({ ...input, reranker: input.reranker === null ? null : { ...input.reranker, ollamaVersion: '0.99.0' } })).not.toBe(digest);
    expect(stageDDigest({ ...input, planned: ['E0', 'E1'] })).not.toBe(digest);
    expect(stageDDigest({ ...input, sets: { ...input.sets, memory: { digest: 'x'.repeat(64) } } })).not.toBe(digest);
    expect(rerank.promptSha256).toBe(RERANK_PROMPT_SHA);
  });
});

// ---------------------------------------------------------------- CLI

describe('CLI stage D', () => {
  const v1 = [buildCase('mail', 6_000, 50, 'ko', 0)];
  const v2: ChunkEvalCaseV2[] = buildCaseV2({ shape: 'mail', length: 6_000, depth: 50, language: 'en', lengthAt: 0, depthAt: 2, languageAt: 1 });
  const memory = generateMemorySet();
  const make = (f = fake(), cacheDir: string | null = null) => {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, unknown> = {};
    let now = 0;
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
      embed: { fetch: f.fetchImpl, cacheDir, clock: () => (now += 7) },
    };
    return { deps, out, err, written, f };
  };
  const digestOf = (out: string[]): string => (out.find((line) => line.startsWith('plan digest: ')) as string).slice('plan digest: '.length);
  const stage = ['--set', 'memory', '--stage', 'D'];

  it('parses the stage D flags and rejects misuse with exit 2', async () => {
    expect(parseArguments([...stage, '--arms', 'E1,R(E1)', '--mode', 'plan']).stageDArms).toEqual(['E1', 'R(E1)']);
    for (const argv of [
      ['--stage', 'D', '--mode', 'plan'],
      ['--set', 'v2', '--stage', 'D', '--mode', 'plan'],
      [...stage, '--mode', 'verify'],
      ['--set', 'memory', '--stage', 'X', '--mode', 'plan'],
      [...stage, '--arms', 'R(E9)', '--mode', 'plan'],
      [...stage, '--arms', 'E1,E1', '--mode', 'plan'],
    ])
      expect(await runCli(argv, make().deps), argv.join(' ')).toBe(EXIT_USAGE);
    expect(() => parseArguments(['--set', 'memory', '--arms', 'R(E1)', '--mode', 'run'])).toThrow();
  });

  it('plan makes no embedding or chat call, covers the reranker pin and is stable; the old plan is untouched', async () => {
    const a = make();
    expect(await runCli([...stage, '--arms', 'E1,E2,R(E1),R(E2)', '--mode', 'plan'], a.deps)).toBe(EXIT_OK);
    expect(a.f.embedBodies).toEqual([]);
    expect(a.f.chatBodies).toEqual([]);
    expect(a.out.join('\n')).toMatch(/planned arms: E0, E1, E2, R\(E1\), R\(E2\)/u);
    expect(a.out.join('\n')).toMatch(/reranker qwen3:8b@500a1f067a9f ollama0\.40\.14/u);
    const digest = digestOf(a.out);
    const b = make();
    await runCli([...stage, '--arms', 'E1,E2,R(E1),R(E2)', '--mode', 'plan'], b.deps);
    expect(digestOf(b.out)).toBe(digest);
    const other = make(fake({ version: '0.99.0' }));
    await runCli([...stage, '--arms', 'E1,E2,R(E1),R(E2)', '--mode', 'plan'], other.deps);
    expect(digestOf(other.out)).not.toBe(digest);
    const fewer = make();
    await runCli([...stage, '--arms', 'E1,R(E1)', '--mode', 'plan'], fewer.deps);
    expect(digestOf(fewer.out)).not.toBe(digest);
    const v1plan = make();
    await runCli(['--mode', 'plan', '--arms', 'E0'], v1plan.deps);
    expect(digestOf(v1plan.out)).not.toBe(digest);
  });

  it('a run or probe without the matching digest is BLOCKED (exit 3) before any call', async () => {
    for (const mode of ['run', 'probe']) {
      const none = make();
      expect(await runCli([...stage, '--arms', 'E1,R(E1)', '--mode', mode], none.deps)).toBe(EXIT_BLOCKED);
      const wrong = make();
      expect(await runCli([...stage, '--arms', 'E1,R(E1)', '--plan-digest', 'e'.repeat(64), '--mode', mode], wrong.deps)).toBe(EXIT_BLOCKED);
      expect(wrong.f.embedBodies).toEqual([]);
      expect(wrong.f.chatBodies).toEqual([]);
    }
  });

  it('a missing reranker model drops the R arms with a note and the verdict is INCOMPLETE', async () => {
    const f = fake({ rerankerDigest: 'e'.repeat(64) });
    const plan = make(f);
    await runCli([...stage, '--arms', 'E1,R(E1)', '--mode', 'plan'], plan.deps);
    expect(plan.out.join('\n')).toMatch(/dropped: R\(E1\) \(reranker qwen3:8b has digest/u);
    const run = make(f);
    expect(await runCli([...stage, '--arms', 'E1,R(E1)', '--plan-digest', digestOf(plan.out), '--mode', 'run'], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.out.join('\n')).toMatch(/verdict: no arm is chosen until all planned arms ran \(missing: R\(E1\)\)/u);
    expect(run.f.chatBodies).toEqual([]);
  });

  it('a run reports plain and rerank arms, first-stage Recall@N, memory-path latency, rerank latency; a second run reuses the rerank cache', async () => {
    const dir = uniqueDir('run');
    const args = [...stage, '--arms', 'E1,R(E1)'];
    const plan = make(fake(), dir);
    await runCli([...args, '--mode', 'plan'], plan.deps);
    const digest = digestOf(plan.out);
    const run = make(fake(), dir);
    expect(await runCli([...args, '--plan-digest', digest, '--mode', 'run'], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.f.chatBodies.length).toBe(memory.queries.length);
    const report = Object.values(run.written)[0] as { embedders: Record<string, { memoryPathLatency: { p95: number; meetsBar: boolean }; firstStageRecallAtN: { n: number }; latency: unknown }>; rerank: Record<string, { fallbacks: number; latencyMs: { p95: number }; metrics: { byLanguage: Record<string, unknown> }; firstStageRecallAtN: { n: number } }>; verdict: { verdict: string } };
    expect(Object.keys(report.embedders)).toEqual(['E0', 'E1']);
    expect(report.embedders.E1?.memoryPathLatency.meetsBar).toBe(true);
    expect(report.embedders.E1?.firstStageRecallAtN.n).toBe(20);
    expect(report.embedders.E1?.latency).not.toBeNull();
    expect(report.rerank['R(E1)']?.fallbacks).toBe(0);
    expect(Object.keys(report.rerank['R(E1)']?.metrics.byLanguage ?? {})).toEqual(['ko', 'en', 'mixed']);
    expect(report.verdict.verdict).not.toBe('INCOMPLETE');
    expect(run.out.join('\n')).toMatch(/R\(E1\) .*R@5/u);
    expect(run.out.join('\n')).toMatch(/95% target R\(E1\)/u);
    const again = make(fake(), dir);
    expect(await runCli([...args, '--plan-digest', digest, '--mode', 'run'], again.deps)).toBe(EXIT_NON_GATING);
    expect(again.f.chatBodies).toEqual([]);
  });

  it('a daemon fault during a rerank run is INVALID (exit 5)', async () => {
    const f = fake({ chatStatus: 500 });
    const plan = make(f);
    await runCli([...stage, '--arms', 'E1,R(E1)', '--mode', 'plan'], plan.deps);
    const run = make(f);
    expect(await runCli([...stage, '--arms', 'E1,R(E1)', '--plan-digest', digestOf(plan.out), '--mode', 'run'], run.deps)).toBe(EXIT_INVALID);
  });

  it('the probe reranks 20 fixed queries per R arm with the cache bypassed and prints per-query and memory-path latency', async () => {
    const dir = uniqueDir('probe');
    const args = [...stage, '--arms', 'E1,R(E1)'];
    const plan = make(fake(), dir);
    await runCli([...args, '--mode', 'plan'], plan.deps);
    const digest = digestOf(plan.out);
    const probe = make(fake(), dir);
    expect(await runCli([...args, '--plan-digest', digest, '--mode', 'probe'], probe.deps)).toBe(EXIT_NON_GATING);
    expect(probe.f.chatBodies.length).toBe(PROBE_RERANK_QUERIES);
    const text = probe.out.join('\n');
    expect(text).toMatch(/E0 memory-path query embed \(50 queries after 1 warm-up\)/u);
    expect(text).toMatch(/E1 memory-path query embed/u);
    expect(text).toMatch(/R\(E1\) rerank, 20 queries/u);
    expect(probe.out.filter((line) => /^ {2}\S+: [0-9.]+ ms/u.test(line)).length).toBe(PROBE_RERANK_QUERIES);
    // the probe wrote nothing to the rerank cache: a second probe calls the model again
    const second = make(fake(), dir);
    await runCli([...args, '--plan-digest', digest, '--mode', 'probe'], second.deps);
    expect(second.f.chatBodies.length).toBe(PROBE_RERANK_QUERIES);
  });

  it('the stage A-C memory run is unchanged: no rerank call, no stage D report', async () => {
    const run = make();
    const plan = make();
    await runCli(['--mode', 'plan', '--arms', 'E0'], plan.deps);
    expect(await runCli(['--set', 'memory', '--arms', 'E0', '--plan-digest', digestOf(plan.out), '--mode', 'run'], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.f.chatBodies).toEqual([]);
    expect(Object.keys(run.written)[0]).toMatch(/^chunk-eval-memory-/u);
  });
});

export type { ArmId };
