import type { Provider } from '@nestjs/common';
import {
  CALENDAR_READER,
  createCalendarTurnHandler,
  type CalendarReader,
  type ConversationTurnHandler,
  type Logger,
} from '@quoky/core';
import { createCalendarReader } from '../calendar-reader-provider';
import type { QuokyConfig } from '../config';
import { ConsoleLogger } from '../console-logger';

/**
 * Calendar schedule questions (ADR-0110 D3–D6, CAL-2) — feature composition (ADR-0096 D7). Every calendar binding
 * lives here:
 *
 * - `CALENDAR_READER` — the CAL-1 read-only Google Calendar adapter, bound ONLY when the calendar is fully configured
 *   and the adapter accepted the configuration (`createCalendarReader`; construction makes no network call);
 * - `CALENDAR_TURN_HANDLERS` — the `pre-classify` order-150 handler over that reader, or an EMPTY list when no calendar
 *   is configured (ADR-0110 D5: the handler is registered only with a calendar, so QUAL-7 routing — schedule questions
 *   to POLICY_SENSITIVE_CHAT — is then unchanged).
 *
 * No provider, router or runtime is touched: the handler never asks the runtime for a model summary (ADR-0110 D4 —
 * calendar text never reaches any model), and no runtime dependency key is added (the deps baseline stays 34).
 */

/** App-local token for this feature's handler list (the wave-1 `feature-tokens.ts` is not edited after wave 1). */
export const CALENDAR_TURN_HANDLERS = Symbol('CalendarTurnHandlers');

export interface CalendarCompositionOptions {
  /** `config.calendar` (CAL-1); `undefined` = not configured. */
  readonly calendar: QuokyConfig['calendar'];
  /** `QUOKY_TIMEZONE` (`config.reminders.timeZone`), the zone every window and time is rendered in. */
  readonly timeZone: string;
  /** Offline acceptance only: replaces the configured adapter (production passes none). */
  readonly reader?: CalendarReader;
  /** Whether a calendar writer is bound (ADR-0110 amendment, CWR-2): picks the handler's help line only. */
  readonly writesEnabled?: boolean;
  readonly logger?: Logger;
}

export function createCalendarProviders(options: CalendarCompositionOptions): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('calendar');
  const reader = options.reader ?? createCalendarReader(options.calendar, logger);
  if (reader === undefined) {
    return [{ provide: CALENDAR_TURN_HANDLERS, useValue: [] as readonly ConversationTurnHandler[] }];
  }
  const timeZone = options.calendar?.timeZone ?? options.timeZone;
  return [
    { provide: CALENDAR_READER, useValue: reader },
    {
      provide: CALENDAR_TURN_HANDLERS,
      useFactory: (calendarReader: CalendarReader): readonly ConversationTurnHandler[] => [
        createCalendarTurnHandler({ reader: calendarReader, timeZone, logger, writesEnabled: options.writesEnabled === true }),
      ],
      inject: [CALENDAR_READER],
    },
  ];
}
