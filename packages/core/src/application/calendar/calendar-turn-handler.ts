import type { ConversationTurnHandler, TurnHandlerContext, TurnHandlerReply } from '../../ports/conversation-turn-handler.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { CALENDAR_EVENTS_MAX_LIMIT, type CalendarEvent, type CalendarReader } from '../../ports/calendar-reader.port';
import { isConnectorQueryError } from '../../ports/connector-query';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { parseCalendarQuestion, placeCalendarSpan, type CalendarLanguage } from './calendar-question';
import {
  renderCalendarEvents,
  renderCalendarHistoryNote,
  renderCalendarInvalidDate,
  renderCalendarReadFailure,
  renderCalendarWriteRefused,
  type CalendarReadFailure,
} from './calendar-reply-renderer';

export const CALENDAR_TURN_HANDLER_ID = 'calendar';
/**
 * ADR-0110 D3 (amends ADR-0096 D5): `pre-classify`, order 150 — after memory commands (50), learning commands (60) and
 * anchored to-dos (100), before reminders (200), work lookups (300) and help intent (400).
 */
export const CALENDAR_TURN_HANDLER_ORDER = 150;
/** The whole read (every configured calendar and page) must finish within this bound. */
export const CALENDAR_READ_TIMEOUT_MS = 30_000;

/** The contributed help line (ADR-0096 D6; one line under the composer's 120-character bound, quoted phrases route here). */
export const CALENDAR_HELP_LINES: readonly string[] = Object.freeze([
  '- 캘린더(읽기 전용): "오늘 일정", "내일 일정 뭐야?", "이번 주 일정", "다음 회의 언제야?"',
]);

export interface CalendarTurnHandlerDeps {
  readonly reader: CalendarReader;
  /** `QUOKY_TIMEZONE`: windows and every rendered time are in this zone. */
  readonly timeZone: string;
  readonly logger?: Logger;
  /** Injectable for tests; production uses CALENDAR_READ_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

class CalendarReadTimeout extends Error {
  constructor() {
    super('calendar read timed out');
    this.name = 'CalendarReadTimeout';
  }
}

/**
 * Schedule questions answered from the owner's calendar (ADR-0110 D3–D6, CAL-2) as an ADR-0096 `pre-classify` turn
 * handler, order 150. Registered by the composition root ONLY when a `CalendarReader` is configured (D5), so with no
 * calendar the QUAL-7 routing is unchanged.
 *
 * - A message the reminder grammar recognizes is never claimed ("내일 9시에 회의 알려줘" stays a reminder).
 * - A calendar write request gets the fixed read-only refusal (D6); no read is made.
 * - A schedule question reads `[from, to)` in `QUOKY_TIMEZONE` once and answers with the deterministic list. There is no
 *   summary and no provider call of any kind (D4: summaries would be LOCAL-only, and the turn-handler `summarize`
 *   outcome cannot be restricted to a LOCAL provider, so none is ever returned — no Claude fallback for calendar text).
 * - A failed read is answered truthfully with fixed copy (never "no events"), status `FAILED`.
 * - The conversation history keeps a fixed note instead of the reply, so event text never reaches a later prompt.
 *
 * Creates no Task, TaskRun or ApprovalRequest; logs no message or event text.
 */
export class CalendarTurnHandler implements ConversationTurnHandler {
  readonly id = CALENDAR_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = CALENDAR_TURN_HANDLER_ORDER;
  readonly helpLines = CALENDAR_HELP_LINES;

  constructor(private readonly deps: CalendarTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    const text = ctx.message.text;
    let question: ReturnType<typeof parseCalendarQuestion>;
    try {
      if (parseReminderMessage(text, { now: ctx.now, timeZone: this.deps.timeZone }).kind !== 'NOT_REMINDER') return null;
      question = parseCalendarQuestion(text);
    } catch {
      return null;
    }
    if (question === null) return null;
    const language = question.language;
    if (question.kind === 'write-refused') {
      this.log('info', 'calendar.turn_handler.write_refused', {});
      return this.reply(ctx, renderCalendarWriteRefused(language), 'RESPONDED', language);
    }

    const window = placeCalendarSpan(question.span, ctx.now, this.deps.timeZone);
    if (window === undefined) return this.reply(ctx, renderCalendarInvalidDate(language), 'RESPONDED', language);

    let events: readonly CalendarEvent[];
    try {
      events = await this.readWithTimeout({ from: window.from, to: window.to, limit: CALENDAR_EVENTS_MAX_LIMIT });
    } catch (error) {
      const failure: CalendarReadFailure =
        error instanceof CalendarReadTimeout ? 'TIMEOUT' : isConnectorQueryError(error) ? error.reason : 'UNAVAILABLE';
      this.log('warn', 'calendar.turn_handler.read_failed', { span: question.span.kind, reason: failure });
      return this.reply(ctx, renderCalendarReadFailure(failure, language), 'FAILED', language);
    }
    this.log('info', 'calendar.turn_handler.answered', { span: question.span.kind, events: events.length });
    const reply = renderCalendarEvents(window, events, {
      timeZone: this.deps.timeZone,
      now: ctx.now,
      language,
      limit: CALENDAR_EVENTS_MAX_LIMIT,
    });
    return this.reply(ctx, reply, 'RESPONDED', language);
  }

  private reply(
    ctx: TurnHandlerContext,
    text: string,
    status: 'RESPONDED' | 'FAILED',
    language: CalendarLanguage,
  ): TurnHandlerReply {
    return {
      reply: { context: ctx.message.context, text, replyToMessageId: ctx.message.id },
      status,
      history: { assistant: renderCalendarHistoryNote(language) },
    };
  }

  private async readWithTimeout(query: Parameters<CalendarReader['listEvents']>[0]): Promise<readonly CalendarEvent[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CalendarReadTimeout()), this.deps.timeoutMs ?? CALENDAR_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.deps.reader.listEvents(query), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger?.[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

/** Factory for the composition root (ADR-0096 D7). */
export function createCalendarTurnHandler(deps: CalendarTurnHandlerDeps): CalendarTurnHandler {
  return new CalendarTurnHandler(deps);
}
