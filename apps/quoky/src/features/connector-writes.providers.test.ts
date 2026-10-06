import { describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_EVENT_WRITER,
  CHANNEL_MESSAGE_WRITER,
  CONNECTOR_WRITE_RECEIPT_REPOSITORY,
  ISSUE_COMMENT_WRITER,
  ISSUE_TRANSITION_WRITER,
  StatelessConnectorWriteFlow,
  connectorWriteSent,
  type CalendarEventWriter,
  type IssueCommentWriter,
  type Logger,
} from '@quoky/core';
import type { FactoryProvider, Provider } from '@nestjs/common';

import { loadConfig } from '../config';
import { CONNECTOR_WRITE_FLOW, createConnectorWriteComposition } from './connector-writes.providers';

// Token-shaped fixtures are built by concatenation (never a literal token pattern in the source).
const REFRESH_TOKEN = '1//' + 'refresh-token-value';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { QUOKY_DISCORD_OWNER_IDS: '111111111111111111', ...overrides } as NodeJS.ProcessEnv;
}
function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function tokens(providers: Provider[]): unknown[] {
  return providers.map((provider) => (provider as { provide: unknown }).provide);
}
function flowOf(providers: Provider[]): unknown {
  const flow = providers.find((provider) => (provider as { provide: unknown }).provide === CONNECTOR_WRITE_FLOW) as FactoryProvider;
  const storage = { sessions: {}, tasks: {} };
  return flow.useFactory(storage, { requestForRisk: vi.fn(), get: vi.fn(), decide: vi.fn() }, {});
}

const COMMENTS: IssueCommentWriter = {
  source: 'jira',
  allowsIssue: () => true,
  addComment: async () => connectorWriteSent('1'),
};
const CALENDAR: CalendarEventWriter = {
  source: 'calendar',
  target: 'primary',
  createEvent: async () => connectorWriteSent('e'),
  updateEvent: async () => connectorWriteSent('e'),
  deleteEvent: async () => connectorWriteSent('e'),
};

describe('connector-write composition (ADR-0112 D4/D5, CWR-2)', () => {
  it('writes are off by default: no writer is bound and the runtime gets no flow (null)', () => {
    const composition = createConnectorWriteComposition({ config: loadConfig(env()), timeZone: 'Asia/Seoul', logger: logger() });
    expect(composition.writers).toEqual({});
    expect(composition.calendarWritesEnabled).toBe(false);
    expect(tokens(composition.providers)).toEqual([CONNECTOR_WRITE_RECEIPT_REPOSITORY, CONNECTOR_WRITE_FLOW]);
    expect(flowOf(composition.providers)).toBeNull();
  });

  it('binds exactly the built writers and hands the runtime a flow over them', () => {
    const composition = createConnectorWriteComposition({
      config: loadConfig(env()),
      timeZone: 'Asia/Seoul',
      logger: logger(),
      writers: { issueComments: COMMENTS },
    });
    expect(tokens(composition.providers)).toEqual([CONNECTOR_WRITE_RECEIPT_REPOSITORY, ISSUE_COMMENT_WRITER, CONNECTOR_WRITE_FLOW]);
    expect(tokens(composition.providers)).not.toContain(ISSUE_TRANSITION_WRITER);
    expect(tokens(composition.providers)).not.toContain(CHANNEL_MESSAGE_WRITER);
    const flow = flowOf(composition.providers);
    expect(flow).toBeInstanceOf(StatelessConnectorWriteFlow);
    expect((flow as StatelessConnectorWriteFlow).helpLines).toHaveLength(1);
  });

  it('a calendar writer gets a reader restricted to the primary calendar, whatever calendars the read path lists', () => {
    const config = loadConfig(env({
      QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'client-' + 'secret-value',
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
      QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS: 'primary,team@group.calendar.google.com',
    }));
    const composition = createConnectorWriteComposition({ config, timeZone: 'Asia/Seoul', logger: logger(), writers: { calendarEvents: CALENDAR } });
    expect(composition.calendarWritesEnabled).toBe(true);
    expect(tokens(composition.providers)).toContain(CALENDAR_EVENT_WRITER);
    const flow = flowOf(composition.providers) as { deps: { calendarReader?: { calendarIds?: readonly string[] } } };
    expect(flow.deps.calendarReader?.calendarIds).toEqual(['primary']);
    expect(config.calendar?.google.calendarIds).toEqual(['primary', 'team@group.calendar.google.com']);
  });
});
