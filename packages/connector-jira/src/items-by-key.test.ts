import { describe, expect, it } from 'vitest';
import { ConnectorQueryError, type ConnectorQuery } from '@quoky/core';
import { JiraConnectorProvider, itemsByKeyJql } from './index';

/**
 * ADR-0121 S2 P3, the "same-source detail reads" implementation note: a same-source detail read is ONE bulk request
 * (`key in (…)`), built only from keys of the closed key shape. No live Jira call: every response is a scripted fake.
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

const query = (keys: unknown): ConnectorQuery => ({ query: 'items-by-key', params: { keys } as never });

function issue(key: string, id: number) {
  return { id: String(id), key, fields: { summary: `요약 ${key}`, status: { name: '진행 중' }, description: `설명 ${key} ${TOKEN}`, updated: '2026-10-20T01:00:00.000+0000' } };
}

describe('Jira items-by-key (ADR-0121 S2 P3): one bulk detail request', () => {
  it('reads ten keys with exactly one HTTP request: key in (…), quoted keys, a constant order, one page', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `OP26-${i + 1}`);
    const { fetchImpl, urls } = scripted([{ body: { issues: keys.map((key, i) => issue(key, 1000 + i)), isLast: true } }]);
    const result = await jira(fetchImpl).query(query(keys));
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/rest/api/3/search/jql');
    expect(urls[0]?.searchParams.get('jql')).toBe(`key in (${keys.map((key) => `"${key}"`).join(', ')}) ORDER BY key ASC`);
    expect(urls[0]?.searchParams.get('maxResults')).toBe('10');
    expect(result.items.map((item) => item.id)).toEqual(keys);
    // Details are bounded and redacted like every Jira read.
    expect(result.items[0]?.summary).toBe('설명 OP26-1 [redacted]');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('returns only the issues asked for: a moved issue answering under another key is dropped, an unseen key is absent', async () => {
    const { fetchImpl, urls } = scripted([{ body: { issues: [issue('OP26-1', 1), issue('NEW-9', 2)] } }]);
    const result = await jira(fetchImpl).query(query(['OP26-1', 'OP26-2']));
    expect(urls).toHaveLength(1);
    expect(result.items.map((item) => item.id)).toEqual(['OP26-1']);
  });

  it('refuses keys outside the closed shape before any request (no JQL is ever built from them)', async () => {
    for (const keys of [[], ['op26-1'], ['OP26-1" OR project != OP26'], ['OP26-1', 'OP26-1'], Array.from({ length: 11 }, (_, i) => `OP26-${i + 1}`), 'OP26-1']) {
      const { fetchImpl, urls } = scripted([{ body: { issues: [] } }]);
      await expect(jira(fetchImpl).query(query(keys))).rejects.toMatchObject({ reason: 'UNSUPPORTED_QUERY' });
      expect(urls).toHaveLength(0);
    }
    expect(() => itemsByKeyJql(['OP26-1) OR (key = "X-1'])).toThrowError(ConnectorQueryError);
    expect(() => itemsByKeyJql([])).toThrowError(ConnectorQueryError);
  });

  it('a 400 naming an issue key is NOT_FOUND; any other 400 is INVALID_RESPONSE; the error text is never returned', async () => {
    const notFound = scripted([{ status: 400, body: { errorMessages: ["An issue with key 'OP26-404' does not exist for field 'key'."] } }]);
    await expect(jira(notFound.fetchImpl).query(query(['OP26-404']))).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const other = scripted([{ status: 400, body: { errorMessages: ['Something else went wrong.'] } }]);
    const error = await jira(other.fetchImpl).query(query(['OP26-1'])).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'INVALID_RESPONSE' });
    expect(String((error as Error).message)).not.toContain('Something else');
  });
});
