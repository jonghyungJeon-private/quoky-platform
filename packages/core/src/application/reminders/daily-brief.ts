import {
  REMINDER_LIMITS,
  ReminderStatus,
  WorkItemStatus,
  type IsoTimestamp,
  type MessageBody,
  type Reminder,
  type WorkItem,
} from '../../domain';
import type { CalendarEvent } from '../../ports/calendar-reader.port';
import type { ConnectorItem } from '../../ports/connector-provider.port';
import { calendarDayEventLines } from '../calendar/calendar-reply-renderer';
import { containsCredentialMaterial } from '../credential-guard';
import { clipMessage, joinBody, messageBody, untrustedText } from '../message-rendering';
import type { MessagePart } from '../message-rendering';
import { localDateOf, toZonedDateTime, type LocalDate } from './zoned-time';

/**
 * The daily brief (ADR-0101 D7, amended by ADR-0117). Pure: `now` and the zone are inputs, and the data are what the
 * caller already read: the owner's own reminders and ACTIVE local WorkItems (local repositories), and — only when they
 * are configured — today's calendar events (ADR-0117 D1) and the owner's assigned work items (ADR-0117 D2, opt-in).
 * It never reaches a provider, connector, tool or network itself, calls no model, and mutates nothing.
 *
 * The brief is delivered by the DM-only path (the adapter enforces it); this module only composes the text.
 */

/** Entries listed per section; the rest is summarized as a count. */
export const DAILY_BRIEF_MAX_ENTRIES = 10;
/** Assigned work items listed (ADR-0117 D2: at most 5, key and title only); the rest is summarized as a count. */
export const DAILY_BRIEF_MAX_WORK_ENTRIES = 5;
const DAILY_BRIEF_WORK_TITLE_MAX_CHARS = 80;
const DAILY_BRIEF_WORK_KEY_MAX_CHARS = 40;

/** Today's calendar read (ADR-0117 D1): the events the read returned and the `limit` it used. */
export interface DailyBriefCalendar {
  readonly events: readonly CalendarEvent[];
  /** A read that returned `limit` events may have more: the count then says "이상". */
  readonly limit: number;
}

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
  /**
   * ADR-0117 D1. Omitted: no calendar is configured and the section is left out (the brief is then byte-identical to
   * the local-only brief). `null`: the calendar could not be read, which the brief says (never an empty day).
   */
  readonly calendar?: DailyBriefCalendar | null;
  /**
   * ADR-0117 D2 (`QUOKY_BRIEF_JIRA_ENABLED`, default off). Omitted: the section is off. `null`: the items could not be
   * read. Otherwise the owner's assigned open items as read; only those due or updated today (in `timeZone`) are shown.
   */
  readonly assignedWork?: readonly ConnectorItem[] | null;
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

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** The brief stays inside one delivered message (the bound applies to the platform's rendering). */
function clampText(body: MessageBody): MessageBody {
  return messageBody(clipMessage(body, REMINDER_LIMITS.maxDeliveredTextChars, 'code-points'));
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

/** A WorkItem title echoed into the brief: an untrusted span whose mentions the platform keeps from pinging. */
function workItemLabel(item: WorkItem): MessagePart {
  const title = item.title?.trim();
  return title !== undefined && title.length > 0
    ? untrustedText(truncate(title, 80), 'mentions')
    : `제목 없는 작업 (${item.id.slice(0, 8)})`;
}

function isoDate(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function sameLocalDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function oneLine(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/**
 * The assigned items due today or updated today (in `timeZone`), deduplicated by key: due today first, then the most
 * recently updated. An item whose key is missing or credential-shaped is dropped.
 */
export function dailyBriefWorkForToday(
  items: readonly ConnectorItem[],
  now: IsoTimestamp,
  timeZone: string,
): ConnectorItem[] {
  const today = localDateOf(now, timeZone);
  const todayIso = isoDate(today);
  const updatedMs = (item: ConnectorItem): number => {
    const ms = item.updatedAt === undefined ? Number.NaN : Date.parse(item.updatedAt);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  const isDueToday = (item: ConnectorItem): boolean => item.dueDate === todayIso;
  const seen = new Set<string>();
  const kept: ConnectorItem[] = [];
  for (const item of items) {
    const key = oneLine(item.id);
    if (key.length === 0 || seen.has(key) || containsCredentialMaterial(item.id)) continue;
    const updated = updatedMs(item);
    const updatedToday = Number.isFinite(updated) && sameLocalDate(localDateOf(updated, timeZone), today);
    if (!isDueToday(item) && !updatedToday) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept.sort(
    (a, b) => Number(isDueToday(b)) - Number(isDueToday(a)) || updatedMs(b) - updatedMs(a) || a.id.localeCompare(b.id),
  );
}

/** "- PROJ-12 로그인 오류 수정": key and title only, both untrusted spans; a credential-shaped title is hidden. */
function workLine(item: ConnectorItem): MessageBody {
  const key = untrustedText(truncate(oneLine(item.id), DAILY_BRIEF_WORK_KEY_MAX_CHARS));
  const title = oneLine(item.title);
  const titlePart: MessagePart =
    title.length === 0
      ? '(제목 없음)'
      : containsCredentialMaterial(item.title)
        ? '(제목 숨김)'
        : untrustedText(truncate(title, DAILY_BRIEF_WORK_TITLE_MAX_CHARS));
  return messageBody('- ', key, ' ', titlePart);
}

/** ADR-0117 D1: "오늘 일정 N건" and the day's events (all-day first), or the empty / unreadable note. */
function calendarSection(calendar: DailyBriefCalendar | null, input: DailyBriefInput): MessageBody[] {
  if (calendar === null) return ['오늘 일정: 불러오지 못했어요.'];
  const lines = calendarDayEventLines(localDateOf(input.now, input.timeZone), calendar.events, input.timeZone);
  const partial = calendar.events.length >= calendar.limit;
  if (lines.length === 0) return [partial ? '오늘 일정: 일부만 읽었어요.' : '오늘 일정이 없어요.'];
  const section: MessageBody[] = [`오늘 일정 ${lines.length}건${partial ? ' 이상' : ''}`];
  section.push(...lines.slice(0, DAILY_BRIEF_MAX_ENTRIES));
  if (lines.length > DAILY_BRIEF_MAX_ENTRIES) section.push(`- 외 ${lines.length - DAILY_BRIEF_MAX_ENTRIES}건`);
  return section;
}

/** ADR-0117 D2: the owner's assigned items due or updated today, or the empty / unreadable note. */
function assignedWorkSection(items: readonly ConnectorItem[] | null, input: DailyBriefInput): MessageBody[] {
  if (items === null) return ['담당 이슈: 불러오지 못했어요.'];
  const today = dailyBriefWorkForToday(items, input.now, input.timeZone);
  if (today.length === 0) return ['오늘 마감·업데이트된 담당 이슈가 없어요.'];
  const section: MessageBody[] = [`오늘 마감·업데이트된 담당 이슈 ${today.length}건`];
  for (const item of today.slice(0, DAILY_BRIEF_MAX_WORK_ENTRIES)) section.push(workLine(item));
  if (today.length > DAILY_BRIEF_MAX_WORK_ENTRIES) section.push(`- 외 ${today.length - DAILY_BRIEF_MAX_WORK_ENTRIES}건`);
  return section;
}

/** Compose the brief text (Korean, no emoji, at most one delivered message). */
export function composeDailyBrief(input: DailyBriefInput): MessageBody {
  const today = toZonedDateTime(input.now, input.timeZone);
  let header = `오늘의 브리핑 · ${today.month}월 ${today.day}일(${WEEKDAY_KO[today.weekday]})`;
  if (input.late === true && input.occurrenceAt !== undefined) {
    header += ` (예정 ${formatShortDateTime(input.occurrenceAt, input.timeZone)}, 늦게 전달)`;
  }
  const lines: MessageBody[] = [header, ''];

  if (input.calendar !== undefined) lines.push(...calendarSection(input.calendar, input), '');

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
      for (const item of active.slice(0, DAILY_BRIEF_MAX_ENTRIES)) lines.push(messageBody('- ', workItemLabel(item)));
      if (active.length > DAILY_BRIEF_MAX_ENTRIES) lines.push(`- 외 ${active.length - DAILY_BRIEF_MAX_ENTRIES}건`);
    }
  }
  if (input.assignedWork !== undefined) lines.push('', ...assignedWorkSection(input.assignedWork, input));
  return clampText(joinBody(lines));
}
