import { nlStatedLabelPeriod } from './action-entries';
import { validateSelection, type NlValidatedSelection, type NlValidationContext } from './selection-validator';
import { resolveNlRange } from './symbolic-time';

/**
 * Owner decision of 2026-10-27 (range grounding; explicit periods always win): when the owner's words state exactly one
 * period of the existing period-label table (`nlStatedLabelPeriod`: no weekday, no span) and the read's range (the
 * selector's, or the entry's default when it left the range out) names other dates, Core uses the owner's period and
 * validates again. "today" (the calendar default) and the entry's own default do not count as stated; a range naming the same dates is
 * kept as the selector wrote it; an invalid result keeps the selection. READ entries with a `range` only. Pure.
 */
export function nlOwnerStatedRange(selection: NlValidatedSelection, groundingText: string, ctx: NlValidationContext): NlValidatedSelection {
  const { entry } = selection;
  const spec = entry.args.find((candidate) => candidate.kind === 'range');
  if (entry.risk !== 'READ' || spec === undefined) return selection;
  const stated = nlStatedLabelPeriod(groundingText);
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
