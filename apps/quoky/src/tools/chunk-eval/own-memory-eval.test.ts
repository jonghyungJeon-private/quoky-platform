/** ADR-0124 phase 2 P2-5 (B): the CH9 evaluation through the real runtime classes with a fake embedder (offline, no model), plus plan and wiring pins. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capability, chunking, detectOwnMemoryRecallQuestion, formatEmbeddingEnvelope, type AiProvider, type RetrievedMemory } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from '../chunk-eval-cli';
import { loadMemorySetOwn, memoryDigestOwn } from './memory-set-own';
import {
  CONTEXT_BUILDER_CONSTANTS,
  IMPLEMENTATION_FILES_OWN,
  OWN_PLAN_VERSION,
  STAGE_R_OWN_PARAMETERS,
  buildStageROwnPlan,
  durableRecallEntriesOf,
  implementationHashesOwn,
  ownModelCallsUpperBound,
  planLinesOwn,
  productionHit,
  ruleQuestionOf,
  runOwnArmFresh,
  stageROwnDigest,
  summaryLinesStageROwn,
  buildStageROwnReport,
  type StageROwnInputs,
} from './own-memory-eval';
import { SAFETY_MARGIN, TAU_GRID } from './own-memory-rules';
import { runsOf, type RuntimeEmbeddingProvider, type StageRPin } from './stage-r';

const scratch = mkdtempSync(join(tmpdir(), 'own-memory-eval-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const root = join(__dirname, '../../../../..');
const set = loadMemorySetOwn();

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
const provider = (): RuntimeEmbeddingProvider =>
  ({
    id: 'fake-embed',
    capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }],
    executionLocality: 'LOCAL',
    isAvailable: async () => true,
    execute: async (request: { prompt: string }) => ({ text: formatEmbeddingEnvelope(embedText(request.prompt), 'fake-embed'), raw: {}, audit: { model: 'fake-embed' } }) as never,
  }) as unknown as AiProvider as RuntimeEmbeddingProvider;

describe('CH9 evaluation through the real runtime classes', () => {
  it('runs end to end: F0 equals the real hasOwnMemoryRecallHit on every question, the families and the verdict are produced', async () => {
    const run = await runOwnArmFresh({ set, provider: provider(), tmpRoot: scratch });
    expect(run.invalid).toBeNull();
    expect(run.fidelity).toEqual({ questions: 140, mismatches: 0 });
    expect(run.prewarm?.missing).toBe(0);
    expect(run.rows).toHaveLength(140);
    expect(run.rules?.questions).toBe(140);
    expect(run.rules?.f0.validate?.negatives.n).toBe(35);
    expect(run.rules?.f0.calibrate?.negatives.n).toBe(35);
    expect(run.rules?.f0.validate?.paraphrase.n).toBe(25);
    expect(run.rules?.f0.params).toBeNull();
    expect(['F0', 'F1', 'F2']).toContain(run.rules?.verdict.choice);
    expect(run.rules?.grid).toHaveLength(TAU_GRID.length);
    // a shared question hits through the topic-word path whenever the gold is among the recalled entries (the fake embedder recalls it for most)
    const shared = run.rows.filter((r) => r.category === 'positive-shared');
    expect(shared.filter((r) => r.production).length).toBeGreaterThan(shared.length / 2);
    // no negative shares a topic word with any memory: production false hits can only come from a semantic score >= 0.9
    expect(run.rules?.f0.validate?.negatives.byTopicWord).toBe(0);
    expect(run.rules?.f0.calibrate?.negatives.byTopicWord).toBe(0);
    const lines = summaryLinesStageROwn(buildStageROwnReport('d'.repeat(64), { version: OWN_PLAN_VERSION, digest: 'e'.repeat(64), pins: [], planned: ['E4'], dropped: [] }, [run])).join('\n');
    expect(lines).toContain('verdict (pre-declared, advisory)');
    expect(lines).toContain('safety bar: zero false hits on the VALIDATE negatives');
  }, 120_000);
});

describe('recalled entries are built like context-builder.ts', () => {
  const retrieved = (id: string, content: string, o: Partial<RetrievedMemory> & { createdAt?: string; updatedAt?: string } = {}): RetrievedMemory =>
    ({
      memory: { id, content, createdAt: o.createdAt ?? '2026-10-01T00:00:00.000Z', updatedAt: o.updatedAt ?? '2026-10-01T00:00:00.000Z' },
      relevanceScore: o.relevanceScore ?? 0.5,
      retrievalReason: 'x',
      ...(o.retrievalMode === undefined ? {} : { retrievalMode: o.retrievalMode }),
      ...(o.semanticScore === undefined ? {} : { semanticScore: o.semanticScore }),
    }) as unknown as RetrievedMemory;

  it('truncates at MAX_MEMORY_CHARS with an ellipsis, drops duplicate ids and contents, caps at 10, orders by createdAt then id', () => {
    const long = 'a'.repeat(450);
    const entries = durableRecallEntriesOf([
      retrieved('b', long, { createdAt: '2026-10-02T00:00:00.000Z', relevanceScore: 0.9, retrievalMode: 'semantic', semanticScore: 0.7 }),
      retrieved('a', 'short', { createdAt: '2026-10-02T00:00:00.000Z', relevanceScore: 0.8 }),
      retrieved('c', 'short', { createdAt: '2026-09-01T00:00:00.000Z', relevanceScore: 0.7 }),
      retrieved('d', 'other', { createdAt: '2026-09-01T00:00:00.000Z', relevanceScore: 0.6 }),
    ]);
    expect(entries.map((entry) => entry.memoryId)).toEqual(['d', 'a', 'b']);
    expect(entries.find((entry) => entry.memoryId === 'b')?.content).toBe(`${'a'.repeat(CONTEXT_BUILDER_CONSTANTS.maxMemoryChars)}…`);
    expect(entries.find((entry) => entry.memoryId === 'b')).toMatchObject({ retrievalMode: 'semantic', semanticScore: 0.7 });
    expect(entries.find((entry) => entry.memoryId === 'a')).not.toHaveProperty('retrievalMode');
    const many = durableRecallEntriesOf(Array.from({ length: 15 }, (_, at) => retrieved(`m${String(at).padStart(2, '0')}`, `text ${at}`, { relevanceScore: 1 - at / 100 })));
    expect(many).toHaveLength(CONTEXT_BUILDER_CONSTANTS.durableRecallLimit);
    // the ten kept are the ten best by relevance
    expect(many.map((entry) => entry.memoryId)).toEqual(Array.from({ length: 10 }, (_, at) => `m${String(at).padStart(2, '0')}`));
  });

  it('literals match the production source', () => {
    const builder = readFileSync(join(root, 'packages/core/src/application/context-builder.ts'), 'utf8');
    expect(builder).toContain(`const MAX_MEMORY_CHARS = ${CONTEXT_BUILDER_CONSTANTS.maxMemoryChars};`);
    expect(builder).toContain(`const DURABLE_RECALL_LIMIT = ${CONTEXT_BUILDER_CONSTANTS.durableRecallLimit};`);
    expect(builder).toContain('return text.length > max ? `${text.slice(0, max)}…` : text;');
  });

  it('the production hit decision runs the real policy; ruleQuestionOf is null for a non-question', () => {
    const q = detectOwnMemoryRecallQuestion('내가 좋아하는 과일이 뭐였지?') as NonNullable<ReturnType<typeof detectOwnMemoryRecallQuestion>>;
    expect(productionHit(q, [{ memoryId: 'a', content: '내가 제일 좋아하는 과일은 사과야' }])).toBe(true);
    expect(productionHit(q, [{ memoryId: 'a', content: '하늘이 푸르다', retrievalMode: 'semantic', semanticScore: 0.89 }])).toBe(false);
    expect(productionHit(q, [{ memoryId: 'a', content: '하늘이 푸르다', retrievalMode: 'semantic', semanticScore: 0.9 }])).toBe(true);
    expect(ruleQuestionOf({ id: 'x', language: 'ko', text: '오늘 날씨 어때?', category: 'negative', gold: [], half: 'validate' }, [])).toBeNull();
  });
});

const pin: StageRPin = { arm: 'E4', model: 'embeddinggemma:300m', digest12: '0'.repeat(12), ollamaVersion: '0.0.0', runtimeQueryPrefix: 'q: ', runtimeDocumentPrefix: 'd: ' };
const inputs = (digest = memoryDigestOwn(set)): StageROwnInputs => ({ set: { digest, memories: set.memories.length, queries: set.queries.length }, planned: ['E4'], pins: [pin], dropped: [], modes: ['backfilled'] });

describe('CH9 plan', () => {
  it('the digest is deterministic and covers the set, the pin, the rules, the margin and the implementation', () => {
    const base = stageROwnDigest(inputs());
    expect(stageROwnDigest(inputs())).toBe(base);
    expect(stageROwnDigest(inputs('f'.repeat(64)))).not.toBe(base);
    expect(stageROwnDigest({ ...inputs(), pins: [{ ...pin, digest12: '1'.repeat(12) }] })).not.toBe(base);
    expect(stageROwnDigest(inputs(), { ...STAGE_R_OWN_PARAMETERS, grid: { ...STAGE_R_OWN_PARAMETERS.grid, safetyMargin: 0.04 } })).not.toBe(base);
    expect(stageROwnDigest(inputs(), STAGE_R_OWN_PARAMETERS, { ...implementationHashesOwn(), 'apps/quoky/src/tools/chunk-eval/own-memory-rules.ts': '0'.repeat(64) })).not.toBe(base);
    expect(STAGE_R_OWN_PARAMETERS.grid.safetyMargin).toBe(SAFETY_MARGIN);
  });

  it('hashes the new files and the production policy files', () => {
    for (const file of ['apps/quoky/src/tools/chunk-eval/memory-set-own.ts', 'apps/quoky/src/tools/chunk-eval/own-memory-rules.ts', 'apps/quoky/src/tools/chunk-eval/own-memory-eval.ts', 'apps/quoky/src/tools/chunk-eval/lexical-variant.ts', 'packages/core/src/application/chat-policy/own-memory-recall.ts', 'packages/core/src/application/chunking/lexical.ts']) {
      expect(IMPLEMENTATION_FILES_OWN as readonly string[]).toContain(file);
      expect(implementationHashesOwn()[file]).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('the model-call upper bound equals stage R backfilled formula; the plan carries E4/backfilled only', () => {
    const bound = ownModelCallsUpperBound(set);
    const stage = runsOf(['E4'], [], set as never, ['backfilled'])[0];
    expect(stage?.modelCallsUpperBound).toBe(bound);
    const plan = buildStageROwnPlan(inputs(), set);
    expect(plan.runs).toEqual([{ arm: 'E4', mode: 'backfilled', queries: 140, modelCallsUpperBound: bound }]);
    expect(plan.modes).toEqual(['backfilled']);
    const lines = planLinesOwn(plan).join('\n');
    expect(lines).toContain(`plan digest: ${plan.digest}`);
    expect(lines).toContain('zero false hits on the validate negatives');
    expect(lines).toContain('+0.03');
  });
});

describe('CH9 CLI wiring', () => {
  const record = JSON.parse(readFileSync(join(__dirname, 'chunk-eval-memory-own.freeze.v1.json'), 'utf8')) as { version: string; seed: string; cases: number; sha256: string };
  const deps = (): { deps: CliDeps; err: string[] } => {
    const err: string[] = [];
    return { err, deps: { stdout: () => undefined, stderr: (line) => err.push(line), now: () => new Date('2026-11-09T00:00:00.000Z'), corpus: () => [], readFreeze: () => undefined, writeFreeze: () => undefined, writeReport: () => '/mem/x', memoryOwn: { corpus: () => set, readFreeze: () => record, writeFreeze: () => undefined } } };
  };

  it('--set memory-own takes --arms E4 and --modes backfilled only, and needs --stage R for arms', async () => {
    const a = deps();
    expect(await runCli(['--set', 'memory-own', '--stage', 'R', '--arms', 'L,E4', '--mode', 'plan'], a.deps)).toBe(EXIT_USAGE);
    expect(a.err.join('\n')).toContain('--arms E4 only');
    expect(await runCli(['--set', 'memory-own', '--stage', 'R', '--arms', 'E4', '--modes', 'live', '--mode', 'plan'], deps().deps)).toBe(EXIT_USAGE);
    expect(await runCli(['--set', 'memory-own', '--arms', 'E4', '--mode', 'plan'], deps().deps)).toBe(EXIT_USAGE);
    expect(await runCli(['--set', 'memory-own', '--mode', 'run'], deps().deps)).toBe(EXIT_USAGE);
  });

  it('a run without --plan-digest is BLOCKED before any model call', async () => {
    const pinned = deps();
    pinned.deps = {
      ...pinned.deps,
      embed: {
        baseUrl: 'http://127.0.0.1:11434',
        fetch: (async (url: string) => {
          if (String(url).endsWith('/api/version')) return { ok: true, status: 200, json: async () => ({ version: '0.0.0' }) };
          return { ok: true, status: 200, json: async () => ({ models: [{ name: 'embeddinggemma:300m', model: 'embeddinggemma:300m', digest: 'a'.repeat(64), size: 1 }] }) };
        }) as never,
      },
    } as CliDeps;
    expect(await runCli(['--set', 'memory-own', '--stage', 'R', '--arms', 'E4', '--modes', 'backfilled', '--mode', 'run'], pinned.deps)).toBe(EXIT_BLOCKED);
    expect(pinned.err.join('\n')).toContain('nothing was called');
    expect(EXIT_OK).toBe(0);
  });
});
