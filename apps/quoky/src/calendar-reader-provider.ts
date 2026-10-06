import {
  GoogleCalendarReader,
  GoogleCalendarTokenFileError,
  readGoogleCalendarTokenFile,
  type GoogleCalendarReaderConfig,
} from '@quoky/connector-calendar-google';
import type { CalendarReader, Logger } from '@quoky/core';

import type { QuokyConfig } from './config';

/** Fixed, value-free reasons logged when a configured calendar is not registered. */
export const CalendarReaderNotRegisteredReason = {
  TOKEN_SOURCE_CONFLICT: 'CALENDAR_TOKEN_SOURCE_CONFLICT',
  CONFIGURATION_REJECTED: 'CALENDAR_CONFIGURATION_REJECTED',
} as const;

export interface CalendarReaderFactoryOptions {
  /** Injectable for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; production reads the mode-600 token file. */
  readonly readTokenFile?: (path: string) => string;
}

/**
 * The calendar reader (ADR-0110 D2/D5, CAL-1). Returns `undefined` — "no calendar" — unless the calendar is fully
 * configured: no calendar config, an inline token AND a token file (conflict), an unreadable or unsafe token file, or
 * a configuration the adapter rejects. The last three log a warning with a fixed code only; no token, secret, path or
 * calendar id is ever logged. Construction makes no network call: the first token refresh happens on the first read.
 *
 * CAL-2 binds the result to `CALENDAR_READER` (and registers the schedule handler only when it is defined).
 */
export function createCalendarReader(
  config: QuokyConfig['calendar'],
  logger: Logger,
  options: CalendarReaderFactoryOptions = {},
): CalendarReader | undefined {
  if (config === undefined) return undefined;
  const google = config.google;
  if (google.refreshToken !== undefined && google.tokenFile !== undefined) {
    logger.warn('calendar not registered', { reason: CalendarReaderNotRegisteredReason.TOKEN_SOURCE_CONFLICT });
    return undefined;
  }

  let refreshToken = google.refreshToken;
  if (refreshToken === undefined && google.tokenFile !== undefined) {
    try {
      refreshToken = (options.readTokenFile ?? readGoogleCalendarTokenFile)(google.tokenFile);
    } catch (error) {
      logger.warn('calendar not registered', {
        reason: error instanceof GoogleCalendarTokenFileError ? error.code : CalendarReaderNotRegisteredReason.CONFIGURATION_REJECTED,
      });
      return undefined;
    }
  }
  if (refreshToken === undefined) return undefined;

  const readerConfig: GoogleCalendarReaderConfig = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    refreshToken,
    timeZone: config.timeZone,
    calendarIds: google.calendarIds,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  try {
    return new GoogleCalendarReader(readerConfig);
  } catch {
    // The adapter's message is value-free, but only the fixed code is logged.
    logger.warn('calendar not registered', { reason: CalendarReaderNotRegisteredReason.CONFIGURATION_REJECTED });
    return undefined;
  }
}
