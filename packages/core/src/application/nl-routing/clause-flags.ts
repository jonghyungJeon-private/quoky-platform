import type { NlArgs, NlCatalogEntry } from './catalog';
import { aliasStarts, conjunctTokens, type ConjunctToken } from './conjuncts';
import { nlHasExclusionOrNegation } from './request-shape';
import { normalizeForMatch } from './selection-input';
import { groundingWordIn, validateSelection, type NlValidatedSelection, type NlValidationContext } from './selection-validator';

/** One conjunct of the owner's prose (the S2 boundaries, the verb connective included). */
export interface NlClause {
  readonly text: string;
  readonly normalized: string;
  readonly words: readonly ConjunctToken[];
}

/** The owner's prose as conjuncts (the S2 boundaries, the verb connective included). Pure. */
export function nlClauses(groundingText: string): NlClause[] {
  const tokens = conjunctTokens(groundingText, { verbConnective: true });
  const clauses = new Map<number, ConjunctToken[]>();
  for (const token of tokens) if (!token.boundary) clauses.set(token.conjunct, [...(clauses.get(token.conjunct) ?? []), token]);
  return [...clauses.values()].map((words) => {
    const text = words.map((token) => token.text).join(' ').replace(/[,،]$/u, '');
    return { text, normalized: normalizeForMatch(text), words };
  });
}

/** Whether the clause names the entry by an alias or source name (a multi-word name as a phrase). */
export function nlClauseNamesEntry(clause: NlClause, entry: NlCatalogEntry): boolean {
  const all = [...entry.aliases, ...(entry.sourceNames ?? [])].map((alias) => normalizeForMatch(alias)).filter((name) => name.length > 0);
  return (
    clause.words.some((token) => all.some((name) => !name.includes(' ') && aliasStarts(token.word, name))) ||
    all.some((name) => name.includes(' ') && ` ${clause.normalized} `.includes(` ${name}`))
  );
}

/** The normalized string values (longer than one character) of a selection's args. */
export function nlClauseStringValues(args: Readonly<Record<string, unknown>>): string[] {
  return Object.values(args).flatMap((value) => (typeof value === 'string' && value.length > 1 ? [normalizeForMatch(value)] : []));
}

/**
 * Owner decision of 2026-10-26 (ADR-0121 S2 note 2): the flag args (with catalog grounding words, `flagGrounding`; today
 * calendar `timedOnly`) a read's OWN clauses ground. `own` are those clauses; `residue` is a clause with every planned
 * read's value set aside. None when an own clause holds an exclusion or negation marker (`nlHasExclusionOrNegation`,
 * fail-safe); a flag counts only when the clauses name the entry by its flag words alone (another alias of the entry
 * that is not a flag word, "일정", "캘린더", means the whole calendar was asked for). No vocabulary of its own. Pure.
 */
export function nlClauseGroundedFlagNames(entry: NlCatalogEntry, args: NlArgs, own: readonly NlClause[], residue: (clause: NlClause) => string): string[] {
  const specs = entry.args.filter((spec) => spec.kind === 'flag' && spec.flagGrounding !== undefined && args[spec.name] !== true);
  if (specs.length === 0) return [];
  const plain = own.filter((clause) => !nlHasExclusionOrNegation(clause.text));
  if (plain.length === 0 || plain.length !== own.length) return [];
  return specs
    .filter((spec) => {
      const flagWords = (spec.flagGrounding ?? []).map((word) => normalizeForMatch(word));
      const broader = entry.aliases.map((alias) => normalizeForMatch(alias)).filter((alias) => alias.length > 0 && !flagWords.includes(alias));
      if (plain.some((clause) => broader.some((alias) => groundingWordIn(residue(clause), alias)))) return false;
      return plain.some((clause) => flagWords.some((word) => groundingWordIn(residue(clause), word)));
    })
    .map((spec) => spec.name);
}

/**
 * Owner decision of 2026-10-27 (closing the one-step question of ADR-0121 S2 note 2): the same clause-grounded flag rule
 * on the ADR-0120 one-step selection path. The one read is the only planned read: its own clauses are the whole message
 * when it is one conjunct, else the conjuncts that name its entry; its own values are set aside. Only turns a flag ON,
 * deterministically; the result is validated again (an invalid one keeps the selection). Pure.
 */
export function nlOneStepClauseGroundedFlags(selection: NlValidatedSelection, groundingText: string, ctx: NlValidationContext): NlValidatedSelection {
  if (selection.entry.risk !== 'READ' || !selection.entry.args.some((spec) => spec.kind === 'flag' && spec.flagGrounding !== undefined)) return selection;
  const clauses = nlClauses(groundingText);
  const values = nlClauseStringValues(selection.args).sort((a, b) => b.length - a.length);
  const residue = (clause: NlClause): string => values.reduce((text, value) => text.split(value).join(' '), clause.normalized);
  const own = clauses.length <= 1 ? clauses : clauses.filter((clause) => nlClauseNamesEntry(clause, selection.entry));
  const set = nlClauseGroundedFlagNames(selection.entry, selection.args, own, residue);
  if (set.length === 0) return selection;
  const args: Record<string, NlArgs[string]> = { ...selection.args };
  for (const name of set) args[name] = true;
  const again = validateSelection({ entryId: selection.entry.id, args }, ctx);
  return again.ok ? { ...again.value, ...(selection.defaulted !== undefined ? { defaulted: selection.defaulted } : {}) } : selection;
}
