import { describe, expect, it } from 'vitest';
import { ConnectorQueryError, type ConnectorQuery } from '@quoky/core';
import {
  JiraConnectorHttpError,
  JiraConnectorProvider,
  type JiraConnectorConfig,
} from './index';

const TOKEN = 'jira-secret-token';

function fakeFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function provider(fetchImpl: typeof fetch, config: Partial<JiraConnectorConfig> = {}): JiraConnectorProvider {
  return new JiraConnectorProvider({
    host: 'example.atlassian.net',
    email: 'dev@example.com',
    apiToken: TOKEN,
    fetchImpl,
    ...config,
  });
}

function personalWork(actorExternalId = 'account-123', extra: Record<string, unknown> = {}): ConnectorQuery {
  return { query: 'personal-work', params: { actorExternalId, ...extra } };
}

describe('JiraConnectorProvider', () => {
  it('maps successful Jira results to ConnectorItems with optional status, due date, update time and project', async () => {
    const issue = {
      key: 'PROJ-42',
      fields: {
        summary: 'Ship the connector',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read only.' }] }] },
        status: { name: 'In Progress' },
        duedate: '2026-10-09',
        updated: '2026-10-02T10:00:00.000+0900',
      },
    };
    const fake = fakeFetch(200, { issues: [issue] });

    const result = await provider(fake.fetchImpl).query(personalWork());

    expect(result).toEqual({
      source: 'jira',
      items: [{
        id: 'PROJ-42',
        title: 'Ship the connector',
        url: 'https://example.atlassian.net/browse/PROJ-42',
        summary: 'Read only.',
        status: 'In Progress',
        dueDate: '2026-10-09',
        updatedAt: '2026-10-02T01:00:00.000Z',
        container: 'PROJ',
        raw: { json: JSON.stringify(issue) },
      }],
    });
    expect(result.items[0]).not.toHaveProperty('content');
    expect(result.items[0]).not.toHaveProperty('metadata');
  });

  it('uses GET /rest/api/3/search/jql with explicit fields and a bounded maxResults for the default filter', async () => {
    const fake = fakeFetch(200, { issues: [] });
    await expect(provider(fake.fetchImpl).query(personalWork())).resolves.toEqual({ source: 'jira', items: [] });

    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://example.atlassian.net/rest/api/3/search/jql');
    expect(url.searchParams.get('jql')).toBe('assignee = "account-123" AND resolution = Unresolved AND statusCategory != Done ORDER BY updated DESC');
    expect(url.searchParams.get('fields')).toBe('summary,status,duedate,updated,description');
    expect(url.searchParams.get('maxResults')).toBe('20');
    expect(fake.calls[0]!.init?.method).toBe('GET');
    expect(fake.calls[0]!.init?.body).toBeUndefined();
  });

  it('renders the due-this-week filter as endOfWeek() ordered by due date', async () => {
    const fake = fakeFetch(200, { issues: [] });
    await provider(fake.fetchImpl).query(personalWork('account-123', { filter: 'due-this-week', limit: 5 }));
    const url = new URL(fake.calls[0]!.url);
    expect(url.searchParams.get('jql')).toBe(
      'assignee = "account-123" AND resolution = Unresolved AND statusCategory != Done AND duedate <= endOfWeek() ORDER BY duedate ASC',
    );
    expect(url.searchParams.get('maxResults')).toBe('5');
  });

  it('ADR-0120 D13: renders the window, role and status as escaped JQL; defaults reproduce the ADR-0100 query', async () => {
    const fake = fakeFetch(200, { issues: [] });
    const jira = provider(fake.fetchImpl);
    await jira.query(personalWork('account-123', { window: { field: 'created', from: '2026-10-12', to: '2026-10-13' }, role: 'either' }));
    await jira.query(personalWork('account-123', { window: { field: 'due', from: '2026-10-12', to: '2026-10-19' }, role: 'reporter', status: 'all' }));
    await jira.query(personalWork('account-123', { window: { field: 'updated', from: '2026-10-05', to: '2026-10-12' } }));
    await jira.query(personalWork('account-123', { role: 'assignee', status: 'open' }));
    const jql = fake.calls.map((call) => new URL(call.url).searchParams.get('jql'));
    expect(jql).toEqual([
      '(assignee = "account-123" OR reporter = "account-123") AND resolution = Unresolved AND statusCategory != Done AND created >= "2026-10-12" AND created < "2026-10-13" ORDER BY created DESC',
      'reporter = "account-123" AND duedate >= "2026-10-12" AND duedate < "2026-10-19" ORDER BY duedate ASC',
      'assignee = "account-123" AND resolution = Unresolved AND statusCategory != Done AND updated >= "2026-10-05" AND updated < "2026-10-12" ORDER BY updated DESC',
      'assignee = "account-123" AND resolution = Unresolved AND statusCategory != Done ORDER BY updated DESC',
    ]);
  });

  it('ADR-0120 follow-up: in-progress renders the status category literal, keeps the role and window, and escapes the identity', async () => {
    const fake = fakeFetch(200, { issues: [] });
    const jira = provider(fake.fetchImpl);
    await jira.query(personalWork('account-123', { status: 'in-progress' }));
    await jira.query(personalWork('account-123', { role: 'either', status: 'in-progress', window: { field: 'updated', from: '2026-10-05', to: '2026-10-12' } }));
    await jira.query(personalWork('a"b', { role: 'reporter', status: 'in-progress' }));
    const jql = fake.calls.map((call) => new URL(call.url).searchParams.get('jql'));
    expect(jql).toEqual([
      'assignee = "account-123" AND statusCategory = "In Progress" ORDER BY updated DESC',
      '(assignee = "account-123" OR reporter = "account-123") AND statusCategory = "In Progress" AND updated >= "2026-10-05" AND updated < "2026-10-12" ORDER BY updated DESC',
      'reporter = "a\\"b" AND statusCategory = "In Progress" ORDER BY updated DESC',
    ]);
  });

  it('ADR-0120 P3: bounds created/updated by minutes relative to now, so the Jira profile time zone cannot shift the window', async () => {
    const fake = fakeFetch(200, { issues: [] });
    // Now: 2026-10-12 12:00 in Asia/Seoul (03:00Z). "Today" in Seoul is [2026-10-11T15:00Z, 2026-10-12T15:00Z).
    const jira = provider(fake.fetchImpl, { now: () => Date.parse('2026-10-12T03:00:00.000Z') });
    const today = { field: 'created', from: '2026-10-12', to: '2026-10-13', fromInstant: '2026-10-11T15:00:00.000Z', toInstant: '2026-10-12T15:00:00.000Z' };
    await jira.query(personalWork('account-123', { window: today }));
    await jira.query(personalWork('account-123', { window: { ...today, field: 'updated', fromInstant: '2026-10-11T15:00:30.000Z' } }));
    // A due date has no zone: the owner's local dates are used as they are.
    await jira.query(personalWork('account-123', { window: { ...today, field: 'due' } }));
    const jql = fake.calls.map((call) => new URL(call.url).searchParams.get('jql'));
    expect(jql[0]).toBe(
      'assignee = "account-123" AND resolution = Unresolved AND statusCategory != Done AND created >= "-720m" AND created < "720m" ORDER BY created DESC',
    );
    // Rounded so the window never shrinks: the lower bound one minute earlier at most.
    expect(jql[1]).toContain('updated >= "-720m" AND updated < "720m"');
    expect(jql[2]).toContain('duedate >= "2026-10-12" AND duedate < "2026-10-13"');
  });

  it('ADR-0120 D13: refuses a window outside the closed set, a reversed or over-31-day window, and a window with the due filter, before any request', async () => {
    const fake = fakeFetch(200, { issues: [] });
    const jira = provider(fake.fetchImpl);
    for (const extra of [
      { window: { field: 'resolved', from: '2026-10-12', to: '2026-10-13' } },
      { window: { field: 'created', from: '2026-10-13', to: '2026-10-12' } },
      { window: { field: 'created', from: '2026-08-01', to: '2026-10-13' } },
      { window: { field: 'created', from: '2026-10-12" OR project = SECRET', to: '2026-10-13' } },
      { window: { field: 'created', from: '2026-10-12', to: '2026-10-13' }, filter: 'due-this-week' },
      { role: 'watcher' },
      { status: 'done' },
    ]) {
      await expect(jira.query(personalWork('account-123', extra))).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('clamps an oversized limit to 20 and rejects a non-positive limit before any request', async () => {
    const fake = fakeFetch(200, { issues: [] });
    await provider(fake.fetchImpl).query(personalWork('account-123', { limit: 500 }));
    expect(new URL(fake.calls[0]!.url).searchParams.get('maxResults')).toBe('20');

    await expect(provider(fake.fetchImpl).query(personalWork('account-123', { limit: 0 }))).rejects.toMatchObject({
      reason: 'UNSUPPORTED_QUERY',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('never accepts caller-supplied JQL: unknown or raw queries are UNSUPPORTED_QUERY and send nothing', async () => {
    const fake = fakeFetch(200, { issues: [] });
    const jira = provider(fake.fetchImpl);
    for (const query of ['project = PROJ', 'search', 'key = SEC-1', '', 'PERSONAL-WORK']) {
      await expect(jira.query({ query, params: { actorExternalId: 'x', text: 'y', jql: 'project = PROJ' } })).rejects.toMatchObject({
        name: 'ConnectorQueryError',
        reason: 'UNSUPPORTED_QUERY',
      });
    }
    await expect(jira.query(personalWork('account-123', { filter: 'review-requested' }))).rejects.toMatchObject({
      reason: 'UNSUPPORTED_QUERY',
    });
    await expect(jira.query(personalWork('account-123', { filter: 'project = PROJ' }))).rejects.toMatchObject({
      reason: 'UNSUPPORTED_QUERY',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('escapes quotes and backslashes in the actor identity and rejects control characters', async () => {
    const fake = fakeFetch(200, { issues: [] });
    await provider(fake.fetchImpl).query(personalWork('a"b\\c" OR project = SECRET'));
    expect(new URL(fake.calls[0]!.url).searchParams.get('jql')).toBe(
      'assignee = "a\\"b\\\\c\\" OR project = SECRET" AND resolution = Unresolved AND statusCategory != Done ORDER BY updated DESC',
    );

    await expect(provider(fake.fetchImpl).query(personalWork('a\nb'))).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    await expect(provider(fake.fetchImpl).query({ query: 'personal-work' })).rejects.toThrow(/identity/);
    expect(fake.calls).toHaveLength(1);
  });

  it('sends Basic auth without returning or exposing the token', async () => {
    const fake = fakeFetch(200, { issues: [{ key: 'SEC-1', fields: { summary: 'Safe', description: TOKEN, status: { name: TOKEN } } }] });
    const result = await provider(fake.fetchImpl).query(personalWork());

    const headers = new Headers(fake.calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`dev@example.com:${TOKEN}`).toString('base64')}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([
    ['host', { host: ' ' }],
    ['email', { email: '' }],
    ['api token', { apiToken: '   ' }],
    ['timeout', { timeoutMs: 0 }],
  ])('rejects a missing or invalid %s at construction', (_label, badConfig) => {
    const fake = fakeFetch(200, { issues: [] });
    expect(() => provider(fake.fetchImpl, badConfig)).toThrow();
  });

  it.each([
    [401, 'UNAUTHORIZED', 'UNAUTHORIZED'],
    [403, 'FORBIDDEN', 'FORBIDDEN'],
    [404, 'NOT_FOUND', 'NOT_FOUND'],
    [429, 'RATE_LIMITED', 'RATE_LIMITED'],
    [500, 'SERVER_ERROR', 'UNAVAILABLE'],
    [503, 'SERVER_ERROR', 'UNAVAILABLE'],
  ] as const)('maps HTTP %i to a sanitized typed error with reason %s', async (status, kind, reason) => {
    const fake = fakeFetch(status, { errorMessages: [`failure ${TOKEN}`] });
    const promise = provider(fake.fetchImpl).query(personalWork());

    await expect(promise).rejects.toMatchObject({
      name: 'JiraConnectorHttpError',
      kind,
      status,
      reason,
    } satisfies Partial<JiraConnectorHttpError>);
    await expect(promise).rejects.toBeInstanceOf(ConnectorQueryError);
    await expect(promise).rejects.not.toThrow(TOKEN);
  });

  it('maps a timeout to UNAVAILABLE and passes an abort signal on every request', async () => {
    const jira = provider(((_url: URL | RequestInfo, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch, { timeoutMs: 5 });
    const promise = jira.query(personalWork());
    await expect(promise).rejects.toMatchObject({ name: 'JiraConnectorRequestError', reason: 'UNAVAILABLE' });
    await expect(promise).rejects.not.toThrow(TOKEN);

    const fake = fakeFetch(200, { issues: [] });
    await provider(fake.fetchImpl).query(personalWork());
    expect(fake.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a malformed response to INVALID_RESPONSE', async () => {
    await expect(provider(fakeFetch(200, { nope: true }).fetchImpl).query(personalWork())).rejects.toMatchObject({
      reason: 'INVALID_RESPONSE',
    });
    await expect(provider(fakeFetch(200, { issues: [{ fields: {} }] }).fetchImpl).query(personalWork())).rejects.toMatchObject({
      reason: 'INVALID_RESPONSE',
    });
  });

  it('truncates a plain-text description to 500 characters', async () => {
    const fake = fakeFetch(200, {
      issues: [{ key: 'LONG-1', fields: { summary: 'Long issue', description: 'x'.repeat(700) } }],
    });
    const result = await provider(fake.fetchImpl).query(personalWork());
    expect(result.items[0]!.summary).toHaveLength(500);
  });

  it('bounds serialized raw issue JSON', async () => {
    const fake = fakeFetch(200, {
      issues: [{ key: 'RAW-1', fields: { summary: 'Bounded', custom: 'x'.repeat(25_000) } }],
    });
    const result = await provider(fake.fetchImpl).query(personalWork());
    const rawJson = result.items[0]!.raw?.json;

    expect(typeof rawJson).toBe('string');
    expect((rawJson as string).length).toBeLessThanOrEqual(20_011);
    expect(rawJson).toMatch(/\[truncated\]$/);
  });

  it('bounds the returned items to the requested limit', async () => {
    const issues = Array.from({ length: 30 }, (_, index) => ({ key: `BULK-${index + 1}`, fields: { summary: 's' } }));
    const result = await provider(fakeFetch(200, { issues }).fetchImpl).query(personalWork('account-123', { limit: 3 }));
    expect(result.items.map((item) => item.id)).toEqual(['BULK-1', 'BULK-2', 'BULK-3']);
  });

  it('handles missing optional fields without inventing provider-neutral fields', async () => {
    const fake = fakeFetch(200, { issues: [{ key: 'MIN-1', fields: { duedate: 'not-a-date', updated: 'garbage' } }] });
    const result = await provider(fake.fetchImpl).query(personalWork());

    expect(result.items[0]).toMatchObject({
      id: 'MIN-1',
      title: 'MIN-1',
      url: 'https://example.atlassian.net/browse/MIN-1',
      container: 'MIN',
    });
    for (const field of ['summary', 'status', 'dueDate', 'updatedAt']) {
      expect(result.items[0]).not.toHaveProperty(field);
    }
  });

  it('reports configured availability without making a network request', async () => {
    const fake = fakeFetch(200, { issues: [] });
    await expect(provider(fake.fetchImpl).isAvailable()).resolves.toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});
