import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baselineWindow, lexicalWindow, relevantPassages, windowHasNeedle } from './arms';
import { ADR_FILE_BYTES, buildCase, corpusDigest, CORPUS_SEED, CORPUS_VERSION, DEPTHS, generateCorpus, LANGUAGES, LENGTHS, lengthsOf, SHAPES, type ChunkEvalCase } from './corpus';
import { firstRelevantRank, mean, ndcgAtK, recallAtK, reciprocalRank } from './metrics';
import { runChunkEval } from './chunk-eval';
import { EXIT_BLOCKED, EXIT_INVALID, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, FREEZE_PATH, parseArguments, runCli, type CliDeps, type FreezeRecord } from '../chunk-eval-cli';
import { buildUntrustedDocumentReadout, chunking } from '@quoky/core';

const corpus = generateCorpus();

describe('CH1 corpus', () => {
  it('has the ADR matrix: 7 shapes x 4 lengths x 5 depths x 3 languages, plus the 2 MiB ADR-file tier, at least 300 cases', () => {
    expect(corpus.length).toBe(SHAPES.length * LENGTHS.length * DEPTHS.length * LANGUAGES.length + DEPTHS.length * LANGUAGES.length);
    expect(SHAPES.map((shape) => lengthsOf(shape).length)).toEqual([4, 4, 4, 4, 4, 4, 5]);
    expect(corpus.length).toBeGreaterThanOrEqual(300);
    expect(new Set(corpus.map((item) => item.id)).size).toBe(corpus.length);
  });

  it('is deterministic: the same cases and the same digest on every generation', () => {
    const again = generateCorpus();
    expect(corpusDigest(again)).toBe(corpusDigest(corpus));
    expect(again[17]?.prepared).toBe(corpus[17]?.prepared);
    expect(buildCase('mail', 20_000, 50, 'ko', 3)).toEqual(buildCase('mail', 20_000, 50, 'ko', 3));
  });

  it('matches the recorded freeze, and any one-character change moves the digest', () => {
    const record = JSON.parse(readFileSync(FREEZE_PATH, 'utf8')) as FreezeRecord;
    expect(record.version).toBe(CORPUS_VERSION);
    expect(record.seed).toBe(CORPUS_SEED);
    expect(record.cases).toBe(corpus.length);
    expect(corpusDigest(corpus)).toBe(record.sha256);
    const changed = corpus.map((item, at) => (at === 5 ? { ...item, question: `${item.question}?` } : item));
    expect(corpusDigest(changed)).not.toBe(record.sha256);
  });

  it('places the needle once, at the requested depth, measured on the serialized text', () => {
    // The needle goes in at the unit boundary (a paragraph, a table row, a short Slack line) nearest the requested depth, so
    // the error is at most half a unit: units are 40-250 code points, i.e. up to ~2.1% of the 6k tier. The measured maximum
    // is 1.5 points; the tolerance is 2 points of depth (0.02) for every case, and the longer tiers sit far inside it.
    const TOLERANCE = 0.02;
    for (const item of corpus) {
      const points = Array.from(item.prepared);
      expect(points.slice(item.needle.start, item.needle.end).join('')).toBe(item.needle.text);
      expect(item.prepared.split(item.needle.text).length - 1).toBe(1);
      const fraction = item.needle.start / points.length;
      expect(Math.abs(fraction - item.depth / 100), item.id).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('table rows count one code point for their separator (the 6k mixed workbook at 70% is not at 77%)', () => {
    const item = corpus.find((candidate) => candidate.id === 'ch1-workbook-6k-d70-mixed') as ChunkEvalCase;
    expect(Math.abs(item.needle.start / Array.from(item.prepared).length - 0.7)).toBeLessThanOrEqual(0.02);
  });

  it('has a 2 MiB ADR file (UTF-8 bytes) at every depth and language', () => {
    const big = corpus.filter((item) => item.length === ADR_FILE_BYTES);
    expect(big.length).toBe(DEPTHS.length * LANGUAGES.length);
    expect(new Set(big.map((item) => item.shape))).toEqual(new Set(['adr-file']));
    for (const item of big) {
      const bytes = Buffer.byteLength(item.prepared, 'utf8');
      expect(bytes, item.id).toBeGreaterThanOrEqual(ADR_FILE_BYTES);
      expect(bytes, item.id).toBeLessThan(ADR_FILE_BYTES * 1.02);
    }
  });

  it('hashes every field of a case, including the prepared text and the sections the EL arm reads', () => {
    const record = corpusDigest(corpus);
    const at = corpus.findIndex((item) => item.sections.length > 1);
    const mutate = (change: (item: ChunkEvalCase) => ChunkEvalCase): string => corpusDigest(corpus.map((item, i) => (i === at ? change(item) : item)));
    expect(mutate((item) => ({ ...item, prepared: `${item.prepared} ` }))).not.toBe(record);
    expect(mutate((item) => ({ ...item, sections: item.sections.map((section, i) => (i === 0 ? { ...section, end: section.end + 1 } : section)) }))).not.toBe(record);
    expect(mutate((item) => ({ ...item, sections: item.sections.slice(0, -1) }))).not.toBe(record);
    // every key of a case moves the digest
    for (const key of Object.keys(corpus[at] as ChunkEvalCase) as (keyof ChunkEvalCase)[]) {
      const moved = mutate((item) => {
        const value = item[key];
        const next = typeof value === 'string' ? `${value}x` : typeof value === 'number' ? value + 1 : Array.isArray(value) ? [...value, value[0]] : { ...(value as object), text: 'x' };
        return { ...item, [key]: next } as ChunkEvalCase;
      });
      expect(moved, key).not.toBe(record);
    }
  });

  it('keeps the needle out of the question and uses only fictional text', () => {
    for (const item of corpus) {
      expect(item.question).not.toContain(item.needle.text);
      expect(item.prepared).not.toMatch(/https?:|@[a-z]+\.|\bsk-|AKIA|password|secret|token/iu);
    }
  });

  it('offsets are in code points even when the text holds astral characters', () => {
    const base = buildCase('mail', 6_000, 50, 'en', 0);
    const shifted = `😀😀${base.prepared}`;
    const points = Array.from(shifted);
    expect(points.slice(base.needle.start + 2, base.needle.end + 2).join('')).toBe(base.needle.text);
    expect(shifted.indexOf(base.needle.text)).toBe(base.prepared.indexOf(base.needle.text) + 4);
  });
});

describe('metrics (hand-checked)', () => {
  it('computes rank, recall@k and reciprocal rank', () => {
    expect(firstRelevantRank([3, 1, 2, 0], new Set([1]))).toBe(2);
    expect(firstRelevantRank([3, 1], new Set([9]))).toBeNull();
    expect(recallAtK(2, 1)).toBe(0);
    expect(recallAtK(2, 3)).toBe(1);
    expect(recallAtK(null, 10)).toBe(0);
    expect(reciprocalRank(2)).toBe(0.5);
    expect(reciprocalRank(null)).toBe(0);
    expect(mean([1, 0, 0.5])).toBe(0.5);
  });

  it('computes binary nDCG@10', () => {
    // relevant at rank 2: DCG = 1/log2(3); ideal = 1.
    expect(ndcgAtK([3, 1, 2, 0], new Set([1]), 10)).toBeCloseTo(1 / Math.log2(3), 10);
    // relevant at ranks 2 and 3: DCG = 1/log2(3) + 1/log2(4); ideal = 1 + 1/log2(3).
    expect(ndcgAtK([3, 1, 2, 0], new Set([1, 2]), 10)).toBeCloseTo((1 / Math.log2(3) + 0.5) / (1 + 1 / Math.log2(3)), 10);
    expect(ndcgAtK([1, 2], new Set([1, 2]), 10)).toBeCloseTo(1, 10);
    expect(ndcgAtK([5, 6], new Set([1]), 10)).toBe(0);
    // a hit beyond k does not count
    expect(ndcgAtK([0, 1, 2, 3], new Set([3]), 3)).toBe(0);
  });
});

describe('arms', () => {
  const pickCase = (id: string): ChunkEvalCase => corpus.find((item) => item.id === id) as ChunkEvalCase;

  it('baseline is today\'s production read path, not a copy', () => {
    const item = pickCase('ch1-mail-60k-d50-en');
    const direct = buildUntrustedDocumentReadout({ source: 'mail', title: `mail ${item.id}`, author: 'synthetic', date: '2027-01-01T00:00:00Z', body: item.prepared });
    expect(direct.ok).toBe(true);
    const window = baselineWindow(item);
    expect(window.sent).toBe(true);
    expect(window.text).toBe(direct.ok ? direct.readout.body : '');
    expect(Array.from(window.text).length).toBeLessThanOrEqual(3_000);
  });

  it('baseline keeps the head and the tail and loses a needle in the middle of a long item', () => {
    expect(windowHasNeedle(baselineWindow(pickCase('ch1-mail-60k-d50-en')), pickCase('ch1-mail-60k-d50-en'))).toBe(false);
    expect(windowHasNeedle(baselineWindow(pickCase('ch1-mail-6k-d10-en')), pickCase('ch1-mail-6k-d10-en'))).toBe(true);
    const long = pickCase('ch1-drive-doc-87k-d90-en');
    const window = baselineWindow(long);
    expect(window.text.startsWith(long.prepared.slice(0, 40))).toBe(true);
    expect(window.text.endsWith(long.prepared.slice(-40).trimEnd())).toBe(true);
  });

  it('baseline refuses nothing of the corpus', () => {
    for (const item of corpus.filter((_, at) => at % 7 === 0)) expect(baselineWindow(item).refused).toBe(false);
  });

  it('lexical arm sends one window within the bound, and it ranks the needle passage first for an English question', () => {
    const item = pickCase('ch1-drive-doc-60k-d50-en');
    const outcome = lexicalWindow(item);
    expect(outcome.window.sent).toBe(true);
    expect(Array.from(outcome.window.text).length).toBeLessThanOrEqual(3_000);
    expect(windowHasNeedle(outcome.window, item)).toBe(true);
    expect(outcome.relevant.size).toBeGreaterThan(0);
    expect(outcome.ranking[0]).toBeDefined();
    expect(outcome.relevant.has(outcome.ranking[0] as number)).toBe(true);
  });

  it('relevant passages are those overlapping the needle range', () => {
    const item = pickCase('ch1-mail-20k-d30-en');
    const passages = chunking.chunk(item.prepared, item.sections);
    const relevant = relevantPassages(passages, item.needle.start, item.needle.end);
    expect(relevant.size).toBeGreaterThanOrEqual(1);
    for (const ordinal of relevant) {
      const span = passages[ordinal]?.span as { start: number; end: number };
      expect(span.start < item.needle.end && span.end > item.needle.start).toBe(true);
    }
  });
});

describe('run on a small slice', () => {
  const slice = corpus.filter((item) => item.length === 6_000 && item.language === 'en');
  const report = runChunkEval(slice, corpusDigest(slice));

  it('reports numbers, stratified, and never a ratified verdict', () => {
    expect(report.status).toBe('NON-GATING');
    expect(report.gate.ratified).toBe(false);
    expect(report.gate.verdict).toBe('NOT_RUN');
    expect(report.notRun).toEqual(['E0', 'E1', 'E2', 'E3', 'EH']);
    expect(report.arms.baseline.cases).toBe(slice.length);
    expect(Object.keys(report.arms.EL.byDepth)).toEqual(['10', '30', '50', '70', '90']);
    expect(report.arms.EL.retrieval.recallAt10).toBeGreaterThanOrEqual(report.arms.EL.retrieval.recallAt1);
    expect(JSON.stringify(report)).not.toContain(slice[0]?.needle.text ?? '\u0000');
  });
});

describe('cli', () => {
  const small = corpus.filter((item) => item.length === 6_000 && item.language === 'en' && item.depth === 50);
  const make = (overrides: Partial<CliDeps> = {}, freeze?: FreezeRecord) => {
    const out: string[] = [];
    const err: string[] = [];
    const written: { dir?: string; name?: string; report?: unknown } = {};
    let record = freeze;
    const deps: CliDeps = {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date('2026-11-03T00:00:00Z'),
      corpus: () => small,
      readFreeze: () => record,
      writeFreeze: (next) => {
        record = next;
      },
      writeReport: (dir, name, report) => {
        Object.assign(written, { dir, name, report });
        return `${dir}/${name}`;
      },
      ...overrides,
    };
    return { deps, out, err, written, record: () => record };
  };
  const frozen = (): FreezeRecord => ({ version: CORPUS_VERSION, seed: CORPUS_SEED, cases: small.length, sha256: corpusDigest(small) });

  it('parses arguments and exits 2 on misuse, 0 on help', async () => {
    expect(parseArguments(['--', '--mode', 'run']).mode).toBe('run');
    expect(await runCli(['--mode', 'nope'], make().deps)).toBe(EXIT_USAGE);
    expect(await runCli(['--bogus', 'x'], make().deps)).toBe(EXIT_USAGE);
    expect(await runCli(['--mode'], make().deps)).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'verify', '--out', 'x'], make().deps)).toBe(EXIT_USAGE);
    expect(await runCli(['--help'], make().deps)).toBe(EXIT_OK);
  });

  it('exits 3 when there is no record or the corpus differs from it, and runs nothing', async () => {
    const none = make();
    expect(await runCli(['--mode', 'run'], none.deps)).toBe(EXIT_BLOCKED);
    expect(none.written.report).toBeUndefined();
    const stale = make({}, { ...frozen(), sha256: 'a'.repeat(64) });
    expect(await runCli(['--mode', 'run'], stale.deps)).toBe(EXIT_BLOCKED);
    expect(await runCli(['--mode', 'verify'], stale.deps)).toBe(EXIT_BLOCKED);
    expect(stale.written.report).toBeUndefined();
  });

  it('regenerates the record only through its own command', async () => {
    const fresh = make();
    expect(await runCli(['--mode', 'regenerate-freeze'], fresh.deps)).toBe(EXIT_OK);
    expect(fresh.record()?.sha256).toBe(corpusDigest(small));
    expect(await runCli(['--mode', 'verify'], fresh.deps)).toBe(EXIT_OK);
  });

  it('exits 4 NON-GATING after a completed run and writes a content-free report', async () => {
    const run = make({}, frozen());
    expect(await runCli(['--mode', 'run', '--out', '/tmp/chunk-eval-test'], run.deps)).toBe(EXIT_NON_GATING);
    expect(run.written.name).toMatch(/^chunk-eval-[0-9a-f]{12}-2026-11-03T00-00-00-000Z\.json$/);
    expect(run.out.join('\n')).toContain('NON-GATING');
    expect(run.out.join('\n')).not.toMatch(/PASSED/);
  });

  it('exits 3 on verify and run when only the prepared text or the sections differ from the freeze', async () => {
    const threaded = corpus.filter((item) => item.shape === 'thread' && item.length === 6_000 && item.language === 'en' && item.depth === 50);
    const record: FreezeRecord = { version: CORPUS_VERSION, seed: CORPUS_SEED, cases: threaded.length, sha256: corpusDigest(threaded) };
    const prepared = threaded.map((item) => ({ ...item, prepared: `${item.prepared}\n` }));
    const sections = threaded.map((item) => ({ ...item, sections: item.sections.map((section) => ({ ...section, end: section.end + 1 })) }));
    for (const changed of [prepared, sections]) {
      const run = make({ corpus: () => changed }, record);
      expect(await runCli(['--mode', 'verify'], run.deps)).toBe(EXIT_BLOCKED);
      expect(await runCli(['--mode', 'run'], run.deps)).toBe(EXIT_BLOCKED);
      expect(run.written.report).toBeUndefined();
    }
    const same = make({ corpus: () => threaded }, record);
    expect(await runCli(['--mode', 'verify'], same.deps)).toBe(EXIT_OK);
  });

  it('exits 5 INVALID when a needle is missing from its item', async () => {
    const broken = small.map((item, at) => (at === 0 ? { ...item, needle: { ...item.needle, text: 'absent needle text' } } : item));
    const run = make({ corpus: () => broken }, { ...frozen(), sha256: corpusDigest(broken) });
    expect(await runCli(['--mode', 'run', '--out', '/tmp/chunk-eval-test'], run.deps)).toBe(EXIT_INVALID);
  });
});
