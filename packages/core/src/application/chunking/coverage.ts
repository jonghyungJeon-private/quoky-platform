import type { Passage } from './types';

/**
 * ADR-0124 N5: every reply states its coverage. Core renders the line from counts, after the model output; the model
 * never writes it. Only integers are used, never a heading or a passage.
 */
export interface Coverage {
  readonly total: number;
  readonly read: number;
  readonly complete: boolean;
  readonly codePointsTotal: number;
  readonly codePointsRead: number;
}

export function computeCoverage(passages: readonly Passage[], readOrdinals: readonly number[]): Coverage {
  const read = new Set(readOrdinals);
  let codePointsTotal = 0;
  let codePointsRead = 0;
  let count = 0;
  for (const passage of passages) {
    const size = passage.span.end - passage.span.start;
    codePointsTotal += size;
    if (read.has(passage.ordinal)) {
      codePointsRead += size;
      count += 1;
    }
  }
  return { total: passages.length, read: count, complete: count === passages.length, codePointsTotal, codePointsRead };
}

/** The fixed coverage line (counts only). Ordinals are 0-based internally; the line speaks of counts, not positions. */
export function renderCoverageLine(coverage: Coverage, language: 'ko' | 'en'): string {
  if (language === 'en') {
    return coverage.complete
      ? `I read all ${coverage.total} parts before answering.`
      : `I read ${coverage.read} of ${coverage.total} parts before answering.`;
  }
  return coverage.complete
    ? `전체 ${coverage.total}개 구간을 모두 읽고 답했어요`
    : `전체 ${coverage.total}개 구간 중 ${coverage.read}개를 읽고 답했어요`;
}

/** What may reach a log or an audit record for one passage: counts and the position, no text, no frame, no heading. */
export function passageAuditView(passage: Passage): { readonly ordinal: number; readonly total: number; readonly kind: string; readonly estTokens: number; readonly codePoints: number } {
  return {
    ordinal: passage.ordinal,
    total: passage.total,
    kind: passage.kind,
    estTokens: passage.estTokens,
    codePoints: passage.span.end - passage.span.start,
  };
}
