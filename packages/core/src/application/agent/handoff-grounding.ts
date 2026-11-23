import { conjunctTokens, isClauseLinkingWord } from '../nl-routing/conjuncts';
import type { NlClause } from '../nl-routing/clause-flags';
import { nlWithoutInlineQuotes } from '../nl-routing/read-statement';
import { nlHasDistributiveMarker, nlHasGrammaticalNegation, nlHasRetraction, nlIsRequestForm, nlRequestVeto } from '../nl-routing/request-shape';
import { normalizeForMatch } from '../nl-routing/selection-input';

/**
 * ADR-0121 A4 (A4-S1), review round 2: the STRUCTURAL ground of a handoff. A handoff is grounded only when the owner's own
 * words (inline quotes removed) are exactly ONE request-form unit; anything else is refused (fail closed, no heuristic that
 * tries to find the "right" clause inside a longer message). The unit holds:
 *  - no quote delimiter this module does not strip (backticks, guillemets), no line or paragraph break anywhere, and no
 *    sentence terminator or semicolon/colon except a trailing run of terminators;
 *  - no negation, exclusion or retraction anywhere (the all-clauses-plain precedent of `nlClauseGroundedFlagNames`);
 *  - only letters, digits, plain spaces, a letter-flanked apostrophe and the one comma (no `&`, `-`, `/` or other symbol), and no
 *    request-shape veto (`nlRequestVeto`: question, past statement, reported or deferred request);
 *  - no clause boundary: no "and"/"그리고", no -고 connective, no -하고 token (a noun particle and a verb connective look alike; the
 *    comitative -랑 is kept: "일정이랑 비교해줘"), no linking ending (-면서, -며, -고서, 후), and a
 *    comma only as the one boundary of an each-item introductory phrase that already holds the distributive marker;
 *  - at most one request-form word (`nlIsRequestForm`), and when there is one it is the LAST word (Korean is head-final).
 * Known residuals (fail open, harmless while handoff is `handoff-off`; DECISIONS.md A4-S1 note): linking endings outside the
 * closed class, bare English commands joined by words, one request naming two sources. The A4-S2 activation gate closes them.
 */
export function handoffOwnerUnit(groundingText: string, scope: 'one-item' | 'each-item'): NlClause | undefined {
  if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(groundingText)) return undefined;
  const stripped = nlWithoutInlineQuotes(groundingText.normalize('NFC').replace(/\p{Cf}/gu, ''), { contractions: true }).trim();
  if (/[`«»‹›]/u.test(stripped)) return undefined;
  // A question mark anywhere, a trailing one included, is a question, never a request to act on (final review, fail closed:
  // a polite "…해줄래?" refuses too). The veto below sees the text WITH its terminators for the same reason.
  if (/[?？]/u.test(stripped) || nlRequestVeto(stripped, [], []) !== undefined) return undefined;
  const text = stripped.replace(/[.!?。！？．｡…]+$/u, '').trim();
  if (text.length === 0) return undefined;
  // Punctuation whitelist: letters, digits, plain spaces, a letter-flanked ASCII apostrophe and a comma (checked below); anything else refuses.
  if (/[^\p{L}\p{N} ,']|(?<![\p{L}])'|'(?![\p{L}])/u.test(text)) return undefined;
  // A comma must close a word and be followed by a space ("메일마다, …"); an embedded comma ("확인,취소") refuses.
  if (/,(?! )|(?<![\p{L}\p{N}]),/u.test(text)) return undefined;
  // Any request-shape veto (question, statement, reported, deferred) refuses.
  if (nlRequestVeto(text, [], []) !== undefined) return undefined;
  if (nlHasGrammaticalNegation(text) || nlHasRetraction(text)) return undefined;
  const tokens = conjunctTokens(text, { verbConnective: true });
  // The clause-boundary checks run on the text WITHOUT its commas, so a comma cannot hide a connective ("정리하고, 일정 확인해줘").
  // The comitative -랑 is allowed ("일정이랑 비교해줘"); a token in -하고 is a noun particle or a verb connective (메일하고 / 확인하고), indistinguishable: refuse.
  const plain = conjunctTokens(text.replace(/,/gu, ''), { verbConnective: true });
  if (plain.some((token) => token.boundary || token.ends === 'connective' || /하고$/u.test(token.word) || isClauseLinkingWord(token.word))) return undefined;
  const commas = tokens.filter((token) => token.ends === 'comma');
  if (commas.length > 1) return undefined;
  if (commas.length === 1) {
    const at = tokens.indexOf(commas[0] as (typeof tokens)[number]);
    if (scope !== 'each-item' || at === tokens.length - 1 || !nlHasDistributiveMarker(tokens.slice(0, at + 1).map((token) => token.text).join(' '))) return undefined;
  }
  const forms = tokens.filter((token) => nlIsRequestForm(token.text));
  if (forms.length > 1 || (forms.length === 1 && forms[0] !== tokens.at(-1))) return undefined;
  return { text, normalized: normalizeForMatch(text), words: tokens };
}
