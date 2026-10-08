import { describe, expect, it } from 'vitest';
import { isConnectorQueryError } from '@quoky/core';
import { GmailEndpointNotAllowedError, GmailResponseTooLargeError, GmailScopeError } from './errors';
import {
  GMAIL_API_ORIGIN,
  GMAIL_FULL_MAX_BYTES,
  GmailMailReader,
  assertGmailReadRequest,
  buildGmailSearchQuery,
} from './gmail-mail-reader';
import { GMAIL_OAUTH_TOKEN_URL, GMAIL_READONLY_SCOPE } from './oauth';

// Fixture credentials: placeholders, not token-shaped. NEVER a real Gmail call: every request goes to the fake fetch.
const CLIENT_SECRET = 'fixture-client-secret';
const REFRESH = 'fixture-refresh-value';
const ACCESS = 'fixture-access-value';
const NOW = Date.parse('2026-10-08T01:00:00.000Z');

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

type Route = (url: URL, call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const b64 = (text: string, encoding: BufferEncoding = 'utf8') => Buffer.from(text, encoding).toString('base64url');

function metadata(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hello &amp; welcome &#39;team&#39;',
    internalDate: String(Date.parse('2026-10-08T00:12:00.000Z')),
    payload: {
      headers: [
        { name: 'From', value: '"Kim, Chulsoo" <kim@example.com>' },
        { name: 'Subject', value: '=?UTF-8?B?7ZqM7J2YIOyekOujjA==?=' },
      ],
    },
    ...extra,
  };
}

function harness(api: Route, token: (call: Call) => Response = () => json({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer', scope: GMAIL_READONLY_SCOPE })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url: url.toString(), method: init?.method ?? 'GET', headers, ...(init?.body ? { body: String(init.body) } : {}) };
    calls.push(call);
    if (url.toString() === GMAIL_OAUTH_TOKEN_URL) return token(call);
    return api(url, call);
  }) as typeof fetch;
  const reader = new GmailMailReader({ clientId: 'fixture-client', clientSecret: CLIENT_SECRET, refreshToken: REFRESH, fetchImpl, nowMs: () => NOW });
  return { reader, calls };
}

async function failure(promise: Promise<unknown>): Promise<{ reason?: string; message: string; name: string }> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const secret of [CLIENT_SECRET, REFRESH, ACCESS]) expect(message).not.toContain(secret);
    return { ...(isConnectorQueryError(error) ? { reason: error.reason } : {}), message, name: (error as Error).name };
  }
  throw new Error('expected a failure');
}

describe('GmailMailReader (ADR-0118 D2/D3)', () => {
  it('search: one ids-only list call, then bounded metadata reads, mapped to the port shape', async () => {
    const ids = ['a1', 'b2', 'c3'];
    const { reader, calls } = harness((url) => {
      if (url.pathname === '/gmail/v1/users/me/messages') return json({ messages: ids.map((id) => ({ id, threadId: 't' })), nextPageToken: 'next' });
      return json(metadata(url.pathname.split('/').pop() as string));
    });
    const result = await reader.search({ unreadOnly: true, limit: 2 });
    expect(result.matched).toBe(3);
    expect(result.matchedIsLowerBound).toBe(true);
    expect(result.messages).toEqual([
      {
        id: 'a1',
        sender: { name: 'Kim, Chulsoo', address: 'kim@example.com' },
        subject: '회의 자료',
        receivedAt: '2026-10-08T00:12:00.000Z',
        snippet: "Hello & welcome 'team'",
        unread: true,
      },
      expect.objectContaining({ id: 'b2' }),
    ]);
    const list = new URL(calls[1]?.url as string);
    expect(list.searchParams.get('q')).toBe('in:inbox is:unread');
    expect(list.searchParams.get('maxResults')).toBe('100');
    expect(list.searchParams.get('fields')).toBe('messages(id),nextPageToken');
    const meta = new URL(calls[2]?.url as string);
    expect(meta.pathname).toBe('/gmail/v1/users/me/messages/a1');
    expect(meta.searchParams.get('format')).toBe('metadata');
    expect(meta.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject']);
    // Exactly: token refresh, list, two metadata reads (limit 2) — never a third.
    expect(calls.length).toBe(4);
    for (const call of calls.slice(1)) {
      expect(call.method).toBe('GET');
      expect(call.url.startsWith(`${GMAIL_API_ORIGIN}/gmail/v1/users/me/messages`)).toBe(true);
      expect(call.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    }
    expect(calls[0]?.method).toBe('POST');
  });

  it('renders the vendor query from the validated filters only, escaping the owner-typed sender', () => {
    const base = { unreadOnly: false, limit: 10 } as const;
    expect(buildGmailSearchQuery({ ...base, receivedAfter: '2026-10-07T15:00:00.000Z', receivedAfterMs: Date.parse('2026-10-07T15:00:00.000Z') })).toBe(
      'in:inbox after:1791385200',
    );
    expect(buildGmailSearchQuery({ ...base, from: '김철수' })).toBe('from:"김철수"');
    expect(buildGmailSearchQuery({ ...base, from: 'a" OR label:secret (x) {y}' })).toBe('from:"a OR label secret x y"');
    expect(() => buildGmailSearchQuery({ ...base, from: '"()"' })).toThrow();
  });

  it('an empty inbox is an empty result (a partial response omits messages)', async () => {
    const { reader, calls } = harness(() => json({}));
    expect(await reader.search({ unreadOnly: true })).toEqual({ messages: [], matched: 0, matchedIsLowerBound: false });
    expect(calls.length).toBe(2);
  });

  it('a message deleted between the list and its metadata read is skipped and not counted', async () => {
    const { reader } = harness((url) => {
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'x1' }, { id: 'x2' }] });
      return url.pathname.endsWith('/x1') ? json({ error: { code: 404 } }, 404) : json(metadata('x2'));
    });
    const result = await reader.search({ from: 'kim' });
    expect(result.messages.map((message) => message.id)).toEqual(['x2']);
    expect(result.matched).toBe(1);
  });

  it('getMessage: the first inline text/plain part, attachments never read, body bounded to 256 KiB', async () => {
    const payload = {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'billing@example.com' }, { name: 'Subject', value: 'Invoice' }],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64('Plain body line\n둘째 줄') } },
          { mimeType: 'text/html', body: { data: b64('<p>HTML</p>') } },
        ] },
        { mimeType: 'text/plain', filename: 'secret.txt', body: { attachmentId: 'att-1', size: 10 } },
      ],
    };
    const { reader, calls } = harness(() => json({ ...metadata('m1'), payload }));
    const message = await reader.getMessage('m1');
    expect(message).toMatchObject({ id: 'm1', bodyText: 'Plain body line\n둘째 줄', bodyTruncated: false, sender: { name: '', address: 'billing@example.com' }, subject: 'Invoice' });
    const get = new URL(calls[1]?.url as string);
    expect(get.searchParams.get('format')).toBe('full');
    expect(calls.some((call) => call.url.includes('attachments'))).toBe(false);

    const huge = harness(() => json({ ...metadata('m2'), payload: { mimeType: 'text/plain', body: { data: b64('가'.repeat(100_000)) } } }));
    const big = await huge.reader.getMessage('m2');
    expect(big.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(big.bodyText, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  it('an HTML-only body is reduced to text; a non-UTF-8 charset (ISO-2022-JP, Japanese mail) is decoded', async () => {
    const html = harness(() =>
      json({ ...metadata('h1'), payload: { mimeType: 'text/html', body: { data: b64('<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><p>Line&#33;</p></body></html>') } } }),
    );
    expect((await html.reader.getMessage('h1')).bodyText).toBe('Hello world\nLine!');

    const jis = Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41, 0x24, 0x4f, 0x1b, 0x28, 0x42]);
    const japanese = harness(() =>
      json({
        ...metadata('j1'),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Content-Type', value: 'text/plain; charset=ISO-2022-JP' },
            { name: 'From', value: '=?ISO-2022-JP?B?GyRCOzNFRBsoQg==?= <yamada@example.jp>' },
          ],
          body: { data: jis.toString('base64url') },
        },
      }),
    );
    const message = await japanese.reader.getMessage('j1');
    expect(message.bodyText).toBe('こんにちは');
    expect(message.sender).toEqual({ name: '山田', address: 'yamada@example.jp' });
  });

  it('refuses a response over its size bound without keeping it', async () => {
    const declared = harness(() => new Response('{}', { status: 200, headers: { 'content-length': String(GMAIL_FULL_MAX_BYTES + 1) } }));
    expect(await failure(declared.reader.getMessage('m1'))).toMatchObject({ reason: 'INVALID_RESPONSE', name: 'GmailResponseTooLargeError' });
    const streamed = harness(() => new Response(`{"messages":[${'{"id":"a"},'.repeat(10_000)}{"id":"b"}]}`, { status: 200 }));
    const error = await failure(streamed.reader.search({ unreadOnly: true }));
    expect(error.name).toBe(new GmailResponseTooLargeError('gmail').name);
  });

  it('a 401 refreshes once and retries once; a second 401 is UNAUTHORIZED (auth expired)', async () => {
    let gets = 0;
    const once = harness(() => (++gets === 1 ? json({}, 401) : json({})));
    await once.reader.search({ unreadOnly: true });
    expect(once.calls.filter((call) => call.url === GMAIL_OAUTH_TOKEN_URL).length).toBe(2);

    const always = harness(() => json({}, 401));
    expect((await failure(always.reader.search({ unreadOnly: true }))).reason).toBe('UNAUTHORIZED');
  });

  it.each([
    ['revoked refresh token (invalid_grant)', json({ error: 'invalid_grant' }, 400), 'UNAUTHORIZED'],
    ['invalid_scope', json({ error: 'invalid_scope' }, 400), 'INSUFFICIENT_SCOPE'],
    ['token endpoint 503', json({}, 503), 'UNAVAILABLE'],
    ['token endpoint 429', json({}, 429), 'RATE_LIMITED'],
    ['a grant of another scope only (refused as broader)', json({ access_token: ACCESS, expires_in: 3600, scope: 'openid' }), 'FORBIDDEN'],
    ['a grant with no scope field (needs consent)', json({ access_token: ACCESS, expires_in: 3600 }), 'INSUFFICIENT_SCOPE'],
    ['a broader grant (gmail.modify alongside)', json({ access_token: ACCESS, expires_in: 3600, scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify` }), 'FORBIDDEN'],
    ['the full mail scope', json({ access_token: ACCESS, expires_in: 3600, scope: 'https://mail.google.com/' }), 'FORBIDDEN'],
  ])('token failure: %s → %s', async (_label, response, reason) => {
    const { reader, calls } = harness(() => json({}), () => response.clone());
    expect((await failure(reader.search({ unreadOnly: true }))).reason).toBe(reason);
    // Nothing reaches the Gmail API without a valid read-only grant.
    expect(calls.every((call) => call.url === GMAIL_OAUTH_TOKEN_URL)).toBe(true);
  });

  it.each([
    [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'INSUFFICIENT_SCOPE'],
    [403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'INSUFFICIENT_SCOPE'],
    [403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 'RATE_LIMITED'],
    [403, { error: { errors: [{ reason: 'domainPolicy' }] } }, 'FORBIDDEN'],
    [429, {}, 'RATE_LIMITED'],
    [500, {}, 'UNAVAILABLE'],
    [404, {}, 'NOT_FOUND'],
    [400, {}, 'UNSUPPORTED_QUERY'],
  ])('Gmail API %s → typed failure', async (status, body, reason) => {
    const { reader } = harness(() => json(body, status));
    expect((await failure(reader.getMessage('m1'))).reason).toBe(reason);
  });

  it('a transport failure or an unexpected shape is a value-free typed failure', async () => {
    const broken = harness(() => {
      throw new Error(`socket closed ${ACCESS}`);
    });
    expect(await failure(broken.reader.search({ unreadOnly: true }))).toMatchObject({ reason: 'UNAVAILABLE' });
    const odd = harness(() => json({ messages: [{ id: '../../drafts' }] }));
    expect((await failure(odd.reader.search({ unreadOnly: true }))).reason).toBe('INVALID_RESPONSE');
    const wrongId = harness(() => json(metadata('other')));
    expect((await failure(wrongId.reader.getMessage('m1'))).reason).toBe('INVALID_RESPONSE');
    expect((await failure(wrongId.reader.getMessage('../send'))).reason).toBe('UNSUPPORTED_QUERY');
  });

  it('the request guard allows only GET to the pinned messages endpoints with read parameters', () => {
    const ok = new URL('/gmail/v1/users/me/messages/abc?format=full&fields=id', GMAIL_API_ORIGIN);
    expect(() => assertGmailReadRequest(ok, 'GET')).not.toThrow();
    const refused: Array<[string, string]> = [
      ['/gmail/v1/users/me/messages/abc', 'POST'],
      ['/gmail/v1/users/me/messages/abc', 'DELETE'],
      ['/gmail/v1/users/me/messages/send', 'POST'],
      ['/gmail/v1/users/me/messages/abc/modify', 'POST'],
      ['/gmail/v1/users/me/messages/abc/trash', 'POST'],
      ['/gmail/v1/users/me/drafts', 'GET'],
      ['/gmail/v1/users/me/labels', 'GET'],
      ['/gmail/v1/users/me/settings/filters', 'GET'],
      ['/gmail/v1/users/other@example.com/messages', 'GET'],
      ['/gmail/v1/users/me/messages?uploadType=media', 'GET'],
    ];
    for (const [path, method] of refused) {
      expect(() => assertGmailReadRequest(new URL(path, GMAIL_API_ORIGIN), method), `${method} ${path}`).toThrow(GmailEndpointNotAllowedError);
    }
    expect(() => assertGmailReadRequest(new URL('https://evil.example/gmail/v1/users/me/messages'), 'GET')).toThrow(GmailEndpointNotAllowedError);
  });

  it('construction makes no network call and refuses an empty credential', () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return json({});
    }) as typeof fetch;
    new GmailMailReader({ clientId: 'c', clientSecret: 's', refreshToken: REFRESH, fetchImpl });
    expect(called).toBe(false);
    expect(() => new GmailMailReader({ clientId: 'c', clientSecret: 's', refreshToken: ' ' })).toThrow('non-empty refresh token');
    expect(new GmailScopeError('MISSING').reason).toBe('INSUFFICIENT_SCOPE');
  });
});
