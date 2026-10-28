import { nlStatedLabelPeriod } from './action-entries';
import { nlClauseStringValues } from './clause-flags';
import type { NlArgs, NlCatalogEntry } from './catalog';
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

/**
 * Owner decision of 2026-10-28 (fix 4 of the 95386868 analysis; amends the follow-up inheritance rule): an ITEM question
 * after a narrowed listing searches the full parent listing. When the held listing of the same entry narrowed its parent
 * (`LastSelection.parent`, e.g. "그중에 오후 것만") and the read names a new item (a keyword arg with a value the held
 * listing did not have, "면접은 몇 시였지?"), every narrowing arg the read only carried over (one the owner's words of this
 * turn do not ground, judged by the validator against the parent alone) is dropped, so the read covers the parent listing.
 * A narrowing the owner states again ("오후 면접은?") stays. The result is validated again; an invalid one keeps the read.
 * Pure.
 */
export function nlSearchParentListing(
  selection: NlValidatedSelection,
  held: { readonly entryId: string; readonly args: NlArgs; readonly parent?: NlArgs } | undefined,
  ctx: NlValidationContext,
): NlValidatedSelection {
  const { entry } = selection;
  if (held === undefined || held.parent === undefined || held.entryId !== entry.id || entry.risk !== 'READ') return selection;
  const namesNewItem = entry.args.some((spec) => spec.kind === 'keyword' && typeof selection.args[spec.name] === 'string' && selection.args[spec.name] !== held.args[spec.name]);
  if (!namesNewItem) return selection;
  const parent = held.parent;
  const narrowing = Object.keys(held.args).filter((name) => parent[name] !== held.args[name] && selection.args[name] === held.args[name]);
  if (narrowing.length === 0) return selection;
  const parentCtx: NlValidationContext = { ...ctx, previousArgs: parent, previousEntryId: entry.id as never };
  // Codex review of 7f7e8d32: grounding is decided PER narrowing filter. Each one is validated against the parent with
  // the other narrowing filters set aside, so an ungrounded inherited filter (timedOnly) never takes a restated one
  // ("오후 면접은?": afternoon) down with it.
  const without = (keep: string): Record<string, NlArgs[string]> =>
    Object.fromEntries(Object.entries(selection.args).filter(([name]) => name === keep || !narrowing.includes(name)));
  const carried = narrowing.filter((name) => {
    const alone = validateSelection({ entryId: entry.id, args: without(name) }, parentCtx);
    return !alone.ok || alone.value.args[name] !== selection.args[name];
  });
  if (carried.length === 0) return selection;
  const args: Record<string, NlArgs[string]> = {};
  for (const [name, value] of Object.entries(selection.args)) if (!carried.includes(name)) args[name] = value;
  for (const [name, value] of Object.entries(parent)) if (args[name] === undefined) args[name] = value;
  const again = validateSelection({ entryId: entry.id, args }, parentCtx);
  return again.ok ? { ...again.value, ...(selection.defaulted !== undefined ? { defaulted: selection.defaulted } : {}) } : selection;
}
