/**
 * ADR-0124 open question 10 (phase 0, no model): does exporting a Google Doc as Markdown (real `#` headings) chunk better than the
 * plain-text export (no headings, so the chunker falls back to paragraphs)? A SEPARATE variant set, never part of the v1 corpus.
 *
 * Built from the v1 generator and seed, drive-doc shape only: every v1 drive-doc case (4 lengths x 5 depths x 3 languages = 60) is
 * rendered twice with IDENTICAL content: a document title line and a section title line before every run of paragraphs (the
 * paragraphs, the needle, the decoys and the question are v1's own). (a) `text`: the titles are ordinary lines, as a Drive
 * plain-text export gives them. (b) `markdown`: the same lines with `# ` (document title) and `## ` (section titles). Nothing else differs.
 *
 * The section layout (about 2,000 code points per section) and the title words are fixed here, before any run, and were not tuned.
 * Titles are fictional word pairs with no codename and none of the question's attribute words.
 */
import { createHash } from 'node:crypto';
import { chunking } from '@quoky/core';
import { runChunkEval, type ArmReport, type ChunkEvalReport } from './chunk-eval';
import { buildCase, CORPUS_SEED, DEPTHS, LANGUAGES, LENGTHS, type ChunkEvalCase, type Language } from './corpus';
import { mean, round4 } from './metrics';
import { lexicalWindow } from './arms';

export const DRIVE_FORMAT_VERSION = 'chunk-eval-drive-format.v1';
export const DRIVE_FORMATS = ['text', 'markdown'] as const;
export type DriveFormat = (typeof DRIVE_FORMATS)[number];
/** A section closes once it holds at least this many code points of paragraphs. */
export const SECTION_TARGET_CODE_POINTS = 2_000;

export interface DriveFormatCase extends ChunkEvalCase {
  readonly format: DriveFormat;
  /** The v1 case both renderings come from. */
  readonly pairId: string;
  /** Code-point offsets of the document title line and of every section title line in `prepared`. */
  readonly titleStarts: readonly number[];
}

const HEADS: Readonly<Record<Language, readonly string[]>> = {
  en: ['Background', 'Scope', 'Timeline', 'Risks', 'Assumptions', 'Appendix', 'Glossary', 'Dependencies'],
  ko: ['배경', '범위', '진행 경과', '위험 요소', '가정', '부록', '용어', '의존 관계'],
  mixed: ['Background', 'Scope', 'Timeline', 'Risks', 'Assumptions', 'Appendix', 'Glossary', 'Dependencies'],
};
const TAILS: Readonly<Record<Language, readonly string[]>> = {
  en: ['overview', 'details', 'summary', 'outline', 'history', 'remarks'],
  ko: ['개요', '세부 내용', '요약', '정리', '이력', '비고'],
  mixed: ['개요', '세부 내용', '요약', '정리', '이력', '비고'],
};
const DOC_TITLE: Readonly<Record<Language, string>> = { en: 'Planning document', ko: '기획 문서', mixed: 'Planning 문서' };

/** The section title for section `index`: a head word and a tail word, by position (no randomness, so a title never carries a name). */
export const sectionTitle = (language: Language, index: number): string => {
  const heads = HEADS[language];
  const tails = TAILS[language];
  return `${heads[index % heads.length]} ${tails[Math.floor(index / heads.length) % tails.length]}`;
};

const cpLength = (text: string): number => Array.from(text).length;

/** Groups the v1 body's paragraphs into sections of about {@link SECTION_TARGET_CODE_POINTS}. */
function groupParagraphs(paragraphs: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const paragraph of paragraphs) {
    current.push(paragraph);
    size += cpLength(paragraph) + 2;
    if (size >= SECTION_TARGET_CODE_POINTS) {
      groups.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function renderDriveDoc(source: ChunkEvalCase, format: DriveFormat): DriveFormatCase {
  const paragraphs = (source.parts[0] as { body: string }).body.split('\n\n');
  const blocks: string[] = [];
  const titleStarts: number[] = [];
  let offset = 0;
  const push = (text: string, isTitle: boolean): void => {
    if (blocks.length > 0) offset += 2;
    if (isTitle) titleStarts.push(offset);
    blocks.push(text);
    offset += cpLength(text);
  };
  push(`${format === 'markdown' ? '# ' : ''}${DOC_TITLE[source.language]}`, true);
  groupParagraphs(paragraphs).forEach((group, index) => {
    push(`${format === 'markdown' ? '## ' : ''}${sectionTitle(source.language, index)}`, true);
    for (const paragraph of group) push(paragraph, false);
  });
  const body = blocks.join('\n\n');
  const joined = chunking.joinSections([{ frame: '', body }]);
  const prepared = joined.text;
  const first = prepared.indexOf(source.needle.text);
  if (first < 0 || prepared.indexOf(source.needle.text, first + 1) >= 0) throw new Error(`drive-format: needle not unique in ${source.id}`);
  const start = cpLength(prepared.slice(0, first));
  return {
    ...source,
    id: `${source.id}-${format}`,
    parts: [{ frame: '', title: '', body }],
    prepared,
    sections: joined.sections,
    needle: { text: source.needle.text, start, end: start + cpLength(source.needle.text) },
    format,
    pairId: source.id,
    titleStarts,
  };
}

/** The v1 drive-doc cases, rebuilt exactly as `generateCorpus` builds them (same ordinal rule). */
export function driveDocSources(): ChunkEvalCase[] {
  const cases: ChunkEvalCase[] = [];
  LENGTHS.forEach((length, lengthAt) => DEPTHS.forEach((depth, depthAt) => LANGUAGES.forEach((language, languageAt) => cases.push(buildCase('drive-doc', length, depth, language, lengthAt + depthAt + languageAt)))));
  return cases;
}

/** Order is fixed: every source in turn, its text rendering then its markdown rendering. */
export function generateDriveFormatSet(): DriveFormatCase[] {
  return driveDocSources().flatMap((source) => DRIVE_FORMATS.map((format) => renderDriveDoc(source, format)));
}

function caseDigest(item: DriveFormatCase): string {
  return createHash('sha256')
    .update(JSON.stringify([item.id, item.pairId, item.format, item.shape, item.length, item.depth, item.language, item.needleKind, item.question, item.needle, item.parts, item.prepared, item.sections, item.titleStarts]))
    .digest('hex');
}

/** sha256 over the variant version, the seed and every case digest, in order. */
export function driveFormatDigest(cases: readonly DriveFormatCase[]): string {
  const hash = createHash('sha256');
  hash.update(`${DRIVE_FORMAT_VERSION}\n${CORPUS_SEED}\n${cases.length}\n`);
  for (const item of cases) hash.update(`${caseDigest(item)}\n`);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- run

export interface FormatStructure {
  readonly passagesPerDoc: { readonly mean: number; readonly max: number };
  /** Passages whose span strictly contains a title line start (they run across a section boundary). */
  readonly crossingPassages: number;
  readonly crossingPerDoc: number;
  /** Passages that begin exactly at a title line. */
  readonly passagesStartingAtTitle: number;
  readonly kinds: Readonly<Record<string, number>>;
}

export interface FormatReport {
  readonly cases: number;
  readonly baseline: ArmReport;
  readonly EL: ArmReport & { readonly retrieval: ChunkEvalReport['arms']['EL']['retrieval'] };
  readonly structure: FormatStructure;
}

export interface PairedArm {
  readonly recallText: number;
  readonly recallMarkdown: number;
  readonly delta: number;
  readonly bothHit: number;
  readonly onlyText: number;
  readonly onlyMarkdown: number;
  readonly neither: number;
  readonly byDepth: Readonly<Record<string, { readonly text: number; readonly markdown: number; readonly delta: number }>>;
}

export interface DriveFormatReport {
  readonly kind: 'chunk-eval-drive-format';
  readonly status: 'NON-GATING';
  readonly corpus: { readonly version: string; readonly seed: string; readonly sha256: string; readonly cases: number; readonly pairs: number };
  readonly formats: Readonly<Record<DriveFormat, FormatReport>>;
  readonly paired: {
    readonly pairs: number;
    readonly baseline: PairedArm;
    readonly EL: PairedArm;
    readonly passagesPerDocDelta: number;
    readonly crossingPerDocDelta: number;
    /** EL ranking quality, where window recall saturates: Recall@1 and MRR of the needle's passage. */
    readonly ELRetrieval: { readonly recallAt1: { readonly text: number; readonly markdown: number }; readonly mrr: { readonly text: number; readonly markdown: number } };
    readonly meanPassageCodePoints: { readonly text: number; readonly markdown: number };
  };
  readonly notRun: readonly string[];
  readonly note: string;
}

function structureOf(cases: readonly DriveFormatCase[]): FormatStructure {
  const counts: number[] = [];
  const kinds: Record<string, number> = {};
  let crossing = 0;
  let atTitle = 0;
  for (const item of cases) {
    const passages = lexicalWindow(item).passages;
    counts.push(passages.length);
    for (const passage of passages) {
      kinds[passage.kind] = (kinds[passage.kind] ?? 0) + 1;
      if (item.titleStarts.some((at) => passage.span.start < at && at < passage.span.end)) crossing += 1;
      if (item.titleStarts.includes(passage.span.start)) atTitle += 1;
    }
  }
  return {
    passagesPerDoc: { mean: Math.round(mean(counts) * 100) / 100, max: counts.reduce((top, value) => Math.max(top, value), 0) },
    crossingPassages: crossing,
    crossingPerDoc: round4(crossing / Math.max(1, cases.length)),
    passagesStartingAtTitle: atTitle,
    kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function pairedArm(texts: readonly boolean[], marks: readonly boolean[], depths: readonly number[]): PairedArm {
  const count = (pick: (a: boolean, b: boolean) => boolean): number => texts.filter((value, at) => pick(value, marks[at] as boolean)).length;
  const recall = (list: readonly boolean[]): number => round4(mean(list.map((hit) => (hit ? 1 : 0))));
  const byDepth: Record<string, { text: number; markdown: number; delta: number }> = {};
  for (const depth of [...new Set(depths)].sort((a, b) => a - b)) {
    const at = depths.map((d, i) => (d === depth ? i : -1)).filter((i) => i >= 0);
    const text = recall(at.map((i) => texts[i] as boolean));
    const markdown = recall(at.map((i) => marks[i] as boolean));
    byDepth[String(depth)] = { text, markdown, delta: round4(markdown - text) };
  }
  return {
    recallText: recall(texts),
    recallMarkdown: recall(marks),
    delta: round4(recall(marks) - recall(texts)),
    bothHit: count((a, b) => a && b),
    onlyText: count((a, b) => a && !b),
    onlyMarkdown: count((a, b) => !a && b),
    neither: count((a, b) => !a && !b),
    byDepth,
  };
}

export function runDriveFormat(cases: readonly DriveFormatCase[], digest: string): DriveFormatReport {
  const by = (format: DriveFormat): DriveFormatCase[] => cases.filter((item) => item.format === format);
  const runs = {} as Record<DriveFormat, { report: ChunkEvalReport; structure: FormatStructure; set: DriveFormatCase[] }>;
  for (const format of DRIVE_FORMATS) {
    const set = by(format);
    runs[format] = { report: runChunkEval(set, digest), structure: structureOf(set), set };
  }
  const formats = Object.fromEntries(
    DRIVE_FORMATS.map((format) => {
      const { report, structure, set } = runs[format];
      return [format, { cases: set.length, baseline: report.arms.baseline, EL: report.arms.EL, structure } satisfies FormatReport];
    }),
  ) as Record<DriveFormat, FormatReport>;
  const rows = (format: DriveFormat): ChunkEvalReport['caseRows'] => runs[format].report.caseRows;
  const depths = runs.text.set.map((item) => item.depth);
  const text = runs.text.report.chunker.byShape['drive-doc'];
  const mark = runs.markdown.report.chunker.byShape['drive-doc'];
  return {
    kind: 'chunk-eval-drive-format',
    status: 'NON-GATING',
    corpus: { version: DRIVE_FORMAT_VERSION, seed: CORPUS_SEED, sha256: digest, cases: cases.length, pairs: runs.text.set.length },
    formats,
    paired: {
      pairs: runs.text.set.length,
      baseline: pairedArm(rows('text').map((r) => r.baselineHit), rows('markdown').map((r) => r.baselineHit), depths),
      EL: pairedArm(rows('text').map((r) => r.lexicalHit), rows('markdown').map((r) => r.lexicalHit), depths),
      passagesPerDocDelta: round4(formats.markdown.structure.passagesPerDoc.mean - formats.text.structure.passagesPerDoc.mean),
      crossingPerDocDelta: round4(formats.markdown.structure.crossingPerDoc - formats.text.structure.crossingPerDoc),
      ELRetrieval: {
        recallAt1: { text: formats.text.EL.retrieval.recallAt1, markdown: formats.markdown.EL.retrieval.recallAt1 },
        mrr: { text: formats.text.EL.retrieval.mrr, markdown: formats.markdown.EL.retrieval.mrr },
      },
      meanPassageCodePoints: { text: text?.passageCodePoints.mean ?? 0, markdown: mark?.passageCodePoints.mean ?? 0 },
    },
    notRun: ['E0', 'E1', 'E2', 'E3', 'EH'],
    note: 'Phase 0, lexical arm only, synthetic text. Same content in both renderings; only the heading markup differs. Real Drive exports differ (tables, lists, inline images, real heading depth); thresholds and the adapter choice stay owner decisions.',
  };
}

export function driveFormatSummaryLines(report: DriveFormatReport): string[] {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const arm = (name: string, p: PairedArm): string =>
    `${name.padEnd(9)} text ${pct(p.recallText)} -> markdown ${pct(p.recallMarkdown)} (delta ${(p.delta * 100).toFixed(1)} pts; both ${p.bothHit}, text only ${p.onlyText}, markdown only ${p.onlyMarkdown}, neither ${p.neither}) by depth ` +
    Object.entries(p.byDepth).map(([d, v]) => `d${d} ${(v.text * 100).toFixed(0)}->${(v.markdown * 100).toFixed(0)}`).join(' ');
  const s = (f: DriveFormat): string => {
    const x = report.formats[f].structure;
    return `${f.padEnd(8)} passages/doc ${x.passagesPerDoc.mean} (max ${x.passagesPerDoc.max}), crossing a section ${x.crossingPassages} (${x.crossingPerDoc}/doc), starting at a title ${x.passagesStartingAtTitle}, kinds ${Object.entries(x.kinds).map(([k, n]) => `${k}:${n}`).join(' ')}`;
  };
  return [
    `eval:chunk drive-format (Phase 0, lexical arm only, no model) — ${report.corpus.pairs} pairs (${report.corpus.cases} cases), set ${report.corpus.sha256}`,
    arm('baseline', report.paired.baseline),
    arm('EL', report.paired.EL),
    s('text'),
    s('markdown'),
    `passages/doc delta (markdown - text) ${report.paired.passagesPerDocDelta}; crossing/doc delta ${report.paired.crossingPerDocDelta}; mean passage cp text ${report.paired.meanPassageCodePoints.text} / markdown ${report.paired.meanPassageCodePoints.markdown}`,
    `EL retrieval (text -> markdown): R@1 ${report.paired.ELRetrieval.recallAt1.text} -> ${report.paired.ELRetrieval.recallAt1.markdown}, MRR ${report.paired.ELRetrieval.mrr.text} -> ${report.paired.ELRetrieval.mrr.markdown}`,
    `status: NON-GATING`,
  ];
}
