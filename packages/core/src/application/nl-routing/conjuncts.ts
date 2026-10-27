import { normalizeForMatch } from './selection-input';

/**
 * ADR-0121 S2: the conjuncts of the owner's prose, shared by the plan validator (step-scoped temporal grounding, the
 * clause-bound enum check; stage P1) and the help split (A1-E1; stage P3). Structural only: grammatical boundaries, never
 * a topic word.
 *
 * Boundaries (P1): the words "and" / "그리고" (a boundary word belongs to no conjunct), a token ending in a comma, and a
 * token with a glued "-랑" / "-하고". The help split also cuts after a Korean token in the verb connective "-고"
 * (owner decision Q2, 2026-10-23: "사용법 알려주고 …"); the validator never does, so its P1 behaviour is unchanged.
 */

export interface ConjunctToken {
  /** The token as the owner wrote it. */
  readonly text: string;
  /** `normalizeForMatch(text)`. */
  readonly word: string;
  /** "and" / "그리고": a boundary word, in no conjunct (`conjunct` is -1). */
  readonly boundary: boolean;
  readonly conjunct: number;
  /** How the token ended its conjunct, when it did. */
  readonly ends?: 'comma' | 'particle' | 'connective';
}

/** A Hangul token of two or more syllables whose last syllable is the connective 고 (not the -하고 particle form). */
const VERB_CONNECTIVE = /^[가-힣]+(?<!하)고$/u;

export function conjunctTokens(text: string, options: { readonly verbConnective?: boolean } = {}): ConjunctToken[] {
  const out: ConjunctToken[] = [];
  let conjunct = 0;
  for (const raw of text.split(/\s+/u).filter((token) => token.length > 0)) {
    const word = normalizeForMatch(raw);
    if (word === 'and' || word === '그리고') {
      out.push({ text: raw, word, boundary: true, conjunct: -1 });
      conjunct += 1;
      continue;
    }
    const ends = /[,،]$/u.test(word) ? 'comma' : /(?:랑|하고)$/u.test(word) ? 'particle' : options.verbConnective === true && VERB_CONNECTIVE.test(word) ? 'connective' : undefined;
    out.push({ text: raw, word, boundary: false, conjunct, ...(ends !== undefined ? { ends } : {}) });
    if (ends !== undefined) conjunct += 1;
  }
  return out;
}

/**
 * Whether a normalized word names the alias. A Korean alias may be followed by anything (a particle: `깃허브에서`); an
 * English (ASCII) alias must end at a word boundary, with only a plural or possessive allowed (`PRs`, `PR's`), so that
 * `project` never reads as the GitHub alias `pr` (Codex P3 on S2 P1).
 */
export function aliasStarts(word: string, name: string): boolean {
  if (!word.startsWith(name)) return false;
  if (!/^[a-z0-9]+$/u.test(name)) return true;
  return /^(?:s|['’]s)?(?![a-z0-9])/u.test(word.slice(name.length));
}
