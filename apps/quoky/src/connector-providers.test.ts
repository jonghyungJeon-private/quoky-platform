import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorManager, type Logger } from '@quoky/core';

import { loadConfig } from './config';
import { createConnectorProviders } from './connector-providers';

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  // Personal edition requires an owner id (ADR-0091); unrelated to the connector settings under test.
  return { QUOKY_DISCORD_OWNER_IDS: '111111111111111111', ...overrides } as NodeJS.ProcessEnv;
}

function logger(warn = vi.fn()): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  return { logger: { info: vi.fn(), warn, error: vi.fn() }, warn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composition-root connector registration', () => {
  it('omits connectors with missing or partial configuration', () => {
    const { logger: testLogger } = logger();
    const manager = new ConnectorManager(
      createConnectorProviders(
        loadConfig(
          env({
            CHUNSIK_JIRA_BASE_URL: 'https://example.atlassian.net',
            CHUNSIK_JIRA_TOKEN: 'jira-token',
            CHUNSIK_SLACK_TOKEN: '   ',
            CHUNSIK_CONFLUENCE_BASE_URL: 'https://example.atlassian.net',
          }),
        ).connectors,
        testLogger,
      ),
    );

    expect(manager.list()).toEqual([]);
  });

  it('omits malformed connector hosts without crashing unrelated connector registration', () => {
    const { logger: testLogger, warn } = logger();
    const manager = new ConnectorManager(
      createConnectorProviders(
        loadConfig(
          env({
            CHUNSIK_JIRA_BASE_URL: 'https://jira.example.atlassian.net/browse',
            CHUNSIK_JIRA_EMAIL: 'builder@example.com',
            CHUNSIK_JIRA_TOKEN: 'jira-token',
            CHUNSIK_SLACK_TOKEN: 'slack-token',
            CHUNSIK_CONFLUENCE_BASE_URL: 'https://confluence.example.atlassian.net/wiki',
            CHUNSIK_CONFLUENCE_TOKEN: 'confluence-token',
          }),
        ).connectors,
        testLogger,
      ),
    );

    expect(manager.list().map((connector) => connector.source)).toEqual(['slack']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, 'connector configuration rejected; connector not registered', {
      source: 'jira',
      reason: 'jira connector: host must be an https host without credentials, port, path, query, or fragment',
    });
    expect(warn).toHaveBeenNthCalledWith(2, 'connector configuration rejected; connector not registered', {
      source: 'confluence',
      reason: 'confluence connector: host must be an https host without credentials, port, path, query, or fragment',
    });
  });

  it('enumerates and queries all fully configured read-only adapters', async () => {
    const { logger: testLogger } = logger();
    const fetchStub = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/rest/api/3/search/jql') {
        return Response.json({ issues: [] });
      }
      if (url.pathname === '/api/conversations.list') {
        return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: '' } });
      }
      if (url.pathname === '/wiki/api/v2/pages') {
        return Response.json({ results: [] });
      }
      throw new Error(`unexpected connector request path: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchStub);

    const manager = new ConnectorManager(
      createConnectorProviders(
        loadConfig(
          env({
            CHUNSIK_JIRA_BASE_URL: 'https://jira.example.atlassian.net',
            CHUNSIK_JIRA_EMAIL: 'builder@example.com',
            CHUNSIK_JIRA_TOKEN: 'jira-token',
            CHUNSIK_SLACK_TOKEN: 'slack-token',
            CHUNSIK_CONFLUENCE_BASE_URL: 'https://confluence.example.atlassian.net',
            CHUNSIK_CONFLUENCE_TOKEN: 'confluence-token',
          }),
        ).connectors,
        testLogger,
      ),
    );

    expect(manager.list().map((connector) => connector.source)).toEqual(['jira', 'slack', 'confluence']);
    await expect(manager.query('jira', { query: 'personal-work', params: { actorExternalId: 'account-123' } })).resolves.toEqual({ source: 'jira', items: [] });
    await expect(manager.query('slack', { query: '', params: { kind: 'channels' } })).resolves.toEqual({
      source: 'slack',
      items: [],
    });
    await expect(manager.query('confluence', { query: '', params: { kind: 'pages' } })).resolves.toEqual({
      source: 'confluence',
      items: [],
    });
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });
});
