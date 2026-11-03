/**
 * ADR-0124 section 3.1 and 3.6: a lexical ranker with no dependency. Korean has no word boundary a plain split can use
 * (particles attach to nouns), so runs of Hangul, Han and Kana become character bigrams; Latin words and digits become
 * lowercase words. There is no stop-word list and no phrase list: BM25's inverse document frequency does that work.
 *
 * This is a pure scoring function over passages the caller already holds in memory. It is not wired into any
 * selection yet; selection slices carry the Chief Architect invariants (ADR-0124 section 10, RQ-2).
 */
const CJK_RUN = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_CHAR = /[\p{Script=Latin}\p{N}]/u;

/** The terms of a text, in order, with repeats. */
export function lexicalTerms(text: string): string[] {
  const terms: string[] = [];
  let cjk: string[] = [];
  let word = '';
  const closeCjk = (): void => {
    if (cjk.length === 1) terms.push(cjk[0] as string);
    for (let at = 0; at + 1 < cjk.length; at += 1) terms.push(`${cjk[at]}${cjk[at + 1]}`);
    cjk = [];
  };
  const closeWord = (): void => {
    if (word.length > 0) terms.push(word.toLowerCase());
    word = '';
  };
  for (const point of text.normalize('NFKC')) {
    if (CJK_RUN.test(point)) {
      closeWord();
      cjk.push(point);
    } else if (WORD_CHAR.test(point)) {
      closeCjk();
      word += point;
    } else {
      closeCjk();
      closeWord();
    }
  }
  closeCjk();
  closeWord();
  return terms;
}

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** BM25 over a fixed list of passage texts. */
export class Bm25Index {
  private readonly frequencies: ReadonlyArray<ReadonlyMap<string, number>>;
  private readonly lengths: readonly number[];
  private readonly documentFrequency: ReadonlyMap<string, number>;
  private readonly averageLength: number;

  constructor(documents: readonly string[]) {
    const frequencies: Map<string, number>[] = [];
    const documentFrequency = new Map<string, number>();
    const lengths: number[] = [];
    for (const document of documents) {
      const terms = lexicalTerms(document);
      const counts = new Map<string, number>();
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      frequencies.push(counts);
      lengths.push(terms.length);
    }
    this.frequencies = frequencies;
    this.lengths = lengths;
    this.documentFrequency = documentFrequency;
    this.averageLength = lengths.length === 0 ? 0 : lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  }

  /** One score per document; 0 when the query shares no term. */
  scores(query: string): number[] {
    const terms = [...new Set(lexicalTerms(query))];
    const count = this.frequencies.length;
    return this.frequencies.map((counts, at) => {
      let score = 0;
      for (const term of terms) {
        const frequency = counts.get(term) ?? 0;
        if (frequency === 0) continue;
        const containing = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (count - containing + 0.5) / (containing + 0.5));
        const length = this.lengths[at] ?? 0;
        const norm = this.averageLength === 0 ? 1 : 1 - BM25_B + (BM25_B * length) / this.averageLength;
        score += (idf * frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * norm);
      }
      return score;
    });
  }

  /** Document indexes by descending score; ties by index (document order). */
  rank(query: string): number[] {
    const scores = this.scores(query);
    return scores.map((_, at) => at).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
  }
}
