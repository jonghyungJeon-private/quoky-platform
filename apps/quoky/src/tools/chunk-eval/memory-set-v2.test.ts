/**
 * ADR-0124 phase 2 P2-3: invariants of the hand-written CH8 validation set (offline, no model).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { containsCredentialMaterial } from '@quoky/core';
import { describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, EXIT_OK, runCli, type CliDeps } from '../chunk-eval-cli';
import { CH8_CATEGORIES, MEMORY_V2_RETRIEVAL_TIME, MEMORY_V2_SEED, MEMORY_V2_VERSION, loadMemorySetV2, memoryDigestV2 } from './memory-set-v2';
import { sharedContentTerms } from './memory-set';
import { RETRIEVAL_TIME } from './stage-r';

const set = loadMemorySetV2();
const memoryById = new Map(set.memories.map((memory) => [memory.id, memory]));
const count = (values: readonly string[]): Record<string, number> => values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});

describe('CH8 set invariants', () => {
  it('counts per language and per category are within the authored ranges', () => {
    expect(set.memories.length).toBe(120);
    const memLang = count(set.memories.map((m) => m.language));
    expect(memLang.ko).toBeGreaterThanOrEqual(66);
    expect(memLang.ko).toBeLessThanOrEqual(78);
    expect(memLang.en).toBeGreaterThanOrEqual(20);
    expect(memLang.en).toBeLessThanOrEqual(28);
    expect(memLang.mixed).toBeGreaterThanOrEqual(20);
    expect(memLang.mixed).toBeLessThanOrEqual(28);
    expect(set.queries.length).toBe(150);
    const lang = count(set.queries.map((q) => q.language));
    expect(lang).toEqual({ ko: 80, en: 35, mixed: 35 });
    const cat = count(set.queries.map((q) => q.category));
    expect(Object.keys(cat).sort()).toEqual([...CH8_CATEGORIES].sort());
    expect(cat.paraphrase / 150).toBeGreaterThanOrEqual(0.35);
    expect(cat.paraphrase / 150).toBeLessThanOrEqual(0.45);
    expect(cat.shared / 150).toBeGreaterThanOrEqual(0.2);
    expect(cat.shared / 150).toBeLessThanOrEqual(0.3);
    expect(cat['recency-wins']).toBeGreaterThanOrEqual(20);
    expect(cat['old-relevant']).toBeGreaterThanOrEqual(25);
  });

  it('ids are unique and every gold and staleId exists; daysAgo is an authored integer in 0-200', () => {
    expect(new Set(set.memories.map((m) => m.id)).size).toBe(set.memories.length);
    expect(new Set(set.queries.map((q) => q.id)).size).toBe(set.queries.length);
    for (const memory of set.memories) {
      expect(Number.isInteger(memory.daysAgo)).toBe(true);
      expect(memory.daysAgo).toBeGreaterThanOrEqual(0);
      expect(memory.daysAgo).toBeLessThanOrEqual(200);
      expect(memory.text.length).toBeLessThan(160);
    }
    for (const query of set.queries) {
      expect(query.gold).toHaveLength(1);
      expect(memoryById.has(query.gold[0] as string)).toBe(true);
      if (query.staleId !== null) expect(memoryById.has(query.staleId)).toBe(true);
      expect(query.category === 'recency-wins' ? query.staleId !== null : query.staleId === null).toBe(true);
    }
  });

  it('paraphrase queries share no content word with their gold; shared queries share at least one; sharedTerms is the measured value', () => {
    for (const query of set.queries) {
      const measured = sharedContentTerms(query.text, (memoryById.get(query.gold[0] as string) as { text: string }).text);
      expect(query.sharedTerms).toBe(measured);
      if (query.category === 'paraphrase') expect(measured, `${query.id} ${query.text}`).toBe(0);
      if (query.category === 'shared') expect(measured, `${query.id} ${query.text}`).toBeGreaterThan(0);
    }
  });

  it('recency-wins: the stale memory is 60-180 days old, the gold 1-20 days, neither is superseded, one pair per topic', () => {
    const pairs = set.queries.filter((q) => q.category === 'recency-wins');
    expect(new Set(pairs.map((q) => q.staleId)).size).toBe(pairs.length);
    for (const query of pairs) {
      const gold = memoryById.get(query.gold[0] as string) as { daysAgo: number; language: string };
      const stale = memoryById.get(query.staleId as string) as { daysAgo: number; language: string };
      expect(stale.daysAgo, query.id).toBeGreaterThanOrEqual(60);
      expect(stale.daysAgo, query.id).toBeLessThanOrEqual(180);
      expect(gold.daysAgo, query.id).toBeGreaterThanOrEqual(1);
      expect(gold.daysAgo, query.id).toBeLessThanOrEqual(20);
      expect(gold.daysAgo).toBeLessThan(stale.daysAgo);
      expect(gold.language).toBe(stale.language);
    }
    expect(JSON.stringify(set.memories)).not.toMatch(/supersed/iu);
  });

  it('old-relevant: the gold is 90-200 days old and its domain holds at least 3 memories younger than 15 days', () => {
    const olds = set.queries.filter((q) => q.category === 'old-relevant');
    for (const query of olds) {
      const gold = memoryById.get(query.gold[0] as string) as { daysAgo: number; domain: string };
      expect(gold.daysAgo, query.id).toBeGreaterThanOrEqual(90);
      expect(gold.daysAgo, query.id).toBeLessThanOrEqual(200);
      const recent = set.memories.filter((m) => m.domain === gold.domain && m.daysAgo < 15).length;
      expect(recent, `${query.id} ${gold.domain}`).toBeGreaterThanOrEqual(3);
    }
    expect(set.memories.filter((m) => m.daysAgo < 15).length).toBeGreaterThanOrEqual(3);
  });

  it('holds no token-like literal, URL, e-mail or phone-like number', () => {
    const texts = [...set.memories.map((m) => m.text), ...set.queries.map((q) => q.text)];
    for (const text of texts) {
      expect(text).not.toMatch(/[A-Za-z0-9_-]{24,}/u);
      expect(text).not.toMatch(/\b(sk|xox[a-z]|ghp|AKIA|AIza)[-_A-Za-z0-9]{6,}/u);
      expect(text).not.toMatch(/https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]{2,}/iu);
      expect(text).not.toMatch(/\d{3}[- ]\d{3,4}[- ]\d{4}|\d{8,}/u);
    }
  });

  it('no memory or query trips the production credential guard (such a memory would never be embedded)', () => {
    for (const text of [...set.memories.map((m) => m.text), ...set.queries.map((q) => q.text)]) expect(containsCredentialMaterial(text), text).toBe(false);
  });

  it('the retrieval time equals stage R, and the digest is deterministic', () => {
    expect(MEMORY_V2_RETRIEVAL_TIME).toBe(RETRIEVAL_TIME);
    expect(memoryDigestV2(loadMemorySetV2())).toBe(memoryDigestV2(set));
    const changed = { ...set, memories: set.memories.map((m, at) => (at === 0 ? { ...m, daysAgo: m.daysAgo + 1 } : m)) };
    expect(memoryDigestV2(changed)).not.toBe(memoryDigestV2(set));
  });
});

describe('CH8 freeze record', () => {
  const record = JSON.parse(readFileSync(resolve(__dirname, 'chunk-eval-memory.freeze.v2.json'), 'utf8')) as { version: string; seed: string; cases: number; sha256: string };

  it('the committed record matches the set', () => {
    expect(record).toEqual({ version: MEMORY_V2_VERSION, seed: MEMORY_V2_SEED, cases: set.memories.length + set.queries.length, sha256: memoryDigestV2(set) });
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
        memoryV2: { corpus: () => set, readFreeze: () => freeze, writeFreeze: () => undefined },
      },
    };
  };

  it('--set memory-v2 --mode verify passes with the record and is BLOCKED without or with a stale one', async () => {
    const ok = deps(record);
    expect(await runCli(['--set', 'memory-v2', '--mode', 'verify'], ok.deps)).toBe(EXIT_OK);
    expect(ok.out.join('\n')).toContain('CH8 memory set matches the record');
    expect(await runCli(['--set', 'memory-v2', '--mode', 'verify'], deps(undefined).deps)).toBe(EXIT_BLOCKED);
    expect(await runCli(['--set', 'memory-v2', '--mode', 'verify'], deps({ ...record, sha256: '0'.repeat(64) }).deps)).toBe(EXIT_BLOCKED);
  });

  it('regenerate-freeze records version, seed, case count and digest', async () => {
    const written: unknown[] = [];
    const h = deps(undefined);
    h.deps = { ...h.deps, memoryV2: { corpus: () => set, readFreeze: () => undefined, writeFreeze: (r) => written.push(r) } };
    expect(await runCli(['--set', 'memory-v2', '--mode', 'regenerate-freeze'], h.deps)).toBe(EXIT_OK);
    expect(written).toEqual([record]);
  });
});
