import type { Provider } from '@nestjs/common';
import { GDRIVE_SOURCE_LABEL, GDriveTokenFileError, GoogleDriveReader, readGDriveTokenFile } from '@quoky/connector-gdrive';
import {
  DRIVE_READER,
  SessionManager,
  createDriveTurnHandler,
  type ConversationTurnHandler,
  type DriveReader,
  type DriveSourceCopy,
  type Logger,
} from '@quoky/core';
import type { QuokyConfig } from '../config';
import { ConsoleLogger } from '../console-logger';

/**
 * The owner's Google Drive, read-only (ADR-0118, DRV-1) — feature composition (ADR-0096 D7). Every Drive binding lives
 * here:
 *
 * - `DRIVE_READER` — the read-only Drive adapter (`drive.readonly`), bound ONLY when Drive is fully configured and the
 *   adapter accepted the configuration; construction makes no network call;
 * - `DRIVE_TURN_HANDLERS` — the `pre-classify` order-145 Drive handler over that reader, or an EMPTY list when Drive is
 *   not configured, so every existing reply (the routing corpus, the help text, the golden fixtures) is unchanged.
 *
 * No provider, router or runtime dependency is touched (the deps baseline stays 35). A summary is a handler
 * `summarize` outcome the runtime serves through its existing SUMMARIZATION path; no tool and no write path exist.
 */

/** The source-specific copy Core does not hold: the adapter's label and the app's consent step. */
export const GDRIVE_DRIVE_COPY: DriveSourceCopy = Object.freeze({
  label: Object.freeze({ ko: GDRIVE_SOURCE_LABEL, en: GDRIVE_SOURCE_LABEL }),
  reconnectHint: Object.freeze({
    ko: '동의 도구(calendar-auth --drive)로 다시 연결해 주세요.',
    en: 'Reconnect with the consent helper (calendar-auth --drive).',
  }),
});

/** App-local token for this feature's handler list (the wave-1 `feature-tokens.ts` is not edited after wave 1). */
export const DRIVE_TURN_HANDLERS = Symbol('DriveTurnHandlers');

/** Fixed, value-free reasons logged when a configured Drive is not registered. */
export const DriveReaderNotRegisteredReason = {
  CONFIGURATION_REJECTED: 'GDRIVE_CONFIGURATION_REJECTED',
} as const;

export interface DriveReaderFactoryOptions {
  /** Injectable for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; production reads the mode-600 token file. */
  readonly readTokenFile?: (path: string) => string;
}

/**
 * The Drive reader, or `undefined` — "no Drive" — unless Drive is fully configured: an unreadable or unsafe token file,
 * or a configuration the adapter rejects, logs a warning with a fixed code only (never a token, secret or path).
 */
export function createDriveReader(
  config: QuokyConfig['drive'],
  logger: Logger,
  options: DriveReaderFactoryOptions = {},
): DriveReader | undefined {
  if (config === undefined) return undefined;
  let refreshToken: string;
  try {
    refreshToken = (options.readTokenFile ?? readGDriveTokenFile)(config.google.tokenFile);
  } catch (error) {
    logger.warn('drive not registered', {
      reason: error instanceof GDriveTokenFileError ? error.code : DriveReaderNotRegisteredReason.CONFIGURATION_REJECTED,
    });
    return undefined;
  }
  try {
    return new GoogleDriveReader({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      refreshToken,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch {
    logger.warn('drive not registered', { reason: DriveReaderNotRegisteredReason.CONFIGURATION_REJECTED });
    return undefined;
  }
}

export interface DriveCompositionOptions {
  /** `config.drive`; `undefined` = not configured. */
  readonly drive: QuokyConfig['drive'];
  /** `QUOKY_TIMEZONE` (`config.reminders.timeZone`). */
  readonly timeZone: string;
  /** Offline acceptance only: replaces the configured adapter (production passes none). */
  readonly reader?: DriveReader;
  readonly logger?: Logger;
}

export function createDriveProviders(options: DriveCompositionOptions): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('drive');
  const reader = options.reader ?? createDriveReader(options.drive, logger);
  if (reader === undefined) {
    return [{ provide: DRIVE_TURN_HANDLERS, useValue: [] as readonly ConversationTurnHandler[] }];
  }
  const timeZone = options.drive?.timeZone ?? options.timeZone;
  return [
    { provide: DRIVE_READER, useValue: reader },
    {
      provide: DRIVE_TURN_HANDLERS,
      useFactory: (driveReader: DriveReader, sessions: SessionManager): readonly ConversationTurnHandler[] => [
        createDriveTurnHandler({ reader: driveReader, timeZone, logger, copy: GDRIVE_DRIVE_COPY, sessions }),
      ],
      inject: [DRIVE_READER, SessionManager],
    },
  ];
}
