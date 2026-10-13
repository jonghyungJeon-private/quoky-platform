import type { Actor, Id, IsoTimestamp } from '../../domain';
import { CALENDAR_EVENTS_MAX_LIMIT, type CalendarEvent, type CalendarReader } from '../../ports/calendar-reader.port';
import { resolveCalendarWindow } from '../../ports/calendar-window';
import type { ConnectorItem, ConnectorProvider } from '../../ports/connector-provider.port';
import { ConnectorQueryName, CONNECTOR_QUERY_MAX_LIMIT, type PersonalWorkFilter } from '../../ports/connector-query';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { MailReader } from '../../ports/mail-reader.port';
import { CALENDAR_READ_TIMEOUT_MS } from '../calendar/calendar-turn-handler';
import { MAIL_READ_TIMEOUT_MS } from '../mail/mail-turn-handler';
import { WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS } from '../work-chat/work-chat-service';
import { DAILY_BRIEF_MAX_MAIL_ENTRIES, type DailyBriefCalendar, type DailyBriefMail } from './daily-brief';

/**
 * The connector reads of the morning brief (ADR-0117 D1/D2, BRF-1). Read-only and bounded; no model, no write, no
 * tool, and nothing is logged but counts and failure classes.
 *
 * - **Calendar (D1).** Only when a `CalendarReader` is configured: one `listEvents` call for today in the brief's zone
 *   (`QUOKY_TIMEZONE`), bounded by the schedule handler's read timeout. A failure or a timeout is `null` ("could not
 *   read"), never an empty day. With no reader the result has no `calendar` key and the section is omitted.
 * - **Assigned work (D2).** Only when the composition root passed a connector (`QUOKY_BRIEF_JIRA_ENABLED=true` and the
 *   connector is configured): the ADR-0100 `personal-work` named query for the owner's identity on that connector
 *   (`all` and `due-this-week`, each at most 20 items), bounded by the work-lookup deadline. The brief keeps the items
 *   due or updated today. A missing identity, an unavailable connector, a failure or a timeout is `null`.
 *
 * - **Mail (BRF-3).** Only when the composition root passed a `MailReader` (`QUOKY_BRIEF_MAIL_ENABLED=true` and Gmail is
 *   configured): ONE `search` for unread inbox mail with `limit` 3 — the count and the newest three summaries, so at
 *   most 1 list call plus 3 metadata gets on the wire (nothing when the inbox is empty), never a body fetch. Bounded by
 *   the mail handler's read timeout. A failure or a timeout is `null`. Only counts and failure classes are logged.
 *
 * The reads run concurrently, so a slow source holds the brief (and the dispatch tick) for at most the longer bound.
 * `read` never throws.
 */

export interface DailyBriefWorkSource {
  /** The read-only connector the composition root selected for the brief. Core never branches on its `source`. */
  readonly connector: ConnectorProvider;
  /** The owner's identities: the one whose platform equals `connector.source` is the query identity (as work chat). */
  readonly actors: { get(id: Id): Promise<Actor | null> };
}

export interface DailyBriefSourcesDeps {
  /** ADR-0117 D1. Absent: no calendar is configured. */
  readonly calendar?: CalendarReader;
  /** ADR-0117 D2. Absent: the section is off (the default) or no connector is configured. */
  readonly work?: DailyBriefWorkSource;
  /** ADR-0117 BRF-3. Absent: the section is off (the default) or Gmail is not configured. */
  readonly mail?: MailReader;
  readonly logger?: Logger;
  /** Injectable for tests; production uses MAIL_READ_TIMEOUT_MS. */
  readonly mailTimeoutMs?: number;
  /** Injectable for tests; production uses CALENDAR_READ_TIMEOUT_MS. */
  readonly calendarTimeoutMs?: number;
  /** Injectable for tests; production uses WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS. */
  readonly workTimeoutMs?: number;
}

export interface DailyBriefSourcesRequest {
  readonly actorId: Id;
  readonly now: IsoTimestamp;
  readonly timeZone: string;
}

/** Only the configured sources have a key; `null` marks a source that could not be read. */
export interface DailyBriefSourcesReadout {
  readonly calendar?: DailyBriefCalendar | null;
  readonly assignedWork?: readonly ConnectorItem[] | null;
  readonly mail?: DailyBriefMail | null;
}

const BRIEF_WORK_FILTERS: readonly PersonalWorkFilter[] = ['all', 'due-this-week'];

class BriefSourceTimeout extends Error {
  constructor() {
    super('brief source read timed out');
    this.name = 'BriefSourceTimeout';
  }
}

class BriefWorkUnavailable extends Error {
  constructor(readonly reason: 'IDENTITY_MISSING' | 'UNAVAILABLE') {
    super(`brief work source ${reason.toLowerCase()}`);
    this.name = 'BriefWorkUnavailable';
  }
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BriefSourceTimeout()), timeoutMs);
  });
  const task = run();
  // A late rejection after the bound must not surface as an unhandled rejection.
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failureClass(error: unknown): string {
  if (error instanceof BriefSourceTimeout) return 'TIMEOUT';
  if (error instanceof BriefWorkUnavailable) return error.reason;
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && /^[A-Z_]{1,40}$/.test(reason) ? reason : 'UNAVAILABLE';
}

export class DailyBriefSources {
  constructor(private readonly deps: DailyBriefSourcesDeps) {}

  async read(request: DailyBriefSourcesRequest): Promise<DailyBriefSourcesReadout> {
    const [calendar, assignedWork, mail] = await Promise.all([
      this.deps.calendar === undefined ? undefined : this.readCalendar(this.deps.calendar, request),
      this.deps.work === undefined ? undefined : this.readWork(this.deps.work, request),
      this.deps.mail === undefined ? undefined : this.readMail(this.deps.mail),
    ]);
    return {
      ...(calendar !== undefined ? { calendar } : {}),
      ...(assignedWork !== undefined ? { assignedWork } : {}),
      ...(mail !== undefined ? { mail } : {}),
    };
  }

  private async readCalendar(reader: CalendarReader, request: DailyBriefSourcesRequest): Promise<DailyBriefCalendar | null> {
    try {
      const window = resolveCalendarWindow('today', request.now, request.timeZone);
      const limit = CALENDAR_EVENTS_MAX_LIMIT;
      const events: readonly CalendarEvent[] = await withTimeout(
        () => reader.listEvents({ ...window, limit }),
        this.deps.calendarTimeoutMs ?? CALENDAR_READ_TIMEOUT_MS,
      );
      if (!Array.isArray(events)) return null;
      this.log('info', 'reminder.brief.calendar_read', { events: events.length });
      return { events, limit };
    } catch (error) {
      this.log('warn', 'reminder.brief.calendar_failed', { reason: failureClass(error) });
      return null;
    }
  }

  private async readWork(work: DailyBriefWorkSource, request: DailyBriefSourcesRequest): Promise<readonly ConnectorItem[] | null> {
    try {
      const items = await withTimeout(async () => {
        const actor = await work.actors.get(request.actorId);
        const identity = actor?.identities
          .filter((candidate) => candidate.platform === work.connector.source)
          .map((candidate) => candidate.externalId.trim())
          .filter(Boolean)
          .sort()[0];
        if (identity === undefined) throw new BriefWorkUnavailable('IDENTITY_MISSING');
        if (!(await work.connector.isAvailable())) throw new BriefWorkUnavailable('UNAVAILABLE');
        const results = await Promise.all(
          BRIEF_WORK_FILTERS.map((filter) =>
            work.connector.query({
              query: ConnectorQueryName.PERSONAL_WORK,
              params: { actorExternalId: identity, filter, limit: CONNECTOR_QUERY_MAX_LIMIT },
            }),
          ),
        );
        return results.flatMap((result) => (Array.isArray(result.items) ? result.items.slice(0, CONNECTOR_QUERY_MAX_LIMIT) : []));
      }, this.deps.workTimeoutMs ?? WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS);
      this.log('info', 'reminder.brief.work_read', { items: items.length });
      return items;
    } catch (error) {
      this.log('warn', 'reminder.brief.work_failed', { reason: failureClass(error) });
      return null;
    }
  }

  private async readMail(reader: MailReader): Promise<DailyBriefMail | null> {
    try {
      const result = await withTimeout(
        () => reader.search({ unreadOnly: true, limit: DAILY_BRIEF_MAX_MAIL_ENTRIES }),
        this.deps.mailTimeoutMs ?? MAIL_READ_TIMEOUT_MS,
      );
      if (!Array.isArray(result?.messages) || !Number.isFinite(result.matched)) return null;
      const messages = result.messages.slice(0, DAILY_BRIEF_MAX_MAIL_ENTRIES);
      this.log('info', 'reminder.brief.mail_read', { unread: result.matched, shown: messages.length });
      return { count: result.matched, lowerBound: result.matchedIsLowerBound === true, messages };
    } catch (error) {
      this.log('warn', 'reminder.brief.mail_failed', { reason: failureClass(error) });
      return null;
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
