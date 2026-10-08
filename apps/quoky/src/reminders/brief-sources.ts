import { DailyBriefSources, type Actor, type CalendarReader, type ConnectorProvider, type Logger } from '@quoky/core';

/**
 * The daily brief's read-only sources (ADR-0117 D1/D2, BRF-1), composed here so the Core dispatch service receives
 * one narrow `briefSources` dependency or none:
 *
 * - the calendar: the `CALENDAR_READER` binding when the calendar is configured (the same reader, and so the same
 *   calendars — `primary` by default — as the schedule handler); otherwise no calendar section;
 * - assigned Jira work: only when `QUOKY_BRIEF_JIRA_ENABLED=true` AND the read-only Jira connector is registered. The
 *   composition root picks the connector by its source label; Core never branches on it.
 *
 * With neither configured this returns `undefined` and the brief is the local-only brief, byte for byte.
 */

/** The connector source label the brief's opt-in work section reads (ADR-0117 D2 names Jira). */
export const BRIEF_WORK_CONNECTOR_SOURCE = 'jira';

/** The storage member the work section reads, resolved at call time (absent before `init()`). */
export interface BriefActorStorageSeam {
  readonly actors?: { get(id: string): Promise<Actor | null> };
}

export class BriefActorStorageUnavailableError extends Error {
  constructor() {
    super('actor storage is not initialized');
    this.name = 'BriefActorStorageUnavailableError';
  }
}

export interface BriefSourcesCompositionOptions {
  readonly calendar?: CalendarReader | null;
  readonly connectors?: readonly ConnectorProvider[] | null;
  /** `QUOKY_BRIEF_JIRA_ENABLED` (`config.reminders.briefJiraEnabled`). */
  readonly briefJiraEnabled: boolean;
  readonly storage: BriefActorStorageSeam;
  readonly logger?: Logger;
}

export function createBriefSources(options: BriefSourcesCompositionOptions): DailyBriefSources | undefined {
  const calendar = options.calendar ?? undefined;
  const connector = options.briefJiraEnabled
    ? (options.connectors ?? []).find((candidate) => candidate.source === BRIEF_WORK_CONNECTOR_SOURCE && candidate.readOnly)
    : undefined;
  if (calendar === undefined && connector === undefined) return undefined;
  const storage = options.storage;
  return new DailyBriefSources({
    ...(calendar !== undefined ? { calendar } : {}),
    ...(connector !== undefined
      ? {
          work: {
            connector,
            actors: {
              get: (id: string) => {
                const actors = storage.actors;
                if (actors === undefined) return Promise.reject(new BriefActorStorageUnavailableError());
                return actors.get(id);
              },
            },
          },
        }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
