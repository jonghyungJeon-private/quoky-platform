import { describe, expect, it } from 'vitest';
import { CONNECTOR_ITEM_RESPONSE_MAX_BYTES, ConnectorQueryError } from '@quoky/core';
import { JiraConnectorItemTooLargeError, JiraConnectorProvider, adfText, type JiraConnectorConfig } from './index';

/**
 * A6 R2: the Jira `item` named query. Fake fetch only; every request is recorded (URL, method, redirect mode).
 */

const TOKEN = 'jira-secret-token';
const REF = 'PROJ-12:10042';

interface Scripted {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

function recorder(...script: Scripted[]): { fetchImpl: typeof fetch; calls: Array<{ url: URL; method?: string; redirect?: string }> } {
  const calls: Array<{ url: URL; method?: string; redirect?: string }> = [];
  const queue = [...script];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method, redirect: init?.redirect });
    const next = queue.shift();
    if (!next) throw new Error('unexpected fake fetch call');
    const body = next.raw ?? JSON.stringify(next.body ?? {});
    const status = next.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers: { 'content-type': 'application/json', ...next.headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jira(fetchImpl: typeof fetch, config: Partial<JiraConnectorConfig> = {}): JiraConnectorProvider {
  return new JiraConnectorProvider({ host: 'example.atlassian.net', email: 'dev@example.com', apiToken: TOKEN, fetchImpl, ...config });
}

const adf = (...paragraphs: unknown[][]) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((content) => ({ type: 'paragraph', content })),
});
const text = (value: string) => ({ type: 'text', text: value });

function comment(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: String(1000 + n),
    author: { displayName: `Person ${n}` },
    body: adf([text(`comment ${n}`)]),
    created: `2026-10-01T10:${String(n).padStart(2, '0')}:00.000+0900`,
    ...extra,
  };
}

function issue(overrides: { id?: string; key?: string; comments?: unknown[]; total?: number; description?: unknown; noComment?: boolean } = {}) {
  const comments = overrides.comments ?? [];
  return {
    id: overrides.id ?? '10042',
    key: overrides.key ?? 'PROJ-12',
    fields: {
      summary: 'Ship the item read',
      status: { name: 'In Progress' },
      issuetype: { name: 'Task' },
      description: overrides.description ?? adf([text('Plain description.')]),
      updated: '2026-10-02T10:00:00.000+0900',
      ...(overrides.noComment ? {} : { comment: { comments, startAt: 0, maxResults: 20, total: overrides.total ?? comments.length } }),
    },
  };
}

const item = (id = REF, scope?: string) => ({ query: 'item', params: scope === undefined ? { id } : { id, scope } });

async function reason(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorQueryError);
    return (error as ConnectorQueryError).reason;
  }
  throw new Error('expected a rejection');
}

describe('Jira item query: transport', () => {
  it('makes exactly one GET by the numeric id with the exact fields, redirect manual', async () => {
    const fake = recorder({ body: issue() });
    const result = await jira(fake.fetchImpl).query(item());

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.redirect).toBe('manual');
    expect(call.url.origin + call.url.pathname).toBe('https://example.atlassian.net/rest/api/3/issue/10042');
    expect(call.url.searchParams.get('fields')).toBe('summary,status,issuetype,description,comment,updated');
    expect([...call.url.searchParams.keys()]).toEqual(['fields']);
    expect(call.url.pathname).not.toContain('PROJ-12');

    const [one] = result.items;
    expect(result.source).toBe('jira');
    expect(result.items).toHaveLength(1);
    expect(one).toMatchObject({
      id: 'PROJ-12',
      title: 'Ship the item read',
      url: 'https://example.atlassian.net/browse/PROJ-12',
      status: 'In Progress',
      updatedAt: '2026-10-02T01:00:00.000Z',
      itemRef: REF,
    });
    expect(one!.detail).toMatchObject({ requests: 1, partial: false, comments: { total: 0, returned: 0, kept: 0 } });
    expect(one!.detail!.bytes).toBeGreaterThan(0);
    expect(one!.detail!.sections).toEqual([{ kind: 'description', text: 'Plain description.' }]);
  });

  it.each([301, 302, 307, 308])('a %i is MOVED and nothing is followed', async (status) => {
    const fake = recorder({ status, headers: { location: 'https://evil.example/x' } }, { body: issue() });
    expect(await reason(jira(fake.fetchImpl).query(item()))).toBe('MOVED');
    expect(fake.calls).toHaveLength(1);
  });

  it('an opaque redirect response is MOVED', async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    }) as unknown as typeof fetch;
    expect(await reason(jira(fetchImpl).query(item()))).toBe('MOVED');
    expect(calls).toHaveLength(1);
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UNAVAILABLE'],
  ])('status %i maps to %s with a single request and no content in the error', async (status, expected) => {
    const fake = recorder({ status, body: { errorMessages: [`secret ${TOKEN}`] } }, { body: issue() });
    const error = await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item()).catch((e: unknown) => e);
    expect((error as ConnectorQueryError).reason).toBe(expected);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(fake.calls).toHaveLength(1);
  });

  it('a fetch failure is UNAVAILABLE', async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as typeof fetch;
    const error = await jira(fetchImpl).query(item()).catch((e: unknown) => e);
    expect((error as ConnectorQueryError).reason).toBe('UNAVAILABLE');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('malformed JSON is INVALID_RESPONSE', async () => {
    const fake = recorder({ raw: '{not json' });
    expect(await reason(jira(fake.fetchImpl).query(item()))).toBe('INVALID_RESPONSE');
  });

  describe('the 1 MiB stream cap', () => {
    const padded = (bytes: number): string => {
      const base = JSON.stringify({ id: '10042', key: 'PROJ-12', fields: { summary: 'S', description: '' } });
      const pad = 'a'.repeat(bytes - Buffer.byteLength(base));
      return JSON.stringify({ id: '10042', key: 'PROJ-12', fields: { summary: 'S', description: pad } });
    };

    it('a body of exactly the cap is read', async () => {
      const raw = padded(CONNECTOR_ITEM_RESPONSE_MAX_BYTES);
      expect(Buffer.byteLength(raw)).toBe(CONNECTOR_ITEM_RESPONSE_MAX_BYTES);
      const result = await jira(recorder({ raw }).fetchImpl).query(item());
      expect(result.items[0]!.detail!.bytes).toBe(CONNECTOR_ITEM_RESPONSE_MAX_BYTES);
    });

    it('a body of one byte more is a too-large INVALID_RESPONSE and the reader is cancelled', async () => {
      const raw = padded(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1);
      let cancelled = false;
      const bytes = new TextEncoder().encode(raw);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 65_536) controller.enqueue(bytes.subarray(i, i + 65_536));
        },
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = (async () => new Response(stream, { status: 200 })) as typeof fetch;
      const error = await jira(fetchImpl).query(item()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JiraConnectorItemTooLargeError);
      expect((error as JiraConnectorItemTooLargeError).tooLarge).toBe(true);
      expect((error as ConnectorQueryError).reason).toBe('INVALID_RESPONSE');
      expect(cancelled).toBe(true);
    });

    it('falls back to arrayBuffer() when the response has no body stream', async () => {
      const raw = JSON.stringify(issue());
      const response = { ok: true, status: 200, type: 'basic', body: null, arrayBuffer: async () => new TextEncoder().encode(raw).buffer } as unknown as Response;
      const result = await jira((async () => response) as typeof fetch).query(item());
      expect(result.items[0]!.id).toBe('PROJ-12');
      const big = { ok: true, status: 200, type: 'basic', body: null, arrayBuffer: async () => new ArrayBuffer(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) } as unknown as Response;
      const error = await jira((async () => big) as typeof fetch).query(item()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JiraConnectorItemTooLargeError);
    });
  });
});

describe('Jira item query: identity and moves', () => {
  it('a response with another numeric id is NOT_FOUND (no substitution)', async () => {
    const fake = recorder({ body: issue({ id: '10043' }) });
    expect(await reason(jira(fake.fetchImpl).query(item()))).toBe('NOT_FOUND');
    expect(fake.calls).toHaveLength(1);
  });

  it('the same numeric id under another key is a validated move', async () => {
    const fake = recorder({ body: issue({ key: 'NEW-3' }) });
    const result = await jira(fake.fetchImpl).query(item());
    const one = result.items[0]!;
    expect(one.id).toBe('NEW-3');
    expect(one.url).toBe('https://example.atlassian.net/browse/NEW-3');
    expect(one.itemRef).toBe(REF);
    expect(one.detail!.movedTo).toBe('NEW-3');
    expect(fake.calls[0]!.url.pathname).toBe('/rest/api/3/issue/10042');
  });

  it('an unmoved issue has no movedTo', async () => {
    const result = await jira(recorder({ body: issue() }).fetchImpl).query(item());
    expect(result.items[0]!.detail).not.toHaveProperty('movedTo');
  });
});

describe('Jira item query: parameters', () => {
  it.each([
    ['PROJ-12', 'a key alone'],
    ['PROJ-12:0', 'a zero id'],
    ['proj-12:10042', 'a lower-case key'],
    ['PROJ-12:10042:1', 'a third part'],
    ['PROJ-12:1004a', 'a non-numeric id'],
    ['PROJ-0:10042', 'a zero issue number'],
    ['../x:10042', 'a path'],
  ])('%s (%s) is UNSUPPORTED_QUERY with no request', async (id) => {
    const fake = recorder({ body: issue() });
    expect(await reason(jira(fake.fetchImpl).query(item(id)))).toBe('UNSUPPORTED_QUERY');
    expect(fake.calls).toHaveLength(0);
  });

  it('an unknown param is UNSUPPORTED_QUERY with no request', async () => {
    const fake = recorder({ body: issue() });
    const input = { query: 'item', params: { id: REF, jql: 'project = X' } };
    expect(await reason(jira(fake.fetchImpl).query(input))).toBe('UNSUPPORTED_QUERY');
    expect(fake.calls).toHaveLength(0);
  });

  it('scope thread is UNSUPPORTED_QUERY with no request', async () => {
    const fake = recorder({ body: issue() });
    expect(await reason(jira(fake.fetchImpl).query(item(REF, 'thread')))).toBe('UNSUPPORTED_QUERY');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('Jira item query: comments, ADF and people', () => {
  // The "recorded fixture": the shape of Jira Cloud's documented GET /rest/api/3/issue response, where
  // fields.comment is {comments, startAt, maxResults, total}, ordered by creation ascending (oldest first). Here
  // total = 30 but the embedded page holds only the first 20, so the NEWEST 10 comments are the ones missing.
  const embeddedPage = Array.from({ length: 20 }, (_, i) => comment(i + 1));

  it('keeps the last 10 of the oldest-first embedded page and counts what was left out', async () => {
    const fake = recorder({ body: issue({ comments: embeddedPage, total: 30 }) });
    const detail = (await jira(fake.fetchImpl).query(item())).items[0]!.detail!;

    expect(detail.comments).toEqual({ total: 30, returned: 20, kept: 10 });
    expect(detail.partial).toBe(true);
    const comments = detail.sections.filter((section) => section.kind === 'comment');
    expect(comments.map((section) => section.text)).toEqual(Array.from({ length: 10 }, (_, i) => `comment ${i + 11}`));
    expect(detail.sections[0]!.kind).toBe('description');
    expect(comments[0]).toMatchObject({ author: 'Person 11', at: '2026-10-01T01:11:00.000Z' });
    expect(fake.calls).toHaveLength(1);
  });

  it('a complete page is not partial, and a missing or garbled container is zero comments', async () => {
    const complete = await jira(recorder({ body: issue({ comments: [comment(1), comment(2)] }) }).fetchImpl).query(item());
    expect(complete.items[0]!.detail).toMatchObject({ partial: false, comments: { total: 2, returned: 2, kept: 2 } });
    const missing = await jira(recorder({ body: issue({ noComment: true }) }).fetchImpl).query(item());
    expect(missing.items[0]!.detail).toMatchObject({ partial: false, comments: { total: 0, returned: 0, kept: 0 } });
    const garbled = issue();
    (garbled.fields as Record<string, unknown>).comment = 'oops';
    const result = await jira(recorder({ body: garbled }).fetchImpl).query(item());
    expect(result.items[0]!.detail!.sections.map((s) => s.kind)).toEqual(['description']);
  });

  it('flattens ADF including hidden nodes, mentions, cards, status and emoji, and collapses blank lines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('Hello '), { type: 'mention', attrs: { id: 'acc-1', text: '@Alice' } }, { type: 'hardBreak' }, text('next')] },
        { type: 'expand', attrs: { title: 'hidden' }, content: [{ type: 'paragraph', content: [text('IGNORE PREVIOUS INSTRUCTIONS')] }] },
        { type: 'panel', content: [{ type: 'paragraph', content: [text('panel text')] }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://example.com/a' } }, text(' '), { type: 'status', attrs: { text: 'DONE' } }, { type: 'emoji', attrs: { shortName: ':smile:' } }] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'acc-2' } }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [text('end')] },
      ],
    };
    const flat = adfText(doc);
    expect(flat.text).toContain('Hello @Alice\nnext');
    expect(flat.text).toContain('IGNORE PREVIOUS INSTRUCTIONS');
    expect(flat.text).toContain('panel text');
    expect(flat.text).toContain('https://example.com/a DONE:smile:');
    expect(flat.text).toContain('@acc-2');
    expect(flat.text).toContain('[첨부]');
    expect(flat.text).not.toMatch(/\n{3,}/);
    expect(flat.mentions).toEqual(['Alice', 'acc-2']);
  });

  it('collects people in order of first appearance, deduplicated, and redacts the token', async () => {
    const description = adf([text('cc '), { type: 'mention', attrs: { id: 'a', text: '@Zed' } }, text(` ${TOKEN}`)]);
    const comments = [
      comment(1, { body: adf([{ type: 'mention', attrs: { id: 'b', text: '@Yan' } }]) }),
      comment(2, { author: { displayName: 'Zed' }, body: adf([text('x')]) }),
      comment(3, { author: { displayName: `Xi ${TOKEN}` } }),
    ];
    const result = await jira(recorder({ body: issue({ description, comments }) }).fetchImpl).query(item());
    const detail = result.items[0]!.detail!;
    expect(detail.people).toEqual(['Zed', 'Person 1', 'Yan', 'Xi [redacted]']);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('omits the author when the comment has none', async () => {
    const bare = { id: '1', body: adf([text('anon')]), created: '2026-10-01T10:00:00.000Z' };
    const detail = (await jira(recorder({ body: issue({ comments: [bare] }) }).fetchImpl).query(item())).items[0]!.detail!;
    expect(detail.sections[1]).toEqual({ kind: 'comment', text: 'anon', at: '2026-10-01T10:00:00.000Z' });
  });
});

describe('Jira item query: D12 second request', () => {
  const embedded = Array.from({ length: 20 }, (_, i) => comment(i + 1));
  const newest = (from: number, count: number) => Array.from({ length: count }, (_, i) => comment(from - i)); // descending
  const page = (comments: unknown[], extra: Record<string, unknown> = {}) => ({ comments, startAt: 0, maxResults: 10, total: 30, ...extra });

  it('off by default: a partial page never makes a second request', async () => {
    const fake = recorder({ body: issue({ comments: embedded, total: 30 }) }, { body: page(newest(30, 10)) });
    const detail = (await jira(fake.fetchImpl).query(item())).items[0]!.detail!;
    expect(fake.calls).toHaveLength(1);
    expect(detail.requests).toBe(1);
  });

  it('off by default: an oversize response is simply too large (one request)', async () => {
    const fake = recorder({ raw: 'x'.repeat(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) }, { body: issue() });
    const error = await jira(fake.fetchImpl).query(item()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraConnectorItemTooLargeError);
    expect(fake.calls).toHaveLength(1);
  });

  it('branch A: a partial page triggers one GET of the newest 10, validated and put back in ascending order', async () => {
    const fake = recorder({ body: issue({ comments: embedded, total: 30 }) }, { body: page(newest(30, 10)) });
    const detail = (await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item())).items[0]!.detail!;

    expect(fake.calls).toHaveLength(2);
    const second = fake.calls[1]!;
    expect(second.method).toBe('GET');
    expect(second.redirect).toBe('manual');
    expect(second.url.pathname).toBe('/rest/api/3/issue/10042/comment');
    expect(second.url.searchParams.get('orderBy')).toBe('-created');
    expect(second.url.searchParams.get('maxResults')).toBe('10');
    expect(detail.requests).toBe(2);
    expect(detail.comments).toMatchObject({ total: 30, kept: 10, newest: true });
    expect(detail.partial).toBe(true);
    const comments = detail.sections.filter((s) => s.kind === 'comment').map((s) => s.text);
    expect(comments).toEqual(Array.from({ length: 10 }, (_, i) => `comment ${i + 21}`));
  });

  it('branch A is not run for a complete page or an error', async () => {
    const complete = recorder({ body: issue({ comments: [comment(1)] }) }, { body: page([]) });
    await jira(complete.fetchImpl, { itemSecondRequest: true }).query(item());
    expect(complete.calls).toHaveLength(1);
    const failing = recorder({ status: 500 }, { body: issue() });
    await jira(failing.fetchImpl, { itemSecondRequest: true }).query(item()).catch(() => undefined);
    expect(failing.calls).toHaveLength(1);
    const moved = recorder({ status: 302 }, { body: issue() });
    await jira(moved.fetchImpl, { itemSecondRequest: true }).query(item()).catch(() => undefined);
    expect(moved.calls).toHaveLength(1);
  });

  it.each([
    ['ascending order', page(newest(30, 10).reverse())],
    ['startAt not 0', page(newest(30, 10), { startAt: 5 })],
    ['more than maxResults', page(newest(30, 10), { maxResults: 5 })],
    ['maxResults above 10', page(newest(30, 10), { maxResults: 50 })],
    ['a comment without created', page([{ id: '1' }])],
    ['a comment without id', page([{ created: '2026-10-01T10:00:00.000Z' }])],
    ['not a container', { comments: 'x' }],
  ])('branch A drops an invalid second page (%s) and keeps request 1', async (_name, body) => {
    const fake = recorder({ body: issue({ comments: embedded, total: 30 }) }, { body });
    const detail = (await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item())).items[0]!.detail!;
    expect(fake.calls).toHaveLength(2);
    expect(detail.requests).toBe(2);
    expect(detail.comments).toEqual({ total: 30, returned: 20, kept: 10 });
    expect(detail.sections.filter((s) => s.kind === 'comment')[9]!.text).toBe('comment 20');
  });

  it('branch A keeps request 1 when the second request fails or is oversize', async () => {
    for (const second of [{ status: 500 }, { status: 302 }, { raw: 'x'.repeat(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) }] as Scripted[]) {
      const fake = recorder({ body: issue({ comments: embedded, total: 30 }) }, second);
      const detail = (await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item())).items[0]!.detail!;
      expect(fake.calls).toHaveLength(2);
      expect(detail.comments).toEqual({ total: 30, returned: 20, kept: 10 });
    }
  });

  it('branch B: an oversize first response retries once without comments', async () => {
    const fake = recorder({ raw: 'x'.repeat(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) }, { body: issue({ noComment: true }) });
    const detail = (await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item())).items[0]!.detail!;
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.url.pathname).toBe('/rest/api/3/issue/10042');
    expect(fake.calls[1]!.url.searchParams.get('fields')).toBe('summary,status,issuetype,description,updated');
    expect(fake.calls[1]!.redirect).toBe('manual');
    expect(detail).toMatchObject({ descriptionOnly: true, partial: true, requests: 2 });
    expect(detail.sections.map((s) => s.kind)).toEqual(['description']);
  });

  it('branch B twice oversize throws too-large after exactly 2 requests, never a third', async () => {
    const big = { raw: 'x'.repeat(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) };
    const fake = recorder(big, big, { body: page(newest(30, 10)) });
    const error = await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraConnectorItemTooLargeError);
    expect(fake.calls).toHaveLength(2);
  });

  it('branch B never turns into branch A (the description-only retry is not followed by a comment page)', async () => {
    const fake = recorder({ raw: 'x'.repeat(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) }, { body: issue({ noComment: true }) }, { body: page(newest(30, 10)) });
    await jira(fake.fetchImpl, { itemSecondRequest: true }).query(item());
    expect(fake.calls).toHaveLength(2);
  });
});

describe('Jira listings carry itemRef', () => {
  const search = () => ({ query: 'personal-work', params: { actorExternalId: 'acc' } });

  it('personal-work items get KEY:id when the id and key have the closed shapes', async () => {
    const fake = recorder({ body: { issues: [{ id: '10042', key: 'PROJ-12', fields: { summary: 'a' } }, { id: 'x1', key: 'PROJ-13', fields: {} }, { key: 'PROJ-14', fields: {} }, { id: '10045', key: 'proj-15', fields: {} }] } });
    const result = await jira(fake.fetchImpl).query(search());
    expect(result.items.map((i) => i.itemRef)).toEqual([REF, undefined, undefined, undefined]);
    expect(result.items[1]).not.toHaveProperty('itemRef');
  });

  it('release-items get KEY:id too', async () => {
    const fake = recorder({ body: { issues: [{ id: '10042', key: 'PROJ-12', fields: { summary: 'a' } }, { key: 'PROJ-13', fields: {} }], isLast: true } });
    const result = await jira(fake.fetchImpl).query({ query: 'release-items', params: { container: 'PROJ', releaseId: '1' } });
    expect(result.items.map((i) => i.itemRef)).toEqual([REF, undefined]);
  });
});
