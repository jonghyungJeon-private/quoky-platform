import { describe, expect, it } from 'vitest';
import { EgressConfigErrorCode, parseEgressConfig } from './egress-config';
import { TELEGRAM_METHODS } from '@quoky/adapter-telegram';
import { GOOGLE_SHEETS_METHODS, SLACK_METHODS, buildEgressInventory, checkDestination, labelFor, pathTemplate } from './egress-policy';
import { EGRESS_BUDGETS } from './egress-budget';
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
      'sheets.googleapis.com': 'google-sheets',
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

describe('ledger path template (design §5.4): an allow-list of fixed prefixes, every later segment {id}', () => {
  it.each([
    ['jira', '/rest/api/3/search?jql=project%3DX', '/rest/api/3/search'],
    ['jira', '/rest/api/3/search/jql', '/rest/api/3/search/jql'],
    ['jira', '/rest/api/3/issue/PROJ-123', '/rest/api/3/issue/{id}'],
    ['jira', '/rest/api/3/issue/PROJ-123/comment', '/rest/api/3/issue/{id}/{id}'],
    ['google-calendar', '/calendar/v3/calendars/owner@example.com/events?timeMin=x', '/calendar/v3/calendars/{id}/{id}'],
    ['google-calendar', '/calendar/v3/calendars/primary/events', '/calendar/v3/calendars/{id}/{id}'],
    ['gmail', '/gmail/v1/users/me/messages/18c2f0a9b1d2e3f4', '/gmail/v1/users/me/messages/{id}'],
    ['google-drive', '/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz_0123/export', '/drive/v3/files/{id}/{id}'],
    ['google-drive', '/drive/v3/files/budget/export', '/drive/v3/files/{id}/{id}'],
    // DRV-2b: the spreadsheet id never survives; only the closed Sheets method list is kept.
    ['google-sheets', '/v4/spreadsheets/1AbCdEfGh_ij-KL?fields=sheets.properties(title)', '/v4/spreadsheets/{id}'],
    ['google-sheets', "/v4/spreadsheets/budget/values:batchGet?ranges='Salaries'!A1:Z10", '/v4/spreadsheets/{id}/values:batchGet'],
    ['google-sheets', '/v4/spreadsheets/budget:batchUpdate', '/v4/spreadsheets/{id}'],
    ['google-sheets', '/v4/spreadsheets/budget/values:append', '/v4/spreadsheets/{id}/{method}'],
    ['google-sheets', '/v4/spreadsheets/budget/Salaries', '/v4/spreadsheets/{id}/{method}'],
    ['google-sheets', '/v4/spreadsheets/budget/values/Salaries!A1', '/v4/spreadsheets/{id}/{id}/{id}'],
    ['google-sheets', '/v4/spreadsheets', '/v4/spreadsheets'],
    ['google-sheets', '/v3/feeds/payroll', '/{id}/{id}/{id}'],
    ['discord', '/api/v10/channels/123456789012345678/messages', '/api/v10/channels/{id}/{id}'],
    ['discord', '/api/v10/users/alice', '/api/v10/users/{id}'],
    ['discord', '/api/v10/gateway/bot', '/api/v10/gateway/bot'],
    ['discord-typing', '/api/v10/channels/123/typing', '/api/v10/channels/{id}/{id}'],
    // Discord CDN: channel id, attachment id and a letter-only file name all become {id}.
    ['discord-attachments', '/attachments/111/222/salary_review.pdf?ex=1&hm=abc', '/attachments/{id}/{id}/{id}'],
    ['discord-attachments', '/attachments/111/222/salary.pdf', '/attachments/{id}/{id}/{id}'],
    // GitHub owner and repository names never survive, letters only or not.
    ['github', '/repos/acme/payroll/pulls', '/repos/{id}/{id}/{id}'],
    ['github', '/users/alice', '/users/{id}'],
    ['github', '/app/installations/42/access_tokens', '/app/installations/{id}/{id}'],
    // Confluence space keys and page ids.
    ['confluence', '/wiki/rest/api/space/HR/content', '/wiki/rest/api/space/{id}/{id}'],
    ['confluence', '/wiki/api/v2/spaces/SECRETSPACE/pages', '/wiki/api/v2/spaces/{id}/{id}'],
    ['confluence', '/wiki/somethingElse/private', '/{id}/{id}/{id}'],
    ['slack', '/api/search.messages', '/api/search.messages'],
    ['slack', '/api/conversations.info', '/api/conversations.info'],
    ['slack', '/api/payroll/channel', '/api/{method}/{id}'],
    ['slack', '/api/private.customerSecret', '/api/{method}'],
    ['slack-search', '/api/search.customerSecret?query=x', '/api/{method}'],
    ['slack', '/other/path', '/{id}/{id}'],
    ['google-oauth', '/token', '/token'],
    ['openai', '/v1/chat/completions', '/v1/chat/completions'],
    ['gemini', '/v1beta/models/gemini-x:generateContent', '/v1beta/models/{id}'],
    ['ollama-local', '/api/tags', '/api/tags'],
    // An unlisted host keeps no segment at all, letters only or not.
    ['unlisted', '/users/alice', '/{id}/{id}'],
    ['unlisted', '/x', '/{id}'],
    ['jira', '/', '/'],
    ['jira', '', '/'],
  ])('%s %s → %s', (label, path, template) => {
    expect(pathTemplate(label, path)).toBe(template);
  });

  it('webhook paths keep no secret segment, including a letters-only token', () => {
    const lettersOnlyToken = 'AlphabeticSecretToken';
    expect(pathTemplate('discord', `/api/v10/webhooks/123/${lettersOnlyToken}`)).toBe('/api/v10/webhooks/{id}/{id}');
    expect(pathTemplate('unlisted', `/webhooks/123/${lettersOnlyToken}`)).toBe('/{id}/{id}/{id}');
    expect(pathTemplate('discord', `/api/webhooks/123/${lettersOnlyToken}`)).not.toContain(lettersOnlyToken);
  });

  it('a Telegram bot token never survives; only a method of the adapter\'s closed list is kept', () => {
    // Built from fragments: no token-shaped literal in the source.
    const botToken = ['1234', '56789'].join('') + ':' + 'AAbbCC_dd-'.repeat(4);
    expect(pathTemplate('telegram-poll', `/bot${botToken}/getUpdates`)).toBe('/{id}/getUpdates');
    expect(pathTemplate('telegram', `/bot${botToken}/sendMessage`)).toBe('/{id}/sendMessage');
    expect(pathTemplate('telegram', `/bot${botToken}/privateWord`)).toBe('/{id}/{method}');
    for (const method of TELEGRAM_METHODS.filter((name) => name !== 'downloadFile')) {
      expect(pathTemplate('telegram', `/bot${botToken}/${method}`)).toBe(`/{id}/${method}`);
    }
    expect(pathTemplate('telegram-file', `/file/bot${botToken}/photos/file_7.jpg`)).toBe('/file/{id}/{id}/{id}');
  });

  it('Slack keeps only the methods Quoky calls; any other dotted method is {method}', () => {
    expect([...SLACK_METHODS].sort()).toEqual([
      'chat.getPermalink', 'chat.postMessage', 'conversations.history', 'conversations.info', 'conversations.list',
      'conversations.replies', 'search.messages',
    ]);
    for (const method of SLACK_METHODS) expect(pathTemplate('slack', `/api/${method}?cursor=abc`)).toBe(`/api/${method}`);
    for (const method of ['auth.test', 'private.customerSecret', 'users.info', 'search.messages.extra', 'a.b']) {
      expect(pathTemplate('slack', `/api/${method}`), method).toBe('/api/{method}');
    }
  });

  it('DRV-2b: sheets.googleapis.com is allowlisted only with Drive configured, with its own budget label', () => {
    const driveOnly = buildEgressInventory({ ...MINIMAL, drive: {} });
    expect(driveOnly.hosts.get('sheets.googleapis.com')).toBe('google-sheets');
    expect(buildEgressInventory({ ...MINIMAL, calendar: {} }).hosts.has('sheets.googleapis.com')).toBe(false);
    expect(buildEgressInventory({ ...MINIMAL, gmail: {} }).hosts.has('sheets.googleapis.com')).toBe(false);
    expect(labelFor(driveOnly, 'sheets.googleapis.com', 443, '/v4/spreadsheets/x/values:batchGet')).toBe('google-sheets');
    expect(labelFor(driveOnly, 'SHEETS.googleapis.com', 443, '/v4/spreadsheets/x')).toBe('google-sheets');
    expect(checkDestination(driveOnly, { protocol: 'https:', host: 'sheets.googleapis.com', port: 443 })).toEqual([]);
    expect(checkDestination(driveOnly, { protocol: 'https:', host: 'evil.sheets.googleapis.com', port: 443 })).toEqual(['new-destination']);
    expect(EGRESS_BUDGETS['google-sheets']).toEqual(EGRESS_BUDGETS['google-drive']);
    expect([...GOOGLE_SHEETS_METHODS]).toEqual(['values:batchGet']);
  });

  it('at most six {id} segments follow the prefix', () => {
    expect(pathTemplate('unlisted', '/a/b/c/d/e/f/g/h/i')).toBe('/{id}/{id}/{id}/{id}/{id}/{id}');
  });

  it('typing indicators get their own labels', () => {
    const inventory = buildEgressInventory(FULL);
    expect(labelFor(inventory, 'api.telegram.org', 443, '/bot1/sendChatAction')).toBe('telegram-typing');
    expect(labelFor(inventory, 'discord.com', 443, '/api/v10/channels/123/typing')).toBe('discord-typing');
    expect(labelFor(inventory, 'discord.com', 443, '/api/v10/channels/123/messages')).toBe('discord');
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
