import type { IsoTimestamp } from '../../domain';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { detectWorkChatCommand, type WorkChatCommand } from '../work-chat/work-chat-command';
import { nlDeterminerSources, nlSpanStartsWithDeterminer } from './action-entries';

/**
 * ADR-0121 S2 (owner-approved fix of 2026-10-26 for ap-n131, under the ratified read + write note): whether one clause of
 * the owner's message is a write request according to the EXISTING deterministic grammars — the reminder grammar
 * (ADR-0101 / ADR-0117: a reminder create, an event-relative create, a cancel, or its clarification) and the to-do / work
 * grammar (ADR-0100 / ADR-0112: a to-do add, complete, cancel or link, an exact connector write or its refusal). No word
 * or phrase is added: the closed command kinds of those grammars decide. Pure; never throws for any input string.
 *
 * Residual: a write the grammars do not recognise (an English or unusual phrasing they leave to selection) is not claimed;
 * such a turn still relies on the planner's own `none`.
 */

/** The write kinds of the work grammar (closed command kinds; reads, hints and status questions are not writes). */
const WORK_WRITE_KINDS: ReadonlySet<WorkChatCommand['kind']> = new Set(['todo.add', 'todo.complete', 'todo.cancel', 'todo.link', 'connector-write', 'external-write-unsupported']);

export function nlClauseClaimsWrite(clause: string, options: { readonly now: IsoTimestamp; readonly timeZone?: string }): boolean {
  const text = clause.trim();
  if (text.length === 0) return false;
  try {
    const reminder = parseReminderMessage(text, { now: options.now, ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}) });
    if (reminder.kind === 'CREATE' || reminder.kind === 'CREATE_EVENT_RELATIVE' || reminder.kind === 'CANCEL' || reminder.kind === 'CLARIFY') return true;
  } catch {
    // An invalid clock is the caller's error; the clause is then not claimed (fail closed toward the planner's plan).
  }
  const work = detectWorkChatCommand(text);
  return work !== null && WORK_WRITE_KINDS.has(work.kind);
}

/**
 * ADR-0121 S2 (CA review of P3, W1): whether a write clause, or one of a selection's payload spans, points back at
 * something already shown instead of carrying the owner's own payload: the A6 determiner + item-noun grammar ("그 할 일",
 * "이 메일"; the referent grammar's step 3) over the clause, or a span that begins with a determiner word ("그 첫 회의 제목",
 * "그 내용"). Existing closed vocabulary only. Pure.
 */
export function nlWriteClausePointsBack(clause: string, spans: readonly string[]): boolean {
  return nlDeterminerSources(clause).size > 0 || spans.some((span) => nlSpanStartsWithDeterminer(span));
}
