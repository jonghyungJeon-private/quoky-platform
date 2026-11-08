/**
 * ADR-0124 phase 2 P2-3: the offline blend comparison of stage R. Pure module (no model, no I/O): given, per query, the candidate
 * table the REAL runtime retrieval observed (pool ids, the semantic scores the real scorer session returned, lexical and recency
 * recomputed with the production formulas), it re-ranks the same candidates under a PRE-DECLARED set of blend formulas, scores them
 * on a pre-declared select / confirm split, and applies a pre-declared deterministic selection rule.
 *
 * Fidelity first: the CURRENT production formula (B0) is recomputed from the table and must reproduce the ids the real retriever
 * returned for every query; any mismatch marks the whole sweep INVALID. The candidates and rules below are frozen and are never
 * tuned to the data. This module only measures; it never changes the production ranking.
 */
import { createHash } from 'node:crypto';

export type LinearCandidate = { readonly id: string; readonly kind: 'linear'; readonly semanticWeight: number; readonly recencyWeight: number };
export type RrfCandidate = { readonly id: string; readonly kind: 'rrf'; readonly k: number; readonly signals: readonly ('semantic' | 'lexical' | 'recency')[] };
export type BlendCandidate = LinearCandidate | RrfCandidate;

const linear = (id: string, semanticWeight: number, recencyWeight: number): LinearCandidate => ({ id, kind: 'linear', semanticWeight, recencyWeight });

/** Pre-declared and frozen (part of the stage R plan digest). B0 is the current production formula. */
export const BLEND_CANDIDATES: readonly BlendCandidate[] = [
  linear('B0', 0.7, 0.25),
  linear('B1', 0.7, 0.1),
  linear('B2', 0.7, 0),
  linear('B3', 0.85, 0.25),
  linear('B4', 0.85, 0.1),
  linear('B5', 0.85, 0),
  linear('B6', 1, 0.25),
  linear('B7', 1, 0.1),
  linear('B8', 1, 0),
  { id: 'B9', kind: 'rrf', k: 60, signals: ['semantic', 'lexical'] },
  { id: 'B10', kind: 'rrf', k: 60, signals: ['semantic', 'lexical', 'recency'] },
];

export const BLEND_RULES = {
  split: 'within each language, queries in set order: even position (0,2,4,..) = select, odd = confirm',
  selection: 'maximize min over languages of Recall@5 on the select half; ties: higher overall MRR@10 on select; further ties: lower candidate index',
  fidelity: 'B0 recomputed from the table must equal the real retriever result ids for every query, else the sweep is INVALID',
  floor: 'report only: percentiles of the gold memory semantic score (max over gold ids) and of the best non-gold semantic score per query',
} as const;

export const labelOf = (candidate: BlendCandidate): string =>
  candidate.kind === 'linear'
    ? `${candidate.id} wS${candidate.semanticWeight.toFixed(2).replace(/^0/u, '').replace(/0$/u, '')} wR${candidate.recencyWeight === 0 ? '0' : candidate.recencyWeight.toFixed(2).replace(/^0/u, '').replace(/0$/u, '')}`
    : `${candidate.id} rrf${candidate.k} ${candidate.signals.join('+')}`;

export interface BlendRow {
  readonly id: string;
  /** Hash of the normalized content, the retriever's content-dedup key. */
  readonly contentKey: string;
  readonly updatedAt: string;
  readonly lexical: number;
  readonly recency: number;
  /** Clamped to [0,1]; undefined when the scorer returned no (finite) score for this id. */
  readonly semantic: number | undefined;
}

export interface BlendQuery {
  readonly language: string;
  readonly gold: readonly string[];
  /** The ids the real retriever returned, in order. */
  readonly actual: readonly string[];
  readonly rows: readonly BlendRow[];
}

const KEYWORD_PATTERN = /[\p{L}\p{N}]+/gu;
const keywordsOf = (text: string): string[] => [...new Set(text.toLocaleLowerCase('und').match(KEYWORD_PATTERN) ?? [])];

/** The retriever's lexical score (semantic-relevance.ts scoreSemanticRelevance, not exported by Core): the share of query keywords the content holds. The fidelity check guards this copy. */
export function lexicalScoreOf(query: string, content: string): number {
  const queryKeywords = keywordsOf(query);
  if (queryKeywords.length === 0) return 0;
  const held = new Set(keywordsOf(content));
  if (held.size === 0) return 0;
  return queryKeywords.reduce((count, keyword) => count + (held.has(keyword) ? 1 : 0), 0) / queryKeywords.length;
}

/** The retriever's dedup key (memory-retriever.ts normalizedContentHash). */
export const contentKeyOf = (content: string): string => createHash('sha256').update(content.trim().replace(/\s+/g, ' ').toLocaleLowerCase('und'), 'utf8').digest('hex');

/** The retriever's recency score (memory-retriever.ts): exp(-ln2 * age / halfLife), age clamped at 0. */
export const recencyOf = (updatedAt: string, retrievalTime: string, halfLifeMs: number): number => Math.exp((-Math.LN2 * Math.max(0, Date.parse(retrievalTime) - Date.parse(updatedAt))) / halfLifeMs);

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** The retriever's tie-breaks after the primary score: updatedAt desc, then id. */
const tieBreak = (a: BlendRow, b: BlendRow): number => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/** 1-based rank per id of `rows` ordered by `value` desc (undefined values excluded), ties by updatedAt desc then id. */
function ranksBy(rows: readonly BlendRow[], value: (row: BlendRow) => number | undefined): Map<string, number> {
  const withValue = rows.filter((row) => value(row) !== undefined);
  withValue.sort((a, b) => (value(b) as number) - (value(a) as number) || tieBreak(a, b));
  return new Map(withValue.map((row, at) => [row.id, at + 1]));
}

/** Scores every row under `candidate` (higher is better). */
function scoresOf(rows: readonly BlendRow[], candidate: BlendCandidate): Map<string, number> {
  const out = new Map<string, number>();
  if (candidate.kind === 'linear') {
    const { semanticWeight: wS, recencyWeight: wR } = candidate;
    for (const row of rows) {
      const blended = row.semantic === undefined ? row.lexical : wS * row.semantic + (1 - wS) * row.lexical;
      out.set(row.id, blended * (1 - wR) + row.recency * wR);
    }
    return out;
  }
  const bySignal = candidate.signals.map((signal) => ranksBy(rows, signal === 'semantic' ? (row) => row.semantic : signal === 'lexical' ? (row) => row.lexical : (row) => row.recency));
  for (const row of rows) out.set(row.id, bySignal.reduce((sum, ranks) => (ranks.has(row.id) ? sum + 1 / (candidate.k + (ranks.get(row.id) as number)) : sum), 0));
  return out;
}

/** The top `limit` ids under `candidate`: the retriever's sort, content dedup and cut. */
export function rankIds(rows: readonly BlendRow[], candidate: BlendCandidate, limit: number): string[] {
  const scores = scoresOf(rows, candidate);
  const sorted = [...rows].sort((a, b) => (scores.get(b.id) as number) - (scores.get(a.id) as number) || tieBreak(a, b));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of sorted) {
    if (seen.has(row.contentKey)) continue;
    seen.add(row.contentKey);
    out.push(row.id);
    if (out.length >= limit) break;
  }
  return out;
}

export type Half = 'select' | 'confirm';

/** Pre-declared split: per language in set order, even position = select, odd = confirm. */
export function splitOf(languages: readonly string[]): Half[] {
  const seen = new Map<string, number>();
  return languages.map((language) => {
    const position = seen.get(language) ?? 0;
    seen.set(language, position + 1);
    return position % 2 === 0 ? 'select' : 'confirm';
  });
}

export interface LangMetrics { readonly n: number; readonly recallAt5: number; readonly mrrAt10: number }
export interface HalfMetrics { readonly overall: LangMetrics; readonly byLanguage: Readonly<Record<string, LangMetrics>> }

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

function metricsOf(ranks: readonly (number | null)[]): LangMetrics {
  const n = ranks.length;
  if (n === 0) return { n: 0, recallAt5: 0, mrrAt10: 0 };
  return { n, recallAt5: round4(ranks.filter((rank) => rank !== null && rank <= 5).length / n), mrrAt10: round4(ranks.reduce<number>((sum, rank) => sum + (rank === null || rank > 10 ? 0 : 1 / rank), 0) / n) };
}

function halfMetrics(languages: readonly string[], items: readonly { language: string; rank: number | null }[]): HalfMetrics {
  const byLanguage: Record<string, LangMetrics> = {};
  for (const language of languages) byLanguage[language] = metricsOf(items.filter((item) => item.language === language).map((item) => item.rank));
  return { overall: metricsOf(items.map((item) => item.rank)), byLanguage };
}

export interface CandidateResult { readonly id: string; readonly label: string; readonly select: HalfMetrics; readonly confirm: HalfMetrics; readonly all: HalfMetrics }

export interface Percentiles7 { readonly n: number; readonly min: number; readonly p05: number; readonly p25: number; readonly p50: number; readonly p75: number; readonly p95: number; readonly max: number }

export function percentiles7(values: readonly number[]): Percentiles7 | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => round4(sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] as number);
  return { n: sorted.length, min: round4(sorted[0] as number), p05: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), max: round4(sorted[sorted.length - 1] as number) };
}

export interface FloorCalibration {
  readonly goldSemantic: Percentiles7 | null;
  readonly bestNonGoldSemantic: Percentiles7 | null;
  /** Queries whose gold memories carry no semantic score (not in the table's scored set). */
  readonly goldUnscored: number;
}

export interface BlendSweep {
  readonly candidates: readonly { readonly id: string; readonly label: string }[];
  readonly split: Readonly<Record<Half, Readonly<Record<string, number>>>>;
  readonly fidelity: { readonly queries: number; readonly mismatches: number };
  /** Set when the sweep cannot be trusted (fidelity mismatch); the numbers are then informational only and nothing is selected. */
  readonly invalid: { readonly reason: string } | null;
  readonly results: readonly CandidateResult[];
  readonly selected: string | null;
  readonly confirmB0VsSelected: { readonly b0: HalfMetrics; readonly selected: HalfMetrics } | null;
  readonly floor: FloorCalibration;
}

export const RECALL_K = 5;
export const RANK_LIMIT = 10;

/** Index of the gold's first hit in `ids`, 1-based, or null. */
const rankOf = (ids: readonly string[], gold: readonly string[]): number | null => {
  const at = ids.findIndex((id) => gold.includes(id));
  return at < 0 ? null : at + 1;
};

/** The pre-declared selection rule on the select half. */
export function selectCandidate(results: readonly CandidateResult[], languages: readonly string[]): string | null {
  let best: { at: number; floor: number; mrr: number } | null = null;
  results.forEach((result, at) => {
    const floor = Math.min(...languages.map((language) => result.select.byLanguage[language]?.recallAt5 ?? 0));
    const mrr = result.select.overall.mrrAt10;
    if (best === null || floor > best.floor || (floor === best.floor && mrr > best.mrr)) best = { at, floor, mrr };
  });
  return best === null ? null : (results[(best as { at: number }).at] as CandidateResult).id;
}

export function buildBlendSweep(queries: readonly BlendQuery[], languages: readonly string[], candidates: readonly BlendCandidate[] = BLEND_CANDIDATES, limit: number = RANK_LIMIT): BlendSweep {
  const halves = splitOf(queries.map((query) => query.language));
  const split: Record<Half, Record<string, number>> = { select: {}, confirm: {} };
  for (const language of languages) {
    split.select[language] = queries.filter((query, at) => query.language === language && halves[at] === 'select').length;
    split.confirm[language] = queries.filter((query, at) => query.language === language && halves[at] === 'confirm').length;
  }
  const current = candidates[0] as BlendCandidate;
  const mismatches = queries.filter((query) => {
    const offline = rankIds(query.rows, current, limit);
    return offline.length !== query.actual.length || offline.some((id, at) => id !== query.actual[at]);
  }).length;
  const results: CandidateResult[] = candidates.map((candidate) => {
    const items = queries.map((query, at) => ({ language: query.language, half: halves[at] as Half, rank: rankOf(rankIds(query.rows, candidate, limit), query.gold) }));
    return {
      id: candidate.id,
      label: labelOf(candidate),
      select: halfMetrics(languages, items.filter((item) => item.half === 'select')),
      confirm: halfMetrics(languages, items.filter((item) => item.half === 'confirm')),
      all: halfMetrics(languages, items),
    };
  });
  const invalid = mismatches > 0 ? { reason: `fidelity: the offline current formula (${current.id}) disagrees with the real retriever on ${mismatches} of ${queries.length} queries` } : null;
  const selected = invalid === null ? selectCandidate(results, languages) : null;
  const b0 = results[0] as CandidateResult;
  const chosen = results.find((result) => result.id === selected);
  const goldScores: number[] = [];
  const otherScores: number[] = [];
  let goldUnscored = 0;
  for (const query of queries) {
    const gold = query.rows.filter((row) => query.gold.includes(row.id) && row.semantic !== undefined).map((row) => row.semantic as number);
    if (gold.length === 0) goldUnscored += 1;
    else goldScores.push(Math.max(...gold));
    const others = query.rows.filter((row) => !query.gold.includes(row.id) && row.semantic !== undefined).map((row) => row.semantic as number);
    if (others.length > 0) otherScores.push(Math.max(...others));
  }
  return {
    candidates: candidates.map((candidate) => ({ id: candidate.id, label: labelOf(candidate) })),
    split,
    fidelity: { queries: queries.length, mismatches },
    invalid,
    results,
    selected,
    confirmB0VsSelected: chosen === undefined ? null : { b0: b0.confirm, selected: chosen.confirm },
    floor: { goldSemantic: percentiles7(goldScores), bestNonGoldSemantic: percentiles7(otherScores), goldUnscored },
  };
}

const f3 = (value: number): string => value.toFixed(3);
const langLine = (half: HalfMetrics, languages: readonly string[]): string => languages.map((language) => `${language} ${f3(half.byLanguage[language]?.recallAt5 ?? 0)}`).join(' ');
const pctLine = (p: Percentiles7 | null): string => (p === null ? '-' : `n${p.n} min ${f3(p.min)} p05 ${f3(p.p05)} p25 ${f3(p.p25)} p50 ${f3(p.p50)} p75 ${f3(p.p75)} p95 ${f3(p.p95)} max ${f3(p.max)}`);

export function blendSweepLines(sweep: BlendSweep, languages: readonly string[]): string[] {
  const out: string[] = [];
  out.push(`  blend sweep (Recall@5 per language; select half | confirm half | MRR@10 select/confirm)${sweep.invalid === null ? '' : ` - INVALID: ${sweep.invalid.reason}`}`);
  for (const result of sweep.results) {
    out.push(`  ${result.label}: select ${langLine(result.select, languages)} | confirm ${langLine(result.confirm, languages)} | MRR ${f3(result.select.overall.mrrAt10)}/${f3(result.confirm.overall.mrrAt10)}${result.id === sweep.selected ? ' <- selected' : ''}`);
  }
  out.push(`  selected ${sweep.selected ?? 'none'}; fidelity ${sweep.fidelity.mismatches} mismatches in ${sweep.fidelity.queries} queries`);
  if (sweep.confirmB0VsSelected !== null) {
    const { b0, selected } = sweep.confirmB0VsSelected;
    out.push(`  confirm half B0 vs ${sweep.selected}: B0 ${langLine(b0, languages)} (all ${f3(b0.overall.recallAt5)}, MRR ${f3(b0.overall.mrrAt10)}) | ${sweep.selected} ${langLine(selected, languages)} (all ${f3(selected.overall.recallAt5)}, MRR ${f3(selected.overall.mrrAt10)})`);
  }
  out.push(`  floor calibration: gold semantic ${pctLine(sweep.floor.goldSemantic)} (gold unscored ${sweep.floor.goldUnscored})`);
  out.push(`  floor calibration: best non-gold semantic ${pctLine(sweep.floor.bestNonGoldSemantic)}`);
  return out;
}
