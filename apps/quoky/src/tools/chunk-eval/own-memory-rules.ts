/**
 * ADR-0124 phase 2 P2-5 (B): the OFFLINE own-memory judgment rule families, their pre-declared calibration and verdict. Pure module (no
 * model, no I/O, never wired to production). Input per question: the recalled entries exactly as the context builder hands them to the
 * policy (content, retrievalMode, semanticScore) plus the id of the memory behind each entry (needed only to tell whether the entry that
 * triggered a hit is the gold memory).
 *
 * Safety purpose, kept: a FALSE hit lets the answering model invent a personal fact; a miss only costs a truthful "not in memory". The bar
 * is ZERO false hits on the negatives.
 *
 * Families (all keep the production topic-word path: an entry sharing a meaningful topic word with the question always hits):
 *   - F0      production: topic word OR any semantic entry with score >= OWN_MEMORY_SEMANTIC_HIT_FLOOR (0.9).
 *   - F1(tau): topic word OR the TOP entry's semantic score >= tau. "Top" = the highest valid semantic score (ties: first in entry order).
 *   - F2(tau, delta): topic word OR (top1 >= tau AND top1 - top2 >= delta); top2 = the second-highest valid semantic score, 0 when there is none.
 * A semantic score is valid only for an entry with retrievalMode `semantic` and a finite score in [0, 1] (as production).
 */
import { OWN_MEMORY_SEMANTIC_HIT_FLOOR, sharesTopicWord, type OwnMemoryRecallQuestion } from '@quoky/core';
import { percentiles7, type Percentiles7 } from './blend-sweep';
import type { OwnCategory, OwnHalf, OwnLanguage } from './memory-set-own';

export interface RecallEntry {
  readonly memoryId: string;
  readonly content: string;
  readonly retrievalMode?: 'lexical' | 'semantic';
  readonly semanticScore?: number;
}

export interface RuleQuestion {
  readonly id: string;
  readonly category: OwnCategory;
  readonly half: OwnHalf;
  readonly language: OwnLanguage;
  readonly gold: readonly string[];
  readonly question: OwnMemoryRecallQuestion;
  readonly entries: readonly RecallEntry[];
}

export type RuleSpec =
  | { readonly family: 'F0' }
  | { readonly family: 'F1'; readonly tau: number }
  | { readonly family: 'F2'; readonly tau: number; readonly delta: number };

export const TAU_GRID: readonly number[] = Array.from({ length: 51 }, (_, at) => (40 + at) / 100);
export const DELTA_OPTIONS: readonly number[] = [0.05, 0.1, 0.15];
export const SAFETY_MARGIN = 0.03;
export const MIN_GAIN = 0.2;
export const F1_PREFERENCE_TOLERANCE = 0.05;

export const OWN_RULES = {
  F0: 'production: topic word OR any semantic entry with score >= 0.9',
  F1: 'topic word OR the top entry semantic >= tau (top = highest valid semantic score)',
  F2: 'topic word OR (top1 semantic >= tau AND top1 - top2 >= delta), delta in {0.05, 0.10, 0.15}; top2 = 0 when there is no second semantic entry',
  correct: 'a hit on a positive is correct only when the entry that triggered it is the gold memory (topic-word hits: any entry sharing a word; whether it was the gold is reported separately); a hit on a negative is a FALSE hit',
  tauGrid: 'tau 0.40 .. 0.90 step 0.01',
  calibration: 'per family, on the calibrate half pick the smallest tau (F2: per delta) giving 0 false hits on calibrate negatives, then add the fixed safety margin +0.03; maximize the calibrate positive-paraphrase correct-hit rate among the F2 delta options (ties: larger delta)',
  verdict: 'adopt the family/params whose VALIDATE half has 0 false hits on negatives AND whose validate positive-paraphrase correct-hit rate >= F0 + 0.20; prefer F1 over F2 when both qualify and the F1 rate is within 0.05 of the F2 rate; else keep F0',
} as const;

const EPS = 1e-9;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** The semantic score production would trust for an entry, or null. */
export function validSemantic(entry: RecallEntry): number | null {
  if (entry.retrievalMode !== 'semantic') return null;
  const score = entry.semanticScore;
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

/** Entries with a valid semantic score, best first (stable: entry order breaks ties). */
export function rankedSemantic(entries: readonly RecallEntry[]): Array<{ entry: RecallEntry; score: number }> {
  const scored = entries.flatMap((entry, at) => {
    const score = validSemantic(entry);
    return score === null ? [] : [{ entry, score, at }];
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map(({ entry, score }) => ({ entry, score }));
}

export interface Decision {
  readonly hit: boolean;
  /** Entries sharing a meaningful topic word with the question. */
  readonly topicIds: readonly string[];
  /** Entries whose semantic score triggered the rule (empty when only the topic path hit). */
  readonly semanticIds: readonly string[];
}

export function decide(spec: RuleSpec, item: RuleQuestion): Decision {
  const topicIds = item.entries.filter((entry) => sharesTopicWord(item.question, entry.content)).map((entry) => entry.memoryId);
  const ranked = rankedSemantic(item.entries);
  let semanticIds: string[] = [];
  if (spec.family === 'F0') semanticIds = ranked.filter((candidate) => candidate.score >= OWN_MEMORY_SEMANTIC_HIT_FLOOR).map((candidate) => candidate.entry.memoryId);
  else {
    const top = ranked[0];
    if (top !== undefined && top.score >= spec.tau) {
      if (spec.family === 'F1') semanticIds = [top.entry.memoryId];
      else {
        const gap = round4(top.score - (ranked[1]?.score ?? 0));
        if (gap + EPS >= spec.delta) semanticIds = [top.entry.memoryId];
      }
    }
  }
  return { hit: topicIds.length > 0 || semanticIds.length > 0, topicIds, semanticIds };
}

export interface PositiveStats {
  readonly n: number;
  readonly hits: number;
  readonly correct: number;
  /** Hit without the gold among its triggers. */
  readonly wrong: number;
  readonly topicHits: number;
  readonly topicHitsGold: number;
  readonly hitRate: number;
  readonly correctRate: number;
}

export interface NegativeStats {
  readonly n: number;
  readonly falseHits: number;
  readonly byTopicWord: number;
  readonly bySemantic: number;
}

export function positiveStats(items: readonly RuleQuestion[], spec: RuleSpec): PositiveStats {
  let hits = 0;
  let correct = 0;
  let wrong = 0;
  let topicHits = 0;
  let topicHitsGold = 0;
  for (const item of items) {
    const decision = decide(spec, item);
    if (!decision.hit) continue;
    hits += 1;
    const triggered = new Set([...decision.topicIds, ...decision.semanticIds]);
    if (item.gold.some((id) => triggered.has(id))) correct += 1;
    else wrong += 1;
    if (decision.topicIds.length > 0) {
      topicHits += 1;
      if (item.gold.some((id) => decision.topicIds.includes(id))) topicHitsGold += 1;
    }
  }
  const n = items.length;
  return { n, hits, correct, wrong, topicHits, topicHitsGold, hitRate: n === 0 ? 0 : round4(hits / n), correctRate: n === 0 ? 0 : round4(correct / n) };
}

export function negativeStats(items: readonly RuleQuestion[], spec: RuleSpec): NegativeStats {
  let falseHits = 0;
  let byTopicWord = 0;
  let bySemantic = 0;
  for (const item of items) {
    const decision = decide(spec, item);
    if (!decision.hit) continue;
    falseHits += 1;
    if (decision.topicIds.length > 0) byTopicWord += 1;
    else bySemantic += 1;
  }
  return { n: items.length, falseHits, byTopicWord, bySemantic };
}

const inHalf = (items: readonly RuleQuestion[], half: OwnHalf, category: OwnCategory): RuleQuestion[] => items.filter((item) => item.half === half && item.category === category);

export interface SplitStats {
  readonly negatives: NegativeStats;
  readonly paraphrase: PositiveStats;
  readonly shared: PositiveStats;
}

export function splitStats(items: readonly RuleQuestion[], half: OwnHalf, spec: RuleSpec): SplitStats {
  return {
    negatives: negativeStats(inHalf(items, half, 'negative'), spec),
    paraphrase: positiveStats(inHalf(items, half, 'positive-paraphrase'), spec),
    shared: positiveStats(inHalf(items, half, 'positive-shared'), spec),
  };
}

// ---------------------------------------------------------------- calibration

export interface TauPick {
  /** The smallest grid tau with 0 false hits on the calibrate negatives, or null when no grid tau achieves it. */
  readonly smallestTau: number | null;
  /** smallestTau + the safety margin; null when smallestTau is null. */
  readonly tau: number | null;
}

const specOf = (family: 'F1' | 'F2', tau: number, delta: number): RuleSpec => (family === 'F1' ? { family: 'F1', tau } : { family: 'F2', tau, delta });

export function pickTau(items: readonly RuleQuestion[], family: 'F1' | 'F2', delta = 0): TauPick {
  const negatives = inHalf(items, 'calibrate', 'negative');
  for (const tau of TAU_GRID) {
    if (negativeStats(negatives, specOf(family, tau, delta)).falseHits === 0) return { smallestTau: tau, tau: round2(tau + SAFETY_MARGIN) };
  }
  return { smallestTau: null, tau: null };
}

export interface FamilyReport {
  readonly family: 'F0' | 'F1' | 'F2';
  /** Chosen parameters; null for F0 (fixed) or when calibration found no tau with 0 false hits. */
  readonly params: { readonly tau: number; readonly delta?: number; readonly smallestTau: number } | null;
  readonly calibrationFailed: boolean;
  readonly calibrate: SplitStats | null;
  readonly validate: SplitStats | null;
  /** F2: the per-delta calibration (every option, for the record). */
  readonly deltaOptions?: ReadonlyArray<{ readonly delta: number; readonly smallestTau: number | null; readonly tau: number | null; readonly calibrateParaphraseCorrectRate: number | null }>;
}

export function calibrateFamily(items: readonly RuleQuestion[], family: 'F1' | 'F2'): FamilyReport {
  if (family === 'F1') {
    const pick = pickTau(items, 'F1');
    if (pick.tau === null || pick.smallestTau === null) return { family, params: null, calibrationFailed: true, calibrate: null, validate: null };
    const spec: RuleSpec = { family: 'F1', tau: pick.tau };
    return { family, params: { tau: pick.tau, smallestTau: pick.smallestTau }, calibrationFailed: false, calibrate: splitStats(items, 'calibrate', spec), validate: splitStats(items, 'validate', spec) };
  }
  const options = DELTA_OPTIONS.map((delta) => {
    const pick = pickTau(items, 'F2', delta);
    const rate = pick.tau === null ? null : positiveStats(inHalf(items, 'calibrate', 'positive-paraphrase'), { family: 'F2', tau: pick.tau, delta }).correctRate;
    return { delta, smallestTau: pick.smallestTau, tau: pick.tau, calibrateParaphraseCorrectRate: rate };
  });
  let best: (typeof options)[number] | null = null;
  for (const option of options) {
    if (option.tau === null || option.calibrateParaphraseCorrectRate === null) continue;
    // ties go to the larger delta (options ascend, so >= keeps the later, larger one)
    if (best === null || option.calibrateParaphraseCorrectRate >= (best.calibrateParaphraseCorrectRate as number)) best = option;
  }
  if (best === null || best.tau === null || best.smallestTau === null) return { family, params: null, calibrationFailed: true, calibrate: null, validate: null, deltaOptions: options };
  const spec: RuleSpec = { family: 'F2', tau: best.tau, delta: best.delta };
  return { family, params: { tau: best.tau, delta: best.delta, smallestTau: best.smallestTau }, calibrationFailed: false, calibrate: splitStats(items, 'calibrate', spec), validate: splitStats(items, 'validate', spec), deltaOptions: options };
}

export function f0Report(items: readonly RuleQuestion[]): FamilyReport {
  const spec: RuleSpec = { family: 'F0' };
  return { family: 'F0', params: null, calibrationFailed: false, calibrate: splitStats(items, 'calibrate', spec), validate: splitStats(items, 'validate', spec) };
}

// ---------------------------------------------------------------- verdict

export type OwnChoice = 'F0' | 'F1' | 'F2';
export interface OwnVerdict {
  readonly choice: OwnChoice;
  readonly qualified: readonly OwnChoice[];
  readonly reason: string;
}

/** A family qualifies when its validate half has 0 false hits AND its validate paraphrase correct-hit rate is at least F0's + 0.20. */
export function qualifies(report: FamilyReport, f0: FamilyReport): boolean {
  if (report.params === null || report.validate === null || f0.validate === null) return false;
  return report.validate.negatives.falseHits === 0 && report.validate.paraphrase.correctRate >= f0.validate.paraphrase.correctRate + MIN_GAIN - EPS;
}

export function ownVerdict(f0: FamilyReport, f1: FamilyReport, f2: FamilyReport): OwnVerdict {
  const q1 = qualifies(f1, f0);
  const q2 = qualifies(f2, f0);
  const qualified: OwnChoice[] = [...(q1 ? (['F1'] as const) : []), ...(q2 ? (['F2'] as const) : [])];
  if (q1 && q2) {
    const r1 = (f1.validate as SplitStats).paraphrase.correctRate;
    const r2 = (f2.validate as SplitStats).paraphrase.correctRate;
    if (r1 >= r2 - F1_PREFERENCE_TOLERANCE - EPS) return { choice: 'F1', qualified, reason: 'F1 and F2 qualify and the F1 validate paraphrase rate is within 0.05 of F2 (simpler rule preferred)' };
    return { choice: 'F2', qualified, reason: 'F1 and F2 qualify and the F2 validate paraphrase rate beats F1 by more than 0.05' };
  }
  if (q1) return { choice: 'F1', qualified, reason: 'only F1 qualifies' };
  if (q2) return { choice: 'F2', qualified, reason: 'only F2 qualifies' };
  return { choice: 'F0', qualified, reason: 'no family has 0 validate false hits together with a validate paraphrase correct-hit rate >= F0 + 0.20; keep the production rule' };
}

// ---------------------------------------------------------------- distributions and the grid

export interface Distributions {
  /** Top-1 valid semantic score per negative, by half. */
  readonly negativeTop1: { readonly calibrate: Percentiles7 | null; readonly validate: Percentiles7 | null; readonly all: Percentiles7 | null };
  /** The gold memory's semantic score per positive (max over gold ids), by category; unscored = the gold is not among the recalled entries or has no valid score. */
  readonly goldScore: Readonly<Record<'positive-paraphrase' | 'positive-shared', { readonly scores: Percentiles7 | null; readonly unscored: number; readonly n: number }>>;
  /** For a paraphrase positive: how often the gold is the top semantic entry. */
  readonly paraphraseGoldIsTop: { readonly n: number; readonly top: number };
}

export function distributionsOf(items: readonly RuleQuestion[]): Distributions {
  const top1 = (item: RuleQuestion): number | null => rankedSemantic(item.entries)[0]?.score ?? null;
  const negs = items.filter((item) => item.category === 'negative');
  const tops = (subset: readonly RuleQuestion[]): Percentiles7 | null => percentiles7(subset.map(top1).filter((value): value is number => value !== null));
  const goldOf = (category: 'positive-paraphrase' | 'positive-shared') => {
    const subset = items.filter((item) => item.category === category);
    const scores: number[] = [];
    let unscored = 0;
    for (const item of subset) {
      const found = item.entries.filter((entry) => item.gold.includes(entry.memoryId)).map(validSemantic).filter((value): value is number => value !== null);
      if (found.length === 0) unscored += 1;
      else scores.push(Math.max(...found));
    }
    return { scores: percentiles7(scores), unscored, n: subset.length };
  };
  const pp = items.filter((item) => item.category === 'positive-paraphrase');
  return {
    negativeTop1: { calibrate: tops(negs.filter((item) => item.half === 'calibrate')), validate: tops(negs.filter((item) => item.half === 'validate')), all: tops(negs) },
    goldScore: { 'positive-paraphrase': goldOf('positive-paraphrase'), 'positive-shared': goldOf('positive-shared') },
    paraphraseGoldIsTop: { n: pp.length, top: pp.filter((item) => item.gold.includes(rankedSemantic(item.entries)[0]?.entry.memoryId ?? '')).length },
  };
}

export interface GridRow {
  readonly tau: number;
  readonly f1: { readonly calibrateFalse: number; readonly validateFalse: number; readonly calibrateParaphrase: number; readonly validateParaphrase: number };
  readonly f2: ReadonlyArray<{ readonly delta: number; readonly calibrateFalse: number; readonly validateFalse: number; readonly calibrateParaphrase: number; readonly validateParaphrase: number }>;
}

/** The whole tau grid (F1 and every F2 delta): false hits per half on negatives and paraphrase correct-hit rate per half. */
export function gridOf(items: readonly RuleQuestion[]): GridRow[] {
  const cell = (spec: RuleSpec) => {
    const cal = splitStats(items, 'calibrate', spec);
    const val = splitStats(items, 'validate', spec);
    return { calibrateFalse: cal.negatives.falseHits, validateFalse: val.negatives.falseHits, calibrateParaphrase: cal.paraphrase.correctRate, validateParaphrase: val.paraphrase.correctRate };
  };
  return TAU_GRID.map((tau) => ({ tau, f1: cell({ family: 'F1', tau }), f2: DELTA_OPTIONS.map((delta) => ({ delta, ...cell({ family: 'F2', tau, delta }) })) }));
}

export interface OwnRulesReport {
  readonly questions: number;
  readonly f0: FamilyReport;
  readonly f1: FamilyReport;
  readonly f2: FamilyReport;
  readonly verdict: OwnVerdict;
  readonly distributions: Distributions;
  readonly grid: readonly GridRow[];
}

export function buildOwnRulesReport(items: readonly RuleQuestion[]): OwnRulesReport {
  const f0 = f0Report(items);
  const f1 = calibrateFamily(items, 'F1');
  const f2 = calibrateFamily(items, 'F2');
  return { questions: items.length, f0, f1, f2, verdict: ownVerdict(f0, f1, f2), distributions: distributionsOf(items), grid: gridOf(items) };
}

// ---------------------------------------------------------------- lines

const f3 = (value: number): string => value.toFixed(3);
const pctLine = (p: Percentiles7 | null): string => (p === null ? '-' : `n${p.n} min ${f3(p.min)} p05 ${f3(p.p05)} p25 ${f3(p.p25)} p50 ${f3(p.p50)} p75 ${f3(p.p75)} p95 ${f3(p.p95)} max ${f3(p.max)}`);
const posLine = (label: string, stats: PositiveStats): string => `${label} correct ${f3(stats.correctRate)} (${stats.correct}/${stats.n}; any hit ${stats.hits}, wrong entry ${stats.wrong}, topic-word hits ${stats.topicHits} of which gold ${stats.topicHitsGold})`;
const splitLine = (half: string, stats: SplitStats | null): string =>
  stats === null ? `    ${half}: n/a` : `    ${half}: false hits ${stats.negatives.falseHits}/${stats.negatives.n} (topic word ${stats.negatives.byTopicWord}, semantic ${stats.negatives.bySemantic}); ${posLine('paraphrase', stats.paraphrase)}; ${posLine('shared', stats.shared)}`;

export function ownRulesLines(report: OwnRulesReport): string[] {
  const out: string[] = [];
  for (const family of [report.f0, report.f1, report.f2]) {
    const params = family.family === 'F0' ? 'tau 0.90 fixed (production)' : family.params === null ? 'calibration FAILED: no grid tau gives 0 false hits on the calibrate negatives' : `tau ${family.params.tau.toFixed(2)} (smallest 0-false-hit tau ${family.params.smallestTau.toFixed(2)} + margin ${SAFETY_MARGIN})${family.params.delta === undefined ? '' : `, delta ${family.params.delta.toFixed(2)}`}`;
    out.push(`  ${family.family}: ${params}`);
    out.push(splitLine('calibrate', family.calibrate));
    out.push(splitLine('validate', family.validate));
    if (family.deltaOptions !== undefined) for (const option of family.deltaOptions) out.push(`    delta ${option.delta.toFixed(2)}: smallest tau ${option.smallestTau === null ? '-' : option.smallestTau.toFixed(2)} -> ${option.tau === null ? '-' : option.tau.toFixed(2)}, calibrate paraphrase correct ${option.calibrateParaphraseCorrectRate === null ? '-' : f3(option.calibrateParaphraseCorrectRate)}`);
  }
  const d = report.distributions;
  out.push(`  semantic top-1 on negatives (calibrate): ${pctLine(d.negativeTop1.calibrate)}`);
  out.push(`  semantic top-1 on negatives (validate):  ${pctLine(d.negativeTop1.validate)}`);
  out.push(`  semantic top-1 on negatives (all):       ${pctLine(d.negativeTop1.all)}`);
  out.push(`  semantic gold score on positive-paraphrase: ${pctLine(d.goldScore['positive-paraphrase'].scores)} (unscored ${d.goldScore['positive-paraphrase'].unscored}/${d.goldScore['positive-paraphrase'].n}; gold is the top semantic entry in ${d.paraphraseGoldIsTop.top}/${d.paraphraseGoldIsTop.n})`);
  out.push(`  semantic gold score on positive-shared:     ${pctLine(d.goldScore['positive-shared'].scores)} (unscored ${d.goldScore['positive-shared'].unscored}/${d.goldScore['positive-shared'].n})`);
  out.push('  grid (tau: F1 false cal/val, paraphrase correct cal/val | F2 d0.05 | d0.10 | d0.15 same fields), every 0.05:');
  for (const row of report.grid.filter((entry) => Math.round(entry.tau * 100) % 5 === 0)) {
    const one = (c: { calibrateFalse: number; validateFalse: number; calibrateParaphrase: number; validateParaphrase: number }): string => `${c.calibrateFalse}/${c.validateFalse} ${f3(c.calibrateParaphrase)}/${f3(c.validateParaphrase)}`;
    out.push(`    ${row.tau.toFixed(2)}: F1 ${one(row.f1)} | ${row.f2.map((cell) => `F2 d${cell.delta.toFixed(2)} ${one(cell)}`).join(' | ')}`);
  }
  out.push(`  verdict (pre-declared, advisory): ${report.verdict.choice}${report.verdict.choice === 'F0' ? ' (keep production)' : ' (adopt)'} - ${report.verdict.reason}; qualified: ${report.verdict.qualified.join(', ') || 'none'}`);
  out.push(`  safety bar: zero false hits on the VALIDATE negatives; rule text: ${OWN_RULES.verdict}`);
  return out;
}
