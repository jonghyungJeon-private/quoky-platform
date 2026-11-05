/**
 * ADR-0124 phase 1 stage A: offline tests of the embedder arms E0-E3, EH(x), the CH7 memory set, the plan digest and the
 * decision rule. A fake Ollama (a fetch function) answers every call; nothing here can reach a real daemon or a model.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunking } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXIT_BLOCKED,
  EXIT_INVALID,
  EXIT_NON_GATING,
  EXIT_OK,
  EXIT_USAGE,
  MEMORY_FREEZE_PATH,
  parseArguments,
  runCli,
  type CliDeps,
  type FreezeRecord,
} from '../chunk-eval-cli';
import type { FetchLike } from '../selector-rag/embed';
import { buildCase, corpusDigest, CORPUS_SEED, CORPUS_VERSION, type ChunkEvalCase } from './corpus';
import { buildCaseV2, corpusV2Digest, CORPUS_V2_SEED, CORPUS_V2_VERSION, type ChunkEvalCaseV2 } from './corpus-v2';
import {
  ARM_SPECS,
  ArmEmbedder,
  EmbeddingCache,
  bundleOf,
  batchesOf,
  cachePath,
  cosine32,
  inScope,
  measureLatency,
  latencySample,
  pinArm,
  rankByScores,
  resolveArms,
  rrfFuse,
  type ArmId,
  type ArmPin,
} from './embed-arms';
import { PLAN_PARAMETERS, planDigest } from './embed-plan';
import { metricRow, runArmOnSet, type CaseScore } from './embed-eval';
import { decideEmbedder, runMemoryArm, buildMemoryReport, type ArmDecisionInput } from './memory-eval';
import { generateMemorySet, memoryDigest, MEMORY_SEED, MEMORY_VERSION, MEMORY_CUT_UNITS, singleVectorText } from './memory-set';

// ---------------------------------------------------------------- a fake loopback Ollama

interface FakeOptions {
  /** installed models: name -> manifest digest */
  readonly models?: Readonly<Record<string, string>>;
  readonly version?: string;
  /** an input longer than this many code points is refused with a 400 context error */
  readonly contextLimit?: number;
  /** model name -> details.parameter_size answered by /api/show (absent = no details) */
  readonly parameterSizes?: Readonly<Record<string, string>>;
  /** model name -> on-disk size in /api/tags */
  readonly sizes?: Readonly<Record<string, number>>;
}
const DIM = 64;
const hashOf = (term: string): number => {
  let h = 2166136261;
  for (const ch of term) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
  return h;
};
/** A bag-of-words hashing "embedding": shared terms give a positive cosine, so ranking is meaningful without a model. */
const embedText = (text: string): number[] => {
  const vector = new Array<number>(DIM).fill(0);
  for (const term of chunking.lexicalTerms(text)) vector[hashOf(term) % DIM] = (vector[hashOf(term) % DIM] as number) + 1;
  return vector;
};

function fakeOllama(options: FakeOptions = {}) {
  const models = options.models ?? { 'nomic-embed-text:latest': 'a'.repeat(64), 'nomic-embed-text-v2-moe:latest': 'b'.repeat(64), 'bge-m3:latest': 'c'.repeat(64), 'qwen3-embedding:0.6b': 'd'.repeat(64) };
  const urls: string[] = [];
  const embedBodies: { model: string; input: string[]; truncate: boolean; keep_alive: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (path === '/api/version') return reply(200, { version: options.version ?? '0.12.3' });
    if (path === '/api/tags') return reply(200, { models: Object.entries(models).map(([name, digest]) => ({ name, digest, size: options.sizes?.[name] ?? 1000 })) });
    if (path === '/api/show') {
      const asked = (JSON.parse(init?.body ?? '{}') as { model: string }).model;
      const size = options.parameterSizes?.[asked];
      return reply(200, size === undefined ? {} : { details: { parameter_size: size } });
    }
    if (path === '/api/ps') return reply(200, { models: [{ name: 'nomic-embed-text:latest', size: 400 * 1024 * 1024, size_vram: 0 }] });
    if (path === '/api/embed') {
      const body = JSON.parse(init?.body ?? '{}') as { model: string; input: string[]; truncate: boolean; keep_alive: unknown };
      embedBodies.push(body);
      if (body.input.length === 0) return reply(200, { embeddings: [] });
      if (options.contextLimit !== undefined && body.input.some((text) => Array.from(text).length > (options.contextLimit as number))) return reply(400, { error: 'the input length exceeds the context length' });
      return reply(200, { embeddings: body.input.map(embedText), prompt_eval_count: body.input.reduce((sum, text) => sum + Math.ceil(Array.from(text).length / 2), 0) });
    }
    return reply(404, {});
  };
  return { fetchImpl, urls, embedBodies, embedCalls: () => embedBodies.filter((body) => body.input.length > 0) };
}

const bigSample = Array.from({ length: 200 }, (_, at) => ({ text: `sample passage ${at}`, language: 'en' as const }));
const scratch = mkdtempSync(join(tmpdir(), 'chunk-embed-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const pinOf = async (arm: ArmId, fake = fakeOllama()): Promise<ArmPin> => pinArm(ARM_SPECS[arm], undefined, fake.fetchImpl);
const embedderOf = async (arm: ArmId, fake = fakeOllama(), cache = new EmbeddingCache()): Promise<ArmEmbedder> => {
  let now = 0;
  return new ArmEmbedder(await pinOf(arm, fake), { fetchImpl: fake.fetchImpl, cache, clock: () => (now += 10) });
};

// ---------------------------------------------------------------- pins, loopback, cloud

describe('arm pins', () => {
  it('pins model, digest12, runtime version, space id and the prefix policy of each arm', async () => {
    const e0 = await pinOf('E0');
    expect(e0).toMatchObject({ arm: 'E0', model: 'nomic-embed-text', digest12: 'a'.repeat(12), ollamaVersion: '0.12.3', spaceId: `nomic-embed-text@${'a'.repeat(12)}@ollama0.12.3`, queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' });
    expect(await pinOf('E1')).toMatchObject({ model: 'nomic-embed-text-v2-moe', queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' });
    expect(await pinOf('E2')).toMatchObject({ model: 'bge-m3', queryPrefix: '', documentPrefix: '' });
    const e3 = await pinOf('E3');
    expect(e3).toMatchObject({ model: 'qwen3-embedding:0.6b', documentPrefix: '' });
    expect(e3.queryPrefix).toBe('Instruct: Given a question, retrieve the passages that answer it\nQuery: ');
  });

  it('refuses a cloud model name and a non-loopback daemon, before any embedding call', async () => {
    const fake = fakeOllama();
    await expect(pinArm({ ...ARM_SPECS.E0, model: 'some-model-cloud' }, undefined, fake.fetchImpl)).rejects.toThrow(/cloud/);
    await expect(pinArm(ARM_SPECS.E0, 'http://example.com:11434', fake.fetchImpl)).rejects.toThrow(/loopback/);
    await expect(pinArm(ARM_SPECS.E0, 'https://127.0.0.1:11434', fake.fetchImpl)).rejects.toThrow(/loopback/);
    expect(() => new ArmEmbedder(({ ...(null as unknown as ArmPin), model: 'x' }) as ArmPin, { baseUrl: 'http://10.0.0.5:11434' })).toThrow(/loopback/);
    expect(fake.urls).toEqual([]);
    expect(fake.embedCalls()).toEqual([]);
  });

  it('drops a model that is not installed with a note and never pulls; other errors are thrown', async () => {
    const fake = fakeOllama({ models: { 'nomic-embed-text:latest': 'a'.repeat(64) } });
    const resolved = await resolveArms(['E0', 'E2', 'E3'], undefined, fake.fetchImpl);
    expect(resolved.available.map((pin) => pin.arm)).toEqual(['E0']);
    expect(resolved.dropped.map((d) => d.arm)).toEqual(['E2', 'E3']);
    expect(resolved.dropped[0]?.reason).toMatch(/not installed.*never pulls/);
    expect(fake.urls.every((url) => /\/api\/(version|tags|show)$/.test(url))).toBe(true);
    const broken: FetchLike = async () => {
      throw new Error('connection refused');
    };
    await expect(resolveArms(['E0'], undefined, broken)).rejects.toThrow(/connection refused/);
  });
});

// ---------------------------------------------------------------- embedding transport

describe('embedder transport', () => {
  it('sends batches of at most 16, one language per batch, truncate:false, and the right prefix per role', async () => {
    const fake = fakeOllama();
    const embedder = await embedderOf('E0', fake);
    const items = Array.from({ length: 40 }, (_, at) => ({ text: `passage number ${at}`, language: at < 25 ? ('en' as const) : ('ko' as const) }));
    expect(batchesOf(items).map((batch) => batch.length)).toEqual([15, 16, 9]);
    await embedder.embed('document', items);
    await embedder.embed('query', [{ text: 'a question', language: 'en' }]);
    const bodies = fake.embedCalls();
    expect(bodies.length).toBe(4);
    for (const body of bodies) {
      expect(body.input.length).toBeLessThanOrEqual(16);
      expect(body.truncate).toBe(false);
      expect(body.model).toBe('nomic-embed-text');
    }
    expect(bodies[0]?.input[0]).toBe('search_document: passage number 25');
    expect(bodies[3]?.input[0]).toBe('search_query: a question');
  });

  it('applies the E3 instruction on the query side only and no prefix for E2', async () => {
    const f3 = fakeOllama();
    const e3 = await embedderOf('E3', f3);
    await e3.embed('query', [{ text: 'q', language: 'en' }]);
    await e3.embed('document', [{ text: 'd', language: 'en' }]);
    expect(f3.embedCalls().map((b) => b.input[0])).toEqual(['Instruct: Given a question, retrieve the passages that answer it\nQuery: q', 'd']);
    const f2 = fakeOllama();
    const e2 = await embedderOf('E2', f2);
    await e2.embed('query', [{ text: 'q', language: 'en' }]);
    expect(f2.embedCalls()[0]?.input).toEqual(['q']);
  });

  it('a cache hit makes no call, in memory and across a new embedder reading the same file', async () => {
    const fake = fakeOllama();
    const file = cachePath(join(scratch, 'cache'), (await pinOf('E0')).spaceId);
    const first = await embedderOf('E0', fake, new EmbeddingCache(file));
    const items = [
      { text: 'alpha beta', language: 'en' as const },
      { text: 'alpha beta', language: 'en' as const },
      { text: '감마 델타', language: 'ko' as const },
    ];
    expect(first.plan('document', items)).toEqual({ unique: 2, cacheHits: 0, toEmbed: 2, calls: 2 });
    await first.embed('document', items);
    expect(fake.embedCalls().length).toBe(2);
    await first.embed('document', items);
    expect(fake.embedCalls().length).toBe(2);
    const second = await embedderOf('E0', fake, new EmbeddingCache(file));
    expect(second.plan('document', items)).toEqual({ unique: 2, cacheHits: 2, toEmbed: 0, calls: 0 });
    const vectors = await second.embed('document', items);
    expect(fake.embedCalls().length).toBe(2);
    expect(vectors.get('alpha beta')?.length).toBe(DIM);
    // the same text in the other role is a different key (the prefix differs) and does call
    await second.embed('query', [{ text: 'alpha beta', language: 'en' }]);
    expect(fake.embedCalls().length).toBe(3);
  });

  it('counts a passage over the model context as overContext (truncate:false), never cuts it, and does not retry it from the cache', async () => {
    const fake = fakeOllama({ contextLimit: 60 });
    const embedder = await embedderOf('E2', fake);
    const long = 'x'.repeat(100);
    const vectors = await embedder.embed('document', [
      { text: 'short one', language: 'en' },
      { text: long, language: 'en' },
      { text: 'short two', language: 'en' },
    ]);
    expect(vectors.get(long)).toBeNull();
    expect(vectors.get('short one')?.length).toBe(DIM);
    expect(vectors.get('short two')?.length).toBe(DIM);
    expect(embedder.overContext).toBe(1);
    const before = fake.embedCalls().length;
    await embedder.embed('document', [{ text: long, language: 'en' }]);
    expect(fake.embedCalls().length).toBe(before);
    expect(fake.embedBodies.every((body) => body.truncate === false)).toBe(true);
  });

  it('treats any other failure as an error (a provider outage is INVALID upstream), not as over-context', async () => {
    const down: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/embed') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return fakeOllama().fetchImpl(url);
    };
    const embedder = new ArmEmbedder(await pinOf('E0'), { fetchImpl: down });
    await expect(embedder.embed('document', [{ text: 'a', language: 'en' }])).rejects.toThrow(/status 500/);
  });
});

// ---------------------------------------------------------------- ranking, fusion, metrics

describe('ranking, RRF and metrics', () => {
  it('ranks by score with ties by ordinal', () => {
    expect(rankByScores([0.2, 0.9, 0.9, -Infinity, 0.5])).toEqual([1, 2, 4, 0, 3]);
  });

  it('fuses rankings by reciprocal rank with k = 60, ties by ordinal', () => {
    const fused = rrfFuse([
      [0, 1, 2],
      [2, 1, 0],
    ]);
    // score(0) = 1/61 + 1/63 = score(2); score(1) = 2/62, slightly smaller
    expect(fused).toEqual([0, 2, 1]);
    expect(rrfFuse([[3, 1], [1]], 60)).toEqual([1, 3]);
    const score = (rank: number): number => 1 / (60 + rank);
    expect(score(1) + score(3)).toBeCloseTo(1 / 61 + 1 / 63, 12);
    // k changes the outcome: with k = 0 rank 1 dominates
    expect(rrfFuse([[5, 6], [6, 5, 7]], 0)).toEqual([5, 6, 7]);
  });

  it('computes Recall@k, MRR, nDCG and window recall on a hand-built set of three cases', () => {
    const item = { id: 'x', shape: 'mail', language: 'en', needleKind: 'date', depth: 50, length: 6000 } as unknown as ChunkEvalCase;
    const scores: CaseScore[] = [
      { item, rank: 1, ndcg: 1, windowHit: true },
      { item, rank: 4, ndcg: 0.4307, windowHit: false },
      { item, rank: null, ndcg: 0, windowHit: false },
    ];
    expect(metricRow(scores)).toEqual({ n: 3, recallAt1: 0.3333, recallAt3: 0.3333, recallAt5: 0.6667, recallAt10: 0.6667, mrr: 0.4167, ndcgAt10: 0.4769, windowRecall: 0.3333 });
  });

  it('latency sample is a fixed stride over de-duplicated v2 passages (at most 200)', () => {
    const bundles = [bundleOf(buildCase('mail', 6_000, 50, 'ko', 0)), bundleOf(buildCase('thread', 6_000, 30, 'en', 1))];
    const sample = latencySample(bundles, 5);
    expect(sample.length).toBe(5);
    expect(latencySample(bundles, 5)).toEqual(sample);
    expect(new Set(sample.map((item) => item.text)).size).toBe(5);
    expect(latencySample(bundles, 100000).length).toBe(new Set(bundles.flatMap((bundle) => bundle.texts)).size);
  });
});

// ---------------------------------------------------------------- scope and the CH1 run

describe('scope and CH1 run with a fake daemon', () => {
  const adr = buildCase('adr-file', 6_000, 70, 'mixed', 2);
  const mail = buildCase('mail', 6_000, 50, 'ko', 0);
  it('phase1 runs the v1 adr-file shape on E0 only; v2 and every other shape on every arm; --shapes narrows', () => {
    expect(inScope('phase1', undefined, 'v1', 'E0', adr)).toBe(true);
    for (const arm of ['E1', 'E2', 'E3'] as const) expect(inScope('phase1', undefined, 'v1', arm, adr)).toBe(false);
    for (const arm of ['E0', 'E1', 'E2', 'E3'] as const) {
      expect(inScope('phase1', undefined, 'v1', arm, mail)).toBe(true);
      expect(inScope('phase1', undefined, 'v2', arm, adr)).toBe(true);
      expect(inScope('all', undefined, 'v1', arm, adr)).toBe(true);
    }
    expect(inScope('all', ['mail'], 'v1', 'E0', adr)).toBe(false);
    expect(inScope('all', ['mail'], 'v1', 'E0', mail)).toBe(true);
  });

  it('reports E, EH and EL on the same cases, with fit, cost and strata', async () => {
    const bundles = [mail, buildCase('thread', 6_000, 30, 'en', 1), adr].map(bundleOf);
    const e0 = await embedderOf('E0');
    const run0 = await runArmOnSet(e0, { set: 'v1', bundles, scope: 'phase1' });
    expect(run0.cases).toBe(3);
    expect(run0.shapes.sort()).toEqual(['adr-file', 'mail', 'thread']);
    expect(run0.embedder.overall.n).toBe(3);
    expect(run0.hybrid.overall.n).toBe(3);
    expect(run0.EL.overall.n).toBe(3);
    expect(Object.keys(run0.embedder.byLanguage).sort()).toEqual(['en', 'ko', 'mixed']);
    expect(Object.keys(run0.embedder.byDepth)).toEqual(['30', '50', '70']);
    expect(run0.fit.byLanguage.ko?.tokensPerHangulSyllable).not.toBeNull();
    expect(run0.cost.calls).toBeGreaterThan(0);
    expect(run0.cost.resident?.sizeBytes).toBe(400 * 1024 * 1024);
    const e1 = await embedderOf('E1');
    const run1 = await runArmOnSet(e1, { set: 'v1', bundles, scope: 'phase1' });
    expect(run1.cases).toBe(2);
    expect(run1.shapes).not.toContain('adr-file');
  });

  it('EH(x) equals the RRF of the arm ranking and the EL full ranking (a case where the fused ranking differs from both)', async () => {
    const bundle = bundleOf(mail);
    const embedder = await embedderOf('E0');
    const run = await runArmOnSet(embedder, { set: 'v1', bundles: [bundle], scope: 'phase1' });
    // with the bag-of-words fake and the lexical ranker both reading the same terms, the case must still be well formed
    expect(run.hybrid.overall.recallAt10).toBeGreaterThanOrEqual(0);
    expect(run.hybrid.overall.n).toBe(1);
  });

  it('v2 strata carry the feature tags', async () => {
    const v2 = buildCaseV2({ shape: 'mail', length: 6_000, depth: 50, language: 'ko', lengthAt: 0, depthAt: 2, languageAt: 0 });
    const run = await runArmOnSet(await embedderOf('E0'), { set: 'v2', bundles: v2.map(bundleOf), scope: 'phase1' });
    expect(run.embedder.byFeature?.all?.n).toBe(v2.length);
    expect(run.embedder.byShapeFeature?.mail).toBeDefined();
  });
});

// ---------------------------------------------------------------- memory set (CH7)

describe('CH7 memory set', () => {
  const set = generateMemorySet();
  it('meets the section 7 size: >= 150 memories and queries, >= 20 long, Korean / English / mixed', () => {
    expect(set.memories.length).toBeGreaterThanOrEqual(150);
    expect(set.queries.length).toBeGreaterThanOrEqual(150);
    expect(set.memories.filter((memory) => memory.long).length).toBeGreaterThanOrEqual(20);
    expect([...new Set(set.memories.map((memory) => memory.language))].sort()).toEqual(['en', 'ko', 'mixed']);
    expect(new Set(set.memories.map((memory) => memory.id)).size).toBe(set.memories.length);
    expect(new Set(set.queries.map((query) => query.id)).size).toBe(set.queries.length);
  });

  it('every query has exactly its gold memory id, in the same language', () => {
    const byId = new Map(set.memories.map((memory) => [memory.id, memory]));
    for (const query of set.queries) {
      expect(query.gold.length).toBe(1);
      expect(byId.get(query.gold[0] as string)?.language).toBe(query.language);
    }
  });

  it('long memories span several C1 passages and nine of them are over the 8,000-unit cut, with queries on the tail facts', () => {
    const long = set.memories.filter((memory) => memory.long);
    for (const memory of long) expect(chunking.chunk(memory.text).length).toBeGreaterThanOrEqual(3);
    expect(long.filter((memory) => memory.text.length > MEMORY_CUT_UNITS).length).toBe(9);
    expect(singleVectorText(long[0]?.text as string).length).toBe(MEMORY_CUT_UNITS);
    const beyond = set.queries.filter((query) => query.beyondCut);
    expect(beyond.length).toBeGreaterThanOrEqual(9);
    for (const query of beyond) {
      const memory = set.memories.find((item) => item.id === query.gold[0]);
      expect((memory?.factOffsets[query.factIndex as number] as number) >= MEMORY_CUT_UNITS).toBe(true);
    }
  });

  it('many queries share no word with their memory (measured with Core lexical terms), and the rest are labelled shared', () => {
    const none = set.queries.filter((query) => query.sharedTerms === 0);
    expect(none.length).toBeGreaterThanOrEqual(set.queries.length / 2);
    for (const query of set.queries.filter((item) => item.mode === 'shared')) expect(query.sharedTerms).toBeGreaterThan(0);
  });

  it('uses no real-looking data: no URL, e-mail address or token-like literal', () => {
    for (const text of [...set.memories.map((memory) => memory.text), ...set.queries.map((query) => query.text)]) expect(text).not.toMatch(/https?:|@[a-z]+\.|\bsk-|AKIA|password|secret|token|[A-Za-z0-9]{24,}/iu);
  });

  it('is deterministic and matches its recorded freeze; any one-character change moves the digest', () => {
    const record = JSON.parse(readFileSync(MEMORY_FREEZE_PATH, 'utf8')) as FreezeRecord;
    expect(record.version).toBe(MEMORY_VERSION);
    expect(record.seed).toBe(MEMORY_SEED);
    expect(record.cases).toBe(set.memories.length + set.queries.length);
    expect(memoryDigest(generateMemorySet())).toBe(memoryDigest(set));
    expect(memoryDigest(set)).toBe(record.sha256);
    const edited = { memories: set.memories, queries: set.queries.map((query, at) => (at === 7 ? { ...query, text: `${query.text}?` } : query)) };
    expect(memoryDigest(edited)).not.toBe(record.sha256);
  });

  it('single-vector vs multi-vector, per language, with the fake daemon; the report has the verdict and the EL baseline', async () => {
    const embedder = await embedderOf('E0');
    const run = await runMemoryArm(embedder, set, { sample: bigSample, query: { text: 'q', language: 'en' } });
    expect(run.single.overall.n).toBe(set.queries.length);
    expect(run.multi.longMemories.n).toBe(set.queries.filter((query) => query.targetLong).length);
    expect(Object.keys(run.multi.byLanguage)).toEqual(['ko', 'en', 'mixed']);
    expect(run.latency?.meetsBar).toBe(true);
    expect(run.fit.singleOverContext).toBe(0);
    const report = buildMemoryReport(set, memoryDigest(set), { E0: run }, { digest: 'p'.repeat(64), planned: ['E0'], dropped: [] }, true);
    expect(report.EL.overall.n).toBe(set.queries.length);
    expect(report.verdict?.verdict).toBe('KEEP_E0');
    expect(buildMemoryReport(set, memoryDigest(set), {}, { digest: null, planned: [], dropped: [] }, false).verdict).toBeNull();
  });

  it('counts a whole memory over the model context as single-vector overContext while the passages still fit', async () => {
    const fake = fakeOllama({ contextLimit: 3_000 });
    const embedder = await embedderOf('E0', fake);
    const run = await runMemoryArm(embedder, set);
    expect(run.fit.singleOverContext).toBeGreaterThan(0);
    expect(run.fit.passageOverContext).toBe(0);
    expect(run.latency).toBeNull();
  });
});

// ---------------------------------------------------------------- decision rule

describe('decision rule (section 6, ratified 2026-11-05)', () => {
  const PARAMS: Record<ArmId, number> = { E0: 137, E1: 475, E2: 568, E3: 596 };
  const input = (arm: ArmId, ko: number, en: number, ms = 1000, bar = true): ArmDecisionInput => ({ arm, koRecallAt5: ko, enRecallAt5: en, time200Ms: ms, paramsM: PARAMS[arm], sizeBytes: null, latencyMeetsBar: bar, latencyReason: bar ? null : 'input(s) refused as over the model context' });
  const base = input('E0', 0.4, 0.8);

  it('breaks a tie with one size metric for the whole tied group, whatever the input order (Codex P2, round 3)', () => {
    const tied = (arm: ArmId, paramsM: number | null, sizeBytes: number | null): ArmDecisionInput => ({ ...input(arm, 0.9, 0.8), paramsM, sizeBytes });
    const arms = [tied('E1', 100, 900), tied('E2', 200, 100), tied('E3', null, 500)];
    const orders = [arms, [...arms].reverse(), [arms[1], arms[2], arms[0]] as ArmDecisionInput[]];
    // E3 has no parameter count, so the on-disk size decides for all three: E2 (100 bytes).
    for (const order of orders) expect(decideEmbedder(['E0', 'E1', 'E2', 'E3'], [base, ...order]).chosen).toBe('E2');
    // With every count pinned, the parameter count decides: E1.
    const pinned = [tied('E1', 100, 900), tied('E2', 200, 100), tied('E3', 300, 500)];
    for (const order of [pinned, [...pinned].reverse()]) expect(decideEmbedder(['E0', 'E1', 'E2', 'E3'], [base, ...order]).chosen).toBe('E1');
  });

  it('says no arm is chosen until all planned arms ran when one is missing or E0 is absent', () => {
    const verdict = decideEmbedder(['E0', 'E1', 'E2'], [base, input('E1', 0.9, 0.8)]);
    expect(verdict.verdict).toBe('INCOMPLETE');
    expect(verdict.chosen).toBeNull();
    expect(verdict.text).toMatch(/^no arm is chosen until all planned arms ran/);
    expect(verdict.text).toMatch(/E2/);
    expect(decideEmbedder(['E1'], [input('E1', 0.9, 0.8)]).verdict).toBe('INCOMPLETE');
  });

  it('keeps E0 when no arm beats it on Korean by at least 5 points (4.99 does not, 5.00 does)', () => {
    expect(decideEmbedder(['E0', 'E1'], [base, input('E1', 0.4499, 0.8)]).verdict).toBe('KEEP_E0');
    const exact = decideEmbedder(['E0', 'E1'], [base, input('E1', 0.45, 0.8)]);
    expect(exact.verdict).toBe('CHOOSE');
    expect(exact.chosen).toBe('E1');
    expect(decideEmbedder(['E0'], [base]).verdict).toBe('KEEP_E0');
  });

  it('excludes an arm over the latency bar (8 s for 200 passages + 1 query)', () => {
    const verdict = decideEmbedder(['E0', 'E1'], [base, input('E1', 0.9, 0.8, 8001)]);
    expect(verdict.verdict).toBe('KEEP_E0');
    expect(decideEmbedder(['E0', 'E1'], [base, input('E1', 0.9, 0.8, 8000)]).chosen).toBe('E1');
  });

  it('excludes an arm more than 2 points worse than E0 on English (exactly 2 is allowed)', () => {
    expect(decideEmbedder(['E0', 'E1'], [base, input('E1', 0.9, 0.7799)]).verdict).toBe('KEEP_E0');
    expect(decideEmbedder(['E0', 'E1'], [base, input('E1', 0.9, 0.78)]).chosen).toBe('E1');
  });

  it('picks the highest Korean Recall@5 among the eligible arms, and the smaller model on a tie', () => {
    const verdict = decideEmbedder(['E0', 'E1', 'E2', 'E3'], [base, input('E1', 0.6, 0.8), input('E2', 0.7, 0.8), input('E3', 0.7, 0.8)]);
    expect(verdict.chosen).toBe('E2');
    const tie = decideEmbedder(['E0', 'E1', 'E2', 'E3'], [base, input('E1', 0.7, 0.8), input('E2', 0.7, 0.8), input('E3', 0.7, 0.8)]);
    expect(tie.chosen).toBe('E1');
    // the best Korean arm is excluded by the English bound, so the next eligible arm wins
    const bound = decideEmbedder(['E0', 'E1', 'E2'], [base, input('E1', 0.95, 0.5), input('E2', 0.6, 0.8)]);
    expect(bound.chosen).toBe('E2');
    expect(bound.reasons.length).toBe(3);
    expect(bound.inputs.find((i) => i.arm === 'E1')?.englishWithin2Points).toBe(false);
  });
});

// ---------------------------------------------------------------- CLI: plan digest, BLOCKED, run

describe('CLI embedder modes', () => {
  const v1 = [buildCase('mail', 6_000, 50, 'ko', 0), buildCase('adr-file', 6_000, 70, 'en', 1)];
  const v2: ChunkEvalCaseV2[] = buildCaseV2({ shape: 'mail', length: 6_000, depth: 50, language: 'en', lengthAt: 0, depthAt: 2, languageAt: 1 });
  const memory = generateMemorySet();
  const make = (fake = fakeOllama(), overrides: Partial<CliDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, { name: string; report: unknown }> = {};
    let now = 0;
    const deps: CliDeps = {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date('2026-11-05T00:00:00Z'),
      corpus: () => v1,
      readFreeze: () => ({ version: CORPUS_VERSION, seed: CORPUS_SEED, cases: v1.length, sha256: corpusDigest(v1) }),
      writeFreeze: () => undefined,
      writeReport: (dir, name, report) => {
        written[name] = { name, report };
        return `${dir}/${name}`;
      },
      v2: { corpus: () => v2, readFreeze: () => ({ version: CORPUS_V2_VERSION, seed: CORPUS_V2_SEED, cases: v2.length, sha256: corpusV2Digest(v2) }), writeFreeze: () => undefined },
      memory: { corpus: () => memory, readFreeze: () => ({ version: MEMORY_VERSION, seed: MEMORY_SEED, cases: memory.memories.length + memory.queries.length, sha256: memoryDigest(memory) }), writeFreeze: () => undefined },
      embed: { fetch: fake.fetchImpl, cacheDir: null, clock: () => (now += 7) },
      ...overrides,
    };
    return { deps, out, err, written, fake };
  };
  const digestOf = (out: string[]): string => (out.find((line) => line.startsWith('plan digest: ')) as string).slice('plan digest: '.length);

  it('parses the new options and rejects misuse with exit 2', async () => {
    expect(parseArguments(['--mode', 'plan']).arms).toBeUndefined();
    expect(parseArguments(['--set', 'memory', '--arms', 'E0,E3', '--mode', 'run']).arms).toEqual(['E0', 'E3']);
    for (const argv of [
      ['--mode', 'run', '--arms', 'E9'],
      ['--mode', 'run', '--arms', 'E0,E0'],
      ['--mode', 'verify', '--arms', 'E0'],
      ['--set', 'drive-format', '--arms', 'E0', '--mode', 'run'],
      ['--mode', 'plan', '--set', 'v1'],
      ['--mode', 'plan', '--scope', 'nope'],
      ['--mode', 'plan', '--shapes', 'nope'],
      ['--mode', 'plan', '--plan-digest', 'abc'],
      ['--mode', 'run', '--plan-digest', 'a'.repeat(64)],
    ])
      expect(await runCli(argv, make().deps), argv.join(' ')).toBe(EXIT_USAGE);
  });

  it('plan makes zero embedding calls, is stable, and changes with a pin, the scope, the arms or a shape filter', async () => {
    const a = make();
    expect(await runCli(['--mode', 'plan'], a.deps)).toBe(EXIT_OK);
    expect(a.fake.embedBodies).toEqual([]);
    expect(a.fake.urls.every((url) => /\/api\/(version|tags|show)$/.test(url))).toBe(true);
    const digest = digestOf(a.out);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.out.join('\n')).toMatch(/E0 nomic-embed-text@a{12}/);
    const b = make();
    await runCli(['--mode', 'plan'], b.deps);
    expect(digestOf(b.out)).toBe(digest);
    const pinChanged = make(fakeOllama({ models: { 'nomic-embed-text:latest': 'f'.repeat(64) } }));
    await runCli(['--mode', 'plan'], pinChanged.deps);
    expect(digestOf(pinChanged.out)).not.toBe(digest);
    for (const extra of [['--scope', 'all'], ['--arms', 'E0,E1'], ['--shapes', 'mail']]) {
      const other = make();
      await runCli(['--mode', 'plan', ...extra], other.deps);
      expect(digestOf(other.out), extra.join(' ')).not.toBe(digest);
    }
    const written = Object.values(a.written)[0]?.report as { arms: { arm: string; v1: { cases: number } }[]; dropped: unknown[] };
    expect(written.arms.map((arm) => arm.arm)).toEqual(['E0', 'E1', 'E2', 'E3']);
    expect(written.arms[0]?.v1.cases).toBe(2);
    expect(written.arms[1]?.v1.cases).toBe(1);
  });

  it('plan lists a missing model as dropped, not as a failure', async () => {
    const run = make(fakeOllama({ models: { 'nomic-embed-text:latest': 'a'.repeat(64) } }));
    expect(await runCli(['--mode', 'plan'], run.deps)).toBe(EXIT_OK);
    expect(run.out.join('\n')).toMatch(/dropped \(not installed\): E1, E2, E3/);
  });

  it('a run or probe with embedder arms and a missing or different plan digest is BLOCKED (exit 3) without any embedding call', async () => {
    const plan = make();
    await runCli(['--mode', 'plan', '--arms', 'E0'], plan.deps);
    const digest = digestOf(plan.out);
    const wrong = make();
    expect(await runCli(['--set', 'v1', '--arms', 'E0', '--plan-digest', 'e'.repeat(64), '--mode', 'run'], wrong.deps)).toBe(EXIT_BLOCKED);
    expect(wrong.fake.embedBodies).toEqual([]);
    expect(Object.keys(wrong.written)).toEqual([]);
    const missing = make();
    expect(await runCli(['--set', 'v2', '--arms', 'E0', '--mode', 'run'], missing.deps)).toBe(EXIT_BLOCKED);
    expect(missing.fake.embedBodies).toEqual([]);
    const probe = make();
    expect(await runCli(['--mode', 'probe', '--arms', 'E0', '--plan-digest', 'e'.repeat(64)], probe.deps)).toBe(EXIT_BLOCKED);
    expect(probe.fake.embedBodies).toEqual([]);
    // the digest of a plan for other arms, scope or pins does not unlock this run
    const otherArms = make();
    expect(await runCli(['--set', 'v1', '--arms', 'E0,E1', '--plan-digest', digest, '--mode', 'run'], otherArms.deps)).toBe(EXIT_BLOCKED);
    expect(otherArms.fake.embedBodies).toEqual([]);
    const drifted = make(fakeOllama({ version: '0.99.0' }));
    expect(await runCli(['--set', 'v1', '--arms', 'E0', '--plan-digest', digest, '--mode', 'run'], drifted.deps)).toBe(EXIT_BLOCKED);
    expect(drifted.fake.embedBodies).toEqual([]);
  });

  it('is BLOCKED when a set differs from its record, before any pin or embedding call', async () => {
    const run = make(fakeOllama(), { readFreeze: () => undefined });
    expect(await runCli(['--mode', 'plan'], run.deps)).toBe(EXIT_BLOCKED);
    expect(run.fake.urls).toEqual([]);
  });

  it('runs v1 with the matching digest: NON-GATING, scope phase1 keeps adr-file on E0, report names the plan digest', async () => {
    const plan = make();
    await runCli(['--mode', 'plan', '--arms', 'E0,E1'], plan.deps);
    const digest = digestOf(plan.out);
    const run = make();
    expect(await runCli(['--set', 'v1', '--arms', 'E0,E1', '--plan-digest', digest, '--mode', 'run', '--out', join(scratch, 'out')], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.fake.embedCalls().length).toBeGreaterThan(0);
    const report = Object.values(run.written)[0] as { name: string; report: { plan: { digest: string }; arms: Record<string, { cases: number; shapes: string[] }>; status: string } };
    expect(report.name).toMatch(/^chunk-eval-embed-v1-[0-9a-f]{12}-2026-11-05T00-00-00-000Z\.json$/);
    expect(report.report.plan.digest).toBe(digest);
    expect(report.report.arms.E0?.cases).toBe(2);
    expect(report.report.arms.E1?.cases).toBe(1);
    expect(run.out.join('\n')).not.toMatch(/PASSED/);
    expect(run.out.join('\n')).toMatch(/EH\(E0\)/);
  });

  it('runs v2 and the memory set (with the verdict) under the same digest, and probes with the sample', async () => {
    const plan = make();
    await runCli(['--mode', 'plan', '--arms', 'E0,E2'], plan.deps);
    const digest = digestOf(plan.out);
    const v2run = make();
    expect(await runCli(['--set', 'v2', '--arms', 'E0,E2', '--plan-digest', digest, '--mode', 'run'], v2run.deps)).toBe(EXIT_NON_GATING);
    const memRun = make();
    expect(await runCli(['--set', 'memory', '--arms', 'E0,E2', '--plan-digest', digest, '--mode', 'run'], memRun.deps)).toBe(EXIT_NON_GATING);
    const report = Object.values(memRun.written)[0] as { report: { verdict: { verdict: string; text: string }; arms: Record<string, unknown> } };
    expect(Object.keys(report.report.arms)).toEqual(['E0', 'E2']);
    expect(['KEEP_E0', 'CHOOSE']).toContain(report.report.verdict.verdict);
    expect(memRun.out.join('\n')).toMatch(/verdict: /);
    const probe = make();
    expect(await runCli(['--mode', 'probe', '--arms', 'E0,E2', '--plan-digest', digest], probe.deps)).toBe(EXIT_NON_GATING);
    expect(probe.out.join('\n')).toMatch(/cold .* warm .* for 200 passages \+ 1 query/);
    const probeReport = Object.values(probe.written)[0] as { report: { arms: Record<string, { cold: { passages: number } }> } };
    expect(probeReport.report.arms.E0?.cold.passages).toBeGreaterThan(0);
  });

  it('a verdict with a missing planned arm says no arm is chosen until all planned arms ran', async () => {
    const fake = fakeOllama({ models: { 'nomic-embed-text:latest': 'a'.repeat(64) } });
    const plan = make(fake);
    await runCli(['--mode', 'plan', '--arms', 'E0,E2'], plan.deps);
    const run = make(fake);
    expect(await runCli(['--set', 'memory', '--arms', 'E0,E2', '--plan-digest', digestOf(plan.out), '--mode', 'run'], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.out.join('\n')).toMatch(/verdict: no arm is chosen until all planned arms ran \(missing: E2\)/);
  });

  it('exits 5 INVALID (never a failure of the gate) when the daemon fails mid-run, and 5 when every planned model is missing', async () => {
    const plan = make();
    await runCli(['--mode', 'plan', '--arms', 'E0'], plan.deps);
    const digest = digestOf(plan.out);
    const good = fakeOllama();
    const flaky: FetchLike = async (url, init) => (new URL(url).pathname === '/api/embed' ? { ok: false, status: 503, json: async () => ({}) } : good.fetchImpl(url, init));
    const broken = make(fakeOllama(), { embed: { fetch: flaky, cacheDir: null } });
    expect(await runCli(['--set', 'v1', '--arms', 'E0', '--plan-digest', digest, '--mode', 'run'], broken.deps)).toBe(EXIT_INVALID);
    const none = make(fakeOllama({ models: {} }));
    await runCli(['--mode', 'plan', '--arms', 'E0'], none.deps);
    expect(await runCli(['--set', 'v1', '--arms', 'E0', '--plan-digest', digestOf(none.out), '--mode', 'run'], none.deps)).toBe(EXIT_INVALID);
  });

  it('memory set: verify and regenerate-freeze with the same BLOCKED semantics; no --arms runs the EL baseline only with no pin read', async () => {
    const ok = make();
    expect(await runCli(['--set', 'memory', '--mode', 'verify'], ok.deps)).toBe(EXIT_OK);
    const stale = make(fakeOllama(), { memory: { corpus: () => memory, readFreeze: () => ({ version: MEMORY_VERSION, seed: MEMORY_SEED, cases: 1, sha256: 'a'.repeat(64) }), writeFreeze: () => undefined } });
    expect(await runCli(['--set', 'memory', '--mode', 'verify'], stale.deps)).toBe(EXIT_BLOCKED);
    expect(await runCli(['--set', 'memory', '--mode', 'run'], stale.deps)).toBe(EXIT_BLOCKED);
    const none = make(fakeOllama(), { memory: { corpus: () => memory, readFreeze: () => undefined, writeFreeze: () => undefined } });
    expect(await runCli(['--set', 'memory', '--mode', 'verify'], none.deps)).toBe(EXIT_BLOCKED);
    let recorded: FreezeRecord | undefined;
    const regen = make(fakeOllama(), { memory: { corpus: () => memory, readFreeze: () => recorded, writeFreeze: (record) => (recorded = record) } });
    expect(await runCli(['--set', 'memory', '--mode', 'regenerate-freeze'], regen.deps)).toBe(EXIT_OK);
    expect(recorded?.sha256).toBe(memoryDigest(memory));
    const baseline = make();
    expect(await runCli(['--set', 'memory', '--mode', 'run'], baseline.deps)).toBe(EXIT_NON_GATING);
    expect(baseline.fake.urls).toEqual([]);
    expect(baseline.out.join('\n')).toMatch(/^EL /m);
  });

  it('keeps the existing run unchanged when no --arms is given: no daemon contact, the v1 report as before', async () => {
    const run = make();
    expect(await runCli(['--mode', 'run', '--out', join(scratch, 'v1')], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.fake.urls).toEqual([]);
    expect(Object.keys(run.written)[0]).toMatch(/^chunk-eval-[0-9a-f]{12}-/);
    expect((Object.values(run.written)[0]?.report as { kind: string }).kind).toBe('chunk-eval');
  });
});


// ---------------------------------------------------------------- review fixes (Codex P2)

describe('cache integrity, cached refusals, timed refusals, plan digest coverage', () => {
  const texts = [
    { text: 'alpha beta', language: 'en' as const },
    { text: 'gamma delta', language: 'en' as const },
  ];

  it('rejects an invalid cached row (bad checksum, wrong dimension, non-finite, torn) as a miss, counts cacheRejected, and re-embeds', async () => {
    const fake = fakeOllama();
    const file = cachePath(join(scratch, 'integrity'), (await pinOf('E0')).spaceId);
    const first = await embedderOf('E0', fake, new EmbeddingCache(file));
    await first.embed('document', texts);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.length).toBe(2);
    // row 0: payload edited after the checksum; row 1 stays valid; plus a torn line and a non-finite vector with a matching checksum
    writeFileSync(file, `${JSON.stringify({ ...rows[0], v: Buffer.from(new Float32Array(DIM).fill(1).buffer).toString('base64') })}\n${JSON.stringify(rows[1])}\n{"k":"torn\n`);
    const second = await embedderOf('E0', fake, new EmbeddingCache(file));
    expect(second.cacheRejected).toBe(2);
    const before = fake.embedCalls().length;
    expect(second.plan('document', texts)).toMatchObject({ cacheHits: 1, toEmbed: 1 });
    await second.embed('document', texts);
    expect(fake.embedCalls().length).toBe(before + 1);
  });

  it('a cached vector of another dimension than the arm is a miss (counted), and cosine32 throws on a dimension mismatch', async () => {
    const fake = fakeOllama();
    const spaceId = (await pinOf('E0')).spaceId;
    const cache = new EmbeddingCache();
    cache.set(EmbeddingCache.key(spaceId, 'search_document: alpha beta'), new Float32Array(3).fill(1));
    const embedder = await embedderOf('E0', fake, cache);
    const vectors = await embedder.embed('document', [texts[0] as (typeof texts)[number], texts[1] as (typeof texts)[number]]);
    expect(vectors.get('alpha beta')?.length).toBe(DIM);
    expect(embedder.cacheRejected).toBe(1);
    expect(fake.embedCalls().length).toBe(2);
    expect(() => cosine32(new Float32Array(3), new Float32Array(4))).toThrow(/different dimensions/);
    expect(() => cosine32(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).not.toThrow();
  });

  it('a cached refusal still counts in overContext, with its own cachedRefusals count, so fit does not depend on cache history', async () => {
    const fake = fakeOllama({ contextLimit: 20 });
    const long = [{ text: 'y'.repeat(50), language: 'en' as const }, texts[0] as (typeof texts)[number]];
    const cache = new EmbeddingCache();
    const fresh = await embedderOf('E2', fake, cache);
    await fresh.embed('document', long);
    expect(fresh.overContext).toBe(1);
    expect(fresh.cachedRefusals).toBe(0);
    const again = await embedderOf('E2', fake, cache);
    const calls = fake.embedCalls().length;
    await again.embed('document', long);
    expect(fake.embedCalls().length).toBe(calls);
    expect(again.overContext).toBe(1);
    expect(again.cachedRefusals).toBe(1);
  });

  it('a refusal inside a timed block counts in calls and overContext, and the block cannot meet the latency bar', async () => {
    const fake = fakeOllama({ contextLimit: 20 });
    const embedder = await embedderOf('E2', fake);
    const sample = [...bigSample.slice(0, 199), { text: 'z'.repeat(50), language: 'en' as const }];
    const block = await measureLatency(embedder, { text: 'q', language: 'en' }, sample, false);
    expect(block.overContext).toBe(1);
    expect(block.meetsBar).toBe(false);
    expect(block.reason).toMatch(/refused/);
    expect(block.calls).toBeGreaterThanOrEqual(4);
    expect(block.reason).not.toMatch(/smaller/);
    expect(embedder.overContext).toBe(1);
    const clean = await measureLatency(await embedderOf('E2', fakeOllama()), { text: 'q', language: 'en' }, bigSample, false);
    expect(clean).toMatchObject({ meetsBar: true, reason: null, overContext: 0 });
  });

  it('a latency block with no successful call cannot qualify', async () => {
    const fake = fakeOllama({ contextLimit: 1 });
    const block = await measureLatency(await embedderOf('E2', fake), { text: 'qq', language: 'en' }, bigSample, false);
    expect(block.meetsBar).toBe(false);
    expect(block.reason).toMatch(/refused|no successful call/);
  });

  it('the plan digest covers every concrete measurement parameter: changing any one value changes it', async () => {
    const resolved = await resolveArms(['E0'], undefined, fakeOllama().fetchImpl);
    const inputs = { sets: { v1: { digest: 'a' }, v2: { digest: 'b' }, memory: { digest: 'c' } }, resolved, scope: 'phase1' as const };
    const base = planDigest(inputs);
    expect(planDigest(inputs, PLAN_PARAMETERS)).toBe(base);
    const paths: string[][] = [];
    const walk = (value: unknown, path: string[]): void => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) for (const [key, inner] of Object.entries(value)) walk(inner, [...path, key]);
      else paths.push(path);
    };
    walk(PLAN_PARAMETERS, []);
    const names = paths.map((path) => path.join('.'));
    for (const must of ['passage.maxCodePoints', 'passage.maxEstTokens', 'passage.targetCodePoints', 'passage.overlapMaxCodePoints', 'passage.overlapMaxFraction', 'window.maxCodePoints', 'window.maxEstTokens', 'window.packingMissLimit', 'rrfK', 'recallKs', 'ndcgK', 'memoryCutUnits', 'batch', 'keepAlive', 'latency.passages', 'latency.queries', 'latency.budgetMs', 'decision.englishToleranceBp', 'decision.koreanGainBp'])
      expect(names, must).toContain(must);
    for (const path of paths) {
      const clone = JSON.parse(JSON.stringify(PLAN_PARAMETERS)) as Record<string, unknown>;
      let holder = clone;
      for (const key of path.slice(0, -1)) holder = holder[key] as Record<string, unknown>;
      const last = path[path.length - 1] as string;
      const old = holder[last];
      holder[last] = Array.isArray(old) ? [...old, 99] : typeof old === 'number' ? old + 1 : typeof old === 'boolean' ? !old : `${String(old)}!`;
      expect(planDigest(inputs, clone), path.join('.')).not.toBe(base);
    }
  });
});


describe('round-2 review fixes', () => {
  const PARAMS: Record<ArmId, number> = { E0: 137, E1: 475, E2: 568, E3: 596 };
  const di = (arm: ArmId, ko: number, en: number, bar = true, extra: Partial<ArmDecisionInput> = {}): ArmDecisionInput => ({ arm, koRecallAt5: ko, enRecallAt5: en, time200Ms: 1000, paramsM: PARAMS[arm], sizeBytes: null, latencyMeetsBar: bar, latencyReason: bar ? null : 'sample smaller than the bar', ...extra });

  it('the verdict excludes an arm whose latency block did not meet the bar, with the recorded reason', () => {
    const verdict = decideEmbedder(['E0', 'E1'], [di('E0', 0.4, 0.8), di('E1', 0.9, 0.8, false)]);
    expect(verdict.verdict).toBe('KEEP_E0');
    expect(verdict.reasons.join('\n')).toMatch(/E1:.*NOT ELIGIBLE: sample smaller than the bar/);
    expect(verdict.inputs.find((i) => i.arm === 'E1')?.latencyOk).toBe(false);
  });

  it('when E0 itself fails the bar it is reported, and E0 is kept only if no eligible arm beats it by 5 points', () => {
    const keep = decideEmbedder(['E0', 'E1'], [di('E0', 0.4, 0.8, false), di('E1', 0.42, 0.8)]);
    expect(keep.verdict).toBe('KEEP_E0');
    expect(keep.reasons.join('\n')).toMatch(/E0 itself fails the latency bar/);
    const choose = decideEmbedder(['E0', 'E1'], [di('E0', 0.4, 0.8, false), di('E1', 0.5, 0.8)]);
    expect(choose.chosen).toBe('E1');
    expect(choose.reasons.join('\n')).toMatch(/E0 itself fails the latency bar/);
  });

  it('a missing latency block makes the memory report treat the arm as ineligible', async () => {
    const set = generateMemorySet();
    const run = await runMemoryArm(await embedderOf('E0'), set);
    const report = buildMemoryReport(set, memoryDigest(set), { E0: run }, { digest: null, planned: ['E0'], dropped: [] }, true);
    expect(report.verdict?.reasons.join('\n')).toMatch(/latency block not run/);
  });

  it('cached query first, then fresh passages in another dimension: the stale cached query is re-embedded, never compared', async () => {
    const fake = fakeOllama();
    const pin = await pinOf('E0');
    const bundle = bundleOf(buildCase('mail', 6_000, 50, 'ko', 0));
    const cache = new EmbeddingCache();
    cache.set(EmbeddingCache.key(pin.spaceId, `search_query: ${bundle.item.question}`), new Float32Array(3).fill(1));
    const embedder = await embedderOf('E0', fake, cache);
    const run = await runArmOnSet(embedder, { set: 'v1', bundles: [bundle], scope: 'phase1' });
    expect(run.embedder.overall.n).toBe(1);
    expect(embedder.cacheRejected).toBeGreaterThanOrEqual(1);
    expect(fake.embedCalls().some((body) => body.input[0]?.startsWith('search_query: '))).toBe(true);
  });

  it('a cache that disagrees with the daemon after a cached vector was served fails loudly instead of mixing sizes', async () => {
    const fake = fakeOllama();
    const pin = await pinOf('E0');
    const cache = new EmbeddingCache();
    cache.set(EmbeddingCache.key(pin.spaceId, 'search_query: only cached'), new Float32Array(3).fill(1));
    const embedder = await embedderOf('E0', fake, cache);
    await embedder.embed('query', [{ text: 'only cached', language: 'en' }]);
    await expect(embedder.embed('document', [{ text: 'fresh', language: 'en' }])).rejects.toThrow(/remove the cache file/);
  });

  it('a block with zero passages or fewer than 200 cannot meet the bar', async () => {
    const embedder = await embedderOf('E2');
    const zero = await measureLatency(embedder, { text: 'q', language: 'en' }, [], false);
    expect(zero.meetsBar).toBe(false);
    expect(zero.reason).toBe('sample smaller than the bar (0 of 200 passages)');
    const small = await measureLatency(embedder, { text: 'q', language: 'en' }, bigSample.slice(0, 199), false);
    expect(small).toMatchObject({ meetsBar: false });
    expect(small.reason).toMatch(/^sample smaller than the bar/);
  });

  it('pins the parameter count from /api/show and the on-disk size from /api/tags (metadata only), in the plan digest', async () => {
    const fake = fakeOllama({ parameterSizes: { 'nomic-embed-text:latest': '137M', 'bge-m3:latest': '566.70M', 'qwen3-embedding:0.6b': '0.6B' }, sizes: { 'nomic-embed-text:latest': 274_000_000 } });
    const e0 = await pinOf('E0', fake);
    expect(e0).toMatchObject({ parameterSize: '137M', paramsM: 137, sizeBytes: 274_000_000 });
    expect((await pinOf('E2', fake)).paramsM).toBe(566.7);
    expect((await pinOf('E3', fake)).paramsM).toBe(600);
    expect((await pinOf('E1', fake)).paramsM).toBeNull();
    expect(fake.embedBodies).toEqual([]);
    expect(fake.urls.filter((url) => url.endsWith('/api/embed'))).toEqual([]);
    const digestWith = async (f: ReturnType<typeof fakeOllama>): Promise<string> =>
      planDigest({ sets: { v1: { digest: 'a' }, v2: { digest: 'b' }, memory: { digest: 'c' } }, resolved: await resolveArms(['E0'], undefined, f.fetchImpl), scope: 'phase1' });
    expect(await digestWith(fake)).not.toBe(await digestWith(fakeOllama({ parameterSizes: { 'nomic-embed-text:latest': '138M' }, sizes: { 'nomic-embed-text:latest': 274_000_000 } })));
    expect(await digestWith(fake)).not.toBe(await digestWith(fakeOllama({ parameterSizes: { 'nomic-embed-text:latest': '137M' }, sizes: { 'nomic-embed-text:latest': 275_000_000 } })));
  });

  it('the tie-break uses the pinned parameter count, then the on-disk size when a count is missing, then the arm order', () => {
    const tie = (e1: Partial<ArmDecisionInput>, e2: Partial<ArmDecisionInput>): ArmId | null =>
      decideEmbedder(['E0', 'E1', 'E2'], [di('E0', 0.4, 0.8), di('E1', 0.7, 0.8, true, e1), di('E2', 0.7, 0.8, true, e2)]).chosen;
    expect(tie({ paramsM: 900 }, { paramsM: 100 })).toBe('E2');
    expect(tie({ paramsM: null, sizeBytes: 5 }, { paramsM: null, sizeBytes: 9 })).toBe('E1');
    expect(tie({ paramsM: null, sizeBytes: 9 }, { paramsM: 100, sizeBytes: 5 })).toBe('E2');
    expect(tie({ paramsM: null, sizeBytes: null }, { paramsM: null, sizeBytes: null })).toBe('E1');
  });
});
