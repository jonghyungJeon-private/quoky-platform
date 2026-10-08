import type { Provider } from '@nestjs/common';
import { GMAIL_SOURCE_LABEL, GmailMailReader, GmailTokenFileError, readGmailTokenFile } from '@quoky/connector-gmail';
import {
  MAIL_READER,
  createMailTurnHandler,
  type ConversationTurnHandler,
  type Logger,
  type MailReader,
  type MailSourceCopy,
} from '@quoky/core';
import type { QuokyConfig } from '../config';
import { ConsoleLogger } from '../console-logger';

/**
 * The owner's mail, read-only (ADR-0118, GML-1) — feature composition (ADR-0096 D7). Every mail binding lives here:
 *
 * - `MAIL_READER` — the read-only Gmail adapter (`gmail.readonly`), bound ONLY when Gmail is fully configured and the
 *   adapter accepted the configuration; construction makes no network call;
 * - `MAIL_TURN_HANDLERS` — the `pre-classify` order-140 mail handler over that reader, or an EMPTY list when Gmail is
 *   not configured, so every existing reply (the routing corpus, the help text, the golden fixtures) is unchanged.
 *
 * No provider, router or runtime dependency is touched (the deps baseline stays 35). A summary is a handler
 * `summarize` outcome the runtime serves through its existing SUMMARIZATION path; no tool and no write path exist.
 */

/**
 * Review P3-6: the source-specific copy Core does not hold — the adapter's label and the app's consent step (the
 * helper lives in this app). Appended to the auth-expired and needs-consent notes.
 */
export const GMAIL_MAIL_COPY: MailSourceCopy = Object.freeze({
  label: Object.freeze({ ko: GMAIL_SOURCE_LABEL, en: GMAIL_SOURCE_LABEL }),
  reconnectHint: Object.freeze({
    ko: '동의 도구(calendar-auth --gmail)로 다시 연결해 주세요.',
    en: 'Reconnect with the consent helper (calendar-auth --gmail).',
  }),
});

/** App-local token for this feature's handler list (the wave-1 `feature-tokens.ts` is not edited after wave 1). */
export const MAIL_TURN_HANDLERS = Symbol('MailTurnHandlers');

/** Fixed, value-free reasons logged when a configured Gmail is not registered. */
export const MailReaderNotRegisteredReason = {
  CONFIGURATION_REJECTED: 'GMAIL_CONFIGURATION_REJECTED',
} as const;

export interface MailReaderFactoryOptions {
  /** Injectable for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; production reads the mode-600 token file. */
  readonly readTokenFile?: (path: string) => string;
}

/**
 * The Gmail reader, or `undefined` — "no mail" — unless Gmail is fully configured: an unreadable or unsafe token file,
 * or a configuration the adapter rejects, logs a warning with a fixed code only (never a token, secret or path).
 */
export function createMailReader(
  config: QuokyConfig['gmail'],
  logger: Logger,
  options: MailReaderFactoryOptions = {},
): MailReader | undefined {
  if (config === undefined) return undefined;
  let refreshToken: string;
  try {
    refreshToken = (options.readTokenFile ?? readGmailTokenFile)(config.google.tokenFile);
  } catch (error) {
    logger.warn('gmail not registered', {
      reason: error instanceof GmailTokenFileError ? error.code : MailReaderNotRegisteredReason.CONFIGURATION_REJECTED,
    });
    return undefined;
  }
  try {
    return new GmailMailReader({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      refreshToken,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch {
    logger.warn('gmail not registered', { reason: MailReaderNotRegisteredReason.CONFIGURATION_REJECTED });
    return undefined;
  }
}

export interface MailCompositionOptions {
  /** `config.gmail`; `undefined` = not configured. */
  readonly gmail: QuokyConfig['gmail'];
  /** `QUOKY_TIMEZONE` (`config.reminders.timeZone`). */
  readonly timeZone: string;
  /** Offline acceptance only: replaces the configured adapter (production passes none). */
  readonly reader?: MailReader;
  readonly logger?: Logger;
}

export function createMailProviders(options: MailCompositionOptions): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('mail');
  const reader = options.reader ?? createMailReader(options.gmail, logger);
  if (reader === undefined) {
    return [{ provide: MAIL_TURN_HANDLERS, useValue: [] as readonly ConversationTurnHandler[] }];
  }
  const timeZone = options.gmail?.timeZone ?? options.timeZone;
  return [
    { provide: MAIL_READER, useValue: reader },
    {
      provide: MAIL_TURN_HANDLERS,
      useFactory: (mailReader: MailReader): readonly ConversationTurnHandler[] => [
        createMailTurnHandler({ reader: mailReader, timeZone, logger, copy: GMAIL_MAIL_COPY }),
      ],
      inject: [MAIL_READER],
    },
  ];
}
