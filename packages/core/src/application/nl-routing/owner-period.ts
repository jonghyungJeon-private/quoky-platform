import { nlStatedLabelPeriod } from './action-entries';
import { nlClauseNamesEntry, nlClauses, nlClauseStringValues, type NlClause } from './clause-flags';
import { nlHasExclusionOrNegation } from './request-shape';
import { validateSelection, type NlValidatedSelection, type NlValidationContext } from './selection-validator';
import { resolveNlRange } from './symbolic-time';

/**
 * Owner decision of 2026-10-27 (range grounding; explicit periods always win): when the owner's words state exactly one
 * period of the existing period-label table (`nlStatedLabelPeriod`: no weekday, no span) and the read's range (the
 * selector's, or the entry's default when it left the range out) names other dates, Core uses the owner's period and
 * validates again. "today" (the calendar default) and the entry's own default do not count as stated; a range naming the same dates is
 * kept as the selector wrote it; an invalid result keeps the selection. Only an entry whose range is the items' own date
 * (`rangeIsItemDate`: calendar.events); none of the read's own clauses (the whole message when it is one conjunct, else
 * those naming the entry) may hold an exclusion or negation marker; those own clauses must state the one period, and it
 * must be the only distinct period of the whole message without its excluded or negated clauses, the read's own arg
 * values set aside in both (two periods, or a period only another read states: left alone). Pure.
 */
export function nlOwnerStatedRange(selection: NlValidatedSelection, groundingText: string, ctx: NlValidationContext): NlValidatedSelection {
  const { entry } = selection;
  const spec = entry.args.find((candidate) => candidate.kind === 'range');
  if (entry.risk !== 'READ' || spec === undefined || entry.rangeIsItemDate !== true) return selection;
  // Codex review of 86271dd5: the read's own clauses, as the clause-grounded flag rule reads them. An exclusion or negation
  // there means no period is stated ("내일 말고 일정 보여줘"), and the read's own values are set aside first (a keyword
  // "다음 주 계획" is a title, not a period).
  const clauses = nlClauses(groundingText);
  const own = clauses.length <= 1 ? clauses : clauses.filter((clause) => nlClauseNamesEntry(clause, entry));
  if (own.length === 0 || own.some((clause) => nlHasExclusionOrNegation(clause.text))) return selection;
  const values = nlClauseStringValues(Object.fromEntries(Object.entries(selection.args).filter(([name]) => name !== spec.name))).sort((a, b) => b.length - a.length);
  const residue = (clause: NlClause): string => values.reduce((text, value) => text.split(value).join(' '), clause.normalized);
  // Codex delta review of 6cc157e6: the clause scoping above is for the exclusion check only. The periods are counted over
  // the WHOLE message without its excluded or negated clauses and without the read's own values, so a coordinated period
  // ("내일이랑 모레") is two periods and the selector's range stays.
  const whole = nlStatedLabelPeriod(clauses.filter((clause) => !nlHasExclusionOrNegation(clause.text)).map(residue).join(' , '));
  // Codex delta review of 02fd5380 (narrowed, closed): the read's OWN clauses must state that same one period ("일정
  // 보여주고 어제 메일도 알려줘": 어제 is the mail read's, and the calendar range stays).
  const stated = whole !== undefined && nlStatedLabelPeriod(own.map(residue).join(' , ')) === whole ? whole : undefined;
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
