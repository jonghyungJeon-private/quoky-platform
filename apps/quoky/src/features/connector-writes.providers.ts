import type { Provider } from '@nestjs/common';
import {
  ApprovalManager,
  CALENDAR_EVENT_WRITER,
  CHANNEL_MESSAGE_WRITER,
  CONNECTOR_WRITE_RECEIPT_REPOSITORY,
  ISSUE_COMMENT_WRITER,
  ISSUE_TRANSITION_WRITER,
  STORAGE_PROVIDER,
  StatelessConnectorWriteFlow,
  newId,
  type CalendarReader,
  type ConnectorWriteFlow,
  type ConnectorWriteReceiptRepository,
  type Logger,
  type StorageProvider,
} from '@quoky/core';
import { createCalendarReader } from '../calendar-reader-provider';
import type { QuokyConfig } from '../config';
import { ConsoleLogger } from '../console-logger';
import { createConnectorWriters, type ConnectorWriters } from '../connector-writers-provider';

/**
 * Connector writes (ADR-0112, ADR-0110 amendment; CWR-2) — feature composition. Every connector-write binding lives
 * here:
 *
 * - the CWR-1 writers (`createConnectorWriters`: only those whose flags, allowlists and credentials are complete; all
 *   default off) bound to `ISSUE_COMMENT_WRITER`, `ISSUE_TRANSITION_WRITER`, `CHANNEL_MESSAGE_WRITER` and
 *   `CALENDAR_EVENT_WRITER` when built;
 * - `CONNECTOR_WRITE_RECEIPT_REPOSITORY` — a lazy view over the SQLite provider's v15 receipts (repositories exist only
 *   after `storage.init()`, ADR-0062);
 * - `CONNECTOR_WRITE_FLOW` — the runtime's optional `connectorWriteFlow` dep (ADR-0112 D5: deps baseline 34 → 35), or
 *   `null` when no writer was built, so every write request keeps its handler's fixed "writes are off" reply;
 * - for calendar writes, a PRIMARY-only calendar reader used to find the event an update or delete means (ADR-0110
 *   amendment D2: other calendars are never written, so they are never offered either).
 *
 * Construction makes no network call.
 */

/** App-local token for the runtime's optional connector-write flow (`null` = writes are off). */
export const CONNECTOR_WRITE_FLOW = Symbol('ConnectorWriteFlow');

export interface ConnectorWriteCompositionOptions {
  readonly config: Pick<QuokyConfig, 'connectorWrites' | 'connectors' | 'calendar'>;
  /** `QUOKY_TIMEZONE` (`config.reminders.timeZone`). */
  readonly timeZone: string;
  readonly logger?: Logger;
  /** Offline acceptance only: replaces the configured writers (production passes none). */
  readonly writers?: ConnectorWriters;
  /** Offline acceptance only: replaces the primary-calendar reader. */
  readonly calendarReader?: CalendarReader;
}

export interface ConnectorWriteComposition {
  readonly writers: ConnectorWriters;
  /** True when a calendar writer is bound (picks the calendar handler's help line, ADR-0110 amendment D7). */
  readonly calendarWritesEnabled: boolean;
  readonly providers: Provider[];
}

/** The storage provider seen structurally: the concrete SQLite provider also exposes its v15 receipts store. */
type ReceiptCapableStorage = StorageProvider & { readonly connectorWriteReceipts: ConnectorWriteReceiptRepository };

export function createConnectorWriteComposition(options: ConnectorWriteCompositionOptions): ConnectorWriteComposition {
  const logger = options.logger ?? new ConsoleLogger('connector-writes');
  const writers = options.writers ?? createConnectorWriters(options.config, logger);
  const anyWriter = Object.values(writers).some((writer) => writer !== undefined);
  const calendarReader =
    writers.calendarEvents === undefined ? undefined : (options.calendarReader ?? createPrimaryCalendarReader(options.config, logger));

  const writerBindings: Provider[] = [
    ...(writers.issueComments ? [{ provide: ISSUE_COMMENT_WRITER, useValue: writers.issueComments }] : []),
    ...(writers.issueTransitions ? [{ provide: ISSUE_TRANSITION_WRITER, useValue: writers.issueTransitions }] : []),
    ...(writers.channelMessages ? [{ provide: CHANNEL_MESSAGE_WRITER, useValue: writers.channelMessages }] : []),
    ...(writers.calendarEvents ? [{ provide: CALENDAR_EVENT_WRITER, useValue: writers.calendarEvents }] : []),
  ];

  const providers: Provider[] = [
    {
      provide: CONNECTOR_WRITE_RECEIPT_REPOSITORY,
      useFactory: (storage: ReceiptCapableStorage): ConnectorWriteReceiptRepository => ({
        prepare: (receipt) => storage.connectorWriteReceipts.prepare(receipt),
        complete: (id, outcome, now) => storage.connectorWriteReceipts.complete(id, outcome, now),
        findByIdempotencyKey: (key) => storage.connectorWriteReceipts.findByIdempotencyKey(key),
        findLatestSent: (match) => storage.connectorWriteReceipts.findLatestSent(match),
        findLatestUnresolved: (match) => storage.connectorWriteReceipts.findLatestUnresolved(match),
        findLatestForOperation: (actorId, operation) => storage.connectorWriteReceipts.findLatestForOperation(actorId, operation),
        markInterruptedPreparedUncertain: (now) => storage.connectorWriteReceipts.markInterruptedPreparedUncertain(now),
      }),
      inject: [STORAGE_PROVIDER],
    },
    ...writerBindings,
    {
      provide: CONNECTOR_WRITE_FLOW,
      useFactory: (
        storage: StorageProvider,
        approvals: ApprovalManager,
        receipts: ConnectorWriteReceiptRepository,
      ): ConnectorWriteFlow | null =>
        anyWriter
          ? new StatelessConnectorWriteFlow({
              writers,
              ...(calendarReader ? { calendarReader } : {}),
              receipts,
              approvals,
              // The live storage seam (ADR-0062): repositories are dereferenced at call time, after init().
              store: storage,
              timeZone: options.config.calendar?.timeZone ?? options.timeZone,
              newId,
              logger,
            })
          : null,
      inject: [STORAGE_PROVIDER, ApprovalManager, CONNECTOR_WRITE_RECEIPT_REPOSITORY],
    },
  ];

  return { writers, calendarWritesEnabled: writers.calendarEvents !== undefined, providers };
}

/** The read path restricted to the primary calendar (the only calendar writes may target). */
function createPrimaryCalendarReader(
  config: Pick<QuokyConfig, 'calendar'>,
  logger: Logger,
): CalendarReader | undefined {
  const calendar = config.calendar;
  if (calendar === undefined) return undefined;
  return createCalendarReader({ ...calendar, google: { ...calendar.google, calendarIds: ['primary'] } }, logger);
}
