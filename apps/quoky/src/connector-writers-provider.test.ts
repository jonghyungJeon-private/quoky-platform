import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_CALENDAR_READ_WRITE_SCOPE,
  GoogleCalendarWriter,
  writeGoogleCalendarTokenFile,
} from '@quoky/connector-calendar-google';
import { JiraIssueCommentWriter, JiraIssueTransitionWriter } from '@quoky/connector-jira';
import { SlackChannelWriter } from '@quoky/connector-slack';
import type { Logger } from '@quoky/core';

import { loadConfig } from './config';
import { ConnectorWriterNotRegisteredReason, createConnectorWriters } from './connector-writers-provider';

// Token-shaped fixtures are built by concatenation (never a literal token pattern in the source).
const BOT_TOKEN = 'xox' + 'b-test-only-bot-token';
const USER_TOKEN = 'xox' + 'p-test-only-user-token';
const JIRA_TOKEN = 'jira-secret-token';
const CLIENT_SECRET = 'client-secret-value';
const REFRESH_TOKEN = '1//refresh-token-value';

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { QUOKY_DISCORD_OWNER_IDS: '111111111111111111', ...overrides } as NodeJS.ProcessEnv;
}

const JIRA_ENV = {
  QUOKY_JIRA_BASE_URL: 'https://example.atlassian.net',
  QUOKY_JIRA_EMAIL: 'dev@example.com',
  QUOKY_JIRA_TOKEN: JIRA_TOKEN,
};
const CALENDAR_CLIENT_ENV = {
  QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
};

function testLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { info: vi.fn(), warn, error: vi.fn() }, warn };
}

function assertNothingSecretLogged(warn: ReturnType<typeof vi.fn>): void {
  const logged = JSON.stringify(warn.mock.calls);
  for (const secret of [BOT_TOKEN, USER_TOKEN, JIRA_TOKEN, CLIENT_SECRET, REFRESH_TOKEN, 'PROJ', 'C0123ABCD9']) {
    expect(logged).not.toContain(secret);
  }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-connector-writers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('connector write config (ADR-0112 D4, ADR-0110 amendment D7)', () => {
  it('is off by default with empty allowlists', () => {
    expect(loadConfig(env({})).connectorWrites).toEqual({ enabled: false, jiraProjects: [], calendarEnabled: false });
  });

  it('parses the flags, the Jira project allowlist and the Slack bot token with its channel allowlist', () => {
    const config = loadConfig(env({
      QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
      QUOKY_CALENDAR_WRITE_ENABLED: 'true',
      QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: ' PROJ , TEST_2 ',
      QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN,
      QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: '#dev-test:C0123ABCD9, G0999ZZZZ1',
      QUOKY_SLACK_TOKEN: USER_TOKEN,
    }));
    expect(config.connectorWrites).toEqual({
      enabled: true,
      jiraProjects: ['PROJ', 'TEST_2'],
      slack: { token: BOT_TOKEN, channels: [{ id: 'C0123ABCD9', name: 'dev-test' }, { id: 'G0999ZZZZ1' }] },
      calendarEnabled: true,
    });
    // The read connector keeps its own token.
    expect(config.connectors.slack).toEqual({ token: USER_TOKEN });
  });

  it('leaves Slack writes unconfigured unless both the bot token and channels are set', () => {
    expect(loadConfig(env({ QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN })).connectorWrites.slack).toBeUndefined();
    expect(loadConfig(env({ QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: 'C0123ABCD9' })).connectorWrites.slack).toBeUndefined();
  });

  it.each([
    ['QUOKY_CONNECTOR_WRITES_ENABLED', 'yes', 'CONNECTOR_WRITES_ENABLED_INVALID'],
    ['QUOKY_CONNECTOR_WRITES_ENABLED', '', 'CONNECTOR_WRITES_ENABLED_INVALID'],
    ['QUOKY_CALENDAR_WRITE_ENABLED', 'TRUE', 'CALENDAR_WRITE_ENABLED_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS', 'proj', 'CONNECTOR_WRITE_JIRA_PROJECTS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS', 'PROJ,,TEST', 'CONNECTOR_WRITE_JIRA_PROJECTS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS', 'PROJ,PROJ', 'CONNECTOR_WRITE_JIRA_PROJECTS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS', 'general', 'CONNECTOR_WRITE_SLACK_CHANNELS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS', 'Dev Test:C0123ABCD9', 'CONNECTOR_WRITE_SLACK_CHANNELS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS', 'a:C0123ABCD9,b:C0123ABCD9', 'CONNECTOR_WRITE_SLACK_CHANNELS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS', 'a:C0123ABCD9,a:C0456ABCD9', 'CONNECTOR_WRITE_SLACK_CHANNELS_INVALID'],
    ['QUOKY_CONNECTOR_WRITE_SLACK_TOKEN', USER_TOKEN, 'CONNECTOR_WRITE_SLACK_TOKEN_INVALID'],
  ])('%s=%j is refused with %s and never echoes the value', (variable, value, code) => {
    let caught: unknown;
    try { loadConfig(env({ [variable]: value })); } catch (error) { caught = error; }
    expect((caught as Error).message).toBe(code);
    if (value.length > 0) expect((caught as Error).message).not.toContain(value);
  });

  it('refuses a Slack write token equal to the read token (ADR-0112 D4: separate tokens)', () => {
    expect(codeOf(() => loadConfig(env({ QUOKY_SLACK_TOKEN: BOT_TOKEN, QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN })))).toBe(
      'CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE',
    );
  });

  it('refuses more than 50 allowlist entries', () => {
    const projects = Array.from({ length: 51 }, (_, i) => `P${i}`).join(',');
    expect(codeOf(() => loadConfig(env({ QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: projects })))).toBe('CONNECTOR_WRITE_JIRA_PROJECTS_INVALID');
  });
});

describe('createConnectorWriters (ADR-0112 D2/D4, ADR-0110 amendment; registration behind flags only)', () => {
  const noNetwork = vi.fn(async () => {
    throw new Error('no network in this test');
  }) as unknown as typeof fetch;

  it('builds nothing by default, even with every read connector and allowlist configured', () => {
    const { logger, warn } = testLogger();
    const config = loadConfig(env({
      ...JIRA_ENV,
      ...CALENDAR_CLIENT_ENV,
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
      QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: 'PROJ',
      QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN,
      QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: 'C0123ABCD9',
    }));
    expect(createConnectorWriters(config, logger, { fetchImpl: noNetwork })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('builds the Jira and Slack writers when writes are on and allowlisted, with no network call', () => {
    const { logger, warn } = testLogger();
    const config = loadConfig(env({
      ...JIRA_ENV,
      QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
      QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: 'PROJ',
      QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN,
      QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: 'dev-test:C0123ABCD9',
    }));
    const writers = createConnectorWriters(config, logger, { fetchImpl: noNetwork });
    expect(writers.issueComments).toBeInstanceOf(JiraIssueCommentWriter);
    expect(writers.issueTransitions).toBeInstanceOf(JiraIssueTransitionWriter);
    expect(writers.channelMessages).toBeInstanceOf(SlackChannelWriter);
    expect(writers.calendarEvents).toBeUndefined();
    expect(writers.issueComments?.allowsIssue('PROJ-1')).toBe(true);
    expect(writers.issueComments?.allowsIssue('OTHER-1')).toBe(false);
    expect(writers.channelMessages?.resolveChannel('#dev-test')).toBe('C0123ABCD9');
    expect(warn).not.toHaveBeenCalled();
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('UNC-1: the built writers classify a thrown write with the platform-fetch classifier (NOT_SENT only with evidence)', async () => {
    const { logger } = testLogger();
    const config = loadConfig(env({
      ...JIRA_ENV,
      QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
      QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: 'PROJ',
      QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN,
      QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: 'dev-test:C0123ABCD9',
    }));
    const failing = (code: string, message: string) =>
      (async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
      }) as unknown as typeof fetch;
    const dns = createConnectorWriters(config, logger, { fetchImpl: failing('ENOTFOUND', 'getaddrinfo ENOTFOUND slack.com') });
    expect(await dns.channelMessages?.post({ channel: '#dev-test', text: 'hi' })).toEqual({
      status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false,
    });
    // Without connection-stage evidence an unreachable-host error may come after the request was written.
    const unreachable = createConnectorWriters(config, logger, { fetchImpl: failing('EHOSTUNREACH', 'read EHOSTUNREACH') });
    expect(await unreachable.channelMessages?.post({ channel: '#dev-test', text: 'hi' })).toEqual({ status: 'UNCERTAIN', reason: 'TRANSPORT' });
  });

  it('a non-allowlisted target is refused by the built writer before any network call', async () => {
    const { logger } = testLogger();
    const config = loadConfig(env({
      ...JIRA_ENV,
      QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
      QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: 'PROJ',
      QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: BOT_TOKEN,
      QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: 'C0123ABCD9',
    }));
    const writers = createConnectorWriters(config, logger, { fetchImpl: noNetwork });
    expect(await writers.issueComments?.addComment({ issueKey: 'OTHER-9', text: 'hi' })).toMatchObject({
      status: 'NOT_SENT', reason: 'TARGET_NOT_ALLOWED',
    });
    expect(await writers.channelMessages?.post({ channel: '#general', text: 'hi' })).toMatchObject({
      status: 'NOT_SENT', reason: 'TARGET_NOT_ALLOWED',
    });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('skips Jira writes without the read connector credentials, with a fixed warning code', () => {
    const { logger, warn } = testLogger();
    const config = loadConfig(env({ QUOKY_CONNECTOR_WRITES_ENABLED: 'true', QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: 'PROJ' }));
    expect(createConnectorWriters(config, logger)).toEqual({});
    expect(warn).toHaveBeenCalledWith('connector writer not registered', {
      reason: ConnectorWriterNotRegisteredReason.JIRA_NOT_CONFIGURED,
    });
    assertNothingSecretLogged(warn);
  });

  it('builds the calendar writer only with QUOKY_CALENDAR_WRITE_ENABLED and a calendar.events grant', () => {
    const rw = join(dir, 'rw.json');
    writeGoogleCalendarTokenFile(rw, REFRESH_TOKEN, GOOGLE_CALENDAR_READ_WRITE_SCOPE);
    const ro = join(dir, 'ro.json');
    writeGoogleCalendarTokenFile(ro, REFRESH_TOKEN);

    const on = (extra: Record<string, string>) =>
      loadConfig(env({ ...CALENDAR_CLIENT_ENV, QUOKY_CALENDAR_WRITE_ENABLED: 'true', ...extra }));

    const writable = testLogger();
    expect(createConnectorWriters(on({ QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: rw }), writable.logger).calendarEvents).toBeInstanceOf(
      GoogleCalendarWriter,
    );
    expect(writable.warn).not.toHaveBeenCalled();

    const inline = testLogger();
    expect(createConnectorWriters(on({ QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN }), inline.logger).calendarEvents)
      .toBeInstanceOf(GoogleCalendarWriter);

    const readonlyGrant = testLogger();
    expect(createConnectorWriters(on({ QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: ro }), readonlyGrant.logger).calendarEvents).toBeUndefined();
    expect(readonlyGrant.warn).toHaveBeenCalledWith('connector writer not registered', {
      reason: ConnectorWriterNotRegisteredReason.CALENDAR_SCOPE_MISSING,
    });

    const missingFile = testLogger();
    expect(createConnectorWriters(on({ QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: join(dir, 'missing.json') }), missingFile.logger).calendarEvents)
      .toBeUndefined();
    expect(missingFile.warn).toHaveBeenCalledWith('connector writer not registered', { reason: 'CALENDAR_TOKEN_FILE_UNREADABLE' });

    const conflict = testLogger();
    expect(createConnectorWriters(
      on({ QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: rw, QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN }), conflict.logger,
    ).calendarEvents).toBeUndefined();
    expect(conflict.warn).toHaveBeenCalledWith('connector writer not registered', {
      reason: ConnectorWriterNotRegisteredReason.CALENDAR_TOKEN_SOURCE_CONFLICT,
    });

    const noCalendar = testLogger();
    expect(createConnectorWriters(loadConfig(env({ QUOKY_CALENDAR_WRITE_ENABLED: 'true' })), noCalendar.logger)).toEqual({});
    expect(noCalendar.warn).toHaveBeenCalledWith('connector writer not registered', {
      reason: ConnectorWriterNotRegisteredReason.CALENDAR_NOT_CONFIGURED,
    });

    const off = testLogger();
    expect(createConnectorWriters(
      loadConfig(env({ ...CALENDAR_CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: rw })), off.logger,
    )).toEqual({});

    for (const { warn } of [writable, inline, readonlyGrant, missingFile, conflict, noCalendar, off]) {
      assertNothingSecretLogged(warn);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(dir);
    }
  });
});
