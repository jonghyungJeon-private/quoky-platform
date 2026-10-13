import { describe, expect, it } from 'vitest';
import { DRIVE_SHEETS_MAX, DRIVE_TEXT_MAX_BYTES, PLT1_VARIANTS, isConnectorQueryError } from '@quoky/core';
import { GDriveEndpointNotAllowedError } from './errors';
import { GDRIVE_ALL_DRIVES_PARAMS, GoogleDriveReader, assertGoogleReadRequest } from './gdrive-reader';
import { DRIVE_READONLY_SCOPE, GDRIVE_OAUTH_TOKEN_URL } from './oauth';
import {
  GSHEETS_API_ORIGIN,
  GSHEETS_CELL_MAX_CHARS,
  GSHEETS_MAX_CELLS,
  GSHEETS_MAX_COLUMNS,
  GSHEETS_META_FIELDS,
  GSHEETS_VALUES_FIELDS,
  assertGSheetsReadRequest,
  gsheetsRange,
  gsheetsRowsPerSheet,
} from './sheets-reader';

/**
 * DRV-2 (shared drives) and DRV-2b (every sheet through the Sheets API), ADR-0118 amendment 2026-10-12 (b)/(c). Every
 * request goes to the fake fetch: never a real Google call.
 */

const CLIENT_SECRET = 'fixture-client-secret';
const REFRESH = 'fixture-refresh-value';
const ACCESS = 'fixture-access-value';
const NOW = Date.parse('2026-10-13T01:00:00.000Z');
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';

interface Call {
  readonly url: string;
  readonly method: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function meta(id: string, mimeType = SHEET) {
  return { id, name: `예산 ${id}`, mimeType, modifiedTime: '2026-10-12T00:00:00.000Z', owners: [{ displayName: '김철수' }] };
}

interface Routes {
  readonly sheetsMeta?: (url: URL) => Response | Promise<Response>;
  readonly sheetsValues?: (url: URL) => Response | Promise<Response>;
  readonly drive?: (url: URL) => Response;
}

function harness(routes: Routes) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    if (url.toString() === GDRIVE_OAUTH_TOKEN_URL) return json({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer', scope: DRIVE_READONLY_SCOPE });
    if (url.origin === GSHEETS_API_ORIGIN) {
      if (url.pathname.endsWith('/values:batchGet')) return (routes.sheetsValues ?? (() => json({}, 500)))(url);
      return (routes.sheetsMeta ?? (() => json({}, 500)))(url);
    }
    if (routes.drive) return routes.drive(url);
    if (url.pathname.endsWith('/export')) return new Response('항목,금액\n서버,100', { status: 200, headers: { 'Content-Type': 'text/csv' } });
    if (url.pathname === '/drive/v3/files') return json({ files: [meta('s1')] });
    return json(meta(url.pathname.split('/').pop() as string));
  }) as typeof fetch;
  const reader = new GoogleDriveReader({ clientId: 'fixture-client', clientSecret: CLIENT_SECRET, refreshToken: REFRESH, fetchImpl, nowMs: () => NOW });
  const sheetsCalls = () => calls.filter((call) => call.url.startsWith(GSHEETS_API_ORIGIN)).map((call) => new URL(call.url));
  const exports = () => calls.filter((call) => call.url.includes('/export'));
  return { reader, calls, sheetsCalls, exports };
}

function sheetList(titles: readonly string[], extra: ReadonlyArray<Record<string, unknown>> = []) {
  return json({ sheets: [...titles.map((title, index) => ({ properties: { title, index, sheetType: 'GRID' } })), ...extra] });
}

/** A values answer with one value range per requested range, built by `rowsFor(rangeIndex)`. */
function valuesFor(rowsFor: (index: number, range: string) => unknown[][]) {
  return (url: URL) => json({ valueRanges: url.searchParams.getAll('ranges').map((range, index) => ({ values: rowsFor(index, range) })) });
}

async function failure(promise: Promise<unknown>): Promise<{ reason?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const secret of [CLIENT_SECRET, REFRESH, ACCESS]) expect(message).not.toContain(secret);
    return { ...(isConnectorQueryError(error) ? { reason: error.reason } : {}), message };
  }
  throw new Error('expected a failure');
}

describe('DRV-2: listings include the owner\'s shared drives (still drive.readonly, still at most 10)', () => {
  it('the list and the count call carry corpora=allDrives, includeItemsFromAllDrives and supportsAllDrives', async () => {
    const { reader, calls } = harness({
      drive: (url) =>
        url.searchParams.get('fields') === 'files(id),nextPageToken'
          ? json({ files: [{ id: 'x1' }, { id: 'x2' }] })
          : json({ files: Array.from({ length: 10 }, (_, index) => ({ ...meta(`f${index}`, DOC) })), nextPageToken: 'more' }),
    });
    await reader.searchByName('예산');
    await reader.recentFiles();
    const lists = calls.filter((call) => new URL(call.url).pathname === '/drive/v3/files').map((call) => new URL(call.url));
    expect(lists.length).toBe(4);
    for (const url of lists) {
      expect(url.searchParams.get('corpora')).toBe('allDrives');
      expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
      expect(url.searchParams.get('spaces')).toBe('drive');
      expect(url.searchParams.has('driveId')).toBe(false);
      expect(url.searchParams.has('pageToken')).toBe(false);
    }
    expect(Number(lists[0]?.searchParams.get('pageSize'))).toBeLessThanOrEqual(10);
    expect(GDRIVE_ALL_DRIVES_PARAMS).toEqual({ corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });
  });

  it('a shared-drive file: metadata with supportsAllDrives; the export carries only its documented mimeType', async () => {
    const doc = harness({ drive: (url) => (url.pathname.endsWith('/export') ? new Response('본문', { headers: { 'Content-Type': 'text/plain' } }) : json(meta('d1', DOC))) });
    expect((await doc.reader.exportText('d1')).text).toBe('본문');
    const get = new URL(doc.calls[1]?.url as string);
    expect(get.searchParams.get('supportsAllDrives')).toBe('true');
    const exported = new URL(doc.calls[2]?.url as string);
    expect([...exported.searchParams.keys()]).toEqual(['mimeType']);
    // A document never touches the Sheets API.
    expect(doc.calls.some((call) => call.url.startsWith(GSHEETS_API_ORIGIN))).toBe(false);
  });
});

describe('DRV-2b: every sheet through the Sheets API under drive.readonly', () => {
  it('reads the sheet list (titles, indexes, types only), then one values read: values only, formatted, by rows; no CSV export', async () => {
    const { reader, sheetsCalls, exports, calls } = harness({
      sheetsMeta: () =>
        json({
          sheets: [
            { properties: { title: '요약', index: 1, sheetType: 'GRID' } },
            { properties: { title: '차트', index: 2, sheetType: 'OBJECT' } },
            { properties: { title: '원본', index: 0 } },
          ],
        }),
      sheetsValues: valuesFor((index) => (index === 0 ? [['항목', '금액'], ['서버', '100']] : [['합계', '=SUM은 보이지 않음', '', '']])),
    });
    const document = await reader.exportText('s1');
    expect(document.sections).toEqual([
      { title: '원본', text: '항목,금액\n서버,100' },
      { title: '요약', text: '합계,=SUM은 보이지 않음' },
    ]);
    expect(document.text).toBe('[원본]\n항목,금액\n서버,100\n\n[요약]\n합계,=SUM은 보이지 않음');
    expect(document.textTruncated).toBe(false);
    expect(document.firstSheetOnly).toBeUndefined();
    expect(exports()).toEqual([]);
    const [metaCall, valuesCall] = sheetsCalls();
    expect(metaCall?.pathname).toBe('/v4/spreadsheets/s1');
    expect([...(metaCall?.searchParams.entries() ?? [])]).toEqual([['fields', GSHEETS_META_FIELDS]]);
    expect(valuesCall?.pathname).toBe('/v4/spreadsheets/s1/values:batchGet');
    expect(valuesCall?.searchParams.getAll('ranges')).toEqual([`'원본'!A1:Z${gsheetsRowsPerSheet(2)}`, `'요약'!A1:Z${gsheetsRowsPerSheet(2)}`]);
    expect(valuesCall?.searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE');
    expect(valuesCall?.searchParams.get('majorDimension')).toBe('ROWS');
    expect(valuesCall?.searchParams.get('fields')).toBe(GSHEETS_VALUES_FIELDS);
    expect(valuesCall?.searchParams.has('includeGridData')).toBe(false);
    // Same token, GET only, the bearer from the drive.readonly grant.
    for (const call of calls.filter((entry) => entry.url !== GDRIVE_OAUTH_TOKEN_URL)) expect(call.method).toBe('GET');
  });

  it('cells: values only (an object or array cell is empty), one line, CSV-quoted, each cut at the cell bound', async () => {
    const long = '가'.repeat(GSHEETS_CELL_MAX_CHARS + 50);
    const { reader } = harness({
      sheetsMeta: () => sheetList(['A']),
      sheetsValues: valuesFor(() => [['a,b', 'say "hi"', 'line1\nline2\tx', { formula: '=IMPORTRANGE("https://evil")' }, ['x'], 3, true, long]]),
    });
    const document = await reader.exportText('s1');
    const text = document.sections?.[0]?.text ?? '';
    expect(text.startsWith('"a,b","say ""hi""",line1 line2 x,,,3,true,')).toBe(true);
    expect(text).not.toContain('IMPORTRANGE');
    expect(Array.from(text.split(',').pop() as string).length).toBe(GSHEETS_CELL_MAX_CHARS);
    expect(document.textTruncated).toBe(true);
  });

  it(`bounds: at most ${DRIVE_SHEETS_MAX} grid sheets, ${GSHEETS_MAX_COLUMNS} columns and ${GSHEETS_MAX_CELLS} cells per read`, async () => {
    const titles = Array.from({ length: 25 }, (_, index) => `S${index}`);
    const { reader, sheetsCalls } = harness({ sheetsMeta: () => sheetList(titles), sheetsValues: valuesFor((index) => [[`v${index}`]]) });
    const document = await reader.exportText('s1');
    expect(document.sections?.length).toBe(DRIVE_SHEETS_MAX);
    expect(document.sections?.map((section) => section.title)).toEqual(titles.slice(0, DRIVE_SHEETS_MAX));
    expect(document.textTruncated).toBe(true);
    const ranges = sheetsCalls()[1]?.searchParams.getAll('ranges') ?? [];
    expect(ranges.length).toBe(DRIVE_SHEETS_MAX);
    const rows = gsheetsRowsPerSheet(DRIVE_SHEETS_MAX);
    expect(rows * GSHEETS_MAX_COLUMNS * DRIVE_SHEETS_MAX).toBeLessThanOrEqual(GSHEETS_MAX_CELLS);
    expect(gsheetsRowsPerSheet(1)).toBe(1000);
    for (const range of ranges) expect(range.endsWith(`!A1:Z${rows}`)).toBe(true);
  });

  it(`the whole text, titles included, is cut at ${DRIVE_TEXT_MAX_BYTES} bytes across sheets on a code-point boundary`, async () => {
    const row = ['가'.repeat(900)];
    const { reader } = harness({
      sheetsMeta: () => sheetList(['A', 'B', 'C']),
      sheetsValues: valuesFor(() => Array.from({ length: gsheetsRowsPerSheet(3) }, () => row)),
    });
    const document = await reader.exportText('s1');
    expect(Buffer.byteLength(document.text, 'utf8')).toBeLessThanOrEqual(DRIVE_TEXT_MAX_BYTES);
    const sectionBytes = (document.sections ?? []).reduce((sum, section) => sum + Buffer.byteLength(section.text, 'utf8') + Buffer.byteLength(section.title, 'utf8'), 0);
    expect(sectionBytes).toBeLessThanOrEqual(DRIVE_TEXT_MAX_BYTES);
    expect(document.text).not.toContain('\uFFFD');
    expect(document.textTruncated).toBe(true);
  });

  it('hostile sheet titles (the PLT-1 corpus, quotes, A1 syntax, line breaks): quoted ranges, one-line bounded titles', async () => {
    const nasty = PLT1_VARIANTS.find((variant) => variant.id === 'nasty');
    if (nasty === undefined) throw new Error('missing corpus');
    const titles = [nasty.message, nasty.paths[2], "a'!A1:Z9999,'b", "x'';DROP", 'line\nbreak\u2028sep', `${'긴'.repeat(150)}`];
    const { reader, sheetsCalls } = harness({ sheetsMeta: () => sheetList(titles), sheetsValues: valuesFor((index) => [[`v${index}`]]) });
    const document = await reader.exportText('s1');
    const ranges = sheetsCalls()[1]?.searchParams.getAll('ranges') ?? [];
    expect(ranges).toEqual(titles.map((title) => gsheetsRange(title, gsheetsRowsPerSheet(titles.length))));
    expect(ranges[2]).toBe(`'a''!A1:Z9999,''b'!A1:Z${gsheetsRowsPerSheet(titles.length)}`);
    for (const section of document.sections ?? []) {
      expect(section.title).not.toMatch(/[\r\n\u2028\u2029]/);
      expect(Array.from(section.title).length).toBeLessThanOrEqual(100);
    }
    expect(document.sections?.[4]?.title).toBe('line break sep');
  });

  it('chart-only spreadsheets have no sections and no text; an over-long raw title is skipped and marked', async () => {
    const charts = harness({ sheetsMeta: () => json({ sheets: [{ properties: { title: 'c', index: 0, sheetType: 'OBJECT' } }] }) });
    const empty = await charts.reader.exportText('s1');
    expect(empty.sections).toEqual([]);
    expect(empty.text).toBe('');
    const long = harness({ sheetsMeta: () => sheetList(['x'.repeat(300), 'ok']), sheetsValues: valuesFor(() => [['1']]) });
    const document = await long.reader.exportText('s1');
    expect(document.sections?.map((section) => section.title)).toEqual(['ok']);
    expect(document.textTruncated).toBe(true);
  });
});

describe('DRV-2b fallback to the first sheet as CSV (never a crash)', () => {
  it.each([
    ['403 SERVICE_DISABLED (current error format)', () => json({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }] } }, 403), 'service-disabled'],
    ['403 accessNotConfigured (legacy error format)', () => json({ error: { code: 403, errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }] } }, 403), 'service-disabled'],
    ['403 other policy', () => json({ error: { errors: [{ reason: 'forbidden' }] } }, 403), 'unavailable'],
    ['500', () => json({}, 500), 'unavailable'],
    ['429', () => json({}, 429), 'unavailable'],
    ['404', () => json({}, 404), 'unavailable'],
    ['a malformed answer', () => json({ sheets: 'x' }), 'unavailable'],
  ] as const)('the sheet list answers %s → first sheet with note %s', async (_label, response, reason) => {
    const { reader, exports, sheetsCalls } = harness({ sheetsMeta: response });
    const document = await reader.exportText('s1');
    expect(document.text).toBe('항목,금액\n서버,100');
    expect(document.firstSheetOnly).toBe(reason);
    expect(document.sections).toBeUndefined();
    expect(exports().length).toBe(1);
    expect(new URL(exports()[0]?.url as string).searchParams.get('mimeType')).toBe('text/csv');
    // No values read after a failed sheet list.
    expect(sheetsCalls().length).toBe(1);
  });

  it('a transport failure (an egress refusal in enforce mode, a timeout) → unavailable; an oversized values answer → too-large', async () => {
    const refused = harness({
      sheetsMeta: () => {
        throw new Error('egress refused: new-destination');
      },
    });
    expect((await refused.reader.exportText('s1')).firstSheetOnly).toBe('unavailable');
    const big = harness({
      sheetsMeta: () => sheetList(['A']),
      sheetsValues: () => new Response(`{"valueRanges":[{"values":[["${'x'.repeat(5 * 1024 * 1024)}"]]}]}`, { status: 200 }),
    });
    expect((await big.reader.exportText('s1')).firstSheetOnly).toBe('too-large');
    const extraRows = harness({ sheetsMeta: () => sheetList(['A']), sheetsValues: valuesFor(() => Array.from({ length: 1001 }, () => ['x'])) });
    expect((await extraRows.reader.exportText('s1')).firstSheetOnly).toBe('unavailable');
  });

  it('a consent or grant problem is NOT hidden by the fallback: it keeps the existing consent reply', async () => {
    const scope = harness({ sheetsMeta: () => json({ error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 403) });
    expect((await failure(scope.reader.exportText('s1'))).reason).toBe('INSUFFICIENT_SCOPE');
    expect(scope.exports()).toEqual([]);
    const expired = harness({ sheetsMeta: () => json({}, 401) });
    expect((await failure(expired.reader.exportText('s1'))).reason).toBe('UNAUTHORIZED');
  });

  it('when the fallback export fails too, the failure is typed (never a crash)', async () => {
    const { reader } = harness({
      sheetsMeta: () => json({ error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 403),
      drive: (url) => (url.pathname.endsWith('/export') ? json({}, 500) : json(meta('s1'))),
    });
    expect((await failure(reader.exportText('s1'))).reason).toBe('UNAVAILABLE');
  });
});

describe('DRV-2b request guard: GET, the pinned host, two paths, values only', () => {
  const rows = gsheetsRowsPerSheet(1);
  const values = (query: string) => new URL(`/v4/spreadsheets/abc/values:batchGet?${query}`, GSHEETS_API_ORIGIN);
  const okValues = `ranges=${encodeURIComponent(`'A'!A1:Z${rows}`)}&fields=${encodeURIComponent(GSHEETS_VALUES_FIELDS)}&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;

  it('allows the metadata read with its fixed mask and a bounded values read', () => {
    expect(() => assertGSheetsReadRequest(new URL(`/v4/spreadsheets/abc?fields=${encodeURIComponent(GSHEETS_META_FIELDS)}`, GSHEETS_API_ORIGIN), 'GET')).not.toThrow();
    expect(() => assertGSheetsReadRequest(values(okValues), 'GET')).not.toThrow();
    expect(() => assertGoogleReadRequest(values(okValues), 'GET')).not.toThrow();
  });

  it.each([
    ['POST', values(okValues)],
    ['GET', new URL('/v4/spreadsheets/abc', GSHEETS_API_ORIGIN)],
    ['GET', new URL('/v4/spreadsheets/abc?fields=sheets&includeGridData=true', GSHEETS_API_ORIGIN)],
    ['GET', new URL(`/v4/spreadsheets/abc?fields=${encodeURIComponent(GSHEETS_META_FIELDS)}&ranges=A1`, GSHEETS_API_ORIGIN)],
    ['GET', values(okValues.replace('FORMATTED_VALUE', 'FORMULA'))],
    ['GET', values(okValues.replace('FORMATTED_VALUE', 'UNFORMATTED_VALUE'))],
    ['GET', values(okValues.replace('ROWS', 'COLUMNS'))],
    ['GET', values(`${okValues}&dateTimeRenderOption=SERIAL_NUMBER`)],
    ['GET', values(okValues.replace(encodeURIComponent(`'A'!A1:Z${rows}`), encodeURIComponent('A!A1:Z10')))],
    ['GET', values(okValues.replace(encodeURIComponent(`'A'!A1:Z${rows}`), encodeURIComponent("'A'!A:Z")))],
    ['GET', values(okValues.replace(encodeURIComponent(`'A'!A1:Z${rows}`), encodeURIComponent("'A'!A1:AZ10")))],
    ['GET', values(okValues.replace(encodeURIComponent(`'A'!A1:Z${rows}`), encodeURIComponent("'A'!A1:Z1001")))],
    ['GET', values(okValues.replace(/^ranges=[^&]+&/, ''))],
    ['GET', values(`${Array.from({ length: 21 }, (_, index) => `ranges=${encodeURIComponent(`'S${index}'!A1:Z10`)}`).join('&')}&fields=${encodeURIComponent(GSHEETS_VALUES_FIELDS)}&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`)],
    // 2 × 1000 rows × 26 columns is over the cell bound.
    ['GET', values(`ranges=${encodeURIComponent("'A'!A1:Z1000")}&ranges=${encodeURIComponent("'B'!A1:Z1000")}&fields=${encodeURIComponent(GSHEETS_VALUES_FIELDS)}&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`)],
    ['GET', new URL('/v4/spreadsheets/abc:batchUpdate', GSHEETS_API_ORIGIN)],
    ['GET', new URL(`/v4/spreadsheets/abc/values/A1?fields=x`, GSHEETS_API_ORIGIN)],
    ['GET', new URL('/v4/spreadsheets/abc/values:append', GSHEETS_API_ORIGIN)],
    ['GET', new URL('/v4/spreadsheets/abc/values:batchClear', GSHEETS_API_ORIGIN)],
    ['GET', new URL('/v4/spreadsheets/abc/developerMetadata', GSHEETS_API_ORIGIN)],
    ['GET', new URL(`https://evil.example/v4/spreadsheets/abc?fields=${encodeURIComponent(GSHEETS_META_FIELDS)}`)],
  ])('refuses %s %s', (method, url) => {
    expect(() => assertGSheetsReadRequest(url, method)).toThrow(GDriveEndpointNotAllowedError);
  });

  it('a Sheets path on the Drive host, or a Drive path on the Sheets host, is refused', () => {
    expect(() => assertGoogleReadRequest(new URL(`/v4/spreadsheets/abc?fields=${encodeURIComponent(GSHEETS_META_FIELDS)}`, 'https://www.googleapis.com'), 'GET')).toThrow(
      GDriveEndpointNotAllowedError,
    );
    expect(() => assertGoogleReadRequest(new URL('/drive/v3/files', GSHEETS_API_ORIGIN), 'GET')).toThrow(GDriveEndpointNotAllowedError);
  });
});
