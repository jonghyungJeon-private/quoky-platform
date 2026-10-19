import {
  REMINDER_LIMITS,
  ReminderStatus,
  type IsoTimestamp,
  type Reminder,
  type ReminderLastOutcome,
  type ReminderSchedule,
  type WorkItem,
  type MessageBody,
} from '../../domain';
import { withObjectParticle, withTopicParticle } from '../korean-particle';
import { containsCredentialMaterial } from '../credential-guard';
import { joinBody, messageBody, untrustedText, type MessagePart } from '../message-rendering';
import type { CalendarEvent } from '../../ports/calendar-reader.port';
import { EVENT_REMINDER_LOOKAHEAD_DAYS } from './event-reminder-calendar';
import type { EventReminderTarget } from './event-reminder-grammar';
import { composeDailyBrief, formatKoreanClock, type DailyBriefCalendar, type DailyBriefMail } from './daily-brief';
import type { ConnectorItem } from '../../ports/connector-provider.port';
import type { ReminderClarifyReason } from './reminder-grammar';
import { toZonedDateTime } from './zoned-time';

/**
 * Owner-facing reminder copy (ADR-0101 D5). Every reminder string — confirmations, clarifications, list, cancel
 * results, refusals, the delivered notification and the brief — is composed here, in Korean, without emoji. The
 * composer is stateless and pure: instants and zones are inputs; nothing is read from a clock.
 *
 * Bounded by `REMINDER_LIMITS`: a delivered text never exceeds `maxDeliveredTextChars`, a list never lists more
 * than fits one message, and no copy repeats a body more than once.
 */

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** Entries beyond what fits one reply are summarized as a count. */
const LIST_REPLY_MAX_CHARS = 1_800;
/** The status words of the reminder status view (owner-approved 2026-10-15). */
const REMINDER_STATUS_LABEL: Readonly<Record<ReminderStatus, string>> = {
  [ReminderStatus.SCHEDULED]: '예정',
  [ReminderStatus.FIRING]: '전달 중',
  [ReminderStatus.COMPLETED]: '보냄',
  [ReminderStatus.CANCELED]: '취소',
  [ReminderStatus.FAILED]: '전달 실패',
  [ReminderStatus.DELIVERY_UNCERTAIN]: '전달 확인 안 됨',
};
const LIST_BODY_PREVIEW_CHARS = 60;

const CLARIFY_COPY: Readonly<Record<ReminderClarifyReason, string>> = {
  PAST_TIME: '이미 지난 시각이에요. 앞으로의 시각으로 다시 말씀해 주세요. 예: "내일 오전 9시에 회의 준비 알려줘"',
  INVALID_DATE: '없는 날짜예요. 날짜를 확인해서 다시 말씀해 주세요. 예: "10월 20일 오후 3시에 서류 제출 알려줘"',
  INVALID_TIME: '올바르지 않은 시각이에요. 예: "오후 3시 30분에 전화하기 알려줘"',
  NONEXISTENT_TIME:
    '그 시각은 시간대 변경 때문에 존재하지 않아요. 다른 시각으로 다시 말씀해 주세요. 예: "내일 오전 9시에 회의 준비 알려줘"',
  TOO_FAR: `알림은 오늘부터 ${REMINDER_LIMITS.horizonDays}일 이내로만 설정할 수 있어요. 더 가까운 날짜로 다시 말씀해 주세요.`,
  TOO_SOON: '알림은 최소 1분 뒤부터 설정할 수 있어요. 예: "30분 뒤에 스트레칭 알려줘"',
  UNSUPPORTED_RECURRENCE:
    '하루에 한 번보다 자주 반복하는 알림이나 지원하지 않는 반복 방식이에요. 예: "매일 오전 8시에 약 먹기 알려줘", "매주 월요일 오전 9시에 주간 회의 알려줘", "평일 오후 6시에 퇴근 준비 알려줘"',
  MISSING_TIME:
    '언제 알려드릴지 알려 주세요. 예: "내일 오전 9시에 회의 준비 알려줘", "30분 뒤에 빨래 알려줘"',
  AMBIGUOUS_TIME:
    '시각이 모호해서 알림을 만들지 않았어요. 오전/오후와 시각을 한 번에 적어 주세요. 예: "내일 오후 7시에 저녁 약속 알려줘"',
  EMPTY_BODY: '무엇을 알려드릴지 알려 주세요. 예: "내일 오전 9시에 회의 준비 알려줘"',
  BODY_TOO_LONG: `알림 내용은 ${REMINDER_LIMITS.maxBodyChars}자 이하로 적어 주세요.`,
  INVALID_REMINDER_NUMBER: '알림 번호를 확인해 주세요. 번호는 "알림 목록"에서 볼 수 있어요. 예: "알림 4 취소"',
  BULK_CANCEL_UNSUPPORTED: '알림은 한 번에 하나씩만 취소할 수 있어요. 예: "알림 4 취소"',
  EVENT_OFFSET_OUT_OF_RANGE: `회의 전 알림은 ${REMINDER_LIMITS.minEventOffsetMinutes}분에서 ${REMINDER_LIMITS.maxEventOffsetMinutes / 60}시간 전 사이로만 만들 수 있어요. 예: "회의 10분 전에 알려줘"`,
  EVENT_OFFSET_MISSING: '회의 몇 분 전에 알려드릴지 알려 주세요. 예: "회의 10분 전에 알려줘", "다음 회의 30분 전에 알려줘"',
};

/** ADR-0117 D5: an event title echoed in reminder copy is an untrusted span, clipped, credential-guarded. */
export const EVENT_REMINDER_TITLE_DISPLAY_MAX_CHARS = 60;
/** The title stored as an event-relative reminder's body: bounded and already credential-guarded. */
const EVENT_REMINDER_TITLE_STORED_MAX_CHARS = 100;
const EVENT_TITLE_HIDDEN = '(제목 숨김)';
const EVENT_TITLE_NONE = '(제목 없음)';

/**
 * The body stored for an event-relative reminder (ADR-0117 D5): the event's title, single-line and bounded, or a fixed
 * placeholder when it is empty or credential-shaped (a credential-shaped title is never stored).
 */
export function eventReminderStoredTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const line = title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (line.length === 0) return EVENT_TITLE_NONE;
  if (containsCredentialMaterial(title)) return EVENT_TITLE_HIDDEN;
  return preview(line, EVENT_REMINDER_TITLE_STORED_MAX_CHARS);
}

/** An event title in copy: an untrusted `markup` span, or Quoky's own placeholder. */
function eventTitlePart(title: string): MessagePart {
  const stored = eventReminderStoredTitle(title);
  if (stored === EVENT_TITLE_NONE || stored === EVENT_TITLE_HIDDEN) return stored;
  return untrustedText(preview(stored, EVENT_REMINDER_TITLE_DISPLAY_MAX_CHARS));
}

/** `10분`, `1시간`, `1시간 30분`. */
export function eventOffsetLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}분`;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/** `회의 10분 전`: the list / brief label of an event-relative reminder. */
function eventRepeatLabel(minutes: number): string {
  return `회의 ${eventOffsetLabel(minutes)} 전`;
}

/** A start time: the clock alone on `reference`'s local day, else `10월 9일 오후 3:00`. */
function startLabel(start: IsoTimestamp, reference: IsoTimestamp, timeZone: string): string {
  const at = toZonedDateTime(start, timeZone);
  const ref = toZonedDateTime(reference, timeZone);
  const clock = formatKoreanClock(at.hour, at.minute);
  if (at.year === ref.year && at.month === ref.month && at.day === ref.day) return clock;
  return `${at.month}월 ${at.day}일 ${clock}`;
}

/** How the fire-time re-check went, for the delivered text (ADR-0117 D6). */
export type EventReminderDeliveryNote =
  /** The event is where it was. */
  | 'none'
  /** The calendar could not be re-read: delivered as scheduled, with a note. */
  | 'unverified'
  /** The event moved earlier than this reminder's due time: delivered now, with the new start. */
  | 'moved-earlier';

export interface EventReminderDeliveryInput {
  readonly displayNo: number;
  /** The event's title now (re-read), or the stored title when the event could not be re-read. */
  readonly title: string;
  /** The event's start now (re-read), or the start the reminder was scheduled for. */
  readonly startAt: IsoTimestamp;
  readonly offsetMinutes: number;
  readonly note: EventReminderDeliveryNote;
  readonly occurrenceAt: IsoTimestamp;
  readonly late: boolean;
  readonly timeZone: string;
  readonly deliveredAt: IsoTimestamp;
}

export interface EventReminderCanceledInput {
  readonly displayNo: number;
  readonly title: string;
  /** `gone`: not in the calendar any more; `all-day`: the event became an all-day event. */
  readonly reason: 'gone' | 'all-day';
}

function clampDelivered(text: string): string {
  const chars = Array.from(text);
  const max = REMINDER_LIMITS.maxDeliveredTextChars;
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function preview(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** `10월 3일(토) 오전 9:00`, with the year only when it is not the current one. */
function formatAbsolute(instant: IsoTimestamp, timeZone: string, now: IsoTimestamp): string {
  const at = toZonedDateTime(instant, timeZone);
  const current = toZonedDateTime(now, timeZone);
  const year = at.year === current.year ? '' : `${at.year}년 `;
  return `${year}${at.month}월 ${at.day}일(${WEEKDAY_KO[at.weekday]}) ${formatKoreanClock(at.hour, at.minute)}`;
}

function isWeekdaysOnly(days: readonly number[]): boolean {
  return days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day));
}

/** `1회`, `매일`, `평일`, `매주 월·수`. */
export function reminderRepeatLabel(schedule: ReminderSchedule): string {
  switch (schedule.type) {
    case 'ONCE':
      return '1회';
    case 'DAILY':
      return '매일';
    case 'WEEKLY': {
      if (isWeekdaysOnly(schedule.weekdays)) return '평일';
      const days = [...schedule.weekdays].sort((a, b) => a - b).map((day) => WEEKDAY_KO[day]);
      return `매주 ${days.join('·')}`;
    }
  }
}

/**
 * A6 R5a preview (§3.1): when a reminder the owner has not created yet would fire, in absolute terms: `10월 17일(금) 오전
 * 9:00 · 한 번`, or `매일 오전 9:00 (첫 알림 10월 17일(금) 오전 9:00)`.
 */
export function reminderWhenPreviewLabel(schedule: ReminderSchedule, firstFireAt: IsoTimestamp, timeZone: string, now: IsoTimestamp): string {
  if (schedule.type === 'ONCE') return `${formatAbsolute(firstFireAt, timeZone, now)} · 한 번`;
  return `${reminderRepeatLabel(schedule)} ${recurringClock(schedule)} (첫 알림 ${formatAbsolute(firstFireAt, timeZone, now)})`;
}

function recurringClock(schedule: ReminderSchedule): string {
  return schedule.type === 'ONCE' ? '' : formatKoreanClock(schedule.time.hour, schedule.time.minute);
}

function lastOutcomeLabel(outcome: ReminderLastOutcome): string {
  switch (outcome.outcome) {
    case 'SENT':
      return '전달됨';
    case 'FAILED':
      return '전달 실패';
    case 'DELIVERY_UNCERTAIN':
      return '전달 여부 불확실';
    case 'SKIPPED_MISSED':
      return '시간이 지나 건너뜀';
  }
}

/** `(원래 오후 10:11 예정 — 늦게 전달됐어요)`, with `10월 2일 ` before the clock when the day differs from delivery. */
function lateNote(input: ReminderDeliveryTextInput): string {
  const at = toZonedDateTime(input.occurrenceAt, input.timeZone);
  let day = '';
  if (input.deliveredAt !== undefined) {
    const now = toZonedDateTime(input.deliveredAt, input.timeZone);
    if (now.year !== at.year || now.month !== at.month || now.day !== at.day) day = `${at.month}월 ${at.day}일 `;
  }
  return `(원래 ${day}${formatKoreanClock(at.hour, at.minute)} 예정 — 늦게 전달됐어요)`;
}

export interface ReminderDeliveryTextInput {
  readonly displayNo: number;
  readonly body: string;
  /** The occurrence being delivered. */
  readonly occurrenceAt: IsoTimestamp;
  readonly late: boolean;
  readonly timeZone: string;
  /** Delivery instant; when given and the scheduled local day differs, the late note includes the date. */
  readonly deliveredAt?: IsoTimestamp;
}

export interface ReminderBriefTextInput {
  readonly now: IsoTimestamp;
  readonly timeZone: string;
  readonly reminders: readonly Reminder[] | null;
  readonly workItems: readonly WorkItem[] | null;
  readonly occurrenceAt?: IsoTimestamp;
  readonly late?: boolean;
  /** ADR-0117 D1: omitted = no calendar configured (no section); `null` = could not be read. */
  readonly calendar?: DailyBriefCalendar | null;
  /** ADR-0117 D2: omitted = the section is off; `null` = could not be read. */
  readonly assignedWork?: readonly ConnectorItem[] | null;
  /** ADR-0117 BRF-3: omitted = the section is off; `null` = could not be read. */
  readonly mail?: DailyBriefMail | null;
}

/** ADR-0120 amendment A6-D3: the undo hint of a natural-language reminder action (the 10-minute window). */
const A6_UNDO_HINT = '되돌리려면 "되돌려줘" (10분 안)';

export class ReminderReplyComposer {
  /** "10월 3일(토) 오전 9:00에 '회의 준비' 알려드릴게요. (#4 · 취소: '알림 4 취소')" */
  created(reminder: Reminder, now: IsoTimestamp): string {
    const cancelHint = `(#${reminder.displayNo} · 취소: '알림 ${reminder.displayNo} 취소')`;
    const what = reminder.kind === 'BRIEF' ? '오늘의 브리핑을 DM으로 보내 드릴게요.' : `'${reminder.body}' 알려드릴게요.`;
    const first = reminder.nextFireAt ?? reminder.occurrenceAt;
    if (reminder.schedule.type === 'ONCE' || first === undefined) {
      const when = formatAbsolute(first ?? now, reminder.timeZone, now);
      return `${when}에 ${what} ${cancelHint}`;
    }
    const repeat = reminderRepeatLabel(reminder.schedule);
    const clock = recurringClock(reminder.schedule);
    return `${repeat} ${clock}에 ${what} 첫 알림은 ${formatAbsolute(first, reminder.timeZone, now)}이에요. ${cancelHint}`;
  }

  clarify(reason: ReminderClarifyReason): string {
    return CLARIFY_COPY[reason];
  }

  // -- ADR-0120 amendment A6: echoes of natural-language reminder actions (never used by the anchored grammar) -------

  /** When the reminder fires, in absolute terms (and its recurrence). */
  private scheduleText(reminder: Reminder, now: IsoTimestamp): string {
    const first = reminder.nextFireAt ?? reminder.occurrenceAt;
    if (reminder.schedule.type === 'ONCE' || first === undefined) return `${formatAbsolute(first ?? now, reminder.timeZone, now)}`;
    return `${reminderRepeatLabel(reminder.schedule)} ${recurringClock(reminder.schedule)} (첫 알림 ${formatAbsolute(first, reminder.timeZone, now)})`;
  }

  /** A6-D3 echo: `알림 #N을 만들었어요: 10월 15일(목) 오전 9:00 · '물 마시기' · 되돌리려면 "되돌려줘" (10분 안)`. */
  actionCreated(reminder: Reminder, now: IsoTimestamp): string {
    const what = reminder.kind === 'BRIEF' ? '오늘의 브리핑' : `'${reminder.body}'`;
    return `${withObjectParticle(`알림 #${reminder.displayNo}`)} 만들었어요: ${this.scheduleText(reminder, now)} · ${what} · ${A6_UNDO_HINT}`;
  }

  /** A6-D3 echo of a natural-language cancel. */
  actionCanceled(reminder: Reminder): string {
    return `${this.canceled(reminder)} · ${A6_UNDO_HINT}`;
  }

  /** Record A: the same reminder (same #N) is scheduled again. */
  actionReactivated(reminder: Reminder, now: IsoTimestamp): string {
    return `${withObjectParticle(`알림 #${reminder.displayNo}`)} 다시 켰어요: ${this.scheduleText(reminder, now)}`;
  }

  /** Record A: an inverse that cannot run, said plainly; nothing changed. */
  undoRefused(reason: 'fired' | 'changed' | 'event-gone' | 'event-moved' | 'event-unreadable' | 'in-flight' | 'not-found' | 'schedule'): string {
    switch (reason) {
      case 'event-moved':
        return '그 일정의 시간이 바뀌어서 알림을 다시 켜지 않았어요. 새 시간 기준 알림이 필요하면 다시 말씀해 주세요.';
      case 'event-unreadable':
        return '그 일정을 지금 확인할 수 없어서 알림을 다시 켜지 않았어요.';
      case 'fired':
        return '이미 알림이 나갔어요. 되돌릴 게 없어요.';
      case 'changed':
        return '그 뒤에 바뀐 알림이라 되돌리지 않았어요. 아무것도 바꾸지 않았어요.';
      case 'event-gone':
        return '그 일정이 이미 지났거나 없어져서 알림을 다시 켤 수 없어요.';
      case 'in-flight':
        return '알림을 지금 보내는 중이라 되돌릴 수 없어요.';
      case 'not-found':
        return '되돌릴 알림을 찾지 못했어요. 아무것도 바꾸지 않았어요.';
      case 'schedule':
        return '원래 한 번만 울리는 알림이에요. 한 번 울릴 시간을 말씀해 주세요.';
    }
  }

  /** Record A: undoing the cancel of a one-shot whose time passed asks for a new time (the reminder id is kept). */
  undoAskTime(displayNo: number): string {
    return `알림 #${displayNo}의 시간이 이미 지났어요. 언제 다시 알려 드릴까요?`;
  }

  /**
   * ADR-0117 D5: "10월 9일(금) 오후 2:50에 알려드릴게요: 디자인 리뷰 (오후 3:00 시작, 10분 전). …(#5 · 취소: '알림 5 취소')".
   * The title is the one stored on the reminder (an untrusted span).
   */
  eventCreated(reminder: Reminder, eventStart: IsoTimestamp, now: IsoTimestamp): MessageBody {
    const fireAt = reminder.nextFireAt ?? reminder.occurrenceAt ?? now;
    const offset = reminder.event?.offsetMinutes ?? 0;
    return messageBody(
      `${formatAbsolute(fireAt, reminder.timeZone, now)}에 알려드릴게요: `,
      eventTitlePart(reminder.body),
      ` (${startLabel(eventStart, fireAt, reminder.timeZone)} 시작, ${eventOffsetLabel(offset)} 전). `,
      '일정이 옮겨지면 알림도 따라 옮기고, 일정이 삭제되면 알림을 취소해요. ',
      `(#${reminder.displayNo} · 취소: '알림 ${reminder.displayNo} 취소')`,
    );
  }

  /** No calendar is configured: an event-relative reminder cannot be made. */
  eventCalendarUnavailable(): string {
    return '캘린더가 연결되어 있지 않아 회의 기준 알림을 만들 수 없어요. 시각을 직접 말씀해 주세요. 예: "오후 2시 50분에 회의 준비 알려줘"';
  }

  /** The calendar read failed or timed out: nothing was created (never "no meeting"). */
  eventCalendarReadFailed(): string {
    return '캘린더를 읽지 못해 회의 전 알림을 만들지 않았어요. 잠시 후 다시 시도해 주세요.';
  }

  /** Nothing matched in the window that was read. */
  eventNotFound(target: EventReminderTarget, partial: boolean): string {
    const where = target.dayOffset !== undefined ? '그날 일정에서' : `앞으로 ${EVENT_REMINDER_LOOKAHEAD_DAYS}일 일정에서`;
    const named = target.title !== undefined || target.time !== undefined || target.weekday !== undefined;
    const what = named ? `말씀하신 일정을 ${where} 찾지 못해` : `${where} 아직 시작하지 않은 시간 지정 일정을 찾지 못해`;
    const more = partial ? ' 일정이 많아 앞쪽 일부만 확인했어요.' : '';
    return `${what} 알림을 만들지 않았어요.${more} "이번 주 일정"으로 일정을 확인해 보세요.`;
  }

  /** Only an all-day event matched: it has no start time to be early for. */
  eventAllDay(event: CalendarEvent): MessageBody {
    return messageBody(
      '종일 일정(',
      eventTitlePart(event.title),
      ')에는 몇 분 전 알림을 만들 수 없어요. 시각을 정해 말씀해 주세요. 예: "내일 오전 9시에 회의 준비 알려줘"',
    );
  }

  /** The event starts too soon for the offset. */
  eventTooSoon(event: CalendarEvent, offsetMinutes: number, now: IsoTimestamp, timeZone: string): MessageBody {
    return messageBody(
      eventTitlePart(event.title),
      ` 일정이 ${startLabel(event.start, now, timeZone)}에 시작해서 ${eventOffsetLabel(offsetMinutes)} 전 알림 시각이 이미 지났거나 1분도 남지 않았어요. `,
      '더 짧게 말씀해 주세요. 예: "회의 5분 전에 알려줘"',
    );
  }

  /** Several events match: the owner names one by its title or time; nothing was created. */
  eventAmbiguous(candidates: readonly CalendarEvent[], now: IsoTimestamp, timeZone: string): MessageBody {
    const lines: MessagePart[] = [
      '어느 일정인지 하나로 정할 수 없어 알림을 만들지 않았어요. 제목이나 시각을 붙여 다시 말씀해 주세요.',
      ...candidates.map((event) => messageBody(`- ${formatAbsolute(event.start, timeZone, now)} `, eventTitlePart(event.title))),
      '예: "오후 3시 주간 회의 10분 전에 알려줘"',
    ];
    return joinBody(lines);
  }

  /** ADR-0117 D6: the delivered pre-meeting reminder (deterministic; the title is an untrusted span). */
  eventDelivery(input: EventReminderDeliveryInput): MessageBody {
    const start = startLabel(input.startAt, input.deliveredAt, input.timeZone);
    const offset = eventOffsetLabel(input.offsetMinutes);
    const main =
      input.note === 'moved-earlier'
        ? ` 일정이 ${start} 시작으로 앞당겨졌어요.${Date.parse(input.startAt) <= Date.parse(input.deliveredAt) ? ' 이미 시작했어요.' : ''} (${offset} 전 알림)`
        : ` 일정이 ${start}에 시작해요. (${offset} 전 알림)`;
    const unverified = input.note === 'unverified' ? ' (캘린더를 다시 확인하지 못해 처음 확인한 시각 기준으로 알려드려요)' : '';
    const late = input.late
      ? ` ${lateNote({ displayNo: input.displayNo, body: '', occurrenceAt: input.occurrenceAt, late: true, timeZone: input.timeZone, deliveredAt: input.deliveredAt })}`
      : '';
    return messageBody(`알림 #${input.displayNo}: `, eventTitlePart(input.title), `${main}${unverified}${late}`);
  }

  /** ADR-0117 D6: the note that tells the owner a pre-meeting reminder was canceled by the re-check. */
  eventCanceledDelivery(input: EventReminderCanceledInput): MessageBody {
    const why =
      input.reason === 'all-day'
        ? ' 일정이 종일 일정으로 바뀌어 회의 전 알림을 취소했어요.'
        : ' 일정을 캘린더에서 찾을 수 없어(삭제·취소됐거나 30일 넘게 옮겨졌어요) 회의 전 알림을 취소했어요.';
    return messageBody(`알림 #${input.displayNo} 취소: `, eventTitlePart(input.title), why);
  }

  /** `알림 목록`: number, local time, repeat label and body; bounded to one message. */
  list(reminders: readonly Reminder[], now: IsoTimestamp): MessageBody {
    return this.listRendered(reminders, now).body;
  }

  /**
   * {@link list} plus how many reminders it actually shows (the character budget can stop it early): ADR-0120 amendment
   * A6 records exactly the rows the owner saw, never one the budget cut.
   */
  listRendered(reminders: readonly Reminder[], now: IsoTimestamp, period?: string): { readonly body: MessageBody; readonly shown: number } {
    if (reminders.length === 0) {
      // Owner decision of 2026-10-19: a period-filtered list names the period ("내일 예정된 알림이 없어요.").
      if (period !== undefined) return { body: `${period} 예정된 알림이 없어요.`, shown: 0 };
      return { body: '예정된 알림이 없어요. 예: "내일 오전 9시에 회의 준비 알려줘"', shown: 0 };
    }
    const header = period === undefined ? `예정된 알림 ${reminders.length}건` : `${period} 예정된 알림 ${reminders.length}건`;
    const lines: MessagePart[] = [];
    let used = Array.from(header).length;
    for (const reminder of reminders) {
      const next = reminder.nextFireAt ?? reminder.occurrenceAt;
      const when = next === undefined ? '' : formatAbsolute(next, reminder.timeZone, now);
      const event = reminder.event;
      const bodyText =
        reminder.kind === 'BRIEF'
          ? '오늘의 브리핑(DM)'
          : preview(event !== undefined ? eventReminderStoredTitle(reminder.body) : reminder.body, event !== undefined ? EVENT_REMINDER_TITLE_DISPLAY_MAX_CHARS : LIST_BODY_PREVIEW_CHARS);
      const state = reminder.status === ReminderStatus.FIRING ? ' · 전달 중' : '';
      const last =
        reminder.lastOutcome !== undefined && reminder.schedule.type !== 'ONCE'
          ? ` · 지난 알림: ${lastOutcomeLabel(reminder.lastOutcome)}`
          : '';
      const label = event !== undefined ? eventRepeatLabel(event.offsetMinutes) : reminderRepeatLabel(reminder.schedule);
      const prefix = `#${reminder.displayNo} ${when} [${label}] `;
      // The budget counts the plain text; an event title (an untrusted span) is bounded at 60 characters, and the
      // 40-character reserve covers its escaping on a markup platform.
      const length = Array.from(`${prefix}${bodyText}${state}${last}`).length + 1;
      if (used + length > LIST_REPLY_MAX_CHARS - 40 - (event !== undefined ? EVENT_REMINDER_TITLE_DISPLAY_MAX_CHARS : 0)) break;
      lines.push(event !== undefined ? messageBody(prefix, eventTitlePart(reminder.body), `${state}${last}`) : `${prefix}${bodyText}${state}${last}`);
      used += length;
    }
    const omitted = reminders.length - lines.length;
    const tail = omitted > 0 ? [`외 ${omitted}건은 생략했어요.`] : [];
    return { body: joinBody([header, ...lines, ...tail]), shown: lines.length };
  }

  /**
   * A read-only status view (owner-approved 2026-10-15): the canceled, already sent or all reminders, each with its `#N`
   * and its status. Same character budget as {@link listRendered}.
   */
  statusListRendered(reminders: readonly Reminder[], status: 'canceled' | 'done' | 'all', now: IsoTimestamp): { readonly body: MessageBody; readonly shown: number } {
    const viewName = status === 'canceled' ? '취소된 알림' : status === 'done' ? '지난 알림' : '전체 알림';
    if (reminders.length === 0) return { body: `${viewName}이 없어요.`, shown: 0 };
    const header = `${viewName} ${reminders.length}건`;
    const lines: MessagePart[] = [];
    let used = Array.from(header).length;
    for (const reminder of reminders) {
      const event = reminder.event;
      const bodyText =
        reminder.kind === 'BRIEF'
          ? '오늘의 브리핑(DM)'
          : preview(event !== undefined ? eventReminderStoredTitle(reminder.body) : reminder.body, event !== undefined ? EVENT_REMINDER_TITLE_DISPLAY_MAX_CHARS : LIST_BODY_PREVIEW_CHARS);
      const next = reminder.status === ReminderStatus.SCHEDULED || reminder.status === ReminderStatus.FIRING ? reminder.nextFireAt ?? reminder.occurrenceAt : undefined;
      const when = next === undefined ? '' : `${formatAbsolute(next, reminder.timeZone, now)} `;
      const label = event !== undefined ? eventRepeatLabel(event.offsetMinutes) : reminderRepeatLabel(reminder.schedule);
      const prefix = `#${reminder.displayNo} ${when}[${label}] `;
      const state = ` · ${REMINDER_STATUS_LABEL[reminder.status]}`;
      const length = Array.from(`${prefix}${bodyText}${state}`).length + 1;
      if (used + length > LIST_REPLY_MAX_CHARS - 40 - (event !== undefined ? EVENT_REMINDER_TITLE_DISPLAY_MAX_CHARS : 0)) break;
      lines.push(event !== undefined ? messageBody(prefix, eventTitlePart(reminder.body), state) : `${prefix}${bodyText}${state}`);
      used += length;
    }
    const omitted = reminders.length - lines.length;
    const tail = omitted > 0 ? [`외 ${omitted}건은 생략했어요.`] : [];
    return { body: joinBody([header, ...lines, ...tail]), shown: lines.length };
  }

  canceled(reminder: Reminder): string {
    // An event-relative reminder's body is an event title (untrusted): this plain-text reply never echoes it.
    if (reminder.event !== undefined) {
      return `알림 #${reminder.displayNo} 취소했어요: ${eventRepeatLabel(reminder.event.offsetMinutes)} 알림`;
    }
    const subject = reminder.kind === 'BRIEF' ? '오늘의 브리핑' : `'${preview(reminder.body, LIST_BODY_PREVIEW_CHARS)}'`;
    return `알림 #${reminder.displayNo} 취소했어요: ${subject}`;
  }

  cancelNotFound(displayNo: number): string {
    return `${withObjectParticle(`알림 #${displayNo}`)} 찾지 못했어요. "알림 목록"에서 번호를 확인해 주세요.`;
  }

  /** Owner decision C (2026-10-17): a reminder `match` that names no scheduled reminder; nothing changed. */
  cancelMatchNotFound(): string {
    return '그 내용의 예정된 알림을 찾지 못했어요. 아무것도 바꾸지 않았어요. "알림 목록"에서 번호를 확인해 주세요.';
  }

  /**
   * Owner decision C (2026-10-17): several scheduled reminders carry the owner's words. Each candidate under its stable
   * `#N`, its next time and its body (an event title stays an untrusted span); nothing changed.
   */
  actionWhich(candidates: readonly Reminder[], now: IsoTimestamp): MessageBody {
    const rows = candidates.map((reminder) => {
      const next = reminder.nextFireAt ?? reminder.occurrenceAt;
      const prefix = `#${reminder.displayNo} ${next === undefined ? '' : `${formatAbsolute(next, reminder.timeZone, now)} `}`;
      return reminder.event !== undefined ? messageBody(prefix, eventTitlePart(reminder.body)) : `${prefix}${preview(reminder.body, LIST_BODY_PREVIEW_CHARS)}`;
    });
    return joinBody(['어느 알림인가요? 번호로 답해 주세요. 아직 아무것도 바꾸지 않았어요.', ...rows]);
  }

  cancelAlreadyFinal(reminder: Reminder): string {
    switch (reminder.status) {
      case ReminderStatus.COMPLETED:
        return `${withTopicParticle(`알림 #${reminder.displayNo}`)} 이미 전달됐어요.`;
      case ReminderStatus.CANCELED:
        return `${withTopicParticle(`알림 #${reminder.displayNo}`)} 이미 취소됐어요.`;
      case ReminderStatus.FAILED:
        return `${withTopicParticle(`알림 #${reminder.displayNo}`)} 전달에 실패해서 이미 종료됐어요.`;
      case ReminderStatus.DELIVERY_UNCERTAIN:
        return `${withTopicParticle(`알림 #${reminder.displayNo}`)} 전달 여부를 확인할 수 없어 종료됐어요. 다시 보내지 않아요.`;
      default:
        return `${withTopicParticle(`알림 #${reminder.displayNo}`)} 이미 종료됐어요.`;
    }
  }

  cancelInFlight(displayNo: number): string {
    return `${withTopicParticle(`알림 #${displayNo}`)} 지금 전달 중이라 취소할 수 없어요.`;
  }

  limitReached(activeCount: number): string {
    return `예정된 알림이 ${activeCount}건으로 최대 ${REMINDER_LIMITS.maxActivePerActor}건에 도달했어요. 불필요한 알림을 취소한 뒤 다시 요청해 주세요. 예: "알림 4 취소"`;
  }

  disabled(): string {
    return '알림 기능이 꺼져 있어요. 켠 뒤에 다시 요청해 주세요.';
  }

  credentialRefused(): string {
    return '알림 내용에 비밀번호나 토큰처럼 보이는 값이 있어 저장하지 않았어요. 민감한 값은 빼고 다시 요청해 주세요.';
  }

  storageFailure(): string {
    return '알림을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }

  /** The delivered notification: "알림 #4: 회의 준비", with the late variant when it was not on time. */
  delivery(input: ReminderDeliveryTextInput): string {
    const late = input.late ? ` ${lateNote(input)}` : '';
    const prefix = `알림 #${input.displayNo}: `;
    const suffixChars = Array.from(late).length;
    const bodyBudget = REMINDER_LIMITS.maxDeliveredTextChars - Array.from(prefix).length - suffixChars;
    return clampDelivered(`${prefix}${preview(input.body, Math.max(1, bodyBudget))}${late}`);
  }

  /** The note an adapter appends when a channel delivery fell back to the owner DM. */
  fallbackDmNote(): string {
    return '(원래 채널로 보낼 수 없어 DM으로 전달했어요)';
  }

  /** The local daily brief template (today's remaining reminders and ACTIVE WorkItem titles). */
  brief(input: ReminderBriefTextInput): MessageBody {
    return composeDailyBrief(input);
  }
}
