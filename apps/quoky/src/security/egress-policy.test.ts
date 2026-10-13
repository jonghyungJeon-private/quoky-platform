import { describe, expect, it } from 'vitest';
import { EgressConfigErrorCode, parseEgressConfig } from './egress-config';
import { buildEgressInventory, checkDestination, labelFor, pathTemplate } from './egress-policy';
import type { EgressInventorySource } from './egress-policy';

const MINIMAL: EgressInventorySource = {
  connectors: {},
  connectorWrites: {},
  ai: { ollamaEnabled: false },
};

const FULL: EgressInventorySource = {
  telegram: {},
  connectors: { jira: { host: 'https://acme.atlassian.net' }, slack: {}, confluence: { host: 'acme.atlassian.net' } },
  connectorWrites: {},
  calendar: {},
  gmail: {},
  drive: {},
  githubApp: {},
  ai: { openai: {}, gemini: {}, ollamaEnabled: true },
};

describe('egress inventory (design §5.1): derived from configuration only', () => {
  it('a minimal configuration allows Discord only, with no local endpoint', () => {
    const inventory = buildEgressInventory(MINIMAL);
    expect([...inventory.hosts.keys()].sort()).toEqual(['cdn.discordapp.com', 'discord.com', 'gateway.discord.gg', 'media.discordapp.net']);
    expect(inventory.localEndpoints).toEqual([]);
  });

  it('each configured connector and platform adds exactly its hosts', () => {
    const inventory = buildEgressInventory(FULL);
    expect(Object.fromEntries(inventory.hosts)).toEqual({
      'discord.com': 'discord',
      'gateway.discord.gg': 'discord',
      'cdn.discordapp.com': 'discord-attachments',
      'media.discordapp.net': 'discord-attachments',
      'api.telegram.org': 'telegram',
      'www.googleapis.com': 'google',
      'gmail.googleapis.com': 'gmail',
      'oauth2.googleapis.com': 'google-oauth',
      'acme.atlassian.net': 'jira',
      'slack.com': 'slack',
      'api.github.com': 'github',
      'api.openai.com': 'openai',
      'generativelanguage.googleapis.com': 'gemini',
    });
    expect(inventory.localEndpoints).toEqual([{ host: '127.0.0.1', port: 11434, label: 'ollama-local' }]);
    expect(Object.isFrozen(inventory)).toBe(true);
  });

  it('labels refine by path where the §5.3 budgets differ', () => {
    const inventory = buildEgressInventory(FULL);
    expect(labelFor(inventory, 'api.telegram.org', 443, '/bot1/getUpdates')).toBe('telegram-poll');
    expect(labelFor(inventory, 'api.telegram.org', 443, '/bot1/sendMessage')).toBe('telegram');
    expect(labelFor(inventory, 'api.telegram.org', 443, '/file/bot1/photos/a.jpg')).toBe('telegram-file');
    expect(labelFor(inventory, 'www.googleapis.com', 443, '/calendar/v3/calendars/primary/events?x=1')).toBe('google-calendar');
    expect(labelFor(inventory, 'www.googleapis.com', 443, '/drive/v3/files')).toBe('google-drive');
    expect(labelFor(inventory, 'slack.com', 443, '/api/search.messages')).toBe('slack-search');
    expect(labelFor(inventory, 'acme.atlassian.net', 443, '/wiki/rest/api/content')).toBe('confluence');
    expect(labelFor(inventory, 'acme.atlassian.net', 443, '/rest/api/3/search/jql')).toBe('jira');
    expect(labelFor(inventory, '127.0.0.1', 11434, '/api/tags')).toBe('ollama-local');
    expect(labelFor(inventory, 'elsewhere.example', 443, '/')).toBe('unlisted');
  });

  it('name checks: https only, no IP literal, allowlisted host; plain http only for the exact local endpoint', () => {
    const inventory = buildEgressInventory(FULL);
    expect(checkDestination(inventory, { protocol: 'https:', host: 'slack.com', port: 443 })).toEqual([]);
    expect(checkDestination(inventory, { protocol: 'https:', host: 'SLACK.COM', port: 443 })).toEqual([]);
    expect(checkDestination(inventory, { protocol: 'http:', host: 'slack.com', port: 80 })).toEqual(['insecure-scheme']);
    expect(checkDestination(inventory, { protocol: 'https:', host: 'evil.example', port: 443 })).toEqual(['new-destination']);
    expect(checkDestination(inventory, { protocol: 'https:', host: '93.184.216.34', port: 443 })).toEqual(['ip-literal']);
    expect(checkDestination(inventory, { protocol: 'http:', host: '127.0.0.1', port: 11434 })).toEqual([]);
    expect(checkDestination(inventory, { protocol: 'http:', host: '127.0.0.1', port: 8080 })).toEqual(['insecure-scheme', 'ip-literal']);
    expect(checkDestination(inventory, { protocol: 'http:', host: 'localhost', port: 11434 })).toEqual(['insecure-scheme', 'new-destination']);
    expect(checkDestination(buildEgressInventory(MINIMAL), { protocol: 'http:', host: '127.0.0.1', port: 11434 })).toEqual([
      'insecure-scheme',
      'ip-literal',
    ]);
  });
});

describe('ledger path template (design §5.4): no query, no ids, no token segment', () => {
  it.each([
    ['/rest/api/3/search?jql=project%3DX', '/rest/api/3/search'],
    ['/calendar/v3/calendars/owner@example.com/events?timeMin=x', '/calendar/v3/calendars/{id}/events'],
    ['/gmail/v1/users/me/messages/18c2f0a9b1d2e3f4', '/gmail/v1/users/me/messages/{id}'],
    ['/rest/api/3/issue/PROJ-123', '/rest/api/3/issue/{id}'],
    ['/api/v10/channels/123456789012345678/messages', '/api/v10/channels/{id}/messages'],
    ['/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz_0123/export', '/drive/v3/files/{id}/export'],
    ['/', '/'],
    ['', '/'],
  ])('%s → %s', (path, template) => {
    expect(pathTemplate(path)).toBe(template);
  });

  it('a Telegram bot token segment and a webhook token never survive', () => {
    // Built from fragments: no token-shaped literal in the source.
    const botToken = ['1234', '56789'].join('') + ':' + 'AAbbCC_dd-'.repeat(4);
    expect(pathTemplate(`/bot${botToken}/getUpdates`)).toBe('/{id}/getUpdates');
    expect(pathTemplate(`/file/bot${botToken}/photos/file_7.jpg`)).toBe('/file/{id}/photos/{id}');
    const longWord = 'abcdefghij'.repeat(5);
    expect(pathTemplate(`/api/webhooks/123/${longWord}`)).toBe('/api/webhooks/{id}/{id}');
  });
});

describe('egress configuration (QUOKY_EGRESS_*)', () => {
  it('defaults to observe with a 16 MiB file cap and 90-day retention', () => {
    expect(parseEgressConfig({})).toEqual({ mode: 'observe', ledgerMaxFileBytes: 16 * 1024 * 1024, ledgerRetentionDays: 90 });
  });

  it.each(['off', 'observe', 'enforce'] as const)('accepts mode %s exactly', (mode) => {
    expect(parseEgressConfig({ QUOKY_EGRESS_GUARD: mode }).mode).toBe(mode);
  });

  it.each(['', 'OBSERVE', 'on', 'true', ' enforce'])('refuses mode %j with a value-free code', (value) => {
    expect(() => parseEgressConfig({ QUOKY_EGRESS_GUARD: value })).toThrow(EgressConfigErrorCode.EGRESS_GUARD_INVALID);
  });

  it('bounds the ledger settings', () => {
    expect(parseEgressConfig({ QUOKY_EGRESS_LEDGER_MAX_FILE_MB: '1', QUOKY_EGRESS_LEDGER_RETENTION_DAYS: '365' })).toMatchObject({
      ledgerMaxFileBytes: 1024 * 1024,
      ledgerRetentionDays: 365,
    });
    for (const value of ['0', '257', '1.5', '-1', '']) {
      expect(() => parseEgressConfig({ QUOKY_EGRESS_LEDGER_MAX_FILE_MB: value })).toThrow(
        EgressConfigErrorCode.EGRESS_LEDGER_MAX_FILE_MB_INVALID,
      );
    }
    for (const value of ['0', '366', 'x']) {
      expect(() => parseEgressConfig({ QUOKY_EGRESS_LEDGER_RETENTION_DAYS: value })).toThrow(
        EgressConfigErrorCode.EGRESS_LEDGER_RETENTION_DAYS_INVALID,
      );
    }
  });
});
