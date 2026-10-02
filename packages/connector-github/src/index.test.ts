import { describe, expect, it, vi } from 'vitest';
import { ConnectorQueryError } from '@quoky/core';
import { GitHubConnectorProvider } from './index';

const TOKEN = 'installation-token';

function searchItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 987654,
    number: 42,
    title: 'Review this',
    html_url: 'https://github.com/o/r/pull/42',
    repository_url: 'https://api.github.com/repos/o/r',
    state: 'open',
    updated_at: '2026-10-02T01:02:03Z',
    body: 'Details',
    ...overrides,
  };
}

function okFetch(body: unknown = { items: [] }): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

function patProvider(fetchImpl: unknown, timeoutMs?: number): GitHubConnectorProvider {
  return new GitHubConnectorProvider({
    auth: { kind: 'pat', token: TOKEN },
    fetchImpl: fetchImpl as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('GitHubConnectorProvider', () => {
  it('maps a bounded read-only personal-work search through injected auth to owner/repo#number ids', async () => {
    const fetchImpl = okFetch({ items: [searchItem()] });
    const tokenSource = vi.fn(async () => TOKEN);
    const provider = new GitHubConnectorProvider({ auth: { kind: 'github-app', tokenSource }, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.query({ query: 'personal-work', params: { actorExternalId: 'octocat' } });

    expect(result).toEqual({ source: 'github', items: [{
      id: 'o/r#42',
      title: 'Review this',
      url: 'https://github.com/o/r/pull/42',
      summary: 'Details',
      container: 'o/r',
      status: 'open',
      updatedAt: '2026-10-02T01:02:03.000Z',
    }] });
    expect(tokenSource).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/search/issues?q=involves%3Aoctocat%20is%3Aopen%20archived%3Afalse&sort=updated&order=desc&per_page=20',
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('renders the review-requested filter as a PR-only qualifier with a bounded per_page', async () => {
    const fetchImpl = okFetch();
    await patProvider(fetchImpl).query({
      query: 'personal-work',
      params: { actorExternalId: 'octocat', filter: 'review-requested', limit: 7 },
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('q')).toBe('is:pr is:open archived:false review-requested:octocat');
    expect(parsed.searchParams.get('sort')).toBe('updated');
    expect(parsed.searchParams.get('per_page')).toBe('7');
  });

  it('clamps per_page to 20', async () => {
    const fetchImpl = okFetch();
    await patProvider(fetchImpl).query({ query: 'personal-work', params: { actorExternalId: 'octocat', limit: 100 } });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('per_page')).toBe('20');
  });

  it('marks drafts and tolerates missing optional fields', async () => {
    const fetchImpl = okFetch({
      items: [searchItem({ draft: true, body: null, updated_at: 'nope', number: 7, repository_url: 'https://api.github.com/repos/Acme/web.app' })],
    });
    const result = await patProvider(fetchImpl).query({ query: 'personal-work', params: { actorExternalId: 'octocat' } });
    expect(result.items[0]).toEqual({
      id: 'Acme/web.app#7',
      title: 'Review this',
      url: 'https://github.com/o/r/pull/42',
      container: 'Acme/web.app',
      status: 'draft',
    });
  });

  it('keeps tokens out of items', async () => {
    const fetchImpl = okFetch({ items: [searchItem({ title: `T ${TOKEN}`, body: `B ${TOKEN}` })] });
    const result = await patProvider(fetchImpl).query({ query: 'personal-work', params: { actorExternalId: 'octocat' } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([
    ['octocat repo:secret/private'],
    ['octocat:x'],
    ['-octocat'],
    ['octo"cat'],
    ['octocat+OR+is:private'],
    ['octocat\tis:private'],
    ['a'.repeat(40)],
  ])('rejects a qualifier-injecting actor identity %j before any request', async (actorExternalId) => {
    const fetchImpl = vi.fn();
    await expect(patProvider(fetchImpl).query({ query: 'personal-work', params: { actorExternalId } })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_QUERY',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unsupported names, filters and missing identity without network access', async () => {
    const fetchImpl = vi.fn();
    const provider = patProvider(fetchImpl);
    await expect(provider.query({ query: 'write-something' })).rejects.toThrow(/unsupported/);
    await expect(provider.query({ query: 'write-something' })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    await expect(provider.query({ query: 'search', params: { text: 'bug' } })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    await expect(provider.query({ query: 'personal-work' })).rejects.toThrow(/identity/);
    await expect(provider.query({ query: 'personal-work', params: { actorExternalId: 'octo cat' } })).rejects.toThrow(/invalid/);
    await expect(provider.query({ query: 'personal-work', params: { actorExternalId: 'octocat is:private' } })).rejects.toMatchObject({
      reason: 'UNSUPPORTED_QUERY',
    });
    await expect(
      provider.query({ query: 'personal-work', params: { actorExternalId: 'octocat', filter: 'due-this-week' } }),
    ).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, {}, 'UNAUTHORIZED'],
    [403, {}, 'FORBIDDEN'],
    [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMITED'],
    [404, {}, 'NOT_FOUND'],
    [429, {}, 'RATE_LIMITED'],
    [500, {}, 'UNAVAILABLE'],
    [502, {}, 'UNAVAILABLE'],
  ] as const)('maps HTTP %i %j to reason %s without leaking the token', async (status, headers, reason) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: TOKEN }), { status, headers }));
    const promise = patProvider(fetchImpl).query({ query: 'personal-work', params: { actorExternalId: 'octocat' } });
    await expect(promise).rejects.toMatchObject({ name: 'GitHubConnectorHttpError', reason, status });
    await expect(promise).rejects.toBeInstanceOf(ConnectorQueryError);
    await expect(promise).rejects.not.toThrow(TOKEN);
  });

  it('maps a timeout to UNAVAILABLE', async () => {
    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const promise = patProvider(hanging, 5).query({ query: 'personal-work', params: { actorExternalId: 'octocat' } });
    await expect(promise).rejects.toMatchObject({ name: 'GitHubConnectorRequestError', reason: 'UNAVAILABLE' });
    await expect(promise).rejects.not.toThrow(TOKEN);
  });

  it('maps malformed bodies and items to INVALID_RESPONSE', async () => {
    const query = { query: 'personal-work', params: { actorExternalId: 'octocat' } };
    await expect(patProvider(okFetch({ nope: true })).query(query)).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    await expect(patProvider(okFetch({ items: [searchItem({ repository_url: 'https://evil.example/repos/o/r' })] })).query(query))
      .rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    await expect(patProvider(okFetch({ items: [searchItem({ number: undefined })] })).query(query))
      .rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }));
    await expect(patProvider(notJson).query(query)).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });

  it('maps auth-source failures without retaining the underlying error', async () => {
    const fetchImpl = vi.fn();
    const failing = new GitHubConnectorProvider({
      auth: { kind: 'github-app', tokenSource: async () => { throw new Error(`boom ${TOKEN}`); } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const promise = failing.query({ query: 'personal-work', params: { actorExternalId: 'octocat' } });
    await expect(promise).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    await expect(promise).rejects.not.toThrow(TOKEN);

    const empty = new GitHubConnectorProvider({
      auth: { kind: 'github-app', tokenSource: async () => '' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(empty.query({ query: 'personal-work', params: { actorExternalId: 'octocat' } })).rejects.toMatchObject({
      reason: 'UNAUTHORIZED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid timeout at construction', () => {
    expect(() => patProvider(vi.fn(), 0)).toThrow(/timeoutMs/);
  });
});
