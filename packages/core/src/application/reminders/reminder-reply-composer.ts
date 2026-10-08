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
import { composeDailyBrief, formatKoreanClock, type DailyBriefCalendar } from './daily-brief';
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
};

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
}

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

  /** `알림 목록`: number, local time, repeat label and body; bounded to one message. */
  list(reminders: readonly Reminder[], now: IsoTimestamp): string {
    if (reminders.length === 0) {
      return '예정된 알림이 없어요. 예: "내일 오전 9시에 회의 준비 알려줘"';
    }
    const header = `예정된 알림 ${reminders.length}건`;
    const lines: string[] = [];
    let used = Array.from(header).length;
    for (const reminder of reminders) {
      const next = reminder.nextFireAt ?? reminder.occurrenceAt;
      const when = next === undefined ? '' : formatAbsolute(next, reminder.timeZone, now);
      const body = reminder.kind === 'BRIEF' ? '오늘의 브리핑(DM)' : preview(reminder.body, LIST_BODY_PREVIEW_CHARS);
      const state = reminder.status === ReminderStatus.FIRING ? ' · 전달 중' : '';
      const last =
        reminder.lastOutcome !== undefined && reminder.schedule.type !== 'ONCE'
          ? ` · 지난 알림: ${lastOutcomeLabel(reminder.lastOutcome)}`
          : '';
      const line = `#${reminder.displayNo} ${when} [${reminderRepeatLabel(reminder.schedule)}] ${body}${state}${last}`;
      const length = Array.from(line).length + 1;
      if (used + length > LIST_REPLY_MAX_CHARS - 40) break;
      lines.push(line);
      used += length;
    }
    const omitted = reminders.length - lines.length;
    const tail = omitted > 0 ? [`외 ${omitted}건은 생략했어요.`] : [];
    return [header, ...lines, ...tail].join('\n');
  }

  canceled(reminder: Reminder): string {
    const subject = reminder.kind === 'BRIEF' ? '오늘의 브리핑' : `'${preview(reminder.body, LIST_BODY_PREVIEW_CHARS)}'`;
    return `알림 #${reminder.displayNo} 취소했어요: ${subject}`;
  }

  cancelNotFound(displayNo: number): string {
    return `${withObjectParticle(`알림 #${displayNo}`)} 찾지 못했어요. "알림 목록"에서 번호를 확인해 주세요.`;
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
