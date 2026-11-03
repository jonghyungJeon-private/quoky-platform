/**
 * CH1 arms for slice C2 (Phase 0: no model of any kind). Both arms answer the same question: does the ONE window the
 * arm would send contain the needle? Each case's window is bounded by today's readout bound (3,000 code points).
 *
 *   baseline  today's production read path, called as it is: `buildUntrustedDocumentReadout` (head 40% / tail 60% clip
 *             of the body, or the per-sheet fair clip for a workbook). Not a copy.
 *   EL        the ADR-0124 lexical arm: C1 `chunk` -> `Bm25Index` (Hangul bigram / Latin word) over passage text ->
 *             passages in score order, only those with a positive score, greedily added while `packWindows` still
 *             yields ONE window of the default window budget (3,000 code points and 1,800 estimated tokens).
 *             No parameter was tuned on the corpus: BM25 k1 and b, the passage sizes and the window budget are Core's.
 *
 * E0-E3 and EH are not run in this slice.
 */
import { buildUntrustedDocumentReadout, chunking, type UntrustedDocumentSource } from '@quoky/core';
import { firstRelevantRank } from './metrics';
import type { ChunkEvalCase, Shape } from './corpus';

export const NOT_RUN_ARMS = ['E0', 'E1', 'E2', 'E3', 'EH'] as const;

const SOURCE: Readonly<Record<Shape, UntrustedDocumentSource>> = {
  mail: 'mail',
  thread: 'mail-thread',
  'drive-doc': 'drive',
  workbook: 'drive',
  'jira-issue': 'jira-issue',
  'slack-thread': 'slack-thread',
  'adr-file': 'drive',
};

export interface ArmWindow {
  readonly text: string;
  /** False when the arm sent nothing (a refusal, or no passage scored). */
  readonly sent: boolean;
  readonly refused: boolean;
}

/** The body today's path receives: the item's parts with their frames (a workbook goes by sections instead). */
function baselineBody(item: ChunkEvalCase): string {
  return item.parts.map((part) => (part.frame === '' ? part.body : `${part.frame}\n${part.body}`)).join('\n\n');
}

export function baselineWindow(item: ChunkEvalCase): ArmWindow {
  const result = buildUntrustedDocumentReadout({
    source: SOURCE[item.shape],
    title: `${item.shape} ${item.id}`,
    author: 'synthetic',
    date: '2027-01-01T00:00:00Z',
    body: item.shape === 'workbook' ? '' : baselineBody(item),
    ...(item.shape === 'workbook' ? { sections: item.parts.map((part) => ({ title: part.title, body: part.body })) } : {}),
  });
  return result.ok ? { text: result.readout.body, sent: true, refused: false } : { text: '', sent: false, refused: true };
}

export interface LexicalOutcome {
  readonly window: ArmWindow;
  /** Every passage ordinal, best first (ties in document order). */
  readonly ranking: readonly number[];
  readonly relevant: ReadonlySet<number>;
  readonly passageCount: number;
}

/** The passages that overlap the needle's code-point range. */
export function relevantPassages(passages: readonly chunking.Passage[], start: number, end: number): Set<number> {
  const out = new Set<number>();
  for (const passage of passages) if (passage.span.start < end && passage.span.end > start) out.add(passage.ordinal);
  return out;
}

export function lexicalWindow(item: ChunkEvalCase): LexicalOutcome {
  const passages = chunking.chunk(item.prepared, item.sections);
  const index = new chunking.CodePointIndex(item.prepared);
  const texts = passages.map((passage) => index.slice(passage.span.start, passage.span.end));
  const bm25 = new chunking.Bm25Index(texts);
  const scores = bm25.scores(item.question);
  const ranking = bm25.rank(item.question);
  const relevant = relevantPassages(passages, item.needle.start, item.needle.end);
  const chosen: number[] = [];
  let misses = 0;
  for (const ordinal of ranking) {
    if ((scores[ordinal] ?? 0) <= 0) break;
    const trial = [...chosen, ordinal];
    if (chunking.packWindows(item.prepared, passages, trial).length === 1) chosen.push(ordinal);
    else if ((misses += 1) >= 8) break;
  }
  const windows = chosen.length === 0 ? [] : chunking.packWindows(item.prepared, passages, chosen);
  const only = windows.length === 1 ? (windows[0] as chunking.Window) : undefined;
  return {
    window: only === undefined ? { text: '', sent: false, refused: false } : { text: only.text, sent: true, refused: false },
    ranking,
    relevant,
    passageCount: passages.length,
  };
}

export const windowHasNeedle = (window: ArmWindow, item: ChunkEvalCase): boolean => window.sent && window.text.includes(item.needle.text);

export const lexicalRank = (outcome: LexicalOutcome): number | null => firstRelevantRank(outcome.ranking, outcome.relevant);
