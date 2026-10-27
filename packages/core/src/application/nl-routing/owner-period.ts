import { nlStatedLabelPeriod } from './action-entries';
import { nlClauseStringValues } from './clause-flags';
import type { NlCatalogEntry } from './catalog';
import { nlHasExclusionOrNegation } from './request-shape';
import { normalizeForMatch } from './selection-input';
import { validateSelection, type NlValidatedSelection, type NlValidationContext } from './selection-validator';
import { resolveNlRange } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

/**
 * Codex delta review of 7503634d: whether normalized text names a catalog alias or source name, bounded by non-letters. The
 * name must not follow a letter or digit (any Unicode punctuation, bracket, quote, space or the text start may precede it:
 * "(메일)도", "“메일”도", "「메일」", "메일,"). A Korean name may be followed by anything (a particle: "메일도"); an English
 * (ASCII) name must end at a non-letter, with only a plural or possessive allowed, as `aliasStarts` reads a token.
 */
function nlNamesCatalogWord(text: string, name: string): boolean {
  // Unicode-mode pattern: only the syntax characters are escaped ("-" and other identity escapes are invalid there).
  const escaped = name.replace(/[\\^$*+?.()|[\]{}/]/g, '\\$&').replace(/ /g, '\\s+');
  const tail = /^[a-z0-9 .-]+$/u.test(name) ? "(?:s|['’]s)?(?![\\p{L}\\p{N}])" : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${tail}`, 'u').test(text);
}

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
  // Single-source messages only: another read entry named by a catalog alias or source name the read's own entry does not
  // share ("어제 일정 관련 메일" names mail) leaves the range to the selector.
  const ownNames = new Set([...entry.aliases, ...(entry.sourceNames ?? [])].map((name) => normalizeForMatch(name)));
  const otherNames = Object.values(NL_WAVE1_ENTRIES)
    .filter((other): other is NlCatalogEntry => other !== undefined && other.id !== entry.id)
    .flatMap((other) => [...other.aliases, ...(other.sourceNames ?? [])].map((name) => normalizeForMatch(name)))
    .filter((name) => name.length > 0 && !ownNames.has(name));
  if (otherNames.some((name) => nlNamesCatalogWord(residueText, name))) return selection;
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
