import {
  GoogleCalendarTokenFileError,
  GoogleCalendarWriter,
  readGoogleCalendarTokenGrant,
  type GoogleCalendarTokenGrant,
} from '@quoky/connector-calendar-google';
import { JiraIssueCommentWriter, JiraIssueTransitionWriter } from '@quoky/connector-jira';
import { SlackChannelWriter } from '@quoky/connector-slack';
import type {
  CalendarEventWriter,
  ChannelMessageWriter,
  IssueCommentWriter,
  IssueTransitionWriter,
  Logger,
} from '@quoky/core';

import type { QuokyConfig } from './config';
import { classifyConnectorWriteTransportFailure, installConnectorWriteTransportDiagnostics } from './connector-write-transport';

/** Fixed, value-free reasons logged when a write adapter is not registered. */
export const ConnectorWriterNotRegisteredReason = {
  JIRA_NOT_CONFIGURED: 'CONNECTOR_WRITE_JIRA_NOT_CONFIGURED',
  CALENDAR_NOT_CONFIGURED: 'CALENDAR_WRITE_NOT_CONFIGURED',
  CALENDAR_TOKEN_SOURCE_CONFLICT: 'CALENDAR_TOKEN_SOURCE_CONFLICT',
  CALENDAR_SCOPE_MISSING: 'CALENDAR_WRITE_SCOPE_MISSING',
  CONFIGURATION_REJECTED: 'CONNECTOR_WRITE_CONFIGURATION_REJECTED',
} as const;

/**
 * The write adapters the composition root may bind (ADR-0112 D2, ADR-0110 amendment). A missing member means that write
 * stays refused. CWR-2 binds them to `ISSUE_COMMENT_WRITER`, `ISSUE_TRANSITION_WRITER`, `CHANNEL_MESSAGE_WRITER` and
 * `CALENDAR_EVENT_WRITER` together with the receipts repository and the approval flow.
 */
export interface ConnectorWriters {
  readonly issueComments?: IssueCommentWriter;
  readonly issueTransitions?: IssueTransitionWriter;
  readonly channelMessages?: ChannelMessageWriter;
  readonly calendarEvents?: CalendarEventWriter;
}

export interface ConnectorWritersFactoryOptions {
  /** Injectable for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; production reads the mode-600 token file. */
  readonly readTokenGrant?: (path: string) => GoogleCalendarTokenGrant;
}

/**
 * Builds only the writers whose flags are on and whose allowlists and credentials are complete (CWR-1; default: none).
 *
 * - Jira comment + transition: `QUOKY_CONNECTOR_WRITES_ENABLED=true`, a non-empty Jira project allowlist and the read
 *   connector's Jira credentials.
 * - Slack post: `QUOKY_CONNECTOR_WRITES_ENABLED=true`, the separate bot token and a non-empty channel allowlist.
 * - Calendar create/update/delete: `QUOKY_CALENDAR_WRITE_ENABLED=true` and a configured calendar whose token file records
 *   a `calendar.events` grant (an inline refresh token is checked on the first write instead).
 *
 * Construction makes no network call. A writer that cannot be built logs a warning with a fixed code only: no token,
 * secret, path, project, channel or calendar id is ever logged.
 */
export function createConnectorWriters(
  config: Pick<QuokyConfig, 'connectorWrites' | 'connectors' | 'calendar'>,
  logger: Logger,
  options: ConnectorWritersFactoryOptions = {},
): ConnectorWriters {
  const writes = config.connectorWrites;
  // UNC-1: every writer classifies a thrown write request with the platform-fetch classifier (NOT_SENT only with
  // connection-stage evidence); the diagnostics subscription exists before the first write request.
  installConnectorWriteTransportDiagnostics();
  const fetchOption = {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    classifyTransportFailure: classifyConnectorWriteTransportFailure,
  };
  const writers: {
    issueComments?: IssueCommentWriter;
    issueTransitions?: IssueTransitionWriter;
    channelMessages?: ChannelMessageWriter;
    calendarEvents?: CalendarEventWriter;
  } = {};

  if (writes.enabled && writes.jiraProjects.length > 0) {
    const jira = config.connectors.jira;
    if (jira === undefined) {
      logger.warn('connector writer not registered', { reason: ConnectorWriterNotRegisteredReason.JIRA_NOT_CONFIGURED });
    } else {
      const jiraConfig = {
        host: jira.host, email: jira.email, apiToken: jira.apiToken, allowedProjects: writes.jiraProjects, ...fetchOption,
      };
      const built = construct(() => ({
        comments: new JiraIssueCommentWriter(jiraConfig),
        transitions: new JiraIssueTransitionWriter(jiraConfig),
      }), logger);
      if (built !== undefined) {
        writers.issueComments = built.comments;
        writers.issueTransitions = built.transitions;
      }
    }
  }

  if (writes.enabled && writes.slack !== undefined) {
    const slack = writes.slack;
    const built = construct(() => new SlackChannelWriter({ token: slack.token, channels: slack.channels, ...fetchOption }), logger);
    if (built !== undefined) writers.channelMessages = built;
  }

  if (writes.calendarEnabled) {
    const calendar = createCalendarEventWriter(config.calendar, logger, options);
    if (calendar !== undefined) writers.calendarEvents = calendar;
  }

  return writers;
}

function createCalendarEventWriter(
  calendar: QuokyConfig['calendar'],
  logger: Logger,
  options: ConnectorWritersFactoryOptions,
): CalendarEventWriter | undefined {
  if (calendar === undefined) {
    logger.warn('connector writer not registered', { reason: ConnectorWriterNotRegisteredReason.CALENDAR_NOT_CONFIGURED });
    return undefined;
  }
  const google = calendar.google;
  if (google.refreshToken !== undefined && google.tokenFile !== undefined) {
    logger.warn('connector writer not registered', { reason: ConnectorWriterNotRegisteredReason.CALENDAR_TOKEN_SOURCE_CONFLICT });
    return undefined;
  }
  let refreshToken = google.refreshToken;
  if (refreshToken === undefined && google.tokenFile !== undefined) {
    let grant: GoogleCalendarTokenGrant;
    try {
      grant = (options.readTokenGrant ?? readGoogleCalendarTokenGrant)(google.tokenFile);
    } catch (error) {
      logger.warn('connector writer not registered', {
        reason: error instanceof GoogleCalendarTokenFileError ? error.code : ConnectorWriterNotRegisteredReason.CONFIGURATION_REJECTED,
      });
      return undefined;
    }
    if (!grant.canWrite) {
      logger.warn('connector writer not registered', { reason: ConnectorWriterNotRegisteredReason.CALENDAR_SCOPE_MISSING });
      return undefined;
    }
    refreshToken = grant.refreshToken;
  }
  if (refreshToken === undefined) return undefined;
  const token = refreshToken;
  return construct(() => new GoogleCalendarWriter({
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    refreshToken: token,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    classifyTransportFailure: classifyConnectorWriteTransportFailure,
  }), logger);
}

/** The adapters' messages are value-free, but only the fixed code is logged. */
function construct<T>(build: () => T, logger: Logger): T | undefined {
  try {
    return build();
  } catch {
    logger.warn('connector writer not registered', { reason: ConnectorWriterNotRegisteredReason.CONFIGURATION_REJECTED });
    return undefined;
  }
}
