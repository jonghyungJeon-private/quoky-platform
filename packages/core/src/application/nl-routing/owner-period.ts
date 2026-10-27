import { nlStatedLabelPeriod } from './action-entries';
import { nlClauseNamesEntry, nlClauses, nlClauseStringValues } from './clause-flags';
import type { NlCatalogEntry } from './catalog';
import { nlHasExclusionOrNegation } from './request-shape';
import { normalizeForMatch } from './selection-input';
import { validateSelection, type NlValidatedSelection, type NlValidationContext } from './selection-validator';
import { resolveNlRange } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

/**
 * Owner decision of 2026-10-27 (range grounding; explicit periods always win), scope narrowed by the orchestrator after
 * four Codex rounds (the fix-loop cap; see DECISIONS). Core uses the owner's period only when ALL hold:
 *  - the message names no catalog source other than the read's own (the catalog's existing aliases and source names of
 *    the other read entries; an alias the read's own entry shares does not count);
 *  - the message holds no exclusion or negation marker (`nlHasExclusionOrNegation`, the shared markers);
 *  - with the read's own arg values set aside, the whole message states exactly ONE period of the existing period-label
 *    table (`nlStatedLabelPeriod`: no weekday form, span, duration, other time unit or month name);
 *  - the entry's range is the items' own date (`rangeIsItemDate`: calendar.events); the period is not "today" or the
 *    entry's default; the read's range (the selector's, or the default when it left it out) names other dates; and the
 *    result validates again.
 * Anything else (several sources, several periods, a negation) leaves the selector's range alone. Pure.
 */
export function nlOwnerStatedRange(selection: NlValidatedSelection, groundingText: string, ctx: NlValidationContext): NlValidatedSelection {
  const { entry } = selection;
  const spec = entry.args.find((candidate) => candidate.kind === 'range');
  if (entry.risk !== 'READ' || spec === undefined || entry.rangeIsItemDate !== true) return selection;
  if (nlHasExclusionOrNegation(groundingText)) return selection;
  const values = nlClauseStringValues(Object.fromEntries(Object.entries(selection.args).filter(([name]) => name !== spec.name))).sort((a, b) => b.length - a.length);
  // The read's own values are set aside first (a keyword "다음 주 계획" is a title, not a period nor a source name).
  const residueText = values.reduce((text, value) => text.split(value).join(' '), normalizeForMatch(groundingText));
  const clauses = nlClauses(residueText);
  // Single-source messages only: another read entry named by a catalog alias or source name the read's own entry does not
  // share ("어제 일정 관련 메일" names mail) leaves the range to the selector.
  const ownNames = new Set([...entry.aliases, ...(entry.sourceNames ?? [])].map((name) => normalizeForMatch(name)));
  const others = Object.values(NL_WAVE1_ENTRIES).filter((other): other is NlCatalogEntry => other !== undefined && other.id !== entry.id);
  const named = (other: NlCatalogEntry): boolean => {
    const names = { ...other, aliases: other.aliases.filter((alias) => !ownNames.has(normalizeForMatch(alias))), sourceNames: (other.sourceNames ?? []).filter((name) => !ownNames.has(normalizeForMatch(name))) };
    return clauses.some((clause) => nlClauseNamesEntry(clause, names));
  };
  if (others.some(named)) return selection;
  const stated = nlStatedLabelPeriod(residueText);
  if (stated === undefined || stated === 'today' || stated === spec.default) return selection;
  const given = typeof selection.args[spec.name] === 'string' ? (selection.args[spec.name] as string) : typeof spec.default === 'string' ? spec.default : undefined;
  if (given === stated) return selection;
  if (given !== undefined) {
    const shown = resolveNlRange(given, ctx.now, ctx.timeZone);
    const owner = resolveNlRange(stated, ctx.now, ctx.timeZone);
    if (shown !== undefined && owner !== undefined && shown.from === owner.from && shown.to === owner.to) return selection;
  }
  const again = validateSelection({ entryId: entry.id, args: { ...selection.args, [spec.name]: stated } }, ctx);
  return again.ok ? { ...again.value, ...(selection.defaulted !== undefined ? { defaulted: selection.defaulted } : {}) } : selection;
}
