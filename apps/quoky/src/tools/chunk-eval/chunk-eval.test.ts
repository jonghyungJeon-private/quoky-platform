import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baselineWindow, lexicalWindow, relevantPassages, windowHasNeedle } from './arms';
import { ADR_FILE_BYTES, buildCase, corpusDigest, CORPUS_SEED, CORPUS_VERSION, DEPTHS, generateCorpus, LANGUAGES, LENGTHS, lengthsOf, SHAPES, type ChunkEvalCase } from './corpus';
import { firstRelevantRank, mean, ndcgAtK, recallAtK, reciprocalRank } from './metrics';
import { runChunkEval } from './chunk-eval';
import { DRIVE_FORMAT_VERSION, driveDocSources, driveFormatDigest, generateDriveFormatSet, renderDriveDoc, runDriveFormat, SECTION_TARGET_CODE_POINTS } from './drive-format';
import { DRIVE_FORMAT_FREEZE_PATH, EXIT_BLOCKED, EXIT_INVALID, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, FREEZE_PATH, parseArguments, runCli, type CliDeps, type FreezeRecord } from '../chunk-eval-cli';
import { CORPUS_V2_SEED, CORPUS_V2_VERSION, corpusV2Digest, generateCorpusV2, renderNeedle, sectionName, FEATURE_TAGS, type ChunkEvalCaseV2 } from './corpus-v2';
import { runChunkEvalV2 } from './chunk-eval-v2';
import { V2_FREEZE_PATH } from '../chunk-eval-cli';
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

  it('breaks window recall down by shape x depth, length, language and needle kind, for both arms', () => {
    for (const arm of [report.arms.baseline, report.arms.EL]) {
      expect(Object.keys(arm.byShapeDepth)).toEqual([...SHAPES]);
      expect(Object.keys(arm.byShapeLength['mail'] ?? {})).toEqual(['6000']);
      expect(Object.keys(arm.byShapeLanguage['mail'] ?? {})).toEqual(['en']);
      expect(Object.keys(arm.byShapeNeedleKind['workbook'] ?? {})).toEqual(['sheet-row']);
      // every cell's n adds back up to the shape's n, and the cell recalls average back to the shape's recall
      for (const shape of SHAPES) {
        const cells = Object.values(arm.byShapeDepth[shape] ?? {});
        expect(cells.reduce((sum, cell) => sum + cell.n, 0)).toBe(arm.byShape[shape]?.n);
        expect(cells.reduce((sum, cell) => sum + cell.n * cell.windowRecall, 0) / (arm.byShape[shape]?.n ?? 1)).toBeCloseTo(arm.byShape[shape]?.windowRecall ?? 0, 3);
      }
    }
  });

  it('reports per-shape chunker statistics and says the boundary level is not exposed', () => {
    expect(Object.keys(report.chunker.byShape)).toEqual([...SHAPES]);
    for (const shape of SHAPES) {
      const stats = report.chunker.byShape[shape];
      expect(stats?.cases).toBe(slice.filter((item) => item.shape === shape).length);
      expect(stats?.passagesPerCase.max).toBeGreaterThanOrEqual(stats?.passagesPerCase.mean ?? 0);
      expect(stats?.passageCodePoints.p95).toBeLessThanOrEqual(stats?.passageCodePoints.max ?? 0);
      expect(stats?.passageCodePoints.max).toBeLessThanOrEqual(1_200);
      expect(stats?.windowsPerCase.mean).toBeGreaterThanOrEqual(1);
      expect(Object.values(stats?.kinds ?? {}).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    }
    expect(Object.keys(report.chunker.byShape['workbook']?.kinds ?? {})).toEqual(['table']);
    expect(report.chunker.boundaryLevel).toMatch(/not exposed/);
  });
});

describe('Drive format variant set (ADR-0124 open question 10)', () => {
  const sources = driveDocSources();
  const set = generateDriveFormatSet();
  const HEADING = /^#{1,2} /gmu;

  it('is built from the v1 drive-doc cases: the same 60 cases, each rendered twice', () => {
    expect(sources.length).toBe(LENGTHS.length * DEPTHS.length * LANGUAGES.length);
    expect(set.length).toBe(sources.length * 2);
    const v1 = corpus.filter((item) => item.shape === 'drive-doc');
    expect(sources.map((item) => item.id)).toEqual(v1.map((item) => item.id));
    expect(sources.map((item) => item.prepared)).toEqual(v1.map((item) => item.prepared));
    expect(new Set(set.map((item) => item.id)).size).toBe(set.length);
  });

  it('renders identical content: the markdown differs from the text only by the heading markers', () => {
    for (const source of sources) {
      const text = renderDriveDoc(source, 'text');
      const markdown = renderDriveDoc(source, 'markdown');
      expect(markdown.prepared.replace(HEADING, '')).toBe(text.prepared);
      expect(text.prepared).not.toMatch(/^#/mu);
      expect(markdown.question).toBe(text.question);
      expect(markdown.needle.text).toBe(text.needle.text);
      expect(markdown.depth).toBe(text.depth);
      expect(markdown.language).toBe(text.language);
      expect(markdown.length).toBe(text.length);
      expect(markdown.titleStarts.length).toBe(text.titleStarts.length);
      expect(markdown.titleStarts.length).toBeGreaterThanOrEqual(2);
      // every v1 paragraph, in order, is still there
      const body = (source.parts[0] as { body: string }).body.split('\n\n');
      let from = 0;
      for (const paragraph of body) {
        const at = text.prepared.indexOf(paragraph, from);
        expect(at).toBeGreaterThanOrEqual(0);
        from = at + paragraph.length;
      }
      // titles sit where titleStarts says, in code points
      for (const variant of [text, markdown]) {
        const points = Array.from(variant.prepared);
        for (const at of variant.titleStarts) expect(at === 0 || points.slice(at - 2, at).join('')).toBe(at === 0 ? true : '\n\n');
        expect(points.slice(variant.needle.start, variant.needle.end).join('')).toBe(variant.needle.text);
      }
    }
  });

  it('keeps a section near its target size and uses no codename or attribute word in a title', () => {
    for (const item of set.filter((candidate) => candidate.format === 'markdown')) {
      const sections = item.prepared.split(/^## /mu).slice(1);
      expect(sections.length).toBeGreaterThanOrEqual(2);
      for (const section of sections.slice(0, -1)) expect(Array.from(section).length).toBeGreaterThanOrEqual(SECTION_TARGET_CODE_POINTS);
      const titles = [...item.prepared.matchAll(/^#{1,2} (.*)$/gmu)].map((match) => match[1] as string).join(' ');
      expect(titles).not.toMatch(/budget|review|owner|decision|meeting|MAX_RETRY/iu);
    }
  });

  it('is frozen with its own digest, separate from the v1 record', () => {
    const record = JSON.parse(readFileSync(DRIVE_FORMAT_FREEZE_PATH, 'utf8')) as FreezeRecord;
    expect(record.version).toBe(DRIVE_FORMAT_VERSION);
    expect(record.seed).toBe(CORPUS_SEED);
    expect(record.cases).toBe(set.length);
    expect(driveFormatDigest(set)).toBe(record.sha256);
    expect(driveFormatDigest(generateDriveFormatSet())).toBe(record.sha256);
    expect(record.sha256).not.toBe(corpusDigest(corpus));
    expect(driveFormatDigest(set.map((item, at) => (at === 3 ? { ...item, question: `${item.question}?` } : item)))).not.toBe(record.sha256);
    expect(driveFormatDigest(set.map((item, at) => (at === 3 ? { ...item, format: 'text' as const } : item)))).not.toBe(record.sha256);
    expect(JSON.parse(readFileSync(FREEZE_PATH, 'utf8')).sha256).toBe(corpusDigest(corpus));
  });

  it('reports a paired difference over a small slice, content-free and non-gating', () => {
    const slice = set.filter((item) => item.length === 6_000 && item.language === 'en');
    const report = runDriveFormat(slice, driveFormatDigest(slice));
    expect(report.status).toBe('NON-GATING');
    expect(report.paired.pairs).toBe(slice.length / 2);
    for (const arm of [report.paired.baseline, report.paired.EL]) {
      expect(arm.bothHit + arm.onlyText + arm.onlyMarkdown + arm.neither).toBe(report.paired.pairs);
      expect(arm.delta).toBeCloseTo(arm.recallMarkdown - arm.recallText, 4);
    }
    expect(report.formats.markdown.structure.passagesStartingAtTitle).toBeGreaterThan(report.formats.text.structure.passagesStartingAtTitle);
    expect(report.formats.markdown.structure.crossingPassages).toBeLessThan(report.formats.text.structure.crossingPassages);
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

  describe('--set drive-format', () => {
    const variantSet = generateDriveFormatSet().filter((item) => item.length === 6_000 && item.language === 'en' && item.depth === 50);
    const variantRecord = (): FreezeRecord => ({ version: DRIVE_FORMAT_VERSION, seed: CORPUS_SEED, cases: variantSet.length, sha256: driveFormatDigest(variantSet) });
    const makeVariant = (corpusOf: () => typeof variantSet, freeze?: FreezeRecord) => {
      let record = freeze;
      const base = make({}, undefined);
      const deps: CliDeps = { ...base.deps, variant: { corpus: corpusOf, readFreeze: () => record, writeFreeze: (next) => { record = next; } } };
      return { ...base, deps, record: () => record };
    };

    it('parses the flag and rejects unknown sets', async () => {
      expect(parseArguments(['--set', 'drive-format', '--mode', 'run']).set).toBe('drive-format');
      expect(parseArguments(['--mode', 'run']).set).toBe('v1');
      expect(await runCli(['--set', 'nope', '--mode', 'run'], make().deps)).toBe(EXIT_USAGE);
    });

    it('is BLOCKED without a record or when the set differs, and never touches the v1 record', async () => {
      const none = makeVariant(() => variantSet);
      expect(await runCli(['--set', 'drive-format', '--mode', 'run'], none.deps)).toBe(EXIT_BLOCKED);
      const stale = makeVariant(() => variantSet, { ...variantRecord(), sha256: 'a'.repeat(64) });
      expect(await runCli(['--set', 'drive-format', '--mode', 'verify'], stale.deps)).toBe(EXIT_BLOCKED);
      expect(await runCli(['--set', 'drive-format', '--mode', 'run'], stale.deps)).toBe(EXIT_BLOCKED);
      expect(stale.written.report).toBeUndefined();
      const changed = makeVariant(() => variantSet.map((item, at) => (at === 0 ? { ...item, prepared: `${item.prepared}\n` } : item)), variantRecord());
      expect(await runCli(['--set', 'drive-format', '--mode', 'run'], changed.deps)).toBe(EXIT_BLOCKED);
    });

    it('records its own freeze only through regenerate-freeze, then verifies and runs NON-GATING', async () => {
      const run = makeVariant(() => variantSet);
      expect(await runCli(['--set', 'drive-format', '--mode', 'regenerate-freeze'], run.deps)).toBe(EXIT_OK);
      expect(run.record()?.sha256).toBe(driveFormatDigest(variantSet));
      expect(await runCli(['--set', 'drive-format', '--mode', 'verify'], run.deps)).toBe(EXIT_OK);
      expect(await runCli(['--set', 'drive-format', '--mode', 'run', '--out', '/tmp/chunk-eval-test'], run.deps)).toBe(EXIT_NON_GATING);
      expect(run.written.name).toMatch(/^chunk-eval-drive-format-[0-9a-f]{12}-2026-11-03T00-00-00-000Z\.json$/);
      expect(run.out.join('\n')).not.toMatch(/PASSED/);
    });
  });
});

// ---------------------------------------------------------------- v2 (ADR-0124 section 16)

describe('harder synthetic set v2 (ADR-0124 section 16)', () => {
  const v2 = generateCorpusV2();
  const cp = (text: string): number => Array.from(text).length;
  /** The paragraph (a sheet row for a workbook) of the prepared text that holds the needle. */
  const paragraphOf = (item: ChunkEvalCaseV2): string => {
    const points = Array.from(item.prepared);
    const at = item.needle.start;
    const boundary = item.shape === 'workbook' ? '\n' : '\n\n';
    const text = item.prepared;
    const unitStart = text.lastIndexOf(boundary, points.slice(0, at).join('').length - 1);
    const from = unitStart < 0 ? 0 : unitStart + boundary.length;
    const to = text.indexOf(boundary, points.slice(0, at).join('').length);
    return text.slice(from, to < 0 ? text.length : to);
  };

  it('keeps v1 and the Drive-format variant byte-identical and verified (digests unchanged)', () => {
    expect(corpusDigest(corpus)).toBe('f395110d15bb635851a85b290d5867ac897160514e71420a0df73e051f8c4ed5');
    expect(driveFormatDigest(generateDriveFormatSet())).toBe('4cec7f4cc4bb1244ff4987ef39f2684bfbea898bdad215dc38b5c34d79a84f4b');
  });

  it('has the v1 shapes, tiers and depths, 300-500 cases, a reduced 2 MiB ADR tier, and Drive section-name pairs', () => {
    expect(v2.length).toBeGreaterThanOrEqual(300);
    expect(v2.length).toBeLessThanOrEqual(500);
    expect(new Set(v2.map((item) => item.id)).size).toBe(v2.length);
    expect(new Set(v2.map((item) => item.shape))).toEqual(new Set(SHAPES));
    expect([...new Set(v2.filter((item) => item.length !== ADR_FILE_BYTES).map((item) => item.length))]).toEqual([...LENGTHS]);
    expect([...new Set(v2.map((item) => item.depth))].sort((a, b) => a - b)).toEqual([...DEPTHS]);
    expect(v2.filter((item) => item.length === ADR_FILE_BYTES).length).toBe(3);
    const pairs = v2.filter((item) => item.format === 'text');
    expect(pairs.length).toBeGreaterThan(0);
    expect(v2.filter((item) => item.format === 'markdown').length).toBe(pairs.length);
    expect(pairs.every((item) => item.shape === 'drive-doc' && item.mode === 'section')).toBe(true);
  });

  it('is deterministic and matches its own freeze record, which is separate from v1 and drive-format', () => {
    expect(corpusV2Digest(generateCorpusV2())).toBe(corpusV2Digest(v2));
    const record = JSON.parse(readFileSync(V2_FREEZE_PATH, 'utf8')) as FreezeRecord;
    expect(V2_FREEZE_PATH).not.toBe(FREEZE_PATH);
    expect(record.version).toBe(CORPUS_V2_VERSION);
    expect(record.seed).toBe(CORPUS_V2_SEED);
    expect(record.cases).toBe(v2.length);
    expect(corpusV2Digest(v2)).toBe(record.sha256);
    expect(corpusV2Digest(v2.map((item, at) => (at === 5 ? { ...item, tags: [...item.tags, 'dense' as const] } : item)))).not.toBe(record.sha256);
  });

  it('puts the needle once in every item, at the requested depth within the documented tolerance', () => {
    // 0.05 everywhere; a section-name case may be as far off as the named section is wide (its share of the item), because the needle
    // must lie inside the one section the requested depth falls into: that share is 0.10-0.5 in the 6k and 20k tiers, below 0.05 above.
    for (const item of v2) {
      const points = Array.from(item.prepared);
      expect(points.slice(item.needle.start, item.needle.end).join(''), item.id).toBe(item.needle.text);
      expect(item.prepared.split(item.needle.text).length - 1, item.id).toBe(1);
      const share = item.section === undefined ? 0 : (item.section.end - item.section.start) / points.length;
      const tolerance = Math.max(0.05, share);
      expect(Math.abs(item.needle.start / points.length - item.depth / 100), item.id).toBeLessThanOrEqual(tolerance);
    }
  });

  it('tags every case and has every shape x feature cell the report stratifies by', () => {
    for (const item of v2) expect(item.tags.every((tag) => FEATURE_TAGS.includes(tag)), item.id).toBe(true);
    for (const shape of SHAPES) {
      const cells = v2.filter((item) => item.shape === shape);
      for (const tag of ['named', 'paraphrase', 'long-paragraph', 'lp-middle', 'lp-cut', 'near-duplicate', 'dense'] as const) {
        expect(cells.filter((item) => item.tags.includes(tag)).length, `${shape} ${tag}`).toBeGreaterThanOrEqual(5);
      }
    }
    for (const shape of ['drive-doc', 'adr-file'] as const) expect(v2.filter((item) => item.shape === shape && item.mode === 'section').length).toBeGreaterThanOrEqual(10);
    expect(v2.filter((item) => item.shape !== 'drive-doc' && item.shape !== 'adr-file').every((item) => item.mode !== 'section')).toBe(true);
  });

  it('paraphrase and section questions contain neither the codename, nor an answer value, nor the needle topic phrase', () => {
    for (const item of v2.filter((candidate) => candidate.mode !== 'named')) {
      const lower = item.question.toLowerCase();
      expect(lower.includes(item.codename.toLowerCase()), item.id).toBe(false);
      for (const answer of item.answers) expect(lower.includes(answer.toLowerCase()), `${item.id} ${answer}`).toBe(false);
      expect(lower.includes(item.topic.needle.toLowerCase()), item.id).toBe(false);
      expect(item.needle.text.toLowerCase().includes(item.codename.toLowerCase()), item.id).toBe(true);
    }
    for (const item of v2.filter((candidate) => candidate.mode === 'named')) expect(item.question.includes(item.codename), item.id).toBe(true);
    expect(v2.filter((item) => item.mode === 'paraphrase').length).toBeGreaterThan(100);
  });

  it('long-paragraph cases hold the needle in one paragraph of 1,300-4,000 code points with no blank line inside', () => {
    const long = v2.filter((item) => item.tags.includes('long-paragraph'));
    expect(long.length).toBeGreaterThan(100);
    for (const item of long) {
      const text = paragraphOf(item);
      expect(text.includes(item.needle.text), item.id).toBe(true);
      expect(cp(text), item.id).toBeGreaterThan(1_200);
      expect(cp(text), item.id).toBeGreaterThanOrEqual(1_300);
      expect(cp(text), item.id).toBeLessThanOrEqual(4_010);
      expect(item.longParagraph?.end).toBe((item.longParagraph?.start ?? 0) + cp(text));
      if (item.shape !== 'workbook') expect(text.includes('\n\n'), item.id).toBe(false);
      if (item.tags.includes('lp-middle')) {
        const fraction = (item.needle.start - (item.longParagraph?.start ?? 0)) / cp(text);
        expect(fraction, item.id).toBeGreaterThanOrEqual(1 / 3);
        expect(fraction, item.id).toBeLessThanOrEqual(2 / 3);
      }
    }
    // a case without the feature has no needle paragraph beyond the cap (v1's situation)
    for (const item of v2.filter((candidate) => !candidate.tags.includes('long-paragraph') && candidate.nearDuplicates.length === 0)) expect(cp(paragraphOf(item)), item.id).toBeLessThanOrEqual(1_200);
  });

  it('the chunker splits long paragraphs and uses its overlap there (the path v1 never ran)', () => {
    const sample = v2.filter((item) => item.tags.includes('long-paragraph') && item.length <= 20_000 && item.shape !== 'workbook').slice(0, 12);
    for (const item of sample) {
      const passages = lexicalWindow(item).passages;
      const span = item.longParagraph as { start: number; end: number };
      const inside = passages.filter((passage) => passage.span.start < span.end && passage.span.end > span.start);
      expect(inside.length, item.id).toBeGreaterThanOrEqual(2);
    }
    expect(sample.some((item) => lexicalWindow(item).passages.some((passage) => passage.overlap !== undefined))).toBe(true);
  });

  it('section-name cases name a section by its title, hold the needle inside it, and keep same-kind near-duplicates out', () => {
    const named = v2.filter((item) => item.mode === 'section');
    expect(named.length).toBeGreaterThan(40);
    for (const item of named) {
      const section = item.section as NonNullable<ChunkEvalCaseV2['section']>;
      expect(section.start, item.id).toBeLessThanOrEqual(item.needle.start);
      expect(section.end, item.id).toBeGreaterThanOrEqual(item.needle.end);
      expect(item.nearDuplicates, item.id).toHaveLength(0);
      const name = sectionName(item.language, section.number - 1);
      expect(name.title).toBe(section.title);
      expect(item.question.startsWith(name.reference), item.id).toBe(true);
      const heading = Array.from(item.prepared).slice(section.start, section.start + cp(section.title) + 3).join('');
      expect(heading.includes(section.title), item.id).toBe(true);
    }
  });

  it('renders each Drive section-name case as a plain-text and a Markdown case that differ only in heading markup', () => {
    const texts = v2.filter((item) => item.format === 'text');
    for (const text of texts) {
      const mark = v2.find((candidate) => candidate.id === `${text.pairId}-markdown`) as ChunkEvalCaseV2;
      expect(mark.pairId).toBe(text.pairId);
      expect(text.id).toBe(`${text.pairId}-text`);
      expect(mark.question).toBe(text.question);
      expect(mark.needle.text).toBe(text.needle.text);
      expect(mark.answers).toEqual(text.answers);
      expect(mark.tags).toEqual(text.tags);
      expect(mark.section?.title).toBe(text.section?.title);
      const stripped = mark.prepared
        .split('\n\n')
        .map((block) => (block.startsWith('## ') ? block.slice(3) : block.startsWith('# ') ? block.slice(2) : block))
        .join('\n\n');
      expect(stripped, text.id).toBe(text.prepared);
      expect(mark.prepared).not.toBe(text.prepared);
      expect(mark.prepared.split('\n').filter((line) => line.startsWith('## ')).length, text.id).toBeGreaterThanOrEqual(2);
      expect(text.prepared.split('\n').some((line) => line.startsWith('#')), text.id).toBe(false);
    }
  });

  it('near-duplicate cases hold at least one same-kind decoy rendered from the needle template, with another topic and codename', () => {
    const dup = v2.filter((item) => item.tags.includes('near-duplicate'));
    expect(dup.length).toBeGreaterThan(50);
    for (const item of dup) {
      expect(item.nearDuplicates.length, item.id).toBeGreaterThanOrEqual(1);
      for (const near of item.nearDuplicates) {
        expect(near.kind).toBe(item.needleKind);
        expect(item.prepared.includes(near.text), item.id).toBe(true);
        expect(renderNeedle(near.kind, item.language, near.slots)).toBe(near.text);
        expect(near.text).not.toBe(item.needle.text);
        expect(near.slots.subject).not.toBe(item.codename);
        expect(near.slots.topic).not.toBe(item.topic.needle);
      }
    }
    // quoted earlier messages carry `>` markers in mail and thread
    expect(dup.filter((item) => item.shape === 'mail' || item.shape === 'thread').every((item) => item.prepared.split('\n').some((line) => line.startsWith('> ')))).toBe(true);
    // a code-line near-duplicate in the ADR file sits in a fenced block with near-identical lines
    expect(dup.some((item) => item.shape === 'adr-file' && item.needleKind === 'code-line' && item.prepared.includes('```ts\nconst MAX_RETRY_'))).toBe(true);
  });

  it('uses only fictional names and no link, address or token-like literal', () => {
    for (const item of v2) expect(item.prepared, item.id).not.toMatch(/https?:\/\/|@[a-z]+\.|sk-[A-Za-z0-9]{8}/);
  });

  describe('run and cli', () => {
    const slice = v2.filter((item) => item.length === 6_000 && item.language === 'en' && (item.shape !== 'adr-file' || item.depth === 50));
    const report = runChunkEvalV2(slice, corpusV2Digest(slice));

    it('reports window recall by feature and by shape x feature, exact misses, overlap use, and the section-name pairs', () => {
      expect(report.kind).toBe('chunk-eval-v2');
      expect(report.status).toBe('NON-GATING');
      expect(report.gate.verdict).toBe('NOT_RUN');
      expect(report.features.EL.all?.n).toBe(slice.length);
      expect(report.features.baseline.paraphrase?.n).toBe(slice.filter((item) => item.tags.includes('paraphrase')).length);
      expect(Object.keys(report.byShapeFeature.EL)).toEqual(expect.arrayContaining([...SHAPES]));
      const cellTotal = Object.values(report.misses.EL).flatMap((kinds) => Object.values(kinds)).reduce((sum, cell) => sum + cell.n, 0);
      expect(cellTotal).toBe(slice.length);
      const missed = Object.values(report.misses.EL).flatMap((kinds) => Object.values(kinds)).reduce((sum, cell) => sum + cell.misses, 0);
      expect(missed).toBe(report.misses.ELMissIds.length);
      expect(report.chunkerLongParagraph.byShape.mail?.longParagraphCases?.cases).toBeGreaterThan(0);
      expect(report.sectionNameDrivePairs.pairs).toBe(slice.filter((item) => item.format === 'text').length);
      expect(JSON.stringify(report)).not.toContain(slice[0]?.needle.text ?? '\u0000');
    });

    const makeCli = (record?: FreezeRecord, corpusOf: () => ChunkEvalCaseV2[] = () => slice) => {
      const out: string[] = [];
      const err: string[] = [];
      const written: { name?: string; report?: unknown } = {};
      let current = record;
      const deps: CliDeps = {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        now: () => new Date('2026-11-05T00:00:00Z'),
        corpus: () => [],
        readFreeze: () => undefined,
        writeFreeze: () => undefined,
        writeReport: (dir, name, body) => {
          Object.assign(written, { name, report: body });
          return `${dir}/${name}`;
        },
        v2: { corpus: corpusOf, readFreeze: () => current, writeFreeze: (next) => { current = next; } },
      };
      return { deps, out, err, written, record: () => current };
    };
    const v2Record = (): FreezeRecord => ({ version: CORPUS_V2_VERSION, seed: CORPUS_V2_SEED, cases: slice.length, sha256: corpusV2Digest(slice) });

    it('is BLOCKED without a record or when the set differs, and never writes a report then', async () => {
      const none = makeCli();
      expect(parseArguments(['--set', 'v2', '--mode', 'run']).set).toBe('v2');
      expect(await runCli(['--set', 'v2', '--mode', 'run'], none.deps)).toBe(EXIT_BLOCKED);
      const stale = makeCli({ ...v2Record(), sha256: 'a'.repeat(64) });
      expect(await runCli(['--set', 'v2', '--mode', 'verify'], stale.deps)).toBe(EXIT_BLOCKED);
      expect(await runCli(['--set', 'v2', '--mode', 'run'], stale.deps)).toBe(EXIT_BLOCKED);
      expect(stale.written.report).toBeUndefined();
      const changed = makeCli(v2Record(), () => slice.map((item, at) => (at === 0 ? { ...item, question: `${item.question}?` } : item)));
      expect(await runCli(['--set', 'v2', '--mode', 'run'], changed.deps)).toBe(EXIT_BLOCKED);
    });

    it('records its own freeze only through regenerate-freeze, then verifies and runs NON-GATING', async () => {
      const run = makeCli();
      expect(await runCli(['--set', 'v2', '--mode', 'regenerate-freeze'], run.deps)).toBe(EXIT_OK);
      expect(run.record()?.sha256).toBe(corpusV2Digest(slice));
      expect(await runCli(['--set', 'v2', '--mode', 'verify'], run.deps)).toBe(EXIT_OK);
      expect(await runCli(['--set', 'v2', '--mode', 'run', '--out', '/tmp/chunk-eval-test'], run.deps)).toBe(EXIT_NON_GATING);
      expect(run.written.name).toMatch(/^chunk-eval-v2-[0-9a-f]{12}-2026-11-05T00-00-00-000Z\.json$/);
      expect(run.out.join('\n')).not.toMatch(/PASSED/);
    });
  });
});
