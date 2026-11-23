import { conjunctTokens, isClauseLinkingWord } from '../nl-routing/conjuncts';
import type { NlClause } from '../nl-routing/clause-flags';
import { nlWithoutInlineQuotes } from '../nl-routing/read-statement';
import { nlHasDistributiveMarker, nlHasGrammaticalNegation, nlHasRetraction, nlIsRequestForm } from '../nl-routing/request-shape';
import { normalizeForMatch } from '../nl-routing/selection-input';

/**
 * ADR-0121 A4 (A4-S1), review round 2: the STRUCTURAL ground of a handoff. A handoff is grounded only when the owner's own
 * words (inline quotes removed) are exactly ONE request-form unit; anything else is refused (fail closed, no heuristic that
 * tries to find the "right" clause inside a longer message). The unit holds:
 *  - no quote delimiter this module does not strip (backticks, guillemets), no line or paragraph break anywhere, and no
 *    sentence terminator or semicolon/colon except a trailing run of terminators;
 *  - no negation, exclusion or retraction anywhere (the all-clauses-plain precedent of `nlClauseGroundedFlagNames`);
 *  - no clause boundary: no "and"/"그리고", no -고 connective (the noun particles -랑/-하고 are not one: "일정이랑 비교해줘"), no linking ending (-면서, -며, -고서, 후), and a
 *    comma only as the one boundary of an each-item introductory phrase that already holds the distributive marker;
 *  - at most one request-form word (`nlIsRequestForm`), and when there is one it is the LAST word (Korean is head-final).
 * Known residual (recorded in DECISIONS.md): English has no closed request-form class, so two English commands without
 * punctuation or a connective ("show mail show calendar") are one unit here; one request naming two sources
 * ("메일 일정 보여줘") is one unit too. A4-S2 must check the operation/kind against the handoff slots before it activates.
 */
export function handoffOwnerUnit(groundingText: string, scope: 'one-item' | 'each-item'): NlClause | undefined {
  if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(groundingText)) return undefined;
  const stripped = nlWithoutInlineQuotes(groundingText.normalize('NFC').replace(/\p{Cf}/gu, '')).trim();
  if (/[`«»‹›]/u.test(stripped)) return undefined;
  const text = stripped.replace(/[.!?。！？．｡…]+$/u, '').trim();
  if (text.length === 0 || /[.!?。！？．｡…;；:：]/u.test(text)) return undefined;
  if (nlHasGrammaticalNegation(text) || nlHasRetraction(text)) return undefined;
  const tokens = conjunctTokens(text, { verbConnective: true });
  if (tokens.some((token) => token.boundary || token.ends === 'connective' || isClauseLinkingWord(token.word.replace(/[,،]$/u, '')))) return undefined;
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
