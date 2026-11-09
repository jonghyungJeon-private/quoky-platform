/**
 * ADR-0124 phase 2 P2-5 (A): the OFFLINE lexical variant comparison of stage R. Pure module (no model, no I/O).
 *
 * The production memory lexical score is whole-word overlap (`scoreSemanticRelevance`), which fails for Korean because particles attach
 * to nouns. Core already has a Korean-aware BM25 (`Bm25Index`, `lexicalTerms`: Hangul/Han/Kana character bigrams, Latin words). This module
 * re-ranks the observed candidate table of each query under the PRODUCTION weights (the frozen linear candidate equal to the runtime
 * weights) with the lexical signal replaced:
 *   - `L-word` : the current lexical score (production; fidelity is checked on this one by the blend sweep / validation).
 *   - `L-bm25` : Core BM25 (Core default k1 / b) built over THAT query's candidate rows' memory texts, normalized to [0,1] by dividing by the
 *                maximum BM25 in the pool (0 when the maximum is 0).
 * The verdict is pre-declared (below) and advisory; nothing here changes production.
 */
import { chunking } from '@quoky/core';
import { BLEND_CANDIDATES, productionCandidateOf, rankIds, type BlendQuery, type BlendRow, type ProductionBlend } from './blend-sweep';

export interface Metrics5 { readonly n: number; readonly recallAt5: number; readonly mrrAt10: number }
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
/** Recall@5 and MRR@10 of a rank list (null = a miss); same definition as the sweep and the validation (kept local so the CH7 module set stays free of CH8 files). */
function metrics5(ranks: readonly (number | null)[]): Metrics5 {
  const n = ranks.length;
  if (n === 0) return { n: 0, recallAt5: 0, mrrAt10: 0 };
  return { n, recallAt5: round4(ranks.filter((rank) => rank !== null && rank <= 5).length / n), mrrAt10: round4(ranks.reduce<number>((sum, rank) => sum + (rank === null || rank > 10 ? 0 : 1 / rank), 0) / n) };
}

export const LEXICAL_VARIANT_IDS = ['L-word', 'L-bm25'] as const;
export type LexicalVariantId = (typeof LEXICAL_VARIANT_IDS)[number];

export const LEXICAL_VERDICT_RULE = {
  ch8: 'on CH8: overall Recall@5 >= L-word AND ko Recall@5 >= L-word AND overall MRR@10 >= L-word - 0.005',
  ch7: 'on CH7: overall Recall@5 >= L-word - 0.01',
  text: 'adopt L-bm25 iff on CH8 (overall Recall@5 >= L-word, ko Recall@5 >= L-word, MRR@10 >= L-word - 0.005) AND on CH7 (overall Recall@5 >= L-word - 0.01); else keep L-word',
  normalization: 'BM25 (Core Bm25Index, Core default k1 and b) built over the query candidate rows memory texts; score divided by the max BM25 of the pool (0 when the max is 0)',
  weights: 'the frozen linear candidate equal to RUNTIME_CONSTANTS (production); only the lexical signal differs',
  fidelity: 'stays on L-word (production)',
  mrrMargin: 0.005,
  ch7RecallMargin: 0.01,
} as const;

/** One BM25 score per text for `query`, divided by the maximum of the pool (0 for all when the maximum is 0). */
export function bm25NormalizedScores(query: string, texts: readonly string[]): number[] {
  if (texts.length === 0) return [];
  const raw = new chunking.Bm25Index(texts).scores(query);
  const max = Math.max(...raw);
  return raw.map((score) => (max > 0 ? score / max : 0));
}

/** The rows with `lexical` replaced by the normalized BM25 of the row's `text` for `queryText` (a row without text counts as empty text). */
export function withBm25Lexical(rows: readonly BlendRow[], queryText: string): BlendRow[] {
  const scores = bm25NormalizedScores(queryText, rows.map((row) => row.text ?? ''));
  return rows.map((row, at) => ({ ...row, lexical: scores[at] as number }));
}

export interface LexicalQuery extends BlendQuery {
  readonly category?: string;
}

export interface LexicalVariantResult {
  readonly id: LexicalVariantId;
  readonly overall: Metrics5;
  readonly byLanguage: Readonly<Record<string, Metrics5>>;
  readonly byCategory: Readonly<Record<string, Metrics5>>;
}

export interface LexicalComparison {
  readonly variants: readonly LexicalVariantResult[];
  /** The frozen candidate equal to the production weights; null (and `invalid` set) when none matches. */
  readonly productionCandidate: string | null;
  readonly invalid: { readonly reason: string } | null;
}

const rankOf = (ids: readonly string[], gold: readonly string[]): number | null => {
  const at = ids.findIndex((id) => gold.includes(id));
  return at < 0 ? null : at + 1;
};

export function buildLexicalComparison(queries: readonly LexicalQuery[], languages: readonly string[], categories: readonly string[], production: ProductionBlend, limit = 10): LexicalComparison {
  const candidate = productionCandidateOf(BLEND_CANDIDATES, production);
  if (candidate === undefined) return { variants: [], productionCandidate: null, invalid: { reason: `no frozen linear candidate equals the production weights (semantic ${production.semanticWeight}, recency ${production.recencyWeight})` } };
  const missingText = queries.some((query) => query.queryText === undefined || query.rows.some((row) => row.text === undefined));
  const variants = LEXICAL_VARIANT_IDS.map((id): LexicalVariantResult => {
    const items = queries.map((query) => {
      const rows = id === 'L-word' ? query.rows : withBm25Lexical(query.rows, query.queryText ?? '');
      return { query, rank: rankOf(rankIds(rows, candidate, limit), query.gold) };
    });
    const byLanguage: Record<string, Metrics5> = {};
    for (const language of languages) byLanguage[language] = metrics5(items.filter((item) => item.query.language === language).map((item) => item.rank));
    const byCategory: Record<string, Metrics5> = {};
    for (const category of categories) byCategory[category] = metrics5(items.filter((item) => item.query.category === category).map((item) => item.rank));
    return { id, overall: metrics5(items.map((item) => item.rank)), byLanguage, byCategory };
  });
  return { variants, productionCandidate: candidate.id, invalid: missingText ? { reason: 'candidate rows lack the memory text or the query text needed for BM25' } : null };
}

const EPS = 1e-9;
const variantOf = (comparison: LexicalComparison, id: LexicalVariantId): LexicalVariantResult | undefined => comparison.variants.find((variant) => variant.id === id);

export interface LexicalCheck { readonly name: string; readonly pass: boolean; readonly word: number; readonly bm25: number }
export interface LexicalSetVerdict { readonly set: 'ch7' | 'ch8'; readonly pass: boolean | null; readonly checks: readonly LexicalCheck[] }

/** The pre-declared checks of one set; `pass` is null when the comparison is invalid or empty. */
export function lexicalSetVerdict(set: 'ch7' | 'ch8', comparison: LexicalComparison): LexicalSetVerdict {
  const word = variantOf(comparison, 'L-word');
  const bm25 = variantOf(comparison, 'L-bm25');
  if (comparison.invalid !== null || word === undefined || bm25 === undefined) return { set, pass: null, checks: [] };
  const checks: LexicalCheck[] = [];
  if (set === 'ch8') {
    checks.push({ name: 'overall Recall@5 >= L-word', pass: bm25.overall.recallAt5 >= word.overall.recallAt5 - EPS, word: word.overall.recallAt5, bm25: bm25.overall.recallAt5 });
    checks.push({ name: 'ko Recall@5 >= L-word', pass: (bm25.byLanguage.ko?.recallAt5 ?? 0) >= (word.byLanguage.ko?.recallAt5 ?? 0) - EPS, word: word.byLanguage.ko?.recallAt5 ?? 0, bm25: bm25.byLanguage.ko?.recallAt5 ?? 0 });
    checks.push({ name: `MRR@10 >= L-word - ${LEXICAL_VERDICT_RULE.mrrMargin}`, pass: bm25.overall.mrrAt10 >= word.overall.mrrAt10 - LEXICAL_VERDICT_RULE.mrrMargin - EPS, word: word.overall.mrrAt10, bm25: bm25.overall.mrrAt10 });
  } else {
    checks.push({ name: `overall Recall@5 >= L-word - ${LEXICAL_VERDICT_RULE.ch7RecallMargin}`, pass: bm25.overall.recallAt5 >= word.overall.recallAt5 - LEXICAL_VERDICT_RULE.ch7RecallMargin - EPS, word: word.overall.recallAt5, bm25: bm25.overall.recallAt5 });
  }
  return { set, pass: checks.every((check) => check.pass), checks };
}

export type LexicalVerdict = 'adopt L-bm25' | 'keep L-word' | 'pending (needs both the CH7 and the CH8 run)';

/** The combined pre-declared verdict: adopt only when both sets pass; keep as soon as one fails; pending while one is unknown. */
export function lexicalVerdict(ch7: boolean | null, ch8: boolean | null): LexicalVerdict {
  if (ch7 === false || ch8 === false) return 'keep L-word';
  if (ch7 === true && ch8 === true) return 'adopt L-bm25';
  return 'pending (needs both the CH7 and the CH8 run)';
}

const f3 = (value: number): string => value.toFixed(3);
const cell = (m: Metrics5 | undefined): string => (m === undefined ? '-' : `${f3(m.recallAt5)}/${f3(m.mrrAt10)}`);

export function lexicalComparisonLines(set: 'ch7' | 'ch8', comparison: LexicalComparison, languages: readonly string[], categories: readonly string[]): string[] {
  const out = [`  lexical variants under the production weights (${comparison.productionCandidate ?? 'none'}; Recall@5/MRR@10; offline, NON-GATING)${comparison.invalid === null ? '' : ` - INVALID: ${comparison.invalid.reason}`}`];
  for (const variant of comparison.variants) {
    out.push(`  ${variant.id}${variant.id === 'L-word' ? ' (production)' : ''}: all ${cell(variant.overall)} | ${languages.map((language) => `${language} ${cell(variant.byLanguage[language])}`).join(' ')}${categories.length === 0 ? '' : ` | ${categories.map((category) => `${category} ${cell(variant.byCategory[category])}`).join(' ')}`}`);
  }
  const verdict = lexicalSetVerdict(set, comparison);
  out.push(`  ${set.toUpperCase()} lexical conditions: ${verdict.pass === null ? 'n/a' : verdict.pass ? 'PASS' : 'FAIL'}${verdict.checks.map((check) => ` [${check.pass ? 'ok' : 'FAIL'} ${check.name}: L-word ${f3(check.word)} vs L-bm25 ${f3(check.bm25)}]`).join('')}`);
  out.push(`  lexical verdict (pre-declared, advisory; the combined verdict needs the CH7 and the CH8 run): ${set === 'ch7' ? `CH7 part ${verdict.pass === null ? 'n/a' : verdict.pass ? 'pass' : 'fail'}` : `CH8 part ${verdict.pass === null ? 'n/a' : verdict.pass ? 'pass' : 'fail'}`}; [${LEXICAL_VERDICT_RULE.text}]`);
  return out;
}
