import {
  REMINDER_LIMITS,
  ReminderStatus,
  WorkItemStatus,
  type IsoTimestamp,
  type Reminder,
  type WorkItem,
} from '../../domain';
import { localDateOf, toZonedDateTime } from './zoned-time';

/**
 * Local-only daily brief (ADR-0101 D7). Pure: `now` and the zone are inputs, and the only data are the owner's
 * own reminders and ACTIVE local WorkItems that the caller already read through local repositories. It never
 * reaches a provider, connector, tool or network, and it mutates nothing.
 *
 * The brief is delivered by the DM-only path (the adapter enforces it); this module only composes the text.
 */

/** Entries listed per section; the rest is summarized as a count. */
export const DAILY_BRIEF_MAX_ENTRIES = 10;

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** `null` marks a source that could not be read; the brief says so instead of pretending it is empty. */
export interface DailyBriefInput {
  readonly now: IsoTimestamp;
  readonly timeZone: string;
  /** The owner's reminders (any status); only today's still-pending TEXT reminders are shown. */
  readonly reminders: readonly Reminder[] | null;
  /** The owner's WorkItems (any status); only ACTIVE ones are shown, titles where present. */
  readonly workItems: readonly WorkItem[] | null;
  /** The occurrence being delivered; with `late`, the header says it was scheduled earlier. */
  readonly occurrenceAt?: IsoTimestamp;
  readonly late?: boolean;
}

/** `오전 9:00` / `오후 3:30` (12-hour with a Korean meridiem marker). */
export function formatKoreanClock(hour: number, minute: number): string {
  const meridiem = hour < 12 ? '오전' : '오후';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${meridiem} ${hour12}:${String(minute).padStart(2, '0')}`;
}

/** `10/3 09:00` — the compact 24-hour form used for "scheduled at" notes. */
export function formatShortDateTime(instant: IsoTimestamp, timeZone: string): string {
  const z = toZonedDateTime(instant, timeZone);
  return `${z.month}/${z.day} ${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

/** Keep `@everyone`, `@here` and raw mention syntax from pinging when a title is echoed into a message. */
function neutralizeMentions(text: string): string {
  return text.replace(/@(?=everyone|here)/gi, '@​').replace(/<@/g, '<​@');
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function clampText(text: string): string {
  const chars = Array.from(text);
  const max = REMINDER_LIMITS.maxDeliveredTextChars;
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function todaysPendingReminders(input: DailyBriefInput): Reminder[] {
  if (input.reminders === null) return [];
  const today = localDateOf(input.now, input.timeZone);
  return input.reminders
    .filter((reminder) => {
      if (reminder.status !== ReminderStatus.SCHEDULED || reminder.kind !== 'TEXT') return false;
      if (reminder.nextFireAt === undefined) return false;
      const day = localDateOf(reminder.nextFireAt, input.timeZone);
      return day.year === today.year && day.month === today.month && day.day === today.day;
    })
    .sort(
      (a, b) =>
        Date.parse(a.nextFireAt ?? '') - Date.parse(b.nextFireAt ?? '') || a.displayNo - b.displayNo,
    );
}

function activeWorkItems(input: DailyBriefInput): WorkItem[] {
  if (input.workItems === null) return [];
  return input.workItems
    .filter((item) => item.status === WorkItemStatus.ACTIVE)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

function workItemLabel(item: WorkItem): string {
  const title = item.title?.trim();
  return title !== undefined && title.length > 0
    ? neutralizeMentions(truncate(title, 80))
    : `제목 없는 작업 (${item.id.slice(0, 8)})`;
}

/** Compose the brief text (Korean, no emoji, at most one delivered message). */
export function composeDailyBrief(input: DailyBriefInput): string {
  const today = toZonedDateTime(input.now, input.timeZone);
  let header = `오늘의 브리핑 · ${today.month}월 ${today.day}일(${WEEKDAY_KO[today.weekday]})`;
  if (input.late === true && input.occurrenceAt !== undefined) {
    header += ` (예정 ${formatShortDateTime(input.occurrenceAt, input.timeZone)}, 늦게 전달)`;
  }
  const lines: string[] = [header, ''];

  if (input.reminders === null) {
    lines.push('남은 알림: 불러오지 못했어요.');
  } else {
    const pending = todaysPendingReminders(input);
    if (pending.length === 0) {
      lines.push('오늘 남은 알림이 없어요.');
    } else {
      lines.push(`오늘 남은 알림 ${pending.length}건`);
      for (const reminder of pending.slice(0, DAILY_BRIEF_MAX_ENTRIES)) {
        const at = toZonedDateTime(reminder.nextFireAt ?? input.now, input.timeZone);
        lines.push(`- ${formatKoreanClock(at.hour, at.minute)} ${truncate(reminder.body, 60)} (#${reminder.displayNo})`);
      }
      if (pending.length > DAILY_BRIEF_MAX_ENTRIES) {
        lines.push(`- 외 ${pending.length - DAILY_BRIEF_MAX_ENTRIES}건`);
      }
    }
  }

  lines.push('');
  if (input.workItems === null) {
    lines.push('진행 중인 작업: 불러오지 못했어요.');
  } else {
    const active = activeWorkItems(input);
    if (active.length === 0) {
      lines.push('진행 중인 작업이 없어요.');
    } else {
      lines.push(`진행 중인 작업 ${active.length}건`);
      for (const item of active.slice(0, DAILY_BRIEF_MAX_ENTRIES)) lines.push(`- ${workItemLabel(item)}`);
      if (active.length > DAILY_BRIEF_MAX_ENTRIES) lines.push(`- 외 ${active.length - DAILY_BRIEF_MAX_ENTRIES}건`);
    }
  }
  return clampText(lines.join('\n'));
}
