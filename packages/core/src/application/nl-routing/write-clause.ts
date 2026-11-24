import type { IsoTimestamp } from '../../domain';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { detectWorkChatCommand, type WorkChatCommand } from '../work-chat/work-chat-command';
// ADR-0121 A7.5 step 0 (owner amendment 2026-11-24): the A6-D2 closed Korean recency words, re-exported for the A7 router only.
export { RECENCY_KO } from './action-entries';
import { isNlDeicticOnlyPayload, nlDeterminerSources, nlLocalListTarget, nlSpanStartsWithDeterminer, normalizeNlSpan } from './action-entries';

/**
 * ADR-0121 A7 (A7-S1, review round 1, P3): the ADR-0112 grammar's closed word sets, re-exported for the A7 router
 * (`agent/cross-write.ts`) so it reads the grammar's own words, never a copy. The agent module imports only through this
 * routing module (the agent boundary allowlist, ADR-0121 D5); nothing here adds a word.
 */
export {
  WORK_CHAT_CHANNEL_NOUNS,
  WORK_CHAT_COMMENT_NOUNS,
  WORK_CHAT_COMMENT_VERBS,
  WORK_CHAT_ISSUE_NOUNS,
  WORK_CHAT_POST_NOUNS,
  WORK_CHAT_POST_VERBS,
  WORK_CHAT_REQUEST_ENDING_FORMS,
} from '../work-chat/work-chat-command';

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
  // Codex P2: the spans are judged in their canonical form (the validator's own `normalizeNlSpan`: one pair of enclosing
  // quotes removed), so a quoted and an unquoted output can never differ in writability.
  return (
    nlDeterminerSources(clause).size > 0 ||
    spans.some((raw) => {
      const span = normalizeNlSpan(raw);
      return span.length > 0 && (nlSpanStartsWithDeterminer(span) || isNlDeicticOnlyPayload(span));
    })
  );
}

/**
 * ADR-0121 A7 (A7-S1), pipeline step 0 item 1: whether the message is an ADR-0112 connector-write command that carries the
 * owner's own payload (`Jira KEY에 댓글: <text>`, `Slack #<channel>에 게시: <text>`): the existing exact grammar decides, and the
 * write-shaped request without a payload (a usage hint) is NOT one (it never carries a payload). Pure; never throws.
 */
export function nlIsExactConnectorWrite(text: string): boolean {
  try {
    const command = detectWorkChatCommand(text);
    return command !== null && command.kind === 'connector-write' && command.draft.kind !== 'usage';
  } catch {
    return false;
  }
}

/**
 * The calendar write grammar's (ADR-0110 D3, `calendar/calendar-write-request.ts`) delete verb and booking verb, moved here
 * verbatim (ADR-0121 A7-S1, review round 2, P2-b) so the calendar parser and the A7 plan validator read ONE source: the
 * calendar parser imports them from here (the nl-routing import scan admits no `calendar/` import, and the agent boundary admits
 * only nl-routing). The regexes are unchanged character for character; nothing is added.
 */
export const CALENDAR_DELETE_VERB = /(?:취소|삭제|지워|지우|빼)\s*(?:해)?\s*(?:줘|주세요|줄래|주실래요|줄\s*수\s*있)|\b(?:cancel|delete|remove)\b/iu;
/** The booking verb as the owner's request ("잡아줘", "추가해 줘"): followed by a request ending or the end of the message. */
export const CALENDAR_BOOKING_VERB = /(?:잡아|넣어|만들어|(?:추가|등록|예약)\s*해)(?=\s*(?:줘|주세요|줄래|주실래요|줄\s*수)|\s*[.!~?]*$)/u;
const HANGUL = /[가-힣]/u;

/**
 * ADR-0121 A7 (A7-S1, review round 2, P2-b): whether the message asks for a calendar event to be CREATED according to the
 * EXISTING calendar write grammar: a Korean message with no delete verb (the parser tries delete first) and the booking verb as
 * the owner's request (with it the parser never takes the update branch), so `parseCalendarWriteRequest` takes its create branch;
 * and the message does not name Quoky's own to-do or reminder list as the place of the write (`nlLocalListTarget`, the calendar
 * classifier's own exclusion). No word is added. That grammar has no English create verb, so an English message is never one (a
 * recorded residual until the A7-S7 calendar write-clause detector). Pure; never throws.
 */
export function nlIsCalendarCreateRequest(text: string): boolean {
  try {
    const message = text.normalize('NFC').trim();
    return HANGUL.test(message) && !CALENDAR_DELETE_VERB.test(message) && CALENDAR_BOOKING_VERB.test(message) && nlLocalListTarget(message) === undefined;
  } catch {
    return false;
  }
}
