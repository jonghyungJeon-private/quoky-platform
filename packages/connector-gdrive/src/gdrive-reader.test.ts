import { describe, expect, it } from 'vitest';
import { DRIVE_TEXT_MAX_BYTES, isConnectorQueryError } from '@quoky/core';
import { GDriveEndpointNotAllowedError, GDriveScopeError } from './errors';
import {
  GDRIVE_API_ORIGIN,
  GDRIVE_LIST_MAX_BYTES,
  GoogleDriveReader,
  assertGDriveReadRequest,
  buildGDriveQuery,
  driveKindOf,
} from './gdrive-reader';
import { DRIVE_READONLY_SCOPE, GDRIVE_OAUTH_TOKEN_URL } from './oauth';

// Fixture credentials: placeholders, not token-shaped. NEVER a real Drive call: every request goes to the fake fetch.
const CLIENT_SECRET = 'fixture-client-secret';
const REFRESH = 'fixture-refresh-value';
const ACCESS = 'fixture-access-value';
const NOW = Date.parse('2026-10-08T01:00:00.000Z');
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';

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

function text(body: string | Uint8Array, type = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': type } });
}

function meta(id: string, mimeType = DOC, extra: Record<string, unknown> = {}) {
  return { id, name: `회의록 ${id}`, mimeType, modifiedTime: '2026-10-08T00:12:00.000Z', ...extra };
}

function harness(api: Route, token: (call: Call) => Response = () => json({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer', scope: DRIVE_READONLY_SCOPE })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url: url.toString(), method: init?.method ?? 'GET', headers, ...(init?.body ? { body: String(init.body) } : {}) };
    calls.push(call);
    if (url.toString() === GDRIVE_OAUTH_TOKEN_URL) return token(call);
    return api(url, call);
  }) as typeof fetch;
  const reader = new GoogleDriveReader({ clientId: 'fixture-client', clientSecret: CLIENT_SECRET, refreshToken: REFRESH, fetchImpl, nowMs: () => NOW });
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

describe('GoogleDriveReader (ADR-0118 D2/D3, DRV-1)', () => {
  it('recentFiles: one bounded list call, newest modified first, mapped to neutral kinds; no count call without more', async () => {
    const { reader, calls } = harness(() =>
      json({ files: [meta('a1'), meta('b2', SHEET, { name: '2026 예산' }), meta('c3', 'application/pdf'), meta('d4', 'image/png')] }),
    );
    const result = await reader.recentFiles();
    expect(result).toEqual({
      files: [
        { id: 'a1', name: '회의록 a1', kind: 'document', modifiedAt: '2026-10-08T00:12:00.000Z' },
        { id: 'b2', name: '2026 예산', kind: 'spreadsheet', modifiedAt: '2026-10-08T00:12:00.000Z' },
        { id: 'c3', name: '회의록 c3', kind: 'pdf', modifiedAt: '2026-10-08T00:12:00.000Z' },
        { id: 'd4', name: '회의록 d4', kind: 'other', modifiedAt: '2026-10-08T00:12:00.000Z' },
      ],
      matched: 4,
      matchedIsLowerBound: false,
    });
    expect(calls.length).toBe(2);
    const list = new URL(calls[1]?.url as string);
    expect(list.pathname).toBe('/drive/v3/files');
    expect(list.searchParams.get('q')).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
    expect(list.searchParams.get('pageSize')).toBe('10');
    expect(list.searchParams.get('orderBy')).toBe('modifiedTime desc');
    expect(list.searchParams.get('fields')).toBe('files(id,name,mimeType,modifiedTime),nextPageToken');
    expect(calls[0]?.method).toBe('POST');
    for (const call of calls.slice(1)) {
      expect(call.method).toBe('GET');
      expect(call.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    }
  });

  it('searchByName: escapes the owner-typed name into a name-contains literal; counts the rest with an ids-only page', async () => {
    const { reader, calls } = harness((url) => {
      if (url.searchParams.get('fields') === 'files(id),nextPageToken') {
        return json({ files: Array.from({ length: 100 }, (_, index) => ({ id: `id${index}` })), nextPageToken: 'more' });
      }
      return json({ files: Array.from({ length: 10 }, (_, index) => meta(`f${index}`)), nextPageToken: 'next' });
    });
    const result = await reader.searchByName("  회의록' or name contains 'x  ", 10);
    expect(result.files.length).toBe(10);
    expect(result.matched).toBe(100);
    expect(result.matchedIsLowerBound).toBe(true);
    expect(new URL(calls[1]?.url as string).searchParams.get('q')).toBe(
      "trashed = false and mimeType != 'application/vnd.google-apps.folder' and name contains '회의록 or name contains x'",
    );
    const count = new URL(calls[2]?.url as string);
    expect(count.searchParams.get('pageSize')).toBe('100');
    expect(calls.length).toBe(3);
  });

  it('renders the vendor query from validated text only; a name of quotes only is refused', () => {
    expect(buildGDriveQuery()).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
    expect(buildGDriveQuery('a\\b"c')).toContain("name contains 'a b c'");
    expect(() => buildGDriveQuery(`'"\\`)).toThrow();
  });

  it('an empty drive is an empty result (a partial response omits files)', async () => {
    const { reader, calls } = harness(() => json({}));
    expect(await reader.recentFiles()).toEqual({ files: [], matched: 0, matchedIsLowerBound: false });
    expect(calls.length).toBe(2);
  });

  it('exportText: a Google Doc is exported as text/plain, a Sheet as text/csv, a text file downloaded; others never read', async () => {
    const routes: Record<string, () => Response> = {
      '/drive/v3/files/d1': () => json({ ...meta('d1'), owners: [{ displayName: '김철수', emailAddress: 'kim@example.com' }] }),
      '/drive/v3/files/d1/export': () => text('﻿회의 결론: 금요일 출시'),
      '/drive/v3/files/s1': () => json(meta('s1', SHEET)),
      '/drive/v3/files/s1/export': () => text('항목,금액\n서버,100', 'text/csv'),
      '/drive/v3/files/t1': () => json(meta('t1', 'text/markdown')),
      '/drive/v3/files/p1': () => json(meta('p1', 'application/vnd.google-apps.presentation')),
      '/drive/v3/files/b1': () => json(meta('b1', 'application/pdf')),
    };
    const { reader, calls } = harness((url) => {
      if (url.pathname === '/drive/v3/files/t1' && url.searchParams.get('alt') === 'media') return text('# notes\n- one');
      const route = routes[url.pathname];
      return route ? route() : json({}, 404);
    });
    const doc = await reader.exportText('d1');
    expect(doc).toEqual({
      id: 'd1',
      name: '회의록 d1',
      kind: 'document',
      modifiedAt: '2026-10-08T00:12:00.000Z',
      ownerName: '김철수',
      text: '회의 결론: 금요일 출시',
      textTruncated: false,
    });
    expect(new URL(calls[1]?.url as string).searchParams.get('fields')).toBe('id,name,mimeType,modifiedTime,owners(displayName)');
    expect(new URL(calls[2]?.url as string).searchParams.get('mimeType')).toBe('text/plain');
    expect((await reader.exportText('s1')).text).toBe('항목,금액\n서버,100');
    expect(calls.some((call) => call.url.endsWith('/s1/export?mimeType=text%2Fcsv'))).toBe(true);
    expect((await reader.exportText('t1')).text).toBe('# notes\n- one');
    expect(calls.some((call) => call.url.endsWith('/t1?alt=media'))).toBe(true);
    const before = calls.length;
    expect((await failure(reader.exportText('p1'))).reason).toBe('UNSUPPORTED_QUERY');
    expect((await failure(reader.exportText('b1'))).reason).toBe('UNSUPPORTED_QUERY');
    // Only the two metadata reads: no export and no download of a presentation or a PDF.
    expect(calls.slice(before).map((call) => new URL(call.url).pathname)).toEqual(['/drive/v3/files/p1', '/drive/v3/files/b1']);
  });

  it('the exported text is cut at 256 KiB while it streams (never a split code point) and marked truncated', async () => {
    const big = new TextEncoder().encode(`${'a'.repeat(DRIVE_TEXT_MAX_BYTES - 1)}가${'나'.repeat(100_000)}`);
    const { reader } = harness((url) => (url.pathname.endsWith('/export') ? text(big) : json(meta('d1'))));
    const doc = await reader.exportText('d1');
    expect(doc.textTruncated).toBe(true);
    expect(Buffer.byteLength(doc.text, 'utf8')).toBeLessThanOrEqual(DRIVE_TEXT_MAX_BYTES);
    expect(doc.text.endsWith('a')).toBe(true);
    expect(doc.text).not.toContain('�');
  });

  it('a text read whose body is not text/* is refused (no binary download)', async () => {
    const { reader } = harness((url) =>
      url.pathname.endsWith('/export') ? new Response(new Uint8Array([0, 1, 2]), { headers: { 'Content-Type': 'application/octet-stream' } }) : json(meta('d1')),
    );
    expect((await failure(reader.exportText('d1'))).reason).toBe('INVALID_RESPONSE');
  });

  it('refuses a JSON response over its size bound without keeping it', async () => {
    const { reader } = harness(() => new Response(`{"files":[${'{"id":"a"},'.repeat(60_000)}{"id":"b"}]}`, { status: 200 }));
    const error = await failure(reader.recentFiles());
    expect(error).toMatchObject({ reason: 'INVALID_RESPONSE', name: 'GDriveResponseTooLargeError' });
    expect(GDRIVE_LIST_MAX_BYTES).toBe(512 * 1024);
  });

  it('a 401 refreshes once and retries once; a second 401 is UNAUTHORIZED (auth expired)', async () => {
    let gets = 0;
    const once = harness(() => (++gets === 1 ? json({}, 401) : json({})));
    await once.reader.recentFiles();
    expect(once.calls.filter((call) => call.url === GDRIVE_OAUTH_TOKEN_URL).length).toBe(2);
    const always = harness(() => json({}, 401));
    expect((await failure(always.reader.recentFiles())).reason).toBe('UNAUTHORIZED');
  });

  it.each([
    ['revoked refresh token (invalid_grant)', json({ error: 'invalid_grant' }, 400), 'UNAUTHORIZED'],
    ['invalid_scope', json({ error: 'invalid_scope' }, 400), 'INSUFFICIENT_SCOPE'],
    ['token endpoint 503', json({}, 503), 'UNAVAILABLE'],
    ['token endpoint 429', json({}, 429), 'RATE_LIMITED'],
    ['a grant of another scope only (refused as broader)', json({ access_token: ACCESS, expires_in: 3600, scope: 'openid' }), 'FORBIDDEN'],
    ['a grant with no scope field (needs consent)', json({ access_token: ACCESS, expires_in: 3600 }), 'INSUFFICIENT_SCOPE'],
    ['a broader grant (full drive alongside)', json({ access_token: ACCESS, expires_in: 3600, scope: `${DRIVE_READONLY_SCOPE} https://www.googleapis.com/auth/drive` }), 'FORBIDDEN'],
    ['drive.file instead', json({ access_token: ACCESS, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }), 'FORBIDDEN'],
    ['the Gmail read scope alongside', json({ access_token: ACCESS, expires_in: 3600, scope: `${DRIVE_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.readonly` }), 'FORBIDDEN'],
  ])('token failure (checked at every refresh): %s → %s', async (_label, response, reason) => {
    const { reader, calls } = harness(() => json({}), () => response.clone());
    expect((await failure(reader.recentFiles())).reason).toBe(reason);
    // Nothing reaches the Drive API without a valid read-only grant.
    expect(calls.every((call) => call.url === GDRIVE_OAUTH_TOKEN_URL)).toBe(true);
  });

  it.each([
    [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'INSUFFICIENT_SCOPE'],
    [403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'INSUFFICIENT_SCOPE'],
    [403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 'RATE_LIMITED'],
    [403, { error: { errors: [{ reason: 'exportSizeLimitExceeded' }] } }, 'INVALID_RESPONSE'],
    [403, { error: { errors: [{ reason: 'domainPolicy' }] } }, 'FORBIDDEN'],
    [429, {}, 'RATE_LIMITED'],
    [500, {}, 'UNAVAILABLE'],
    [404, {}, 'NOT_FOUND'],
    [400, {}, 'UNSUPPORTED_QUERY'],
  ])('Drive API %s → typed failure', async (status, body, reason) => {
    const { reader } = harness(() => json(body, status));
    expect((await failure(reader.exportText('d1'))).reason).toBe(reason);
  });

  it('a transport failure or an unexpected shape is a value-free typed failure', async () => {
    const broken = harness(() => {
      throw new Error(`socket closed ${ACCESS}`);
    });
    expect(await failure(broken.reader.recentFiles())).toMatchObject({ reason: 'UNAVAILABLE' });
    const odd = harness(() => json({ files: [{ ...meta('x'), id: '../../files/x/permissions' }] }));
    expect((await failure(odd.reader.recentFiles())).reason).toBe('INVALID_RESPONSE');
    const tooMany = harness(() => json({ files: Array.from({ length: 11 }, (_, index) => meta(`f${index}`)) }));
    expect((await failure(tooMany.reader.recentFiles())).reason).toBe('INVALID_RESPONSE');
    const wrongId = harness(() => json(meta('other')));
    expect((await failure(wrongId.reader.exportText('d1'))).reason).toBe('INVALID_RESPONSE');
    expect((await failure(wrongId.reader.exportText('../d1/permissions'))).reason).toBe('UNSUPPORTED_QUERY');
    expect((await failure(wrongId.reader.searchByName(' '))).reason).toBe('UNSUPPORTED_QUERY');
  });

  it('the request guard allows only GET to the pinned list, get and text-export endpoints with read parameters', () => {
    const allowed = [
      '/drive/v3/files?q=x&pageSize=10&orderBy=modifiedTime+desc&fields=files(id)&spaces=drive',
      '/drive/v3/files/abc?fields=id,name',
      '/drive/v3/files/abc?alt=media',
      '/drive/v3/files/abc/export?mimeType=text%2Fplain',
      '/drive/v3/files/abc/export?mimeType=text%2Fcsv',
    ];
    for (const path of allowed) expect(() => assertGDriveReadRequest(new URL(path, GDRIVE_API_ORIGIN), 'GET'), path).not.toThrow();
    const refused: Array<[string, string]> = [
      ['/drive/v3/files', 'POST'],
      ['/drive/v3/files/abc', 'PATCH'],
      ['/drive/v3/files/abc', 'DELETE'],
      ['/drive/v3/files/abc/copy', 'POST'],
      ['/drive/v3/files/abc/permissions', 'GET'],
      ['/drive/v3/files/abc/permissions', 'POST'],
      ['/drive/v3/files/abc/revisions', 'GET'],
      ['/drive/v3/files/abc/comments', 'GET'],
      ['/drive/v3/files/abc/watch', 'POST'],
      ['/drive/v3/files/trash', 'DELETE'],
      ['/drive/v3/changes', 'GET'],
      ['/drive/v3/about', 'GET'],
      ['/upload/drive/v3/files?uploadType=media', 'POST'],
      ['/drive/v3/files/abc/export?mimeType=application%2Fpdf', 'GET'],
      ['/drive/v3/files/abc/export', 'GET'],
      ['/drive/v3/files/abc?alt=json', 'GET'],
      ['/drive/v3/files/abc?alt=media&fields=id', 'GET'],
      ['/drive/v3/files?q=x&pageToken=t', 'GET'],
      ['/drive/v3/files?q=x&q=y', 'GET'],
      ['/drive/v3/files?supportsAllDrives=true', 'GET'],
      ['/drive/v2/files', 'GET'],
    ];
    for (const [path, method] of refused) {
      expect(() => assertGDriveReadRequest(new URL(path, GDRIVE_API_ORIGIN), method), `${method} ${path}`).toThrow(GDriveEndpointNotAllowedError);
    }
    expect(() => assertGDriveReadRequest(new URL('https://evil.example/drive/v3/files'), 'GET')).toThrow(GDriveEndpointNotAllowedError);
    expect(() => assertGDriveReadRequest(new URL('https://content.googleapis.com/drive/v3/files'), 'GET')).toThrow(GDriveEndpointNotAllowedError);
  });

  it('maps vendor types to neutral kinds; construction makes no network call and refuses an empty credential', () => {
    expect(['document', 'spreadsheet', 'presentation', 'folder', 'pdf', 'text', 'text', 'text', 'other', 'other']).toEqual(
      [DOC, SHEET, 'application/vnd.google-apps.presentation', 'application/vnd.google-apps.folder', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'text/html', undefined].map(driveKindOf),
    );
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return json({});
    }) as typeof fetch;
    new GoogleDriveReader({ clientId: 'c', clientSecret: 's', refreshToken: REFRESH, fetchImpl });
    expect(called).toBe(false);
    expect(() => new GoogleDriveReader({ clientId: 'c', clientSecret: 's', refreshToken: ' ' })).toThrow('non-empty refresh token');
    expect(new GDriveScopeError('MISSING').reason).toBe('INSUFFICIENT_SCOPE');
  });
});
