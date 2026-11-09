/**
 * ADR-0124 phase 2 P2-5: invariants of the hand-written CH9 own-memory set (offline, no model).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { containsCredentialMaterial, detectOwnMemoryRecallQuestion, sharesTopicWord } from '@quoky/core';
import { describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_OK, runCli, type CliDeps } from '../chunk-eval-cli';
import { MEMORY_OWN_SEED, MEMORY_OWN_VERSION, OWN_CATEGORIES, loadMemorySetOwn, memoryDigestOwn } from './memory-set-own';
import { RETRIEVAL_TIME } from './stage-r';

const set = loadMemorySetOwn();
const memoryById = new Map(set.memories.map((memory) => [memory.id, memory]));
const count = (values: readonly string[]): Record<string, number> => values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});
const question = (text: string) => detectOwnMemoryRecallQuestion(text) as NonNullable<ReturnType<typeof detectOwnMemoryRecallQuestion>>;

describe('CH9 set invariants', () => {
  it('counts: 70 memories (ko about 60 percent), 140 questions (50 paraphrase, 20 shared, 70 negative)', () => {
    expect(set.memories.length).toBe(70);
    expect(count(set.memories.map((m) => m.language))).toEqual({ ko: 42, en: 28 });
    expect(set.queries.length).toBe(140);
    expect(count(set.queries.map((q) => q.category))).toEqual({ 'positive-paraphrase': 50, 'positive-shared': 20, negative: 70 });
    expect(count(set.queries.map((q) => `${q.category}/${q.language}`))).toEqual({
      'positive-paraphrase/ko': 30,
      'positive-paraphrase/en': 20,
      'positive-shared/ko': 12,
      'positive-shared/en': 8,
      'negative/ko': 42,
      'negative/en': 28,
    });
    expect([...new Set(set.queries.map((q) => q.category))].sort()).toEqual([...OWN_CATEGORIES].sort());
  });

  it('ids are unique, daysAgo is an authored integer in 0-200, texts are short, golds exist and negatives have none', () => {
    expect(new Set(set.memories.map((m) => m.id)).size).toBe(set.memories.length);
    expect(new Set(set.queries.map((q) => q.id)).size).toBe(set.queries.length);
    expect(new Set(set.memories.map((m) => m.text)).size).toBe(set.memories.length);
    for (const memory of set.memories) {
      expect(Number.isInteger(memory.daysAgo)).toBe(true);
      expect(memory.daysAgo).toBeGreaterThanOrEqual(0);
      expect(memory.daysAgo).toBeLessThanOrEqual(200);
      expect(memory.text.length).toBeLessThan(100);
    }
    for (const query of set.queries) {
      if (query.category === 'negative') expect(query.gold, query.text).toEqual([]);
      else {
        expect(query.gold, query.text).toHaveLength(1);
        expect(memoryById.has(query.gold[0] as string), query.text).toBe(true);
        expect(memoryById.get(query.gold[0] as string)?.language, query.text).toBe(query.language);
      }
    }
  });

  it('EVERY question is an own-memory recall question for the production detector', () => {
    for (const query of set.queries) expect(detectOwnMemoryRecallQuestion(query.text), query.text).not.toBeNull();
  });

  it('the detected language equals the authored language', () => {
    for (const query of set.queries) expect(question(query.text).language, query.text).toBe(query.language);
  });

  it('positive-paraphrase questions share NO topic word with their gold (and with no other memory, so the semantic path alone is measured)', () => {
    for (const query of set.queries.filter((q) => q.category === 'positive-paraphrase')) {
      const detected = question(query.text);
      expect(sharesTopicWord(detected, (memoryById.get(query.gold[0] as string) as { text: string }).text), `gold: ${query.text}`).toBe(false);
      for (const memory of set.memories) expect(sharesTopicWord(detected, memory.text), `${query.text} / ${memory.text}`).toBe(false);
    }
  });

  it('positive-shared questions share a topic word with their gold', () => {
    for (const query of set.queries.filter((q) => q.category === 'positive-shared')) {
      expect(sharesTopicWord(question(query.text), (memoryById.get(query.gold[0] as string) as { text: string }).text), query.text).toBe(true);
    }
  });

  it('negatives share a topic word with NO memory, so production topic-word hits cannot mask the semantic false-hit count', () => {
    for (const query of set.queries.filter((q) => q.category === 'negative')) {
      const detected = question(query.text);
      for (const memory of set.memories) expect(sharesTopicWord(detected, memory.text), `${query.text} / ${memory.text}`).toBe(false);
    }
  });

  it('split: per category and language, even position = calibrate, odd = validate', () => {
    const seen = new Map<string, number>();
    for (const query of set.queries) {
      const key = `${query.category}/${query.language}`;
      const position = seen.get(key) ?? 0;
      seen.set(key, position + 1);
      expect(query.half, query.id).toBe(position % 2 === 0 ? 'calibrate' : 'validate');
    }
    const halves = count(set.queries.filter((q) => q.category === 'negative').map((q) => q.half));
    expect(halves).toEqual({ calibrate: 35, validate: 35 });
  });

  it('holds no token-like literal, URL, e-mail or phone-like number', () => {
    for (const text of [...set.memories.map((m) => m.text), ...set.queries.map((q) => q.text)]) {
      expect(text).not.toMatch(/[A-Za-z0-9_-]{24,}/u);
      expect(text).not.toMatch(/\b(sk|xox[a-z]|ghp|AKIA|AIza)[-_A-Za-z0-9]{6,}/u);
      expect(text).not.toMatch(/https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]{2,}/iu);
      expect(text).not.toMatch(/\d{3}[- ]\d{3,4}[- ]\d{4}|\d{8,}/u);
    }
  });

  it('no memory or question trips the production credential guard (such a memory would never be embedded)', () => {
    for (const text of [...set.memories.map((m) => m.text), ...set.queries.map((q) => q.text)]) expect(containsCredentialMaterial(text), text).toBe(false);
  });

  it('the digest is deterministic and changes with any byte', () => {
    expect(memoryDigestOwn(loadMemorySetOwn())).toBe(memoryDigestOwn(set));
    expect(memoryDigestOwn({ ...set, memories: set.memories.map((m, at) => (at === 0 ? { ...m, daysAgo: m.daysAgo + 1 } : m)) })).not.toBe(memoryDigestOwn(set));
    expect(memoryDigestOwn({ ...set, queries: set.queries.map((q, at) => (at === 0 ? { ...q, half: 'validate' as const } : q)) })).not.toBe(memoryDigestOwn(set));
  });

  it('daysAgo is relative to the shared retrieval time of stage R', () => {
    expect(RETRIEVAL_TIME).toBe('2026-11-06T00:00:00.000Z');
  });
});

describe('CH9 freeze record', () => {
  const record = JSON.parse(readFileSync(resolve(__dirname, 'chunk-eval-memory-own.freeze.v1.json'), 'utf8')) as { version: string; seed: string; cases: number; sha256: string };

  it('the committed record matches the set', () => {
    expect(record).toEqual({ version: MEMORY_OWN_VERSION, seed: MEMORY_OWN_SEED, cases: set.memories.length + set.queries.length, sha256: memoryDigestOwn(set) });
  });

  const deps = (freeze: typeof record | undefined): { deps: CliDeps; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        now: () => new Date('2026-11-09T00:00:00.000Z'),
        corpus: () => [],
        readFreeze: () => undefined,
        writeFreeze: () => undefined,
        writeReport: () => '/mem/x',
        memoryOwn: { corpus: () => set, readFreeze: () => freeze, writeFreeze: () => undefined },
      },
    };
  };

  it('--set memory-own --mode verify passes with the record and is BLOCKED without or with a stale one', async () => {
    const ok = deps(record);
    expect(await runCli(['--set', 'memory-own', '--mode', 'verify'], ok.deps)).toBe(EXIT_OK);
    expect(ok.out.join('\n')).toContain('CH9 memory set matches the record');
    expect(await runCli(['--set', 'memory-own', '--mode', 'verify'], deps(undefined).deps)).toBe(EXIT_BLOCKED);
    expect(await runCli(['--set', 'memory-own', '--mode', 'verify'], deps({ ...record, sha256: '0'.repeat(64) }).deps)).toBe(EXIT_BLOCKED);
  });

  it('regenerate-freeze records version, seed, case count and digest', async () => {
    const written: unknown[] = [];
    const h = deps(undefined);
    h.deps = { ...h.deps, memoryOwn: { corpus: () => set, readFreeze: () => undefined, writeFreeze: (r) => written.push(r) } };
    expect(await runCli(['--set', 'memory-own', '--mode', 'regenerate-freeze'], h.deps)).toBe(EXIT_OK);
    expect(written).toEqual([record]);
  });
});
