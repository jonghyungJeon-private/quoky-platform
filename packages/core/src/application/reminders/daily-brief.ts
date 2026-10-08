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
import { clipMessage, messageBody, takeLines, untrustedText } from '../message-rendering';
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

/**
 * One brief section: `head` is never dropped (the section header with its count, or the empty / could-not-read
 * notice); `items` are the listed entries (already capped per section), and `hidden` counts the entries past the cap.
 * Under the message budget the items shrink, and one "- 외 N건" line counts every entry not shown.
 */
interface BriefSection {
  readonly head: readonly string[];
  readonly items: readonly MessageBody[];
  readonly hidden: number;
}

/** Room for a section's closing "- 외 N건" line and its line break. */
const OMITTED_LINE_RESERVE_CHARS = 12;

function listSection(header: string, entries: readonly MessageBody[], max: number): BriefSection {
  return { head: [header], items: entries.slice(0, max), hidden: Math.max(0, entries.length - max) };
}

function noticeSection(notice: string): BriefSection {
  return { head: [notice], items: [], hidden: 0 };
}

/** ADR-0117 D1: "오늘 일정 N건" and the day's events (all-day first), or the empty / unreadable note. */
function calendarSection(calendar: DailyBriefCalendar | null, input: DailyBriefInput): BriefSection {
  if (calendar === null) return noticeSection('오늘 일정: 불러오지 못했어요.');
  const lines = calendarDayEventLines(localDateOf(input.now, input.timeZone), calendar.events, input.timeZone);
  const partial = calendar.events.length >= calendar.limit;
  if (lines.length === 0) return noticeSection(partial ? '오늘 일정: 일부만 읽었어요.' : '오늘 일정이 없어요.');
  return listSection(`오늘 일정 ${lines.length}건${partial ? ' 이상' : ''}`, lines, DAILY_BRIEF_MAX_ENTRIES);
}

function remindersSection(input: DailyBriefInput): BriefSection {
  if (input.reminders === null) return noticeSection('남은 알림: 불러오지 못했어요.');
  const pending = todaysPendingReminders(input);
  if (pending.length === 0) return noticeSection('오늘 남은 알림이 없어요.');
  const lines = pending.map((reminder): MessageBody => {
    const at = toZonedDateTime(reminder.nextFireAt ?? input.now, input.timeZone);
    return `- ${formatKoreanClock(at.hour, at.minute)} ${truncate(reminder.body, 60)} (#${reminder.displayNo})`;
  });
  return listSection(`오늘 남은 알림 ${pending.length}건`, lines, DAILY_BRIEF_MAX_ENTRIES);
}

function workItemsSection(input: DailyBriefInput): BriefSection {
  if (input.workItems === null) return noticeSection('진행 중인 작업: 불러오지 못했어요.');
  const active = activeWorkItems(input);
  if (active.length === 0) return noticeSection('진행 중인 작업이 없어요.');
  const lines = active.map((item) => messageBody('- ', workItemLabel(item)));
  return listSection(`진행 중인 작업 ${active.length}건`, lines, DAILY_BRIEF_MAX_ENTRIES);
}

/** ADR-0117 D2: the owner's assigned items due or updated today, or the empty / unreadable note. */
function assignedWorkSection(items: readonly ConnectorItem[] | null, input: DailyBriefInput): BriefSection {
  if (items === null) return noticeSection('담당 이슈: 불러오지 못했어요.');
  const today = dailyBriefWorkForToday(items, input.now, input.timeZone);
  if (today.length === 0) return noticeSection('오늘 마감·업데이트된 담당 이슈가 없어요.');
  return listSection(`오늘 마감·업데이트된 담당 이슈 ${today.length}건`, today.map(workLine), DAILY_BRIEF_MAX_WORK_ENTRIES);
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/** What a section needs even when every one of its items is dropped: its blank separator, head and "외 N건" line. */
function mandatoryChars(section: BriefSection): number {
  const head = section.head.reduce((sum, line) => sum + 1 + codePoints(line), 0);
  const listed = section.items.length > 0 || section.hidden > 0;
  return 1 + head + (listed ? OMITTED_LINE_RESERVE_CHARS : 0);
}

/**
 * The sections inside one delivered message (REMINDER_LIMITS.maxDeliveredTextChars of the platform's rendering).
 * Each section is a `take-lines` node whose head holds everything before it, so earlier sections keep their items
 * first. Every layer reserves the mandatory lines of the sections after it, so a header, an empty-day notice or a
 * could-not-read note is never dropped: only list items shrink, each section closing with "- 외 N건".
 */
function boundedBrief(header: string, sections: readonly BriefSection[]): MessageBody {
  const maxChars = REMINDER_LIMITS.maxDeliveredTextChars;
  const later = sections.map((_, index) =>
    sections.slice(index + 1).reduce((sum, section) => sum + mandatoryChars(section), 0),
  );
  let body: MessagePart = header;
  sections.forEach((section, index) => {
    const head: MessagePart[] = [body, '', ...section.head];
    body = takeLines({
      unit: 'code-points',
      maxChars,
      // The line breaks between the head lines, the "외 N건" line, and every later section's mandatory lines.
      baseChars: head.length - 1 + OMITTED_LINE_RESERVE_CHARS + (later[index] ?? 0),
      head,
      tail: [],
      lines: section.items.map((content) => ({ content, item: true })),
      omitted: { hidden: section.hidden, before: '- 외 ', after: '건' },
    });
  });
  // A last guard only: the layers above already keep the rendering inside the bound.
  return messageBody(clipMessage(body, maxChars, 'code-points'));
}

/** Compose the brief text (Korean, no emoji, at most one delivered message). */
export function composeDailyBrief(input: DailyBriefInput): MessageBody {
  const today = toZonedDateTime(input.now, input.timeZone);
  let header = `오늘의 브리핑 · ${today.month}월 ${today.day}일(${WEEKDAY_KO[today.weekday]})`;
  if (input.late === true && input.occurrenceAt !== undefined) {
    header += ` (예정 ${formatShortDateTime(input.occurrenceAt, input.timeZone)}, 늦게 전달)`;
  }
  const sections: BriefSection[] = [];
  if (input.calendar !== undefined) sections.push(calendarSection(input.calendar, input));
  sections.push(remindersSection(input), workItemsSection(input));
  if (input.assignedWork !== undefined) sections.push(assignedWorkSection(input.assignedWork, input));
  return boundedBrief(header, sections);
}
