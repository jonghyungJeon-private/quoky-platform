/**
 * ADR-0124 chunking — a pure Core sub-barrel (not yet exported from the application barrel; no handler uses it).
 * It keeps nothing after a call: no port, no store, no log.
 */
export { chunk, joinSections } from './passages';
export {
  OVERLAP_MAX_CODE_POINTS,
  OVERLAP_MAX_FRACTION,
  PASSAGE_MAX_CODE_POINTS,
  PASSAGE_MAX_TOKENS,
  PASSAGE_TARGET_CODE_POINTS,
  TABLE_HEADER_REPEAT_MAX_CODE_POINTS,
} from './passages';
export { DEFAULT_WINDOW_BUDGET, WINDOW_GAP_MARKER, packWindows, selectStratified, singleWindow } from './pack';
export { windowReadout } from './readout';
export { computeCoverage, passageAuditView, renderCoverageLine } from './coverage';
export type { Coverage } from './coverage';
export { Bm25Index, lexicalTerms } from './lexical';
export { DEFAULT_TOKEN_WEIGHTS, estimateTokenWeight, estimateTokens } from './token-estimate';
export type { TokenWeights } from './token-estimate';
export { CodePointIndex, codePointLength } from './code-points';
export type { ChunkSection, Passage, PassageKind, PassageRows, Span, Window, WindowBudget } from './types';
