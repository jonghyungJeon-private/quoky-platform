import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from '@quoky/core';
import {
  SlackConnectorProvider,
  type SlackConnectorConfig,
  type SlackConnectorHttpError,
} from './index';

const TOKEN = 'slack-secret-token';

function fakeFetch(...responses: Array<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error('unexpected fake fetch call');
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function provider(fetchImpl: typeof fetch, config: Partial<SlackConnectorConfig> = {}): SlackConnectorProvider {
  return new SlackConnectorProvider({ token: TOKEN, fetchImpl, ...config });
}

describe('SlackConnectorProvider', () => {
  it('lists channels with Bearer authentication', async () => {
    const fake = fakeFetch({
      status: 200,
      body: { ok: true, channels: [{ id: 'C123', name: 'general', purpose: { value: 'Team updates' } }] },
    });

    const result = await provider(fake.fetchImpl).listItems({ kind: 'channels' });

    expect(result).toEqual({
      source: 'slack',
      items: [{
        id: 'C123',
        title: '#general',
        summary: 'Team updates',
        raw: { kind: 'channel', channelId: 'C123' },
      }],
    });
    expect(fake.calls[0]!.url).toBe('https://slack.com/api/conversations.list?limit=100');
    expect(new Headers(fake.calls[0]!.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('retrieves message history', async () => {
    const fake = fakeFetch({
      status: 200,
      body: { ok: true, messages: [{ ts: '1000.001', text: `Status update ${TOKEN}` }] },
    });

    const result = await provider(fake.fetchImpl).listItems({ kind: 'messages', channelId: 'C123' });

    expect(result.items[0]).toEqual({
      id: 'C123:1000.001',
      title: 'Status update [redacted]',
      summary: 'Status update [redacted]',
      raw: { kind: 'message', channelId: 'C123', ts: '1000.001' },
    });
    expect(fake.calls[0]!.url).toBe('https://slack.com/api/conversations.history?channel=C123&limit=100');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('retrieves thread replies and resolves a single item', async () => {
    const body = {
      ok: true,
      messages: [
        { ts: '1000.001', text: 'Parent' },
        { ts: '1000.002', text: 'Reply' },
      ],
    };
    const fake = fakeFetch({ status: 200, body }, { status: 200, body });
    const slack = provider(fake.fetchImpl);

    const thread = await slack.listItems({ kind: 'thread', channelId: 'C123', threadTs: '1000.001' });
    const item = await slack.getItem({ channelId: 'C123', ts: '1000.001' });

    expect(thread.items.map(({ id }) => id)).toEqual(['C123:1000.001', 'C123:1000.002']);
    expect(item?.title).toBe('Parent');
    expect(fake.calls[0]!.url).toBe('https://slack.com/api/conversations.replies?channel=C123&ts=1000.001&limit=100');
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
  ] as const)('maps auth HTTP %i to a sanitized typed error', async (status, kind) => {
    const fake = fakeFetch({ status, body: { ok: false, error: `${kind} ${TOKEN}` } });
    const promise = provider(fake.fetchImpl).listItems({ kind: 'channels' });

    await expect(promise).rejects.toMatchObject({
      name: 'SlackConnectorHttpError',
      kind,
      status,
    } satisfies Partial<SlackConnectorHttpError>);
    await expect(promise).rejects.not.toThrow(TOKEN);
  });

  it('maps rate limiting without retrying', async () => {
    const fake = fakeFetch({ status: 429, body: { ok: false, error: 'ratelimited' } });
    await expect(provider(fake.fetchImpl).listItems({ kind: 'channels' })).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
      status: 429,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('maps Slack not-found responses', async () => {
    const fake = fakeFetch({ status: 200, body: { ok: false, error: 'channel_not_found' } });
    await expect(provider(fake.fetchImpl).listItems({ kind: 'messages', channelId: 'missing' })).rejects.toMatchObject({
      kind: 'NOT_FOUND',
      status: 200,
    });
  });

  it.each([
    [{ ok: true, channels: [] }, { kind: 'channels' } as const],
    [{ ok: true, messages: [] }, { kind: 'messages', channelId: 'C123' } as const],
  ])('returns an empty result for an empty Slack response', async (body, input) => {
    const fake = fakeFetch({ status: 200, body });
    await expect(provider(fake.fetchImpl).listItems(input)).resolves.toEqual({ source: 'slack', items: [] });
  });

  it('follows bounded cursor pagination and caps output', async () => {
    const fake = fakeFetch(
      {
        status: 200,
        body: { ok: true, channels: [{ id: 'C1', name: 'one' }], response_metadata: { next_cursor: 'next' } },
      },
      {
        status: 200,
        body: { ok: true, channels: [{ id: 'C2', name: 'two' }], response_metadata: { next_cursor: 'unused' } },
      },
    );

    const result = await provider(fake.fetchImpl, { maxItems: 2, maxPages: 2 }).listItems({ kind: 'channels' });

    expect(result.items.map(({ id }) => id)).toEqual(['C1', 'C2']);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.url).toContain('cursor=next');
  });

  it('supports the canonical ConnectorProvider query method', async () => {
    const fake = fakeFetch({ status: 200, body: { ok: true, messages: [{ ts: '1000.001', text: 'Via query' }] } });
    const result = await provider(fake.fetchImpl).query({ query: '', params: { kind: 'messages', channelId: 'C123' } });
    expect(result.items[0]?.title).toBe('Via query');
  });

  it('disconnects without a network request and reconnects locally', async () => {
    const fake = fakeFetch({ status: 200, body: { ok: true, channels: [] } });
    const slack = provider(fake.fetchImpl);
    await slack.disconnect();
    await expect(slack.isAvailable()).resolves.toBe(false);
    await expect(slack.listItems()).rejects.toThrow('disconnected');
    expect(fake.calls).toHaveLength(0);
    await slack.connect();
    await expect(slack.isAvailable()).resolves.toBe(true);
  });

  describe('named search query', () => {
    const match = {
      channel: { id: 'C123', name: 'eng' },
      ts: '1727859600.000100',
      text: `Deploy   finished ${TOKEN}`,
      permalink: 'https://example.slack.com/archives/C123/p1727859600000100',
    };

    it('uses GET search.messages with bounded count and timestamp sort, and maps matches', async () => {
      const fake = fakeFetch({ status: 200, body: { ok: true, messages: { matches: [match], paging: { count: 1 } } } });
      const result = await provider(fake.fetchImpl).query({ query: 'search', params: { text: 'deploy "now"', limit: 50 } });

      const url = new URL(fake.calls[0]!.url);
      expect(url.origin + url.pathname).toBe('https://slack.com/api/search.messages');
      expect(url.searchParams.get('query')).toBe('"deploy" "now"');
      expect(url.searchParams.get('count')).toBe('20');
      expect(url.searchParams.get('sort')).toBe('timestamp');
      expect(fake.calls[0]!.init?.method).toBe('GET');
      expect(fake.calls[0]!.init?.body).toBeUndefined();
      expect(fake.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
      expect(result).toEqual({
        source: 'slack',
        items: [{
          id: 'C123:1727859600.000100',
          title: 'Deploy finished [redacted]',
          summary: 'Deploy finished [redacted]',
          url: 'https://example.slack.com/archives/C123/p1727859600000100',
          container: '#eng',
          updatedAt: '2024-10-02T09:00:00.000Z',
          raw: { kind: 'message', channelId: 'C123', ts: '1727859600.000100' },
        }],
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it.each([
      ['incident OR in:private', '"incident" "or" "in" "private"'],
      ['from:@boss -draft has:link', '"from" "@boss" "draft" "has" "link"'],
      ['before:2026-01-01 after:2025-12-01 during:march', '"before" "2026-01-01" "after" "2025-12-01" "during" "march"'],
      ['"exact phrase" AND NOT secret*', '"exact" "phrase" "and" "not" "secret"'],
      ['\u201csmart\u201d quotes (grouped) <@U123>', '"smart" "quotes" "grouped" "@U123"'],
      ['+must ~fuzzy !bang 배포 상태', '"must" "fuzzy" "bang" "배포" "상태"'],
      ['in-flight re-deploy', '"in-flight" "re-deploy"'],
    ])('renders %j as escaped literal terms (no operator, modifier or exclusion injection)', async (text, expected) => {
      const fake = fakeFetch({ status: 200, body: { ok: true, messages: { matches: [] } } });
      await provider(fake.fetchImpl).query({ query: 'search', params: { text } });
      const query = new URL(fake.calls[0]!.url).searchParams.get('query') ?? '';
      expect(query).toBe(expected);
      // Every term is a quoted literal: nothing outside quotes, and no syntax inside them.
      expect(query.replace(/"[^"\s:*]+"/g, '').trim()).toBe('');
    });

    it.each([['"" :: **'], ['- -- +'], ['() <> \u201c\u201d']])(
      'rejects text %j with no searchable terms before any request',
      async (text) => {
        const fake = fakeFetch({ status: 200, body: { ok: true, messages: { matches: [] } } });
        await expect(provider(fake.fetchImpl).query({ query: 'search', params: { text } })).rejects.toMatchObject({
          reason: 'UNSUPPORTED_QUERY',
        });
        expect(fake.calls).toHaveLength(0);
      },
    );

    it('bounds the title to 120 characters, skips malformed matches and drops non-Slack permalinks', async () => {
      const fake = fakeFetch({
        status: 200,
        body: {
          ok: true,
          messages: {
            matches: [
              { ...match, text: 'x'.repeat(300), permalink: 'https://evil.example.com/p' },
              { channel: {}, ts: '1.0', text: 'no channel id' },
              { channel: { id: 'C9' }, text: 'no ts' },
            ],
          },
        },
      });
      const result = await provider(fake.fetchImpl).query({ query: 'search', params: { text: 'x' } });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toHaveLength(120);
      expect(result.items[0]).not.toHaveProperty('url');
    });

    it.each([
      [undefined],
      [''],
      ['   '],
      ['y'.repeat(101)],
    ])('rejects invalid search text %j before any request', async (text) => {
      const fake = fakeFetch({ status: 200, body: { ok: true, messages: { matches: [] } } });
      await expect(provider(fake.fetchImpl).query({ query: 'search', params: { text } })).rejects.toMatchObject({
        reason: 'UNSUPPORTED_QUERY',
      });
      expect(fake.calls).toHaveLength(0);
    });

    it('maps not_allowed_token_type and missing_scope to INSUFFICIENT_SCOPE', async () => {
      for (const error of ['not_allowed_token_type', 'missing_scope']) {
        const fake = fakeFetch({ status: 200, body: { ok: false, error } });
        const promise = provider(fake.fetchImpl).query({ query: 'search', params: { text: 'deploy' } });
        await expect(promise).rejects.toMatchObject({ name: 'SlackConnectorHttpError', kind: 'INSUFFICIENT_SCOPE', reason: 'INSUFFICIENT_SCOPE' });
        await expect(promise).rejects.toBeInstanceOf(ConnectorQueryError);
      }
    });

    it.each([
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'UNAVAILABLE'],
    ] as const)('maps HTTP %i to reason %s without leaking the token', async (status, reason) => {
      const fake = fakeFetch({ status, body: { ok: false, error: TOKEN } });
      const promise = provider(fake.fetchImpl).query({ query: 'search', params: { text: 'deploy' } });
      await expect(promise).rejects.toMatchObject({ reason });
      await expect(promise).rejects.not.toThrow(TOKEN);
    });

    it('maps a timeout to UNAVAILABLE and a malformed body to INVALID_RESPONSE', async () => {
      const hanging = provider(((_url: URL | RequestInfo, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch, { timeoutMs: 5 });
      await expect(hanging.query({ query: 'search', params: { text: 'deploy' } })).rejects.toMatchObject({
        name: 'SlackConnectorRequestError',
        reason: 'UNAVAILABLE',
      });

      const fake = fakeFetch({ status: 200, body: { ok: true, messages: { nope: [] } } });
      await expect(provider(fake.fetchImpl).query({ query: 'search', params: { text: 'deploy' } })).rejects.toMatchObject({
        reason: 'INVALID_RESPONSE',
      });
    });

    it('rejects personal-work, unknown names and unknown kinds as UNSUPPORTED_QUERY', async () => {
      const fake = fakeFetch({ status: 200, body: { ok: true, channels: [] } });
      const slack = provider(fake.fetchImpl);
      await expect(slack.query({ query: 'personal-work', params: { actorExternalId: 'U1' } })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
      await expect(slack.query({ query: 'chat.postMessage' })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
      await expect(slack.query({ query: '', params: { kind: 'post' } })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
      expect(fake.calls).toHaveLength(0);
    });

    it('is UNAVAILABLE while disconnected and issues only GET requests across all kinds', async () => {
      const fake = fakeFetch(
        { status: 200, body: { ok: true, channels: [] } },
        { status: 200, body: { ok: true, messages: { matches: [] } } },
      );
      const slack = provider(fake.fetchImpl);
      await slack.listItems();
      await slack.query({ query: 'search', params: { text: 'a' } });
      expect(fake.calls.map((call) => call.init?.method)).toEqual(['GET', 'GET']);

      await slack.disconnect();
      await expect(slack.query({ query: 'search', params: { text: 'a' } })).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    });
  });
});
