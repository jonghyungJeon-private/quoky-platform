import { describe, expect, it } from 'vitest';
import { parseReleaseItemsParams, type ConnectorQuery } from '@quoky/core';
import { JiraConnectorProvider, jqlString, releaseItemsJql } from './index';

/**
 * ADR-0120 amendment A8: the read-only release queries of the Jira adapter. No live Jira call: every response is a
 * scripted fake. The JQL is built only from re-validated closed shapes and quoted, escaped literals.
 */

const TOKEN = 'jira-secret-token';

function scripted(responses: ReadonlyArray<{ status?: number; body: unknown }>): { fetchImpl: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  let index = 0;
  const fetchImpl = (async (input: URL | RequestInfo) => {
    urls.push(new URL(String(input)));
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function jira(fetchImpl: typeof fetch): JiraConnectorProvider {
  return new JiraConnectorProvider({ host: 'example.atlassian.net', email: 'dev@example.com', apiToken: TOKEN, fetchImpl });
}

function jqlOf(url: URL): string {
  return url.searchParams.get('jql') ?? '';
}

describe('JQL safety of release-items (A8)', () => {
  it('quotes and escapes a release name: quotes, backslashes and an injected clause stay inside one literal', () => {
    const cases: Array<[string, string]> = [
      ['20261015', 'fixVersion = "20261015"'],
      ['1.0 "beta"', 'fixVersion = "1.0 \\"beta\\""'],
      ['a\\b', 'fixVersion = "a\\\\b"'],
      ['x" OR project != OP26', 'fixVersion = "x\\" OR project != OP26"'],
      ['x\\" OR project != OP26 OR fixVersion = "y', 'fixVersion = "x\\\\\\" OR project != OP26 OR fixVersion = \\"y"'],
      ["it's", 'fixVersion = "it\'s"'],
    ];
    for (const [name, clause] of cases) {
      const parsed = parseReleaseItemsParams({ container: 'OP26', releaseName: name });
      expect(releaseItemsJql(parsed)).toBe(`project = "OP26" AND ${clause} ORDER BY key ASC`);
    }
  });

  it('a version id is digits only and never quoted; the assignee is a quoted literal; the order is constant', () => {
    expect(releaseItemsJql(parseReleaseItemsParams({ container: 'OP26', releaseId: '16555' }))).toBe('project = "OP26" AND fixVersion = 16555 ORDER BY key ASC');
    expect(releaseItemsJql(parseReleaseItemsParams({ releaseName: '20261015', assignee: 'acc"ount' }))).toBe('fixVersion = "20261015" AND assignee = "acc\\"ount" ORDER BY key ASC');
    expect(jqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it.each([
    [{ container: 'OP26' }, 'no release'],
    [{ container: 'OP26', releaseId: '1', releaseName: 'x' }, 'both release forms'],
    [{ container: 'op26', releaseName: 'x' }, 'a lower-case key'],
    [{ container: 'OP26" OR 1=1', releaseName: 'x' }, 'a key with JQL'],
    [{ container: 'O', releaseName: 'x' }, 'a one-letter key'],
    [{ container: 'OP26', releaseId: '16555 OR 1=1' }, 'a non-numeric id'],
    [{ container: 'OP26', releaseId: '-1' }, 'a negative id'],
    [{ container: 'OP26', releaseId: '0' }, 'a zero id'],
    [{ container: 'OP26', releaseName: 'a\nb' }, 'a control character'],
    [{ container: 'OP26', releaseName: '   ' }, 'a blank name'],
    [{ container: 'OP26', releaseName: 'x'.repeat(101) }, 'a name over 100 characters'],
    [{ container: 'OP26', releaseName: 'x', assignee: 'a\u0000b' }, 'a control character in the assignee'],
  ])('refuses %j (%s) before any request', async (params) => {
    const fake = scripted([{ body: { issues: [] } }]);
    await expect(jira(fake.fetchImpl).query({ query: 'release-items', params } as ConnectorQuery)).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    expect(fake.urls).toHaveLength(0);
  });
});

describe('release-items (A8)', () => {
  it('reads one release: key, summary, status, status group, assignee, link; isLast=false means partial', async () => {
    const fake = scripted([
      {
        body: {
          isLast: false,
          issues: [
            { key: 'OP26-1', fields: { summary: '로그인 오류', status: { name: '배포 완료', statusCategory: { key: 'done' } }, assignee: { displayName: '홍길동' } } },
            { key: 'OP26-2', fields: { summary: `토큰 ${TOKEN} 노출`, status: { name: '진행 중', statusCategory: { key: 'indeterminate' } }, assignee: null } },
            { key: 'OP26-3', fields: { summary: '할 일', status: { name: 'To Do', statusCategory: { key: 'new' } } } },
            { key: 'OP26-4', fields: { summary: '모름', status: { name: 'X', statusCategory: { key: 'constructor' } } } },
          ],
        },
      },
    ]);
    const result = await jira(fake.fetchImpl).query({ query: 'release-items', params: { container: 'OP26', releaseId: '16555', limit: 20 } });
    expect(fake.urls).toHaveLength(1);
    const url = fake.urls[0]!;
    expect(url.origin).toBe('https://example.atlassian.net');
    expect(url.pathname).toBe('/rest/api/3/search/jql');
    expect(jqlOf(url)).toBe('project = "OP26" AND fixVersion = 16555 ORDER BY key ASC');
    expect(url.searchParams.get('fields')).toBe('summary,status,assignee');
    expect(url.searchParams.get('maxResults')).toBe('20');
    expect(result.truncated).toBe(true);
    expect(result.items).toEqual([
      { id: 'OP26-1', title: '로그인 오류', url: 'https://example.atlassian.net/browse/OP26-1', status: '배포 완료', statusCategory: 'done', assignee: '홍길동', container: 'OP26' },
      { id: 'OP26-2', title: '토큰 [redacted] 노출', url: 'https://example.atlassian.net/browse/OP26-2', status: '진행 중', statusCategory: 'in-progress', container: 'OP26' },
      { id: 'OP26-3', title: '할 일', url: 'https://example.atlassian.net/browse/OP26-3', status: 'To Do', statusCategory: 'todo', container: 'OP26' },
      { id: 'OP26-4', title: '모름', url: 'https://example.atlassian.net/browse/OP26-4', status: 'X', container: 'OP26' },
    ]);
  });

  it('a complete page is not partial; a 400 (unknown version) is NOT_FOUND; a 401 stays UNAUTHORIZED', async () => {
    const complete = scripted([{ body: { isLast: true, issues: [] } }]);
    expect((await jira(complete.fetchImpl).query({ query: 'release-items', params: { releaseName: '20261015' } })).truncated).toBeUndefined();
    const unknown = scripted([{ status: 400, body: { errorMessages: ["The value 'nope' does not exist for the field 'fixVersion'."] } }]);
    await expect(jira(unknown.fetchImpl).query({ query: 'release-items', params: { releaseName: 'nope' } })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    // Any other 400 (not about the fix version) is not "not found".
    const other = scripted([{ status: 400, body: { errorMessages: ["Error in the JQL Query: expecting ')'"] } }]);
    await expect(jira(other.fetchImpl).query({ query: 'release-items', params: { releaseName: 'x' } })).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    const empty = scripted([{ status: 400, body: 'not json' }]);
    await expect(jira(empty.fetchImpl).query({ query: 'release-items', params: { releaseName: 'x' } })).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    const denied = scripted([{ status: 401, body: {} }]);
    await expect(jira(denied.fetchImpl).query({ query: 'release-items', params: { releaseName: 'x' } })).rejects.toMatchObject({ reason: 'UNAUTHORIZED' });
  });
});

describe('containers and releases (A8)', () => {
  it('lists visible projects page by page (key and name only, no owner text sent), stopping at isLast', async () => {
    const fake = scripted([
      { body: { isLast: false, values: [{ key: 'OP25', name: '차란차 운영 2025' }, { key: 'bad key', name: 'x' }] } },
      { body: { isLast: true, values: [{ key: 'OP26', name: '차란차 운영 2026' }] } },
    ]);
    const result = await jira(fake.fetchImpl).query({ query: 'containers' });
    expect(result.items).toEqual([
      { id: 'OP25', title: '차란차 운영 2025', container: 'OP25' },
      { id: 'OP26', title: '차란차 운영 2026', container: 'OP26' },
    ]);
    expect(result.truncated).toBeUndefined();
    expect(fake.urls.map((url) => `${url.pathname}?${url.searchParams.get('startAt')}`)).toEqual(['/rest/api/3/project/search?0', '/rest/api/3/project/search?50']);
    expect(fake.urls.every((url) => url.searchParams.get('query') === null)).toBe(true);
  });

  it('stops at 200 projects and says the list is partial', async () => {
    const page = (start: number) => ({ body: { isLast: false, values: Array.from({ length: 50 }, (_, i) => ({ key: `P${start + i}X`, name: `p${start + i}` })) } });
    const fake = scripted([page(0), page(50), page(100), page(150), page(200)]);
    const result = await jira(fake.fetchImpl).query({ query: 'containers' });
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(fake.urls).toHaveLength(4);
  });

  it('lists the released and unreleased versions of a validated key, newest first, archived ones skipped', async () => {
    const fake = scripted([
      {
        body: {
          isLast: true,
          values: [
            { id: '16600', name: '20261022', released: false, archived: false, releaseDate: '2026-10-22' },
            { id: '16555', name: '20261015', released: true, archived: false, releaseDate: '2026-10-15' },
            { id: '16000', name: 'old', released: true, archived: true },
            { id: 'x1', name: 'bad id' },
          ],
        },
      },
    ]);
    const result = await jira(fake.fetchImpl).query({ query: 'releases', params: { container: 'OP26' } });
    const url = fake.urls[0]!;
    expect(url.pathname).toBe('/rest/api/3/project/OP26/version');
    expect(url.searchParams.get('orderBy')).toBe('-sequence');
    expect(url.searchParams.get('status')).toBe('released,unreleased');
    expect(result.items).toEqual([
      { id: '16600', title: '20261022', status: 'unreleased', container: 'OP26', url: 'https://example.atlassian.net/projects/OP26/versions/16600/tab/release-report-all-issues', dueDate: '2026-10-22' },
      { id: '16555', title: '20261015', status: 'released', container: 'OP26', url: 'https://example.atlassian.net/projects/OP26/versions/16555/tab/release-report-all-issues', dueDate: '2026-10-15' },
    ]);
  });

  it('stops at the release limit (first page only for narrowing)', async () => {
    const fake = scripted([{ body: { isLast: false, values: Array.from({ length: 50 }, (_, i) => ({ id: String(100 + i), name: `v${i}` })) } }]);
    const result = await jira(fake.fetchImpl).query({ query: 'releases', params: { container: 'OP26', limit: 50 } });
    expect(fake.urls).toHaveLength(1);
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
    await expect(jira(fake.fetchImpl).query({ query: 'releases', params: { container: 'OP26', limit: 201 } })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
  });

  it.each([['op26'], ['OP26/../x'], ['OP26?x=1'], [''], [undefined]])('refuses the container %j before any request', async (container) => {
    const fake = scripted([{ body: { values: [] } }]);
    await expect(jira(fake.fetchImpl).query({ query: 'releases', params: container === undefined ? {} : { container } })).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
    expect(fake.urls).toHaveLength(0);
  });

  it('an unexpected listing shape is INVALID_RESPONSE', async () => {
    const fake = scripted([{ body: { issues: [] } }]);
    await expect(jira(fake.fetchImpl).query({ query: 'containers' })).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });
});
