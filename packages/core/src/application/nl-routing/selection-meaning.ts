import type { IsoTimestamp } from '../../domain';
import type { NlArgValue, NlCatalogEntry, NlGrammarSelection } from './catalog';
import { normalizeNlRangeSymbol, resolveNlRange } from './symbolic-time';

/**
 * ADR-0120 D10 / S1 W3: the meaning of a selection — what the owner would see — so the grammar's answer and the
 * selector's answer can be compared fairly. Both sides are resolved the same way, with Core's clock and time zone:
 *
 *  - every absent argument takes its catalog default (`range` today, `status` open, `query` my-items, flags false);
 *  - a range is resolved to its instants (`fri`, `10-20` and `2026-10-16` are the same day when they are);
 *  - `count` is dropped: a count question is answered with the same deterministic list plus a count line;
 *  - a bare mail check (no `today`, no `from`) ignores `unread`: the mail grammar's default listing is the unread inbox,
 *    and "메일 확인해줘" asks for that inbox either way.
 *
 * Keywords stay exact (after case and spacing): a different search word is a different result. Pure.
 */
export function nlSelectionMeaning(
  selection: NlGrammarSelection,
  entry: NlCatalogEntry | undefined,
  now: IsoTimestamp,
  timeZone: string,
): string {
  const values: Record<string, NlArgValue> = {};
  for (const spec of entry?.args ?? []) {
    const value = selection.args[spec.name] ?? spec.default;
    if (value === undefined || value === false) continue;
    values[spec.name] = value;
  }
  for (const [name, value] of Object.entries(selection.args)) if (!(name in values) && value !== false) values[name] = value;
  delete values.count;
  for (const spec of entry?.args ?? []) {
    const value = values[spec.name];
    if (spec.kind === 'range' && typeof value === 'string') {
      const resolved = resolveNlRange(normalizeNlRangeSymbol(value), now, timeZone);
      values[spec.name] = resolved === undefined ? `?${value}` : `${resolved.from}..${resolved.to}`;
    } else if (spec.kind === 'keyword' && typeof value === 'string') {
      values[spec.name] = value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    }
  }
  if (selection.entryId === 'mail.list' && values.today === undefined && values.from === undefined) delete values.unread;
  return JSON.stringify([selection.entryId, Object.keys(values).sort().map((name) => [name, values[name]])]);
}
