/**
 * ADR-0124 phase 2 P2-3 validation on the CH8 set: a pre-declared VALIDATION of three frozen blend candidates, not a selection.
 * Pure module (no model, no I/O). Same inputs as the sweep (the candidate table the REAL retriever observed, per query) plus the
 * CH8 tags (`category`, `staleId`). Candidates are fixed to B0 (previous production 0.25), B1 and B2 from the frozen `BLEND_CANDIDATES`; there is
 * no select/confirm split and nothing is selected. The frozen linear candidate equal to the production weights (B1 since P2-4), recomputed offline, must equal the real retriever's ids (fidelity); INVALID when none matches or any query differs.
 *
 * Extra metric `newer-first` (recency-wins queries only): the share of those queries where the gold (the newer memory) ranks above its
 * `staleId` in the candidate's top 10. A stale memory absent from the top 10 while the gold is present counts as newer-first; a gold
 * absent from the top 10 counts as not newer-first.
 */
import { BLEND_CANDIDATES, labelOf, noProductionCandidateReason, percentiles7, productionCandidateOf, rankIds, type BlendCandidate, type ProductionBlend, type BlendQuery, type FloorCalibration } from './blend-sweep';

export const VALIDATION_CANDIDATE_IDS = ['B0', 'B1', 'B2'] as const;
export type ValidationCandidateId = (typeof VALIDATION_CANDIDATE_IDS)[number];

export const validationCandidates = (): BlendCandidate[] => VALIDATION_CANDIDATE_IDS.map((id) => BLEND_CANDIDATES.find((candidate) => candidate.id === id) as BlendCandidate);

/** Pre-declared, in the plan digest. The verdict is advisory (the run stays NON-GATING). */
export const VERDICT_RULE = {
  b2Confirmed: { overallRecallAt5: 0.95, koRecallAt5: 0.9, newerFirstMargin: 0.1 },
  b1Recommended: { overallRecallAt5: 0.93, koRecallAt5: 0.85 },
  text: 'B2 confirmed if B2 overall Recall@5 >= 0.95 AND B2 ko Recall@5 >= 0.90 AND B2 newer-first >= B1 newer-first - 0.10; else B1 recommended if B1 overall Recall@5 >= 0.93 AND B1 ko Recall@5 >= 0.85; else no change recommended',
  kind: 'validation, not selection: candidates fixed to B0, B1, B2; no select/confirm split; nothing is selected',
} as const;

export type Verdict = 'B2 confirmed' | 'B1 recommended' | 'no change recommended';

export interface ValidationQuery extends BlendQuery {
  readonly category: string;
  readonly staleId: string | null;
}

export interface Metrics5 { readonly n: number; readonly recallAt5: number; readonly mrrAt10: number }
export interface NewerFirst { readonly n: number; readonly newerFirst: number; readonly rate: number }
export interface CandidateValidation {
  readonly id: string;
  readonly label: string;
  readonly overall: Metrics5;
  readonly byLanguage: Readonly<Record<string, Metrics5>>;
  readonly byCategory: Readonly<Record<string, Metrics5>>;
  readonly newerFirst: NewerFirst;
}

export interface BlendValidation {
  readonly kind: 'validation';
  readonly fidelity: { readonly queries: number; readonly mismatches: number };
  readonly tableSize: { readonly min: number; readonly max: number };
  readonly invalid: { readonly reason: string } | null;
  readonly results: readonly CandidateValidation[];
  readonly floor: FloorCalibration;
  /** null when the validation is INVALID (fidelity mismatch). */
  readonly verdict: Verdict | null;
}

export const RECALL_AT = 5;
export const RANK_AT = 10;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const rankOf = (ids: readonly string[], gold: readonly string[]): number | null => {
  const at = ids.findIndex((id) => gold.includes(id));
  return at < 0 ? null : at + 1;
};

export function metrics5(ranks: readonly (number | null)[]): Metrics5 {
  const n = ranks.length;
  if (n === 0) return { n: 0, recallAt5: 0, mrrAt10: 0 };
  return {
    n,
    recallAt5: round4(ranks.filter((rank) => rank !== null && rank <= RECALL_AT).length / n),
    mrrAt10: round4(ranks.reduce<number>((sum, rank) => sum + (rank === null || rank > RANK_AT ? 0 : 1 / rank), 0) / n),
  };
}

/** True when the gold ranks above the stale memory in `top`; stale absent with the gold present is newer-first; gold absent is not. */
export function isNewerFirst(top: readonly string[], gold: readonly string[], staleId: string): boolean {
  const goldAt = top.findIndex((id) => gold.includes(id));
  if (goldAt < 0) return false;
  const staleAt = top.indexOf(staleId);
  return staleAt < 0 || goldAt < staleAt;
}

/** The pre-declared verdict rule over the validated candidates (B1 and B2 results; `ko` is the Korean language key). */
export function verdictOf(results: readonly CandidateValidation[]): Verdict {
  const b1 = results.find((result) => result.id === 'B1');
  const b2 = results.find((result) => result.id === 'B2');
  const eps = 1e-9;
  if (b2 !== undefined && b1 !== undefined) {
    const rule = VERDICT_RULE.b2Confirmed;
    if (b2.overall.recallAt5 >= rule.overallRecallAt5 - eps && (b2.byLanguage.ko?.recallAt5 ?? 0) >= rule.koRecallAt5 - eps && b2.newerFirst.rate >= b1.newerFirst.rate - rule.newerFirstMargin - eps) return 'B2 confirmed';
  }
  if (b1 !== undefined && b1.overall.recallAt5 >= VERDICT_RULE.b1Recommended.overallRecallAt5 - eps && (b1.byLanguage.ko?.recallAt5 ?? 0) >= VERDICT_RULE.b1Recommended.koRecallAt5 - eps) return 'B1 recommended';
  return 'no change recommended';
}

export function buildBlendValidation(queries: readonly ValidationQuery[], languages: readonly string[], categories: readonly string[], production: ProductionBlend, limit: number = RANK_AT): BlendValidation {
  const candidates = validationCandidates();
  const current = productionCandidateOf(BLEND_CANDIDATES, production);
  let mismatches = 0;
  for (const query of queries) {
    if (current === undefined) break;
    const offline = rankIds(query.rows, current, limit);
    if (!(offline.length === query.actual.length && offline.every((id, at) => id === query.actual[at]))) mismatches += 1;
  }
  const results: CandidateValidation[] = candidates.map((candidate) => {
    const tops = queries.map((query) => rankIds(query.rows, candidate, limit));
    const items = queries.map((query, at) => ({ query, rank: rankOf(tops[at] as string[], query.gold) }));
    const byLanguage: Record<string, Metrics5> = {};
    for (const language of languages) byLanguage[language] = metrics5(items.filter((item) => item.query.language === language).map((item) => item.rank));
    const byCategory: Record<string, Metrics5> = {};
    for (const category of categories) byCategory[category] = metrics5(items.filter((item) => item.query.category === category).map((item) => item.rank));
    const recency = queries.map((query, at) => ({ query, top: tops[at] as string[] })).filter((entry) => entry.query.staleId !== null);
    const newer = recency.filter((entry) => isNewerFirst(entry.top, entry.query.gold, entry.query.staleId as string)).length;
    return {
      id: candidate.id,
      label: labelOf(candidate, production),
      overall: metrics5(items.map((item) => item.rank)),
      byLanguage,
      byCategory,
      newerFirst: { n: recency.length, newerFirst: newer, rate: recency.length === 0 ? 0 : round4(newer / recency.length) },
    };
  });
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
  const invalid = current === undefined ? { reason: noProductionCandidateReason(production) } : mismatches > 0 ? { reason: `fidelity: the offline production formula (${current.id}) disagrees with the real retriever on ${mismatches} of ${queries.length} queries` } : null;
  return {
    kind: 'validation',
    fidelity: { queries: queries.length, mismatches },
    tableSize: { min: queries.length === 0 ? 0 : Math.min(...queries.map((query) => query.rows.length)), max: queries.length === 0 ? 0 : Math.max(...queries.map((query) => query.rows.length)) },
    invalid,
    results,
    floor: { goldSemantic: percentiles7(goldScores), bestNonGoldSemantic: percentiles7(otherScores), goldUnscored },
    verdict: invalid === null ? verdictOf(results) : null,
  };
}

const f3 = (value: number): string => value.toFixed(3);
const pctLine = (p: FloorCalibration['goldSemantic']): string => (p === null ? '-' : `n${p.n} min ${f3(p.min)} p05 ${f3(p.p05)} p25 ${f3(p.p25)} p50 ${f3(p.p50)} p75 ${f3(p.p75)} p95 ${f3(p.p95)} max ${f3(p.max)}`);
const cell = (m: Metrics5 | undefined): string => (m === undefined ? '-' : `${f3(m.recallAt5)}/${f3(m.mrrAt10)}`);

export function blendValidationLines(validation: BlendValidation, languages: readonly string[], categories: readonly string[]): string[] {
  const out: string[] = [];
  out.push(`  validation of B0/B1/B2 (pre-declared, not a selection; Recall@5/MRR@10)${validation.invalid === null ? '' : ` - INVALID: ${validation.invalid.reason}`}`);
  for (const result of validation.results) {
    out.push(`  ${result.label}: all ${cell(result.overall)} | ${languages.map((language) => `${language} ${cell(result.byLanguage[language])}`).join(' ')} | ${categories.map((category) => `${category} ${cell(result.byCategory[category])}`).join(' ')} | newer-first ${f3(result.newerFirst.rate)} (${result.newerFirst.newerFirst}/${result.newerFirst.n})`);
  }
  out.push(`  fidelity ${validation.fidelity.mismatches} mismatches in ${validation.fidelity.queries} queries`);
  out.push(`  verdict (advisory, pre-declared): ${validation.verdict ?? 'none (INVALID)'}  [${VERDICT_RULE.text}]`);
  out.push(`  floor calibration: gold semantic ${pctLine(validation.floor.goldSemantic)} (gold unscored ${validation.floor.goldUnscored})`);
  out.push(`  floor calibration: best non-gold semantic ${pctLine(validation.floor.bestNonGoldSemantic)}`);
  return out;
}
