/**
 * ADR-0124 section 3.1: a token estimate from code points by script class, with no tokenizer dependency. The weights
 * are PROPOSALS; phase 1 calibrates them per pinned model from the provider's reported prompt token count and records
 * a 20% safety margin. The code-point bound stays the hard bound.
 */
export interface TokenWeights {
  /** Hangul, Han, Kana (tokens per code point). */
  readonly cjk: number;
  /** Latin letters and digits. */
  readonly latin: number;
  /** Whitespace, punctuation, symbols. */
  readonly other: number;
  /** Letters of any other script (not in the proposal's table; counted conservatively like CJK). */
  readonly otherLetter: number;
}

export const DEFAULT_TOKEN_WEIGHTS: TokenWeights = { cjk: 1.0, latin: 0.3, other: 0.5, otherLetter: 1.0 };

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN_EXTENDED = /[\p{Script=Latin}\p{N}]/u;
const LETTER = /\p{L}/u;

/** The weight of one code point. */
function weightOf(point: string, weights: TokenWeights): number {
  const code = point.charCodeAt(0);
  if (code < 0x80) {
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return weights.latin;
    return weights.other;
  }
  if (CJK.test(point)) return weights.cjk;
  if (LATIN_EXTENDED.test(point)) return weights.latin;
  if (LETTER.test(point)) return weights.otherLetter;
  return weights.other;
}

/** The unrounded estimate; additive over concatenation, so a packer can sum parts. */
export function estimateTokenWeight(text: string, weights: TokenWeights = DEFAULT_TOKEN_WEIGHTS): number {
  let sum = 0;
  for (const point of text) sum += weightOf(point, weights);
  return sum;
}

/** The estimated token count of `text`, rounded up. */
export function estimateTokens(text: string, weights: TokenWeights = DEFAULT_TOKEN_WEIGHTS): number {
  return Math.ceil(estimateTokenWeight(text, weights));
}
